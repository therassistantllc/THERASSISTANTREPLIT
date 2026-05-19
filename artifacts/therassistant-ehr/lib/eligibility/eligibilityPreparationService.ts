import "server-only";

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  completeAvailityTransactionLog,
  createAvailityTransactionLog,
} from "@/lib/availity/transactionLogger";

const DEFAULT_SERVICE_TYPE_CODE = "98";
const DEFAULT_SERVICE_TYPE_DESCRIPTION = "Professional Services";

type RequestMode = "mock" | "demo" | "production";

export interface PrepareEligibilityRequestInput {
  organization_id?: string | null;
  patient_id?: string | null;
  payer_configuration_id?: string | null;
  payer_id?: string | null;
  payer_name?: string | null;
  provider_npi?: string | null;
  subscriber_id?: string | null;
  subscriber_first_name?: string | null;
  subscriber_last_name?: string | null;
  subscriber_dob?: string | null;
  patient_first_name?: string | null;
  patient_last_name?: string | null;
  patient_dob?: string | null;
  request_mode?: RequestMode;
}

interface MockEligibilityResponseInput {
  payerId?: string | null;
  payerName?: string | null;
}

export interface PrepareEligibilityResult {
  requestId: string;
  status: string;
  payerId: string | null;
  payerName: string | null;
  serviceTypeCode: string;
  serviceTypeDescription: string;
  eligibilityStatus: string | null;
  copayAmount: number | null;
  deductibleRemaining: number | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  isMock: boolean;
}

type JsonLike =
  | string
  | number
  | boolean
  | null
  | JsonLike[]
  | { [key: string]: JsonLike };

const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|password|api[_-]?key|client[_-]?id|client[_-]?secret|bearer)/i;

function sanitizeValue(value: unknown): JsonLike {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (typeof value === "object") {
    const sanitized: { [key: string]: JsonLike } = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = sanitizeValue(raw);
      }
    }
    return sanitized;
  }

  return String(value);
}

function parseRequestMode(inputMode?: string | null): RequestMode {
  if (inputMode === "demo" || inputMode === "production" || inputMode === "mock") {
    return inputMode;
  }
  return "mock";
}

function normalizeResult(row: Record<string, unknown>, isMock: boolean): PrepareEligibilityResult {
  return {
    requestId: String(row.id),
    status: String(row.status ?? "created"),
    payerId: row.payer_id ? String(row.payer_id) : null,
    payerName: row.payer_name ? String(row.payer_name) : null,
    serviceTypeCode: String(row.service_type_code ?? DEFAULT_SERVICE_TYPE_CODE),
    serviceTypeDescription: String(
      row.service_type_description ?? DEFAULT_SERVICE_TYPE_DESCRIPTION
    ),
    eligibilityStatus: row.eligibility_status ? String(row.eligibility_status) : null,
    copayAmount:
      typeof row.copay_amount === "number"
        ? row.copay_amount
        : row.copay_amount
          ? Number(row.copay_amount)
          : null,
    deductibleRemaining:
      typeof row.deductible_remaining === "number"
        ? row.deductible_remaining
        : row.deductible_remaining
          ? Number(row.deductible_remaining)
          : null,
    effectiveDate: row.effective_date ? String(row.effective_date) : null,
    terminationDate: row.termination_date ? String(row.termination_date) : null,
    isMock,
  };
}

export function createMockEligibilityResponse(
  input: MockEligibilityResponseInput
): Record<string, JsonLike> {
  const today = new Date();
  const year = today.getUTCFullYear();
  const effectiveDate = `${year}-01-01`;
  const terminationDate = `${year}-12-31`;

  return {
    eligibility_status: "active",
    payer_id: input.payerId ?? null,
    payer_name: input.payerName ?? null,
    service_type_code: DEFAULT_SERVICE_TYPE_CODE,
    service_type_description: DEFAULT_SERVICE_TYPE_DESCRIPTION,
    copay_amount: 25,
    deductible_remaining: 600,
    effective_date: effectiveDate,
    termination_date: terminationDate,
    source: "mock",
  };
}

