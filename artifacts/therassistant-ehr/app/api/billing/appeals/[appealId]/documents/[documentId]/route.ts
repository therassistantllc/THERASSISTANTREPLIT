/**
 * DELETE /api/billing/appeals/[appealId]/documents/[documentId]
 *
 * Removes a supporting document from an appeal: drops the row, deletes
 * the underlying object, refreshes the denormalized attachments_count,
 * and writes an audit note on the claim timeline.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const text = (v: unknown) => String(v ?? "").trim();

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ appealId: string; documentId: string }> },
) {
  try {
    const { appealId, documentId } = await ctx.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }
    if (!appealId || !documentId) {
      return NextResponse.json(
        { success: false, error: "appealId and documentId are required" },
        { status: 400 },
      );
    }

    const { data: doc, error: docErr } = await supabase
      .from("claim_appeal_documents")
      .select("id, claim_id, file_name, storage_bucket, storage_path, source_document_id")
      .eq("organization_id", organizationId)
      .eq("appeal_id", appealId)
      .eq("id", documentId)
      .maybeSingle();
    if (docErr) {
      return NextResponse.json(
        { success: false, error: docErr.message },
        { status: 422 },
      );
    }
    if (!doc) {
      return NextResponse.json(
        { success: false, error: "Document not found" },
        { status: 404 },
      );
    }

    const bucket = text((doc as { storage_bucket?: string }).storage_bucket);
    const path = text((doc as { storage_path?: string }).storage_path);
    const isChartLink = Boolean(
      (doc as { source_document_id?: string | null }).source_document_id,
    );

    const { error: delRowErr } = await supabase
      .from("claim_appeal_documents")
      .delete()
      .eq("organization_id", organizationId)
      .eq("appeal_id", appealId)
      .eq("id", documentId);
    if (delRowErr) {
      return NextResponse.json(
        { success: false, error: delRowErr.message },
        { status: 422 },
      );
    }

    if (bucket && path && !isChartLink) {
      await supabase.storage.from(bucket).remove([path]).catch(() => {});
    }

    const { count } = await supabase
      .from("claim_appeal_documents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("appeal_id", appealId);

    const now = new Date().toISOString();
    await supabase
      .from("claim_appeals")
      .update({ attachments_count: count ?? 0, updated_at: now })
      .eq("organization_id", organizationId)
      .eq("id", appealId);

    const userId = (guard as { userId?: string | null }).userId ?? null;
    await supabase.from("claim_notes").insert({
      organization_id: organizationId,
      claim_id: (doc as { claim_id: string }).claim_id,
      body: `Removed appeal document: ${text((doc as { file_name?: string }).file_name) || "document"}`,
      author_user_id: userId,
      author_display_name: null,
    });

    return NextResponse.json({ success: true, attachmentsCount: count ?? 0 });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Delete failed",
      },
      { status: 500 },
    );
  }
}
