/**
 * Payment Posting Engine — shared types.
 *
 * The engine is the single chokepoint for every write that changes a
 * payment ledger: ERA 835 auto-post, manual insurance post, patient
 * payment, recoupment, refund, reversal. Each call goes through:
 *   role guard → validation → commit → audit.
 *
 * Phase 1 (Task #107) wires only the ERA-835 single-claim path; manual
 * insurance / patient / reversal sources land in Tasks #109 & #110.
 */

export type PostingSourceType =
  | "era_835"
  | "manual_insurance"
  | "patient_payment"
  | "recoupment"
  | "refund"
  | "reversal";

/**
 * Caller-provided identity for audit and role enforcement.
 * Service-trusted callers (cron, internal background jobs) may omit this;
 * API-route callers MUST supply it after passing the role guard.
 */
export interface PostingActor {
  /** staff_profiles.id of the posting biller. */
  staffId: string | null;
  /** auth.users.id (Supabase auth uid), for audit_logs.user_id. */
  userId: string | null;
  /** First role from rbac (admin / biller / supervisor / clinician / …). */
  role: string | null;
  /** Free-text label for audit trail (e.g. "system: era-cron", "ui: era-detail"). */
  source: string;
}

/**
 * Discriminated union for the commit input.
 * Phase 1 implements `era_835` only.
 */
export type PostingSource =
  | {
      type: "era_835";
      /** era_claim_payments.id to post. */
      eraClaimPaymentId: string;
    }
  | {
      type: "manual_insurance";
      /** TODO: shape filled in by Task #109. */
      professionalClaimId: string;
      payerPaymentAmount: number;
      patientResponsibilityAmount: number;
      contractualAdjustmentAmount: number;
      checkOrEftNumber: string | null;
      paymentDate: string;
      clientId: string | null;
    }
  | {
      type: "patient_payment";
      /** TODO: shape filled in by Task #109. */
      clientId: string;
      patientInvoiceId: string | null;
      amount: number;
      method: "cash" | "check" | "card" | "ach" | "other";
      reference: string | null;
      paymentDate: string;
    }
  | {
      type: "recoupment";
      /** TODO: shape filled in by Task #110. */
      professionalClaimId: string;
      amount: number;
      reasonCode: string | null;
      description: string | null;
    }
  | {
      type: "refund";
      /** TODO: shape filled in by Task #110. */
      clientId: string;
      amount: number;
      reason: string | null;
    }
  | {
      type: "reversal";
      /** TODO: shape filled in by Task #110. */
      eraClaimPaymentId?: string;
      manualPostingId?: string;
      patientPaymentId?: string;
      reason: string;
    };

export interface CommitPostingInput {
  organizationId: string;
  source: PostingSource;
  actor?: PostingActor | null;
  /** When true, validation runs but no rows are written. */
  dryRun?: boolean;
}

export type ValidationSeverity = "blocking" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  field: string;
  message: string;
}

export interface ValidationResult {
  blocking: ValidationIssue[];
  warning: ValidationIssue[];
}

export interface PostingLedgerEffect {
  entryType: "insurance_payment" | "contractual_adjustment" | "patient_responsibility";
  amount: number;
  groupCode?: string | null;
  reasonCode?: string | null;
  description: string;
}

export interface CommitPostingResult {
  ok: boolean;
  /** True if any rows were actually written. */
  posted: boolean;
  /** True if the engine refused due to blocking validation. */
  blocked: boolean;
  /** True if engine treated this as a no-op replay. */
  alreadyPosted: boolean;
  validation: ValidationResult;
  effects: PostingLedgerEffect[];
  patientInvoiceCreated: boolean;
  workqueueItemsClosed: number;
  /** audit_logs.id rows written by the engine, in commit order. */
  auditLogIds: string[];
  errors: Array<{ field: string; message: string }>;
}

/**
 * Internal — the fully-hydrated row the validation + commit functions
 * operate on for the ERA 835 source. Mirrors EraClaimPaymentRow in
 * era835PostingService for backwards-compat reasons.
 */
export interface EraClaimPaymentRow {
  id: string;
  professional_claim_id: string | null;
  client_id: string | null;
  clp01_claim_control_number: string;
  clp03_total_charge: number;
  clp04_payment_amount: number;
  clp05_patient_responsibility: number;
  cas_adjustments: Array<{
    groupCode?: string;
    reasonCode?: string;
    amount?: number;
    group_code?: string;
    reason_code?: string;
  }>;
  claim_match_status: string;
  posting_status: string;
}
