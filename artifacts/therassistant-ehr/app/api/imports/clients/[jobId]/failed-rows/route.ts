import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (entry == null ? "" : String(entry)))
      .filter((entry) => entry.length > 0);
  }
  return [];
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await context.params;

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
      .select("id, original_file_name, organization_id")
      .eq("id", jobId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: "Import job not found" }, { status: 404 });
    }

    if (job.organization_id && job.organization_id !== organizationId) {
      return NextResponse.json({ error: "Import job not found" }, { status: 404 });
    }

    const { data: rows, error: rowsError } = await supabase
      .from("client_import_rows")
      .select(
        "row_number, raw_data, validation_errors, promotion_error, import_status"
      )
      .eq("import_job_id", jobId)
      .in("import_status", ["invalid", "failed"])
      .order("row_number", { ascending: true });

    if (rowsError) {
      return NextResponse.json(
        { error: "Failed to fetch failed rows" },
        { status: 500 }
      );
    }

    const failedRows = rows ?? [];

    // Collect union of all header keys actually present in raw_data
    const headerSet = new Set<string>();
    for (const row of failedRows) {
      const raw = (row.raw_data ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(raw)) headerSet.add(key);
    }
    const sourceHeaders = Array.from(headerSet);
    const headers = ["row_number", ...sourceHeaders, "errors"];

    const lines: string[] = [];
    lines.push(headers.map(csvEscape).join(","));

    for (const row of failedRows) {
      const raw = (row.raw_data ?? {}) as Record<string, unknown>;
      const errors = asStringArray(row.validation_errors);
      const promotionError =
        typeof row.promotion_error === "string" && row.promotion_error.trim()
          ? row.promotion_error.trim()
          : null;
      if (promotionError && !errors.includes(promotionError)) {
        errors.push(promotionError);
      }
      const errorText = errors.join("; ");

      const cells: string[] = [];
      cells.push(String(row.row_number ?? ""));
      for (const header of sourceHeaders) {
        const value = raw[header];
        cells.push(value == null ? "" : String(value));
      }
      cells.push(errorText);

      lines.push(cells.map(csvEscape).join(","));
    }

    const body = `${lines.join("\n")}\n`;

    const baseName =
      typeof job.original_file_name === "string" && job.original_file_name.trim()
        ? job.original_file_name.replace(/\.[^.]+$/, "")
        : `import-${jobId}`;
    const fileName = `${baseName}-failed-rows.csv`;

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to build failed rows CSV";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
