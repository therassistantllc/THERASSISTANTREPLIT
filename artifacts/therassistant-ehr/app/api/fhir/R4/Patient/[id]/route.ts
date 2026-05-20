import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { ORGANIZATION_ID } from "@/lib/config";
import { clientToFhirPatient, fhirJson, operationOutcome, PATIENT_DB_COLUMNS, type ClientRow } from "@/lib/fhir/patient";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return operationOutcome("error", "exception", "Database connection not available", 500);

    const { id } = await context.params;
    if (!id) return operationOutcome("error", "required", "Patient id is required", 400);

    // Org scope is server-side only — FHIR is outward-facing, never trust a caller-supplied org id here.
    const organizationId = ORGANIZATION_ID;
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}/api/fhir/R4`;

    const { data, error } = await supabase
      .from("clients")
      .select(PATIENT_DB_COLUMNS)
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) return operationOutcome("error", "exception", error.message, 500);
    if (!data) return operationOutcome("error", "not-found", `Patient/${id} not found`, 404);

    return fhirJson(clientToFhirPatient(data as ClientRow, baseUrl));
  } catch (err) {
    return operationOutcome("error", "exception", err instanceof Error ? err.message : "Internal error", 500);
  }
}
