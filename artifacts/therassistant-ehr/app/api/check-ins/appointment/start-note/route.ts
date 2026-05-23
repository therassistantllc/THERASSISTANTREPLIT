import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type AppointmentRow = {
  id: string;
  organization_id: string;
  client_id: string | null;
  provider_id: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  appointment_status: string | null;
};

const ADVANCEABLE_STATUSES = new Set(["scheduled"]);

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const appointmentId = body.appointmentId ? String(body.appointmentId) : "";
    const organizationId = body.organizationId ? String(body.organizationId) : "";

    if (!appointmentId || !organizationId) {
      return NextResponse.json(
        { success: false, error: "appointmentId and organizationId are required" },
        { status: 400 },
      );
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, organization_id, client_id, provider_id, scheduled_start_at, scheduled_end_at, appointment_status")
      .eq("organization_id", organizationId)
      .eq("id", appointmentId)
      .is("archived_at", null)
      .maybeSingle();

    if (appointmentError || !appointment) {
      return NextResponse.json({ success: false, error: "Appointment not found" }, { status: 404 });
    }

    const appt = appointment as AppointmentRow;
    if (!appt.client_id) {
      return NextResponse.json(
        { success: false, error: "Appointment is missing a client; assign a client before checking in." },
        { status: 422 },
      );
    }

    const nowIso = new Date().toISOString();
    let appointmentStatus = appt.appointment_status ?? "scheduled";

    // Mark checked in only if still scheduled — don't regress in_progress / completed.
    if (ADVANCEABLE_STATUSES.has(appointmentStatus)) {
      const { error: statusError } = await supabase
        .from("appointments")
        .update({ appointment_status: "checked_in", updated_at: nowIso })
        .eq("organization_id", organizationId)
        .eq("id", appointmentId);
      if (statusError) {
        return NextResponse.json(
          { success: false, error: `Failed to update appointment status: ${statusError.message}` },
          { status: 500 },
        );
      }
      appointmentStatus = "checked_in";
    }

    // Find-or-create encounter (same logic as /api/encounters/create-from-appointment).
    let encounterId: string | null = null;
    let encounterCreated = false;
    let encounterClientId = appt.client_id;
    let encounterProviderId: string | null = appt.provider_id;

    const { data: existingEncounter, error: existingEncounterError } = await supabase
      .from("encounters")
      .select("id, client_id, provider_id")
      .eq("organization_id", organizationId)
      .eq("appointment_id", appointmentId)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();

    if (existingEncounterError) {
      return NextResponse.json(
        { success: false, error: `Failed to look up encounter: ${existingEncounterError.message}` },
        { status: 500 },
      );
    }

    if (existingEncounter?.id) {
      encounterId = String(existingEncounter.id);
      encounterClientId = (existingEncounter.client_id as string | null) ?? encounterClientId;
      encounterProviderId = (existingEncounter.provider_id as string | null) ?? encounterProviderId;
    } else {
      const serviceDate = appt.scheduled_start_at
        ? new Date(appt.scheduled_start_at).toISOString().slice(0, 10)
        : nowIso.slice(0, 10);

      const { data: newEncounter, error: encounterInsertError } = await supabase
        .from("encounters")
        .insert({
          organization_id: organizationId,
          client_id: appt.client_id,
          provider_id: appt.provider_id,
          appointment_id: appointmentId,
          encounter_status: "draft",
          service_date: serviceDate,
          required_billing_fields_complete: false,
          started_at: appt.scheduled_start_at ?? null,
          ended_at: appt.scheduled_end_at ?? null,
        })
        .select("id")
        .single();

      if (encounterInsertError || !newEncounter) {
        return NextResponse.json(
          {
            success: false,
            error: `Failed to create encounter: ${encounterInsertError?.message ?? "unknown error"}`,
          },
          { status: 422 },
        );
      }
      encounterId = String(newEncounter.id);
      encounterCreated = true;
    }

    // Find-or-create clinical note attached to that encounter.
    let noteId: string | null = null;
    let noteCreated = false;

    const { data: existingNote, error: existingNoteError } = await supabase
      .from("encounter_clinical_notes")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("encounter_id", encounterId)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();

    if (existingNoteError) {
      return NextResponse.json(
        { success: false, error: `Failed to look up clinical note: ${existingNoteError.message}` },
        { status: 500 },
      );
    }

    if (existingNote?.id) {
      noteId = String(existingNote.id);
    } else {
      const { data: newNote, error: noteInsertError } = await supabase
        .from("encounter_clinical_notes")
        .insert({
          organization_id: organizationId,
          encounter_id: encounterId,
          client_id: encounterClientId,
          provider_id: encounterProviderId,
          note_status: "draft",
          subjective: "",
          interventions: "",
          plan: "",
          signed_at: null,
          signed_by_user_id: null,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select("id")
        .single();

      if (noteInsertError || !newNote) {
        return NextResponse.json(
          {
            success: false,
            error: `Failed to create clinical note: ${noteInsertError?.message ?? "unknown error"}`,
          },
          { status: 422 },
        );
      }
      noteId = String(newNote.id);
      noteCreated = true;
    }

    return NextResponse.json({
      success: true,
      appointmentId,
      appointmentStatus,
      encounterId,
      encounterCreated,
      noteId,
      noteCreated,
      noteUrl: `/encounters/${encounterId}`,
    });
  } catch (error) {
    console.error("Check-in start-note API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Check-in failed",
      },
      { status: 500 },
    );
  }
}
