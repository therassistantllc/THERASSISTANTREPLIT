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
 *       | "route_to_client_admin"
 *       | "reopen",
 *     organizationId: string,
 *     ordered_policy_ids?: string[],
 *     note?: string,
 *   }
 *
 * Every action writes an audit_logs row under the `cob_<action>`
 * event_type. The GET route reduces those rows into the queue's
 * authoritative state (resolved, awaiting_eob, client_update_needed).
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

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
