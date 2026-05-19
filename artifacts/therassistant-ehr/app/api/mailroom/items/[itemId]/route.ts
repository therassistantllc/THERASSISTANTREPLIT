import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type DbRow = Record<string, unknown>;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function itemDto(row: DbRow) {
  return {
    id: clean(row.id),
    organizationId: clean(row.organization_id),
    clientId: clean(row.client_id),
    fileName: clean(row.file_name),
    mimeType: clean(row.mime_type),
    storagePath: clean(row.storage_path),
    status: clean(row.status),
    documentType: clean(row.document_type),
    source: clean(row.source),
    notes: clean(row.notes),
    adminComments: clean(row.admin_comments),
    uploadedByUserId: clean(row.uploaded_by_user_id),
    createdAt: clean(row.created_at),
    updatedAt: clean(row.updated_at),
  };
}

export async function GET(request: Request, context: { params: Promise<{ itemId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { itemId } = await context.params;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";

    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

    const { data, error } = await supabase
      .from("mailroom_items")
      .select("id, organization_id, client_id, file_name, mime_type, storage_path, status, document_type, source, notes, admin_comments, uploaded_by_user_id, created_at, updated_at")
      .eq("organization_id", organizationId)
      .eq("id", itemId)
      .maybeSingle();

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });
    if (!data) return NextResponse.json({ success: false, error: "Mailroom item not found" }, { status: 404 });

    return NextResponse.json({ success: true, item: itemDto(data as DbRow) });
  } catch (error) {
    console.error("Mailroom item detail API error:", error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Mailroom item detail failed" }, { status: 500 });
  }
}
