/**
 * POST /api/billing/payments/patient
 *
 * Records a client payment (Stripe / cash / check / external_card /
 * refund / unapplied_credit / transferred_balance) and applies it to an
 * invoice, encounter, claim, or the client's account-balance bucket.
 * Reuses any existing Stripe webhook/charge id supplied — does NOT create
 * a new Stripe integration.
 */

import { NextResponse } from "next/server";
import {
  commitPatientPayment,
  requireAuthenticatedPaymentPoster,
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  type PatientPaymentApplyTo,
  type PatientPaymentMethod,
} from "@/lib/payments/postingEngine";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { assertFkBelongsToOrg, FkOwnershipError } from "@/lib/payments/fkOwnershipGuard";

// PP-4 (Task #113): "refund" deliberately excluded — callers must use
// /api/billing/payments/posted/[id]/refund so the prior posted payment is
// reversed atomically (ledger compensation + Stripe issuance + workqueue).
const ALLOWED_METHODS: PatientPaymentMethod[] = [
  "cash",
  "check",
  "credit_card",
  "debit_card",
  "stripe",
  "external_card",
  "unapplied_credit",
  "transferred_balance",
  "other",
];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const organizationId = String(body.organizationId ?? "").trim();
    if (!organizationId) {
      return NextResponse.json({ ok: false, error: "organizationId is required" }, { status: 400 });
    }
    const actor = await requireAuthenticatedPaymentPoster(organizationId);

    const clientId = String(body.clientId ?? "").trim();
    if (!clientId) {
      return NextResponse.json({ ok: false, error: "clientId is required" }, { status: 400 });
    }
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Database connection not available" }, { status: 503 });
    }
    await assertFkBelongsToOrg(supabase as unknown as Parameters<typeof assertFkBelongsToOrg>[0], "clients", organizationId, clientId);

    const method = String(body.method ?? "cash") as PatientPaymentMethod;
    if (String(body.method ?? "") === "refund") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Refunds must be issued against the prior posted payment via /api/billing/payments/posted/[id]/refund (PP-4). Direct method='refund' intake is no longer supported.",
        },
        { status: 400 },
      );
    }
    if (!ALLOWED_METHODS.includes(method)) {
      return NextResponse.json({ ok: false, error: `Unsupported payment method: ${method}` }, { status: 400 });
    }

    const applyToKind = String(body.applyToKind ?? "account_balance");
    let applyTo: PatientPaymentApplyTo = { kind: "none" };
    if (applyToKind === "invoice") {
      const id = String(body.patientInvoiceId ?? "").trim();
      if (!id) return NextResponse.json({ ok: false, error: "patientInvoiceId is required for invoice apply" }, { status: 400 });
      await assertFkBelongsToOrg(supabase as unknown as Parameters<typeof assertFkBelongsToOrg>[0], "patient_invoices", organizationId, id);
      applyTo = { kind: "invoice", patientInvoiceId: id };
    } else if (applyToKind === "claim") {
      const id = String(body.professionalClaimId ?? "").trim();
      if (!id) return NextResponse.json({ ok: false, error: "professionalClaimId is required for claim apply" }, { status: 400 });
      await assertFkBelongsToOrg(supabase as unknown as Parameters<typeof assertFkBelongsToOrg>[0], "professional_claims", organizationId, id);
      applyTo = { kind: "claim", professionalClaimId: id };
    } else if (applyToKind === "encounter") {
      const id = String(body.appointmentId ?? "").trim();
      if (!id) return NextResponse.json({ ok: false, error: "appointmentId is required for encounter apply" }, { status: 400 });
      await assertFkBelongsToOrg(supabase as unknown as Parameters<typeof assertFkBelongsToOrg>[0], "appointments", organizationId, id, "appointmentId");
      applyTo = { kind: "encounter", appointmentId: id };
    } else if (applyToKind === "account_balance") {
      applyTo = { kind: "account_balance" };
    }

    let transferFrom: { fromInvoiceId?: string | null; fromClaimId?: string | null } | null = null;
    if (body.transferFrom && (body.transferFrom.fromInvoiceId || body.transferFrom.fromClaimId)) {
      const fromInvoiceId = body.transferFrom.fromInvoiceId ? String(body.transferFrom.fromInvoiceId) : null;
      const fromClaimId = body.transferFrom.fromClaimId ? String(body.transferFrom.fromClaimId) : null;
      if (fromInvoiceId) {
        await assertFkBelongsToOrg(supabase as unknown as Parameters<typeof assertFkBelongsToOrg>[0], "patient_invoices", organizationId, fromInvoiceId, "transferFrom.fromInvoiceId");
      }
      if (fromClaimId) {
        await assertFkBelongsToOrg(supabase as unknown as Parameters<typeof assertFkBelongsToOrg>[0], "professional_claims", organizationId, fromClaimId, "transferFrom.fromClaimId");
      }
      transferFrom = { fromInvoiceId, fromClaimId };
    }

    const result = await commitPatientPayment({
      organizationId,
      clientId,
      amount: Number(body.amount ?? 0),
      method,
      applyTo,
      externalPaymentId: body.externalPaymentId ? String(body.externalPaymentId) : null,
      stripeChargeId: body.stripeChargeId ? String(body.stripeChargeId) : null,
      stripeConnectedAccountId: body.stripeConnectedAccountId ? String(body.stripeConnectedAccountId) : null,
      referenceNumber: body.reference ? String(body.reference) : null,
      note: body.note ? String(body.note) : null,
      paymentDate: body.paymentDate ? String(body.paymentDate) : null,
      transferFrom,
      transferReason: body.transferReason ? String(body.transferReason) : null,
      actor,
      dryRun: Boolean(body.dryRun),
    });

    if (!result.ok && result.blocked) {
      return NextResponse.json(
        { ok: false, blocked: true, validation: result.validation, errors: result.errors },
        { status: 422 },
      );
    }
    if (!result.ok) {
      return NextResponse.json({ ok: false, errors: result.errors }, { status: 500 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    if (err instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
    }
    if (err instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 403 });
    }
    if (err instanceof FkOwnershipError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 404 });
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Client payment posting failed" },
      { status: 500 },
    );
  }
}
