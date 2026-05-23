import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type ClaimReadinessStatus = "ready" | "not_ready";

interface ClaimReadinessError {
  field: string;
  message: string;
}

export interface BillingProviderInput {
  name: string;
  npi: string;
  taxId: string;
  address1: string;
  city: string;
  state: string;
  zip: string;
  address2?: string | null;
  taxIdType?: "EI" | "SY";
}

export interface ClaimServiceLineInput {
  serviceDate: string;
  procedureCode: string;
  chargeAmount: number;
  units?: number;
  modifiers?: string[];
  diagnosisPointers?: string[];
  placeOfService?: string | null;
  renderingProviderNpi?: string | null;
  authorizationNumber?: string | null;
}

export interface CreateClaimDraftInput {
  organizationId: string;
  clientId: string;
  policyId?: string | null;
  appointmentId?: string | null;
  placeOfService?: string | null;
  diagnosisCodes: string[];
  serviceLines: ClaimServiceLineInput[];
  billingProvider: BillingProviderInput;
  patientAccountNumber?: string | null;
  claimNumber?: string | null;
}

export interface CreateClaimDraftResult {
  ok: boolean;
  claimId: string | null;
  errors: ClaimReadinessError[];
}

export interface ClaimReadinessResult {
  ok: boolean;
  status: ClaimReadinessStatus;
  claimId: string;
  errors: ClaimReadinessError[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRecord = Record<string, any>;

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeNullable(value: unknown): string | null {
  const valueText = normalizeText(value);
  return valueText.length > 0 ? valueText : null;
}

function normalizeDate(value: unknown): string | null {
  const valueText = normalizeText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText)) return null;
  return valueText;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function addRequired(errors: ClaimReadinessError[], field: string, value: unknown, message: string) {
  if (!normalizeText(value)) {
    errors.push({ field, message });
  }
}

async function resolvePrimaryPolicy(params: {
  organizationId: string;
  clientId: string;
  policyId?: string | null;
}): Promise<{ policy: DbRecord | null; payer: DbRecord | null; subscriber: DbRecord | null; errors: ClaimReadinessError[] }> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      policy: null,
      payer: null,
      subscriber: null,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  let policyQuery = supabase
    .from("insurance_policies")
    .select("id, payer_id, subscriber_id, plan_name, policy_number, priority, active_flag")
    .eq("organization_id", params.organizationId)
    .eq("client_id", params.clientId)
    .eq("active_flag", true)
    .is("archived_at", null)
    .limit(1);

  if (params.policyId) {
    policyQuery = policyQuery.eq("id", params.policyId);
  } else {
    policyQuery = policyQuery.eq("priority", "primary");
  }

  const { data: policy, error: policyError } = await policyQuery.maybeSingle();
  const errors: ClaimReadinessError[] = [];

  if (policyError || !policy) {
    errors.push({
      field: "insurance_policy",
      message: "No active primary insurance policy found for this client",
    });
    return { policy: null, payer: null, subscriber: null, errors };
  }

  const { data: payer } = await supabase
    .from("insurance_payers")
    .select("id, payer_name, payer_id")
    .eq("id", policy.payer_id)
    .is("archived_at", null)
    .maybeSingle();

  if (!payer) {
    errors.push({ field: "payer", message: "Insurance policy has no usable payer record" });
  }

  const { data: subscriber } = await supabase
    .from("insurance_subscribers")
    .select("id, first_name, last_name, date_of_birth, member_id, group_number, relationship_to_client")
    .eq("id", policy.subscriber_id)
    .is("archived_at", null)
    .maybeSingle();

  if (!subscriber) {
    errors.push({ field: "subscriber", message: "Insurance policy has no usable subscriber record" });
  }

  return { policy, payer: payer ?? null, subscriber: subscriber ?? null, errors };
}

