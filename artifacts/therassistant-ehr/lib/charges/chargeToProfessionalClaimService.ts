import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { createProfessionalClaimDraft } from "@/lib/claims/claimReadinessService";

export interface ConvertChargeToProfessionalClaimInput {
  organizationId: string;
  chargeId: string;
  billingProvider: {
    name: string;
    npi: string;
    taxId: string;
    address1: string;
    city: string;
    state: string;
    zip: string;
    address2?: string | null;
    taxIdType?: "EI" | "SY";
  };
}

export interface ConvertChargeToProfessionalClaimResult {
  ok: boolean;
  chargeId: string;
  claimId: string | null;
  errors: Array<{ field: string; message: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function toServiceLines(lines: DbRow[]) {
  return lines.map((line) => ({
    serviceDate: normalizeText(line.serviceDate),
    procedureCode: normalizeText(line.procedureCode).toUpperCase(),
    chargeAmount: Number(line.chargeAmount ?? 0),
    units: Number(line.units ?? 1) || 1,
    modifiers: Array.isArray(line.modifiers) ? line.modifiers : [],
    diagnosisPointers: ["1"],
    placeOfService: normalizeText(line.placeOfService) || null,
    renderingProviderNpi: null,
    authorizationNumber: null,
  }));
}

export async function convertChargeCaptureToProfessionalClaim(
  input: ConvertChargeToProfessionalClaimInput,
): Promise<ConvertChargeToProfessionalClaimResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      chargeId: input.chargeId,
      claimId: null,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const { data: charge, error: chargeError } = await supabase
    .from("charge_capture_items")
    .select("*")
    .eq("id", input.chargeId)
    .eq("organization_id", input.organizationId)
    .is("archived_at", null)
    .maybeSingle();

  if (chargeError || !charge) {
    return {
      ok: false,
      chargeId: input.chargeId,
      claimId: null,
      errors: [{ field: "charge_capture_items", message: "Charge capture item not found" }],
    };
  }

  if (charge.charge_status === "claim_created" && charge.claim_id) {
    return {
      ok: true,
      chargeId: input.chargeId,
      claimId: String(charge.claim_id),
      errors: [],
    };
  }

  if (charge.charge_status !== "ready_for_claim") {
    return {
      ok: false,
      chargeId: input.chargeId,
      claimId: null,
      errors: [{ field: "charge_status", message: `Charge must be ready_for_claim before claim creation. Current status: ${charge.charge_status}` }],
    };
  }

  const diagnosisCodes = Array.isArray(charge.diagnosis_codes)
    ? charge.diagnosis_codes.map(normalizeText).filter(Boolean)
    : [];

  const serviceLineRows = Array.isArray(charge.service_lines) ? charge.service_lines : [];
  if (diagnosisCodes.length === 0 || serviceLineRows.length === 0) {
    return {
      ok: false,
      chargeId: input.chargeId,
      claimId: null,
      errors: [{ field: "charge_capture_items", message: "Charge is missing diagnosis codes or service lines" }],
    };
  }

  const result = await createProfessionalClaimDraft({
    organizationId: input.organizationId,
    clientId: String(charge.client_id),
    policyId: charge.insurance_policy_id ? String(charge.insurance_policy_id) : null,
    appointmentId: charge.appointment_id ? String(charge.appointment_id) : null,
    placeOfService: charge.place_of_service ?? null,
    diagnosisCodes,
    serviceLines: toServiceLines(serviceLineRows),
    billingProvider: input.billingProvider,
    claimNumber: `CLM-${Date.now()}`,
    patientAccountNumber: `CHG-${String(charge.id).slice(0, 8)}`,
  });

  if (!result.ok || !result.claimId) {
    return {
      ok: false,
      chargeId: input.chargeId,
      claimId: null,
      errors: result.errors,
    };
  }

  const { error: updateError } = await supabase
    .from("charge_capture_items")
    .update({
      charge_status: "claim_created",
      claim_id: result.claimId,
      claim_created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.chargeId)
    .eq("organization_id", input.organizationId);

  if (updateError) {
    return {
      ok: false,
      chargeId: input.chargeId,
      claimId: result.claimId,
      errors: [{ field: "charge_capture_items", message: updateError.message }],
    };
  }

  return { ok: true, chargeId: input.chargeId, claimId: result.claimId, errors: [] };
}
