// File: app/api/claims/[claimId]/status-history/route.ts
import { NextResponse } from "next/server";
import { ClearinghouseService } from "@/lib/clearinghouse/ClearinghouseService";

export async function GET(
  _request: Request,
  context: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await context.params;
    const service = new ClearinghouseService();
    const result = await service.getClaimStatusHistory(claimId);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load claim status history." },
      { status: 500 }
    );
  }
}