async function ensurePayerProfile(params: {
  organizationId: string;
  payerName: string;
  availityPayerId: string;
}): Promise<string | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data: existing } = await supabase
    .from("payer_profiles")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("availity_payer_id", params.availityPayerId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (existing?.id) return String(existing.id);

  const { data: inserted, error } = await supabase
    .from("payer_profiles")
    .insert({
      organization_id: params.organizationId,
      payer_name: params.payerName,
      availity_payer_id: params.availityPayerId,
      payer_type: "commercial",
      is_active: true,
    })
    .select("id")
    .single();

  if (error || !inserted) return null;
  return String(inserted.id);
}

export async function createProfessionalClaimDraft(
  input: CreateClaimDraftInput
): Promise<CreateClaimDraftResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return { ok: false, claimId: null, errors: [{ field: "system", message: "Database connection not available" }] };
  }

  const errors: ClaimReadinessError[] = [];
  addRequired(errors, "organization_id", input.organizationId, "Organization is required");
  addRequired(errors, "client_id", input.clientId, "Client is required");
  addRequired(errors, "billing_provider.name", input.billingProvider.name, "Billing provider name is required");
  addRequired(errors, "billing_provider.npi", input.billingProvider.npi, "Billing provider NPI is required");
  addRequired(errors, "billing_provider.tax_id", input.billingProvider.taxId, "Billing provider tax ID is required");
  addRequired(errors, "billing_provider.address1", input.billingProvider.address1, "Billing provider address is required");
  addRequired(errors, "billing_provider.city", input.billingProvider.city, "Billing provider city is required");
  addRequired(errors, "billing_provider.state", input.billingProvider.state, "Billing provider state is required");
  addRequired(errors, "billing_provider.zip", input.billingProvider.zip, "Billing provider ZIP is required");

  // Format gates — block claim creation if format is invalid
  const npiVal = normalizeText(input.billingProvider.npi);
  if (npiVal && !/^\d{10}$/.test(npiVal)) {
    errors.push({ field: "billing_provider.npi", message: "Billing provider NPI must be exactly 10 digits" });
  }
  const stateVal = normalizeText(input.billingProvider.state);
  if (stateVal && !/^[A-Z]{2}$/.test(stateVal)) {
    errors.push({ field: "billing_provider.state", message: "Billing provider state must be a valid 2-character state code (e.g. CA, NY)" });
  }
  const zipVal = normalizeText(input.billingProvider.zip);
  if (zipVal && !/^\d{5}(?:-\d{4})?$/.test(zipVal)) {
    errors.push({ field: "billing_provider.zip", message: "Billing provider ZIP must be 5 or 9 digits (e.g. 12345 or 12345-6789)" });
  }
  if (input.billingProvider.address1 && /^p\.?\s*o\.?\s*box/i.test(normalizeText(input.billingProvider.address1))) {
    errors.push({ field: "billing_provider.address1", message: "Billing provider address must be a street address, not a PO Box" });
  }

  if (!input.diagnosisCodes.length) {
    errors.push({ field: "diagnosis_codes", message: "At least one diagnosis code is required" });
  }

  if (!input.serviceLines.length) {
    errors.push({ field: "service_lines", message: "At least one service line is required" });
  }

  for (const [index, line] of input.serviceLines.entries()) {
    if (!normalizeDate(line.serviceDate)) {
      errors.push({ field: `service_lines.${index}.service_date`, message: "Service line has invalid service date" });
    }
    addRequired(errors, `service_lines.${index}.procedure_code`, line.procedureCode, "Procedure code is required");
    if (!Number.isFinite(line.chargeAmount) || line.chargeAmount <= 0) {
      errors.push({ field: `service_lines.${index}.charge_amount`, message: "Charge amount must be greater than zero" });
    }
  }

  // Reference-table validation: reject any DX or CPT/HCPCS not present
  // in the seeded code tables, so claim creation can't introduce unbillable codes.
  const dxToCheck = [...new Set(input.diagnosisCodes.map((c) => normalizeText(c).toUpperCase()).filter(Boolean))];
  if (dxToCheck.length > 0) {
    const { data: dxRows } = await supabase
      .from("diagnosis_codes")
      .select("code")
      .eq("is_active", true)
      .in("code", dxToCheck);
    const known = new Set((dxRows ?? []).map((r: DbRecord) => String(r.code).toUpperCase()));
    for (const [index, raw] of input.diagnosisCodes.entries()) {
      const upper = normalizeText(raw).toUpperCase();
      if (upper && !known.has(upper)) {
        errors.push({ field: `diagnosis_codes.${index}`, message: `Unknown ICD-10 code: ${upper}` });
      }
    }
  }
  const procToCheck = [...new Set(
    input.serviceLines.map((l) => normalizeText(l.procedureCode).toUpperCase()).filter(Boolean),
  )];
  if (procToCheck.length > 0) {
    const { data: pxRows } = await supabase
      .from("procedure_codes")
      .select("code")
      .eq("is_active", true)
      .in("code", procToCheck);
    const known = new Set((pxRows ?? []).map((r: DbRecord) => String(r.code).toUpperCase()));
    for (const [index, line] of input.serviceLines.entries()) {
      const upper = normalizeText(line.procedureCode).toUpperCase();
      if (upper && !known.has(upper)) {
        errors.push({ field: `service_lines.${index}.procedure_code`, message: `Unknown CPT/HCPCS code: ${upper}` });
      }
    }
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, organization_id, first_name, last_name, date_of_birth, sex_at_birth, address_line_1, city, state, postal_code")
    .eq("id", input.clientId)
    .eq("organization_id", input.organizationId)
    .is("archived_at", null)
    .maybeSingle();

  if (clientError || !client) {
    errors.push({ field: "client", message: "Client not found" });
  }

  const policyResolution = await resolvePrimaryPolicy({
    organizationId: input.organizationId,
    clientId: input.clientId,
    policyId: input.policyId,
  });
  errors.push(...policyResolution.errors);

  const payer = policyResolution.payer;
  const subscriber = policyResolution.subscriber;

  if (payer && !normalizeText(payer.payer_id)) {
    errors.push({ field: "payer.payer_id", message: "Payer is missing clearinghouse payer ID" });
  }

  if (subscriber && !normalizeText(subscriber.member_id)) {
    errors.push({ field: "subscriber.member_id", message: "Subscriber is missing member ID" });
  }

  if (errors.length > 0) {
    return { ok: false, claimId: null, errors };
  }

  const payerProfileId = await ensurePayerProfile({
    organizationId: input.organizationId,
    payerName: normalizeText(payer!.payer_name),
    availityPayerId: normalizeText(payer!.payer_id),
  });

  const totalCharge = money(input.serviceLines.reduce((sum, line) => sum + line.chargeAmount * (line.units ?? 1), 0));
  const placeOfService = normalizeNullable(input.placeOfService) ?? "10";
  const patientAccountNumber = normalizeNullable(input.patientAccountNumber) ?? `PC-${Date.now()}`;
  const claimNumber = normalizeNullable(input.claimNumber) ?? `CLM-${Date.now()}`;

  const { data: claim, error: claimError } = await supabase
    .from("professional_claims")
    .insert({
      organization_id: input.organizationId,
      patient_id: input.clientId,
      appointment_id: input.appointmentId ?? undefined,
      payer_profile_id: payerProfileId,
      claim_number: claimNumber,
      patient_account_number: patientAccountNumber,
      claim_status: "ready_for_validation",
      total_charge: totalCharge,
      place_of_service: placeOfService,
      diagnosis_codes: input.diagnosisCodes,
      validation_errors: [],
    })
    .select("id")
    .single();

  if (claimError || !claim) {
    return {
      ok: false,
      claimId: null,
      errors: [{ field: "professional_claims", message: claimError?.message ?? "Failed to create professional claim" }],
    };
  }

  const claimId = String(claim.id);
  const serviceLinePayload = input.serviceLines.map((line, index) => ({
    claim_id: claimId,
    line_number: index + 1,
    service_date_from: line.serviceDate,
    service_date_to: line.serviceDate,
    procedure_code: normalizeText(line.procedureCode),
    modifiers: line.modifiers ?? [],
    charge_amount: money(line.chargeAmount),
    units: line.units ?? 1,
    diagnosis_pointers: line.diagnosisPointers ?? ["1"],
    place_of_service: normalizeNullable(line.placeOfService) ?? placeOfService,
    rendering_provider_npi: normalizeNullable(line.renderingProviderNpi),
    authorization_number: normalizeNullable(line.authorizationNumber),
  }));

  const { error: lineError } = await supabase.from("professional_claim_service_lines").insert(serviceLinePayload);
  if (lineError) {
    return { ok: false, claimId, errors: [{ field: "professional_claim_service_lines", message: lineError.message }] };
  }

  const subscriberAddress1 = normalizeNullable(client!.address_line_1) ?? input.billingProvider.address1;
  const subscriberCity = normalizeNullable(client!.city) ?? input.billingProvider.city;
  const subscriberState = normalizeNullable(client!.state) ?? input.billingProvider.state;
  const subscriberZip = normalizeNullable(client!.postal_code) ?? input.billingProvider.zip;

  const { error: snapshotError } = await supabase.from("claim_parties_snapshot").insert({
    claim_id: claimId,
    billing_provider_name: input.billingProvider.name,
    billing_provider_npi: input.billingProvider.npi,
    billing_provider_tax_id: input.billingProvider.taxId,
    billing_provider_tax_id_type: input.billingProvider.taxIdType ?? "EI",
    billing_provider_address1: input.billingProvider.address1,
    billing_provider_address2: normalizeNullable(input.billingProvider.address2),
    billing_provider_city: input.billingProvider.city,
    billing_provider_state: input.billingProvider.state,
    billing_provider_zip: input.billingProvider.zip,
    subscriber_last_name: normalizeText(subscriber!.last_name),
    subscriber_first_name: normalizeText(subscriber!.first_name),
    subscriber_member_id: normalizeText(subscriber!.member_id),
    subscriber_dob: normalizeDate(subscriber!.date_of_birth)!,
    subscriber_gender: "U",
    subscriber_address1: subscriberAddress1,
    subscriber_city: subscriberCity,
    subscriber_state: subscriberState,
    subscriber_zip: subscriberZip,
    patient_is_subscriber: true,
    payer_name: normalizeText(payer!.payer_name),
    payer_id: normalizeText(payer!.payer_id),
    rendering_same_as_billing: true,
    service_facility_same_as_billing: true,
  });

  if (snapshotError) {
    return { ok: false, claimId, errors: [{ field: "claim_parties_snapshot", message: snapshotError.message }] };
  }

  return { ok: true, claimId, errors: [] };
}

