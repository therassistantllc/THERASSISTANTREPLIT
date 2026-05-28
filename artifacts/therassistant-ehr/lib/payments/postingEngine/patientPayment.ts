/**
 * Payment Posting Engine — patient_payment source (Task #109).
 *
 * Accepts a client payment from any source (stripe / cash / check /
 * external_card / refund / unapplied_credit / transferred_balance) and
 * applies it to one of: a patient_invoice, a professional_claim's
 * client-responsibility balance, an encounter (via its claim), or the
 * client's account-balance bucket as unapplied credit.
 *
 * Invariants:
 *   - amount > 0
 *   - applies-to target must belong to the same client and org
 *   - external_payment_id is captured for stripe / external_card so the
 *     Stripe webhook reconciler can dedupe (unique partial index).
 *   - All writes are audited via writePaymentAuditLog.
 *   - When apply target is `none`, the entire payment becomes a client_credit
 *     row in the unapplied-credit bucket.
 */

import crypto from "crypto";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { writePaymentAuditLog } from "./audit";
import type { CommitPostingResult, PostingActor, ValidationIssue, ValidationResult } from "./types";

export type PatientPaymentMethod =
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

export type PatientPaymentApplyTo =
  | { kind: "invoice"; patientInvoiceId: string }
  | { kind: "claim"; professionalClaimId: string }
  | { kind: "encounter"; appointmentId: string }
  | { kind: "account_balance" }
  | { kind: "none" };

export interface CommitPatientPaymentInput {
  organizationId: string;
  clientId: string;
  amount: number;
  method: PatientPaymentMethod;
  applyTo: PatientPaymentApplyTo;
  externalPaymentId?: string | null;
  stripeChargeId?: string | null;
  stripeConnectedAccountId?: string | null;
  referenceNumber?: string | null;
  note?: string | null;
  paymentDate?: string | null;
  actor: PostingActor;
  dryRun?: boolean;
  /**
   * For method='transferred_balance': the source invoice or claim whose
   * balance is being moved. The engine writes a payment_transfers row and
   * paired ledger entries (negative on source, positive on destination) so
   * net balances stay correct.
   */
  transferFrom?: { fromInvoiceId?: string | null; fromClaimId?: string | null } | null;
  transferReason?: string | null;
}

export interface PatientPaymentResult extends CommitPostingResult {
  paymentId: string | null;
  appliedAmount: number;
  unappliedAmount: number;
  creditId: string | null;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function genId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function emptyResult(): PatientPaymentResult {
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
    paymentId: null,
    appliedAmount: 0,
    unappliedAmount: 0,
    creditId: null,
  };
}

export function validatePatientPayment(input: CommitPatientPaymentInput): ValidationResult {
  const blocking: ValidationIssue[] = [];
  const warning: ValidationIssue[] = [];
  const amount = round2(Number(input.amount ?? 0));
  if (amount <= 0) {
    blocking.push({
      severity: "blocking",
      code: "amount_required",
      field: "amount",
      message: "Payment amount must be greater than zero.",
    });
  }
  if (!input.clientId) {
    blocking.push({
      severity: "blocking",
      code: "client_required",
      field: "clientId",
      message: "Client (client) is required.",
    });
  }
  if ((input.method === "stripe" || input.method === "external_card") && !input.externalPaymentId) {
    warning.push({
      severity: "warning",
      code: "external_payment_id_missing",
      field: "externalPaymentId",
      message: "External payment id not supplied — webhook reconciliation will be skipped.",
    });
  }
  if (input.method === "transferred_balance") {
    const tf = input.transferFrom;
    if (tf && tf.fromInvoiceId && tf.fromClaimId) {
      // Exactly-one-source invariant: posting against BOTH would double-debit
      // because the commit step adjusts each named source by the full amount.
      blocking.push({
        severity: "blocking",
        code: "transfer_source_ambiguous",
        field: "transferFrom",
        message: "transferred_balance must specify exactly one of fromInvoiceId or fromClaimId, not both.",
      });
    }
    if (!tf || (!tf.fromInvoiceId && !tf.fromClaimId)) {
      blocking.push({
        severity: "blocking",
        code: "transfer_source_required",
        field: "transferFrom",
        message: "transferred_balance requires a source invoice or claim in transferFrom.",
      });
    }
    if (input.applyTo.kind === "account_balance" || input.applyTo.kind === "none") {
      blocking.push({
        severity: "blocking",
        code: "transfer_destination_required",
        field: "applyTo",
        message: "transferred_balance must land on a specific invoice, claim, or encounter.",
      });
    }
  }
  if (input.method === "refund") {
    // PP-4 (Task #113): refunds must reverse a prior posted payment via
    // recordPatientRefund / reversePostedPayment so applications + balances
    // unwind atomically and Stripe charges are reconciled. Recording a
    // flat negative entry through the intake path would leave the original
    // payment + invoice applications intact (silent ledger divergence).
    blocking.push({
      severity: "blocking",
      code: "refund_via_intake_blocked",
      field: "method",
      message:
        "Refunds must be issued against the prior posted payment via /api/billing/payments/posted/[id]/refund (PP-4). Direct method='refund' intake is no longer supported.",
    });
  }
  return { blocking, warning };
}

