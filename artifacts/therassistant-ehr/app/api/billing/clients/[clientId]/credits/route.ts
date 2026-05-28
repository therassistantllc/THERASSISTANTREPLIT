/**
 * GET  /api/billing/clients/[clientId]/credits  — list unapplied credits.
 * POST /api/billing/clients/[clientId]/credits  — apply a credit to an
 *      invoice/claim, OR refund a credit back to the source payment.
 *
 * Refund path (action: "refund") loads the credit's `source_payment_id`,
 * dispatches recordPatientRefund against that client_payment, then
 * decrements the credit balance so the Summary tab's "Credit on account"
 * total stays in sync. We never refund more than the credit balance — the
 * unrefunded portion of the source payment that was already applied to an
 * invoice is handled by the regular payment-detail refund flow, not here.
 */

import { NextResponse } from "next/server";
import {
  applyClientCredit,
  recordPatientRefund,
  requireAuthenticatedPaymentPoster,
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
} from "@/lib/payments/postingEngine";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { assertFkBelongsToOrg, FkOwnershipError } from "@/lib/payments/fkOwnershipGuard";

type DbRow = Record<string, unknown>;

export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const { clientId } = await params;
    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organizationId") ?? "";
    if (!organizationId) {
      return NextResponse.json({ ok: false, error: "organizationId is required" }, { status: 400 });
    }
    await requireAuthenticatedPaymentPoster(organizationId);
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ ok: false, error: "DB unavailable" }, { status: 503 });

    const { data, error } = await supabase
      .from("client_credits")
      .select("id, client_id, source_payment_id, initial_amount, applied_amount, balance_amount, note, created_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 422 });

    // Hydrate the originating client_payment so the UI can show "Visa ****
    // 4242 on May 12" instead of an opaque uuid. Best-effort: if the source
    // payment lookup fails we still return the credit rows so the panel
    // renders — the source label just falls back to "—".
    const credits = (data ?? []) as DbRow[];
    const sourceIds = Array.from(
      new Set(
        credits
          .map((c) => (typeof c.source_payment_id === "string" ? c.source_payment_id : null))
          .filter((v): v is string => !!v),
      ),
    );

    const sourceById = new Map<string, DbRow>();
    if (sourceIds.length > 0) {
      const { data: payments } = await supabase
        .from("client_payments")
        .select("id, payment_method, reference_number, posted_at, amount, posting_status, reversed_at")
        .eq("organization_id", organizationId)
        .in("id", sourceIds);
      for (const p of (payments ?? []) as DbRow[]) {
        sourceById.set(String(p.id), p);
      }
    }

    const enriched = credits.map((c) => {
      const sourceId = typeof c.source_payment_id === "string" ? c.source_payment_id : null;
      const source = sourceId ? sourceById.get(sourceId) ?? null : null;
      return {
        ...c,
        source: source
          ? {
              id: String(source.id),
              paymentMethod: (source.payment_method as string | null) ?? null,
              referenceNumber: (source.reference_number as string | null) ?? null,
              paidAt: (source.posted_at as string | null) ?? null,
              amount: source.amount ?? null,
              postingStatus: (source.posting_status as string | null) ?? null,
              reversedAt: (source.reversed_at as string | null) ?? null,
              refundable:
                String(source.posting_status ?? "") === "posted" &&
                !source.reversed_at,
            }
          : null,
      };
    });

    return NextResponse.json({ ok: true, credits: enriched });
  } catch (err) {
    if (err instanceof PaymentPostingUnauthenticatedError) return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
    if (err instanceof PaymentPostingForbiddenError) return NextResponse.json({ ok: false, error: err.message }, { status: 403 });
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const { clientId } = await params;
    const body = await request.json();
    const organizationId = String(body.organizationId ?? "").trim();
    if (!organizationId) return NextResponse.json({ ok: false, error: "organizationId is required" }, { status: 400 });
    const actor = await requireAuthenticatedPaymentPoster(organizationId);
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ ok: false, error: "DB unavailable" }, { status: 503 });

    const clientCreditId = String(body.clientCreditId ?? "").trim();
    if (!clientCreditId) return NextResponse.json({ ok: false, error: "clientCreditId is required" }, { status: 400 });
    await assertFkBelongsToOrg(supabase as unknown as Parameters<typeof assertFkBelongsToOrg>[0], "client_credits", organizationId, clientCreditId);

    const action = String(body.action ?? "apply").trim();

    if (action === "refund") {
      // Refund a credit back to the source client_payment, then decrement
      // the credit balance so the Summary tab total updates immediately.
      const amount = Number(body.amount ?? 0);
      if (!(amount > 0)) {
        return NextResponse.json({ ok: false, error: "amount must be greater than zero" }, { status: 400 });
      }
      const reason = String(body.reason ?? "").trim();
      if (!reason) {
        return NextResponse.json({ ok: false, error: "reason is required for a refund" }, { status: 400 });
      }

      const { data: credit, error: cErr } = await supabase
        .from("client_credits")
        .select("id, client_id, source_payment_id, balance_amount, applied_amount")
        .eq("organization_id", organizationId)
        .eq("id", clientCreditId)
        .is("archived_at", null)
        .maybeSingle();
      if (cErr) return NextResponse.json({ ok: false, error: cErr.message }, { status: 422 });
      if (!credit) return NextResponse.json({ ok: false, error: "Credit not found" }, { status: 404 });
      if (credit.client_id !== clientId) {
        return NextResponse.json({ ok: false, error: "Credit belongs to a different client" }, { status: 422 });
      }
      const available = Math.round(Number(credit.balance_amount ?? 0) * 100) / 100;
      if (amount > available + 0.005) {
        return NextResponse.json(
          { ok: false, error: `Requested ${amount.toFixed(2)} exceeds credit balance ${available.toFixed(2)}.` },
          { status: 422 },
        );
      }
      const sourcePaymentId = typeof credit.source_payment_id === "string" ? credit.source_payment_id : null;
      if (!sourcePaymentId) {
        return NextResponse.json(
          { ok: false, error: "This credit has no source payment to refund." },
          { status: 422 },
        );
      }

      const r = await recordPatientRefund({
        organizationId,
        target: { kind: "client_payment", id: sourcePaymentId },
        amount,
        reason,
        actor,
      });
      if (!r.ok) {
        return NextResponse.json({ ok: false, errors: r.errors }, { status: 422 });
      }

      // Decrement the credit so Summary tab "Credit on account" drops by
      // the refunded amount. Best-effort — if this fails the refund row is
      // still recorded; we surface the error so the UI can prompt a refetch.
      const newBalance = Math.max(0, Math.round((available - amount) * 100) / 100);
      const updatePayload: Record<string, unknown> = {
        balance_amount: newBalance,
        updated_at: new Date().toISOString(),
      };
      if (newBalance <= 0) {
        updatePayload.archived_at = new Date().toISOString();
      }
      const { error: uErr } = await supabase
        .from("client_credits")
        .update(updatePayload)
        .eq("id", clientCreditId)
        .eq("organization_id", organizationId);
      if (uErr) {
        return NextResponse.json(
          {
            ok: true,
            refundId: r.refundId,
            refundStatus: r.refundStatus,
            newCreditBalance: available,
            warning: `Refund recorded but failed to update credit balance: ${uErr.message}`,
          },
          { status: 200 },
        );
      }

      return NextResponse.json({
        ok: true,
        refundId: r.refundId,
        refundStatus: r.refundStatus,
        workqueueItemId: r.workqueueItemId,
        newCreditBalance: newBalance,
      });
    }

    // Default action: apply credit to an invoice or claim.
    let applyTo: { kind: "invoice"; patientInvoiceId: string } | { kind: "claim"; professionalClaimId: string };
    if (body.patientInvoiceId) {
      await assertFkBelongsToOrg(supabase as unknown as Parameters<typeof assertFkBelongsToOrg>[0], "patient_invoices", organizationId, String(body.patientInvoiceId));
      applyTo = { kind: "invoice", patientInvoiceId: String(body.patientInvoiceId) };
    } else if (body.professionalClaimId) {
      await assertFkBelongsToOrg(supabase as unknown as Parameters<typeof assertFkBelongsToOrg>[0], "professional_claims", organizationId, String(body.professionalClaimId));
      applyTo = { kind: "claim", professionalClaimId: String(body.professionalClaimId) };
    } else {
      return NextResponse.json({ ok: false, error: "patientInvoiceId or professionalClaimId is required" }, { status: 400 });
    }

    void clientId;
    const r = await applyClientCredit({
      organizationId,
      clientCreditId,
      amount: Number(body.amount ?? 0),
      applyTo,
      actor,
      note: body.note ? String(body.note) : null,
    });
    if (!r.ok) return NextResponse.json({ ok: false, errors: r.errors }, { status: 422 });
    return NextResponse.json({ ok: true, applicationId: r.applicationId, newCreditBalance: r.newCreditBalance });
  } catch (err) {
    if (err instanceof PaymentPostingUnauthenticatedError) return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
    if (err instanceof PaymentPostingForbiddenError) return NextResponse.json({ ok: false, error: err.message }, { status: 403 });
    if (err instanceof FkOwnershipError) return NextResponse.json({ ok: false, error: err.message }, { status: 404 });
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