export async function validateProfessionalClaimReadiness(
  claimId: string,
  organizationId: string
): Promise<ClaimReadinessResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      status: "not_ready",
      claimId,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const errors: ClaimReadinessError[] = [];

  const { data: claim, error: claimError } = await supabase
    .from("professional_claims")
    .select("id, patient_id, payer_profile_id, claim_status, total_charge, place_of_service, diagnosis_codes")
    .eq("id", claimId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (claimError || !claim) {
    return {
      ok: false,
      status: "not_ready",
      claimId,
      errors: [{ field: "claim", message: "Professional claim not found" }],
    };
  }

  addRequired(errors, "claim.patient_id", claim.patient_id, "Claim is missing patient/client link");
  addRequired(errors, "claim.place_of_service", claim.place_of_service, "Claim is missing place of service");

  if (!Array.isArray(claim.diagnosis_codes) || claim.diagnosis_codes.length === 0) {
    errors.push({ field: "claim.diagnosis_codes", message: "Claim requires at least one diagnosis code" });
  }

  if (!Number.isFinite(Number(claim.total_charge)) || Number(claim.total_charge) <= 0) {
    errors.push({ field: "claim.total_charge", message: "Claim total charge must be greater than zero" });
  }

  const { data: lines } = await supabase
    .from("professional_claim_service_lines")
    .select("id, line_number, service_date_from, procedure_code, charge_amount, units, diagnosis_pointers, place_of_service, rendering_provider_npi")
    .eq("claim_id", claimId)
    .order("line_number", { ascending: true });

  // Reference-table validation: reject claims whose stored DX or CPT/HCPCS codes
  // are not in the seeded code tables (catches data loaded outside the UI).
  const dxOnClaim = Array.isArray(claim.diagnosis_codes)
    ? [...new Set((claim.diagnosis_codes as unknown[]).map((c) => normalizeText(c).toUpperCase()).filter(Boolean))]
    : [];
  if (dxOnClaim.length > 0) {
    const { data: dxRows } = await supabase
      .from("diagnosis_codes")
      .select("code")
      .eq("is_active", true)
      .in("code", dxOnClaim);
    const known = new Set((dxRows ?? []).map((r: DbRecord) => String(r.code).toUpperCase()));
    for (const code of dxOnClaim) {
      if (!known.has(code)) {
        errors.push({ field: "claim.diagnosis_codes", message: `Unknown ICD-10 code: ${code}` });
      }
    }
  }
  const procOnClaim = Array.isArray(lines)
    ? [...new Set((lines as DbRecord[]).map((l) => normalizeText(l.procedure_code).toUpperCase()).filter(Boolean))]
    : [];
  if (procOnClaim.length > 0) {
    const { data: pxRows } = await supabase
      .from("procedure_codes")
      .select("code")
      .eq("is_active", true)
      .in("code", procOnClaim);
    const known = new Set((pxRows ?? []).map((r: DbRecord) => String(r.code).toUpperCase()));
    for (const line of (lines ?? []) as DbRecord[]) {
      const code = normalizeText(line.procedure_code).toUpperCase();
      if (code && !known.has(code)) {
        errors.push({ field: `service_lines.${line.line_number}.procedure_code`, message: `Unknown CPT/HCPCS code: ${code}` });
      }
    }
  }

  if (!lines || lines.length === 0) {
    errors.push({ field: "service_lines", message: "Claim requires at least one service line" });
  } else {
    for (const line of lines as DbRecord[]) {
      addRequired(errors, `service_lines.${line.line_number}.service_date_from`, line.service_date_from, "Service date is required");
      addRequired(errors, `service_lines.${line.line_number}.procedure_code`, line.procedure_code, "Procedure code is required");
      if (!Number.isFinite(Number(line.charge_amount)) || Number(line.charge_amount) <= 0) {
        errors.push({ field: `service_lines.${line.line_number}.charge_amount`, message: "Service line charge must be greater than zero" });
      }
      if (!Number.isFinite(Number(line.units)) || Number(line.units) <= 0) {
        errors.push({ field: `service_lines.${line.line_number}.units`, message: "Service line units must be greater than zero" });
      }
      // Diagnosis pointer must reference a valid position (1-based, 1-8)
      const pointers = Array.isArray(line.diagnosis_pointers) ? line.diagnosis_pointers as unknown[] : [];
      if (pointers.length === 0) {
        errors.push({ field: `service_lines.${line.line_number}.diagnosis_pointers`, message: "Service line requires at least one diagnosis pointer" });
      } else {
        const diagCount = Array.isArray(claim.diagnosis_codes) ? (claim.diagnosis_codes as unknown[]).length : 0;
        for (const ptr of pointers) {
          const ptrNum = Number(ptr);
          if (!Number.isInteger(ptrNum) || ptrNum < 1 || ptrNum > diagCount) {
            errors.push({ field: `service_lines.${line.line_number}.diagnosis_pointers`, message: `Diagnosis pointer ${String(ptr)} does not reference a valid diagnosis position (1–${diagCount})` });
          }
        }
      }
      // Place of service required per line
      addRequired(errors, `service_lines.${line.line_number}.place_of_service`, line.place_of_service ?? claim.place_of_service, "Place of service is required");
    }
  }

  const { data: snapshot } = await supabase
    .from("claim_parties_snapshot")
    .select("*")
    .eq("claim_id", claimId)
    .maybeSingle();

  if (!snapshot) {
    errors.push({ field: "claim_parties_snapshot", message: "Claim is missing party snapshot" });
  } else {
    const requiredSnapshotFields = [
      ["billing_provider_name", "Billing provider name is required"],
      ["billing_provider_npi", "Billing provider NPI is required"],
      ["billing_provider_tax_id", "Billing provider tax ID is required"],
      ["billing_provider_address1", "Billing provider address is required"],
      ["billing_provider_city", "Billing provider city is required"],
      ["billing_provider_state", "Billing provider state is required"],
      ["billing_provider_zip", "Billing provider ZIP is required"],
      ["subscriber_last_name", "Subscriber last name is required"],
      ["subscriber_first_name", "Subscriber first name is required"],
      ["subscriber_member_id", "Subscriber member ID is required"],
      ["subscriber_dob", "Subscriber DOB is required"],
      ["subscriber_address1", "Subscriber address is required"],
      ["subscriber_city", "Subscriber city is required"],
      ["subscriber_state", "Subscriber state is required"],
      ["subscriber_zip", "Subscriber ZIP is required"],
      ["payer_name", "Payer name is required"],
      ["payer_id", "Payer clearinghouse ID is required"],
    ] as const;

    for (const [field, message] of requiredSnapshotFields) {
      addRequired(errors, `claim_parties_snapshot.${field}`, (snapshot as DbRecord)[field], message);
    }

    // Validate ZIP format (5-digit or 9-digit ZIP+4)
    const zipPattern = /^\d{5}(-?\d{4})?$/;
    for (const zipField of ["billing_provider_zip", "subscriber_zip", "patient_zip", "service_facility_zip"] as const) {
      const zipVal = normalizeText((snapshot as DbRecord)[zipField]);
      if (zipVal && !zipPattern.test(zipVal)) {
        errors.push({ field: `claim_parties_snapshot.${zipField}`, message: `${zipField} must be a valid 5 or 9-digit ZIP code` });
      }
    }

    // If rendering provider is different from billing, NPI is required
    if ((snapshot as DbRecord).rendering_same_as_billing === false) {
      addRequired(errors, "claim_parties_snapshot.rendering_provider_npi", (snapshot as DbRecord).rendering_provider_npi, "Rendering provider NPI is required when different from billing provider");
    }

    // Patient DOB is required
    if (!(snapshot as DbRecord).patient_is_subscriber) {
      addRequired(errors, "claim_parties_snapshot.patient_dob", (snapshot as DbRecord).patient_dob, "Patient date of birth is required");
    }

    // NPI format: billing provider NPI must be exactly 10 digits
    const billingNpi = normalizeText((snapshot as DbRecord).billing_provider_npi);
    if (billingNpi && !/^\d{10}$/.test(billingNpi)) {
      errors.push({ field: "claim_parties_snapshot.billing_provider_npi", message: "Billing provider NPI must be exactly 10 digits" });
    }

    // NPI format: rendering provider NPI when present
    const renderingNpi = normalizeText((snapshot as DbRecord).rendering_provider_npi);
    if (renderingNpi && !/^\d{10}$/.test(renderingNpi)) {
      errors.push({ field: "claim_parties_snapshot.rendering_provider_npi", message: "Rendering provider NPI must be exactly 10 digits" });
    }

    // PO Box is not permitted for billing provider address per 837P spec
    const billingAddr = normalizeText((snapshot as DbRecord).billing_provider_address1);
    if (billingAddr && /^p\.?\s*o\.?\s*box/i.test(billingAddr)) {
      errors.push({ field: "claim_parties_snapshot.billing_provider_address1", message: "Billing provider address must be a street address, not a PO Box" });
    }
  }


  const ready = errors.length === 0;
  await supabase
    .from("professional_claims")
    .update({
      claim_status: ready ? "ready_for_batch" : "validation_failed",
      validation_errors: errors,
      last_validated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", claimId);

  return {
    ok: ready,
    status: ready ? "ready" : "not_ready",
    claimId,
    errors,
  };
}
