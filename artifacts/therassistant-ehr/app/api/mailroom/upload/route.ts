import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";

const BUCKET = "mailroom-documents";

function logCtx(label: string, ctx: Record<string, unknown>) {
  const parts = Object.entries(ctx)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  console.log(`[mailroom.upload] ${label} ${parts}`);
}

/**
 * Ensure the mailroom storage bucket exists (idempotent, best-effort).
 * Service-role can list/create buckets. We ignore "already exists" errors.
 */
async function ensureBucket(supabase: ReturnType<typeof createServerSupabaseAdminClient>) {
  if (!supabase) return;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (buckets && buckets.some((b) => b.name === BUCKET)) return;
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: 25 * 1024 * 1024, // 25 MB cap on individual mailroom files
    });
    if (error && !/already exists/i.test(error.message)) {
      logCtx("ensure-bucket-error", { bucket: BUCKET, err: error.message });
    } else {
      logCtx("ensure-bucket-created", { bucket: BUCKET });
    }
  } catch (err) {
    logCtx("ensure-bucket-exception", {
      bucket: BUCKET,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ success: false, error: "file is required" }, { status: 400 });
    }
    const organizationId = String(form.get("organizationId") || "").trim() || DEFAULT_ORG_ID;
    const clientId = String(form.get("clientId") || "").trim() || null;
    const documentType = String(form.get("documentType") || "").trim() || "other";

    const blob = file as Blob & { name?: string };
    const fileName = (blob.name && String(blob.name)) || `mailroom-${Date.now()}`;
    const mimeType = blob.type || "application/octet-stream";
    const safeName = fileName.replace(/[^\w.\-]+/g, "_");
    const storagePath = `${organizationId}/${Date.now()}-${safeName}`;

    await ensureBucket(supabase);

    logCtx("upload-start", {
      organizationId,
      bucket: BUCKET,
      path: storagePath,
      mime: mimeType,
      size: blob.size ?? 0,
    });

    const arrayBuffer = await blob.arrayBuffer();
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, new Uint8Array(arrayBuffer), { contentType: mimeType, upsert: false });
    if (upErr) {
      logCtx("upload-failed", {
        organizationId,
        bucket: BUCKET,
        path: storagePath,
        err: upErr.message,
      });
      return NextResponse.json(
        { success: false, error: `Storage upload failed: ${upErr.message}`, bucket: BUCKET, attemptedPath: storagePath },
        { status: 500 },
      );
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("mailroom_items")
      .insert({
        organization_id: organizationId,
        client_id: clientId,
        file_name: fileName,
        mime_type: mimeType,
        storage_path: storagePath,
        status: "needs_review",
        document_type: documentType,
        source: "manual_upload",
        notes: "Uploaded via mailroom drop zone.",
        created_at: now,
        updated_at: now,
      })
      .select("id, file_name, mime_type, storage_path, status, document_type, source, client_id, notes, created_at, updated_at")
      .single();

    if (error || !data) {
      await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      logCtx("db-insert-failed", {
        organizationId,
        bucket: BUCKET,
        path: storagePath,
        err: error?.message || "no-data",
      });
      return NextResponse.json(
        { success: false, error: error?.message || "Failed to create mailroom item" },
        { status: 422 },
      );
    }

    logCtx("upload-ok", {
      organizationId,
      bucket: BUCKET,
      path: storagePath,
      itemId: String(data.id),
    });

    return NextResponse.json({
      success: true,
      item: {
        id: String(data.id),
        fileName: String(data.file_name ?? fileName),
        mimeType: String(data.mime_type ?? mimeType),
        storagePath: String(data.storage_path ?? storagePath),
        status: String(data.status ?? "needs_review"),
        documentType: String(data.document_type ?? documentType),
        source: String(data.source ?? "manual_upload"),
        clientId: data.client_id ? String(data.client_id) : null,
        notes: String(data.notes ?? ""),
        createdAt: String(data.created_at ?? now),
      },
    });
  } catch (error) {
    console.error("Mailroom upload error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 },
    );
  }
}
