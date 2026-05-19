// File: app/api/clearinghouse/events/route.ts
import { NextResponse } from "next/server";
import { ClearinghouseService } from "@/lib/clearinghouse/ClearinghouseService";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const service = new ClearinghouseService();
    const result = await service.getEvents({
      unresolved_only: searchParams.get("unresolved_only"),
      event_type: searchParams.get("event_type"),
      severity: searchParams.get("severity"),
      claim_id: searchParams.get("claim_id"),
      client_id: searchParams.get("client_id") ?? searchParams.get("patient_id"),
    });
    return NextResponse.json({ rows: result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load clearinghouse events." },
      { status: 500 }
    );
  }
}
