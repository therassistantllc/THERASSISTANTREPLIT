/**
 * POST /api/billing/rejections-277ca/[itemId]
 *
 * Action handler for the 277CA Rejections workqueue. Supports:
 *   - { action: "correct_claim" }            — adds a "correction started" note.
 *   - { action: "resubmit_corrected_claim" } — flips the underlying claim
 *                                              back to ready_for_validation
 *                                              and notes the resubmission.
 *   - { action: "route_to_eligibility" }     — defers the item and notes the
 *                                              eligibility hand-off.
 *   - { action: "route_to_enrollment" }      — defers the item and notes the
 *                                              credentialing/enrollment
 *                                              hand-off.
 *   - { action: "mark_resolved" }            — closes the workqueue item via
 *                                              resolveWorkqueueItem (also
 *                                              creates a billing_alerts row).
 *
 * Every action appends an audit_logs row so the action is traceable.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import {
  addWorkqueueComment,
  deferWorkqueueItem,
  resolveWorkqueueItem,
} from "@/lib/workqueue/workqueueActionService";

type ActionId =
  | "correct_claim"
  | "resubmit_corrected_claim"
  | "route_to_eligibility"
  | "route_to_enrollment"
  | "mark_resolved";

type ActionBody = {
  organizationId?: string;
  action?: ActionId;
  note?: string;
};

const FAR_FUTURE_ISO = "9999-12-31T00:00:00.000Z";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ itemId: string }> },
) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as ActionBody;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const userId = guard.userId;
    const staffId = guard.staffId;

    const { itemId } = await ctx.params;
    if (!itemId) {
      return NextResponse.json(
        { success: false, error: "itemId is required" },
        { status: 400 },
      );
    }

    const action = body.action;
    if (!action) {
      return NextResponse.json(
        { success: false, error: "action is required" },
        { status: 400 },
      );
    }

    // Verify the item belongs to this org and pull the claim id we need
    // for the resubmit branch / audit metadata.
    const { data: item, error: lookupErr } = await (supabase as any)
      .from("workqueue_items")
      .select("id, status, professional_claim_id, client_id, work_type, context_payload")
      .eq("organization_id", organizationId)
      .eq("id", itemId)
      .is("archived_at", null)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!item) {
      return NextResponse.json(
        { success: false, error: "Workqueue item not found" },
        { status: 404 },
      );
    }
    if (item.work_type !== "payer_rejection") {
      return NextResponse.json(
        { success: false, error: "Not a 277CA rejection item" },
        { status: 400 },
      );
    }

    const claimId: string | null = item.professional_claim_id ?? null;

    if (action === "correct_claim") {
      const r = await addWorkqueueComment({
        organizationId,
        workqueueItemId: itemId,
        userId,
        comment: body.note ?? "Started correcting claim from 277CA rejection.",
      });
      if (!r.ok) return NextResponse.json({ success: false, error: r.errors[0]?.message }, { status: 500 });
      await writeAudit(supabase, {
        organizationId,
        userId,
        claimId,
        eventType: "rejection_277ca_correction_started",
        summary: "Biller opened 277CA rejection to correct claim.",
        metadata: { workqueueItemId: itemId, staffId },
      });
      return NextResponse.json({ success: true, action, status: r.status });
    }

    if (action === "resubmit_corrected_claim") {
      if (!claimId) {
        return NextResponse.json(
          { success: false, error: "Rejection item is not linked to a claim" },
          { status: 400 },
        );
      }
      const { error: updErr } = await (supabase as any)
        .from("professional_claims")
        .update({
          claim_status: "ready_for_validation",
          updated_at: new Date().toISOString(),
        })
        .eq("id", claimId)
        .eq("organization_id", organizationId);
      if (updErr) throw updErr;

      const r = await resolveWorkqueueItem({
        organizationId,
        workqueueItemId: itemId,
        userId,
        comment:
          body.note ??
          "Corrected claim queued for resubmission (claim returned to ready_for_validation).",
      });
      if (!r.ok) return NextResponse.json({ success: false, error: r.errors[0]?.message }, { status: 500 });

      await writeAudit(supabase, {
        organizationId,
        userId,
        claimId,
        eventType: "rejection_277ca_resubmitted",
        summary: "Claim re-queued for batch after 277CA correction.",
        metadata: { workqueueItemId: itemId, staffId },
      });
      return NextResponse.json({ success: true, action, status: r.status });
    }

    if (action === "route_to_eligibility" || action === "route_to_enrollment") {
      const reason =
        action === "route_to_eligibility"
          ? "routed_to_eligibility"
          : "routed_to_credentialing";
      const r = await deferWorkqueueItem({
        organizationId,
        workqueueItemId: itemId,
        userId,
        deferredUntil: FAR_FUTURE_ISO,
        deferReason: reason,
        comment:
          body.note ??
          (action === "route_to_eligibility"
            ? "Routed to eligibility for member/coverage verification."
            : "Routed to credentialing/enrollment for provider setup."),
      });
      if (!r.ok) return NextResponse.json({ success: false, error: r.errors[0]?.message }, { status: 500 });

      await writeAudit(supabase, {
        organizationId,
        userId,
        claimId,
        eventType:
          action === "route_to_eligibility"
            ? "rejection_277ca_routed_eligibility"
            : "rejection_277ca_routed_enrollment",
        summary:
          action === "route_to_eligibility"
            ? "277CA rejection routed to eligibility."
            : "277CA rejection routed to credentialing/enrollment.",
        metadata: { workqueueItemId: itemId, staffId },
      });
      return NextResponse.json({ success: true, action, status: r.status });
    }

    if (action === "mark_resolved") {
      const r = await resolveWorkqueueItem({
        organizationId,
        workqueueItemId: itemId,
        userId,
        comment: body.note ?? "Marked 277CA rejection resolved.",
      });
      if (!r.ok) return NextResponse.json({ success: false, error: r.errors[0]?.message }, { status: 500 });
      await writeAudit(supabase, {
        organizationId,
        userId,
        claimId,
        eventType: "rejection_277ca_resolved",
        summary: "277CA rejection marked resolved.",
        metadata: { workqueueItemId: itemId, staffId },
      });
      return NextResponse.json({ success: true, action, status: r.status });
    }

    return NextResponse.json(
      { success: false, error: `Unknown action: ${action}` },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Action failed" },
      { status: 500 },
    );
  }
}

async function writeAudit(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  args: {
    organizationId: string;
    userId: string | null;
    claimId: string | null;
    eventType: string;
    summary: string;
    metadata: Record<string, unknown>;
  },
) {
  if (!supabase) return;
  try {
    await (supabase as any).from("audit_logs").insert({
      organization_id: args.organizationId,
      user_id: args.userId,
      action: args.eventType,
      object_type: args.claimId ? "claim" : "workqueue_item",
      object_id: args.claimId ?? args.metadata.workqueueItemId ?? null,
      event_type: args.eventType,
      event_summary: args.summary,
      event_metadata: args.metadata,
    });
  } catch {
    // Audit failure must not block the action's success response.
  }
}
