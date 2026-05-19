import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import { parseClientImportFile } from "@/lib/imports/clientImportParser";
import { proposeClientImportMapping } from "@/lib/imports/clientImportMappingService";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const sourceSystem = String(formData.get("source_system") ?? "unknown").trim() || "unknown";
    const organizationIdRaw = String(formData.get("organization_id") ?? "").trim();
    const organizationId = organizationIdRaw.length > 0 ? organizationIdRaw : null;

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const content = await file.text();
    const parsed = parseClientImportFile({
      fileName: file.name,
      mimeType: file.type,
      content,
    });

    const proposedMapping = proposeClientImportMapping(parsed.headers);

    const supabase = createServerSupabaseAdminClientTyped();
    if (!supabase) {
      return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
    }

    const { data: job, error: jobError } = await supabase
      .from("client_import_jobs")
      .insert({
        organization_id: organizationId,
        source_system: sourceSystem,
        original_file_name: file.name,
        file_type: file.type || "text/csv",
        status: "uploaded",
        total_rows: parsed.totalRows,
        mapping: proposedMapping,
      })
      .select("id")
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: "Failed to create import job" }, { status: 500 });
    }

    const jobId = String(job.id);

    if (parsed.rows.length > 0) {
      const chunkSize = 500;
      for (let index = 0; index < parsed.rows.length; index += chunkSize) {
        const chunk = parsed.rows.slice(index, index + chunkSize).map((row, chunkIndex) => ({
          import_job_id: jobId,
          row_number: index + chunkIndex + 1,
          raw_data: row,
          import_status: "pending",
        }));

        const { error: rowError } = await supabase.from("client_import_rows").insert(chunk);
        if (rowError) {
          await supabase
            .from("client_import_jobs")
            .update({ status: "failed", updated_at: new Date().toISOString() })
            .eq("id", jobId);
          return NextResponse.json({ error: "Failed to stage import rows" }, { status: 500 });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      jobId,
      headers: parsed.headers,
      totalRows: parsed.totalRows,
      proposedMapping,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload import file";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