export async function commitPatientPayment(
  input: CommitPatientPaymentInput,
  supabaseClient?: NonNullable<ReturnType<typeof createServerSupabaseAdminClient>> | null,
): Promise<PatientPaymentResult> {
  const result = emptyResult();
  const supabase = supabaseClient ?? createServerSupabaseAdminClient();
  if (!supabase) {
    result.errors.push({ field: "system", message: "Database connection not available" });
    return result;
  }

  result.validation = validatePatientPayment(input);
  if (result.validation.blocking.length > 0) {
    result.blocked = true;
    result.errors.push(...result.validation.blocking.map((i) => ({ field: i.field, message: i.message })));
    return result;
  }

  const amount = round2(Number(input.amount));
  const now = input.paymentDate ?? new Date().toISOString();
  const dryRun = input.dryRun ?? false;

  // Resolve apply target → returns {invoiceId?, claimId?, applyAmount}
  let resolvedInvoiceId: string | null = null;
  let resolvedClaimId: string | null = null;
  let applyAmount = 0;

  if (input.applyTo.kind === "invoice") {
    const { data, error } = await supabase
      .from("patient_invoices")
      .select("id, client_id, balance_amount, invoice_status")
      .eq("organization_id", input.organizationId)
      .eq("id", input.applyTo.patientInvoiceId)
      .is("archived_at", null)
      .maybeSingle();
    if (error) {
      result.errors.push({ field: "patient_invoices", message: error.message });
      return result;
    }
    if (!data) {
      result.blocked = true;
      result.errors.push({ field: "patientInvoiceId", message: "Client invoice not found." });
      return result;
    }
    if (data.client_id !== input.clientId) {
      result.blocked = true;
      result.errors.push({ field: "patientInvoiceId", message: "Invoice does not belong to that client." });
      return result;
    }
    resolvedInvoiceId = String(data.id);
    applyAmount = Math.min(amount, round2(Number(data.balance_amount ?? 0)));
  } else if (input.applyTo.kind === "claim") {
    const { data, error } = await supabase
      .from("professional_claims")
      .select("id, patient_id, patient_responsibility_amount")
      .eq("organization_id", input.organizationId)
      .eq("id", input.applyTo.professionalClaimId)
      .is("archived_at", null)
      .maybeSingle();
    if (error) {
      result.errors.push({ field: "professional_claims", message: error.message });
      return result;
    }
    if (!data) {
      result.blocked = true;
      result.errors.push({ field: "professionalClaimId", message: "Claim not found." });
      return result;
    }
    if (data.patient_id && data.patient_id !== input.clientId) {
      result.blocked = true;
      result.errors.push({ field: "professionalClaimId", message: "Claim does not belong to that client." });
      return result;
    }
    resolvedClaimId = String(data.id);
    // Cap to claim's PR balance; never fall back to full amount when PR is 0 —
    // overflow flows into the unapplied-credit bucket below.
    applyAmount = Math.min(amount, round2(Number(data.patient_responsibility_amount ?? 0)));
  } else if (input.applyTo.kind === "encounter") {
    const { data, error } = await supabase
      .from("professional_claims")
      .select("id, patient_id, patient_responsibility_amount")
      .eq("organization_id", input.organizationId)
      .eq("appointment_id", input.applyTo.appointmentId)
      .is("archived_at", null)
      .maybeSingle();
    if (error) {
      result.errors.push({ field: "professional_claims", message: error.message });
      return result;
    }
    if (data) {
      resolvedClaimId = String(data.id);
      applyAmount = Math.min(amount, round2(Number(data.patient_responsibility_amount ?? 0)));
    } else {
      applyAmount = 0; // becomes unapplied credit
    }
  } else if (input.applyTo.kind === "account_balance" || input.applyTo.kind === "none") {
    applyAmount = 0;
  }

  const unapplied = round2(amount - applyAmount);

  // Object-level authorization for transferred_balance: source invoice/claim
  // MUST belong to the same client as input.clientId (the destination client).
  // Without this, a biller could move balance off another client's invoice
  // because route-level FK ownership only enforces org scope.
  if (input.method === "transferred_balance" && input.transferFrom) {
    const tf = input.transferFrom;
    if (tf.fromInvoiceId) {
      const { data: srcInvAuth } = await supabase
        .from("patient_invoices")
        .select("id, client_id")
        .eq("organization_id", input.organizationId)
        .eq("id", tf.fromInvoiceId)
        .maybeSingle();
      if (!srcInvAuth || String((srcInvAuth as { client_id: unknown }).client_id) !== String(input.clientId)) {
        result.errors.push({
          field: "transferFrom.fromInvoiceId",
          message: "Transfer source invoice does not belong to this client.",
        });
        return result;
      }
    }
    if (tf.fromClaimId) {
      const { data: srcClmAuth } = await supabase
        .from("professional_claims")
        .select("id, patient_id")
        .eq("organization_id", input.organizationId)
        .eq("id", tf.fromClaimId)
        .maybeSingle();
      if (!srcClmAuth || String((srcClmAuth as { patient_id: unknown }).patient_id) !== String(input.clientId)) {
        result.errors.push({
          field: "transferFrom.fromClaimId",
          message: "Transfer source claim does not belong to this client.",
        });
        return result;
      }
    }
  }

  if (dryRun) {
    result.ok = true;
    result.appliedAmount = applyAmount;
    result.unappliedAmount = unapplied;
    return result;
  }

  // Idempotency dedupe for stripe/external_card by external_payment_id.
  if (input.externalPaymentId && (input.method === "stripe" || input.method === "external_card")) {
    const { data: existing } = await supabase
      .from("client_payments")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("payment_method", input.method)
      .eq("external_payment_id", input.externalPaymentId)
      .is("archived_at", null)
      .maybeSingle();
    if (existing?.id) {
      result.ok = true;
      result.alreadyPosted = true;
      result.paymentId = String(existing.id);
      return result;
    }
  }

  const paymentId = genId();
  const { error: insertError } = await supabase
    .from("client_payments")
    .insert({
      id: paymentId,
      organization_id: input.organizationId,
      client_id: input.clientId,
      claim_id: resolvedClaimId,
      patient_invoice_id: resolvedInvoiceId,
      payment_method: input.method,
      amount,
      reference_number: input.referenceNumber ?? null,
      external_payment_id: input.externalPaymentId ?? null,
      stripe_charge_id: input.stripeChargeId ?? null,
      stripe_connected_account_id: input.stripeConnectedAccountId ?? null,
      source_label: input.applyTo.kind,
      note: input.note ?? null,
      posted_actor_id: input.actor.staffId ?? null,
      posting_status: "posted",
      posted_at: now,
    });

  if (insertError) {
    // Race-safe idempotency (Task #114): concurrent webhook deliveries
    // (e.g. Stripe `charge.succeeded` + `payment_intent.succeeded` for the
    // same charge) can both pass the pre-insert lookup, then one hits the
    // unique index on (organization_id, payment_method, external_payment_id).
    // Treat that 23505 as success and return the row the winner inserted —
    // never surface it as a generic error or noisy workqueue item.
    const isUniqueViolation =
      (insertError as { code?: string }).code === "23505" ||
      /duplicate key|unique constraint/i.test(insertError.message ?? "");
    if (
      isUniqueViolation &&
      input.externalPaymentId &&
      (input.method === "stripe" || input.method === "external_card")
    ) {
      const { data: winner } = await supabase
        .from("client_payments")
        .select("id")
        .eq("organization_id", input.organizationId)
        .eq("payment_method", input.method)
        .eq("external_payment_id", input.externalPaymentId)
        .is("archived_at", null)
        .maybeSingle();
      if (winner?.id) {
        result.ok = true;
        result.alreadyPosted = true;
        result.paymentId = String(winner.id);
        return result;
      }
    }
    result.errors.push({ field: "client_payments", message: insertError.message });
    return result;
  }

  try {
    if (applyAmount > 0) {
      await supabase.from("payment_applications").insert({
        organization_id: input.organizationId,
        payment_kind: "client",
        payment_source_id: paymentId,
        client_id: input.clientId,
        claim_id: resolvedClaimId,
        applied_amount: applyAmount,
        applied_at: now,
      });

      await supabase.from("era_posting_ledger_entries").insert({
        organization_id: input.organizationId,
        professional_claim_id: resolvedClaimId,
        client_id: input.clientId,
        source_type: "patient_payment",
        source_id: paymentId,
        entry_type: "insurance_payment",
        amount: -applyAmount, // negative = reduces balance
        description: `Client payment applied (${input.method})`,
      });

      result.effects.push({
        entryType: "insurance_payment",
        amount: -applyAmount,
        description: `Client payment applied (${input.method})`,
      });

      if (resolvedInvoiceId) {
        const { data: inv } = await supabase
          .from("patient_invoices")
          .select("paid_amount, balance_amount, invoice_status")
          .eq("id", resolvedInvoiceId)
          .maybeSingle();
        const newPaid = round2(Number(inv?.paid_amount ?? 0) + applyAmount);
        const newBal = Math.max(0, round2(Number(inv?.balance_amount ?? 0) - applyAmount));
        const newStatus = newBal <= 0 ? "paid" : inv?.invoice_status === "draft" ? "open" : inv?.invoice_status ?? "open";
        await supabase
          .from("patient_invoices")
          .update({ paid_amount: newPaid, balance_amount: newBal, invoice_status: newStatus, updated_at: now })
          .eq("id", resolvedInvoiceId)
          .eq("organization_id", input.organizationId);
      }
      if (resolvedClaimId) {
        const { data: cl } = await supabase
          .from("professional_claims")
          .select("patient_responsibility_amount")
          .eq("id", resolvedClaimId)
          .maybeSingle();
        const nextPr = Math.max(0, round2(Number(cl?.patient_responsibility_amount ?? 0) - applyAmount));
        await supabase
          .from("professional_claims")
          .update({ patient_responsibility_amount: nextPr, updated_at: now })
          .eq("id", resolvedClaimId)
          .eq("organization_id", input.organizationId);
      }
    }

    if (unapplied > 0) {
      const creditId = genId();
      const { error: credErr } = await supabase.from("client_credits").insert({
        id: creditId,
        organization_id: input.organizationId,
        client_id: input.clientId,
        source_payment_id: paymentId,
        initial_amount: unapplied,
        applied_amount: 0,
        balance_amount: unapplied,
        note: input.note ?? `Unapplied portion of ${input.method} payment`,
      });
      if (credErr) throw new Error(credErr.message);
      result.creditId = creditId;
      const credAudit = await writePaymentAuditLog(supabase, {
        organizationId: input.organizationId,
        actor: input.actor,
        action: "unapplied_credit_recorded",
        objectType: "patient_invoice_payment",
        objectId: creditId,
        afterValue: { client_id: input.clientId, amount: unapplied, source_payment_id: paymentId },
        summary: `Recorded unapplied credit ${unapplied.toFixed(2)} for client ${input.clientId}`,
      });
      if (credAudit) result.auditLogIds.push(credAudit.id);
    }

    const audit = await writePaymentAuditLog(supabase, {
      organizationId: input.organizationId,
      actor: input.actor,
      action: "payment_posted",
      objectType: "patient_invoice_payment",
      objectId: paymentId,
      claimId: resolvedClaimId,
      afterValue: {
        amount,
        method: input.method,
        apply_to: input.applyTo.kind,
        applied_amount: applyAmount,
        unapplied_amount: unapplied,
        external_payment_id: input.externalPaymentId ?? null,
      },
      summary: `Posted client payment ${amount.toFixed(2)} (${input.method}) — applied ${applyAmount.toFixed(2)}, unapplied ${unapplied.toFixed(2)}`,
      metadata: { source: "patient_payment", warnings: result.validation.warning.map((w) => w.code) },
    });
    if (audit) result.auditLogIds.push(audit.id);

    // Paired transferred_balance entries: write payment_transfers row and a
    // matching negative ledger entry on the source so the source balance
    // decreases at the same time the destination credit is applied above.
    if (input.method === "transferred_balance" && input.transferFrom && applyAmount > 0) {
      const tf = input.transferFrom;

      const transferId = genId();
      const { error: tErr } = await supabase.from("payment_transfers").insert({
        id: transferId,
        organization_id: input.organizationId,
        client_id: input.clientId,
        from_invoice_id: tf.fromInvoiceId ?? null,
        from_claim_id: tf.fromClaimId ?? null,
        to_invoice_id: resolvedInvoiceId,
        to_claim_id: resolvedClaimId,
        amount: applyAmount,
        reason: input.transferReason ?? input.note ?? null,
        transferred_actor_id: input.actor.staffId ?? null,
      });
      if (tErr) throw new Error(tErr.message);

      // Negative ledger entry on the source — increases source balance back
      // (i.e. the source's previously-credited amount is moved away).
      await supabase.from("era_posting_ledger_entries").insert({
        organization_id: input.organizationId,
        professional_claim_id: tf.fromClaimId ?? null,
        client_id: input.clientId,
        source_type: "payment_transfer",
        source_id: transferId,
        entry_type: "insurance_payment",
        amount: applyAmount, // positive = restores balance on source
        description: `Balance transferred away (${input.transferReason ?? "transfer"})`,
      });
      // The destination already received its negative entry in the applyAmount
      // block above; this row pairs the source side for full audit symmetry.

      if (tf.fromInvoiceId) {
        const { data: srcInv } = await supabase
          .from("patient_invoices")
          .select("paid_amount, balance_amount")
          .eq("id", tf.fromInvoiceId)
          .maybeSingle();
        const srcPaid = Math.max(0, round2(Number(srcInv?.paid_amount ?? 0) - applyAmount));
        const srcBal = round2(Number(srcInv?.balance_amount ?? 0) + applyAmount);
        await supabase
          .from("patient_invoices")
          .update({ paid_amount: srcPaid, balance_amount: srcBal, updated_at: now })
          .eq("id", tf.fromInvoiceId)
          .eq("organization_id", input.organizationId);
      }
      if (tf.fromClaimId) {
        const { data: srcCl } = await supabase
          .from("professional_claims")
          .select("patient_responsibility_amount")
          .eq("id", tf.fromClaimId)
          .maybeSingle();
        const nextPr = round2(Number(srcCl?.patient_responsibility_amount ?? 0) + applyAmount);
        await supabase
          .from("professional_claims")
          .update({ patient_responsibility_amount: nextPr, updated_at: now })
          .eq("id", tf.fromClaimId)
          .eq("organization_id", input.organizationId);
      }

      const tAudit = await writePaymentAuditLog(supabase, {
        organizationId: input.organizationId,
        actor: input.actor,
        action: "payment_adjusted",
        objectType: "patient_invoice_payment",
        objectId: transferId,
        afterValue: {
          transfer_id: transferId,
          amount: applyAmount,
          from_invoice_id: tf.fromInvoiceId ?? null,
          from_claim_id: tf.fromClaimId ?? null,
          to_invoice_id: resolvedInvoiceId,
          to_claim_id: resolvedClaimId,
        },
        summary: `Transferred ${applyAmount.toFixed(2)} from ${tf.fromInvoiceId ?? tf.fromClaimId} to ${resolvedInvoiceId ?? resolvedClaimId}`,
      });
      if (tAudit) result.auditLogIds.push(tAudit.id);
    }

    try {
      const { applyWorkqueueRules } = await import("./workqueueRules");
      await applyWorkqueueRules(supabase, {
        organizationId: input.organizationId,
        sourceObjectType: "client_payment",
        sourceObjectId: paymentId,
        professionalClaimId: resolvedClaimId,
        clientId: input.clientId,
        sourceKind: "patient_payment",
        actor: input.actor,
      });
    } catch (ruleErr) {
      console.warn(
        "[patientPayment] applyWorkqueueRules failed (non-fatal)",
        ruleErr instanceof Error ? ruleErr.message : ruleErr,
      );
    }

    result.ok = true;
    result.posted = true;
    result.paymentId = paymentId;
    result.appliedAmount = applyAmount;
    result.unappliedAmount = unapplied;
    return result;
  } catch (err) {
    result.errors.push({
      field: "patient_payment",
      message: err instanceof Error ? err.message : "Failed to post client payment",
    });
    return result;
  }
}

