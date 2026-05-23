/**
 * POST /api/billing/payments/posted/:id/refund
 *
 * Records an insurance refund OR a patient refund against a posted payment.
 * `refundType` defaults to the natural fit for the source (client_payment →
 * patient; era_835/insurance_manual → insurance). Stripe issuance is
 * handled outside this route (Task #114 webhook); callers that have
 * already issued via Stripe may pass `stripeRefundId` + `alreadyIssued`.
 */
import { NextResponse } from "next/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  recordInsuranceRefund,
  recordPatientRefund,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";
import { parseCompositePostedPaymentId as parseCompositeId } from "../_compositeId";

interface Body {
  organizationId?: string;
  refundType?: "insurance" | "patient";
  amount?: number;
  reason?: string;
  stripeRefundId?: string | null;
  alreadyIssued?: boolean;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Body;
    const organizationId = body.organizationId ? String(body.organizationId) : "";
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }
    const target = parseCompositeId(rawId);
    if (!target) {
      return NextResponse.json(
        { success: false, error: "Invalid posted-payment id (expected era:|cp:|mi: prefix)" },
        { status: 400 },
      );
    }
    const actor = await requireAuthenticatedPaymentPoster(organizationId);
    const refundType: "insurance" | "patient" =
      body.refundType ?? (target.kind === "client_payment" ? "patient" : "insurance");
    const fn = refundType === "patient" ? recordPatientRefund : recordInsuranceRefund;
    const result = await fn({
      organizationId,
      target,
      amount: Number(body.amount ?? 0),
      reason: String(body.reason ?? "").trim(),
      stripeRefundId: body.stripeRefundId ?? null,
      alreadyIssued: body.alreadyIssued === true,
      actor,
    });
    if (!result.ok) {
      const isClientError = result.errors.some((e) =>
        ["amount", "reason", "target.kind", "posting_status", target.kind].includes(e.field),
      );
      return NextResponse.json({ success: false, ...result }, { status: isClientError ? 409 : 500 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError)
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    if (error instanceof PaymentPostingForbiddenError)
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    console.error("Refund posted-payment API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to record refund" },
      { status: 500 },
    );
  }
}
