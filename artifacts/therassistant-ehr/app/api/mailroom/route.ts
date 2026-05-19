import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function value(input: unknown) {
  return String(input ?? "").trim();
}

function auditEntry(action: string, message: string) {
  return { action, message, at: new Date().toISOString() };
}

function clientName(client: Row | undefined) {
  if (!client) return null;
  return [client.first_name, client.last_name].map(value).filter(Boolean).join(" ") || null;
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    const status = value(searchParams.get("status"));
    const clientId = value(searchParams.get("clientId"));

    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

    let query = supabase
      .from("mailroom_items")
      .select("id, client_id, mail_status, priority, document_type, title, sender_name, payer_name, received_date, notes, file_name, file_mime_type, file_size_bytes, storage_bucket, storage_path, filed_location, filed_at, resolved_at, handling_audit, created_at, updated_at")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(150);

    if (status && status !== "all") query = query.eq("mail_status", status);
    if (clientId) query = query.eq("client_id", clientId);

    const { data: items, error } = await query;
    if (error) throw error;

    const clientIds = [...new Set(((items ?? []) as Row[]).map((item) => value(item.client_id)).filter(Boolean))];
    const { data: clients } = clientIds.length
      ? await supabase.from("clients").select("id, first_name, last_name, date_of_birth").in("id", clientIds)
      : { data: [] as Row[] };

    const clientById = new Map<string, Row>(((clients ?? []) as Row[]).map((client) => [value(client.id), client]));

    const normalized = ((items ?? []) as Row[]).map((item) => {
      const client = clientById.get(value(item.client_id));
      return {
        id: value(item.id),
        clientId: item.client_id ?? null,
        clientName: clientName(client),
        clientDateOfBirth: client?.date_of_birth ?? null,
        status: item.mail_status,
        priority: item.priority,
        documentType: item.document_type,
        title: item.title,
        senderName: item.sender_name,
        payerName: item.payer_name,
        receivedDate: item.received_date,
        notes: item.notes,
        fileName: item.file_name,
        fileMimeType: item.file_mime_type,
        fileSizeBytes: item.file_size_bytes,
        storageBucket: item.storage_bucket,
        storagePath: item.storage_path,
        filedLocation: item.filed_location,
        filedAt: item.filed_at,
        resolvedAt: item.resolved_at,
        handlingAudit: Array.isArray(item.handling_audit) ? item.handling_audit : [],
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      };
    });

    return NextResponse.json({
      success: true,
      organizationId,
      metrics: {
        total: normalized.length,
        unsorted: normalized.filter((item) => item.status === "unsorted").length,
        pendingAction: normalized.filter((item) => item.status === "pending_action").length,
        filed: normalized.filter((item) => item.status === "filed").length,
        archived: normalized.filter((item) => item.status === "archived").length,
      },
      items: normalized,
    });
  } catch (error) {
    console.error("Mailroom GET error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Mailroom API failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const body = await request.json();
    const organizationId = value(body.organizationId);
    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

    const now = new Date().toISOString();
    const title = value(body.title) || "Uploaded mail item";

    const { data, error } = await supabase
      .from("mailroom_items")
      .insert({
        organization_id: organizationId,
        client_id: value(body.clientId) || null,
        mail_status: value(body.status) || "unsorted",
        priority: value(body.priority) || "normal",
        document_type: value(body.documentType) || "payer_notice",
        title,
        sender_name: value(body.senderName) || null,
        payer_name: value(body.payerName) || null,
        received_date: value(body.receivedDate) || new Date().toISOString().slice(0, 10),
        notes: value(body.notes) || null,
        file_name: value(body.fileName) || null,
        file_mime_type: value(body.fileMimeType) || null,
        file_size_bytes: Number(body.fileSizeBytes ?? 0) || null,
        storage_bucket: value(body.storageBucket) || null,
        storage_path: value(body.storagePath) || null,
        handling_audit: [auditEntry("created", "Mailroom item created")],
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();

    if (error || !data) return NextResponse.json({ success: false, error: error?.message ?? "Failed to create mailroom item" }, { status: 422 });

    return NextResponse.json({ success: true, id: data.id });
  } catch (error) {
    console.error("Mailroom POST error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Mailroom create failed" },
      { status: 500 },
    );
  }
}
