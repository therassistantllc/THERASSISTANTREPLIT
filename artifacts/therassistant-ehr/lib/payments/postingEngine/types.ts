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

type PostingSourceType =
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
      professionalClaimId: string;
      payerPaymentAmount: number;
      patientResponsibilityAmount: number;
      contractualAdjustmentAmount: number;
      checkOrEftNumber: string | null;
      paymentDate: string;
      clientId: string | null;
      totalChargeAmount?: number | null;
      eobReference?: string | null;
      mailroomItemId?: string | null;
      payerProfileId?: string | null;
      note?: string | null;
      /**
       * Per-service-line allocation (mirrors ERA 835 SVC line posting).
       * When present, the engine validates each line's paid+adj+pr against
       * its charge and writes per-line ledger entries linked to the
       * professional_claim_service_lines row.
       */
      serviceLineAllocations?: Array<{
        serviceLineId: string;
        chargeAmount: number;
        paidAmount: number;
        adjustmentAmount: number;
        patientResponsibilityAmount: number;
      }> | null;
    }
  | {
      type: "patient_payment";
      clientId: string;
      patientInvoiceId: string | null;
      amount: number;
      method:
        | "cash"
        | "check"
        | "credit_card"
        | "debit_card"
        | "stripe"
        | "external_card"
        | "refund"
        | "unapplied_credit"
        | "transferred_balance"
        | "other";
      reference: string | null;
      paymentDate: string;
      /** Source side of a transferred_balance move. */
      transferFrom?: {
        fromInvoiceId?: string | null;
        fromClaimId?: string | null;
      } | null;
    }
  | {
      /**
       * Recoupment (PP-5): payer takeback of a previously posted payment.
       * Dispatches to recordRecoupment, which writes a payment_recoupments
       * row, a negative ledger entry (source_type='recoupment'), and a
       * workqueue item for biller follow-up. Target must be a posted
       * era_835 or client_payment (manual EOBs are not supported by the
       * underlying recoupment recorder).
       */
      type: "recoupment";
      target: { kind: "era_835" | "client_payment"; id: string };
      amount: number;
      reason: string;
      reasonCode?: string | null;
      /** When the takeback is netted out of a subsequent ERA check. */
      offsetEraClaimPaymentId?: string | null;
    }
  | {
      /**
       * Refund (PP-4): refers to an existing posted payment and issues
       * insurance OR patient refund against it. Dispatched to
       * recordInsuranceRefund / recordPatientRefund. When refundType is
       * omitted the engine picks the natural fit for the source kind
       * (client_payment → patient, era/manual → insurance).
       */
      type: "refund";
      target: { kind: "era_835" | "client_payment" | "insurance_manual"; id: string };
      amount: number;
      reason: string;
      refundType?: "insurance" | "patient";
      stripeRefundId?: string | null;
      alreadyIssued?: boolean;
    }
  | {
      /**
       * Reversal (PP-4): undoes a previously posted payment by writing
       * paired negative ledger entries and restoring invoice/claim
       * balances. Dispatched to reversePostedPayment.
       */
      type: "reversal";
      target: { kind: "era_835" | "client_payment" | "insurance_manual"; id: string };
      reason: string;
    };

export interface CommitPostingInput {
  organizationId: string;
  source: PostingSource;
  actor?: PostingActor | null;
  /** When true, validation runs but no rows are written. */
  dryRun?: boolean;
}

type ValidationSeverity = "blocking" | "warning";

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
  /**
   * PP-4: present only when source.type === 'refund'. Surfaces the
   * payment_refunds row id, its terminal status (issued vs pending), and
   * any workqueue follow-up so callers don't have to call recordRefund
   * directly to see what was created.
   */
  refund?: {
    refundId: string | null;
    refundStatus: "pending" | "issued" | "failed" | "cancelled" | null;
    workqueueItemId: string | null;
    /** Populated when dryRun=true — see RefundPreview in reversal.ts. */
    preview?: import("./reversal").RefundPreview;
  };
  /**
   * PP-4 dry-run: populated when source.type === 'reversal' and dryRun=true.
   * Detailed preview of every write the live reverse would fire.
   */
  reversalPreview?: import("./reversal").ReversalPreview;
  /**
   * PP-4: present only when source.type === 'reversal'. True when the
   * reversal engine treated this as a no-op replay of an already-reversed
   * payment (distinct from `alreadyPosted` which targets posting replays).
   */
  alreadyReversed?: boolean;
  /**
   * PP-5: present only when source.type === 'recoupment'. Surfaces the
   * payment_recoupments row id, the paired negative ledger entry id, and
   * the workqueue item opened for biller follow-up.
   */
  recoupment?: {
    recoupmentId: string | null;
    ledgerEntryId: string | null;
    workqueueItemId: string | null;
    /** Populated when dryRun=true — see RecoupmentPreview in reversal.ts. */
    preview?: import("./reversal").RecoupmentPreview;
  };
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
