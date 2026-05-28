import { NextResponse } from "next/server";
import { markPatientInvoiceSent } from "@/lib/payments/patientInvoicePaymentService";
import { attemptAutopayForInvoice } from "@/lib/payments/autopayService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId || !body.patientInvoiceId) {
      return NextResponse.json(
        { success: false, error: "organizationId and patientInvoiceId are required" },
        { status: 400 },
      );
    }

    const organizationId = String(body.organizationId);
    const patientInvoiceId = String(body.patientInvoiceId);
    const result = await markPatientInvoiceSent({
      organizationId,
      patientInvoiceId,
      memo: body.memo ?? null,
    });

    // Task #602: auto-charge enrolled clients on statement send.
    const autopayResult = result.ok
      ? await attemptAutopayForInvoice({ organizationId, patientInvoiceId }).catch(
          (err) => ({
            attempted: false,
            ok: false,
            code: "failed" as const,
            message: err instanceof Error ? err.message : "Autopay attempt threw",
          }),
        )
      : null;

    return NextResponse.json(
      { success: result.ok, result, autopayResult },
      { status: result.ok ? 200 : 422 },
    );
  } catch (error) {
    console.error("Client invoice mark sent API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Client invoice mark sent failed" },
      { status: 500 },
    );
  }
}
