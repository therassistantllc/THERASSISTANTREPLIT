import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await context.params;

    const { searchParams } = new URL(req.url);
    const pageSize = Math.min(parseInt(searchParams.get("pageSize") ?? "50"), 500);
    const pageNumber = Math.max(parseInt(searchParams.get("pageNumber") ?? "1"), 1);
    const includeRawRows = searchParams.get("includeRawRows") === "true";
    const offset = (pageNumber - 1) * pageSize;

    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const { organizationId } = guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 503 }
      );
    }

    // Get job summary
    const { data: job, error: jobError } = await supabase
      .from("client_import_jobs")
      .select(
        "id, organization_id, source_system, original_file_name, status, total_rows, valid_rows, invalid_rows, imported_rows, duplicate_rows, validation_summary, promotion_summary, created_at, updated_at"
      )
      .eq("id", jobId)
      .single();

    if (jobError || !job) {
      return NextResponse.json(
        { error: "Import job not found" },
        { status: 404 }
      );
    }

    if (job.organization_id && job.organization_id !== organizationId) {
      return NextResponse.json(
        { error: "Import job not found" },
        { status: 404 }
      );
    }

    // Get paginated rows
    const { data: rows, error: rowsError, count } = await supabase
      .from("client_import_rows")
      .select(
        "id, row_number, raw_data, mapped_data, validation_errors, validation_warnings, source_client_id, duplicate_match_client_id, duplicate_reason, duplicate_strategy, import_status, imported_client_id, promoted_policy_id, promotion_error",
        { count: "exact" }
      )
      .eq("import_job_id", jobId)
      .order("row_number", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (rowsError) {
      return NextResponse.json(
        { error: "Failed to fetch import rows" },
        { status: 500 }
      );
    }

    const totalRows = count ?? 0;
    const totalPages = Math.ceil(totalRows / pageSize);

    // Map rows to response format, excluding raw PHI by default
    const mappedRows = (rows ?? []).map((row) => {
      const mappedData = (row.mapped_data ?? null) as Record<string, unknown> | null;

      return {
        id: row.id,
        rowNumber: row.row_number,
        importStatus: row.import_status,
        errors: row.validation_errors ?? [],
        warnings: row.validation_warnings ?? [],
          sourceClientId: row.source_client_id ?? null,
        isDuplicate: !!row.duplicate_match_client_id,
          duplicateReason: row.duplicate_reason ?? null,
          duplicateStrategy: row.duplicate_strategy ?? null,
          importedClientId: row.imported_client_id ?? null,
          importedPolicyId: row.promoted_policy_id ?? null,
          promotionError: row.promotion_error ?? null,
          rawData: includeRawRows ? row.raw_data ?? null : undefined,
        mappedValues: mappedData
          ? {
            source_client_id: mappedData.source_client_id ?? null,
              first_name: mappedData.first_name ?? null,
              last_name: mappedData.last_name ?? null,
              email: mappedData.email ?? null,
              phone: mappedData.phone ?? null,
            }
          : null,
      };
    });

    return NextResponse.json({
      ok: true,
      job: {
        id: job.id,
        organizationId: job.organization_id,
        sourceSystem: job.source_system,
        fileName: job.original_file_name,
        status: job.status,
        totalRows: job.total_rows,
        validRows: job.valid_rows,
        invalidRows: job.invalid_rows,
        importedRows: job.imported_rows,
        duplicateRows: job.duplicate_rows,
        validationSummary: job.validation_summary,
        promotionSummary: job.promotion_summary,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      },
      pagination: {
        pageNumber,
        pageSize,
        totalRows,
        totalPages,
      },
      rows: mappedRows,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to retrieve job details";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
