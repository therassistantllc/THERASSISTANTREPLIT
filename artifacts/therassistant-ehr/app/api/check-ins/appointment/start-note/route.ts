import { NextResponse } from "next/server";
import {
  findOrCreateEncounter,
  findOrCreateNote,
  type EncountersSupabase,
} from "@/lib/encounters/findOrCreate";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  composeCheckInSubjectiveBlock,
  mergeCheckInIntoSubjective,
} from "@/lib/checkIns/welcomeFocus";

type AppointmentRow = {
  id: string;
  organization_id: string;
  client_id: string | null;
  provider_id: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  appointment_status: string | null;
  appointment_type: string | null;
};

const ADVANCEABLE_STATUSES = new Set(["scheduled"]);

type TemplateDefaults = {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
};

const EMPTY_TEMPLATE: TemplateDefaults = { subjective: "", objective: "", assessment: "", plan: "" };

type SupabaseClient = ReturnType<typeof createServerSupabaseAdminClient>;

async function pickTemplateDefaults(
  supabase: NonNullable<SupabaseClient>,
  organizationId: string,
  appointmentType: string | null,
): Promise<TemplateDefaults> {
  // Auto-pick at check-in only considers org-wide templates. Personal
  // templates belong to a clinician and aren't part of the org default flow,
  // so we never want them to silently win the auto-fill at check-in time.
  const { data, error } = await supabase
    .from("note_templates")
    .select("service_type, cpt_code, is_default, default_subjective, default_objective, default_assessment, default_plan")
    .eq("organization_id", organizationId)
    .is("provider_id", null)
    .is("archived_at", null);

  if (error || !Array.isArray(data) || data.length === 0) {
    return EMPTY_TEMPLATE;
  }

  type Row = {
    service_type: string | null;
    cpt_code: string | null;
    is_default: boolean | null;
    default_subjective: string | null;
    default_objective: string | null;
    default_assessment: string | null;
    default_plan: string | null;
  };

  const rows = data as Row[];
  const needle = (appointmentType ?? "").trim().toLowerCase();
  let match: Row | undefined;
  if (needle) {
    match = rows.find(
      (row) =>
        (row.service_type ?? "").trim().toLowerCase() === needle ||
        (row.cpt_code ?? "").trim().toLowerCase() === needle,
    );
  }
  if (!match) match = rows.find((row) => row.is_default === true);
  if (!match) return EMPTY_TEMPLATE;

  return {
    subjective: match.default_subjective ?? "",
    objective: match.default_objective ?? "",
    assessment: match.default_assessment ?? "",
    plan: match.default_plan ?? "",
  };
}

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
      .select("id, organization_id, client_id, provider_id, scheduled_start_at, scheduled_end_at, appointment_status, appointment_type")
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

    // Important: do encounter + note creation BEFORE flipping appointment_status.
    // If either fails, status stays at 'scheduled' so the next click can retry
    // cleanly with no half-checked-in state.
    const encounterResult = await findOrCreateEncounter(
      supabase as unknown as EncountersSupabase,
      organizationId,
      appointmentId,
      appt,
      nowIso,
    );
    if (!encounterResult.ok) {
      return NextResponse.json(
        { success: false, error: encounterResult.error },
        { status: encounterResult.status },
      );
    }

    const templateDefaults = await pickTemplateDefaults(
      supabase,
      organizationId,
      appt.appointment_type,
    );

    // Pull the latest submitted check-in for this appointment so we can
    // pre-populate Subjective with the patient's stated focus + reflection.
    // Only "submitted" check-ins count — drafts shouldn't bleed into the note.
    const { data: checkInRow } = await supabase
      .from("patient_check_ins")
      .select("focus_option, focus_reflection, status")
      .eq("organization_id", organizationId)
      .eq("appointment_id", appointmentId)
      .eq("status", "submitted")
      .is("archived_at", null)
      .order("submitted_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const checkInBlock = checkInRow
      ? composeCheckInSubjectiveBlock({
          focusOption: (checkInRow as { focus_option: string | null }).focus_option,
          focusReflection: (checkInRow as { focus_reflection: string | null }).focus_reflection,
        })
      : "";

    const subjectiveWithCheckIn = mergeCheckInIntoSubjective(
      templateDefaults.subjective,
      checkInBlock,
    );

    const noteResult = await findOrCreateNote(
      supabase as unknown as EncountersSupabase,
      organizationId,
      encounterResult.encounterId,
      encounterResult.clientId,
      encounterResult.providerId,
      nowIso,
      { ...templateDefaults, subjective: subjectiveWithCheckIn },
    );
    if (!noteResult.ok) {
      return NextResponse.json(
        { success: false, error: noteResult.error },
        { status: noteResult.status },
      );
    }

    // Only now advance status (and only from 'scheduled' so we don't regress
    // in_progress / completed / etc.). If this fails after encounter/note are
    // created, the retry just re-uses the existing rows and finishes the flip.
    let appointmentStatus = appt.appointment_status ?? "scheduled";
    if (ADVANCEABLE_STATUSES.has(appointmentStatus)) {
      const { error: statusError } = await supabase
        .from("appointments")
        .update({ appointment_status: "checked_in", updated_at: nowIso })
        .eq("organization_id", organizationId)
        .eq("id", appointmentId)
        .eq("appointment_status", "scheduled");
      if (statusError) {
        return NextResponse.json(
          { success: false, error: `Failed to update appointment status: ${statusError.message}` },
          { status: 500 },
        );
      }
      appointmentStatus = "checked_in";
    }

    return NextResponse.json({
      success: true,
      appointmentId,
      appointmentStatus,
      encounterId: encounterResult.encounterId,
      encounterCreated: encounterResult.created,
      noteId: noteResult.noteId,
      noteCreated: noteResult.created,
      noteUrl: `/encounters/${encounterResult.encounterId}`,
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
