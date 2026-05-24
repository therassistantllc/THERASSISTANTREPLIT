/**
 * POST /api/billing/paper-checks/[id]/upload
 *
 * Multipart upload for paper check artifacts. Accepts a PDF/PNG/JPG file and a
 * `kind` of 'eob' or 'scan', stores the file in the `paper-checks` Supabase
 * Storage bucket, then updates the corresponding column on `paper_checks`
 * (`paper_eob_url` for kind=eob, `scanned_check_url` for kind=scan) with the
 * storage path. Writes a `paper_check_events` audit row so the upload shows up
 * in the activity timeline, matching the JSON `upload_eob` action.
 *
 * The column type stays `text` (see migration 20260608000000) — we just store
 * a storage path instead of an arbitrary URL. The companion `file` route
 * detects whether the stored value is a legacy http(s) URL or a bucket path
 * and serves the right thing.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const BUCKET = "paper-checks";
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

async function ensureBucket(supabase: ReturnType<typeof createServerSupabaseAdminClient>) {
  if (!supabase) return;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (buckets && buckets.some((b) => b.name === BUCKET)) return;
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: MAX_BYTES,
    });
    if (error && !/already exists/i.test(error.message)) {
      console.warn("[paper-checks.upload] ensure-bucket-error", error.message);
    }
  } catch (err) {
    console.warn("[paper-checks.upload] ensure-bucket-exception", err);
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }
    const { id: checkId } = await ctx.params;
    if (!checkId) {
      return NextResponse.json(
        { success: false, error: "Missing check id" },
        { status: 400 },
      );
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json(
        { success: false, error: "file is required" },
        { status: 400 },
      );
    }
    const kindRaw = String(form.get("kind") || "").trim().toLowerCase();
    const kind: "eob" | "scan" =
      kindRaw === "scan" || kindRaw === "scanned_check" ? "scan" : "eob";
    const guard = await requireBillingAccess({
      requestedOrganizationId:
        String(form.get("organizationId") || "").trim() || null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    // Confirm the check belongs to this org.
    const { data: existing, error: getErr } = await (supabase as any)
      .from("paper_checks")
      .select("id, organization_id, paper_eob_url, scanned_check_url")
      .eq("id", checkId)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .maybeSingle();
    if (getErr) throw getErr;
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Paper check not found" },
        { status: 404 },
      );
    }

    const blob = file as Blob & { name?: string };
    if (typeof blob.size === "number" && blob.size > MAX_BYTES) {
      return NextResponse.json(
        {
          success: false,
          error: `File exceeds ${Math.round(MAX_BYTES / (1024 * 1024))} MB limit`,
        },
        { status: 413 },
      );
    }
    const mimeType = blob.type || "application/octet-stream";
    if (!ALLOWED_MIMES.has(mimeType.toLowerCase())) {
      return NextResponse.json(
        {
          success: false,
          error: `Unsupported file type: ${mimeType}. Use PDF, PNG, or JPG.`,
        },
        { status: 415 },
      );
    }
    const originalName =
      (blob.name && String(blob.name)) || `paper-check-${kind}-${Date.now()}`;
    const safeName = originalName.replace(/[^\w.\-]+/g, "_");
    const storagePath = `${organizationId}/${checkId}/${kind}-${Date.now()}-${safeName}`;

    await ensureBucket(supabase);

    const arrayBuffer = await blob.arrayBuffer();
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, new Uint8Array(arrayBuffer), {
        contentType: mimeType,
        upsert: false,
      });
    if (upErr) {
      return NextResponse.json(
        {
          success: false,
          error: `Storage upload failed: ${upErr.message}`,
          bucket: BUCKET,
          attemptedPath: storagePath,
        },
        { status: 500 },
      );
    }

    const column = kind === "scan" ? "scanned_check_url" : "paper_eob_url";
    const patch: Record<string, unknown> = {
      [column]: storagePath,
      updated_at: new Date().toISOString(),
    };
    const { error: updErr } = await (supabase as any)
      .from("paper_checks")
      .update(patch)
      .eq("id", checkId)
      .eq("organization_id", organizationId);
    if (updErr) {
      // Roll back the storage object so we don't leave orphans.
      await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      throw updErr;
    }

    await (supabase as any).from("paper_check_events").insert({
      organization_id: organizationId,
      paper_check_id: checkId,
      event_type: "upload_eob",
      message:
        kind === "scan" ? "Scanned check uploaded" : "Paper EOB uploaded",
      actor_user_id: guard.userId,
      payload: {
        kind,
        storage_path: storagePath,
        bucket: BUCKET,
        file_name: originalName,
        mime_type: mimeType,
        size_bytes: typeof blob.size === "number" ? blob.size : null,
      },
    });

    return NextResponse.json({
      success: true,
      kind,
      bucket: BUCKET,
      column,
      storage_path: storagePath,
      file_name: originalName,
      mime_type: mimeType,
    });
  } catch (error) {
    console.error("Paper checks upload error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Upload failed",
      },
      { status: 500 },
    );
  }
}
