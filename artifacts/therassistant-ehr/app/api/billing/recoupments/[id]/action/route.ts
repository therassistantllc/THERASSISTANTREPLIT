/**
 * POST /api/billing/recoupments/:id/action
 *
 * `:id` is the payment_recoupments.id. Body:
 *   {
 *     action:
 *       | "dispute"
 *       | "accept"
 *       | "pending_review"
 *       | "create_refund"
 *       | "apply_offset"
 *       | "mark_refund_due"
 *       | "add_note"
 *       | "reopen",
 *     organizationId: string,
 *     note?: string,
 *     deadline?: string,                 // YYYY-MM-DD (dispute window)
 *     assigned_to?: string,              // staff display label
 *     offset_era_claim_payment_id?: string,
 *   }
 *
 * Each action writes an audit_logs row under `recoupment_<action>`. The GET
 * route reduces those rows into the queue's authoritative state. The
 * special-case side effects:
 *
 *   - apply_offset           sets payment_recoupments.offset_era_claim_payment_id
 *   - create_refund          inserts a payment_refunds row pointing at the
 *                            source payment (status='pending')
 *   - add_note               also inserts into claim_notes when the
 *                            recoupment is linked to a professional_claim
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const ALLOWED = [
  "dispute",
  "accept",
  "pending_review",
  "create_refund",
  "apply_offset",
  "mark_refund_due",
  "add_note",
  "reopen",
] as const;
type Action = (typeof ALLOWED)[number];

const SUMMARIES: Record<Action, string> = {
  dispute: "Recoupment disputed",
  accept: "Recoupment adjustment accepted",
  pending_review: "Recoupment routed for review",
  create_refund: "Refund request created for payer",
  apply_offset: "Recoupment offset against future payment recorded",
  mark_refund_due: "Recoupment flagged — refund due to payer",
  add_note: "Note added to recoupment",
  reopen: "Recoupment reopened",
};

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    if (!id) {
      return NextResponse.json(
        { success: false, error: "Missing recoupment id" },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      organizationId?: string;
      note?: string;
      deadline?: string;
      assigned_to?: string;
      offset_era_claim_payment_id?: string;
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

    const { data: rec, error: recErr } = await (supabase as any)
      .from("payment_recoupments")
      .select(
        "id, organization_id, source_era_claim_payment_id, source_client_payment_id, professional_claim_id, client_id, payer_profile_id, amount, reason, workqueue_item_id",
      )
      .eq("id", id)
      .maybeSingle();
    if (recErr) throw recErr;
    if (!rec || rec.organization_id !== organizationId) {
      return NextResponse.json(
        { success: false, error: "Recoupment not found" },
        { status: 404 },
      );
    }

    const metadata: Record<string, unknown> = {};
    if (body.note) metadata.note = String(body.note).slice(0, 2000);
    if (action === "dispute" && body.deadline) metadata.deadline = body.deadline;
    if (action === "pending_review" && body.assigned_to) {
      metadata.assigned_to = String(body.assigned_to).slice(0, 200);
    }
    if (action === "apply_offset" && body.offset_era_claim_payment_id) {
      metadata.offset_era_claim_payment_id = body.offset_era_claim_payment_id;
    }

    // ── Side effects (before audit so the audit row reflects truth) ───
    if (action === "apply_offset" && body.offset_era_claim_payment_id) {
      // Validate the offset target belongs to this org before linking.
      const { data: target, error: tgtErr } = await (supabase as any)
        .from("era_claim_payments")
        .select("id, organization_id")
        .eq("id", body.offset_era_claim_payment_id)
        .maybeSingle();
      if (tgtErr) throw tgtErr;
      if (!target || target.organization_id !== organizationId) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Offset target ERA payment not found or belongs to another organization.",
          },
          { status: 400 },
        );
      }
      const { error: updErr } = await (supabase as any)
        .from("payment_recoupments")
        .update({ offset_era_claim_payment_id: body.offset_era_claim_payment_id })
        .eq("id", id)
        .eq("organization_id", organizationId);
      if (updErr) throw updErr;
    }

    let createdRefundId: string | null = null;
    if (action === "create_refund") {
      const sourceEra = rec.source_era_claim_payment_id ?? null;
      const sourceClient = rec.source_client_payment_id ?? null;
      if (!sourceEra && !sourceClient) {
        return NextResponse.json(
          {
            success: false,
            error: "Cannot create refund — recoupment has no source payment.",
          },
          { status: 400 },
        );
      }
      const refundType = sourceEra ? "insurance" : "client";
      const insertPayload: Record<string, unknown> = {
        organization_id: organizationId,
        refund_type: refundType,
        source_era_claim_payment_id: sourceEra,
        source_client_payment_id: sourceClient,
        client_id: rec.client_id ?? null,
        professional_claim_id: rec.professional_claim_id ?? null,
        payer_profile_id: rec.payer_profile_id ?? null,
        amount: rec.amount,
        reason: rec.reason ?? body.note ?? "Payer recoupment refund",
        refund_status: "pending",
        workqueue_item_id: rec.workqueue_item_id ?? null,
        requested_by_actor_id: guard.userId,
        note: body.note ?? null,
      };
      const { data: refundRow, error: refErr } = await (supabase as any)
        .from("payment_refunds")
        .insert(insertPayload)
        .select("id")
        .maybeSingle();
      if (refErr) throw refErr;
      createdRefundId = (refundRow as { id?: string } | null)?.id ?? null;
      if (createdRefundId) metadata.refund_id = createdRefundId;
    }

    if (action === "add_note" && rec.professional_claim_id && body.note) {
      // Best-effort claim_notes write — non-fatal if it fails (e.g.
      // legacy claim ids that aren't FK-resolvable). Audit row still
      // captures the note.
      await insertClaimNote(supabase as any, {
        organizationId,
        claimId: rec.professional_claim_id,
        authorUserId: guard.userId,
        body: String(body.note).slice(0, 2000),
      });
    }

    // ── Audit ─────────────────────────────────────────────────────────
    const eventType = `recoupment_${action}`;
    const summary = SUMMARIES[action];

    const { error: auditErr } = await (supabase as any).from("audit_logs").insert({
      organization_id: organizationId,
      claim_id: rec.professional_claim_id ?? null,
      patient_id: rec.client_id ?? null,
      event_type: eventType,
      event_summary: summary,
      event_metadata: metadata,
      user_id: guard.userId,
      action: eventType,
      object_type: "recoupment",
      object_id: id,
    });
    if (auditErr) throw auditErr;

    return NextResponse.json({
      success: true,
      organizationId,
      recoupmentId: id,
      action,
      summary,
      refundId: createdRefundId,
    });
  } catch (error) {
    console.error("Recoupment action error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Action failed",
      },
      { status: 500 },
    );
  }
}
