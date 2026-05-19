import { NextRequest, NextResponse } from "next/server";
import { promoteClientImportRows } from "@/lib/imports/clientImportPromotionService";

interface ImportRequest {
  importDuplicates?: boolean;
  allowUpdateExisting?: boolean;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await context.params;
    const body = (await req.json()) as ImportRequest;
    const { importDuplicates = false, allowUpdateExisting = false } = body;

    const summary = await promoteClientImportRows({
      jobId,
      importDuplicates,
      allowUpdateExisting,
    });

    return NextResponse.json({
      ok: true,
      summary,
      failedRows: summary.failedRows.length > 0 ? summary.failedRows : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to import rows";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
