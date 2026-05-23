/**
 * POST /api/billing/payments/posted/:id/confirm-refund
 *
 * Two-step insurance refund confirmation. The posted-payment id in the
 * path is the composite id of the SOURCE payment (used for audit context
 * and the action button's anchor); the actual refund row is identified
 * by `refundId` in the body. On confirmation:
 *   - payment_refunds.refund_status pending → issued
 *   - compensating negative ledger entry (source_type='refund') posted
 *   - professional_claims.claim_status restored to 'billed'
 *
 * Fail-closed: if ledger insert errors, refund is reverted to pending.
 */
import { NextResponse } from "next/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  confirmInsuranceRefund,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";
import { parseCompositePostedPaymentId as parseCompositeId, UUID_RE } from "../_compositeId";

interface Body {
  organizationId?: string;
  refundId?: string;
  reason?: string | null;
  externalReferenceNumber?: string | null;
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
    const refundId = String(body.refundId ?? "");
    if (!UUID_RE.test(refundId)) {
      return NextResponse.json({ success: false, error: "refundId must be a UUID" }, { status: 400 });
    }
    const actor = await requireAuthenticatedPaymentPoster(organizationId);
    const result = await confirmInsuranceRefund({
      organizationId,
      refundId,
      reason: body.reason ?? null,
      externalReferenceNumber: body.externalReferenceNumber ?? null,
      actor,
    });
    if (!result.ok) {
      const isClient = result.errors.some((e) => ["refund_status", "refund_type"].includes(e.field));
      return NextResponse.json({ success: false, ...result }, { status: isClient ? 409 : 500 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError)
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    if (error instanceof PaymentPostingForbiddenError)
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    console.error("Confirm-refund posted-payment API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to confirm refund" },
      { status: 500 },
    );
  }
}
