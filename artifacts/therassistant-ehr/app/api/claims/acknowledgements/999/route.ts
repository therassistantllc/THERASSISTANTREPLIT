import { NextResponse } from "next/server";
import { intake999Acknowledgement } from "@/lib/claims/edi999AcknowledgementService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId || !body.rawContent) {
      return NextResponse.json({ success: false, error: "organizationId and rawContent are required" }, { status: 400 });
    }

    const result = await intake999Acknowledgement({
      organizationId: String(body.organizationId),
      batchId: body.batchId ?? null,
      fileName: body.fileName ?? null,
      rawContent: String(body.rawContent),
    });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("999 acknowledgement API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "999 acknowledgement intake failed" },
      { status: 500 },
    );
  }
}
