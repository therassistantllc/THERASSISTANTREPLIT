/**
 * Payment Posting Engine — `commitPosting` entrypoint.
 *
 * Single chokepoint for every ledger write. Wraps:
 *   1. Validation (blocking → return; warning → log + continue)
 *   2. Idempotency (already-posted replay)
 *   3. Ledger writes (era_posting_ledger_entries)
 *   4. Parent updates (era_claim_payments.posting_status,
 *      professional_claims.claim_status)
 *   5. Patient invoice creation (when PR > 0 and client linked)
 *   6. Workqueue closeout (era_mismatch / era_835_exception items)
 *   7. Audit log emission for every meaningful step
 *
 * Phase 1 (Task #107) implements the `era_835` source only. Sources
 * `manual_insurance`, `patient_payment`, `recoupment`, `refund`, and
 * `reversal` are stubbed and return a clear "not implemented in
 * Foundation phase" error — Tasks #109 and #110 fill them in.
 *
 * Backwards compatibility:
 *   `era835PostingService.postSingleEra835ClaimPayment` delegates here.
 *   `postEra835Batch` iterates and calls this per claim.
 */

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { writePaymentAuditLog } from "./audit";
import { validateEra835Posting, isAlreadyPosted } from "./validation";
import type {
  CommitPostingInput,
  CommitPostingResult,
  EraClaimPaymentRow,
  PostingActor,
  PostingLedgerEffect,
} from "./types";

export * from "./types";
export * from "./roleGuard";
export { validateEra835Posting, isAlreadyPosted, POSTING_BALANCE_TOLERANCE } from "./validation";
export { writePaymentAuditLog } from "./audit";

/** Default actor used when an internal service caller doesn't supply one. */
const SYSTEM_ACTOR: PostingActor = {
  staffId: null,
  userId: null,
  role: "system",
  source: "service:internal",
};

function casGroupCode(adj: EraClaimPaymentRow["cas_adjustments"][number]) {
  return (adj.groupCode ?? adj.group_code ?? "").toString().toUpperCase();
}

function sumContractualAdjustments(adjustments: EraClaimPaymentRow["cas_adjustments"]) {
  return (adjustments ?? [])
    .filter((adj) => casGroupCode(adj) === "CO")
    .reduce((sum, adj) => sum + Number(adj.amount ?? 0), 0);
}

function invoiceNumber(paymentId: string) {
  return `INV-${paymentId.slice(0, 8).toUpperCase()}`;
}

function emptyResult(): CommitPostingResult {
  return {
    ok: false,
    posted: false,
    blocked: false,
    alreadyPosted: false,
    validation: { blocking: [], warning: [] },
    effects: [],
    patientInvoiceCreated: false,
    workqueueItemsClosed: 0,
    auditLogIds: [],
    errors: [],
  };
}

export async function commitPosting(
  input: CommitPostingInput,
): Promise<CommitPostingResult> {
  if (input.source.type !== "era_835") {
    const result = emptyResult();
    result.errors.push({
      field: "source.type",
      message: `Posting source "${input.source.type}" is not implemented in Foundation phase. See Tasks #109 / #110.`,
    });
    return result;
  }

  return commitEra835Posting(input, input.source.eraClaimPaymentId);
}