export async function prepareEligibilityRequest(
  input: PrepareEligibilityRequestInput
): Promise<PrepareEligibilityResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    throw new Error("Database connection not available");
  }

  const requestMode = parseRequestMode(input.request_mode);
  const isMock = requestMode === "mock";

  let organizationId = input.organization_id ?? null;
  let payerConfigurationId = input.payer_configuration_id ?? null;
  let payerId = input.payer_id ?? null;
  let payerName = input.payer_name ?? null;

  if (payerConfigurationId) {
    const { data: payerConfig, error: payerConfigError } = await supabase
      .from("payer_configurations")
      .select("id, organization_id, payer_id, payer_name")
      .eq("id", payerConfigurationId)
      .maybeSingle();

    if (payerConfigError) {
      const message = payerConfigError?.message || "";
      if (message.includes("Could not find the table") || message.includes("does not exist")) {
        throw new Error("Payer configuration table not initialized. Migration pending.");
      }
      throw new Error("Failed to load payer configuration");
    }

    if (!payerConfig) {
      throw new Error("Payer configuration not found");
    }

    payerConfigurationId = String(payerConfig.id);
    organizationId = organizationId ?? (payerConfig.organization_id ? String(payerConfig.organization_id) : null);
    payerId = payerConfig.payer_id ? String(payerConfig.payer_id) : payerId;
    payerName = payerConfig.payer_name ? String(payerConfig.payer_name) : payerName;
  }

  const safeRequestPayload = sanitizeValue({
    organization_id: organizationId,
    patient_id: input.patient_id ?? null,
    payer_configuration_id: payerConfigurationId,
    payer_id: payerId,
    payer_name: payerName,
    provider_npi: input.provider_npi ?? null,
    subscriber_id: input.subscriber_id ?? null,
    subscriber_first_name: input.subscriber_first_name ?? null,
    subscriber_last_name: input.subscriber_last_name ?? null,
    subscriber_dob: input.subscriber_dob ?? null,
    patient_first_name: input.patient_first_name ?? null,
    patient_last_name: input.patient_last_name ?? null,
    patient_dob: input.patient_dob ?? null,
    service_type_code: DEFAULT_SERVICE_TYPE_CODE,
    service_type_description: DEFAULT_SERVICE_TYPE_DESCRIPTION,
    request_mode: requestMode,
  });

  const { data: created, error: createError } = await supabase
    .from("eligibility_requests")
    .insert({
      organization_id: organizationId,
      patient_id: input.patient_id ?? null,
      payer_configuration_id: payerConfigurationId,
      payer_id: payerId,
      payer_name: payerName,
      provider_npi: input.provider_npi ?? null,
      subscriber_id: input.subscriber_id ?? null,
      subscriber_first_name: input.subscriber_first_name ?? null,
      subscriber_last_name: input.subscriber_last_name ?? null,
      subscriber_dob: input.subscriber_dob ?? null,
      patient_first_name: input.patient_first_name ?? null,
      patient_last_name: input.patient_last_name ?? null,
      patient_dob: input.patient_dob ?? null,
      service_type_code: DEFAULT_SERVICE_TYPE_CODE,
      service_type_description: DEFAULT_SERVICE_TYPE_DESCRIPTION,
      request_mode: requestMode,
      status: "created",
      request_payload_safe: safeRequestPayload,
    })
    .select("*")
    .single();

  if (createError || !created) {
    const message = createError?.message || "";
    if (message.includes("Could not find the table") || message.includes("does not exist")) {
      throw new Error("Eligibility request table not initialized. Migration pending.");
    }
    throw new Error("Failed to create eligibility request");
  }

  if (!isMock) {
    const { data: prepared, error: preparedError } = await supabase
      .from("eligibility_requests")
      .update({
        status: "prepared",
        updated_at: new Date().toISOString(),
      })
      .eq("id", created.id)
      .select("*")
      .single();

    if (preparedError || !prepared) {
      throw new Error("Failed to prepare eligibility request");
    }

    return normalizeResult(prepared as Record<string, unknown>, false);
  }

  const mockResponse = createMockEligibilityResponse({
    payerId,
    payerName,
  });

  const transactionId = await createAvailityTransactionLog({
    organizationId: organizationId ?? undefined,
    patientId: input.patient_id ?? undefined,
    payerId: payerId ?? undefined,
    payerName: payerName ?? undefined,
    transactionType: "eligibility_270",
    transactionDirection: "outbound",
    environment: "demo",
    requestMethod: "POST",
    requestUrl: "/mock/eligibility/270",
    requestBody: safeRequestPayload,
  });

  if (transactionId) {
    await completeAvailityTransactionLog({
      transactionId,
      responseStatus: 200,
      responseBody: mockResponse,
    });
  }

  const { data: completed, error: completedError } = await supabase
    .from("eligibility_requests")
    .update({
      status: "completed",
      service_type_code: DEFAULT_SERVICE_TYPE_CODE,
      service_type_description: DEFAULT_SERVICE_TYPE_DESCRIPTION,
      availity_transaction_id: transactionId,
      response_payload_safe: sanitizeValue(mockResponse),
      eligibility_status: String(mockResponse.eligibility_status),
      copay_amount: Number(mockResponse.copay_amount),
      deductible_remaining: Number(mockResponse.deductible_remaining),
      effective_date: String(mockResponse.effective_date),
      termination_date: String(mockResponse.termination_date),
      updated_at: new Date().toISOString(),
    })
    .eq("id", created.id)
    .select("*")
    .single();

  if (completedError || !completed) {
    throw new Error("Failed to finalize mock eligibility request");
  }

  return normalizeResult(completed as Record<string, unknown>, true);
}
