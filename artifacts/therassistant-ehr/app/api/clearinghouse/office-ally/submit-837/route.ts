import { NextResponse } from "next/server";
import { OfficeAllyJsonApiAdapter } from "@/lib/clearinghouse/adapters/OfficeAllyJsonApiAdapter";
import { assertClaimSubmissionReady, gateResponse } from "@/lib/validation/claimSubmissionGate";
import { resolveClearinghouseCredential } from "@/lib/clearinghouse/credentials";

/**
 * Raw-X12 837 transmission endpoint.
 *
 * This route accepts a pre-built X12 string and an organizationId without a batch reference,
 * which means we cannot determine which payers are inside the X12 envelope. The per-payer
 * enrollment gate (T003) therefore CANNOT be evaluated here.
 *
 * To preserve T003 compliance, this endpoint is hard-gated to SANDBOX credentials only.
 * Production 837 transmission must go through `/api/claims/837p/batch/[id]/submit`, which
 * resolves the batch's payers and runs the full per-payer enrollment gate.
 */

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    if (!body.x12) {
      return NextResponse.json({ success: false, error: "x12 payload is required" }, { status: 400 });
    }

    const gate = await assertClaimSubmissionReady(String(body.organizationId));
    const blocked = gateResponse(gate);
    if (blocked) return blocked;

    // Resolve credential explicitly (T001) and refuse production transmission (T003 bypass guard).
    const credential = await resolveClearinghouseCredential({
      organizationId: String(body.organizationId),
      vendor: "office_ally",
    });

    if (!credential) {
      return NextResponse.json(
        {
          success: false,
          error: "No active Office Ally credential is configured for this organization. Open /settings/clearinghouse to add one.",
        },
        { status: 412 },
      );
    }

    if (credential.environment === "production") {
      return NextResponse.json(
        {
          success: false,
          error:
            "Raw-X12 transmission is restricted to sandbox credentials. Production 837 submission must use the batch endpoint (/api/claims/837p/batch/[id]/submit) so the per-payer enrollment gate can run.",
          gate: {
            blocked: true,
            reason: "raw_x12_production_blocked",
            fixRoute: "/settings/payer-enrollments",
          },
        },
        { status: 422 },
      );
    }

    const adapter = new OfficeAllyJsonApiAdapter({
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl,
    });

    const result = await adapter.submitProfessionalX12({
      organizationId: body.organizationId,
      x12: body.x12,
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "837 submission failed" },
      { status: 500 },
    );
  }
}
