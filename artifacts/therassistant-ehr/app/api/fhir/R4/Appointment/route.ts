import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { fhirJson, operationOutcome, type FhirBundle } from "@/lib/fhir/patient";
import { baseUrlOf, requireFhirAuth, safeTerm, stripRefPrefix, toFiniteInt } from "@/lib/fhir/common";
import {
  APPOINTMENT_DB_COLUMNS,
  appointmentRowToFhir,
  type AppointmentRow,
  type FhirAppointment,
} from "@/lib/fhir/appointment";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireFhirAuth();
    if (auth.kind === "error") return auth.response;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return operationOutcome("error", "exception", "Database connection not available", 500);

    const baseUrl = baseUrlOf(request);
    const { searchParams } = new URL(request.url);

    const patient = safeTerm(stripRefPrefix(searchParams.get("patient"), "Patient"));
    const practitioner = safeTerm(stripRefPrefix(searchParams.get("practitioner"), "Practitioner"));
    const status = safeTerm(searchParams.get("status") || "");
    const date = (searchParams.get("date") || "").trim();
    const count = toFiniteInt(searchParams.get("_count"), 20, 1, 200);
    const offset = toFiniteInt(searchParams.get("_offset"), 0, 0, 100000);

    let query = supabase
      .from("appointments")
      .select(APPOINTMENT_DB_COLUMNS, { count: "exact" })
      .eq("organization_id", auth.organizationId)
      .is("archived_at", null)
      .order("scheduled_start_at", { ascending: false })
      .range(offset, offset + count - 1);

    if (patient) query = query.eq("client_id", patient);
    if (practitioner) query = query.eq("provider_id", practitioner);
    if (status) query = query.eq("appointment_status", status);
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return operationOutcome("error", "invalid", "date must be YYYY-MM-DD", 400);
      }
      query = query.gte("scheduled_start_at", `${date}T00:00:00.000Z`).lt("scheduled_start_at", `${date}T23:59:59.999Z`);
    }

    const { data, error, count: total } = await query;
    if (error) return operationOutcome("error", "exception", error.message, 500);

    const rows = (data ?? []) as AppointmentRow[];
    const entry = rows.map((row) => ({
      fullUrl: `${baseUrl}/Appointment/${row.id}`,
      resource: appointmentRowToFhir(row, baseUrl),
      search: { mode: "match" as const },
    }));

    const bundle: FhirBundle<FhirAppointment> = {
      resourceType: "Bundle",
      type: "searchset",
      total: total ?? rows.length,
      link: [{ relation: "self", url: new URL(request.url).toString() }],
      entry,
    };
    return fhirJson(bundle);
  } catch (err) {
    return operationOutcome("error", "exception", err instanceof Error ? err.message : "Internal error", 500);
  }
}
