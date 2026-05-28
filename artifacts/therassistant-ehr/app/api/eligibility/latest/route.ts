import { NextRequest, NextResponse } from "next/server";
import { getLatestEligibilityForClient } from "@/lib/eligibility/latestEligibilityService";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
export async function GET(req: NextRequest) {
  try {
    const guard = await requireOrgAccess({
      requestedOrganizationId: req.nextUrl.searchParams.get("organization_id"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const patientId = req.nextUrl.searchParams.get("patient_id");
    const payerId = req.nextUrl.searchParams.get("payer_id");

    if (!patientId) {
      return NextResponse.json(
        { error: "patient_id is required" },
        { status: 400 }
      );
    }

    const eligibility = await getLatestEligibilityForClient({
      organization_id: organizationId,
      patient_id: patientId,
      payer_id: payerId,
    });

    return NextResponse.json({
      ok: true,
      eligibility,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
