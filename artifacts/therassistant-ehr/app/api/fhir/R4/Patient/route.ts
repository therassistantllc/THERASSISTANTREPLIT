import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireAuthentication } from "@/lib/rbac/middleware";
import {
  clientToFhirClient,
  fhirJson,
  operationOutcome,
  PATIENT_DB_COLUMNS,
  type ClientRow,
  type FhirBundle,
  type FhirClient,
} from "@/lib/fhir/patient";

export const dynamic = "force-dynamic";

function toFiniteInt(raw: string | null, fallback: number, min: number, max: number) {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// PostgREST .or() / .ilike() filter values are interpolated into a filter DSL
// where `,`, `(`, `)`, `:`, `*`, `%`, and quotes have special meaning. Strip
// anything outside a conservative allowlist so user input cannot break out of
// the intended filter expression.
function safeTerm(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 _.'\-]/g, "").trim().slice(0, 100);
}

export async function GET(request: Request) {
  try {
    const auth = await requireAuthentication();
    if (auth instanceof NextResponse) {
      const status = auth.status;
      const code = status === 401 ? "login" : "forbidden";
      return operationOutcome("error", code, status === 401 ? "Not authenticated" : "Access denied", status);
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return operationOutcome("error", "exception", "Database connection not available", 500);

    const { searchParams, protocol, host } = new URL(request.url);
    const baseUrl = `${protocol}//${host}/api/fhir/R4`;
    // Organization is resolved from the authenticated staff session — query-param
    // org ids are intentionally ignored on FHIR routes.
    const organizationId = auth.organizationId;

    const identifierRaw = (searchParams.get("identifier") || "").trim();
    const identifier = safeTerm(
      identifierRaw.includes("|") ? identifierRaw.split("|").slice(1).join("|") : identifierRaw,
    );
    const name = safeTerm(searchParams.get("name") || "");
    const family = safeTerm(searchParams.get("family") || "");
    const given = safeTerm(searchParams.get("given") || "");
    const birthdate = (searchParams.get("birthdate") || "").trim();
    const count = toFiniteInt(searchParams.get("_count"), 20, 1, 200);
    const offset = toFiniteInt(searchParams.get("_offset"), 0, 0, 100000);

    let query = supabase
      .from("clients")
      .select(PATIENT_DB_COLUMNS, { count: "exact" })
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("last_name", { ascending: true })
      .range(offset, offset + count - 1);

    if (identifier) {
      query = query.or(`mrn.eq.${identifier},external_client_ref.eq.${identifier}`);
    }
    if (family) query = query.ilike("last_name", `%${family}%`);
    if (given) {
      query = query.or(
        `first_name.ilike.%${given}%,middle_name.ilike.%${given}%,preferred_name.ilike.%${given}%`,
      );
    }
    if (name) {
      query = query.or(
        `first_name.ilike.%${name}%,middle_name.ilike.%${name}%,last_name.ilike.%${name}%,preferred_name.ilike.%${name}%`,
      );
    }
    if (birthdate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
        return operationOutcome("error", "invalid", "birthdate must be YYYY-MM-DD", 400);
      }
      query = query.eq("date_of_birth", birthdate);
    }

    const { data, error, count: total } = await query;
    if (error) return operationOutcome("error", "exception", error.message, 500);

    const rows = (data ?? []) as ClientRow[];
    const entry = rows.map((row) => ({
      fullUrl: `${baseUrl}/Patient/${row.id}`,
      resource: clientToFhirClient(row, baseUrl),
      search: { mode: "match" as const },
    }));

    const selfUrl = new URL(request.url);
    const bundle: FhirBundle<FhirClient> = {
      resourceType: "Bundle",
      type: "searchset",
      total: total ?? rows.length,
      link: [{ relation: "self", url: selfUrl.toString() }],
      entry,
    };
    return fhirJson(bundle);
  } catch (err) {
    return operationOutcome("error", "exception", err instanceof Error ? err.message : "Internal error", 500);
  }
}
