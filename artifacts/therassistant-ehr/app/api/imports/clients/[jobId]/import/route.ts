import { NextRequest, NextResponse } from "next/server";
import { promoteClientImportRows } from "@/lib/imports/clientImportPromotionService";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

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

    const guard = await requireOrgAccess();
    if (guard instanceof NextResponse) return guard;
    const { organizationId } = guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 503 }
      );
    }

    const { data: job, error: jobError } = await supabase
      .from("client_import_jobs")
      .select("id, organization_id")
      .eq("id", jobId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: "Import job not found" }, { status: 404 });
    }

    if (job.organization_id && job.organization_id !== organizationId) {
      return NextResponse.json({ error: "Import job not found" }, { status: 404 });
    }

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
