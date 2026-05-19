import { NextResponse } from "next/server";
import {
  mark837PBatchSubmitted,
  mark837PBatchSubmissionFailed,
} from "@/lib/claims/edi837pSubmissionService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId || !body.batchId) {
      return NextResponse.json({ success: false, error: "organizationId and batchId are required" }, { status: 400 });
    }

    const result = body.status === "failed"
      ? await mark837PBatchSubmissionFailed({
          organizationId: String(body.organizationId),
          batchId: String(body.batchId),
          reason: String(body.reason ?? "837P submission failed"),
        })
      : await mark837PBatchSubmitted({
          organizationId: String(body.organizationId),
          batchId: String(body.batchId),
          officeAllyFileId: body.officeAllyFileId ?? null,
          submittedAt: body.submittedAt ?? null,
        });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("837P submission API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "837P submission tracking failed" },
      { status: 500 },
    );
  }
}
