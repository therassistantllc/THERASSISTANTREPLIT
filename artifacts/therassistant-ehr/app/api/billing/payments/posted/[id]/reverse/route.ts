/**
 * POST /api/billing/payments/posted/:id/reverse
 *
 * Reverses a posted payment (writes paired negative ledger entries, restores
 * balances, marks posting_status='reversed', closes obsolete workqueue items,
 * audits). Routes ERA-835 / client_payment / insurance_manual uniformly
 * through the posting engine.
 */
import { NextResponse } from "next/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  requireAuthenticatedPaymentPoster,
  reversePostedPayment,
} from "@/lib/payments/postingEngine";
import { parseCompositePostedPaymentId as parseCompositeId } from "../_compositeId";

interface Body {
  organizationId?: string;
  reason?: string;
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
    const result = await reversePostedPayment({
      organizationId,
      target,
      reason: String(body.reason ?? "").trim(),
      actor,
    });
    if (!result.ok) {
      const isClientError = result.errors.some((e) =>
        ["reason", "posting_status", target.kind].includes(e.field),
      );
      return NextResponse.json({ success: false, ...result }, { status: isClientError ? 409 : 500 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError)
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    if (error instanceof PaymentPostingForbiddenError)
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    console.error("Reverse posted-payment API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to reverse payment" },
      { status: 500 },
    );
  }
}