async function commitEra835Posting(
  input: CommitPostingInput,
  eraClaimPaymentId: string,
): Promise<CommitPostingResult> {
  const result = emptyResult();
  const actor = input.actor ?? SYSTEM_ACTOR;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    result.errors.push({ field: "system", message: "Database connection not available" });
    return result;
  }

  // ── 1. Hydrate ────────────────────────────────────────────────────────────
  const { data: paymentRow, error: paymentError } = await supabase
    .from("era_claim_payments")
    .select(
      "id, professional_claim_id, client_id, clp01_claim_control_number, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, cas_adjustments, claim_match_status, posting_status",
    )
    .eq("organization_id", input.organizationId)
    .eq("id", eraClaimPaymentId)
    .is("archived_at", null)
    .maybeSingle();

  if (paymentError) {
    result.errors.push({ field: "era_claim_payments", message: paymentError.message });
    return result;
  }
  if (!paymentRow) {
    result.errors.push({ field: "era_claim_payments", message: "ERA claim payment not found" });
    return result;
  }

  const row = paymentRow as EraClaimPaymentRow;

  // ── 2. Idempotency replay ────────────────────────────────────────────────
  if (isAlreadyPosted(row)) {
    result.ok = true;
    result.alreadyPosted = true;
    return result;
  }

  // ── 3. Validation ────────────────────────────────────────────────────────
  result.validation = validateEra835Posting(row);
  if (result.validation.blocking.length > 0) {
    result.blocked = true;
    result.errors.push(
      ...result.validation.blocking.map((issue) => ({
        field: issue.field,
        message: issue.message,
      })),
    );
    return result;
  }

  // ── 4. Dry-run short-circuit ─────────────────────────────────────────────
  if (input.dryRun) {
    result.ok = true;
    return result;
  }

  // ── 5. Commit ledger effects + parent updates ────────────────────────────
  const now = new Date().toISOString();
  const insurancePayment = Number(row.clp04_payment_amount ?? 0);
  const contractualAdjustment = sumContractualAdjustments(row.cas_adjustments);
  const patientResponsibility = Number(row.clp05_patient_responsibility ?? 0);

  try {
    if (insurancePayment > 0) {
      await createLedgerEntry(supabase, input.organizationId, row, {
        entryType: "insurance_payment",
        amount: insurancePayment,
        description: "Insurance payment posted from ERA 835 CLP04",
      });
      result.effects.push({
        entryType: "insurance_payment",
        amount: insurancePayment,
        description: "Insurance payment posted from ERA 835 CLP04",
      });
    }

    if (contractualAdjustment > 0) {
      await createLedgerEntry(supabase, input.organizationId, row, {
        entryType: "contractual_adjustment",
        amount: contractualAdjustment,
        groupCode: "CO",
        description: "Contractual adjustment posted from ERA 835 CAS CO segments",
      });
      result.effects.push({
        entryType: "contractual_adjustment",
        amount: contractualAdjustment,
        groupCode: "CO",
        description: "Contractual adjustment posted from ERA 835 CAS CO segments",
      });
    }

    let patientInvoiceCreated = false;
    if (patientResponsibility > 0) {
      await createLedgerEntry(supabase, input.organizationId, row, {
        entryType: "patient_responsibility",
        amount: patientResponsibility,
        groupCode: "PR",
        description: "Patient responsibility transferred from ERA 835 CLP05",
      });
      result.effects.push({
        entryType: "patient_responsibility",
        amount: patientResponsibility,
        groupCode: "PR",
        description: "Patient responsibility transferred from ERA 835 CLP05",
      });

      patientInvoiceCreated = await createPatientInvoiceIfNeeded(
        supabase,
        input.organizationId,
        row,
        actor,
        result.auditLogIds,
      );
      result.patientInvoiceCreated = patientInvoiceCreated;
    }

    const { error: updateError } = await supabase
      .from("era_claim_payments")
      .update({ posting_status: "posted", updated_at: now })
      .eq("id", row.id)
      .eq("organization_id", input.organizationId);
    if (updateError) throw new Error(updateError.message);

    const newClaimStatus =
      insurancePayment > 0 || patientResponsibility > 0 ? "paid" : "denied";

    const { error: claimUpdateError } = await supabase
      .from("professional_claims")
      .update({ claim_status: newClaimStatus, updated_at: now })
      .eq("id", row.professional_claim_id!)
      .eq("organization_id", input.organizationId);
    if (claimUpdateError) throw new Error(claimUpdateError.message);

    try {
      result.workqueueItemsClosed = await closeRelatedEraWorkqueueItems(
        supabase,
        input.organizationId,
        row.id,
        now,
      );
    } catch (workqueueError) {
      console.warn(
        "[postingEngine] failed to close related workqueue items",
        workqueueError instanceof Error ? workqueueError.message : workqueueError,
      );
    }

    // ── 6. Audit ──────────────────────────────────────────────────────────
    const auditLog = await writePaymentAuditLog(supabase, {
      organizationId: input.organizationId,
      actor,
      action: "payment_posted",
      objectType: "era_claim_payment",
      objectId: row.id,
      claimId: row.professional_claim_id,
      beforeValue: { posting_status: row.posting_status, claim_status: null },
      afterValue: {
        posting_status: "posted",
        claim_status: newClaimStatus,
        insurance_payment: insurancePayment,
        contractual_adjustment: contractualAdjustment,
        patient_responsibility: patientResponsibility,
      },
      summary: `Posted ERA 835 claim ${row.clp01_claim_control_number}: ${result.effects.length} ledger entr${result.effects.length === 1 ? "y" : "ies"}.`,
      metadata: {
        source: "era_835",
        clp01: row.clp01_claim_control_number,
        warnings: result.validation.warning.map((w) => w.code),
      },
    });
    if (auditLog) result.auditLogIds.push(auditLog.id);

    result.ok = true;
    result.posted = true;
    return result;
  } catch (error) {
    result.errors.push({
      field: row.clp01_claim_control_number,
      message: error instanceof Error ? error.message : "Failed to post ERA claim payment",
    });
    return result;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function createLedgerEntry(
  supabase: NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>,
  organizationId: string,
  payment: EraClaimPaymentRow,
  effect: PostingLedgerEffect,
) {
  const { data: existing, error: existingError } = await supabase
    .from("era_posting_ledger_entries")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("era_claim_payment_id", payment.id)
    .eq("entry_type", effect.entryType)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing?.id) return;

  const { error } = await supabase.from("era_posting_ledger_entries").insert({
    organization_id: organizationId,
    era_claim_payment_id: payment.id,
    professional_claim_id: payment.professional_claim_id,
    client_id: payment.client_id,
    entry_type: effect.entryType,
    amount: effect.amount,
    group_code: effect.groupCode ?? null,
    reason_code: effect.reasonCode ?? null,
    description: effect.description,
  });
  if (error) throw new Error(error.message);
}

