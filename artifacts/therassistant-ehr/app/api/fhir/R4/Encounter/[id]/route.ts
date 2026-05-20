import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { fhirJson, operationOutcome } from "@/lib/fhir/patient";
import { baseUrlOf, isUuid, requireFhirAuth } from "@/lib/fhir/common";
import { ENCOUNTER_DB_COLUMNS, encounterRowToFhir, type EncounterRow } from "@/lib/fhir/encounter";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireFhirAuth();
    if (auth.kind === "error") return auth.response;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return operationOutcome("error", "exception", "Database connection not available", 500);

    const { id } = await context.params;
    if (!id || !isUuid(id)) return operationOutcome("error", "not-found", `Encounter/${id} not found`, 404);

    const { data, error } = await supabase
      .from("encounters")
      .select(ENCOUNTER_DB_COLUMNS)
      .eq("id", id)
      .eq("organization_id", auth.organizationId)
      .maybeSingle();
    if (error) return operationOutcome("error", "exception", error.message, 500);
    if (!data) return operationOutcome("error", "not-found", `Encounter/${id} not found`, 404);

    return fhirJson(encounterRowToFhir(data as EncounterRow, baseUrlOf(request)));
  } catch (err) {
    return operationOutcome("error", "exception", err instanceof Error ? err.message : "Internal error", 500);
  }
}
