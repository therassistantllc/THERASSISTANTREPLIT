import { NextResponse } from "next/server";
import { generate837PBatch } from "@/lib/claims/edi837pBatchService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    const result = await generate837PBatch({
      organizationId: String(body.organizationId),
      claimIds: Array.isArray(body.claimIds) ? body.claimIds.map(String) : undefined,
      mode: body.mode === "production" ? "production" : "test",
      fileName: body.fileName ?? null,
    });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("837P batch API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "837P batch generation failed" },
      { status: 500 },
    );
  }
}
