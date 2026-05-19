import { NextResponse } from "next/server";
import { intake277CAAcknowledgement } from "@/lib/claims/edi277caAcknowledgementService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId || !body.rawContent) {
      return NextResponse.json({ success: false, error: "organizationId and rawContent are required" }, { status: 400 });
    }

    const result = await intake277CAAcknowledgement({
      organizationId: String(body.organizationId),
      batchId: body.batchId ?? null,
      fileName: body.fileName ?? null,
      rawContent: String(body.rawContent),
    });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("277CA acknowledgement API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "277CA acknowledgement intake failed" },
      { status: 500 },
    );
  }
}
