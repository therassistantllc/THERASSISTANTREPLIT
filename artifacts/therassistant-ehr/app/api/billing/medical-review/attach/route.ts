/**
 * POST /api/billing/medical-review/attach
 *
 * Links existing client-chart documents to a claim by setting
 * `documents.claim_id`. Used by the chart picker in the Medical Review
 * detail panel so billers can attach records already on file (notes,
 * treatment plans, prior auths, etc.) without re-uploading.
 *
 * Validates every document belongs to the same org and (when set) the
 * claim's client before any update lands.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

interface AttachBody {
  organizationId?: string;
  claimId?: string;
  documentIds?: string[];
}

export async function POST(req: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }
    const body = (await req.json()) as AttachBody;
    const guard = await requireBillingAccess({ requestedOrganizationId: body.organizationId });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const userId = guard.userId;

    const claimId = (body.claimId ?? "").trim();
    const documentIds = Array.isArray(body.documentIds)
      ? body.documentIds.map((id) => String(id).trim()).filter(Boolean)
      : [];

    if (!claimId || documentIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "claimId and documentIds are required" },
        { status: 400 },
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };

    const { data: claim, error: claimErr } = await sb
      .from("professional_claims")
      .select("id, patient_id, appointment_id")
      .eq("id", claimId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (claimErr) {
      return NextResponse.json(
        { success: false, error: claimErr.message ?? "Failed to look up claim" },
        { status: 500 },
      );
    }
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found in this organization" },
        { status: 404 },
      );
    }
    const patientId = (claim.patient_id as string | null) ?? null;

    const { data: docs, error: docsErr } = await sb
      .from("documents")
      .select("id, client_id, claim_id, file_name, title")
      .in("id", documentIds)
      .eq("organization_id", organizationId)
      .is("archived_at", null);

    if (docsErr) {
      return NextResponse.json(
        { success: false, error: docsErr.message ?? "Failed to look up documents" },
        { status: 500 },
      );
    }

    type DocRow = { id: string; client_id: string | null; claim_id: string | null; file_name: string | null; title: string | null };
    const found = ((docs as DocRow[] | null) ?? []);
    const allowed = found.filter((d) => {
      if (patientId && d.client_id && d.client_id !== patientId) return false;
      return true;
    });
    if (allowed.length === 0) {
      return NextResponse.json(
        { success: false, error: "No matching documents to attach" },
        { status: 404 },
      );
    }

    const now = new Date().toISOString();
    const { error: updErr } = await sb
      .from("documents")
      .update({ claim_id: claimId, updated_at: now })
      .in("id", allowed.map((d) => d.id))
      .eq("organization_id", organizationId);

    if (updErr) {
      return NextResponse.json(
        { success: false, error: updErr.message ?? "Failed to link documents to claim" },
        { status: 500 },
      );
    }

    try {
      await sb.from("audit_logs").insert({
        organization_id: organizationId,
        user_id: userId,
        action: "medical_review_records_attached",
        event_type: "medical_review_workqueue",
        event_summary: `Attached ${allowed.length} chart document(s) to claim`,
        event_metadata: {
          source: "chart_picker",
          documentIds: allowed.map((d) => d.id),
          fileNames: allowed.map((d) => d.title || d.file_name || "Document"),
        },
        appointment_id: (claim.appointment_id as string | null) ?? null,
        claim_id: claimId,
        patient_id: patientId,
        object_type: "professional_claim",
        object_id: claimId,
      });
    } catch (err) {
      console.warn("[medical-review.attach] audit-failed", err);
    }

    return NextResponse.json({
      success: true,
      attached: allowed.map((d) => ({ id: d.id, title: d.title ?? d.file_name ?? "Document" })),
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Attach failed" },
      { status: 500 },
    );
  }
}
