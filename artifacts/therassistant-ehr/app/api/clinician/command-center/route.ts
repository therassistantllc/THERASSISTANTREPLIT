import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

function getDayRange(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function clientName(client: DbRow | undefined) {
  if (!client) return "Unknown client";
  return [client.first_name, client.last_name].filter(Boolean).join(" ") || "Unknown client";
}

function isEligibilityStale(checkedAt: string | null | undefined) {
  if (!checkedAt) return true;
  const checked = new Date(checkedAt);
  if (Number.isNaN(checked.getTime())) return true;
  const ageMs = Date.now() - checked.getTime();
  return ageMs > 30 * 24 * 60 * 60 * 1000;
}

async function loadPatientBalances(organizationId: string, clientIds: string[]) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase || clientIds.length === 0) return new Map<string, number>();

  const { data } = await supabase
    .from("patient_invoices")
    .select("client_id, balance_amount, invoice_status")
    .eq("organization_id", organizationId)
    .in("client_id", clientIds)
    .in("invoice_status", ["open", "sent", "collections"])
    .is("archived_at", null);

  const balances = new Map<string, number>();
  for (const row of data ?? []) {
    const clientId = String(row.client_id);
    balances.set(clientId, (balances.get(clientId) ?? 0) + Number(row.balance_amount ?? 0));
  }
  return balances;
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId") ?? process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? null;
    const dateParam = searchParams.get("date");

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    // Dev fallback: when no clinicianId is supplied and we're not in production,
    // use the known test provider so today's appointments are visible without a session.
    const paramClinicianId = searchParams.get("clinicianId");
    const devFallback = !paramClinicianId && process.env.NODE_ENV !== "production";
    const clinicianId = paramClinicianId ?? (devFallback ? "22222222-2222-2222-2222-222222222222" : null);

    const { start, end } = getDayRange(dateParam ? new Date(dateParam) : new Date());

    let appointmentQuery = supabase
      .from("appointments")
      .select("id, client_id, provider_id, appointment_status, appointment_type, scheduled_start_at, scheduled_end_at, check_in_at, telehealth_url")
      .eq("organization_id", organizationId)
      .gte("scheduled_start_at", start)
      .lt("scheduled_start_at", end)
      .is("archived_at", null)
      .order("scheduled_start_at", { ascending: true })
      .limit(75);

    if (clinicianId) appointmentQuery = appointmentQuery.eq("provider_id", clinicianId);

    const { data: appointments, error: appointmentError } = await appointmentQuery;
    if (appointmentError) throw appointmentError;

    const clientIds = [...new Set((appointments ?? []).map((row: DbRow) => row.client_id).filter(Boolean).map(String))];

    const { data: clients } = clientIds.length
      ? await supabase
          .from("clients")
          .select("id, first_name, last_name, date_of_birth")
          .in("id", clientIds)
      : { data: [] as DbRow[] };

    const clientById = new Map<string, DbRow>((clients ?? []).map((client: DbRow) => [String(client.id), client]));

    const { data: eligibilityChecks } = clientIds.length
      ? await supabase
          .from("eligibility_checks")
          .select("id, client_id, eligibility_status, checked_at, copay_amount, deductible_remaining, coverage_start_date, coverage_end_date, response_summary")
          .eq("organization_id", organizationId)
          .in("client_id", clientIds)
          .is("archived_at", null)
          .order("checked_at", { ascending: false })
      : { data: [] as DbRow[] };

    const latestEligibility = new Map<string, DbRow>();
    for (const row of eligibilityChecks ?? []) {
      const clientId = String(row.client_id);
      if (!latestEligibility.has(clientId)) latestEligibility.set(clientId, row);
    }

    const { data: encounters } = clientIds.length
      ? await supabase
          .from("encounters")
          .select("id, appointment_id, encounter_status")
          .eq("organization_id", organizationId)
          .in("client_id", clientIds)
          .is("archived_at", null)
      : { data: [] as DbRow[] };

    const encounterByAppointment = new Map<string, DbRow>();
    for (const row of encounters ?? []) {
      if (row.appointment_id) encounterByAppointment.set(String(row.appointment_id), row);
    }

    const patientBalances = await loadPatientBalances(organizationId, clientIds);

    const agenda = (appointments ?? []).map((appointment: DbRow) => {
      const clientId = String(appointment.client_id ?? "");
      const eligibility = latestEligibility.get(clientId) ?? null;
      const encounter = encounterByAppointment.get(String(appointment.id)) ?? null;
      const stale = eligibility ? isEligibilityStale(eligibility.checked_at) : true;

      return {
        appointmentId: appointment.id,
        clientId,
        clientName: clientName(clientById.get(clientId)),
        dateOfBirth: clientById.get(clientId)?.date_of_birth ?? null,
        startTime: appointment.scheduled_start_at,
        endTime: appointment.scheduled_end_at,
        status: appointment.appointment_status ?? null,
        type: appointment.appointment_type ?? null,
        serviceLocation: null,
        telehealthUrl: appointment.telehealth_url ?? null,
        encounter: encounter ? { id: encounter.id, status: encounter.encounter_status } : null,
        checkIn: appointment.check_in_at ? { status: "checked_in", checkedInAt: appointment.check_in_at } : null,
        eligibility: eligibility
          ? {
              id: eligibility.id,
              status: stale ? "stale" : eligibility.eligibility_status,
              rawStatus: eligibility.eligibility_status,
              checkedAt: eligibility.checked_at,
              copayAmount: eligibility.copay_amount,
              deductibleRemaining: eligibility.deductible_remaining,
              coverageStartDate: eligibility.coverage_start_date,
              coverageEndDate: eligibility.coverage_end_date,
              responseSummary: eligibility.response_summary,
            }
          : null,
        patientBalance: patientBalances.get(clientId) ?? 0,
      };
    });

    const metrics = {
      appointmentsToday: agenda.length,
      checkedIn: agenda.filter((item) => item.checkIn?.status === "checked_in").length,
      eligibilityMissingOrStale: agenda.filter((item) => !item.eligibility || item.eligibility.status === "stale").length,
      eligibilityInactive: agenda.filter((item) => item.eligibility?.rawStatus === "inactive").length,
      balancesToReview: agenda.filter((item) => item.patientBalance > 0).length,
    };

    return NextResponse.json({ success: true, organizationId, clinicianId, devFallback, date: start.slice(0, 10), metrics, agenda });
  } catch (error) {
    console.error("Clinician command center API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Clinician command center failed" },
      { status: 500 },
    );
  }
}
