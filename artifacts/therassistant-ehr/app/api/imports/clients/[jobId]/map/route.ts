import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient as createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  applyClientImportMapping,
  CLIENT_IMPORT_CANONICAL_FIELDS,
  type ClientImportMapping,
} from "@/lib/imports/clientImportMappingService";
import { validateClientImportRows } from "@/lib/imports/clientImportValidationService";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

interface MapRequest {
  mapping: Record<string, string | null>;
}

type ImportRow = {
  id: string;
  row_number: number;
  raw_data: Record<string, unknown> | null;
};

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await context.params;
    const body = (await req.json()) as MapRequest;
    const { mapping } = body;

    if (!mapping || typeof mapping !== "object") {
      return NextResponse.json(
        { error: "mapping is required and must be an object" },
        { status: 400 }
      );
    }

    const guard = await requireOrgAccess();
    if (guard instanceof NextResponse) return guard;
    const { organizationId: sessionOrgId } = guard;

    const normalizedMapping = Object.fromEntries(
      CLIENT_IMPORT_CANONICAL_FIELDS.map((field) => {
        const rawValue = mapping[field];
        const value = typeof rawValue === "string" && rawValue.trim() ? rawValue : null;
        return [field, value];
      })
    ) as ClientImportMapping;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 503 }
      );
    }

    // Verify job exists and get current rows
    const { data: job, error: jobError } = await supabase
      .from("client_import_jobs")
      .select("id, status, organization_id, source_system")
      .eq("id", jobId)
      .single();

    if (jobError || !job) {
      return NextResponse.json(
        { error: "Import job not found" },
        { status: 404 }
      );
    }

    if (
      typeof job.organization_id === "string" &&
      job.organization_id &&
      job.organization_id !== sessionOrgId
    ) {
      return NextResponse.json(
        { error: "Import job not found" },
        { status: 404 }
      );
    }

    // Fetch all rows for this job
    const { data: rows, error: rowsError } = await supabase
      .from("client_import_rows")
      .select("id, row_number, raw_data")
      .eq("import_job_id", jobId)
      .order("row_number", { ascending: true });

    if (rowsError || !rows) {
      return NextResponse.json(
        { error: "Failed to fetch import rows" },
        { status: 500 }
      );
    }

    const typedRows = rows as unknown as ImportRow[];

    // Apply mapping to all rows
    const mappedRows = typedRows.map((row) => {
      const rawData = (row.raw_data ?? {}) as Record<string, unknown>;
      const mapped = applyClientImportMapping(rawData, normalizedMapping);
      return {
        id: row.id,
        mapped_data: mapped,
      };
    });

    // Validate all rows
    const validatedRows = await validateClientImportRows(
      typedRows.map((row) => ({
        id: row.id,
        row_number: row.row_number,
        mapped_data: mappedRows.find((m) => m.id === row.id)?.mapped_data ?? null,
      })),
      {
        organizationId:
          typeof job.organization_id === "string" && job.organization_id.trim()
            ? job.organization_id
            : null,
        sourceSystem:
          typeof job.source_system === "string" && job.source_system.trim()
            ? job.source_system
            : "unknown",
      }
    );

    // Prepare bulk update data
    const updateData = validatedRows.map((validated) => ({
      id: validated.id,
      mapped_data: validated.mappedData,
      validation_errors: validated.errors.length > 0 ? validated.errors : null,
      validation_warnings: validated.warnings.length > 0 ? validated.warnings : null,
      source_client_id: validated.sourceClientId,
      duplicate_match_client_id: validated.duplicateMatchClientId,
      duplicate_reason: validated.duplicateReason,
      duplicate_strategy: validated.duplicateStrategy,
      import_status: validated.importStatus,
      updated_at: new Date().toISOString(),
    }));

    // Update all rows with mapped and validated data
    for (const update of updateData) {
      const { error: updateError } = await supabase
        .from("client_import_rows")
        .update({
          mapped_data: update.mapped_data,
          validation_errors: update.validation_errors,
          validation_warnings: update.validation_warnings,
          source_client_id: update.source_client_id,
          duplicate_match_client_id: update.duplicate_match_client_id,
          duplicate_reason: update.duplicate_reason,
          duplicate_strategy: update.duplicate_strategy,
          import_status: update.import_status,
          updated_at: update.updated_at,
        })
        .eq("id", update.id);

      if (updateError) {
        await supabase
          .from("client_import_jobs")
          .update({
            status: "failed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        return NextResponse.json(
          { error: "Failed to update import rows" },
          { status: 500 }
        );
      }
    }

    // Calculate validation summary
    const validCount = validatedRows.filter((r) => r.importStatus === "valid")
      .length;
    const invalidCount = validatedRows.filter((r) => r.importStatus === "invalid")
      .length;
    const duplicateCount = validatedRows.filter(
      (r) => r.importStatus === "duplicate"
    ).length;

    const validationSummary = {
      totalRows: validatedRows.length,
      validRows: validCount,
      invalidRows: invalidCount,
      duplicateRows: duplicateCount,
      validatedAt: new Date().toISOString(),
    };

    // Update job status to validated
    const { error: updateJobError } = await supabase
      .from("client_import_jobs")
      .update({
        status: "validated",
        valid_rows: validCount,
        invalid_rows: invalidCount,
        duplicate_rows: duplicateCount,
        validation_summary: validationSummary,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    if (updateJobError) {
      return NextResponse.json(
        { error: "Failed to update job status" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      validationSummary,
      rowValidations: validatedRows.map((r) => ({
        rowNumber: r.rowNumber,
        importStatus: r.importStatus,
        errors: r.errors,
        warnings: r.warnings,
        sourceClientId: r.sourceClientId,
        isDuplicate: !!r.duplicateMatchClientId,
        duplicateReason: r.duplicateReason,
        duplicateStrategy: r.duplicateStrategy,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to map and validate rows";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