/**
 * Apply an existing client_credit balance against a patient_invoice (or
 * professional_claim's client-responsibility). Produces a
 * client_credit_applications row + ledger entry + invoice/claim updates.
 */
export interface ApplyClientCreditInput {
  organizationId: string;
  clientCreditId: string;
  amount: number;
  applyTo:
    | { kind: "invoice"; patientInvoiceId: string }
    | { kind: "claim"; professionalClaimId: string };
  actor: PostingActor;
  note?: string | null;
}

export interface ApplyClientCreditResult {
  ok: boolean;
  applicationId: string | null;
  newCreditBalance: number;
  errors: Array<{ field: string; message: string }>;
}

export async function applyClientCredit(
  input: ApplyClientCreditInput,
  supabaseClient?: NonNullable<ReturnType<typeof createServerSupabaseAdminClient>> | null,
): Promise<ApplyClientCreditResult> {
  const errors: Array<{ field: string; message: string }> = [];
  const supabase = supabaseClient ?? createServerSupabaseAdminClient();
  if (!supabase) {
    return { ok: false, applicationId: null, newCreditBalance: 0, errors: [{ field: "system", message: "Database connection not available" }] };
  }
  const amount = round2(Number(input.amount));
  if (amount <= 0) {
    return { ok: false, applicationId: null, newCreditBalance: 0, errors: [{ field: "amount", message: "Amount must be greater than zero." }] };
  }
  const { data: credit, error: cErr } = await supabase
    .from("client_credits")
    .select("id, organization_id, client_id, balance_amount, applied_amount")
    .eq("organization_id", input.organizationId)
    .eq("id", input.clientCreditId)
    .is("archived_at", null)
    .maybeSingle();
  if (cErr) {
    errors.push({ field: "client_credits", message: cErr.message });
    return { ok: false, applicationId: null, newCreditBalance: 0, errors };
  }
  if (!credit) {
    return { ok: false, applicationId: null, newCreditBalance: 0, errors: [{ field: "clientCreditId", message: "Credit not found." }] };
  }
  const available = round2(Number(credit.balance_amount));
  if (amount > available) {
    return { ok: false, applicationId: null, newCreditBalance: available, errors: [{ field: "amount", message: `Requested ${amount.toFixed(2)} exceeds credit balance ${available.toFixed(2)}.` }] };
  }

  let invoiceId: string | null = null;
  let claimId: string | null = null;
  if (input.applyTo.kind === "invoice") {
    const { data, error } = await supabase
      .from("patient_invoices")
      .select("id, client_id, paid_amount, balance_amount, invoice_status")
      .eq("organization_id", input.organizationId)
      .eq("id", input.applyTo.patientInvoiceId)
      .is("archived_at", null)
      .maybeSingle();
    if (error || !data) {
      return { ok: false, applicationId: null, newCreditBalance: available, errors: [{ field: "patientInvoiceId", message: error?.message ?? "Invoice not found." }] };
    }
    if (data.client_id !== credit.client_id) {
      return { ok: false, applicationId: null, newCreditBalance: available, errors: [{ field: "patientInvoiceId", message: "Invoice belongs to a different client." }] };
    }
    invoiceId = String(data.id);
    // Cap to invoice balance; never overpay an invoice via a credit application.
    const invBal = round2(Number(data.balance_amount ?? 0));
    if (amount > invBal + 0.005) {
      return { ok: false, applicationId: null, newCreditBalance: available, errors: [{ field: "amount", message: `Requested ${amount.toFixed(2)} exceeds invoice balance ${invBal.toFixed(2)}.` }] };
    }
    const newPaid = round2(Number(data.paid_amount ?? 0) + amount);
    const newBal = Math.max(0, round2(invBal - amount));
    const newStatus = newBal <= 0 ? "paid" : data.invoice_status === "draft" ? "open" : data.invoice_status;
    await supabase
      .from("patient_invoices")
      .update({ paid_amount: newPaid, balance_amount: newBal, invoice_status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", invoiceId);
  } else {
    const { data, error } = await supabase
      .from("professional_claims")
      .select("id, patient_id, patient_responsibility_amount")
      .eq("organization_id", input.organizationId)
      .eq("id", input.applyTo.professionalClaimId)
      .is("archived_at", null)
      .maybeSingle();
    if (error || !data) {
      return { ok: false, applicationId: null, newCreditBalance: available, errors: [{ field: "professionalClaimId", message: error?.message ?? "Claim not found." }] };
    }
    if (data.patient_id !== credit.client_id) {
      return { ok: false, applicationId: null, newCreditBalance: available, errors: [{ field: "professionalClaimId", message: "Claim belongs to a different client." }] };
    }
    claimId = String(data.id);
    const pr = round2(Number(data.patient_responsibility_amount ?? 0));
    if (amount > pr + 0.005) {
      return { ok: false, applicationId: null, newCreditBalance: available, errors: [{ field: "amount", message: `Requested ${amount.toFixed(2)} exceeds claim client-responsibility ${pr.toFixed(2)}.` }] };
    }
    const nextPr = Math.max(0, round2(pr - amount));
    await supabase
      .from("professional_claims")
      .update({ patient_responsibility_amount: nextPr, updated_at: new Date().toISOString() })
      .eq("id", claimId);
  }

  const applicationId = genId();
  const { error: aErr } = await supabase.from("client_credit_applications").insert({
    id: applicationId,
    organization_id: input.organizationId,
    client_credit_id: credit.id,
    patient_invoice_id: invoiceId,
    professional_claim_id: claimId,
    applied_amount: amount,
    applied_actor_id: input.actor.staffId ?? null,
    note: input.note ?? null,
  });
  if (aErr) {
    errors.push({ field: "client_credit_applications", message: aErr.message });
    return { ok: false, applicationId: null, newCreditBalance: available, errors };
  }

  const newApplied = round2(Number(credit.applied_amount ?? 0) + amount);
  const newBalance = round2(available - amount);
  await supabase
    .from("client_credits")
    .update({ applied_amount: newApplied, balance_amount: newBalance, updated_at: new Date().toISOString() })
    .eq("id", credit.id);

  await writePaymentAuditLog(supabase, {
    organizationId: input.organizationId,
    actor: input.actor,
    action: "payment_adjusted",
    objectType: "patient_invoice_payment",
    objectId: applicationId,
    afterValue: { credit_id: credit.id, applied_amount: amount, new_balance: newBalance, invoice_id: invoiceId, claim_id: claimId },
    summary: `Applied client credit ${amount.toFixed(2)} from credit ${credit.id}`,
  });

  return { ok: true, applicationId, newCreditBalance: newBalance, errors: [] };
}
