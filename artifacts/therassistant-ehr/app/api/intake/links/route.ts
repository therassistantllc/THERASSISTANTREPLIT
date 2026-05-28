import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requirePermissionInRoute } from "@/lib/rbac/middleware";
import { PERMISSIONS } from "@/lib/rbac/constants";
import { sendIntakeEmail } from "@/lib/email/resend";

type Row = Record<string, unknown>;

function value(input: unknown) {
  return String(input ?? "").trim();
}

function generateToken() {
  return randomBytes(24).toString("base64url");
}

function resolveCanonicalBaseUrl(): string | null {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim();
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

export async function POST(request: Request) {
  try {
    const auth = await requirePermissionInRoute(PERMISSIONS.EDIT_PATIENT_DEMOGRAPHICS);
    if (auth instanceof NextResponse) return auth;
    const { organizationId, staffId } = auth;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const payload = (await request.json().catch(() => null)) as Row | null;
    const clientId = value(payload?.clientId);
    if (!clientId) return NextResponse.json({ success: false, error: "clientId is required" }, { status: 400 });

    const requestedDelivery = value(payload?.delivery).toLowerCase();
    const deliveryMethod: "clipboard" | "email" =
      requestedDelivery === "email" ? "email" : "clipboard";

    const { data: clientRow, error: clientErr } = await supabase
      .from("clients")
      .select("id, organization_id, email, first_name, last_name, preferred_name")
      .eq("id", clientId)
      .single();
    if (clientErr || !clientRow) {
      return NextResponse.json({ success: false, error: "Client not found" }, { status: 404 });
    }
    if (value((clientRow as Row).organization_id) !== organizationId) {
      return NextResponse.json({ success: false, error: "Client is not in your organization" }, { status: 403 });
    }

    const client = clientRow as Row;
    const patientEmail = value(client.email);

    if (deliveryMethod === "email" && !patientEmail) {
      return NextResponse.json(
        {
          success: false,
          error: "This client does not have an email on file. Add one to the chart before emailing the intake link.",
        },
        { status: 400 },
      );
    }

    // Look up the practice name for the email template (best effort).
    let practiceName = "your care team";
    try {
      const { data: orgRow } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", organizationId)
        .single();
      const name = value((orgRow as Row | null)?.name);
      if (name) practiceName = name;
    } catch {
      // ignore; fall back to default
    }

    // Revoke any prior pending links for this client (one active link at a time)
    await supabase
      .from("intake_links")
      .update({ status: "revoked" })
      .eq("client_id", clientId)
      .eq("status", "pending");

    const token = generateToken();
    const { data: inserted, error: insertErr } = await supabase
      .from("intake_links")
      .insert({
        organization_id: organizationId,
        client_id: clientId,
        token,
        created_by_user_id: staffId,
        delivery_method: deliveryMethod,
      })
      .select("id, token, expires_at, status, delivery_method")
      .single();

    if (insertErr || !inserted) throw insertErr ?? new Error("Failed to create intake link");

    await supabase.from("clients").update({ intake_status: "pending" }).eq("id", clientId);

    const row = inserted as Row;
    const relativeUrl = `/intake/${value(row.token)}`;
    const expiresAt = (row.expires_at as string | null) ?? null;

    // For emailed links we require a configured canonical URL — we won't put a
    // host derived from request headers into outbound client mail. For
    // clipboard the worst case is staff sees a localhost URL, so a header
    // fallback is acceptable there.
    const canonicalBase = resolveCanonicalBaseUrl();
    const baseUrlForClipboard = resolveBaseUrlForClipboard(request);
    const baseUrl = deliveryMethod === "email" ? canonicalBase : baseUrlForClipboard;

    if (deliveryMethod === "email" && !canonicalBase) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Cannot email an intake link without a canonical app URL. Set APP_URL or NEXT_PUBLIC_APP_URL before emailing intake links.",
        },
        { status: 500 },
      );
    }

    const fullUrl = baseUrl ? `${baseUrl}${relativeUrl}` : relativeUrl;

    let emailResult: { sent: boolean; to: string | null; error: string | null } = {
      sent: false,
      to: null,
      error: null,
    };

    if (deliveryMethod === "email") {
      const patientName = [value(client.preferred_name) || value(client.first_name), value(client.last_name)]
        .filter(Boolean)
        .join(" ")
        .trim();
      const send = await sendIntakeEmail({
        to: patientEmail,
        patientName,
        practiceName,
        intakeUrl: fullUrl,
        expiresAt,
      });

      if (send.ok) {
        emailResult = { sent: true, to: patientEmail, error: null };
        const nowIso = new Date().toISOString();
        await supabase
          .from("intake_links")
          .update({
            delivered_to_email: patientEmail,
            delivered_at: nowIso,
            delivery_error: null,
            delivery_provider_id: send.providerId,
            delivery_status: "sent",
            delivery_status_at: nowIso,
          })
          .eq("id", value(row.id));
      } else {
        emailResult = { sent: false, to: patientEmail, error: send.error };
        await supabase
          .from("intake_links")
          .update({
            delivery_error: send.error,
            delivered_to_email: patientEmail,
            delivery_status: "failed",
            delivery_status_at: new Date().toISOString(),
          })
          .eq("id", value(row.id));
        return NextResponse.json(
          {
            success: false,
            error: send.error,
            link: {
              id: value(row.id),
              token: value(row.token),
              url: relativeUrl,
              expiresAt,
              status: value(row.status),
              deliveryMethod,
            },
          },
          { status: 502 },
        );
      }
    }

    return NextResponse.json({
      success: true,
      link: {
        id: value(row.id),
        token: value(row.token),
        url: relativeUrl,
        expiresAt,
        status: value(row.status),
        deliveryMethod,
      },
      email: emailResult,
    });
  } catch (error) {
    console.error("Intake link create error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create intake link" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    const auth = await requirePermissionInRoute(PERMISSIONS.VIEW_PATIENT_CHART);
    if (auth instanceof NextResponse) return auth;
    const { organizationId } = auth;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const clientId = value(searchParams.get("clientId"));
    if (!clientId) return NextResponse.json({ success: false, error: "clientId is required" }, { status: 400 });

    const { data, error } = await supabase
      .from("intake_links")
      .select(
        "id, token, status, expires_at, created_at, used_at, submission_id, delivery_method, delivered_to_email, delivered_at, delivery_error, delivery_status, delivery_status_at",
      )
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    return NextResponse.json({
      success: true,
      links: ((data ?? []) as Row[]).map((row) => ({
        id: value(row.id),
        token: value(row.token),
        url: `/intake/${value(row.token)}`,
        status: value(row.status),
        expiresAt: row.expires_at ?? null,
        createdAt: row.created_at ?? null,
        usedAt: row.used_at ?? null,
        submissionId: row.submission_id ?? null,
        deliveryMethod: value(row.delivery_method) || "clipboard",
        deliveredToEmail: (row.delivered_to_email as string | null) ?? null,
        deliveredAt: row.delivered_at ?? null,
        deliveryError: (row.delivery_error as string | null) ?? null,
        deliveryStatus: (row.delivery_status as string | null) ?? null,
        deliveryStatusAt: row.delivery_status_at ?? null,
      })),
    });
  } catch (error) {
    console.error("Intake link list error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to list intake links" },
      { status: 500 },
    );
  }
}
