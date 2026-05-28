import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
// File: app/api/mailroom/file/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 500 }
      );
    }
    const body = await req.json();
    const {
      mailroom_item_id,
      filing_destination,
      target_id,
      admin_comments,
      organization_id,
    } = body;

    const guard = await requireOrgAccess({
      requestedOrganizationId: organization_id,
    });
    if (guard instanceof NextResponse) return guard;
    const effectiveOrgId = guard.organizationId;

    if (!mailroom_item_id || !filing_destination) {
      return NextResponse.json(
        { error: "Missing required fields: mailroom_item_id, filing_destination" },
        { status: 400 }
      );
    }

    // Destinations that route the document into a specific row (client chart,
    // claim, or encounter) MUST carry a target_id. `practice_documents` is the
    // only destination that legitimately has no target. The UI enforces this
    // via canFileDocument; the API enforces it here so a hand-rolled POST
    // can't sneak a document in without a target FK.
    const targetRequired =
      filing_destination === "patient_chart" ||
      filing_destination === "claim" ||
      filing_destination === "encounter";
    const cleanedTargetId = clean(target_id) || null;
    if (targetRequired && !cleanedTargetId) {
      return NextResponse.json(
        { error: `target_id is required for filing_destination=${filing_destination}` },
        { status: 400 }
      );
    }

    // Get mailroom item, enforcing org ownership
    const { data: mailroomItem, error: mailroomError } = await supabase
      .from("mailroom_items")
      .select("*")
      .eq("id", mailroom_item_id)
      .eq("organization_id", effectiveOrgId)
      .single();

    if (mailroomError || !mailroomItem) {
      return NextResponse.json(
        { error: "Mailroom item not found" },
        { status: 404 }
      );
    }

    // Cross-org target_id guard: the FK target row (client / claim / encounter)
    // must belong to the same organization as the session. Without this an
    // attacker who knows another tenant's UUID could file a document straight
    // into their chart.
    if (targetRequired && cleanedTargetId) {
      const targetTable =
        filing_destination === "patient_chart"
          ? "clients"
          : filing_destination === "claim"
          ? "claims"
          : "encounters";
      const { data: targetRow, error: targetError } = await supabase
        .from(targetTable)
        .select("id")
        .eq("id", cleanedTargetId)
        .eq("organization_id", effectiveOrgId)
        .maybeSingle();
      if (targetError || !targetRow) {
        return NextResponse.json(
          { error: `target_id not found in your organization` },
          { status: 404 }
        );
      }
    }

    const mimeType =
      clean((mailroomItem as Record<string, unknown>).mime_type) || "application/pdf";

    // documents.document_scope check constraint allows: encounter, claim, other
    const scope =
      filing_destination === "claim" ? "claim"
      : filing_destination === "encounter" ? "encounter"
      : "other";

    const fileName = clean((mailroomItem as Record<string, unknown>).file_name) || "mailroom_document";

    // Create document record using actual schema columns
    const documentData: Record<string, unknown> = {
      organization_id: effectiveOrgId,
      mailroom_item_id,
      title: fileName,
      document_scope: scope,
      document_type: clean((mailroomItem as Record<string, unknown>).document_type) || "other",
      file_name: fileName,
      mime_type: mimeType,
      storage_bucket: "mailroom-documents",
      storage_path: clean((mailroomItem as Record<string, unknown>).storage_path) || null,
      uploaded_by_user_id: (mailroomItem as Record<string, unknown>).uploaded_by_user_id || null,
      filed_at: new Date().toISOString(),
      notes: admin_comments || null,
    };

    // Set appropriate FK based on filing destination. By this point the
    // target_id has been validated as required (when applicable) and verified
    // to belong to the session organization, so we can trust cleanedTargetId.
    if (filing_destination === "patient_chart" && cleanedTargetId) {
      documentData.client_id = cleanedTargetId;
    } else if (filing_destination === "claim" && cleanedTargetId) {
      documentData.claim_id = cleanedTargetId;
    } else if (filing_destination === "encounter" && cleanedTargetId) {
      documentData.encounter_id = cleanedTargetId;
    }

    const { data: document, error: documentError } = await supabase
      .from("documents")
      .insert([documentData])
      .select()
      .single();

    if (documentError) {
      return NextResponse.json(
        { error: `Failed to create document: ${documentError.message}` },
        { status: 500 }
      );
    }

    // Update mailroom item status to filed (with org guard)
    const { error: updateError } = await supabase
      .from("mailroom_items")
      .update({
        status: "filed",
        admin_comments: admin_comments ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", mailroom_item_id)
      .eq("organization_id", effectiveOrgId);

    if (updateError) {
      return NextResponse.json(
        { error: `Failed to update mailroom item: ${updateError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      document_id: document.id,
      message: "Document filed successfully",
    });
  } catch (error: unknown) {
    console.error("Mailroom filing error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
