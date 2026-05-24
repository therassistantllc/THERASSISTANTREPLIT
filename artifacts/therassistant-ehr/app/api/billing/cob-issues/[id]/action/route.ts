/**
 * POST /api/billing/cob-issues/:id/action
 *
 * `:id` is the professional_claims.id. Body shape:
 *   {
 *     action:
 *       | "update_insurance_order"   // ordered_policy_ids[]
 *       | "bill_primary"
 *       | "bill_secondary"
 *       | "request_eob"
 *       | "record_eob"
 *       | "route_to_client_admin"    // delivery: "clipboard" | "email"
 *       | "reopen",
 *     organizationId: string,
 *     ordered_policy_ids?: string[],
 *     note?: string,
 *     delivery?: "clipboard" | "email",
 *   }
 *
 * Every action writes an audit_logs row under the `cob_<action>`
 * event_type. The GET route reduces those rows into the queue's
 * authoritative state (resolved, awaiting_eob, client_update_needed).
 *
 * `route_to_client_admin` additionally provisions a one-time tokenized
 * link in cob_client_update_links and (when delivery=email) emails it
 * to the client via Resend. The audit row's event_metadata carries the
 * link URL + expiry so the queue UI can surface it to billers.
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { sendCobUpdateEmail } from "@/lib/email/resend";

const ALLOWED = [
  "update_insurance_order",
  "bill_primary",
  "bill_secondary",
  "request_eob",
  "record_eob",
  "route_to_client_admin",
  "reopen",
] as const;
type Action = (typeof ALLOWED)[number];

const SUMMARIES: Record<Action, string> = {
  update_insurance_order: "Insurance order updated for COB",
  bill_primary: "Claim queued to bill primary payer",
  bill_secondary: "Claim queued to bill secondary payer",
  request_eob: "Prior-payer EOB requested",
  record_eob: "Prior-payer EOB recorded",
  route_to_client_admin: "Routed to client/admin for insurance update",
  reopen: "COB issue reopened",
};

function generateToken() {
  return randomBytes(24).toString("base64url");
}

function resolveCanonicalBaseUrl(): string | null {
  const fromEnv =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return null;
}

function resolveBaseUrlForClipboard(request: Request): string {
  const canonical = resolveCanonicalBaseUrl();
  if (canonical) return canonical;
  try {
    const url = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const host = forwardedHost || url.host;
    const proto = forwardedProto || url.protocol.replace(/:$/, "");
    return `${proto}://${host}`;
  } catch {
    return "";
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    if (!id) {
      return NextResponse.json(
        { success: false, error: "Missing claim id" },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      organizationId?: string;
      ordered_policy_ids?: string[];
      note?: string;
      delivery?: string;
    };

    const action = body.action as Action | undefined;
    if (!action || !ALLOWED.includes(action)) {
      return NextResponse.json(
        { success: false, error: `Unknown action: ${body.action ?? ""}` },
        { status: 400 },
      );
    }

    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const { data: claim, error: claimErr } = await (supabase as any)
      .from("professional_claims")
      .select("id, organization_id, patient_id, appointment_id, claim_status")
      .eq("id", id)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claim || claim.organization_id !== organizationId) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const metadata: Record<string, unknown> = {};
    if (body.note) metadata.note = String(body.note).slice(0, 2000);
    if (action === "update_insurance_order" && Array.isArray(body.ordered_policy_ids)) {
      metadata.ordered_policy_ids = body.ordered_policy_ids
        .map((x) => String(x))
        .filter(Boolean);
    }

    // ── route_to_client_admin: mint a one-time link + (optional) email ──
    let clientUpdate: {
      linkId: string;
      token: string;
      url: string;
      fullUrl: string;
      expiresAt: string | null;
      deliveryMethod: "clipboard" | "email";
      email: { sent: boolean; to: string | null; error: string | null };
    } | null = null;

    if (action === "route_to_client_admin") {
      const clientId = String(claim.patient_id ?? "").trim();
      if (!clientId) {
        return NextResponse.json(
          {
            success: false,
            error: "Cannot route to client — claim is not linked to a client.",
          },
          { status: 400 },
        );
      }

      const requestedDelivery = String(body.delivery ?? "clipboard").toLowerCase();
      const deliveryMethod: "clipboard" | "email" =
        requestedDelivery === "email" ? "email" : "clipboard";

      const { data: clientRow } = await (supabase as any)
        .from("clients")
        .select("id, email, first_name, last_name, preferred_name")
        .eq("id", clientId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      const patientEmail = String(clientRow?.email ?? "").trim();

      const canonicalBase = resolveCanonicalBaseUrl();
      if (deliveryMethod === "email") {
        if (!patientEmail) {
          return NextResponse.json(
            {
              success: false,
              error:
                "This client does not have an email on file. Add one to the chart, or copy the link manually instead.",
            },
            { status: 400 },
          );
        }
        if (!canonicalBase) {
          return NextResponse.json(
            {
              success: false,
              error:
                "Cannot email an insurance-update link without a canonical app URL. Set APP_URL or NEXT_PUBLIC_APP_URL.",
            },
            { status: 500 },
          );
        }
      }

      let practiceName = "your care team";
      try {
        const { data: orgRow } = await (supabase as any)
          .from("organizations")
          .select("name")
          .eq("id", organizationId)
          .maybeSingle();
        const name = String(orgRow?.name ?? "").trim();
        if (name) practiceName = name;
      } catch {
        // ignore
      }

      // One active link per claim — revoke any prior pending links so the
      // client always lands on the freshest workflow.
      await (supabase as any)
        .from("cob_client_update_links")
        .update({ status: "revoked" })
        .eq("claim_id", id)
        .eq("status", "pending");

      const token = generateToken();
      const { data: inserted, error: insertErr } = await (supabase as any)
        .from("cob_client_update_links")
        .insert({
          organization_id: organizationId,
          client_id: clientId,
          claim_id: id,
          token,
          created_by_user_id: guard.userId,
          delivery_method: deliveryMethod,
        })
        .select("id, token, expires_at")
        .single();
      if (insertErr || !inserted) {
        throw insertErr ?? new Error("Failed to create client-update link");
      }

      const relativeUrl = `/cob-update/${inserted.token}`;
      const baseUrl =
        deliveryMethod === "email"
          ? (canonicalBase as string)
          : resolveBaseUrlForClipboard(request);
      const fullUrl = baseUrl ? `${baseUrl}${relativeUrl}` : relativeUrl;
      const expiresAt = (inserted.expires_at as string | null) ?? null;

      clientUpdate = {
        linkId: String(inserted.id),
        token: String(inserted.token),
        url: relativeUrl,
        fullUrl,
        expiresAt,
        deliveryMethod,
        email: { sent: false, to: null, error: null },
      };

      if (deliveryMethod === "email") {
        const patientName = [
          String(clientRow?.preferred_name ?? "").trim() ||
            String(clientRow?.first_name ?? "").trim(),
          String(clientRow?.last_name ?? "").trim(),
        ]
          .filter(Boolean)
          .join(" ")
          .trim();
        const send = await sendCobUpdateEmail({
          to: patientEmail,
          patientName,
          practiceName,
          updateUrl: fullUrl,
          expiresAt,
        });

        const nowIso = new Date().toISOString();
        if (send.ok) {
          clientUpdate.email = { sent: true, to: patientEmail, error: null };
          await (supabase as any)
            .from("cob_client_update_links")
            .update({
              delivered_to_email: patientEmail,
              delivered_at: nowIso,
              delivery_error: null,
              delivery_provider_id: send.providerId,
              delivery_status: "sent",
              delivery_status_at: nowIso,
            })
            .eq("id", clientUpdate.linkId);
        } else {
          clientUpdate.email = { sent: false, to: patientEmail, error: send.error };
          await (supabase as any)
            .from("cob_client_update_links")
            .update({
              delivered_to_email: patientEmail,
              delivery_error: send.error,
              delivery_status: "failed",
              delivery_status_at: nowIso,
            })
            .eq("id", clientUpdate.linkId);
          return NextResponse.json(
            {
              success: false,
              error: send.error,
              clientUpdate,
            },
            { status: 502 },
          );
        }
      }

      metadata.link_id = clientUpdate.linkId;
      metadata.link_url = relativeUrl;
      metadata.link_expires_at = expiresAt;
      metadata.delivery_method = deliveryMethod;
      if (clientUpdate.email.sent) {
        metadata.delivered_to_email = clientUpdate.email.to;
      }
    }

    const eventType = `cob_${action}`;
    const summary = SUMMARIES[action];

    const { error: auditErr } = await (supabase as any).from("audit_logs").insert({
      organization_id: organizationId,
      claim_id: id,
      patient_id: claim.patient_id ?? null,
      appointment_id: claim.appointment_id ?? null,
      event_type: eventType,
      event_summary: summary,
      event_metadata: metadata,
      user_id: guard.userId,
      action: eventType,
      object_type: "claim",
      object_id: id,
    });
    if (auditErr) throw auditErr;

    // Status nudges: a "bill primary/secondary" action flips the claim
    // back to draft so it picks up the new payer in the next batch run.
    if (action === "bill_primary" || action === "bill_secondary") {
      await (supabase as any)
        .from("professional_claims")
        .update({
          claim_status: "draft",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("organization_id", organizationId);
    }

    return NextResponse.json({
      success: true,
      organizationId,
      claimId: id,
      action,
      summary,
      clientUpdate,
    });
  } catch (error) {
    console.error("COB Issues action error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Action failed",
      },
      { status: 500 },
    );
  }
}
