import { NextResponse } from "next/server";
import { recordPatientInvoicePayment } from "@/lib/payments/patientInvoicePaymentService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId || !body.patientInvoiceId || body.amount == null) {
      return NextResponse.json(
        { success: false, error: "organizationId, patientInvoiceId, and amount are required" },
        { status: 400 },
      );
    }

    const result = await recordPatientInvoicePayment({
      organizationId: String(body.organizationId),
      patientInvoiceId: String(body.patientInvoiceId),
      amount: Number(body.amount),
      paymentMethod: body.paymentMethod ?? "manual",
      externalPaymentId: body.externalPaymentId ?? null,
      memo: body.memo ?? null,
      paidAt: body.paidAt ?? null,
    });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("Client invoice payment API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Client invoice payment failed" },
      { status: 500 },
    );
  }
}
