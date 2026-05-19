import { NextResponse } from "next/server";
import { routeAgingProfessionalClaimsToWorkqueue } from "@/lib/workqueue/professionalClaimAgingWorkqueueService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    const result = await routeAgingProfessionalClaimsToWorkqueue({
      organizationId: String(body.organizationId),
      agingDays: body.agingDays == null ? undefined : Number(body.agingDays),
      now: body.now ?? undefined,
    });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("Claim aging workqueue API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Claim aging workqueue routing failed" },
      { status: 500 },
    );
  }
}
