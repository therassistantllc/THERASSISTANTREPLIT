import { NextResponse } from "next/server";
import { convertChargeCaptureToProfessionalClaim } from "@/lib/charges/chargeToProfessionalClaimService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId || !body.chargeId || !body.billingProvider) {
      return NextResponse.json(
        { success: false, error: "organizationId, chargeId, and billingProvider are required" },
        { status: 400 },
      );
    }

    const result = await convertChargeCaptureToProfessionalClaim({
      organizationId: String(body.organizationId),
      chargeId: String(body.chargeId),
      billingProvider: body.billingProvider,
    });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("Charge to claim API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Charge to claim conversion failed" },
      { status: 500 },
    );
  }
}
