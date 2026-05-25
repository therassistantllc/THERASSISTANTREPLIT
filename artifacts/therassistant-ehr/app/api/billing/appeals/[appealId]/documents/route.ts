/**
 * /api/billing/appeals/[appealId]/documents
 *
 * GET  — list real supporting documents uploaded against an appeal.
 * POST — multipart upload: stores the file in the `claim-appeal-documents`
 *        Supabase storage bucket and inserts a row in
 *        public.claim_appeal_documents so it surfaces in the Attachments
 *        tab with a download link. Also writes a claim_notes entry for
 *        the audit trail.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const BUCKET = "claim-appeal-documents";
const MAX_BYTES = 25 * 1024 * 1024;

const text = (v: unknown) => String(v ?? "").trim();

async function ensureBucket(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
) {
  if (!supabase) return;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (buckets && buckets.some((b) => b.name === BUCKET)) return;
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: MAX_BYTES,
    });
    if (error && !/already exists/i.test(error.message)) {
      console.warn("[appeals.documents] ensure-bucket-error", error.message);
    }
  } catch (err) {
    console.warn(
      "[appeals.documents] ensure-bucket-exception",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function loadAppeal(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  organizationId: string,
  appealId: string,
) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("claim_appeals")
    .select("id, claim_id, organization_id")
    .eq("organization_id", organizationId)
    .eq("id", appealId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as { id: string; claim_id: string; organization_id: string } | null;
}

function shapeDoc(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    appealId: String(row.appeal_id),
    claimId: String(row.claim_id),
    fileName: text(row.file_name) || "document",
    mimeType: text(row.mime_type) || null,
    fileSizeBytes:
      row.file_size_bytes === null || row.file_size_bytes === undefined
        ? null
        : Number(row.file_size_bytes),
    description: text(row.description) || null,
    uploadedByDisplayName: text(row.uploaded_by_display_name) || null,
    uploadedAt: text(row.created_at) || null,
  };
}

async function attachFromChart(
  request: NextRequest,
  supabase: NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>,
  appealId: string,
): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as {
    organizationId?: string | null;
    actorDisplayName?: string | null;
    description?: string | null;
    chartDocumentIds?: unknown;
  };

  const ids = Array.isArray(body.chartDocumentIds)
    ? Array.from(
        new Set(
          body.chartDocumentIds
            .map((v) => text(v))
            .filter((v) => v.length > 0),
        ),
      )
    : [];

  if (ids.length === 0) {
    return NextResponse.json(
      { success: false, error: "chartDocumentIds is required" },
      { status: 400 },
    );
  }

  const guard = await requireBillingAccess({
    requestedOrganizationId: body.organizationId ?? null,
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

  const appeal = await loadAppeal(supabase, organizationId, appealId);
  if (!appeal) {
    return NextResponse.json(
      { success: false, error: "Appeal not found" },
      { status: 404 },
    );
  }

  const { data: claimRow, error: claimErr } = await (supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (a: string, b: string) => {
          eq: (a: string, b: string) => {
            maybeSingle: () => Promise<{
              data: { patient_id: string | null } | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  })
    .from("professional_claims")
    .select("patient_id")
    .eq("id", appeal.claim_id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (claimErr) {
    return NextResponse.json(
      { success: false, error: claimErr.message },
      { status: 422 },
    );
  }
  const claimClientId = (claimRow?.patient_id ?? null) as string | null;

  const { data: docs, error: docsErr } = await supabase
    .from("documents")
    .select(
      "id, client_id, title, file_name, mime_type, file_size_bytes, storage_bucket, storage_path, document_type",
    )
    .eq("organization_id", organizationId)
    .in("id", ids)
    .is("archived_at", null);

  if (docsErr) {
    return NextResponse.json(
      { success: false, error: docsErr.message },
      { status: 422 },
    );
  }

  type ChartDoc = {
    id: string;
    client_id: string | null;
    title: string | null;
    file_name: string | null;
    mime_type: string | null;
    file_size_bytes: number | null;
    storage_bucket: string | null;
    storage_path: string | null;
    document_type: string | null;
  };
  const chartDocs = (docs ?? []) as ChartDoc[];

  if (chartDocs.length === 0) {
    return NextResponse.json(
      { success: false, error: "No matching chart documents found" },
      { status: 404 },
    );
  }

  if (claimClientId) {
    const wrongClient = chartDocs.find(
      (d) => d.client_id && d.client_id !== claimClientId,
    );
    if (wrongClient) {
      return NextResponse.json(
        {
          success: false,
          error: "One or more documents do not belong to this claim's client",
        },
        { status: 403 },
      );
    }
  }

  const description = text(body.description) || null;
  const userId = (guard as { userId?: string | null }).userId ?? null;
  const authorDisplay = text(body.actorDisplayName) || null;

  const rowsToInsert = chartDocs
    .filter((d) => text(d.storage_bucket) && text(d.storage_path))
    .map((d) => ({
      organization_id: organizationId,
      appeal_id: appealId,
      claim_id: appeal.claim_id,
      file_name: text(d.file_name) || text(d.title) || "chart_document",
      mime_type: text(d.mime_type) || "application/octet-stream",
      file_size_bytes: d.file_size_bytes ?? null,
      storage_bucket: text(d.storage_bucket),
      storage_path: text(d.storage_path),
      description:
        description ||
        `Attached from chart${d.document_type ? ` (${d.document_type})` : ""}`,
      uploaded_by_user_id: userId,
      uploaded_by_display_name: authorDisplay,
      source_document_id: d.id,
    }));

  if (rowsToInsert.length === 0) {
    return NextResponse.json(
      { success: false, error: "Selected chart documents have no stored file" },
      { status: 422 },
    );
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("claim_appeal_documents")
    .insert(rowsToInsert)
    .select(
      "id, appeal_id, claim_id, file_name, mime_type, file_size_bytes, description, uploaded_by_display_name, created_at",
    );

  if (insertErr || !inserted) {
    return NextResponse.json(
      { success: false, error: insertErr?.message || "Failed to link chart documents" },
      { status: 422 },
    );
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

  const notes = rowsToInsert.map((r) => ({
    organization_id: organizationId,
    claim_id: appeal.claim_id,
    body: `Attached chart document to appeal: ${r.file_name}${description ? ` — ${description}` : ""}`,
    author_user_id: userId,
    author_display_name: authorDisplay,
  }));
  if (notes.length > 0) {
    await supabase.from("claim_notes").insert(notes);
  }

  return NextResponse.json({
    success: true,
    documents: (inserted as Record<string, unknown>[]).map((r) => shapeDoc(r)),
    attached: rowsToInsert.length,
    attachmentsCount: count ?? 0,
  });
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ appealId: string }> },
) {
  try {
    const { appealId } = await ctx.params;
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
    if (!appealId) {
      return NextResponse.json(
        { success: false, error: "appealId is required" },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from("claim_appeal_documents")
      .select(
        "id, appeal_id, claim_id, file_name, mime_type, file_size_bytes, description, uploaded_by_display_name, created_at",
      )
      .eq("organization_id", organizationId)
      .eq("appeal_id", appealId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 422 },
      );
    }

    const documents = (data ?? []).map((r) => shapeDoc(r as Record<string, unknown>));
    return NextResponse.json({ success: true, documents, total: documents.length });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Failed to list documents",
      },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ appealId: string }> },
) {
  try {
    const { appealId } = await ctx.params;
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }
    if (!appealId) {
      return NextResponse.json(
        { success: false, error: "appealId is required" },
        { status: 400 },
      );
    }

    const contentType = (request.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("multipart/form-data")) {
      return await attachFromChart(request, supabase, appealId);
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json(
        { success: false, error: "file is required" },
        { status: 400 },
      );
    }
    const guard = await requireBillingAccess({
      requestedOrganizationId: text(form.get("organizationId")) || null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const appeal = await loadAppeal(supabase, organizationId, appealId);
    if (!appeal) {
      return NextResponse.json(
        { success: false, error: "Appeal not found" },
        { status: 404 },
      );
    }

    const blob = file as Blob & { name?: string };
    const size = blob.size ?? 0;
    if (size <= 0) {
      return NextResponse.json(
        { success: false, error: "Uploaded file is empty" },
        { status: 400 },
      );
    }
    if (size > MAX_BYTES) {
      return NextResponse.json(
        { success: false, error: `File exceeds ${MAX_BYTES / (1024 * 1024)}MB cap` },
        { status: 413 },
      );
    }

    const fileName = (blob.name && String(blob.name)) || `appeal-${Date.now()}`;
    const mimeType = blob.type || "application/octet-stream";
    const description = text(form.get("description")) || null;
    const safeName = fileName.replace(/[^\w.\-]+/g, "_");
    const storagePath = `${organizationId}/${appealId}/${Date.now()}-${safeName}`;

    await ensureBucket(supabase);

    const buffer = new Uint8Array(await blob.arrayBuffer());
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buffer, { contentType: mimeType, upsert: false });
    if (upErr) {
      return NextResponse.json(
        { success: false, error: `Storage upload failed: ${upErr.message}` },
        { status: 500 },
      );
    }

    const userId = (guard as { userId?: string | null }).userId ?? null;
    const authorDisplay = text(form.get("actorDisplayName")) || null;

    const { data: inserted, error: insertErr } = await supabase
      .from("claim_appeal_documents")
      .insert({
        organization_id: organizationId,
        appeal_id: appealId,
        claim_id: appeal.claim_id,
        file_name: fileName,
        mime_type: mimeType,
        file_size_bytes: size,
        storage_bucket: BUCKET,
        storage_path: storagePath,
        description,
        uploaded_by_user_id: userId,
        uploaded_by_display_name: authorDisplay,
      })
      .select(
        "id, appeal_id, claim_id, file_name, mime_type, file_size_bytes, description, uploaded_by_display_name, created_at",
      )
      .single();

    if (insertErr || !inserted) {
      await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      return NextResponse.json(
        { success: false, error: insertErr?.message || "Failed to record document" },
        { status: 422 },
      );
    }

    // Refresh denormalized counter + audit note. Counter is derived from
    // the documents table on read, but keeping the column up to date keeps
    // older read paths honest.
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

    await supabase.from("claim_notes").insert({
      organization_id: organizationId,
      claim_id: appeal.claim_id,
      body: `Uploaded appeal document: ${fileName}${description ? ` — ${description}` : ""}`,
      author_user_id: userId,
      author_display_name: authorDisplay,
    });

    return NextResponse.json({
      success: true,
      document: shapeDoc(inserted as Record<string, unknown>),
      attachmentsCount: count ?? 0,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Upload failed",
      },
      { status: 500 },
    );
  }
}
