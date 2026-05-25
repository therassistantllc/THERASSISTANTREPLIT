/**
 * POST /api/billing/claims/[claimId]/attach-proof
 *
 * Records proof of timely filing as a structured claim note. Accepts
 * either:
 *   - application/json with { kind, reference, description } — legacy
 *     text-only path (fax #, trace #, etc.).
 *   - multipart/form-data with the same fields plus one or more `files`
 *     entries (PDF / image of the actual receipt or EOB). Uploaded
 *     files are stored in the `claim-proofs` Supabase Storage bucket
 *     under `<organizationId>/claim-proofs/<claimId>/<ts>-<name>` and
 *     their metadata is appended to the claim note body as a JSON
 *     sentinel block so the Timely Filing detail panel can render
 *     downloadable links via /api/billing/claims/[claimId]/proof-files.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const text = (v: unknown) => String(v ?? "").trim();

const BUCKET = "claim-proofs";
const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/tiff",
]);

type StoredFile = {
  name: string;
  mime: string;
  size: number;
  path: string;
};

function logCtx(label: string, ctx: Record<string, unknown>) {
  const parts = Object.entries(ctx)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  console.log(`[claim.attach-proof] ${label} ${parts}`);
}

async function ensureBucket(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
) {
  if (!supabase) return;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (buckets && buckets.some((b) => b.name === BUCKET)) return;
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: MAX_FILE_BYTES,
    });
    if (error && !/already exists/i.test(error.message)) {
      logCtx("ensure-bucket-error", { bucket: BUCKET, err: error.message });
    }
  } catch (err) {
    logCtx("ensure-bucket-exception", {
      bucket: BUCKET,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function safeName(name: string) {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "proof";
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ claimId: string }> },
) {
  try {
    const { claimId } = await ctx.params;
    const contentType = request.headers.get("content-type") || "";

    let bodyOrganizationId: string | null = null;
    let kind = "other";
    let reference = "";
    let description = "";
    let rawFiles: Blob[] = [];

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      bodyOrganizationId = text(form.get("organizationId")) || null;
      kind = text(form.get("kind")) || "other";
      reference = text(form.get("reference"));
      description = text(form.get("description"));
      const entries = form.getAll("files");
      for (const entry of entries) {
        if (entry && typeof entry !== "string") rawFiles.push(entry as Blob);
      }
    } else {
      const json = (await request.json().catch(() => ({}))) as {
        organizationId?: string;
        kind?: string;
        reference?: string;
        description?: string;
      };
      bodyOrganizationId = json.organizationId ?? null;
      kind = text(json.kind) || "other";
      reference = text(json.reference);
      description = text(json.description);
    }

    const guard = await requireBillingAccess({
      requestedOrganizationId: bodyOrganizationId,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    if (rawFiles.length > MAX_FILES) {
      return NextResponse.json(
        { success: false, error: `Attach at most ${MAX_FILES} files at a time` },
        { status: 400 },
      );
    }
    for (const f of rawFiles) {
      if ((f.size ?? 0) > MAX_FILE_BYTES) {
        return NextResponse.json(
          {
            success: false,
            error: `Each file must be ≤ ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`,
          },
          { status: 400 },
        );
      }
      const mime = (f.type || "").toLowerCase();
      if (mime && !ALLOWED_MIME.has(mime)) {
        return NextResponse.json(
          { success: false, error: `Unsupported file type: ${mime}` },
          { status: 400 },
        );
      }
    }

    if (!reference && !description && rawFiles.length === 0) {
      return NextResponse.json(
        { success: false, error: "Provide a reference, description, or file" },
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

    const { data: claim } = await (supabase as any)
      .from("professional_claims")
      .select("id")
      .eq("id", claimId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const stored: StoredFile[] = [];
    if (rawFiles.length > 0) {
      await ensureBucket(supabase);
      for (const f of rawFiles) {
        const blob = f as Blob & { name?: string };
        const originalName = (blob.name && String(blob.name)) || "proof";
        const mime = blob.type || "application/octet-stream";
        const path = `${organizationId}/claim-proofs/${claimId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName(originalName)}`;
        const arrayBuffer = await blob.arrayBuffer();
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, new Uint8Array(arrayBuffer), {
            contentType: mime,
            upsert: false,
          });
        if (upErr) {
          logCtx("upload-failed", {
            organizationId,
            claimId,
            path,
            err: upErr.message,
          });
          // best-effort cleanup of anything already uploaded in this request
          if (stored.length > 0) {
            await supabase.storage
              .from(BUCKET)
              .remove(stored.map((s) => s.path))
              .catch(() => {});
          }
          return NextResponse.json(
            { success: false, error: `Upload failed: ${upErr.message}` },
            { status: 500 },
          );
        }
        stored.push({
          name: originalName,
          mime,
          size: blob.size ?? 0,
          path,
        });
      }
    }

    const lines: Array<string | null> = [
      "[Proof of timely filing]",
      `Kind: ${kind}`,
      reference ? `Reference: ${reference}` : null,
      description ? `Notes: ${description}` : null,
    ];
    if (stored.length > 0) {
      lines.push(`Files: ${JSON.stringify(stored)}`);
    }
    const noteBody = lines.filter(Boolean).join("\n");

    const { error } = await insertClaimNote(supabase as any, {
      organizationId,
      claimId,
      authorUserId: guard.userId ?? null,
      authorDisplayName: "Timely Filing workqueue",
      body: noteBody,
    });
    if (error) {
      if (stored.length > 0) {
        await supabase.storage
          .from(BUCKET)
          .remove(stored.map((s) => s.path))
          .catch(() => {});
      }
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 },
      );
    }

    logCtx("ok", { organizationId, claimId, files: stored.length });
    return NextResponse.json({ success: true, files: stored });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
