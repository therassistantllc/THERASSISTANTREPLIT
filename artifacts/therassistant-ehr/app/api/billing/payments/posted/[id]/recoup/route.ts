/**
 * POST /api/billing/payments/posted/:id/recoup
 *
 * Records a payer recoupment (negative-payment takeback) against a
 * previously posted ERA-835 or client_payment. Writes a payment_recoupments
 * row, a negative ledger entry, and opens a recoupment_review workqueue item.
 */
import { NextResponse } from "next/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  recordRecoupment,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";
import { parseCompositePostedPaymentId as parseCompositeId } from "../_compositeId";

interface Body {
  organizationId?: string;
  amount?: number;
  reason?: string;
  reasonCode?: string | null;
  offsetEraClaimPaymentId?: string | null;
  dryRun?: boolean;
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
    const result = await recordRecoupment({
      organizationId,
      target,
      amount: Number(body.amount ?? 0),
      reason: String(body.reason ?? "").trim(),
      reasonCode: body.reasonCode ?? null,
      offsetEraClaimPaymentId: body.offsetEraClaimPaymentId ?? null,
      dryRun: body.dryRun === true,
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
    console.error("Recoup posted-payment API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to record recoupment" },
      { status: 500 },
    );
  }
}
