import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { fhirJson, operationOutcome } from "@/lib/fhir/patient";
import { isUuid, requireFhirAuth } from "@/lib/fhir/common";
import {
  PRACTITIONER_PROVIDER_COLUMNS,
  PRACTITIONER_STAFF_COLUMNS,
  staffToFhirPractitioner,
  type ProviderProfileRow,
  type StaffRow,
} from "@/lib/fhir/practitioner";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireFhirAuth();
    if (auth.kind === "error") return auth.response;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return operationOutcome("error", "exception", "Database connection not available", 500);

    const { id } = await context.params;
    if (!id || !isUuid(id)) return operationOutcome("error", "not-found", `Practitioner/${id} not found`, 404);

    const organizationId = auth.organizationId;
    const { data, error } = await supabase
      .from("staff_profiles")
      .select(PRACTITIONER_STAFF_COLUMNS)
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) return operationOutcome("error", "exception", error.message, 500);
    if (!data) return operationOutcome("error", "not-found", `Practitioner/${id} not found`, 404);

    const { data: provider } = await supabase
      .from("provider_profiles")
      .select(PRACTITIONER_PROVIDER_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("staff_id", id)
      .is("archived_at", null)
      .maybeSingle();

    return fhirJson(staffToFhirPractitioner(data as StaffRow, (provider as ProviderProfileRow | null) ?? null));
  } catch (err) {
    return operationOutcome("error", "exception", err instanceof Error ? err.message : "Internal error", 500);
  }
}
