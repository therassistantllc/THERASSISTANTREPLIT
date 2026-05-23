import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  getDefaultCaseForClient,
  isPatientResponsibilityCaseType,
  resolveCaseBillingPolicy,
} from "@/lib/cases/clientCasesService";

export interface CaptureSignedEncounterChargeInput {
  organizationId: string;
  encounterId: string;
}

export interface CaptureSignedEncounterChargeResult {
  ok: boolean;
  chargeId: string | null;
  status: "ready_for_claim" | "blocked" | "patient_responsibility";
  blockers: Array<{ field: string; message: string }>;
  caseId?: string | null;
  routing?: "insurance_claim" | "patient_responsibility";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function money(value: unknown) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100) / 100;
}

function normalizeModifiers(line: DbRow) {
  return [line.modifier_1, line.modifier_2, line.modifier_3, line.modifier_4]
    .map(normalizeText)
    .filter(Boolean);
}

async function getActivePrimaryPolicy(params: { organizationId: string; clientId: string }) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("insurance_policies")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("client_id", params.clientId)
    .eq("priority", "primary")
    .eq("active_flag", true)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data?.id ? String(data.id) : null;
}

export async function captureSignedEncounterCharge(
  input: CaptureSignedEncounterChargeInput
): Promise<CaptureSignedEncounterChargeResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      chargeId: null,
      status: "blocked",
      blockers: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const { data: encounter, error: encounterError } = await supabase
    .from("encounters")
    .select("id, organization_id, appointment_id, client_id, provider_id, encounter_status, service_date, case_id")
    .eq("id", input.encounterId)
    .eq("organization_id", input.organizationId)
    .is("archived_at", null)
    .maybeSingle();

  if (encounterError || !encounter) {
    return {
      ok: false,
      chargeId: null,
      status: "blocked",
      blockers: [{ field: "encounter", message: "Signed encounter not found" }],
    };
  }

  const blockers: Array<{ field: string; message: string }> = [];
  if (encounter.encounter_status !== "signed") {
    blockers.push({ field: "encounter_status", message: "Encounter must be signed before charge capture" });
  }
  if (!encounter.client_id) blockers.push({ field: "client_id", message: "Encounter is missing client" });
  if (!encounter.service_date) blockers.push({ field: "service_date", message: "Encounter is missing service date" });

  const { data: diagnosisRows, error: diagnosisError } = await supabase
    .from("encounter_diagnoses")
    .select("diagnosis_code, sequence_number, is_primary, present_on_claim")
    .eq("organization_id", input.organizationId)
    .eq("encounter_id", input.encounterId)
    .is("archived_at", null)
    .order("sequence_number", { ascending: true });

  if (diagnosisError) throw new Error(diagnosisError.message);

  const diagnosisCodes = (diagnosisRows ?? [])
    .filter((row: DbRow) => row.present_on_claim !== false)
    .map((row: DbRow) => normalizeText(row.diagnosis_code).toUpperCase())
    .filter(Boolean);

  if (diagnosisCodes.length === 0) {
    blockers.push({ field: "diagnosis_codes", message: "No diagnosis is available for billing after note signature" });
  }

  const { data: serviceRows, error: serviceError } = await supabase
    .from("encounter_service_lines")
    .select("id, service_date, sequence_number, cpt_hcpcs_code, modifier_1, modifier_2, modifier_3, modifier_4, units, charge_amount, place_of_service_code, rendering_provider_id")
    .eq("organization_id", input.organizationId)
    .eq("encounter_id", input.encounterId)
    .is("archived_at", null)
    .order("sequence_number", { ascending: true });

  if (serviceError) throw new Error(serviceError.message);

  const serviceLines = (serviceRows ?? []).map((line: DbRow, index: number) => {
    const chargeAmount = money(line.charge_amount);
    const units = Number(line.units ?? 1) || 1;
    return {
      encounterServiceLineId: line.id,
      serviceDate: line.service_date ?? encounter.service_date,
      sequenceNumber: line.sequence_number ?? index + 1,
      procedureCode: normalizeText(line.cpt_hcpcs_code).toUpperCase(),
      modifiers: normalizeModifiers(line),
      units,
      chargeAmount,
      placeOfService: normalizeText(line.place_of_service_code) || null,
      renderingProviderId: line.rendering_provider_id ?? null,
    };
  });

  if (serviceLines.length === 0) {
    blockers.push({ field: "service_lines", message: "No service lines are available for billing after note signature" });
  }

  for (const [index, line] of serviceLines.entries()) {
    if (!line.procedureCode) blockers.push({ field: `service_lines.${index}.procedure_code`, message: "Service line is missing procedure code" });
    if (line.chargeAmount <= 0) blockers.push({ field: `service_lines.${index}.charge_amount`, message: "Service line charge must be greater than zero" });
  }

  // Resolve the case for this encounter — explicit case_id wins, then the
  // client's default case. Self-pay / charity cases route to patient
  // responsibility instead of generating an insurance claim.
  let resolvedCaseId: string | null = encounter.case_id ? String(encounter.case_id) : null;
  if (!resolvedCaseId && encounter.client_id) {
    const defaultCase = await getDefaultCaseForClient({
      organizationId: input.organizationId,
      clientId: String(encounter.client_id),
    });
    resolvedCaseId = defaultCase?.id ?? null;
  }

  let policyId: string | null = null;
  let routing: "insurance_claim" | "patient_responsibility" = "insurance_claim";

  if (resolvedCaseId) {
    const billing = await resolveCaseBillingPolicy({
      organizationId: input.organizationId,
      caseId: resolvedCaseId,
    });
    if (billing.kind === "patient_responsibility") {
      routing = "patient_responsibility";
    } else if (billing.kind === "insurance") {
      policyId = billing.policyId;
    } else {
      blockers.push({ field: "insurance_policy", message: billing.reason });
    }
  } else if (encounter.client_id) {
    // Legacy fallback for clients with no case yet (e.g. pre-migration data).
    policyId = await getActivePrimaryPolicy({ organizationId: input.organizationId, clientId: String(encounter.client_id) });
    if (!policyId) blockers.push({ field: "insurance_policy", message: "No active primary insurance policy found for claim creation" });
  }

  const status =
    blockers.length > 0
      ? "blocked"
      : routing === "patient_responsibility"
        ? "patient_responsibility"
        : "ready_for_claim";
  const totalCharge = serviceLines.reduce((sum, line) => sum + line.chargeAmount * line.units, 0);

  const { data: existing } = await supabase
    .from("charge_capture_items")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("encounter_id", input.encounterId)
    .is("archived_at", null)
    .neq("charge_status", "voided")
    .limit(1)
    .maybeSingle();

  const okForFlow = status === "ready_for_claim" || status === "patient_responsibility";

  if (existing?.id) {
    const { data: updated, error: updateError } = await supabase
      .from("charge_capture_items")
      .update({
        insurance_policy_id: policyId,
        case_id: resolvedCaseId,
        charge_status: status,
        diagnosis_codes: diagnosisCodes,
        service_lines: serviceLines,
        total_charge: totalCharge,
        place_of_service: serviceLines[0]?.placeOfService ?? null,
        blocker_reasons: blockers,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select("id")
      .single();

    if (updateError || !updated) throw new Error(updateError?.message ?? "Failed to update charge capture item");
    return { ok: okForFlow, chargeId: String(updated.id), status, blockers, caseId: resolvedCaseId, routing };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("charge_capture_items")
    .insert({
      organization_id: input.organizationId,
      encounter_id: input.encounterId,
      client_id: encounter.client_id,
      provider_id: encounter.provider_id,
      appointment_id: encounter.appointment_id,
      insurance_policy_id: policyId,
      case_id: resolvedCaseId,
      source_object_type: "encounter",
      source_object_id: input.encounterId,
      charge_status: status,
      service_date: encounter.service_date,
      diagnosis_codes: diagnosisCodes,
      service_lines: serviceLines,
      total_charge: totalCharge,
      place_of_service: serviceLines[0]?.placeOfService ?? null,
      blocker_reasons: blockers,
    })
    .select("id")
    .single();

  if (insertError || !inserted) throw new Error(insertError?.message ?? "Failed to create charge capture item");
  return { ok: okForFlow, chargeId: String(inserted.id), status, blockers, caseId: resolvedCaseId, routing };
}

// Test-only re-export so unit tests can detect self-pay routing without
// importing the cases module directly.
export { isPatientResponsibilityCaseType };
