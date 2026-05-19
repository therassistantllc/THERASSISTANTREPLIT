import { NextResponse } from "next/server";
import { OfficeAllyJsonApiAdapter } from "@/lib/clearinghouse/adapters/OfficeAllyJsonApiAdapter";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const adapter = new OfficeAllyJsonApiAdapter();

    const result = await adapter.fetchPayerSearchOptions({
      organizationId: body.organizationId ?? null,
      payerIds: body.payerIds ?? [],
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Payer search options request failed" },
      { status: 500 },
    );
  }
}
