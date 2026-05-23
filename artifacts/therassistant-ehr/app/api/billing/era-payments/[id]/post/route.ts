import { NextResponse } from "next/server";
import { postSingleEra835ClaimPayment } from "@/lib/payments/era835PostingService";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { organizationId?: string };
    const organizationId = body.organizationId ? String(body.organizationId) : "";

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }
    if (!id) {
      return NextResponse.json({ success: false, error: "ERA payment id is required" }, { status: 400 });
    }

    const actor = await requireAuthenticatedPaymentPoster(organizationId);

    const result = await postSingleEra835ClaimPayment({
      organizationId,
      eraClaimPaymentId: id,
      actor,
    });

    if (!result.ok) {
      const status = result.blocked ? 409 : 500;
      return NextResponse.json({ success: false, ...result }, { status });
    }

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    if (error instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    console.error("Post ERA payment API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to post ERA payment" },
      { status: 500 },
    );
  }
}
