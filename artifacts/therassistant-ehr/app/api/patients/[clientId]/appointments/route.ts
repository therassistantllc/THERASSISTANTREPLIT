import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

export async function GET(request: Request, context: { params: Promise<{ clientId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 500 });

    const { clientId } = await context.params;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId required" }, { status: 400 });

    const { data: appointments, error } = await supabase
      .from("appointments")
      .select("id, scheduled_start_at, scheduled_end_at, appointment_status, appointment_type, reason, check_in_at, cancelled_at, cancellation_reason, provider_id, insurance_policy_id, created_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("scheduled_start_at", { ascending: false })
      .limit(50);

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });

    const apptIds = (appointments ?? []).map((a: DbRow) => a.id as string);

    const { data: encounters } = apptIds.length > 0
      ? await supabase
          .from("encounters")
          .select("id, appointment_id, encounter_status, service_date")
          .in("appointment_id", apptIds)
          .is("archived_at", null)
      : { data: [] as DbRow[] };

    const encounterByAppt: Record<string, DbRow> = {};
    for (const enc of (encounters ?? [])) {
      if (enc.appointment_id) encounterByAppt[enc.appointment_id as string] = enc;
    }

    const items = (appointments ?? []).map((appt: DbRow) => ({
      id: appt.id as string,
      scheduledStart: appt.scheduled_start_at as string | null,
      scheduledEnd: appt.scheduled_end_at as string | null,
      status: appt.appointment_status as string | null,
      type: appt.appointment_type as string | null,
      reason: appt.reason as string | null,
      checkedInAt: appt.check_in_at as string | null,
      cancelledAt: appt.cancelled_at as string | null,
      cancellationReason: appt.cancellation_reason as string | null,
      providerId: appt.provider_id as string | null,
      insurancePolicyId: appt.insurance_policy_id as string | null,
      createdAt: appt.created_at as string | null,
      encounter: encounterByAppt[appt.id as string]
        ? {
            id: encounterByAppt[appt.id as string].id as string,
            status: encounterByAppt[appt.id as string].encounter_status as string | null,
            serviceDate: encounterByAppt[appt.id as string].service_date as string | null,
          }
        : null,
    }));

    return NextResponse.json({ success: true, appointments: items, total: items.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to load appointments" },
      { status: 500 },
    );
  }
}
