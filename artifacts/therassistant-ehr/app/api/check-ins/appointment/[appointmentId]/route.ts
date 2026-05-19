import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type DbRow = Record<string, unknown>;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function checkInDto(row: DbRow | null) {
  if (!row) return null;
  return {
    id: clean(row.id),
    organizationId: clean(row.organization_id),
    clientId: clean(row.client_id),
    appointmentId: clean(row.appointment_id),
    encounterId: clean(row.encounter_id),
    status: clean(row.status),
    currentMood: clean(row.current_mood),
    currentStressors: clean(row.current_stressors),
    safetyConcerns: clean(row.safety_concerns),
    psychosocialUpdates: clean(row.psychosocial_updates),
    selectedGoalIds: Array.isArray(row.selected_goal_ids) ? row.selected_goal_ids : [],
    goalUpdates: row.goal_updates ?? [],
    patientStatement: clean(row.patient_statement),
    submittedAt: clean(row.submitted_at),
    reviewedAt: clean(row.reviewed_at),
  };
}

async function loadAppointment(organizationId: string, appointmentId: string) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("appointments")
    .select("id, organization_id, client_id, provider_id, appointment_type, start_time, end_time")
    .eq("organization_id", organizationId)
    .eq("id", appointmentId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as DbRow | null;
}

export async function GET(request: Request, context: { params: Promise<{ appointmentId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { appointmentId } = await context.params;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";

    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

    const appointment = await loadAppointment(organizationId, appointmentId);
    if (!appointment) return NextResponse.json({ success: false, error: "Appointment not found" }, { status: 404 });

    const { data: checkIn, error } = await supabase
      .from("patient_check_ins")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("appointment_id", appointmentId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });

    return NextResponse.json({ success: true, appointment, checkIn: checkInDto(checkIn as DbRow | null) });
  } catch (error) {
    console.error("Appointment check-in GET error:", error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Check-in load failed" }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ appointmentId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { appointmentId } = await context.params;
    const body = await request.json();
    const organizationId = clean(body.organizationId) || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
    const status = clean(body.status) || "submitted";

    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

    const appointment = await loadAppointment(organizationId, appointmentId);
    if (!appointment) return NextResponse.json({ success: false, error: "Appointment not found" }, { status: 404 });

    const clientId = clean(appointment.client_id);
    if (!clientId) return NextResponse.json({ success: false, error: "Appointment is missing client_id" }, { status: 422 });

    const payload = {
      organization_id: organizationId,
      client_id: clientId,
      appointment_id: appointmentId,
      encounter_id: clean(body.encounterId) || null,
      status,
      current_mood: clean(body.currentMood) || null,
      current_stressors: clean(body.currentStressors) || null,
      safety_concerns: clean(body.safetyConcerns) || null,
      psychosocial_updates: clean(body.psychosocialUpdates) || null,
      selected_goal_ids: Array.isArray(body.selectedGoalIds) ? body.selectedGoalIds.map(clean).filter(Boolean) : [],
      goal_updates: Array.isArray(body.goalUpdates) ? body.goalUpdates : [],
      patient_statement: clean(body.patientStatement) || null,
      submitted_at: status === "submitted" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await supabase
      .from("patient_check_ins")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("appointment_id", appointmentId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const mutation = existing?.id
      ? supabase.from("patient_check_ins").update(payload).eq("id", existing.id).select("*").single()
      : supabase.from("patient_check_ins").insert({ ...payload, created_at: new Date().toISOString() }).select("*").single();

    const { data, error } = await mutation;
    if (error || !data) return NextResponse.json({ success: false, error: error?.message || "Failed to save check-in" }, { status: 422 });

    return NextResponse.json({ success: true, checkIn: checkInDto(data as DbRow) });
  } catch (error) {
    console.error("Appointment check-in POST error:", error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Check-in save failed" }, { status: 500 });
  }
}
