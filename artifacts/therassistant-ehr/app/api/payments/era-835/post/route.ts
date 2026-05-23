import { NextResponse } from "next/server";
import { postEra835Batch } from "@/lib/payments/era835PostingService";
import { routeEra835ExceptionsToWorkqueue } from "@/lib/workqueue/era835ExceptionWorkqueueService";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId || !body.eraImportBatchId) {
      return NextResponse.json(
        { success: false, error: "organizationId and eraImportBatchId are required" },
        { status: 400 },
      );
    }

    const organizationId = String(body.organizationId);
    const eraImportBatchId = String(body.eraImportBatchId);
    const actor = await requireAuthenticatedPaymentPoster(organizationId);
    const result = await postEra835Batch({ organizationId, eraImportBatchId, actor });
    const exceptionRouting = await routeEra835ExceptionsToWorkqueue({ organizationId, eraImportBatchId });

    return NextResponse.json({ success: result.ok, result, exceptionRouting }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    if (error instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    console.error("ERA 835 posting API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "ERA 835 posting failed" },
      { status: 500 },
    );
  }
}
