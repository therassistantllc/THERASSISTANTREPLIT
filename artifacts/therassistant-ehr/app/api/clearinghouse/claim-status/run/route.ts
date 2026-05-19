// File: app/api/clearinghouse/claim-status/run/route.ts
import { NextResponse } from "next/server";
import { ClearinghouseService } from "@/lib/clearinghouse/ClearinghouseService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body?.claimId) {
      return NextResponse.json({ error: "claimId is required." }, { status: 400 });
    }

    const service = new ClearinghouseService();
    const result = await service.runClaimStatus({ claimId: body.claimId });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Claim status run failed." },
      { status: 500 }
    );
  }
}
