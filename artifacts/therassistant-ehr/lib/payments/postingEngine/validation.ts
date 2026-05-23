/**
 * Payment Posting Engine — validation rules.
 *
 * Pure functions. No DB access, no side effects. Easy to unit-test.
 *
 * Rule classification follows spec §6 ("Validation Engine"):
 *   blocking → engine refuses to commit; UI shows red highlight.
 *   warning  → engine commits; UI shows yellow highlight + biller must
 *              acknowledge in the assisted poster (Task #108).
 */

import type {
  EraClaimPaymentRow,
  ValidationIssue,
  ValidationResult,
} from "./types";

/** Money tolerance for "balanced" checks. Half a cent. */
export const POSTING_BALANCE_TOLERANCE = 0.005;

function casGroupCode(adjustment: EraClaimPaymentRow["cas_adjustments"][number]) {
  return (adjustment.groupCode ?? adjustment.group_code ?? "").toString().toUpperCase();
}

function casReasonCode(adjustment: EraClaimPaymentRow["cas_adjustments"][number]) {
  return (adjustment.reasonCode ?? adjustment.reason_code ?? "").toString();
}

function sumAdjustments(
  adjustments: EraClaimPaymentRow["cas_adjustments"],
  groupCodeFilter?: string,
) {
  return (adjustments ?? [])
    .filter((adj) => !groupCodeFilter || casGroupCode(adj) === groupCodeFilter)
    .reduce((sum, adj) => sum + Number(adj.amount ?? 0), 0);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * Validate an ERA 835 single-claim posting attempt.
 *
 * @returns { blocking, warning } — both empty means the posting is clean.
 */
export function validateEra835Posting(row: EraClaimPaymentRow): ValidationResult {
  const blocking: ValidationIssue[] = [];
  const warning: ValidationIssue[] = [];

  // ── BLOCKING ──────────────────────────────────────────────────────────────

  if (row.claim_match_status !== "matched" || !row.professional_claim_id) {
    blocking.push({
      severity: "blocking",
      code: "claim_not_matched",
      field: "claim_match_status",
      message: "ERA claim payment is not matched to a claim and cannot be posted.",
    });
  }

  if (row.posting_status === "blocked") {
    blocking.push({
      severity: "blocking",
      code: "posting_status_blocked",
      field: "posting_status",
      message: "ERA claim payment is in blocked posting status; clear the underlying error first.",
    });
  }

  const charge = Number(row.clp03_total_charge ?? 0);
  const insurancePayment = Number(row.clp04_payment_amount ?? 0);
  const patientResp = Number(row.clp05_patient_responsibility ?? 0);
  const casTotal = sumAdjustments(row.cas_adjustments);

  if (insurancePayment < 0) {
    blocking.push({
      severity: "blocking",
      code: "negative_insurance_payment",
      field: "clp04_payment_amount",
      message: `Insurance payment cannot be negative (received ${insurancePayment.toFixed(2)}). Use a reversal/recoupment instead.`,
    });
  }

  if (patientResp < 0) {
    blocking.push({
      severity: "blocking",
      code: "negative_patient_responsibility",
      field: "clp05_patient_responsibility",
      message: `Patient responsibility cannot be negative (received ${patientResp.toFixed(2)}).`,
    });
  }

  // Balance check: charge ≈ payment + adjustments + patient_responsibility.
  // 835 spec: CLP03 = CLP04 + Σ(CAS amounts) + CLP05 (for the claim line).
  const expected = round2(insurancePayment + casTotal + patientResp);
  const actualCharge = round2(charge);
  const variance = round2(expected - actualCharge);

  if (Math.abs(variance) > POSTING_BALANCE_TOLERANCE * 2) {
    // > 1 cent off — block.
    blocking.push({
      severity: "blocking",
      code: "balance_mismatch",
      field: "clp03_total_charge",
      message: `Posting does not balance: payment ${insurancePayment.toFixed(2)} + adjustments ${casTotal.toFixed(2)} + patient ${patientResp.toFixed(2)} = ${expected.toFixed(2)}, but charge is ${actualCharge.toFixed(2)} (variance ${variance.toFixed(2)}).`,
    });
  } else if (Math.abs(variance) > POSTING_BALANCE_TOLERANCE) {
    // ½ cent .. 1 cent — warn (rounding noise).
    warning.push({
      severity: "warning",
      code: "balance_rounding",
      field: "clp03_total_charge",
      message: `Posting has minor rounding variance of ${variance.toFixed(4)}; auto-rounding to nearest cent.`,
    });
  }

  // ── WARNINGS ──────────────────────────────────────────────────────────────

  if (patientResp > 0 && !row.client_id) {
    warning.push({
      severity: "warning",
      code: "patient_resp_without_client",
      field: "client_id",
      message: "Patient responsibility was reported but the claim is not linked to a patient; no patient invoice will be created.",
    });
  }

  for (const [idx, adj] of (row.cas_adjustments ?? []).entries()) {
    const group = casGroupCode(adj);
    const reason = casReasonCode(adj);
    if (!group) {
      warning.push({
        severity: "warning",
        code: "cas_missing_group",
        field: `cas_adjustments[${idx}].groupCode`,
        message: `CAS adjustment ${idx + 1} is missing a group code (expected CO/PR/OA/CR/PI).`,
      });
    } else if (!["CO", "PR", "OA", "CR", "PI"].includes(group)) {
      warning.push({
        severity: "warning",
        code: "cas_unknown_group",
        field: `cas_adjustments[${idx}].groupCode`,
        message: `CAS adjustment ${idx + 1} has unrecognised group code "${group}".`,
      });
    }
    if (!reason) {
      warning.push({
        severity: "warning",
        code: "cas_missing_reason",
        field: `cas_adjustments[${idx}].reasonCode`,
        message: `CAS adjustment ${idx + 1} is missing a CARC reason code.`,
      });
    }
  }

  // Denial-like signal: zero payment, nonzero adjustments, no patient resp.
  if (insurancePayment === 0 && casTotal > 0 && patientResp === 0) {
    warning.push({
      severity: "warning",
      code: "likely_denial",
      field: "clp04_payment_amount",
      message: "Zero payment with non-zero adjustments and no patient responsibility — this looks like a denial; route to denial workqueue after posting.",
    });
  }

  return { blocking, warning };
}

/**
 * Convenience for the engine's "already posted?" replay check.
 * Returns true when posting_status indicates the row was already committed
 * and re-running would be a no-op.
 */
export function isAlreadyPosted(row: EraClaimPaymentRow): boolean {
  return row.posting_status === "posted";
}
