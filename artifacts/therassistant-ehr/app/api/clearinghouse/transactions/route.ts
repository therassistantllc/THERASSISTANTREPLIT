// File: app/api/clearinghouse/transactions/route.ts
import { NextResponse } from "next/server";
import { ClearinghouseService } from "@/lib/clearinghouse/ClearinghouseService";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const service = new ClearinghouseService();
    const result = await service.getTransactions({
      transaction_type: searchParams.get("transaction_type"),
      client_id: searchParams.get("client_id") ?? searchParams.get("patient_id"),
      claim_id: searchParams.get("claim_id"),
      status: searchParams.get("status"),
      date_from: searchParams.get("date_from"),
      date_to: searchParams.get("date_to"),
    });
    return NextResponse.json({ rows: result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load transaction log." },
      { status: 500 }
    );
  }
}
