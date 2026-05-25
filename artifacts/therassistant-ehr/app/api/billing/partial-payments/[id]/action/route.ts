/**
 * POST /api/billing/partial-payments/:id/action
 *
 * `:id` is the professional_claims.id. Body shape:
 *   {
 *     action:
 *       | "accept_payment"
 *       | "appeal_balance"
 *       | "bill_secondary"
 *       | "transfer_to_patient"
 *       | "add_note"
 *       | "reopen",
 *     organizationId: string,
 *     note?: string,
 *   }
 *
 * Every action writes an audit_logs row under the `pp_<action>`
 * event_type and is overlaid by the GET route to derive each row's
 * state column. The "transfer_to_patient" action also opens a
 * patient_invoices row sized to the remaining balance.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const ALLOWED = [
  "accept_payment",
  "appeal_balance",
  "bill_secondary",
  "transfer_to_patient",
  "add_note",
  "reopen",
] as const;
type Action = (typeof ALLOWED)[number];

const SUMMARIES: Record<Action, string> = {
  accept_payment: "Partial payment accepted; remaining adjusted off",
  appeal_balance: "Appeal queued for remaining balance",
  bill_secondary: "Claim queued to bill secondary payer",
  transfer_to_patient: "Remaining balance transferred to patient invoice",
  add_note: "Biller added a note",
  reopen: "Partial-payment item reopened",
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
      .select(
        "id, organization_id, patient_id, appointment_id, claim_status, total_charge",
      )
      .eq("id", id)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claim || claim.organization_id !== organizationId) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const note = text(body.note).slice(0, 2000);
    if (action === "add_note" && !note) {
      return NextResponse.json(
        { success: false, error: "Note body is required" },
        { status: 400 },
      );
    }

    const metadata: Record<string, unknown> = {};
    if (note) metadata.note = note;

    // Side effects per action.
    let invoiceId: string | null = null;
    if (action === "transfer_to_patient") {
      // Compute remaining balance from the latest ERA on this claim.
      const { data: era } = await (supabase as any)
        .from("era_claim_payments")
        .select(
          "id, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, cas_adjustments",
        )
        .eq("organization_id", organizationId)
        .eq("professional_claim_id", id)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const billed = money(era?.clp03_total_charge ?? claim.total_charge);
      const paid = money(era?.clp04_payment_amount);
      const patientResp = money(era?.clp05_patient_responsibility);
      const casTotal = Array.isArray(era?.cas_adjustments)
        ? (era!.cas_adjustments as Array<Record<string, unknown>>).reduce(
            (s, c) => s + money(c.amount ?? c.cas03),
            0,
          )
        : 0;
      const remaining = Math.round(
        Math.max(0, billed - paid - casTotal) * 100,
      ) / 100;
      const responsibilityAmount = patientResp > 0 ? patientResp : remaining;

      if (responsibilityAmount > 0 && claim.patient_id) {
        const invoiceNumber = `PR-${Date.now().toString(36).toUpperCase()}-${id
          .slice(0, 6)
          .toUpperCase()}`;
        const { data: invoice, error: invoiceErr } = await (supabase as any)
          .from("patient_invoices")
          .insert({
            organization_id: organizationId,
            client_id: claim.patient_id,
            professional_claim_id: id,
            era_claim_payment_id: era?.id ?? null,
            invoice_status: "open",
            invoice_number: invoiceNumber,
            patient_responsibility_amount: responsibilityAmount,
            paid_amount: 0,
            balance_amount: responsibilityAmount,
            source: "partial_payments",
          })
          .select("id")
          .maybeSingle();
        if (invoiceErr) throw invoiceErr;
        invoiceId = invoice ? text(invoice.id) : null;
        metadata.invoice_id = invoiceId;
        metadata.invoice_amount = responsibilityAmount;
      } else {
        metadata.invoice_skipped = "no_remaining_balance";
      }
    }

    if (action === "bill_secondary") {
      // Drop the claim back to draft so the next batch picks it up
      // routed to the secondary payer.
      await (supabase as any)
        .from("professional_claims")
        .update({
          claim_status: "draft",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("organization_id", organizationId);
      metadata.next_status = "draft";
    }

    if (action === "add_note" && note) {
      const { error: noteErr } = await insertClaimNote(supabase as any, {
        organizationId,
        claimId: id,
        authorUserId: guard.userId,
        body: note,
      });
      if (noteErr) throw noteErr;
    }

    const eventType = `pp_${action}`;
    const summary = SUMMARIES[action];
    const { error: auditErr } = await (supabase as any)
      .from("audit_logs")
      .insert({
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

    // Task #485: auto-resolve any open claim_workqueue_items row that the
    // ERA posting engine seeded for this partial payment. Only resolves
    // rows tagged item_status='partial_payment' so unrelated workqueue
    // entries (denials, aging, etc.) on the same claim are untouched.
    if (
      action === "accept_payment" ||
      action === "appeal_balance" ||
      action === "bill_secondary" ||
      action === "transfer_to_patient"
    ) {
      const resolvedAt = new Date().toISOString();
      const { error: resolveErr } = await (supabase as any)
        .from("claim_workqueue_items")
        .update({
          item_status: "resolved",
          action_taken: SUMMARIES[action],
          resolved_at: resolvedAt,
          resolved_by_user_id: guard.userId,
          updated_at: resolvedAt,
        })
        .eq("organization_id", organizationId)
        .eq("claim_id", id)
        .eq("item_status", "partial_payment")
        .is("archived_at", null);
      if (resolveErr) {
        // Non-fatal: the audit log is the source of truth for the queue
        // state overlay. Log and continue so the action still succeeds.
        console.warn(
          "Partial Payments: failed to resolve claim_workqueue_items row",
          resolveErr.message,
        );
      }
    } else if (action === "reopen") {
      // Reverse the auto-resolve from a prior terminal action: restore
      // any claim_workqueue_items row this queue previously stamped
      // back to item_status='partial_payment' so it surfaces in the
      // open queue again. We scope to rows where resolved_by_user_id /
      // action_taken match one of the four terminal SUMMARIES so we
      // don't accidentally reopen rows resolved by an unrelated queue
      // (denials, aging, etc.).
      const terminalSummaries = [
        SUMMARIES.accept_payment,
        SUMMARIES.appeal_balance,
        SUMMARIES.bill_secondary,
        SUMMARIES.transfer_to_patient,
      ];
      const nowIso = new Date().toISOString();
      const { error: reopenErr } = await (supabase as any)
        .from("claim_workqueue_items")
        .update({
          item_status: "partial_payment",
          resolved_at: null,
          resolved_by_user_id: null,
          action_taken: SUMMARIES.reopen,
          updated_at: nowIso,
        })
        .eq("organization_id", organizationId)
        .eq("claim_id", id)
        .eq("item_status", "resolved")
        .in("action_taken", terminalSummaries)
        .is("archived_at", null);
      if (reopenErr) {
        console.warn(
          "Partial Payments: failed to reopen claim_workqueue_items row",
          reopenErr.message,
        );
      }
    }

    return NextResponse.json({
      success: true,
      organizationId,
      claimId: id,
      action,
      summary,
      invoiceId,
    });
  } catch (error) {
    console.error("Partial Payments action error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Action failed",
      },
      { status: 500 },
    );
  }
}
