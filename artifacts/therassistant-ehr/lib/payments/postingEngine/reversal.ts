/**
 * Payment Posting Engine — reversal, void, recoupment, refund (Task #110).
 *
 * Every destructive operation on a posted payment routes through this
 * module so role-guard, validation, ledger writes, and audit are uniform
 * across ERA-835, manual-insurance, and client-payment sources.
 *
 * Exports:
 *   - reversePostedPayment   — undoes a posted payment (writes paired
 *     negative ledger entries with source_type='reversal', restores
 *     claim/invoice balances, marks posting_status='reversed').
 *   - voidPostedPayment      — marks posting_status='voided' WITHOUT
 *     financial reversal (used for data-entry mistakes caught before
 *     deposit). No ledger writes.
 *   - recordRecoupment       — inserts a payment_recoupments row linked
 *     to the original posted payment, writes a negative ledger entry
 *     (source_type='recoupment'), opens a workqueue item.
 *   - recordInsuranceRefund  — inserts a payment_refunds row
 *     (refund_type='insurance'), opens a workqueue item for the AR team
 *     to issue the payer-refund check.
 *   - recordPatientRefund    — inserts a payment_refunds row
 *     (refund_type='patient') linked to the originating client_payment.
 *     Stripe issuance is left to the dedicated Stripe webhook/task (#114);
 *     callers may pass a pre-issued stripeRefundId for reconciliation.
 *
 * Atomicity caveat (carry-forward from PP-3 reviewer notes): supabase-js
 * cannot wrap multi-table writes in a true SQL transaction. We minimise
 * partial-state risk by writing the immutable "intent" row (refund /
 * recoupment / reversal ledger) FIRST, then mutating parent balances —
 * so a mid-flight failure leaves an audit trail rather than silent state
 * loss.
 */

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { writePaymentAuditLog } from "./audit";
import type { PostingActor } from "./types";

export type PostedPaymentKind = "era_835" | "client_payment" | "insurance_manual";

export interface PostedPaymentRef {
  kind: PostedPaymentKind;
  id: string;
}

export interface ReverseOrVoidInput {
  organizationId: string;
  target: PostedPaymentRef;
  reason: string;
  actor: PostingActor;
  /**
   * When true, all validation runs and a `preview` is computed describing
   * what the live call WOULD do — but NO rows are mutated. Used by the
   * biller-facing "preview" UI before money actually moves.
   */
  dryRun?: boolean;
}

/**
 * Shape returned in dry-run mode so the UI can render exactly what a
 * live reverse would do. Every numeric is what the engine would write.
 */
export interface ReversalPreview {
  source: { kind: PostedPaymentKind; id: string; label: string };
  paymentTotalImpact: number;
  /** Paired negative entries the engine would insert (one per prior non-reversal ledger row). */
  ledgerReversalEntries: Array<{
    entryType: string;
    amount: number;
    groupCode: string | null;
    reasonCode: string | null;
    description: string;
  }>;
  /** For era/manual reversals: the claim would flip back to 'billed'. */
  claimStatusChange: { claimId: string; from: string; to: string } | null;
  /** For client_payment reversals where an invoice is linked: the would-be invoice delta. */
  patientInvoice: {
    invoiceId: string;
    currentPaidAmount: number;
    paidAmountDelta: number;
    newPaidAmount: number;
    newBalanceAmount: number;
    newStatus: string;
  } | null;
  /** Auto-created pending patient refund (Stripe/card client_payment reversals only). */
  autoPatientRefund: {
    amount: number;
    stripeChargeId: string | null;
    method: string;
  } | null;
  /** Open workqueue items the engine would resolve (era_835 reversals only). */
  workqueueItemsToClose: number;
}

export interface ReversalResult {
  ok: boolean;
  reversed: boolean;
  alreadyReversed: boolean;
  ledgerEntriesWritten: number;
  workqueueItemsClosed: number;
  auditLogIds: string[];
  errors: Array<{ field: string; message: string }>;
  /** Populated only when input.dryRun === true and validation passed. */
  preview?: ReversalPreview;
}

export interface VoidResult {
  ok: boolean;
  voided: boolean;
  alreadyVoided: boolean;
  auditLogIds: string[];
  errors: Array<{ field: string; message: string }>;
}

export interface RecordRecoupmentInput {
  organizationId: string;
  target: PostedPaymentRef; // ERA or client_payment being recouped
  amount: number;
  reasonCode?: string | null;
  reason: string;
  actor: PostingActor;
  /** Optional — when this recoupment is netted out of a subsequent ERA check. */
  offsetEraClaimPaymentId?: string | null;
  /**
   * When true, all validation runs (amount > 0, reason, target-kind,
   * remaining-recoupable cap) and a `preview` is computed describing what
   * the live call WOULD write — but NO rows are mutated. Used by the
   * biller-facing "preview" UI before money actually moves.
   */
  dryRun?: boolean;
}

/**
 * Shape returned in dry-run mode so the UI can render exactly what a live
 * recoupment would do (cap check, negative ledger entry, workqueue item).
 */
export interface RecoupmentPreview {
  source: { kind: PostedPaymentKind; id: string; label: string };
  amount: number;
  paymentTotalImpact: number;
  priorRefundTotal: number;
  priorRecoupTotal: number;
  remainingRecoupableBefore: number;
  remainingRecoupableAfter: number;
  /** Negative ledger entry the engine would insert. */
  ledgerEntry: {
    entryType: string;
    amount: number;
    groupCode: string;
    reasonCode: string | null;
    description: string;
  };
  /** Workqueue follow-up the engine would open (only when claim is linked). */
  workqueueItem: {
    wouldOpen: boolean;
    workType: string | null;
    title: string | null;
    priority: string | null;
  };
}

export interface RecordRecoupmentResult {
  ok: boolean;
  recoupmentId: string | null;
  workqueueItemId: string | null;
  ledgerEntryId: string | null;
  auditLogIds: string[];
  errors: Array<{ field: string; message: string }>;
  /** Populated only when input.dryRun === true and validation passed. */
  preview?: RecoupmentPreview;
}

export interface RecordRefundInput {
  organizationId: string;
  target: PostedPaymentRef;
  amount: number;
  reason: string;
  actor: PostingActor;
  /** For patient refunds issued via Stripe — supply the refund id for reconciliation. */
  stripeRefundId?: string | null;
  /** When true, the refund is marked 'issued' immediately (e.g. Stripe call already succeeded). */
  alreadyIssued?: boolean;
  /**
   * When true, all validation runs and a `preview` is computed describing
   * what the live call WOULD do — but NO rows are mutated and no Stripe
   * API call is made. Used by the biller-facing "preview" UI.
   */
  dryRun?: boolean;
}

/**
 * Shape returned in dry-run mode so the UI can render exactly what a
 * live refund would do (remaining balance, compensating ledger, invoice
 * delta, whether a Stripe API call would actually fire).
 */
export interface RefundPreview {
  source: { kind: PostedPaymentKind; id: string; label: string };
  refundType: "insurance" | "patient";
  amount: number;
  paymentTotalImpact: number;
  priorRefundTotal: number;
  priorRecoupTotal: number;
  remainingRefundableBefore: number;
  remainingRefundableAfter: number;
  /** What refund_status the row would be inserted with (before Stripe issuance). */
  initialRefundStatus: "pending" | "issued";
  /**
   * Compensating negative ledger entry the engine would post (only when
   * the refund ends 'issued' — insurance refunds always, patient refunds
   * only if Stripe auto-issuance would succeed in the live call).
   */
  compensatingLedgerEntry: {
    entryType: string;
    amount: number;
    description: string;
  } | null;
  /** For patient refunds linked to an invoice: the would-be invoice delta. */
  patientInvoice: {
    invoiceId: string;
    currentPaidAmount: number;
    paidAmountDelta: number;
    newPaidAmount: number;
    newBalanceAmount: number;
    newStatus: string;
  } | null;
  /** Whether the live call would hit Stripe, plus the exact request shape. */
  stripeRefund: {
    wouldFire: boolean;
    reason:
      | "would_fire"
      | "no_stripe_key"
      | "no_charge_or_intent"
      | "not_applicable"
      | "already_issued";
    chargeId: string | null;
    paymentIntentId: string | null;
    amountCents: number;
  } | null;
  /** Workqueue follow-up that would be opened (skipped when refund is already issued). */
  workqueueItem: {
    wouldOpen: boolean;
    queueType: string | null;
    title: string | null;
  };
}

