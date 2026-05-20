import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { fhirJson, operationOutcome, type FhirBundle } from "@/lib/fhir/patient";
import { baseUrlOf, requireFhirAuth, safeTerm, stripRefPrefix, toFiniteInt } from "@/lib/fhir/common";
import {
  OBSERVATION_DB_COLUMNS,
  checkInRowToObservation,
  type CheckInRow,
  type FhirObservation,
} from "@/lib/fhir/observation";

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
    const date = (searchParams.get("date") || "").trim();
    const count = toFiniteInt(searchParams.get("_count"), 20, 1, 200);
    const offset = toFiniteInt(searchParams.get("_offset"), 0, 0, 100000);

    let query = supabase
      .from("patient_check_ins")
      .select(OBSERVATION_DB_COLUMNS, { count: "exact" })
      .eq("organization_id", auth.organizationId)
      .is("archived_at", null)
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .range(offset, offset + count - 1);

    if (patient) query = query.eq("client_id", patient);
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return operationOutcome("error", "invalid", "date must be YYYY-MM-DD", 400);
      }
      // submitted_at is a timestamptz; bracket the day in UTC for an exact match.
      query = query.gte("submitted_at", `${date}T00:00:00.000Z`).lt("submitted_at", `${date}T23:59:59.999Z`);
    }

    const { data, error, count: total } = await query;
    if (error) return operationOutcome("error", "exception", error.message, 500);

    const rows = (data ?? []) as CheckInRow[];
    const entry = rows.map((row) => ({
      fullUrl: `${baseUrl}/Observation/${row.id}`,
      resource: checkInRowToObservation(row, baseUrl),
      search: { mode: "match" as const },
    }));

    const bundle: FhirBundle<FhirObservation> = {
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
