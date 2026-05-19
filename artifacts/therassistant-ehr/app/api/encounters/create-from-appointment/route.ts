import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const body = await request.json();
    const appointmentId = body.appointmentId ? String(body.appointmentId) : "";
    const organizationId = body.organizationId ? String(body.organizationId) : "";

    if (!appointmentId || !organizationId) {
      return NextResponse.json({ success: false, error: "appointmentId and organizationId are required" }, { status: 400 });
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, organization_id, client_id, provider_id, scheduled_start_at, scheduled_end_at")
      .eq("organization_id", organizationId)
      .eq("id", appointmentId)
      .is("archived_at", null)
      .maybeSingle();

    if (appointmentError || !appointment) return NextResponse.json({ success: false, error: "Appointment not found" }, { status: 404 });
    if (!appointment.client_id) return NextResponse.json({ success: false, error: "Appointment is missing client_id" }, { status: 422 });

    const { data: existingEncounter, error: existingError } = await supabase
      .from("encounters")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("appointment_id", appointmentId)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();

    if (existingError) throw existingError;
    if (existingEncounter?.id) {
      return NextResponse.json({ success: true, encounterId: existingEncounter.id, created: false });
    }

    const serviceDate = appointment.scheduled_start_at
      ? new Date(appointment.scheduled_start_at).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const { data: encounter, error: encounterError } = await supabase
      .from("encounters")
      .insert({
        organization_id: organizationId,
        client_id: appointment.client_id,
        provider_id: appointment.provider_id,
        appointment_id: appointmentId,
        encounter_status: "draft",
        service_date: serviceDate,
        required_billing_fields_complete: false,
        started_at: appointment.scheduled_start_at ?? null,
        ended_at: appointment.scheduled_end_at ?? null,
      })
      .select("id")
      .single();

    if (encounterError || !encounter) {
      return NextResponse.json(
        { success: false, error: encounterError?.message ?? "Failed to create encounter" },
        { status: 422 },
      );
    }

    return NextResponse.json({ success: true, encounterId: encounter.id, created: true });
  } catch (error) {
    console.error("Create encounter from appointment API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Create encounter failed" },
      { status: 500 },
    );
  }
}
