import { NextResponse } from "next/server";
import { createClaimDraftFromChargeCapture } from "@/lib/claims/chargeCaptureClaimBridgeService";
import { assertClaimSubmissionReady, gateResponse } from "@/lib/validation/claimSubmissionGate";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

interface ReleaseRequestBody {
  organizationId?: string;
  chargeCaptureIds?: unknown;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ReleaseRequestBody;
    const requestedOrg = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
    const guard = await requireBillingAccess({ requestedOrganizationId: requestedOrg || null });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const ids = Array.isArray(body.chargeCaptureIds)
      ? body.chargeCaptureIds.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];

    if (ids.length === 0) {
      return NextResponse.json({ success: false, error: "chargeCaptureIds is required" }, { status: 400 });
    }

    const gate = await assertClaimSubmissionReady(organizationId);
    const blocked = gateResponse(gate);
    if (blocked) return blocked;

    const results = await Promise.all(
      ids.map(async (chargeCaptureId) => {
        const result = await createClaimDraftFromChargeCapture({ organizationId, chargeCaptureId });
        return {
          chargeCaptureId,
          ok: result.ok,
          claimId: result.claimId,
          errors: result.errors,
        };
      }),
    );

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;

    return NextResponse.json({
      success: true,
      totalRequested: ids.length,
      succeeded,
      failed,
      results,
    });
  } catch (error) {
    console.error("Charge release API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Release to billing failed" },
      { status: 500 },
    );
  }
}
