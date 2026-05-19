import { NextResponse } from "next/server";
import { routeEraMismatchClaimsToWorkqueue } from "@/lib/workqueue/eraMismatchWorkqueueService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    const result = await routeEraMismatchClaimsToWorkqueue({
      organizationId: String(body.organizationId),
      now: body.now ?? undefined,
    });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("ERA mismatch workqueue API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "ERA mismatch workqueue routing failed" },
      { status: 500 },
    );
  }
}
