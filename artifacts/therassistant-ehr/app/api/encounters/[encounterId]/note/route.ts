import { NextResponse } from "next/server";
import { captureSignedEncounterCharge } from "@/lib/charges/signedEncounterChargeCaptureService";
import { createClaimDraftFromChargeCapture } from "@/lib/claims/chargeCaptureClaimBridgeService";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type EncounterRow = {
  id: string;
  organization_id: string;
  client_id: string;
  provider_id: string | null;
};

function cleanText(value: unknown) {
  return typeof value === "string" ? value : "";
}

async function loadEncounter(organizationId: string, encounterId: string) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("encounters")
    .select("id, organization_id, client_id, provider_id")
    .eq("organization_id", organizationId)
    .eq("id", encounterId)
    .is("archived_at", null)
    .maybeSingle();

  if (error) throw error;
  return data as EncounterRow | null;
}

export async function POST(request: Request, context: { params: Promise<{ encounterId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { encounterId } = await context.params;
    const body = await request.json();
    const organizationId = body.organizationId ? String(body.organizationId) : "";
    const action = body.action ? String(body.action) : "save";
    const userId = body.userId ? String(body.userId) : null;

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    if (!["save", "sign"].includes(action)) {
      return NextResponse.json({ success: false, error: "action must be save or sign" }, { status: 400 });
    }

    const encounter = await loadEncounter(organizationId, encounterId);
    if (!encounter) {
      return NextResponse.json({ success: false, error: "Encounter not found" }, { status: 404 });
    }

    const now = new Date().toISOString();
    const noteStatus = action === "sign" ? "signed" : "draft";

    const notePayload = {
      organization_id: organizationId,
      encounter_id: encounterId,
      client_id: encounter.client_id,
      provider_id: encounter.provider_id,
      note_status: noteStatus,
      subjective: cleanText(body.subjective),
      interventions: cleanText(body.interventions),
      plan: cleanText(body.plan),
      signed_at: action === "sign" ? now : null,
      signed_by_user_id: action === "sign" ? userId : null,
      updated_at: now,
    };

    const { data: existingNote } = await supabase
      .from("encounter_clinical_notes")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("encounter_id", encounterId)
      .is("archived_at", null)
      .maybeSingle();

    let noteId: string | null = null;
    if (existingNote?.id) {
      const { data: updated, error: updateError } = await supabase
        .from("encounter_clinical_notes")
        .update(notePayload)
        .eq("organization_id", organizationId)
        .eq("id", existingNote.id)
        .select("id")
        .single();

      if (updateError || !updated) throw updateError ?? new Error("Failed to update note");
      noteId = String(updated.id);
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from("encounter_clinical_notes")
        .insert({ ...notePayload, created_at: now })
        .select("id")
        .single();

      if (insertError || !inserted) throw insertError ?? new Error("Failed to create note");
      noteId = String(inserted.id);
    }

    let chargeCapture = null;
    let claimDraft = null;
    if (action === "sign") {
      const { error: encounterUpdateError } = await supabase
        .from("encounters")
        .update({
          encounter_status: "signed",
          required_billing_fields_complete: true,
          updated_at: now,
        })
        .eq("organization_id", organizationId)
        .eq("id", encounterId);

      if (encounterUpdateError) throw encounterUpdateError;
      chargeCapture = await captureSignedEncounterCharge({ organizationId, encounterId });

      if (chargeCapture.chargeId && chargeCapture.status === "ready_for_claim") {
        claimDraft = await createClaimDraftFromChargeCapture({
          organizationId,
          chargeCaptureId: chargeCapture.chargeId,
        });
      }
    } else {
      await supabase
        .from("encounters")
        .update({ encounter_status: "draft", updated_at: now })
        .eq("organization_id", organizationId)
        .eq("id", encounterId);
    }

    return NextResponse.json({ success: true, noteId, encounterId, status: noteStatus, chargeCapture, claimDraft });
  } catch (error) {
    console.error("Encounter note API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Encounter note action failed" },
      { status: 500 },
    );
  }
}
