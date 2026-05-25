/**
 * POST   /api/settings/organization/logo  — upload a letterhead logo (JPEG,
 *                                            PNG, WebP, GIF) and persist its
 *                                            storage path on
 *                                            `organization.billing_profile`.
 * DELETE /api/settings/organization/logo  — clear the persisted logo and best-
 *                                            effort remove the storage object.
 *
 * Why we store JPEG: the cover-letter PDF generator embeds images with the
 * `DCTDecode` filter (raw JPEG passthrough). PNG / WebP / GIF uploads are
 * transcoded to JPEG via `sharp` at upload time so the PDF path remains
 * dependency-free and small while still accepting common brand-asset formats
 * (PNG transparency is flattened against white).
 */
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

const ACCEPTED_MIME = /^image\/(jpe?g|png|webp|gif)$/i;

const BUCKET = "organization-assets";
const BILLING_PROFILE_KEY = "organization.billing_profile";
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — letterhead logos are small.

async function ensureBucket(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
): Promise<void> {
  if (!supabase) return;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (buckets && buckets.some((b) => b.name === BUCKET)) return;
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: MAX_BYTES,
    });
    if (error && !/already exists/i.test(error.message)) {
      console.warn(`[org-logo] ensure bucket failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(
      `[org-logo] ensure bucket exception: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function loadBillingProfile(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  organizationId: string,
): Promise<Record<string, unknown>> {
  if (!supabase) return {};
  const { data } = await supabase
    .from("system_settings")
    .select("setting_value")
    .eq("organization_id", organizationId)
    .eq("setting_key", BILLING_PROFILE_KEY)
    .maybeSingle();
  if (
    data?.setting_value &&
    typeof data.setting_value === "object" &&
    !Array.isArray(data.setting_value)
  ) {
    return { ...(data.setting_value as Record<string, unknown>) };
  }
  return {};
}

async function saveBillingProfile(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  organizationId: string,
  profile: Record<string, unknown>,
): Promise<string | null> {
  if (!supabase) return "Database not available";
  const now = new Date().toISOString();
  const { error } = await supabase.from("system_settings").upsert(
    {
      organization_id: organizationId,
      setting_key: BILLING_PROFILE_KEY,
      setting_value: profile,
      updated_at: now,
      created_at: now,
    },
    { onConflict: "organization_id,setting_key" },
  );
  return error ? error.message : null;
}

export async function POST(req: NextRequest) {
  const guard = await requireOrgAccess({
    requestedOrganizationId: req.nextUrl.searchParams.get("organizationId"),
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  const blob = file as Blob & { name?: string };
  if (typeof blob.size === "number" && blob.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Logo exceeds ${Math.round(MAX_BYTES / 1024)} KB limit` },
      { status: 413 },
    );
  }
  const mimeType = blob.type || "";
  if (!ACCEPTED_MIME.test(mimeType)) {
    return NextResponse.json(
      { error: "Logo must be a JPEG, PNG, WebP, or GIF image." },
      { status: 415 },
    );
  }

  await ensureBucket(supabase);

  // Read previous so we can swap the storage object atomically (best-effort
  // cleanup of the old file after the new one is in place).
  const prevProfile = await loadBillingProfile(supabase, organizationId);
  const prevBucket = typeof prevProfile.letterhead_logo_bucket === "string"
    ? (prevProfile.letterhead_logo_bucket as string) : null;
  const prevPath = typeof prevProfile.letterhead_logo_path === "string"
    ? (prevProfile.letterhead_logo_path as string) : null;

  const stamp = Date.now();
  const storagePath = `${organizationId}/letterhead/logo-${stamp}.jpg`;
  const arrayBuffer = await blob.arrayBuffer();
  const inputBytes = new Uint8Array(arrayBuffer);

  // Transcode every upload through sharp. JPEG inputs are re-encoded (cheap
  // and safe — also strips orientation EXIF, fixing rotated-photo logos);
  // PNG / WebP / GIF are flattened against white and emitted as baseline JPEG
  // so the PDF generator's DCTDecode path keeps working unchanged.
  let bytes: Uint8Array;
  try {
    const jpeg = await sharp(inputBytes)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .rotate()
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: false })
      .toBuffer();
    bytes = new Uint8Array(jpeg);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not read image: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 400 },
    );
  }

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, {
      contentType: "image/jpeg",
      upsert: false,
    });
  if (upErr) {
    return NextResponse.json(
      { error: `Storage upload failed: ${upErr.message}` },
      { status: 500 },
    );
  }

  const nextProfile: Record<string, unknown> = {
    ...prevProfile,
    letterhead_logo_bucket: BUCKET,
    letterhead_logo_path: storagePath,
    letterhead_logo_size_bytes: bytes.byteLength,
    letterhead_logo_updated_at: new Date().toISOString(),
  };
  const saveErr = await saveBillingProfile(supabase, organizationId, nextProfile);
  if (saveErr) {
    // Roll back the orphan storage object.
    await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    return NextResponse.json(
      { error: `Failed to persist logo path: ${saveErr}` },
      { status: 500 },
    );
  }

  // Best-effort: delete the prior logo object.
  if (prevBucket && prevPath && prevPath !== storagePath) {
    await supabase.storage.from(prevBucket).remove([prevPath]).catch(() => {});
  }

  return NextResponse.json({
    success: true,
    logo: {
      bucket: BUCKET,
      path: storagePath,
      sizeBytes: bytes.byteLength,
    },
  });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireOrgAccess({
    requestedOrganizationId: req.nextUrl.searchParams.get("organizationId"),
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  const prevProfile = await loadBillingProfile(supabase, organizationId);
  const prevBucket = typeof prevProfile.letterhead_logo_bucket === "string"
    ? (prevProfile.letterhead_logo_bucket as string) : null;
  const prevPath = typeof prevProfile.letterhead_logo_path === "string"
    ? (prevProfile.letterhead_logo_path as string) : null;

  if (!prevPath) {
    return NextResponse.json({ success: true, removed: false });
  }

  const nextProfile = { ...prevProfile };
  delete nextProfile.letterhead_logo_bucket;
  delete nextProfile.letterhead_logo_path;
  delete nextProfile.letterhead_logo_size_bytes;
  delete nextProfile.letterhead_logo_updated_at;

  const saveErr = await saveBillingProfile(supabase, organizationId, nextProfile);
  if (saveErr) {
    return NextResponse.json(
      { error: `Failed to clear logo path: ${saveErr}` },
      { status: 500 },
    );
  }

  if (prevBucket && prevPath) {
    await supabase.storage.from(prevBucket).remove([prevPath]).catch(() => {});
  }

  return NextResponse.json({ success: true, removed: true });
}