async function createPatientInvoiceIfNeeded(
  supabase: NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>,
  organizationId: string,
  payment: EraClaimPaymentRow,
  actor: PostingActor,
  auditSink: string[],
): Promise<boolean> {
  const responsibility = Number(payment.clp05_patient_responsibility ?? 0);
  if (responsibility <= 0 || !payment.client_id) return false;

  const { data: existing } = await supabase
    .from("patient_invoices")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("era_claim_payment_id", payment.id)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();

  if (existing?.id) return false;

  const { data: inserted, error } = await supabase
    .from("patient_invoices")
    .insert({
      organization_id: organizationId,
      client_id: payment.client_id,
      professional_claim_id: payment.professional_claim_id,
      era_claim_payment_id: payment.id,
      invoice_status: "open",
      invoice_number: invoiceNumber(payment.id),
      patient_responsibility_amount: responsibility,
      paid_amount: 0,
      balance_amount: responsibility,
      source: "era_pr",
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  if (!inserted) return false;

  const audit = await writePaymentAuditLog(supabase, {
    organizationId,
    actor,
    action: "patient_invoice_created",
    objectType: "patient_invoice",
    objectId: String((inserted as { id: string }).id),
    claimId: payment.professional_claim_id,
    afterValue: {
      patient_responsibility_amount: responsibility,
      invoice_number: invoiceNumber(payment.id),
      source: "era_pr",
    },
    summary: `Patient invoice ${invoiceNumber(payment.id)} created from ERA PR balance ${responsibility.toFixed(2)}`,
  });
  if (audit) auditSink.push(audit.id);
  return true;
}

async function closeRelatedEraWorkqueueItems(
  supabase: NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>,
  organizationId: string,
  eraClaimPaymentId: string,
  now: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("workqueue_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("source_object_type", "era_claim_payment")
    .eq("source_object_id", eraClaimPaymentId)
    .in("work_type", ["era_mismatch", "era_835_exception"])
    .in("status", ["open", "in_progress", "blocked"])
    .is("archived_at", null);
  if (error) throw new Error(error.message);

  const ids = (data ?? []).map((row) => row.id);
  if (ids.length === 0) return 0;

  const { error: updateError } = await supabase
    .from("workqueue_items")
    .update({ status: "resolved", resolved_at: now, updated_at: now })
    .in("id", ids);
  if (updateError) throw new Error(updateError.message);
  return ids.length;
}
