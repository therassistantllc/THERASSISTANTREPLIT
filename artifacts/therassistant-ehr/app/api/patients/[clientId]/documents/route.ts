import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

export async function GET(request: Request, context: { params: Promise<{ clientId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 500 });

    const { clientId } = await context.params;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId required" }, { status: 400 });

    const { data: documents, error } = await supabase
      .from("documents")
      .select("id, document_scope, document_type, title, file_name, mime_type, file_size_bytes, notes, filed_at, created_at, encounter_id, claim_id, mailroom_item_id, workqueue_item_id, storage_path")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });

    const items = (documents ?? []).map((doc: DbRow) => ({
      id: doc.id as string,
      scope: doc.document_scope as string | null,
      type: doc.document_type as string | null,
      title: doc.title as string | null,
      fileName: doc.file_name as string | null,
      mimeType: doc.mime_type as string | null,
      fileSizeBytes: doc.file_size_bytes as number | null,
      notes: doc.notes as string | null,
      filedAt: doc.filed_at as string | null,
      createdAt: doc.created_at as string | null,
      encounterId: doc.encounter_id as string | null,
      claimId: doc.claim_id as string | null,
      mailroomItemId: doc.mailroom_item_id as string | null,
      workqueueItemId: doc.workqueue_item_id as string | null,
      storagePath: doc.storage_path as string | null,
    }));

    return NextResponse.json({ success: true, documents: items, total: items.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to load documents" },
      { status: 500 },
    );
  }
}
