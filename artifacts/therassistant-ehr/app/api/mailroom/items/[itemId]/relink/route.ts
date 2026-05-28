import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

type DbRow = Record<string, unknown>;

type RelinkDestination = "patient_chart" | "claim" | "encounter" | "practice_documents";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function scopeForDestination(destination: RelinkDestination): "encounter" | "claim" | "other" {
  if (destination === "claim") return "claim";
  if (destination === "encounter") return "encounter";
  return "other";
}

export async function PATCH(request: Request, context: { params: Promise<{ itemId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { itemId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      organization_id?: string;
      filing_destination?: RelinkDestination;
      target_id?: string | null;
    };

    const guard = await requireOrgAccess({ requestedOrganizationId: body.organization_id });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const destination = body.filing_destination;
    if (!destination || !["patient_chart", "claim", "encounter", "practice_documents"].includes(destination)) {
      return NextResponse.json({ success: false, error: "Invalid filing_destination" }, { status: 400 });
    }

    const targetId = body.target_id ? clean(body.target_id) : null;
    if (destination !== "practice_documents" && !targetId) {
      return NextResponse.json(
        { success: false, error: "target_id is required for this destination" },
        { status: 400 },
      );
    }

    // Confirm the mailroom item belongs to this org.
    const { data: itemRow, error: itemErr } = await supabase
      .from("mailroom_items")
      .select("id, organization_id, status")
      .eq("organization_id", organizationId)
      .eq("id", itemId)
      .maybeSingle();
    if (itemErr) {
      return NextResponse.json({ success: false, error: itemErr.message }, { status: 422 });
    }
    if (!itemRow) {
      return NextResponse.json({ success: false, error: "Mailroom item not found" }, { status: 404 });
    }

    // Find the most recent filed document for this mailroom item.
    const { data: docRow, error: docErr } = await supabase
      .from("documents")
      .select("id, client_id, encounter_id, claim_id, document_scope")
      .eq("organization_id", organizationId)
      .eq("mailroom_item_id", itemId)
      .order("filed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (docErr) {
      return NextResponse.json({ success: false, error: docErr.message }, { status: 422 });
    }
    if (!docRow) {
      return NextResponse.json(
        { success: false, error: "No filed document exists for this mailroom item yet" },
        { status: 409 },
      );
    }

    const existing = docRow as DbRow;
    const before = {
      client_id: clean(existing.client_id) || null,
      encounter_id: clean(existing.encounter_id) || null,
      claim_id: clean(existing.claim_id) || null,
      document_scope: clean(existing.document_scope) || null,
    };

    // Validate the new target exists in this org before we touch the document row.
    if (destination === "patient_chart") {
      const { data, error } = await supabase
        .from("clients")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("id", targetId!)
        .maybeSingle();
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });
      if (!data) return NextResponse.json({ success: false, error: "Client not found" }, { status: 404 });
    } else if (destination === "encounter") {
      const { data, error } = await supabase
        .from("encounters")
        .select("id, client_id")
        .eq("organization_id", organizationId)
        .eq("id", targetId!)
        .maybeSingle();
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });
      if (!data) return NextResponse.json({ success: false, error: "Encounter not found" }, { status: 404 });
    } else if (destination === "claim") {
      const { data, error } = await supabase
        .from("claims")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("id", targetId!)
        .maybeSingle();
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });
      if (!data) return NextResponse.json({ success: false, error: "Claim not found" }, { status: 404 });
    }

    const update: Record<string, unknown> = {
      client_id: null,
      encounter_id: null,
      claim_id: null,
      document_scope: scopeForDestination(destination),
      updated_at: new Date().toISOString(),
    };
    if (destination === "patient_chart") {
      update.client_id = targetId;
    } else if (destination === "encounter") {
      update.encounter_id = targetId;
    } else if (destination === "claim") {
      update.claim_id = targetId;
    }

    const { error: updateError } = await supabase
      .from("documents")
      .update(update)
      .eq("id", clean(existing.id))
      .eq("organization_id", organizationId);
    if (updateError) {
      return NextResponse.json(
        { success: false, error: `Failed to re-link document: ${updateError.message}` },
        { status: 500 },
      );
    }

    const after = {
      client_id: (update.client_id as string | null) ?? null,
      encounter_id: (update.encounter_id as string | null) ?? null,
      claim_id: (update.claim_id as string | null) ?? null,
      document_scope: update.document_scope as string,
    };

    // Best-effort audit (never fail the re-link if the audit insert errors).
    try {
      await supabase.from("audit_logs").insert({
        organization_id: organizationId,
        user_id: guard.userId,
        action: "mailroom_document_relinked",
        object_type: "document",
        object_id: clean(existing.id),
        event_type: "mailroom_document_relinked",
        event_summary: `Mailroom document re-linked (${destination})`,
        before_value: before,
        after_value: after,
        event_metadata: {
          mailroom_item_id: itemId,
          filing_destination: destination,
        },
        created_at: new Date().toISOString(),
      });
    } catch (auditError) {
      console.warn("mailroom relink audit insert failed:", auditError);
    }

    return NextResponse.json({ success: true, document_id: clean(existing.id) });
  } catch (error) {
    console.error("Mailroom relink API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Mailroom relink failed" },
      { status: 500 },
    );
  }
}
