import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

type SaveCodingReportBody = {
  organizationId?: string;
  report?: {
    id?: string;
    date?: string;
    codes?: string;
    auditSummary?: string;
    formSummary?: string;
    [key: string]: unknown;
  };
};

function safeToken(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function parseCodes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((token) => token.trim().toUpperCase())
        .filter((token) => token.length > 0),
    ),
  );
}

export async function POST(request: Request, context: { params: Promise<{ encounterId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const body = (await request.json().catch(() => ({}))) as SaveCodingReportBody;
    const guard = await requireOrgAccess({ requestedOrganizationId: body.organizationId ?? null });
    if (guard instanceof NextResponse) return guard;

    const organizationId = guard.organizationId;
    const { encounterId } = await context.params;

    const report = body.report;
    if (!report || typeof report !== "object") {
      return NextResponse.json({ success: false, error: "report is required" }, { status: 400 });
    }

    const { data: encounter, error: encounterError } = await supabase
      .from("encounters")
      .select("id, client_id")
      .eq("organization_id", organizationId)
      .eq("id", encounterId)
      .maybeSingle();

    if (encounterError) {
      return NextResponse.json({ success: false, error: encounterError.message }, { status: 422 });
    }
    if (!encounter) {
      return NextResponse.json({ success: false, error: "Encounter not found" }, { status: 404 });
    }
    const clientId = (encounter as { client_id: string | null }).client_id;
    if (!clientId) {
      return NextResponse.json({ success: false, error: "Encounter is missing client linkage" }, { status: 422 });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const dateToken = now.toISOString().slice(0, 10);
    const reportToken = safeToken(typeof report.id === "string" ? report.id : "coding-report");
    const fileName = `coding-report-${dateToken}-${reportToken || "report"}.json`;
    const storagePath = `encounters/${encounterId}/coding-reports/${Date.now()}-${fileName}`;

    const serialized = JSON.stringify(
      {
        savedAt: nowIso,
        encounterId,
        organizationId,
        report,
      },
      null,
      2,
    );

    const reportId = typeof report.id === "string" && report.id.trim().length > 0
      ? report.id.trim()
      : `coding-report-${Date.now()}`;
    const suggestedCodes = parseCodes(report.codes);
    const auditSummary = typeof report.auditSummary === "string" ? report.auditSummary.trim() : "";
    const formSummary = typeof report.formSummary === "string" ? report.formSummary.trim() : "";

    const codingSupportBlock = [
      "",
      `Coding Support Report (${dateToken})`,
      `Report ID: ${reportId}`,
      suggestedCodes.length > 0 ? `Suggested codes: ${suggestedCodes.join(", ")}` : "Suggested codes: none",
      auditSummary ? `Audit summary: ${auditSummary}` : "",
      formSummary ? `Session summary:\n${formSummary}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { data: existingNote, error: noteReadError } = await supabase
      .from("encounter_clinical_notes")
      .select("id, plan, suggested_codes")
      .eq("organization_id", organizationId)
      .eq("encounter_id", encounterId)
      .is("archived_at", null)
      .maybeSingle();

    if (noteReadError) {
      return NextResponse.json({ success: false, error: noteReadError.message }, { status: 422 });
    }

    if (existingNote) {
      const previousPlan = existingNote.plan ?? "";
      const nextPlan = previousPlan.includes(`Report ID: ${reportId}`)
        ? previousPlan
        : `${previousPlan.trimEnd()}${codingSupportBlock}`;

      const mergedCodes = Array.from(
        new Set([...(existingNote.suggested_codes ?? []), ...suggestedCodes]),
      );

      const { error: noteUpdateError } = await supabase
        .from("encounter_clinical_notes")
        .update({
          plan: nextPlan,
          suggested_codes: mergedCodes,
          updated_at: nowIso,
        })
        .eq("id", existingNote.id)
        .eq("organization_id", organizationId);

      if (noteUpdateError) {
        return NextResponse.json({ success: false, error: noteUpdateError.message }, { status: 422 });
      }
    } else {
      const { error: noteInsertError } = await supabase
        .from("encounter_clinical_notes")
        .insert({
          organization_id: organizationId,
          encounter_id: encounterId,
          client_id: clientId,
          note_status: "draft",
          plan: codingSupportBlock.trim(),
          suggested_codes: suggestedCodes,
          updated_at: nowIso,
        });

      if (noteInsertError) {
        return NextResponse.json({ success: false, error: noteInsertError.message }, { status: 422 });
      }
    }

    const { error: uploadError } = await supabase.storage
      .from("mailroom-documents")
      .upload(storagePath, serialized, {
        contentType: "application/json",
        upsert: false,
      });

    if (uploadError) {
      return NextResponse.json({ success: false, error: uploadError.message }, { status: 422 });
    }

    const title = `Coding Report ${dateToken}`;
    const summary = auditSummary ? auditSummary.slice(0, 1500) : null;

    const fileSizeBytes = new TextEncoder().encode(serialized).length;

    const { data: inserted, error: insertError } = await supabase
      .from("documents")
      .insert({
        organization_id: organizationId,
        encounter_id: encounterId,
        client_id: clientId,
        document_scope: "encounter",
        document_type: "coding_report",
        title,
        file_name: fileName,
        mime_type: "application/json",
        storage_bucket: "mailroom-documents",
        storage_path: storagePath,
        file_size_bytes: fileSizeBytes,
        notes: summary,
        filed_at: nowIso,
        uploaded_by_user_id: (guard as { userId?: string | null }).userId ?? null,
      })
      .select("id, title")
      .single();

    if (insertError) {
      return NextResponse.json({ success: false, error: insertError.message }, { status: 422 });
    }

    return NextResponse.json({
      success: true,
      documentId: inserted.id,
      title: inserted.title,
      noteUpdated: true,
      suggestedCodes,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to save coding report" },
      { status: 500 },
    );
  }
}