export interface RecordRefundResult {
  ok: boolean;
  refundId: string | null;
  refundStatus: "pending" | "issued" | "failed" | "cancelled" | null;
  workqueueItemId: string | null;
  auditLogIds: string[];
  errors: Array<{ field: string; message: string }>;
  /** Populated only when input.dryRun === true and validation passed. */
  preview?: RefundPreview;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

type LoadedPayment = {
  kind: PostedPaymentKind;
  id: string;
  organizationId: string;
  clientId: string | null;
  professionalClaimId: string | null;
  payerProfileId: string | null;
  postingStatus: string;
  totalImpact: number;
  reversedAt: string | null;
  voidedAt: string | null;
  rawSourceLabel: string;
};

type SupabaseAdmin = NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>;

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

async function loadPayment(
  supabase: SupabaseAdmin,
  organizationId: string,
  target: PostedPaymentRef,
): Promise<LoadedPayment | null> {
  if (target.kind === "era_835") {
    const { data, error } = await supabase
      .from("era_claim_payments")
      .select(
        "id, organization_id, client_id, professional_claim_id, clp01_claim_control_number, clp04_payment_amount, posting_status, reversed_at, voided_at",
      )
      .eq("organization_id", organizationId)
      .eq("id", target.id)
      .is("archived_at", null)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    return {
      kind: "era_835",
      id: String(row.id),
      organizationId: String(row.organization_id),
      clientId: (row.client_id as string | null) ?? null,
      professionalClaimId: (row.professional_claim_id as string | null) ?? null,
      payerProfileId: null,
      postingStatus: String(row.posting_status ?? ""),
      totalImpact: Number(row.clp04_payment_amount ?? 0),
      reversedAt: (row.reversed_at as string | null) ?? null,
      voidedAt: (row.voided_at as string | null) ?? null,
      rawSourceLabel: `ERA 835 ${String(row.clp01_claim_control_number ?? target.id)}`,
    };
  }
  if (target.kind === "client_payment") {
    const { data, error } = await supabase
      .from("client_payments")
      .select(
        "id, organization_id, client_id, claim_id, patient_invoice_id, amount, payment_method, posting_status, reversed_at, voided_at, external_payment_id, stripe_charge_id",
      )
      .eq("organization_id", organizationId)
      .eq("id", target.id)
      .is("archived_at", null)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    return {
      kind: "client_payment",
      id: String(row.id),
      organizationId: String(row.organization_id),
      clientId: (row.client_id as string | null) ?? null,
      professionalClaimId: (row.claim_id as string | null) ?? null,
      payerProfileId: null,
      postingStatus: String(row.posting_status ?? ""),
      totalImpact: Number(row.amount ?? 0),
      reversedAt: (row.reversed_at as string | null) ?? null,
      voidedAt: (row.voided_at as string | null) ?? null,
      rawSourceLabel: `Client payment ${String(row.payment_method ?? "")} ${target.id.slice(0, 8)}`,
    };
  }
  // insurance_manual
  const { data, error } = await supabase
    .from("insurance_manual_payments")
    .select(
      "id, organization_id, client_id, professional_claim_id, payer_profile_id, payer_payment_amount, posting_status, reversed_at, voided_at, check_number",
    )
    .eq("organization_id", organizationId)
    .eq("id", target.id)
    .is("archived_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return {
    kind: "insurance_manual",
    id: String(row.id),
    organizationId: String(row.organization_id),
    clientId: (row.client_id as string | null) ?? null,
    professionalClaimId: (row.professional_claim_id as string | null) ?? null,
    payerProfileId: (row.payer_profile_id as string | null) ?? null,
    postingStatus: String(row.posting_status ?? ""),
    totalImpact: Number(row.payer_payment_amount ?? 0),
    reversedAt: (row.reversed_at as string | null) ?? null,
    voidedAt: (row.voided_at as string | null) ?? null,
    rawSourceLabel: `Manual EOB ${String(row.check_number ?? target.id.slice(0, 8))}`,
  };
}

function targetTable(kind: PostedPaymentKind): string {
  if (kind === "era_835") return "era_claim_payments";
  if (kind === "client_payment") return "client_payments";
  return "insurance_manual_payments";
}

function auditObjectType(kind: PostedPaymentKind) {
  if (kind === "era_835") return "era_claim_payment" as const;
  if (kind === "client_payment") return "client_payment" as const;
  return "insurance_manual_payment" as const;
}

function refundSourceColumn(kind: PostedPaymentKind): string {
  if (kind === "era_835") return "source_era_claim_payment_id";
  if (kind === "client_payment") return "source_client_payment_id";
  return "source_insurance_manual_payment_id";
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry-run preview helpers (no writes)
// ─────────────────────────────────────────────────────────────────────────────

async function buildReversalPreview(
  supabase: SupabaseAdmin,
  input: ReverseOrVoidInput,
  payment: LoadedPayment,
  result: ReversalResult,
): Promise<ReversalResult> {
  // Read the same ledger rows the live path would mirror, then synthesise
  // the negative entries it would insert. Excluding source_type='reversal'
  // matches the live INSERT filter so the preview row-count is exact.
  const { data: priorLedger, error: ledgerErr } = await supabase
    .from("era_posting_ledger_entries")
    .select(
      "entry_type, amount, group_code, reason_code, description, professional_claim_id, client_id",
    )
    .eq("organization_id", input.organizationId)
    .eq("source_id", payment.id)
    .neq("source_type", "reversal")
    .is("archived_at", null);
  if (ledgerErr) {
    result.errors.push({ field: "era_posting_ledger_entries", message: ledgerErr.message });
    return result;
  }
  const ledgerReversalEntries = (priorLedger ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      entryType: String(r.entry_type ?? ""),
      amount: -Math.abs(Number(r.amount ?? 0)),
      groupCode: (r.group_code as string | null) ?? null,
      reasonCode: (r.reason_code as string | null) ?? null,
      description: `Reversal of ${String(r.description ?? "ledger entry")} (${input.reason})`,
    };
  });

  let claimStatusChange: ReversalPreview["claimStatusChange"] = null;
  if (payment.professionalClaimId && payment.kind !== "client_payment") {
    claimStatusChange = {
      claimId: payment.professionalClaimId,
      from: payment.postingStatus === "posted" ? "paid" : payment.postingStatus,
      to: "billed",
    };
  }

  let patientInvoice: ReversalPreview["patientInvoice"] = null;
  let autoPatientRefund: ReversalPreview["autoPatientRefund"] = null;

  if (payment.kind === "client_payment") {
    const { data: cp } = await supabase
      .from("client_payments")
      .select("patient_invoice_id, amount, payment_method, stripe_charge_id")
      .eq("id", payment.id)
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    const cpRow = cp as Record<string, unknown> | null;
    const invId = (cpRow?.patient_invoice_id as string | null) ?? null;
    const amt = round2(Number((cpRow?.amount as number | undefined) ?? 0));
    const method = String(cpRow?.payment_method ?? "");
    const stripeChargeId = (cpRow?.stripe_charge_id as string | null) ?? null;

    if (amt > 0 && (stripeChargeId || method === "card" || method === "stripe")) {
      autoPatientRefund = { amount: amt, stripeChargeId, method };
    }

    if (invId && amt > 0) {
      const { data: inv } = await supabase
        .from("patient_invoices")
        .select("paid_amount, patient_responsibility_amount, invoice_status")
        .eq("id", invId)
        .eq("organization_id", input.organizationId)
        .maybeSingle();
      if (inv) {
        const ir = inv as Record<string, unknown>;
        const currentPaid = Number(ir.paid_amount ?? 0);
        const newPaid = round2(Math.max(currentPaid - amt, 0));
        const responsibility = Number(ir.patient_responsibility_amount ?? 0);
        const newBalance = round2(Math.max(responsibility - newPaid, 0));
        const curStatus = String(ir.invoice_status ?? "");
        const newStatus = newBalance > 0 && curStatus === "paid" ? "open" : curStatus;
        patientInvoice = {
          invoiceId: invId,
          currentPaidAmount: round2(currentPaid),
          paidAmountDelta: -round2(Math.min(amt, currentPaid)),
          newPaidAmount: newPaid,
          newBalanceAmount: newBalance,
          newStatus,
        };
      }
    }
  }

  let workqueueItemsToClose = 0;
  if (payment.kind === "era_835") {
    // See .agents/memory/workqueue-items-schema.md: workqueue_items rows
    // for ERA-domain sources are stored as source_object_type='payment_posting'
    // with the original logical kind in context_payload.
    const { count } = await supabase
      .from("workqueue_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", input.organizationId)
      .eq("source_object_type", "payment_posting")
      .eq("source_object_id", payment.id)
      .contains("context_payload", { logical_source_object_type: "era_claim_payment" })
      .in("status", ["open", "in_progress", "blocked"])
      .is("archived_at", null);
    workqueueItemsToClose = count ?? 0;
  }

  result.ok = true;
  // Mirror what the live path would report so dashboard counts line up.
  result.ledgerEntriesWritten = ledgerReversalEntries.length;
  result.workqueueItemsClosed = workqueueItemsToClose;
  result.preview = {
    source: { kind: payment.kind, id: payment.id, label: payment.rawSourceLabel },
    paymentTotalImpact: round2(payment.totalImpact),
    ledgerReversalEntries,
    claimStatusChange,
    patientInvoice,
    autoPatientRefund,
    workqueueItemsToClose,
  };
  return result;
}

