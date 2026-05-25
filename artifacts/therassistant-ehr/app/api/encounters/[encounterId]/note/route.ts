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

    if (!["save", "sign", "amend"].includes(action)) {
      return NextResponse.json({ success: false, error: "action must be save, sign, or amend" }, { status: 400 });
    }

    const encounter = await loadEncounter(organizationId, encounterId);
    if (!encounter) {
      return NextResponse.json({ success: false, error: "Encounter not found" }, { status: 404 });
    }

    const now = new Date().toISOString();

    // For "amend", preserve the existing signed status + signed_at; we update
    // SOAP fields in-place on the already-signed note. "save" = draft, "sign"
    // = transition to signed.
    let existingSigned: { signed_at: string | null; signed_by_user_id: string | null } | null = null;
    if (action === "amend") {
      const { data: existingForAmend } = await supabase
        .from("encounter_clinical_notes")
        .select("note_status, signed_at, signed_by_user_id")
        .eq("organization_id", organizationId)
        .eq("encounter_id", encounterId)
        .is("archived_at", null)
        .maybeSingle();
      if (!existingForAmend || existingForAmend.note_status !== "signed") {
        return NextResponse.json(
          { success: false, error: "Only signed notes can be amended" },
          { status: 409 },
        );
      }
      existingSigned = {
        signed_at: existingForAmend.signed_at,
        signed_by_user_id: existingForAmend.signed_by_user_id,
      };
    }

    const noteStatus = action === "sign" ? "signed" : action === "amend" ? "signed" : "draft";

    const notePayload = {
      organization_id: organizationId,
      encounter_id: encounterId,
      client_id: encounter.client_id,
      provider_id: encounter.provider_id,
      note_status: noteStatus,
      subjective: cleanText(body.subjective),
      objective: cleanText(body.objective),
      assessment: cleanText(body.assessment),
      plan: cleanText(body.plan),
      // Preserve the original signed_at / signed_by exactly on amend — never
      // overwrite with `now`, even if the existing values are null. Sign sets
      // them; save (draft) clears them.
      signed_at: action === "sign" ? now : action === "amend" ? existingSigned!.signed_at : null,
      signed_by_user_id: action === "sign" ? userId : action === "amend" ? existingSigned!.signed_by_user_id : null,
      updated_at: now,
    };

    const selectExistingNote = () =>
      supabase
        .from("encounter_clinical_notes")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("encounter_id", encounterId)
        .is("archived_at", null)
        .maybeSingle();

    const { data: existingNote } = await selectExistingNote();

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

      if (inserted) {
        noteId = String(inserted.id);
      } else if ((insertError as { code?: string } | null)?.code === "23505") {
        // Race: another concurrent save inserted the note between our SELECT
        // and INSERT. The partial unique index on (organization_id, encounter_id)
        // WHERE archived_at IS NULL rejected the duplicate; re-select and
        // update the winning row instead of throwing.
        const { data: raceRow } = await selectExistingNote();
        if (!raceRow?.id) throw insertError ?? new Error("Failed to create note");
        const { data: updated, error: updateError } = await supabase
          .from("encounter_clinical_notes")
          .update(notePayload)
          .eq("organization_id", organizationId)
          .eq("id", raceRow.id)
          .select("id")
          .single();
        if (updateError || !updated) throw updateError ?? new Error("Failed to update note after race");
        noteId = String(updated.id);
      } else {
        throw insertError ?? new Error("Failed to create note");
      }
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
    } else if (action === "save") {
      await supabase
        .from("encounters")
        .update({ encounter_status: "draft", updated_at: now })
        .eq("organization_id", organizationId)
        .eq("id", encounterId);
    } else if (action === "amend") {
      // Note remains signed; just bump updated_at on the encounter so the
      // chart reflects the amendment time. Do NOT re-run charge capture or
      // create a new claim draft — those were handled at original sign time.
      await supabase
        .from("encounters")
        .update({ updated_at: now })
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
