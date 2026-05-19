import { NextResponse } from "next/server";
import {
  createProfessionalClaimDraft,
  validateProfessionalClaimReadiness,
} from "@/lib/claims/claimReadinessService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = body.action ?? "create_draft";

    if (action === "validate_existing") {
      if (!body.organizationId || !body.claimId) {
        return NextResponse.json({ success: false, error: "organizationId and claimId are required" }, { status: 400 });
      }

      const result = await validateProfessionalClaimReadiness(String(body.claimId), String(body.organizationId));
      return NextResponse.json({ success: result.ok, result });
    }

    const required = ["organizationId", "clientId", "diagnosisCodes", "serviceLines", "billingProvider"];
    for (const field of required) {
      if (body[field] == null) {
        return NextResponse.json({ success: false, error: `${field} is required` }, { status: 400 });
      }
    }

    const result = await createProfessionalClaimDraft({
      organizationId: String(body.organizationId),
      clientId: String(body.clientId),
      policyId: body.policyId ?? null,
      appointmentId: body.appointmentId ?? null,
      placeOfService: body.placeOfService ?? null,
      diagnosisCodes: body.diagnosisCodes,
      serviceLines: body.serviceLines,
      billingProvider: body.billingProvider,
      patientAccountNumber: body.patientAccountNumber ?? null,
      claimNumber: body.claimNumber ?? null,
    });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("Claim readiness API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Claim readiness failed" },
      { status: 500 },
    );
  }
}
