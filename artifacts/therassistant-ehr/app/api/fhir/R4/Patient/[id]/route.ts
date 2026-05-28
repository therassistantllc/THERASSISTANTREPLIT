import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireAuthentication } from "@/lib/rbac/middleware";
import { clientToFhirClient, fhirJson, operationOutcome, PATIENT_DB_COLUMNS, type ClientRow } from "@/lib/fhir/patient";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    // Enforce same authenticated-staff guard the rest of the protected EHR APIs use.
    // Translate the JSON 401/403 response into a FHIR OperationOutcome so callers
    // still get a spec-shaped error.
    const auth = await requireAuthentication();
    if (auth instanceof NextResponse) {
      const status = auth.status;
      const code = status === 401 ? "login" : "forbidden";
      return operationOutcome("error", code, status === 401 ? "Not authenticated" : "Access denied", status);
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return operationOutcome("error", "exception", "Database connection not available", 500);

    const { id } = await context.params;
    if (!id) return operationOutcome("error", "required", "Client id is required", 400);

    // Org scope comes from the authenticated staff context — never from query params.
    const organizationId = auth.organizationId;
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}/api/fhir/R4`;

    const { data, error } = await supabase
      .from("clients")
      .select(PATIENT_DB_COLUMNS)
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) return operationOutcome("error", "exception", error.message, 500);
    if (!data) return operationOutcome("error", "not-found", `Client/${id} not found`, 404);

    return fhirJson(clientToFhirClient(data as ClientRow, baseUrl));
  } catch (err) {
    return operationOutcome("error", "exception", err instanceof Error ? err.message : "Internal error", 500);
  }
}
