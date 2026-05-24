/**
 * DELETE /api/billing/claims/[claimId]/documents/[documentId]
 *
 * Soft-archives a claim-linked document so it disappears from the
 * Medical Review "Uploaded documents" list (the underlying storage
 * object is left in place for compliance/history). Writes an audit
 * log entry so the action shows up in the claim's submission history.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ claimId: string; documentId: string }> },
) {
  try {
    const { claimId, documentId } = await ctx.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const userId = guard.userId;

    if (!claimId || !documentId) {
      return NextResponse.json(
        { success: false, error: "claimId and documentId are required" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };

    const { data: doc, error: docErr } = await sb
      .from("documents")
      .select("id, title, file_name, client_id, claim_id, archived_at")
      .eq("id", documentId)
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .maybeSingle();

    if (docErr) {
      return NextResponse.json(
        { success: false, error: docErr.message ?? "Failed to look up document" },
        { status: 500 },
      );
    }
    if (!doc) {
      return NextResponse.json(
        { success: false, error: "Document not found" },
        { status: 404 },
      );
    }
    if (doc.archived_at) {
      return NextResponse.json({ success: true, alreadyArchived: true });
    }

    const now = new Date().toISOString();
    const { error: updErr } = await sb
      .from("documents")
      .update({ archived_at: now, updated_at: now })
      .eq("id", documentId)
      .eq("organization_id", organizationId);

    if (updErr) {
      return NextResponse.json(
        { success: false, error: updErr.message ?? "Failed to archive document" },
        { status: 500 },
      );
    }

    try {
      await sb.from("audit_logs").insert({
        organization_id: organizationId,
        user_id: userId,
        action: "medical_review_document_removed",
        event_type: "medical_review_workqueue",
        event_summary: `Removed document "${doc.title || doc.file_name || "Document"}" from claim`,
        event_metadata: {
          documentId,
          title: doc.title ?? null,
          fileName: doc.file_name ?? null,
        },
        claim_id: claimId,
        patient_id: (doc.client_id as string | null) ?? null,
        object_type: "professional_claim",
        object_id: claimId,
      });
    } catch (err) {
      console.warn("[claim-documents.delete] audit-failed", err);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Failed to remove document",
      },
      { status: 500 },
    );
  }
}
