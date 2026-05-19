// File: app/api/clearinghouse/eligibility/run/route.ts
import { NextResponse } from "next/server";
import { ClearinghouseService } from "@/lib/clearinghouse/ClearinghouseService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body?.patientId) {
      return NextResponse.json({ error: "patientId is required." }, { status: 400 });
    }

    const service = new ClearinghouseService();
    const result = await service.runEligibility({
      patientId: body.patientId,
      appointmentId: body.appointmentId ?? null,
      insurancePolicyId: body.insurancePolicyId ?? null,
      serviceTypeCode: body.serviceTypeCode ?? "98",
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Eligibility run failed." },
      { status: 500 }
    );
  }
}
