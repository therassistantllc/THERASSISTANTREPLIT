import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requirePermissionInRoute } from "@/lib/rbac/middleware";
import { PERMISSIONS } from "@/lib/rbac/constants";

type Row = Record<string, unknown>;

function value(input: unknown) {
  return String(input ?? "").trim();
}

export async function GET(request: Request) {
  try {
    const auth = await requirePermissionInRoute(PERMISSIONS.VIEW_PATIENT_CHART);
    if (auth instanceof NextResponse) return auth;
    const { organizationId } = auth;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const clientId = value(searchParams.get("clientId"));
    if (!clientId) {
      return NextResponse.json({ success: false, error: "clientId is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("intake_submissions")
      .select(
        "id, status, demographics, insurance, consents, screeners, signature_name, signature_signed_at, phq9_score, phq9_severity, gad7_score, gad7_severity, submitted_at",
      )
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .order("submitted_at", { ascending: false })
      .limit(10);

    if (error) throw error;

    return NextResponse.json({
      success: true,
      submissions: ((data ?? []) as Row[]).map((row) => ({
        id: value(row.id),
        status: value(row.status),
        demographics: row.demographics ?? {},
        insurance: row.insurance ?? {},
        consents: row.consents ?? {},
        screeners: row.screeners ?? {},
        signatureName: row.signature_name ?? null,
        signatureSignedAt: row.signature_signed_at ?? null,
        phq9Score: row.phq9_score ?? null,
        phq9Severity: row.phq9_severity ?? null,
        gad7Score: row.gad7_score ?? null,
        gad7Severity: row.gad7_severity ?? null,
        submittedAt: row.submitted_at ?? null,
      })),
    });
  } catch (error) {
    console.error("Intake submissions list error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load intake submissions" },
      { status: 500 },
    );
  }
}
