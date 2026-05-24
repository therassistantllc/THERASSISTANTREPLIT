/**
 * POST /api/billing/medical-review/upload
 *
 * Multipart upload for the Medical Review detail panel. Stores the file in
 * the `claim-documents` storage bucket and inserts a row into
 * `public.documents` with `claim_id` populated so the "Uploaded documents"
 * tab and the claim hold panel both pick it up. Also writes an audit entry
 * so the Submission history shows the upload.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const BUCKET = "claim-documents";
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file

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
      console.warn("[medical-review.upload] ensure-bucket-error", error.message);
    }
  } catch (err) {
    console.warn("[medical-review.upload] ensure-bucket-exception", err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
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
    const claimId = String(form.get("claimId") || "").trim();
    if (!claimId) {
      return NextResponse.json(
        { success: false, error: "claimId is required" },
        { status: 400 },
      );
    }

    const guard = await requireBillingAccess({
      requestedOrganizationId: String(form.get("organizationId") || "").trim() || null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const userId = guard.userId;

    const documentType = String(form.get("documentType") || "").trim() || null;
    const title = String(form.get("title") || "").trim();
    const notes = String(form.get("notes") || "").trim() || null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };

    // Verify claim exists in the caller's org, and capture patient/encounter.
    const { data: claim, error: claimErr } = await sb
      .from("professional_claims")
      .select("id, patient_id, appointment_id, encounter_id")
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

    const blob = file as Blob & { name?: string };
    if (typeof blob.size === "number" && blob.size > MAX_BYTES) {
      return NextResponse.json(
        { success: false, error: `File exceeds ${Math.round(MAX_BYTES / (1024 * 1024))} MB limit` },
        { status: 413 },
      );
    }
    const originalName = (blob.name && String(blob.name)) || `claim-${Date.now()}`;
    const mimeType = blob.type || "application/octet-stream";
    const safeName = originalName.replace(/[^\w.\-]+/g, "_");
    const storagePath = `${organizationId}/${claimId}/${Date.now()}-${safeName}`;

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

    const now = new Date().toISOString();
    const insertRow: Record<string, unknown> = {
      organization_id: organizationId,
      client_id: (claim.patient_id as string | null) ?? null,
      encounter_id: (claim.encounter_id as string | null) ?? null,
      claim_id: claimId,
      document_scope: "claim",
      document_type: documentType,
      title: title || originalName,
      file_name: originalName,
      storage_bucket: BUCKET,
      storage_path: storagePath,
      mime_type: mimeType,
      file_size_bytes: typeof blob.size === "number" ? blob.size : null,
      uploaded_by_user_id: userId,
      filed_by_user_id: userId,
      filed_at: now,
      notes,
    };

    const { data: inserted, error: insErr } = await sb
      .from("documents")
      .insert(insertRow)
      .select("id, title, file_name, document_type, mime_type, file_size_bytes, notes, filed_at, created_at")
      .single();

    if (insErr || !inserted) {
      // Roll back the storage object so we don't leave orphans.
      await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      return NextResponse.json(
        { success: false, error: insErr?.message ?? "Failed to insert document row" },
        { status: 422 },
      );
    }

    // Best-effort audit (don't roll back the upload if audit fails).
    try {
      await sb.from("audit_logs").insert({
        organization_id: organizationId,
        user_id: userId,
        action: "medical_review_records_attached",
        event_type: "medical_review_workqueue",
        event_summary: `Uploaded ${originalName} to claim`,
        event_metadata: {
          documentId: inserted.id,
          fileName: originalName,
          mimeType,
          sizeBytes: typeof blob.size === "number" ? blob.size : null,
          source: "upload",
        },
        appointment_id: (claim.appointment_id as string | null) ?? null,
        claim_id: claimId,
        patient_id: (claim.patient_id as string | null) ?? null,
        object_type: "professional_claim",
        object_id: claimId,
      });
    } catch (err) {
      console.warn("[medical-review.upload] audit-failed", err);
    }

    return NextResponse.json({
      success: true,
      document: {
        id: String(inserted.id),
        title: String(inserted.title ?? originalName),
        fileName: String(inserted.file_name ?? originalName),
        documentType: (inserted.document_type as string | null) ?? null,
        mimeType: (inserted.mime_type as string | null) ?? mimeType,
        fileSizeBytes: (inserted.file_size_bytes as number | null) ?? null,
        notes: (inserted.notes as string | null) ?? null,
        uploadedAt: (inserted.filed_at as string | null) ?? (inserted.created_at as string | null) ?? now,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 },
    );
  }
}
