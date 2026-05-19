import { NextResponse } from "next/server";
import { voidPatientInvoice } from "@/lib/payments/patientInvoicePaymentService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId || !body.patientInvoiceId) {
      return NextResponse.json(
        { success: false, error: "organizationId and patientInvoiceId are required" },
        { status: 400 },
      );
    }

    const result = await voidPatientInvoice({
      organizationId: String(body.organizationId),
      patientInvoiceId: String(body.patientInvoiceId),
      memo: body.memo ?? null,
    });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("Patient invoice void API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Patient invoice void failed" },
      { status: 500 },
    );
  }
}
