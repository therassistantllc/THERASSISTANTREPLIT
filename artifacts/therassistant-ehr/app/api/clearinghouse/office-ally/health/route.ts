import { NextResponse } from "next/server";
import { OfficeAllyJsonApiAdapter } from "@/lib/clearinghouse/adapters/OfficeAllyJsonApiAdapter";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    const adapter = new OfficeAllyJsonApiAdapter();
    const result = await adapter.healthCheck(organizationId);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Office Ally health check failed" },
      { status: 500 },
    );
  }
}