async function buildRefundPreview(
  supabase: SupabaseAdmin,
  refundType: "insurance" | "patient",
  input: RecordRefundInput,
  payment: LoadedPayment,
  amount: number,
  priorRefundTotal: number,
  priorRecoupTotal: number,
  refundStatus: "pending" | "issued",
  result: RecordRefundResult,
): Promise<RecordRefundResult> {
  const remainingBefore = round2(payment.totalImpact - priorRefundTotal - priorRecoupTotal);
  const remainingAfter = round2(remainingBefore - amount);
  const amountCents = Math.round(amount * 100);

  // ── Stripe issuance preview ─────────────────────────────────────────────────
  // Mirror the same gating the live path uses; no HTTP call is made here.
  let stripeRefund: RefundPreview["stripeRefund"] = null;
  let stripeWouldIssue = false;
  if (refundType === "patient" && payment.kind === "client_payment") {
    if (input.alreadyIssued) {
      stripeRefund = {
        wouldFire: false,
        reason: "already_issued",
        chargeId: null,
        paymentIntentId: null,
        amountCents,
      };
    } else if (!process.env.STRIPE_SECRET_KEY) {
      stripeRefund = {
        wouldFire: false,
        reason: "no_stripe_key",
        chargeId: null,
        paymentIntentId: null,
        amountCents,
      };
    } else {
      const { data: cpRow } = await supabase
        .from("client_payments")
        .select("stripe_charge_id, stripe_payment_intent_id")
        .eq("id", payment.id)
        .eq("organization_id", input.organizationId)
        .maybeSingle();
      const cp = cpRow as
        | { stripe_charge_id?: string | null; stripe_payment_intent_id?: string | null }
        | null;
      const chargeId = cp?.stripe_charge_id ?? null;
      const piId = cp?.stripe_payment_intent_id ?? null;
      if (chargeId || piId) {
        stripeRefund = {
          wouldFire: true,
          reason: "would_fire",
          chargeId,
          paymentIntentId: piId,
          amountCents,
        };
        stripeWouldIssue = true;
      } else {
        stripeRefund = {
          wouldFire: false,
          reason: "no_charge_or_intent",
          chargeId: null,
          paymentIntentId: null,
          amountCents,
        };
      }
    }
  } else if (refundType === "insurance") {
    stripeRefund = {
      wouldFire: false,
      reason: "not_applicable",
      chargeId: null,
      paymentIntentId: null,
      amountCents,
    };
  }

  // Effective terminal status after the (simulated) Stripe issuance step.
  const effectiveStatus: "pending" | "issued" =
    refundStatus === "issued" || stripeWouldIssue ? "issued" : refundStatus;

  // ── Compensating ledger entry preview ─────────────────────────────────────
  // Insurance refund: writes when effective status is 'issued'.
  // Patient refund: live code does NOT write a ledger entry directly; the
  // invoice paid_amount reduction is the financial record. Keep null.
  let compensatingLedgerEntry: RefundPreview["compensatingLedgerEntry"] = null;
  if (refundType === "insurance" && effectiveStatus === "issued" && amount > 0) {
    compensatingLedgerEntry = {
      entryType: "payment",
      amount: -round2(amount),
      description: `Insurance refund issued: ${input.reason}`,
    };
  }

  // ── Patient invoice delta preview ─────────────────────────────────────────
  let patientInvoice: RefundPreview["patientInvoice"] = null;
  if (
    refundType === "patient" &&
    payment.kind === "client_payment" &&
    effectiveStatus === "issued"
  ) {
    const { data: cp } = await supabase
      .from("client_payments")
      .select("patient_invoice_id")
      .eq("id", payment.id)
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    const invId = (cp as { patient_invoice_id?: string | null } | null)?.patient_invoice_id ?? null;
    if (invId) {
      const { data: inv } = await supabase
        .from("patient_invoices")
        .select("paid_amount, patient_responsibility_amount, invoice_status")
        .eq("id", invId)
        .eq("organization_id", input.organizationId)
        .maybeSingle();
      if (inv) {
        const ir = inv as Record<string, unknown>;
        const currentPaid = Number(ir.paid_amount ?? 0);
        const newPaid = round2(Math.max(currentPaid - amount, 0));
        const responsibility = Number(ir.patient_responsibility_amount ?? 0);
        const newBalance = round2(Math.max(responsibility - newPaid, 0));
        const curStatus = String(ir.invoice_status ?? "");
        const newStatus = newBalance > 0 && curStatus === "paid" ? "open" : curStatus;
        patientInvoice = {
          invoiceId: invId,
          currentPaidAmount: round2(currentPaid),
          paidAmountDelta: -round2(Math.min(amount, currentPaid)),
          newPaidAmount: newPaid,
          newBalanceAmount: newBalance,
          newStatus,
        };
      }
    }
  }

  // ── Workqueue item preview ────────────────────────────────────────────────
  const queueType = refundType === "insurance" ? "insurance_refund" : "patient_refund";
  const wouldOpenWorkqueue = effectiveStatus !== "issued";
  const workqueueItem: RefundPreview["workqueueItem"] = {
    wouldOpen: wouldOpenWorkqueue,
    queueType: wouldOpenWorkqueue ? queueType : null,
    title: wouldOpenWorkqueue
      ? refundType === "insurance"
        ? `Issue payer refund ${amount.toFixed(2)} on ${payment.rawSourceLabel}`
        : `Issue patient refund ${amount.toFixed(2)} on ${payment.rawSourceLabel}`
      : null,
  };

  result.ok = true;
  result.refundStatus = effectiveStatus;
  result.preview = {
    source: { kind: payment.kind, id: payment.id, label: payment.rawSourceLabel },
    refundType,
    amount,
    paymentTotalImpact: round2(payment.totalImpact),
    priorRefundTotal: round2(priorRefundTotal),
    priorRecoupTotal: round2(priorRecoupTotal),
    remainingRefundableBefore: remainingBefore,
    remainingRefundableAfter: remainingAfter,
    initialRefundStatus: refundStatus,
    compensatingLedgerEntry,
    patientInvoice,
    stripeRefund,
    workqueueItem,
  };
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// reversePostedPayment
// ─────────────────────────────────────────────────────────────────────────────

export async function reversePostedPayment(
  input: ReverseOrVoidInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<ReversalResult> {
  const result: ReversalResult = {
    ok: false,
    reversed: false,
    alreadyReversed: false,
    ledgerEntriesWritten: 0,
    workqueueItemsClosed: 0,
    auditLogIds: [],
    errors: [],
  };

  if (!input.reason || !input.reason.trim()) {
    result.errors.push({ field: "reason", message: "Reversal reason is required." });
    return result;
  }

  const supabase = injectedSupabase ?? createServerSupabaseAdminClient();
  if (!supabase) {
    result.errors.push({ field: "system", message: "Database connection not available" });
    return result;
  }

  const payment = await loadPayment(supabase, input.organizationId, input.target);
  if (!payment) {
    result.errors.push({ field: input.target.kind, message: "Posted payment not found." });
    return result;
  }

  // Object-level auth: explicit org check (defence in depth — the load
  // query already filtered on org, but a future refactor must not lose it).
  if (payment.organizationId !== input.organizationId) {
    result.errors.push({ field: "organizationId", message: "Cross-tenant access denied." });
    return result;
  }

  if (payment.postingStatus === "reversed" || payment.reversedAt) {
    result.ok = true;
    result.alreadyReversed = true;
    return result;
  }
  if (payment.postingStatus === "voided" || payment.voidedAt) {
    result.errors.push({
      field: "posting_status",
      message: "Voided payments cannot be reversed (they already have no financial impact).",
    });
    return result;
  }
  if (payment.postingStatus !== "posted") {
    result.errors.push({
      field: "posting_status",
      message: `Only posted payments can be reversed (current: ${payment.postingStatus}).`,
    });
    return result;
  }

  const now = new Date().toISOString();

  // ── 0. Dry-run preview ─────────────────────────────────────────────────────
  // When dryRun=true, run the same READ queries the live path would run,
  // assemble a preview of every write that WOULD fire, and return without
  // mutating any table (or hitting Stripe). Callers use this to render a
  // confirm-modal before money actually moves.
  if (input.dryRun) {
    return await buildReversalPreview(supabase, input, payment, result);
  }

  // ── 1. Concurrency guard: conditional status flip BEFORE any ledger writes
  // Two parallel reverse requests would otherwise both see `posted` and both
  // insert reversal rows. Atomically flip posting_status='reversed' only if it
  // is still 'posted' and reversed_at is null; if the update affects zero rows
  // another caller won the race and we return as alreadyReversed.
  const { data: claimed, error: claimErr } = await supabase
    .from(targetTable(payment.kind))
    .update({
      posting_status: "reversed",
      reversed_at: now,
      reversal_reason: input.reason,
      reversed_by_actor_id: input.actor.staffId ?? null,
      updated_at: now,
    })
    .eq("id", payment.id)
    .eq("organization_id", input.organizationId)
    .eq("posting_status", "posted")
    .is("reversed_at", null)
    .select("id");
  if (claimErr) {
    result.errors.push({ field: targetTable(payment.kind), message: claimErr.message });
    return result;
  }
  if (!claimed || (Array.isArray(claimed) && claimed.length === 0)) {
    // Lost the race — another caller already reversed (or status changed).
    result.ok = true;
    result.alreadyReversed = true;
    return result;
  }

  // ── 2. Write paired negative ledger entries.
  // Mirror every prior NON-REVERSAL ledger row for this source as a negative
  // entry. Excluding source_type='reversal' is essential so re-reads / retries
  // don't double-mirror compensating rows.
  // Atomicity-rollback helper. Supabase has no client-side transactions, so
  // any failure AFTER the step-1 status flip must compensate by restoring
  // posting_status='posted' and clearing the reversal columns. Otherwise we
  // leave the payment marked 'reversed' with no compensating ledger entries —
  // financial-state divergence between header and ledger.
  const restoreStatus = async () => {
    // Compensating cleanup: any reversal ledger rows we already inserted for
    // this source must be archived too, otherwise the header reverts to
    // 'posted' while compensating negatives remain — corrupting balances.
    // Best-effort; even if this archive fails, the header restore proceeds so
    // we never leave the header in 'reversed' with no compensating rows.
    const restoreNow = new Date().toISOString();
    await supabase
      .from("era_posting_ledger_entries")
      .update({ archived_at: restoreNow })
      .eq("organization_id", input.organizationId)
      .eq("source_id", payment.id)
      .eq("source_type", "reversal")
      .is("archived_at", null);
    await supabase
      .from(targetTable(payment.kind))
      .update({
        posting_status: "posted",
        reversed_at: null,
        reversal_reason: null,
        reversed_by_actor_id: null,
        updated_at: restoreNow,
      })
      .eq("id", payment.id)
      .eq("organization_id", input.organizationId);
  };

  const { data: priorLedger, error: ledgerLoadErr } = await supabase
    .from("era_posting_ledger_entries")
    .select("id, entry_type, amount, group_code, reason_code, description, professional_claim_id, client_id, era_claim_payment_id, source_type")
    .eq("organization_id", input.organizationId)
    .eq("source_id", payment.id)
    .neq("source_type", "reversal")
    .is("archived_at", null);
  if (ledgerLoadErr) {
    await restoreStatus();
    result.errors.push({ field: "era_posting_ledger_entries", message: ledgerLoadErr.message });
    return result;
  }

  const reversalRows = (priorLedger ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      organization_id: input.organizationId,
      era_claim_payment_id: r.era_claim_payment_id ?? null,
      source_type: "reversal" as const,
      source_id: payment.id,
      professional_claim_id: r.professional_claim_id ?? payment.professionalClaimId,
      client_id: r.client_id ?? payment.clientId,
      entry_type: r.entry_type,
      amount: -Math.abs(Number(r.amount ?? 0)),
      group_code: r.group_code ?? null,
      reason_code: r.reason_code ?? null,
      description: `Reversal of ${String(r.description ?? "ledger entry")} (${input.reason})`,
    };
  });

  if (reversalRows.length > 0) {
    const { error: ledgerInsertErr } = await supabase
      .from("era_posting_ledger_entries")
      .insert(reversalRows);
    if (ledgerInsertErr) {
      await restoreStatus();
      result.errors.push({ field: "era_posting_ledger_entries", message: ledgerInsertErr.message });
      return result;
    }
    result.ledgerEntriesWritten = reversalRows.length;
  }

  // ── 2. Restore claim balance (best-effort; PP-5 dashboard recomputes) ──────
  if (payment.professionalClaimId && payment.kind !== "client_payment") {
    // ERA / manual-insurance reversal frees the claim back to a billable state.
    await supabase
      .from("professional_claims")
      .update({ claim_status: "billed", updated_at: now })
      .eq("id", payment.professionalClaimId)
      .eq("organization_id", input.organizationId);
  }

  // ── 3. Restore patient invoice balance for client_payment reversals ────────
  // Also: when the underlying client payment was a Stripe charge, the
  // reversal *requires* an outbound refund — patients can't just have a
  // ledger correction; we must initiate the money-movement flow. We create a
  // pending patient refund row + workqueue item so AR / Stripe-ops can issue.
  if (payment.kind === "client_payment") {
    const { data: cp } = await supabase
      .from("client_payments")
      .select("patient_invoice_id, amount, payment_method, stripe_charge_id, client_id, claim_id")
      .eq("id", payment.id)
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    const cpRow = cp as Record<string, unknown> | null;
    const invId = (cpRow?.patient_invoice_id as string | null) ?? null;
    const amt = round2(Number((cpRow?.amount as number | undefined) ?? 0));

    // Auto-create patient refund + workqueue if the original payment had
    // outbound money movement (Stripe or any non-cash method). Cash/check
    // reversals are AR-paper only.
    const method = String(cpRow?.payment_method ?? "");
    const needsOutboundRefund = amt > 0 && (cpRow?.stripe_charge_id || method === "card" || method === "stripe");
    if (needsOutboundRefund) {
      // Fail-closed: a patient reversal that did NOT successfully record a
      // refund-initiation obligation must roll the reversal back. Otherwise
      // the patient is "owed money" but no system-of-record exists for AR.
      const { data: refundRow, error: refundErr } = await supabase
        .from("payment_refunds")
        .insert({
          organization_id: input.organizationId,
          source_client_payment_id: payment.id,
          refund_type: "patient",
          amount: amt,
          reason: `Auto-initiated by reversal: ${input.reason}`,
          refund_status: "pending",
          requested_by_actor_id: input.actor.staffId ?? null,
          stripe_charge_id: (cpRow?.stripe_charge_id as string | null) ?? null,
          patient_invoice_id: invId,
          client_id: (cpRow?.client_id as string | null) ?? payment.clientId,
        })
        .select("id")
        .single();
      if (refundErr || !refundRow) {
        await restoreStatus();
        result.errors.push({
          field: "payment_refunds",
          message: `Auto-refund initiation failed: ${refundErr?.message ?? "insert returned no row"}. Reversal rolled back.`,
        });
        return result;
      }
      const refundId = (refundRow as { id: string }).id;
      // Schema invariants (see .agents/memory/workqueue-items-schema.md):
      //   - column is `work_type`; `queue_type` is a legacy column new
      //     insert paths must not set.
      //   - `source_object_type` is a Postgres ENUM — `payment_refund` is
      //     NOT a valid member, so use `payment_posting` and stash the
      //     refund linkage in `context_payload` for downstream filters.
      const { error: wqErr } = await supabase.from("workqueue_items").insert({
        organization_id: input.organizationId,
        work_type: "patient_refund",
        status: "open",
        priority: "high",
        title: `Issue patient refund $${amt.toFixed(2)} (reversal)`,
        description: `Patient refund triggered by payment reversal. Stripe charge: ${String(cpRow?.stripe_charge_id ?? "n/a")}.`,
        source_object_type: "payment_posting",
        source_object_id: refundId,
        client_id: (cpRow?.client_id as string | null) ?? payment.clientId,
        context_payload: {
          origin: "reversal_auto_refund",
          payment_refund_id: refundId,
          source_kind: payment.kind,
          source_id: payment.id,
          stripe_charge_id: (cpRow?.stripe_charge_id as string | null) ?? null,
          amount: amt,
        },
      });
      if (wqErr) {
        // Refund row exists but workqueue creation failed — append a warning
        // but DO NOT fail the reversal: the refund row is the source of truth
        // for the obligation; workqueue is a denormalized convenience and a
        // sweeper can re-open it. The compensating ledger writes are also
        // already committed.
        result.errors.push({
          field: "workqueue_items",
          message: `Refund row created but workqueue item failed: ${wqErr.message}. AR queue sweep will recover.`,
        });
      }
    }

    if (invId && amt > 0) {
      const { data: inv } = await supabase
        .from("patient_invoices")
        .select("paid_amount, balance_amount, patient_responsibility_amount, invoice_status")
        .eq("id", invId)
        .eq("organization_id", input.organizationId)
        .maybeSingle();
      if (inv) {
        const row = inv as Record<string, unknown>;
        const newPaid = round2(Math.max(Number(row.paid_amount ?? 0) - amt, 0));
        const responsibility = Number(row.patient_responsibility_amount ?? 0);
        const newBalance = round2(Math.max(responsibility - newPaid, 0));
        const newStatus = newBalance > 0 && row.invoice_status === "paid" ? "open" : row.invoice_status;
        await supabase
          .from("patient_invoices")
          .update({
            paid_amount: newPaid,
            balance_amount: newBalance,
            invoice_status: newStatus,
            updated_at: now,
          })
          .eq("id", invId)
          .eq("organization_id", input.organizationId);
      }
    }
  }

  // ── 4. (parent posting_status already flipped in step 1) ───────────────────
  // ── 5. Close ERA-mismatch workqueue items that were opened for this payment
  if (payment.kind === "era_835") {
    // See .agents/memory/workqueue-items-schema.md: workqueue_items rows for
    // ERA-domain sources are stored as source_object_type='payment_posting'
    // with the original logical kind in context_payload. Filtering by the
    // old logical literal silently returned zero rows.
    const { data: wq } = await supabase
      .from("workqueue_items")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("source_object_type", "payment_posting")
      .eq("source_object_id", payment.id)
      .contains("context_payload", { logical_source_object_type: "era_claim_payment" })
      .in("status", ["open", "in_progress", "blocked"])
      .is("archived_at", null);
    const ids = (wq ?? []).map((r) => (r as { id: string }).id);
    if (ids.length > 0) {
      await supabase
        .from("workqueue_items")
        .update({ status: "resolved", resolved_at: now, updated_at: now })
        .in("id", ids);
      result.workqueueItemsClosed = ids.length;
    }
  }

  // ── 6. Audit ───────────────────────────────────────────────────────────────
  const audit = await writePaymentAuditLog(supabase, {
    organizationId: input.organizationId,
    actor: input.actor,
    action: "payment_reversed",
    objectType: auditObjectType(payment.kind),
    objectId: payment.id,
    claimId: payment.professionalClaimId,
    beforeValue: { posting_status: payment.postingStatus },
    afterValue: {
      posting_status: "reversed",
      reversed_at: now,
      ledger_reversal_rows: result.ledgerEntriesWritten,
    },
    summary: `Reversed ${payment.rawSourceLabel}: ${input.reason}`,
    metadata: { source_kind: payment.kind, reversal_reason: input.reason },
  });
  if (audit) result.auditLogIds.push(audit.id);

  result.ok = true;
  result.reversed = true;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// voidPostedPayment
// ─────────────────────────────────────────────────────────────────────────────

export async function voidPostedPayment(
  input: ReverseOrVoidInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<VoidResult> {
  const result: VoidResult = {
    ok: false,
    voided: false,
    alreadyVoided: false,
    auditLogIds: [],
    errors: [],
  };

  if (!input.reason || !input.reason.trim()) {
    result.errors.push({ field: "reason", message: "Void reason is required." });
    return result;
  }

  const supabase = injectedSupabase ?? createServerSupabaseAdminClient();
  if (!supabase) {
    result.errors.push({ field: "system", message: "Database connection not available" });
    return result;
  }

  const payment = await loadPayment(supabase, input.organizationId, input.target);
  if (!payment) {
    result.errors.push({ field: input.target.kind, message: "Posted payment not found." });
    return result;
  }

  if (payment.postingStatus === "voided" || payment.voidedAt) {
    result.ok = true;
    result.alreadyVoided = true;
    return result;
  }
  if (payment.postingStatus === "reversed") {
    result.errors.push({
      field: "posting_status",
      message: "Reversed payments cannot be voided; the financial impact has already been undone.",
    });
    return result;
  }
  // Void is reserved for data-entry mistakes caught BEFORE balances post.
  // If the payment is already posted and any ledger entries exist, the
  // caller MUST use reversal — voiding would orphan financial state.
  if (payment.postingStatus === "posted") {
    const { count } = await supabase
      .from("era_posting_ledger_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", input.organizationId)
      .eq("source_id", payment.id)
      .is("archived_at", null);
    if ((count ?? 0) > 0) {
      result.errors.push({
        field: "posting_status",
        message: "Cannot void a posted payment with ledger impact. Use reversal instead.",
      });
      return result;
    }
  }

  const now = new Date().toISOString();
  // Concurrency-safe flip: only succeed if status is still the value we read
  // (posted/blocked) AND voided_at is still null. Lost races → alreadyVoided.
  const { data: claimed, error: updateErr } = await supabase
    .from(targetTable(payment.kind))
    .update({
      posting_status: "voided",
      voided_at: now,
      void_reason: input.reason,
      voided_by_actor_id: input.actor.staffId ?? null,
      updated_at: now,
    })
    .eq("id", payment.id)
    .eq("organization_id", input.organizationId)
    .eq("posting_status", payment.postingStatus)
    .is("voided_at", null)
    .select("id");
  if (updateErr) {
    result.errors.push({ field: targetTable(payment.kind), message: updateErr.message });
    return result;
  }
  if (!claimed || (Array.isArray(claimed) && claimed.length === 0)) {
    result.ok = true;
    result.alreadyVoided = true;
    return result;
  }

  const audit = await writePaymentAuditLog(supabase, {
    organizationId: input.organizationId,
    actor: input.actor,
    action: "payment_voided",
    objectType: auditObjectType(payment.kind),
    objectId: payment.id,
    claimId: payment.professionalClaimId,
    beforeValue: { posting_status: payment.postingStatus },
    afterValue: { posting_status: "voided", voided_at: now },
    summary: `Voided ${payment.rawSourceLabel}: ${input.reason}`,
    metadata: { source_kind: payment.kind, void_reason: input.reason },
  });
  if (audit) result.auditLogIds.push(audit.id);

  result.ok = true;
  result.voided = true;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// recordRecoupment
// ─────────────────────────────────────────────────────────────────────────────

export async function recordRecoupment(
  input: RecordRecoupmentInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<RecordRecoupmentResult> {
  const result: RecordRecoupmentResult = {
    ok: false,
    recoupmentId: null,
    workqueueItemId: null,
    ledgerEntryId: null,
    auditLogIds: [],
    errors: [],
  };

  const amount = round2(Number(input.amount ?? 0));
  if (amount <= 0) {
    result.errors.push({ field: "amount", message: "Recoupment amount must be greater than zero." });
    return result;
  }
  if (!input.reason || !input.reason.trim()) {
    result.errors.push({ field: "reason", message: "Recoupment reason is required." });
    return result;
  }
  if (input.target.kind === "insurance_manual") {
    result.errors.push({
      field: "target.kind",
      message: "Recoupments apply to ERA-835 or client_payment sources, not manual EOBs.",
    });
    return result;
  }

  const supabase = injectedSupabase ?? createServerSupabaseAdminClient();
  if (!supabase) {
    result.errors.push({ field: "system", message: "Database connection not available" });
    return result;
  }

  const payment = await loadPayment(supabase, input.organizationId, input.target);
  if (!payment) {
    result.errors.push({ field: input.target.kind, message: "Original payment not found." });
    return result;
  }
  if (payment.postingStatus !== "posted") {
    result.errors.push({
      field: "posting_status",
      message: `Cannot recoup against a ${payment.postingStatus} payment.`,
    });
    return result;
  }

  // Refund/recoupment must not exceed the original payment amount minus
  // anything previously refunded or recouped against the same source.
  const sourceCol =
    payment.kind === "era_835" ? "source_era_claim_payment_id" : "source_client_payment_id";
  const [{ data: priorRecoups }, { data: priorRefunds }] = await Promise.all([
    supabase
      .from("payment_recoupments")
      .select("amount")
      .eq("organization_id", input.organizationId)
      .eq(sourceCol, payment.id)
      .is("archived_at", null),
    supabase
      .from("payment_refunds")
      .select("amount, refund_status")
      .eq("organization_id", input.organizationId)
      .eq(sourceCol, payment.id)
      .is("archived_at", null),
  ]);
  const priorRecoupTotal = (priorRecoups ?? []).reduce(
    (s, r) => s + Number((r as { amount?: number }).amount ?? 0),
    0,
  );
  const priorRefundTotal = (priorRefunds ?? [])
    .filter((r) => (r as { refund_status?: string }).refund_status !== "cancelled")
    .reduce((s, r) => s + Number((r as { amount?: number }).amount ?? 0), 0);
  const remaining = round2(payment.totalImpact - priorRecoupTotal - priorRefundTotal);
  if (amount > remaining + 0.005) {
    result.errors.push({
      field: "amount",
      message: `Recoupment ${amount.toFixed(2)} exceeds remaining recoupable balance ${remaining.toFixed(2)} (original ${payment.totalImpact.toFixed(2)}, prior recoups ${priorRecoupTotal.toFixed(2)}, prior refunds ${priorRefundTotal.toFixed(2)}).`,
    });
    return result;
  }

  // ── Dry-run preview ───────────────────────────────────────────────────────
  // All validation (amount > 0, reason, target-kind, remaining cap) has
  // already run above. For the over-cap concurrent-write guard, we re-read
  // the prior totals a second time WITHOUT inserting — if a concurrent
  // recoup/refund has already pushed totals near the original between the
  // first cap check and now, we surface the same 409 the live path would.
  if (input.dryRun) {
    const [{ data: nowRecoupsDry }, { data: nowRefundsDry }] = await Promise.all([
      supabase
        .from("payment_recoupments")
        .select("amount")
        .eq("organization_id", input.organizationId)
        .eq(sourceCol, payment.id)
        .is("archived_at", null),
      supabase
        .from("payment_refunds")
        .select("amount, refund_status")
        .eq("organization_id", input.organizationId)
        .eq(sourceCol, payment.id)
        .is("archived_at", null),
    ]);
    const nowRecoupTotalDry = (nowRecoupsDry ?? []).reduce(
      (s, r) => s + Number((r as { amount?: number }).amount ?? 0),
      0,
    );
    const nowRefundTotalDry = (nowRefundsDry ?? [])
      .filter((r) => (r as { refund_status?: string }).refund_status !== "cancelled")
      .reduce((s, r) => s + Number((r as { amount?: number }).amount ?? 0), 0);
    if (round2(amount + nowRecoupTotalDry + nowRefundTotalDry) > payment.totalImpact + 0.005) {
      result.errors.push({
        field: "amount",
        message: `Concurrent recoupment/refund would push total over original ${payment.totalImpact.toFixed(2)}. Re-enter with adjusted amount.`,
      });
      return result;
    }

    const remainingBefore = round2(payment.totalImpact - nowRecoupTotalDry - nowRefundTotalDry);
    const remainingAfter = round2(remainingBefore - amount);

    const wouldOpenWq = Boolean(payment.professionalClaimId);
    result.ok = true;
    result.preview = {
      source: { kind: payment.kind, id: payment.id, label: payment.rawSourceLabel },
      amount,
      paymentTotalImpact: round2(payment.totalImpact),
      priorRefundTotal: round2(nowRefundTotalDry),
      priorRecoupTotal: round2(nowRecoupTotalDry),
      remainingRecoupableBefore: remainingBefore,
      remainingRecoupableAfter: remainingAfter,
      ledgerEntry: {
        entryType: "insurance_payment",
        amount: -amount,
        groupCode: "OA",
        reasonCode: input.reasonCode ?? null,
        description: `Recoupment: ${input.reason}`,
      },
      workqueueItem: {
        wouldOpen: wouldOpenWq,
        workType: wouldOpenWq ? "recoupment_review" : null,
        title: wouldOpenWq
          ? `Payer recoupment ${amount.toFixed(2)} on ${payment.rawSourceLabel}`
          : null,
        priority: wouldOpenWq ? "high" : null,
      },
    };
    return result;
  }

  // ── 1. Insert recoupment row (immutable intent first) ──────────────────────
  const insertPayload: Record<string, unknown> = {
    organization_id: input.organizationId,
    source_era_claim_payment_id: payment.kind === "era_835" ? payment.id : null,
    source_client_payment_id: payment.kind === "client_payment" ? payment.id : null,
    offset_era_claim_payment_id: input.offsetEraClaimPaymentId ?? null,
    professional_claim_id: payment.professionalClaimId,
    client_id: payment.clientId,
    payer_profile_id: payment.payerProfileId,
    amount,
    reason_code: input.reasonCode ?? null,
    reason: input.reason,
    recouped_by_actor_id: input.actor.staffId ?? null,
  };
  const { data: inserted, error: insertErr } = await supabase
    .from("payment_recoupments")
    .insert(insertPayload)
    .select("id")
    .single();
  if (insertErr || !inserted) {
    result.errors.push({
      field: "payment_recoupments",
      message: insertErr?.message ?? "Failed to insert recoupment.",
    });
    return result;
  }
  result.recoupmentId = String((inserted as { id: string }).id);

  // ── 1b. Race-safe cap re-verify after insert. Two parallel recoups could
  // each pass the pre-check and together exceed the original. Re-aggregate
  // after our row lands; if total exceeds original, rollback our insert and
  // surface a 409 to the caller so the AR team can re-enter with corrected
  // amount.
  const [{ data: nowRecoups }, { data: nowRefunds }] = await Promise.all([
    supabase
      .from("payment_recoupments")
      .select("amount")
      .eq("organization_id", input.organizationId)
      .eq(sourceCol, payment.id)
      .is("archived_at", null),
    supabase
      .from("payment_refunds")
      .select("amount, refund_status")
      .eq("organization_id", input.organizationId)
      .eq(sourceCol, payment.id)
      .is("archived_at", null),
  ]);
  const nowRecoupTotal = (nowRecoups ?? []).reduce(
    (s, r) => s + Number((r as { amount?: number }).amount ?? 0),
    0,
  );
  const nowRefundTotal = (nowRefunds ?? [])
    .filter((r) => (r as { refund_status?: string }).refund_status !== "cancelled")
    .reduce((s, r) => s + Number((r as { amount?: number }).amount ?? 0), 0);
  if (round2(nowRecoupTotal + nowRefundTotal) > payment.totalImpact + 0.005) {
    await supabase
      .from("payment_recoupments")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", result.recoupmentId)
      .eq("organization_id", input.organizationId);
    result.recoupmentId = null;
    result.errors.push({
      field: "amount",
      message: `Concurrent recoupment/refund pushed total over original ${payment.totalImpact.toFixed(2)}. Re-enter with adjusted amount.`,
    });
    return result;
  }

  // ── 2. Negative ledger entry (source_type='recoupment') ────────────────────
  const { data: ledger, error: ledgerErr } = await supabase
    .from("era_posting_ledger_entries")
    .insert({
      organization_id: input.organizationId,
      era_claim_payment_id: payment.kind === "era_835" ? payment.id : null,
      source_type: "recoupment",
      source_id: result.recoupmentId,
      professional_claim_id: payment.professionalClaimId,
      client_id: payment.clientId,
      entry_type: "insurance_payment",
      amount: -amount,
      group_code: "OA",
      reason_code: input.reasonCode ?? null,
      description: `Recoupment: ${input.reason}`,
    })
    .select("id")
    .single();
  if (ledgerErr) {
    result.errors.push({ field: "era_posting_ledger_entries", message: ledgerErr.message });
    return result;
  }
  if (ledger) result.ledgerEntryId = String((ledger as { id: string }).id);

  // ── 3. Open a workqueue item for the affected claim ────────────────────────
  if (payment.professionalClaimId) {
    // Schema invariants (see .agents/memory/workqueue-items-schema.md):
    //   - column is `client_id`, NOT patient_id
    //   - column is `work_type`, no `queue_type`
    //   - `payer_id` is NOT a workqueue_items column
    //   - `source_object_type` is an enum — `payment_recoupment` is not a
    //     valid value, so use `payment_posting` (the closest enum family
    //     for ledger-affecting events) and stash the recoupment linkage in
    //     `context_payload` for downstream filters.
    const { data: wq } = await supabase
      .from("workqueue_items")
      .insert({
        organization_id: input.organizationId,
        professional_claim_id: payment.professionalClaimId,
        claim_id: payment.professionalClaimId,
        client_id: payment.clientId,
        work_type: "recoupment_review",
        priority: "high",
        status: "open",
        title: `Payer recoupment ${amount.toFixed(2)} on ${payment.rawSourceLabel}`,
        description: input.reason,
        source_object_type: "payment_posting",
        source_object_id: result.recoupmentId,
        context_payload: {
          origin: "recoupment",
          payment_recoupment_id: result.recoupmentId,
          source_kind: payment.kind,
          source_id: payment.id,
          amount,
          reason_code: input.reasonCode ?? null,
        },
      })
      .select("id")
      .single();
    if (wq) {
      result.workqueueItemId = String((wq as { id: string }).id);
      await supabase
        .from("payment_recoupments")
        .update({ workqueue_item_id: result.workqueueItemId })
        .eq("id", result.recoupmentId)
        .eq("organization_id", input.organizationId);
    }
  }

  // ── 4. Audit ───────────────────────────────────────────────────────────────
  const audit = await writePaymentAuditLog(supabase, {
    organizationId: input.organizationId,
    actor: input.actor,
    action: "recoupment_recorded",
    objectType: "payment_recoupment",
    objectId: result.recoupmentId,
    claimId: payment.professionalClaimId,
    workqueueItemId: result.workqueueItemId,
    afterValue: { amount, reason: input.reason, source_kind: payment.kind, source_id: payment.id },
    summary: `Recoupment ${amount.toFixed(2)} recorded against ${payment.rawSourceLabel}: ${input.reason}`,
  });
  if (audit) result.auditLogIds.push(audit.id);

  // Only invoke the PP-5 rule engine if the reversal flow did not already
  // open its own workqueue item; otherwise we'd duplicate the queue entry.
  if (!result.workqueueItemId) {
    try {
      const { applyWorkqueueRules } = await import("./workqueueRules");
      await applyWorkqueueRules(supabase, {
        organizationId: input.organizationId,
        sourceObjectType: "payment_recoupment",
        sourceObjectId: result.recoupmentId,
        professionalClaimId: payment.professionalClaimId,
        clientId: payment.clientId,
        sourceKind: "recoupment",
        actor: input.actor,
      });
    } catch (ruleErr) {
      console.warn(
        "[reversal.recoupment] applyWorkqueueRules failed (non-fatal)",
        ruleErr instanceof Error ? ruleErr.message : ruleErr,
      );
    }
  }

  result.ok = true;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// recordInsuranceRefund / recordPatientRefund
// ─────────────────────────────────────────────────────────────────────────────

async function recordRefundShared(
  refundType: "insurance" | "patient",
  input: RecordRefundInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<RecordRefundResult> {
  const result: RecordRefundResult = {
    ok: false,
    refundId: null,
    refundStatus: null,
    workqueueItemId: null,
    auditLogIds: [],
    errors: [],
  };

  const amount = round2(Number(input.amount ?? 0));
  if (amount <= 0) {
    result.errors.push({ field: "amount", message: "Refund amount must be greater than zero." });
    return result;
  }
  if (!input.reason || !input.reason.trim()) {
    result.errors.push({ field: "reason", message: "Refund reason is required." });
    return result;
  }
  if (refundType === "patient" && input.target.kind !== "client_payment") {
    result.errors.push({
      field: "target.kind",
      message: "Patient refunds must reference a client_payment source.",
    });
    return result;
  }
  if (refundType === "insurance" && input.target.kind === "client_payment") {
    result.errors.push({
      field: "target.kind",
      message: "Insurance refunds must reference an ERA-835 or manual-insurance source.",
    });
    return result;
  }

  const supabase = injectedSupabase ?? createServerSupabaseAdminClient();
  if (!supabase) {
    result.errors.push({ field: "system", message: "Database connection not available" });
    return result;
  }

  const payment = await loadPayment(supabase, input.organizationId, input.target);
  if (!payment) {
    result.errors.push({ field: input.target.kind, message: "Source payment not found." });
    return result;
  }
  if (payment.postingStatus === "voided") {
    result.errors.push({
      field: "posting_status",
      message: "Voided payments have no balance to refund.",
    });
    return result;
  }

  // Refund cannot exceed original payment minus prior refunds/recoups.
  const sourceCol = refundSourceColumn(payment.kind);
  const [{ data: priorRefunds }, { data: priorRecoups }] = await Promise.all([
    supabase
      .from("payment_refunds")
      .select("amount, refund_status")
      .eq("organization_id", input.organizationId)
      .eq(sourceCol, payment.id)
      .is("archived_at", null),
    payment.kind === "insurance_manual"
      ? Promise.resolve({ data: [] as Array<{ amount: number }> })
      : supabase
          .from("payment_recoupments")
          .select("amount")
          .eq("organization_id", input.organizationId)
          .eq(
            payment.kind === "era_835" ? "source_era_claim_payment_id" : "source_client_payment_id",
            payment.id,
          )
          .is("archived_at", null),
  ]);
  const priorRefundTotal = (priorRefunds ?? [])
    .filter((r) => (r as { refund_status?: string }).refund_status !== "cancelled")
    .reduce((s, r) => s + Number((r as { amount?: number }).amount ?? 0), 0);
  const priorRecoupTotal = (priorRecoups ?? []).reduce(
    (s, r) => s + Number((r as { amount?: number }).amount ?? 0),
    0,
  );
  const remaining = round2(payment.totalImpact - priorRefundTotal - priorRecoupTotal);
  if (amount > remaining + 0.005) {
    result.errors.push({
      field: "amount",
      message: `Refund ${amount.toFixed(2)} exceeds remaining refundable balance ${remaining.toFixed(2)} (original ${payment.totalImpact.toFixed(2)}, prior refunds ${priorRefundTotal.toFixed(2)}, prior recoupments ${priorRecoupTotal.toFixed(2)}).`,
    });
    return result;
  }

  const now = new Date().toISOString();
  const refundStatus: "pending" | "issued" = input.alreadyIssued ? "issued" : "pending";

  // ── Dry-run preview ───────────────────────────────────────────────────────
  // All validation (amount > 0, refund-type vs source-kind, cap check) has
  // already run above. Build the preview from already-loaded state plus a
  // small extra read for the patient invoice / Stripe charge metadata.
  if (input.dryRun) {
    return await buildRefundPreview(
      supabase,
      refundType,
      input,
      payment,
      amount,
      priorRefundTotal,
      priorRecoupTotal,
      refundStatus,
      result,
    );
  }

  const refundPayload: Record<string, unknown> = {
    organization_id: input.organizationId,
    refund_type: refundType,
    source_era_claim_payment_id: payment.kind === "era_835" ? payment.id : null,
    source_client_payment_id: payment.kind === "client_payment" ? payment.id : null,
    source_insurance_manual_payment_id: payment.kind === "insurance_manual" ? payment.id : null,
    client_id: payment.clientId,
    professional_claim_id: payment.professionalClaimId,
    payer_profile_id: payment.payerProfileId,
    amount,
    reason: input.reason,
    refund_status: refundStatus,
    stripe_refund_id: input.stripeRefundId ?? null,
    requested_by_actor_id: input.actor.staffId ?? null,
    issued_at: refundStatus === "issued" ? now : null,
    issued_by_actor_id: refundStatus === "issued" ? input.actor.staffId ?? null : null,
  };
  const { data: inserted, error: insertErr } = await supabase
    .from("payment_refunds")
    .insert(refundPayload)
    .select("id, refund_status")
    .single();
  if (insertErr || !inserted) {
    result.errors.push({
      field: "payment_refunds",
      message: insertErr?.message ?? "Failed to insert refund.",
    });
    return result;
  }
  result.refundId = String((inserted as { id: string }).id);
  result.refundStatus = (inserted as { refund_status: typeof refundStatus }).refund_status;

  // ── Race-safe cap re-verify after insert (analogous to recoupment) ────────
  const [{ data: nowRefunds2 }, { data: nowRecoups2 }] = await Promise.all([
    supabase
      .from("payment_refunds")
      .select("amount, refund_status")
      .eq("organization_id", input.organizationId)
      .eq(sourceCol, payment.id)
      .is("archived_at", null),
    payment.kind === "insurance_manual"
      ? Promise.resolve({ data: [] as Array<{ amount: number }> })
      : supabase
          .from("payment_recoupments")
          .select("amount")
          .eq("organization_id", input.organizationId)
          .eq(
            payment.kind === "era_835" ? "source_era_claim_payment_id" : "source_client_payment_id",
            payment.id,
          )
          .is("archived_at", null),
  ]);
  const nowRefundTotal2 = (nowRefunds2 ?? [])
    .filter((r) => (r as { refund_status?: string }).refund_status !== "cancelled")
    .reduce((s, r) => s + Number((r as { amount?: number }).amount ?? 0), 0);
  const nowRecoupTotal2 = (nowRecoups2 ?? []).reduce(
    (s, r) => s + Number((r as { amount?: number }).amount ?? 0),
    0,
  );
  if (round2(nowRefundTotal2 + nowRecoupTotal2) > payment.totalImpact + 0.005) {
    await supabase
      .from("payment_refunds")
      .update({ archived_at: new Date().toISOString(), refund_status: "cancelled" })
      .eq("id", result.refundId)
      .eq("organization_id", input.organizationId);
    result.refundId = null;
    result.refundStatus = null;
    result.errors.push({
      field: "amount",
      message: `Concurrent refund/recoupment pushed total over original ${payment.totalImpact.toFixed(2)}. Re-enter with adjusted amount.`,
    });
    return result;
  }

  // ── Stripe refund issuance for patient/Stripe-origin refunds ──────────────
  // If the original client_payment was a Stripe charge and STRIPE_SECRET_KEY
  // is available, attempt to issue the refund via the Stripe REST API now.
  // On success we mark the refund row as 'issued' and stamp stripe_refund_id;
  // on failure (or no key configured) we leave it 'pending' so the workqueue
  // sweeper / ops can issue manually. Best-effort: NEVER fail the refund-row
  // creation on Stripe error — the AR obligation is already persisted.
  let stripeIssuedNow = false;
  if (
    refundType === "patient" &&
    payment.kind === "client_payment" &&
    refundStatus === "pending" &&
    !input.alreadyIssued
  ) {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      try {
        const { data: cpRow } = await supabase
          .from("client_payments")
          .select("stripe_charge_id, stripe_payment_intent_id, stripe_connected_account_id")
          .eq("id", payment.id)
          .eq("organization_id", input.organizationId)
          .maybeSingle();
        const cp = cpRow as {
          stripe_charge_id?: string | null;
          stripe_payment_intent_id?: string | null;
          stripe_connected_account_id?: string | null;
        } | null;
        const chargeId = cp?.stripe_charge_id ?? null;
        const piId = cp?.stripe_payment_intent_id ?? null;
        const connectedAccountId = cp?.stripe_connected_account_id ?? null;
        if (chargeId || piId) {
          const form = new URLSearchParams();
          if (chargeId) form.set("charge", chargeId);
          else if (piId) form.set("payment_intent", piId);
          form.set("amount", String(Math.round(amount * 100)));
          form.set("reason", "requested_by_customer");
          form.set(`metadata[reversal_refund_id]`, result.refundId ?? "");
          form.set(`metadata[organization_id]`, input.organizationId);
          const headers: Record<string, string> = {
            Authorization: `Bearer ${stripeKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Idempotency-Key": `refund-${result.refundId}`,
          };
          // For Stripe Connect copay charges (Task #123), refunds MUST
          // target the connected account where the charge lives.
          if (connectedAccountId) headers["Stripe-Account"] = connectedAccountId;
          const resp = await fetch("https://api.stripe.com/v1/refunds", {
            method: "POST",
            headers,
            body: form.toString(),
          });
          if (resp.ok) {
            const j = (await resp.json()) as { id?: string; status?: string };
            const stripeRefundId = j.id ?? null;
            if (stripeRefundId) {
              await supabase
                .from("payment_refunds")
                .update({
                  stripe_refund_id: stripeRefundId,
                  refund_status: "issued",
                  issued_at: now,
                  issued_by_actor_id: input.actor.staffId ?? null,
                })
                .eq("id", result.refundId)
                .eq("organization_id", input.organizationId);
              result.refundStatus = "issued";
              stripeIssuedNow = true;
            }
          } else {
            const errText = await resp.text().catch(() => "");
            result.errors.push({
              field: "stripe",
              message: `Stripe refund issuance failed (${resp.status}); refund left pending for manual follow-up: ${errText.slice(0, 200)}`,
            });
          }
        }
      } catch (e) {
        result.errors.push({
          field: "stripe",
          message: `Stripe refund issuance error (refund left pending): ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  // ── Open a workqueue item so AR / Stripe-ops follow up ────────────────────
  if (refundStatus === "pending" && !stripeIssuedNow) {
    const queueType = refundType === "insurance" ? "insurance_refund" : "patient_refund";
    const title =
      refundType === "insurance"
        ? `Issue payer refund ${amount.toFixed(2)} on ${payment.rawSourceLabel}`
        : `Issue patient refund ${amount.toFixed(2)} on ${payment.rawSourceLabel}`;
    // Schema invariants (see .agents/memory/workqueue-items-schema.md):
    //   - column is `client_id`, NOT `patient_id` (dropped in
    //     20260505010000_enforce_client_schema_drift.sql).
    //   - `payer_id` is NOT a workqueue_items column.
    //   - column is `work_type`; `queue_type` is a legacy column new
    //     insert paths must not set.
    //   - `source_object_type` is a Postgres ENUM — `payment_refund` is
    //     NOT a valid member, so use `payment_posting` and stash the
    //     refund + payer linkage in `context_payload`.
    const { data: wq } = await supabase
      .from("workqueue_items")
      .insert({
        organization_id: input.organizationId,
        professional_claim_id: payment.professionalClaimId,
        claim_id: payment.professionalClaimId,
        client_id: payment.clientId,
        work_type: queueType,
        priority: "high",
        status: "open",
        title,
        description: input.reason,
        source_object_type: "payment_posting",
        source_object_id: result.refundId,
        context_payload: {
          origin: "refund_request",
          payment_refund_id: result.refundId,
          refund_type: refundType,
          source_kind: payment.kind,
          source_id: payment.id,
          payer_profile_id: payment.payerProfileId ?? null,
          amount,
        },
      })
      .select("id")
      .single();
    if (wq) {
      result.workqueueItemId = String((wq as { id: string }).id);
      await supabase
        .from("payment_refunds")
        .update({ workqueue_item_id: result.workqueueItemId })
        .eq("id", result.refundId)
        .eq("organization_id", input.organizationId);
    }
  }

  // ── Reduce patient invoice paid_amount when refunding a posted patient payment
  // CRITICAL: key off the FINAL refund status (post-Stripe-issuance), not the
  // initial local `refundStatus` constant. Stripe auto-issuance can flip
  // pending→issued above and must trigger ledger reconciliation here.
  const effectiveStatus = result.refundStatus ?? refundStatus;
  if (refundType === "patient" && payment.kind === "client_payment") {
    const { data: cp } = await supabase
      .from("client_payments")
      .select("patient_invoice_id")
      .eq("id", payment.id)
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    const invId = (cp as { patient_invoice_id?: string | null } | null)?.patient_invoice_id ?? null;
    if (invId && effectiveStatus === "issued") {
      const { data: inv } = await supabase
        .from("patient_invoices")
        .select("paid_amount, balance_amount, patient_responsibility_amount, invoice_status")
        .eq("id", invId)
        .eq("organization_id", input.organizationId)
        .maybeSingle();
      if (inv) {
        const row = inv as Record<string, unknown>;
        const newPaid = round2(Math.max(Number(row.paid_amount ?? 0) - amount, 0));
        const responsibility = Number(row.patient_responsibility_amount ?? 0);
        const newBalance = round2(Math.max(responsibility - newPaid, 0));
        const newStatus = newBalance > 0 && row.invoice_status === "paid" ? "open" : row.invoice_status;
        await supabase
          .from("patient_invoices")
          .update({
            paid_amount: newPaid,
            balance_amount: newBalance,
            invoice_status: newStatus,
            updated_at: now,
          })
          .eq("id", invId)
          .eq("organization_id", input.organizationId);
      }
    }
  }

  // ── Apply payer cash reduction when an INSURANCE refund is issued ─────────
  // Refunding the payer reduces our cash position against the underlying
  // payment. We post a compensating negative ledger entry (source_type=
  // 'refund') so balances/dashboards reflect the outbound payment without
  // touching the original posted rows.
  if (refundType === "insurance" && effectiveStatus === "issued" && amount > 0) {
    // Fail-closed: if the compensating ledger write or claim-status update
    // errors out, we MUST NOT return ok=true with the refund row sitting in
    // 'issued' — that would mean cash left the building but our ledger never
    // reflected it. We cancel/archive the just-inserted refund and surface a
    // 5xx-style error so callers can retry / page on-call.
    const { error: ledgerErr } = await supabase.from("era_posting_ledger_entries").insert({
      organization_id: input.organizationId,
      era_claim_payment_id: payment.kind === "era_835" ? payment.id : null,
      source_type: "refund",
      source_id: result.refundId,
      professional_claim_id: payment.professionalClaimId,
      client_id: payment.clientId,
      entry_type: "payment",
      amount: -round2(amount),
      group_code: null,
      reason_code: null,
      description: `Insurance refund issued: ${input.reason}`,
    });
    if (ledgerErr) {
      await supabase
        .from("payment_refunds")
        .update({
          refund_status: "cancelled",
          archived_at: new Date().toISOString(),
          note: `Auto-cancelled: ledger write failed (${ledgerErr.message})`,
        })
        .eq("id", result.refundId)
        .eq("organization_id", input.organizationId);
      result.refundId = null;
      result.refundStatus = null;
      result.errors.push({
        field: "era_posting_ledger_entries",
        message: `Insurance refund could not be posted to ledger: ${ledgerErr.message}. Refund row cancelled — re-issue once underlying ledger error is resolved.`,
      });
      return result;
    }
    if (payment.professionalClaimId) {
      const { error: claimErr } = await supabase
        .from("professional_claims")
        .update({ claim_status: "billed", updated_at: now })
        .eq("id", payment.professionalClaimId)
        .eq("organization_id", input.organizationId);
      if (claimErr) {
        result.errors.push({
          field: "professional_claims",
          message: `Refund ledger posted, but claim status restore failed: ${claimErr.message}. Manual fix-up required.`,
        });
        // Do not fail the call — ledger is the source of truth; claim status
        // is a denormalized convenience that the dashboard can recompute.
      }
    }
  }

  const audit = await writePaymentAuditLog(supabase, {
    organizationId: input.organizationId,
    actor: input.actor,
    action: refundStatus === "issued" ? "refund_issued" : "refund_requested",
    objectType: "payment_refund",
    objectId: result.refundId,
    claimId: payment.professionalClaimId,
    workqueueItemId: result.workqueueItemId,
    afterValue: {
      refund_type: refundType,
      amount,
      refund_status: refundStatus,
      stripe_refund_id: input.stripeRefundId ?? null,
      source_kind: payment.kind,
      source_id: payment.id,
    },
    summary: `${refundType === "insurance" ? "Insurance" : "Patient"} refund ${amount.toFixed(2)} ${refundStatus} on ${payment.rawSourceLabel}: ${input.reason}`,
  });
  if (audit) result.auditLogIds.push(audit.id);

  // Skip rule engine when (a) the reversal flow already opened its own
  // workqueue item, or (b) the refund is already fully issued — already-
  // issued refunds are terminal and don't need follow-up review.
  if (!result.workqueueItemId && refundStatus !== "issued") {
    try {
      const { applyWorkqueueRules } = await import("./workqueueRules");
      await applyWorkqueueRules(supabase, {
        organizationId: input.organizationId,
        sourceObjectType: "payment_refund",
        sourceObjectId: result.refundId,
        professionalClaimId: payment.professionalClaimId,
        clientId: payment.clientId,
        sourceKind: "refund",
        actor: input.actor,
      });
    } catch (ruleErr) {
      console.warn(
        "[reversal.refund] applyWorkqueueRules failed (non-fatal)",
        ruleErr instanceof Error ? ruleErr.message : ruleErr,
      );
    }
  }

  result.ok = true;
  return result;
}

export function recordInsuranceRefund(
  input: RecordRefundInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<RecordRefundResult> {
  return recordRefundShared("insurance", input, injectedSupabase);
}

/**
 * Two-step insurance refund confirmation: moves a pending payment_refunds
 * row to 'issued' and posts the compensating negative ledger entry
 * (source_type='refund') at that point. Used by the UI confirm action /
 * AR ops once a check/ACH has actually left the building.
 *
 * Fail-closed: if ledger insert fails, the refund row is left pending
 * (status NOT flipped) and ok=false is returned, so cash cannot leave
 * the building without a matching ledger entry.
 */
export interface ConfirmInsuranceRefundInput {
  organizationId: string;
  refundId: string;
  reason?: string | null;
  externalReferenceNumber?: string | null;
  actor: PostingActor;
}

export interface ConfirmInsuranceRefundResult {
  ok: boolean;
  refundId: string | null;
  refundStatus: "issued" | null;
  ledgerEntriesWritten: number;
  errors: Array<{ field: string; message: string }>;
}

export async function confirmInsuranceRefund(
  input: ConfirmInsuranceRefundInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<ConfirmInsuranceRefundResult> {
  const result: ConfirmInsuranceRefundResult = {
    ok: false,
    refundId: null,
    refundStatus: null,
    ledgerEntriesWritten: 0,
    errors: [],
  };
  const supabase = injectedSupabase ?? createServerSupabaseAdminClient();
  if (!supabase) {
    result.errors.push({ field: "system", message: "Database connection not available" });
    return result;
  }

  // Concurrency-safe state flip: only succeed if still pending.
  const now = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from("payment_refunds")
    .update({
      refund_status: "issued",
      issued_at: now,
      issued_by_actor_id: input.actor.staffId ?? null,
    })
    .eq("id", input.refundId)
    .eq("organization_id", input.organizationId)
    .eq("refund_status", "pending")
    .is("archived_at", null)
    .select(
      "id, refund_type, amount, professional_claim_id, source_era_claim_payment_id, source_insurance_manual_payment_id, source_client_payment_id, client_id",
    );
  if (claimErr) {
    result.errors.push({ field: "payment_refunds", message: claimErr.message });
    return result;
  }
  const row = Array.isArray(claimed) ? (claimed[0] as Record<string, unknown> | undefined) : null;
  if (!row) {
    result.errors.push({
      field: "refund_status",
      message: "Refund could not be confirmed — not found, already issued/cancelled, or wrong org.",
    });
    return result;
  }
  if (String(row.refund_type) !== "insurance") {
    result.errors.push({
      field: "refund_type",
      message: "confirmInsuranceRefund only applies to insurance refunds.",
    });
    return result;
  }

  const amount = round2(Number(row.amount ?? 0));
  const eraId = (row.source_era_claim_payment_id as string | null) ?? null;
  const claimId = (row.professional_claim_id as string | null) ?? null;
  const clientId = (row.client_id as string | null) ?? null;
  const reason = input.reason || "Insurance refund confirmation";

  // Post compensating negative ledger entry. Fail-closed: on error, revert
  // the refund row back to pending so cash isn't recorded as gone without
  // a matching ledger entry.
  const { error: ledgerErr } = await supabase.from("era_posting_ledger_entries").insert({
    organization_id: input.organizationId,
    era_claim_payment_id: eraId,
    source_type: "refund",
    source_id: input.refundId,
    professional_claim_id: claimId,
    client_id: clientId,
    entry_type: "payment",
    amount: -amount,
    group_code: null,
    reason_code: null,
    description: `Insurance refund confirmed: ${reason}${
      input.externalReferenceNumber ? ` (ref ${input.externalReferenceNumber})` : ""
    }`,
  });
  if (ledgerErr) {
    await supabase
      .from("payment_refunds")
      .update({
        refund_status: "pending",
        issued_at: null,
        issued_by_actor_id: null,
      })
      .eq("id", input.refundId)
      .eq("organization_id", input.organizationId);
    result.errors.push({
      field: "era_posting_ledger_entries",
      message: `Ledger write failed (${ledgerErr.message}); refund left pending.`,
    });
    return result;
  }
  result.ledgerEntriesWritten = 1;

  if (claimId) {
    await supabase
      .from("professional_claims")
      .update({ claim_status: "billed", updated_at: now })
      .eq("id", claimId)
      .eq("organization_id", input.organizationId);
  }

  await writePaymentAuditLog(supabase, {
    organizationId: input.organizationId,
    actor: input.actor,
    action: "refund_issued",
    objectType: "payment_refund",
    objectId: input.refundId,
    claimId,
    afterValue: {
      refund_status: "issued",
      amount,
      external_reference_number: input.externalReferenceNumber ?? null,
      reason,
    },
    summary: `Insurance refund ${amount.toFixed(2)} confirmed (ledger compensated): ${reason}`,
  });

  result.ok = true;
  result.refundId = input.refundId;
  result.refundStatus = "issued";
  return result;
}

/**
 * Cancel a pending insurance refund (Task #169).
 *
 * If a biller opens a pending insurance refund in error, this lets them
 * close it out cleanly without ever moving money:
 *   - payment_refunds.refund_status pending → cancelled
 *   - archived_at stamped so dashboard totals stop counting it
 *   - note stamped with the cancellation reason
 *   - linked workqueue item closed (status='cancelled')
 *
 * Concurrency-safe: only succeeds when the row is still pending+unarchived
 * and refund_type='insurance'. Already-issued refunds cannot be cancelled
 * — by then money has moved and the right tool is reverse/recoup, not
 * cancel.
 *
 * NO ledger writes happen: a pending insurance refund never posted a
 * compensating ledger entry in the first place (that only happens when
 * confirmInsuranceRefund flips it to 'issued'), so cancellation is a
 * pure metadata flip.
 */
export interface CancelPendingRefundInput {
  organizationId: string;
  refundId: string;
  reason: string;
  actor: PostingActor;
}

export interface CancelPendingRefundResult {
  ok: boolean;
  refundId: string | null;
  refundStatus: "cancelled" | null;
  workqueueItemClosed: boolean;
  auditLogIds: string[];
  errors: Array<{ field: string; message: string }>;
}

export async function cancelPendingRefund(
  input: CancelPendingRefundInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<CancelPendingRefundResult> {
  const result: CancelPendingRefundResult = {
    ok: false,
    refundId: null,
    refundStatus: null,
    workqueueItemClosed: false,
    auditLogIds: [],
    errors: [],
  };
  if (!input.reason || !input.reason.trim()) {
    result.errors.push({ field: "reason", message: "Cancellation reason is required." });
    return result;
  }
  const supabase = injectedSupabase ?? createServerSupabaseAdminClient();
  if (!supabase) {
    result.errors.push({ field: "system", message: "Database connection not available" });
    return result;
  }

  const now = new Date().toISOString();
  // Concurrency-safe state flip: only succeeds while still pending+unarchived.
  // Filtering refund_type='insurance' here is what makes a same-id call
  // against a patient refund return "not found" rather than silently mutate.
  const { data: claimed, error: claimErr } = await supabase
    .from("payment_refunds")
    .update({
      refund_status: "cancelled",
      archived_at: now,
      note: input.reason.trim(),
      updated_at: now,
    })
    .eq("id", input.refundId)
    .eq("organization_id", input.organizationId)
    .eq("refund_status", "pending")
    .eq("refund_type", "insurance")
    .is("archived_at", null)
    .select(
      "id, amount, professional_claim_id, source_era_claim_payment_id, source_insurance_manual_payment_id, workqueue_item_id",
    );
  if (claimErr) {
    result.errors.push({ field: "payment_refunds", message: claimErr.message });
    return result;
  }
  const row = Array.isArray(claimed) ? (claimed[0] as Record<string, unknown> | undefined) : null;
  if (!row) {
    result.errors.push({
      field: "refund_status",
      message:
        "Refund could not be cancelled — not found, already issued/cancelled, not an insurance refund, or wrong org.",
    });
    return result;
  }

  result.refundId = input.refundId;
  result.refundStatus = "cancelled";

  // Close the linked workqueue item so the AR team's queue doesn't keep
  // showing "issue payer refund". Best-effort: a workqueue failure must
  // NOT roll back the cancellation — the refund row is already settled.
  const wqId = (row.workqueue_item_id as string | null) ?? null;
  if (wqId) {
    const { error: wqErr } = await supabase
      .from("workqueue_items")
      .update({
        status: "cancelled",
        resolved_at: now,
        resolution_notes: `Pending refund cancelled: ${input.reason.trim()}`,
        updated_at: now,
      })
      .eq("id", wqId)
      .eq("organization_id", input.organizationId);
    if (!wqErr) {
      result.workqueueItemClosed = true;
    } else {
      console.warn("[reversal.cancelPendingRefund] workqueue close failed", wqErr.message);
    }
  }

  const amount = round2(Number(row.amount ?? 0));
  const claimId = (row.professional_claim_id as string | null) ?? null;
  const audit = await writePaymentAuditLog(supabase, {
    organizationId: input.organizationId,
    actor: input.actor,
    action: "refund_cancelled",
    objectType: "payment_refund",
    objectId: input.refundId,
    claimId,
    workqueueItemId: wqId,
    beforeValue: { refund_status: "pending" },
    afterValue: {
      refund_status: "cancelled",
      cancelled_at: now,
      cancellation_reason: input.reason.trim(),
      amount,
    },
    summary: `Pending insurance refund ${amount.toFixed(2)} cancelled: ${input.reason.trim()}`,
  });
  if (audit) result.auditLogIds.push(audit.id);

  result.ok = true;
  return result;
}

export function recordPatientRefund(
  input: RecordRefundInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<RecordRefundResult> {
  return recordRefundShared("patient", input, injectedSupabase);
}

/**
 * Two-step patient refund confirmation: moves a pending payment_refunds
 * row (refund_type='patient', sourced from a client_payment) to 'issued'
 * and reconciles the originating patient_invoice paid_amount/balance.
 *
 * Used by the Stripe webhook (Task #136) when a `charge.refunded` /
 * `refund.updated` event matches an existing pending refund row by
 * `stripe_refund_id` — i.e. our own refund-issuance flow created the
 * pending row but Stripe is now confirming it actually settled.
 *
 * Concurrency-safe: the pending→issued flip is conditional, so concurrent
 * webhook re-deliveries collapse into a single state transition.
 * Fail-closed on the transition itself; the invoice paid_amount update
 * is best-effort (matches the inline patient-refund issuance path).
 */
export interface ConfirmPatientRefundInput {
  organizationId: string;
  refundId: string;
  stripeRefundId?: string | null;
  actor: PostingActor;
}

export interface ConfirmPatientRefundResult {
  ok: boolean;
  refundId: string | null;
  refundStatus: "issued" | null;
  alreadyIssued: boolean;
  errors: Array<{ field: string; message: string }>;
}

export async function confirmPatientRefund(
  input: ConfirmPatientRefundInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<ConfirmPatientRefundResult> {
  const result: ConfirmPatientRefundResult = {
    ok: false,
    refundId: null,
    refundStatus: null,
    alreadyIssued: false,
    errors: [],
  };
  const supabase = injectedSupabase ?? createServerSupabaseAdminClient();
  if (!supabase) {
    result.errors.push({ field: "system", message: "Database connection not available" });
    return result;
  }

  // First, check whether the row is already issued (idempotent webhook noop).
  const { data: existing } = await supabase
    .from("payment_refunds")
    .select("id, refund_status, refund_type, source_client_payment_id, amount")
    .eq("id", input.refundId)
    .eq("organization_id", input.organizationId)
    .is("archived_at", null)
    .maybeSingle();
  const existingRow = existing as Record<string, unknown> | null;
  if (!existingRow) {
    result.errors.push({
      field: "payment_refunds",
      message: "Refund row not found or wrong org.",
    });
    return result;
  }
  if (String(existingRow.refund_type) !== "patient") {
    result.errors.push({
      field: "refund_type",
      message: "confirmPatientRefund only applies to patient refunds.",
    });
    return result;
  }
  if (String(existingRow.refund_status) === "issued") {
    result.ok = true;
    result.alreadyIssued = true;
    result.refundId = input.refundId;
    result.refundStatus = "issued";
    return result;
  }

  const now = new Date().toISOString();
  const updatePayload: Record<string, unknown> = {
    refund_status: "issued",
    issued_at: now,
    issued_by_actor_id: input.actor.staffId ?? null,
  };
  if (input.stripeRefundId) updatePayload.stripe_refund_id = input.stripeRefundId;

  const { data: claimed, error: claimErr } = await supabase
    .from("payment_refunds")
    .update(updatePayload)
    .eq("id", input.refundId)
    .eq("organization_id", input.organizationId)
    .eq("refund_status", "pending")
    .is("archived_at", null)
    .select("id, amount, source_client_payment_id");
  if (claimErr) {
    result.errors.push({ field: "payment_refunds", message: claimErr.message });
    return result;
  }
  const row = Array.isArray(claimed) ? (claimed[0] as Record<string, unknown> | undefined) : null;
  if (!row) {
    // Lost race — re-read to report current state.
    result.ok = true;
    result.alreadyIssued = true;
    result.refundId = input.refundId;
    result.refundStatus = "issued";
    return result;
  }

  const amount = round2(Number(row.amount ?? 0));
  const sourceCpId = (row.source_client_payment_id as string | null) ?? null;

  // Best-effort patient invoice paid_amount reduction (mirrors the inline
  // patient-refund issuance path in recordRefundShared so balances stay
  // accurate after webhook confirmation).
  if (sourceCpId && amount > 0) {
    const { data: cp } = await supabase
      .from("client_payments")
      .select("patient_invoice_id")
      .eq("id", sourceCpId)
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    const invId =
      (cp as { patient_invoice_id?: string | null } | null)?.patient_invoice_id ?? null;
    if (invId) {
      const { data: inv } = await supabase
        .from("patient_invoices")
        .select("paid_amount, balance_amount, patient_responsibility_amount, invoice_status")
        .eq("id", invId)
        .eq("organization_id", input.organizationId)
        .maybeSingle();
      if (inv) {
        const invRow = inv as Record<string, unknown>;
        const newPaid = round2(Math.max(Number(invRow.paid_amount ?? 0) - amount, 0));
        const responsibility = Number(invRow.patient_responsibility_amount ?? 0);
        const newBalance = round2(Math.max(responsibility - newPaid, 0));
        const newStatus =
          newBalance > 0 && invRow.invoice_status === "paid" ? "open" : invRow.invoice_status;
        await supabase
          .from("patient_invoices")
          .update({
            paid_amount: newPaid,
            balance_amount: newBalance,
            invoice_status: newStatus,
            updated_at: now,
          })
          .eq("id", invId)
          .eq("organization_id", input.organizationId);
      }
    }
  }

  await writePaymentAuditLog(supabase, {
    organizationId: input.organizationId,
    actor: input.actor,
    action: "refund_issued",
    objectType: "payment_refund",
    objectId: input.refundId,
    afterValue: {
      refund_status: "issued",
      amount,
      stripe_refund_id: input.stripeRefundId ?? null,
    },
    summary: `Patient refund ${amount.toFixed(2)} confirmed by Stripe webhook.`,
  });

  result.ok = true;
  result.refundId = input.refundId;
  result.refundStatus = "issued";
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure validators (exported so API routes can dry-run UI feedback)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReversalValidationInput {
  postingStatus: string;
  reversedAt: string | null;
  voidedAt: string | null;
  reason: string;
}

export function validateReversalRequest(
  input: ReversalValidationInput,
): { ok: boolean; code?: string; message?: string } {
  if (!input.reason || !input.reason.trim()) {
    return { ok: false, code: "reason_required", message: "Reversal reason is required." };
  }
  if (input.postingStatus === "reversed" || input.reversedAt) {
    return { ok: false, code: "already_reversed", message: "Payment is already reversed." };
  }
  if (input.postingStatus === "voided" || input.voidedAt) {
    return { ok: false, code: "already_voided", message: "Voided payments cannot be reversed." };
  }
  if (input.postingStatus !== "posted") {
    return {
      ok: false,
      code: "not_posted",
      message: `Only posted payments can be reversed (current: ${input.postingStatus}).`,
    };
  }
  return { ok: true };
}

export function validateRefundAmount(
  amount: number,
  originalAmount: number,
  priorRefunded: number,
  priorRecouped: number,
): { ok: boolean; code?: string; message?: string; remaining: number } {
  const remaining = round2(originalAmount - priorRefunded - priorRecouped);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: "amount_required", message: "Refund amount must be greater than zero.", remaining };
  }
  if (amount > remaining + 0.005) {
    return {
      ok: false,
      code: "amount_exceeds_balance",
      message: `Refund ${amount.toFixed(2)} exceeds remaining refundable balance ${remaining.toFixed(2)}.`,
      remaining,
    };
  }
  return { ok: true, remaining };
}
