import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { fhirJson, operationOutcome, type FhirBundle } from "@/lib/fhir/patient";
import { baseUrlOf, requireFhirAuth, safeTerm, stripRefPrefix, toFiniteInt } from "@/lib/fhir/common";
import {
  COVERAGE_DB_COLUMNS,
  intakeRowToCoverage,
  type FhirCoverage,
  type IntakeSubmissionRow,
} from "@/lib/fhir/coverage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireFhirAuth();
    if (auth.kind === "error") return auth.response;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return operationOutcome("error", "exception", "Database connection not available", 500);

    const baseUrl = baseUrlOf(request);
    const { searchParams } = new URL(request.url);

    // Both `beneficiary` and `patient` are accepted as aliases for the
    // Coverage's beneficiary (see CapabilityStatement).
    const beneficiary = safeTerm(
      stripRefPrefix(searchParams.get("beneficiary") || searchParams.get("patient"), "Patient"),
    );
    const count = toFiniteInt(searchParams.get("_count"), 20, 1, 200);
    const offset = toFiniteInt(searchParams.get("_offset"), 0, 0, 100000);

    let query = supabase
      .from("intake_submissions")
      .select(COVERAGE_DB_COLUMNS, { count: "exact" })
      .eq("organization_id", auth.organizationId)
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .range(offset, offset + count - 1);

    if (beneficiary) query = query.eq("client_id", beneficiary);

    const { data, error, count: total } = await query;
    if (error) return operationOutcome("error", "exception", error.message, 500);

    const rows = (data ?? []) as IntakeSubmissionRow[];
    const entry = rows.map((row) => ({
      fullUrl: `${baseUrl}/Coverage/${row.id}`,
      resource: intakeRowToCoverage(row, baseUrl),
      search: { mode: "match" as const },
    }));

    const bundle: FhirBundle<FhirCoverage> = {
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
