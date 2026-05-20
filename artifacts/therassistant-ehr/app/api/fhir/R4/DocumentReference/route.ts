import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { fhirJson, operationOutcome, type FhirBundle } from "@/lib/fhir/patient";
import { baseUrlOf, requireFhirAuth, safeTerm, stripRefPrefix, toFiniteInt } from "@/lib/fhir/common";
import {
  DOCUMENT_DB_COLUMNS,
  documentRowToFhir,
  type DocumentRow,
  type FhirDocumentReference,
} from "@/lib/fhir/documentReference";

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
    const type = safeTerm(searchParams.get("type") || "");
    const count = toFiniteInt(searchParams.get("_count"), 20, 1, 200);
    const offset = toFiniteInt(searchParams.get("_offset"), 0, 0, 100000);

    let query = supabase
      .from("documents")
      .select(DOCUMENT_DB_COLUMNS, { count: "exact" })
      .eq("organization_id", auth.organizationId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + count - 1);

    if (patient) query = query.eq("client_id", patient);
    if (type) query = query.eq("document_type", type);

    const { data, error, count: total } = await query;
    if (error) return operationOutcome("error", "exception", error.message, 500);

    const rows = (data ?? []) as DocumentRow[];
    const entry = rows.map((row) => ({
      fullUrl: `${baseUrl}/DocumentReference/${row.id}`,
      resource: documentRowToFhir(row, baseUrl),
      search: { mode: "match" as const },
    }));

    const bundle: FhirBundle<FhirDocumentReference> = {
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
