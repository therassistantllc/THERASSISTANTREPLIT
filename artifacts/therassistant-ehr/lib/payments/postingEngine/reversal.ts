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
}

export interface ReversalResult {
  ok: boolean;
  reversed: boolean;
  alreadyReversed: boolean;
  ledgerEntriesWritten: number;
  workqueueItemsClosed: number;
  auditLogIds: string[];
  errors: Array<{ field: string; message: string }>;
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
}

export interface RecordRecoupmentResult {
  ok: boolean;
  recoupmentId: string | null;
  workqueueItemId: string | null;
  ledgerEntryId: string | null;
  auditLogIds: string[];
  errors: Array<{ field: string; message: string }>;
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
}

export interface RecordRefundResult {
  ok: boolean;
  refundId: string | null;
  refundStatus: "pending" | "issued" | "failed" | "cancelled" | null;
  workqueueItemId: string | null;
  auditLogIds: string[];
  errors: Array<{ field: string; message: string }>;
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
    await supabase
      .from(targetTable(payment.kind))
      .update({
        posting_status: "posted",
        reversed_at: null,
        reversal_reason: null,
        reversed_by_actor_id: null,
        updated_at: new Date().toISOString(),
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
      const { error: wqErr } = await supabase.from("workqueue_items").insert({
        organization_id: input.organizationId,
        queue_type: "patient_refund",
        work_type: "patient_refund",
        status: "open",
        priority: "high",
        title: `Issue patient refund $${amt.toFixed(2)} (reversal)`,
        description: `Patient refund triggered by payment reversal. Stripe charge: ${String(cpRow?.stripe_charge_id ?? "n/a")}.`,
        source_object_type: "payment_refund",
        source_object_id: refundId,
        client_id: (cpRow?.client_id as string | null) ?? payment.clientId,
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
    const { data: wq } = await supabase
      .from("workqueue_items")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("source_object_type", "era_claim_payment")
      .eq("source_object_id", payment.id)
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
    const { data: wq } = await supabase
      .from("workqueue_items")
      .insert({
        organization_id: input.organizationId,
        professional_claim_id: payment.professionalClaimId,
        claim_id: payment.professionalClaimId,
        patient_id: payment.clientId,
        payer_id: payment.payerProfileId,
        queue_type: "recoupment_review",
        work_type: "recoupment_review",
        priority: "high",
        status: "open",
        title: `Payer recoupment ${amount.toFixed(2)} on ${payment.rawSourceLabel}`,
        description: input.reason,
        source_object_type: "payment_recoupment",
        source_object_id: result.recoupmentId,
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

  // ── Open a workqueue item so AR / Stripe-ops follow up ────────────────────
  if (refundStatus === "pending") {
    const queueType = refundType === "insurance" ? "insurance_refund" : "patient_refund";
    const title =
      refundType === "insurance"
        ? `Issue payer refund ${amount.toFixed(2)} on ${payment.rawSourceLabel}`
        : `Issue patient refund ${amount.toFixed(2)} on ${payment.rawSourceLabel}`;
    const { data: wq } = await supabase
      .from("workqueue_items")
      .insert({
        organization_id: input.organizationId,
        professional_claim_id: payment.professionalClaimId,
        claim_id: payment.professionalClaimId,
        patient_id: payment.clientId,
        payer_id: payment.payerProfileId,
        queue_type: queueType,
        work_type: queueType,
        priority: "high",
        status: "open",
        title,
        description: input.reason,
        source_object_type: "payment_refund",
        source_object_id: result.refundId,
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
  if (refundType === "patient" && payment.kind === "client_payment") {
    const { data: cp } = await supabase
      .from("client_payments")
      .select("patient_invoice_id")
      .eq("id", payment.id)
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    const invId = (cp as { patient_invoice_id?: string | null } | null)?.patient_invoice_id ?? null;
    if (invId && refundStatus === "issued") {
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
  if (refundType === "insurance" && refundStatus === "issued" && amount > 0) {
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

  result.ok = true;
  return result;
}

export function recordInsuranceRefund(
  input: RecordRefundInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<RecordRefundResult> {
  return recordRefundShared("insurance", input, injectedSupabase);
}

export function recordPatientRefund(
  input: RecordRefundInput,
  injectedSupabase?: SupabaseAdmin,
): Promise<RecordRefundResult> {
  return recordRefundShared("patient", input, injectedSupabase);
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
