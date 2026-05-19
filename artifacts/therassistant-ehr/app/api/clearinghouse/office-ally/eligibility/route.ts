import { NextResponse } from "next/server";
import { OfficeAllyJsonApiAdapter } from "@/lib/clearinghouse/adapters/OfficeAllyJsonApiAdapter";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    if (!body.clientId) {
      return NextResponse.json({ success: false, error: "clientId is required" }, { status: 400 });
    }

    const adapter = new OfficeAllyJsonApiAdapter();

    const result = await adapter.runEligibility({
      organizationId: body.organizationId,
      clientId: body.clientId,
      appointmentId: body.appointmentId ?? null,
      insurancePolicyId: body.insurancePolicyId ?? null,
      request: body.request,
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Eligibility request failed" },
      { status: 500 },
    );
  }
}
