import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { fhirJson, operationOutcome, type FhirBundle } from "@/lib/fhir/patient";
import { baseUrlOf, requireFhirAuth, safeTerm, toFiniteInt } from "@/lib/fhir/common";
import {
  PRACTITIONER_PROVIDER_COLUMNS,
  PRACTITIONER_STAFF_COLUMNS,
  staffToFhirPractitioner,
  type FhirPractitioner,
  type ProviderProfileRow,
  type StaffRow,
} from "@/lib/fhir/practitioner";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireFhirAuth();
    if (auth.kind === "error") return auth.response;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return operationOutcome("error", "exception", "Database connection not available", 500);

    const baseUrl = baseUrlOf(request);
    const { searchParams } = new URL(request.url);
    const organizationId = auth.organizationId;

    const identifier = safeTerm((searchParams.get("identifier") || "").split("|").pop() || "");
    const name = safeTerm(searchParams.get("name") || "");
    const family = safeTerm(searchParams.get("family") || "");
    const given = safeTerm(searchParams.get("given") || "");
    const count = toFiniteInt(searchParams.get("_count"), 20, 1, 200);
    const offset = toFiniteInt(searchParams.get("_offset"), 0, 0, 100000);

    let query = supabase
      .from("staff_profiles")
      .select(PRACTITIONER_STAFF_COLUMNS, { count: "exact" })
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("last_name", { ascending: true })
      .range(offset, offset + count - 1);

    if (identifier) query = query.eq("provider_npi", identifier);
    if (family) query = query.ilike("last_name", `%${family}%`);
    if (given) query = query.ilike("first_name", `%${given}%`);
    if (name) query = query.or(`first_name.ilike.%${name}%,last_name.ilike.%${name}%`);

    const { data, error, count: total } = await query;
    if (error) return operationOutcome("error", "exception", error.message, 500);

    const rows = (data ?? []) as StaffRow[];

    // provider_profiles is a separate table without a PostgREST-embeddable FK,
    // so we fetch the matching provider records in one extra round-trip and
    // merge them in memory.
    let providersById: Record<string, ProviderProfileRow> = {};
    const ids = rows.map((r) => String(r.id));
    if (ids.length) {
      const { data: providers, error: pErr } = await supabase
        .from("provider_profiles")
        .select(PRACTITIONER_PROVIDER_COLUMNS)
        .eq("organization_id", organizationId)
        .in("staff_id", ids)
        .is("archived_at", null);
      if (pErr) return operationOutcome("error", "exception", pErr.message, 500);
      providersById = Object.fromEntries(
        (providers ?? []).map((p) => [String((p as ProviderProfileRow).staff_id ?? ""), p as ProviderProfileRow]),
      );
    }

    const entry = rows.map((row) => ({
      fullUrl: `${baseUrl}/Practitioner/${row.id}`,
      resource: staffToFhirPractitioner(row, providersById[String(row.id)]),
      search: { mode: "match" as const },
    }));

    const bundle: FhirBundle<FhirPractitioner> = {
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
