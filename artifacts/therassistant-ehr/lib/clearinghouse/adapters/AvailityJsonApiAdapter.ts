// File: lib/clearinghouse/adapters/AvailityJsonApiAdapter.ts
// JSON-first Availity EDI Services adapter.
// Uses v2 for real-time eligibility/claim status and v1 for claims/health/payer-search where needed.

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  getAvailityAccessToken,
  type AvailityOAuthConfig,
} from "@/lib/edi/availity270/availityOAuth";
import { mapAvailityJsonTo271 } from "@/lib/edi/availity270/jsonToParsed271";
import { parsed271ToLegacyNormalized } from "@/lib/edi/availity270/parsedToLegacy";
import type { Eligibility270Input, Parsed271Response } from "@/lib/edi/availity270/types";
import type { EligibilityResponseNormalized } from "@/types/clearinghouse";
import type {
  AvailityApiResponse,
  AvailityClaimStatusRequest,
  AvailityClaimStatusResponse,
  AvailityEligibilityRequest,
  AvailityEligibilityResponse,
  AvailityPayerSearchOptionInfo,
  AvailityPayerSearchOptionLookupRequest,
} from "@/types/availityJsonApi";

type ApiRequestOptions = {
  organizationId?: string | null;
  operation: string;
  method?: "GET" | "POST";
  path: string;
  body?: unknown;
  accept?: "application/json" | "application/EDI-X12";
  contentType?: "application/json" | "text/plain";
  clientId?: string | null;
  claimId?: string | null;
  ediTransactionId?: string | null;
  idempotencyKey?: string | null;
};

type HealthCheckResult = {
  status: "healthy" | "degraded" | "down" | "unknown";
  httpStatus?: number | null;
  latencyMs: number;
  rawResponse?: string | null;
  errorMessage?: string | null;
};

// WARNING: This adapter was inherited from the Office Ally implementation.
// Availity exposes REST at https://api.availity.com/availity/v1 (with OAuth2
// client-credentials), which has different request/response shapes than
// Office Ally's edi.officeally.io JSON API. The base URL below is a
// placeholder to keep callers compiling; the REST adapter rewrite is a
// separate task.
const DEFAULT_BASE_URL = "https://api.availity.com/availity/v1";

function getBaseUrl() {
  return (process.env.AVAILITY_EDI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

function envApiKey() {
  return process.env.AVAILITY_EDI_API_KEY ?? null;
}

function getApiKeyHeaderName() {
  return process.env.AVAILITY_EDI_API_KEY_HEADER ?? "apiKey";
}

function uuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function buildHeaders(
  apiKey: string,
  accept: string,
  contentType: "application/json" | "text/plain",
  idempotencyKey?: string | null,
) {
  const headers: Record<string, string> = {
    [getApiKeyHeaderName()]: apiKey,
    Accept: accept,
    "Content-Type": contentType,
  };
  if (idempotencyKey) {
    // Common idempotency header conventions vary by clearinghouse; send both.
    headers["Idempotency-Key"] = idempotencyKey;
    headers["X-Idempotency-Key"] = idempotencyKey;
  }
  return headers;
}

function serializeBody(body: unknown, contentType: "application/json" | "text/plain") {
  if (body == null) return null;
  return contentType === "text/plain" ? String(body) : JSON.stringify(body);
}

async function insertApiAudit(input: {
  organizationId?: string | null;
  operation: string;
  transport?: string;
  endpointUrl: string;
  httpMethod: string;
  httpStatus?: number | null;
  requestPayload?: unknown;
  responsePayload?: unknown;
  requestBody?: string | null;
  responseBody?: string | null;
  rawResponseJson?: unknown;
  rawResponseX12?: string | null;
  status: "created" | "sent" | "received" | "parsed" | "failed";
  errorMessage?: string | null;
  startedAt: string;
  completedAt?: string | null;
  ediTransactionId?: string | null;
}) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase || !input.organizationId) return null;

  const { data } = await supabase
    .from("clearinghouse_api_requests")
    .insert({
      id: uuid(),
      organization_id: input.organizationId,
      vendor: "availity",
      operation: input.operation,
      transport: input.transport ?? "api",
      endpoint_url: input.endpointUrl,
      http_method: input.httpMethod,
      http_status: input.httpStatus ?? null,
      request_payload: (input.requestPayload ?? {}) as Record<string, unknown>,
      response_payload: (input.responsePayload ?? {}) as Record<string, unknown>,
      request_body: input.requestBody ?? null,
      response_body: input.responseBody ?? null,
      raw_response_json: (input.rawResponseJson ?? {}) as Record<string, unknown>,
      raw_response_x12: input.rawResponseX12 ?? null,
      edi_transaction_id: input.ediTransactionId ?? null,
      status: input.status,
      error_message: input.errorMessage ?? null,
      started_at: input.startedAt,
      completed_at: input.completedAt ?? new Date().toISOString(),
      created_at: input.startedAt,
    })
    .select()
    .maybeSingle();

  return data;
}

function normalizeEligibilityStatus(response: AvailityEligibilityResponse) {
  if (response.transactionErrors?.length) return "error";
  const code = response.responseStatus?.codeValue?.toLowerCase() ?? "";
  const description = response.responseStatus?.description?.toLowerCase() ?? "";
  if (code.includes("active") || description.includes("active")) return "active";
  if (code.includes("inactive") || description.includes("inactive")) return "inactive";
  if (description.includes("not found") || description.includes("no match")) return "not_found";
  return "unknown";
}

function normalizeInquiryStatus(response: AvailityClaimStatusResponse) {
  if (response.transactionErrors?.length) return "failed";
  const text = JSON.stringify(response).toLowerCase();
  if (text.includes("paid")) return "paid";
  if (text.includes("denied")) return "denied";
  if (text.includes("reject")) return "rejected";
  if (text.includes("pending") || text.includes("process")) return "pending";
  if (text.includes("accept")) return "received";
  return "unknown";
}

function normalizeClaimRecordStatus(inquiryStatus: string) {
  if (["paid", "denied", "rejected", "pending"].includes(inquiryStatus)) return inquiryStatus;
  if (inquiryStatus === "received" || inquiryStatus === "unknown") return "submitted";
  return "submitted";
}

function toNumber(value: unknown) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function benefitBuckets(response: AvailityEligibilityResponse) {
  const details = response.subscriber?.ebResponseDetails ?? response.dependent?.ebResponseDetails ?? null;
  if (!details) return [];

  const buckets = [
    "plans",
    "benefits",
    "benefitDescriptions",
    "exclusions",
    "limitations",
    "entities",
    "preExistingConditions",
    "disclaimers",
    "otherPayers",
    "miscellaneous",
    "cannotProcess",
    "otherSourceOfData",
  ] as const;

  return buckets.flatMap((bucket) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((details as Record<string, unknown>)[bucket] as unknown[] | undefined ?? []).map((item) => ({ bucket, item: item as Record<string, any> })),
  );
}

async function persistEligibilityResponse(params: {
  organizationId: string;
  clientId: string;
  appointmentId?: string | null;
  insurancePolicyId?: string | null;
  request: AvailityEligibilityRequest;
  response: AvailityEligibilityResponse;
  rawX12?: string | null;
}) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const now = new Date().toISOString();
  const status = normalizeEligibilityStatus(params.response);

  const { data: eligibility, error } = await supabase
    .from("eligibility_checks")
    .insert({
      id: uuid(),
      organization_id: params.organizationId,
      client_id: params.clientId,
      appointment_id: params.appointmentId ?? null,
      insurance_policy_id: params.insurancePolicyId ?? null,
      payer_name: params.response.oaPayer?.name ?? params.response.responsePayer?.name ?? null,
      payer_id: params.response.oaPayer?.payerId ?? params.response.responsePayer?.payerId ?? params.request.payerId ?? null,
      service_type_code: Array.isArray(params.request.serviceTypeCodes) ? params.request.serviceTypeCodes[0] : "98",
      eligibility_status: status,
      plan_name: params.response.subscriber?.planName ?? null,
      member_id: params.response.subscriber?.memberId ?? params.request.subscriber?.memberId ?? null,
      subscriber_name: [params.response.subscriber?.firstName, params.response.subscriber?.lastName].filter(Boolean).join(" ") || null,
      raw_response_json: params.response as Record<string, unknown>,
      raw_response_x12: params.rawX12 ?? params.response.x12 ?? null,
      availity_transaction_id: params.response.transactionId ?? null,
      response_status_code: params.response.responseStatus?.codeValue ?? null,
      response_status_description: params.response.responseStatus?.description ?? null,
      raw_benefits: params.response as Record<string, unknown>,
      checked_at: now,
      created_at: now,
    })
    .select()
    .single();

  if (error) throw error;

  const benefitRows = benefitBuckets(params.response).map(({ bucket, item }) => ({
    id: uuid(),
    organization_id: params.organizationId,
    eligibility_check_id: eligibility.id,
    client_id: params.clientId,
    payer_id: params.response.oaPayer?.payerId ?? params.request.payerId ?? null,
    payer_name: params.response.oaPayer?.name ?? null,
    service_type_code: item.serviceTypeCodes?.[0]?.codeValue ?? null,
    service_type_description: item.serviceTypeCodes?.[0]?.description ?? null,
    benefit_information_code: item.benefitInformationCode?.codeValue ?? null,
    benefit_description: item.benefitInformationCode?.description ?? bucket,
    coverage_level_code: item.coverageLevel?.codeValue ?? null,
    insurance_type_code: item.insuranceTypeCode?.codeValue ?? null,
    plan_coverage_description: item.planCoverageDescription ?? null,
    time_period_qualifier: item.timePeriod?.codeValue ?? null,
    monetary_amount: toNumber(item.monetaryAmount),
    percent_amount: toNumber(item.percent),
    quantity_qualifier: item.quantityType?.codeValue ?? null,
    quantity: toNumber(item.quantity),
    authorization_or_certification_required: item.requiresAuthorization?.codeValue ? item.requiresAuthorization.codeValue !== "N" : null,
    in_plan_network_indicator: item.networkIndicator?.codeValue ?? null,
    messages: item.messages ?? [],
    raw_eb_segment: item,
    created_at: now,
  }));

  if (benefitRows.length) {
    const { error: benefitError } = await supabase.from("eligibility_benefit_segments").insert(benefitRows);
    if (benefitError) throw benefitError;
  }

  if (params.response.transactionErrors?.length) {
    const events = params.response.transactionErrors.map((err) => ({
      id: uuid(),
      organization_id: params.organizationId,
      client_id: params.clientId,
      event_type: "eligibility_result",
      severity: "error",
      source: "clearinghouse",
      title: `Eligibility error ${err.rejectReason?.codeValue ?? "unknown"}`,
      message: err.rejectReason?.description ?? err.followUpAction?.description ?? "Eligibility transaction error.",
      normalized_code: err.rejectReason?.codeValue ?? null,
      raw_codes: err as Record<string, unknown>,
      is_resolved: false,
      created_at: now,
    }));
    const { error: eventError } = await supabase.from("clearinghouse_response_events").insert(events);
    if (eventError) throw eventError;
  }

  return eligibility;
}

function arrayify<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function collectClaimStatusLines(response: AvailityClaimStatusResponse) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topLevel = arrayify(response.statusInformation as any).map((item) => ({ item, serviceLine: null }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const serviceLines = (response.serviceLines ?? []).flatMap((line: any) => [
    ...arrayify(line.statusInformation).map((item) => ({ item, serviceLine: line })),
    ...arrayify(line.lineStatusInformation).map((item) => ({ item, serviceLine: line })),
  ]);
  return [...topLevel, ...serviceLines];
}

async function persistClaimStatusResponse(params: {
  organizationId: string;
  clientId: string;
  claimId: string;
  request: AvailityClaimStatusRequest;
  response: AvailityClaimStatusResponse;
  rawX12?: string | null;
}) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const now = new Date().toISOString();
  const inquiryStatus = normalizeInquiryStatus(params.response);

  const { data: inquiry, error } = await supabase
    .from("claim_status_inquiries")
    .insert({
      id: uuid(),
      organization_id: params.organizationId,
      claim_id: params.claimId,
      client_id: params.clientId,
      inquiry_status: inquiryStatus,
      external_transaction_id: params.response.transactionId ?? null,
      payer_status_code: params.response.responseStatus?.codeValue ?? null,
      payer_status_text: params.response.responseStatus?.description ?? null,
      response_summary: params.response.responseStatus?.description ?? inquiryStatus,
      requested_at: now,
      received_at: now,
      raw_response_json: params.response as Record<string, unknown>,
      raw_response_x12: params.rawX12 ?? params.response.x12 ?? null,
      availity_transaction_id: params.response.transactionId ?? null,
      response_status_code: params.response.responseStatus?.codeValue ?? null,
      response_status_description: params.response.responseStatus?.description ?? null,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) throw error;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = collectClaimStatusLines(params.response).map(({ item, serviceLine }: any) => ({
    id: uuid(),
    organization_id: params.organizationId,
    claim_status_inquiry_id: inquiry.id,
    claim_id: params.claimId,
    client_id: params.clientId,
    payer_id: params.response.oaPayer?.payerId ?? params.request.payerId ?? null,
    payer_name: params.response.oaPayer?.name ?? null,
    status_category_code: item.statusCategory?.codeValue ?? item.statusCategoryCode ?? null,
    status_code: item.statusCode?.codeValue ?? item.statusCode ?? null,
    entity_code: item.entityCode?.codeValue ?? item.entityCode ?? null,
    status_effective_date: item.statusEffectiveDate ?? null,
    total_charge_amount: toNumber(item.totalChargeAmount),
    paid_amount: toNumber(item.paidAmount),
    check_eft_number: item.checkEftNumber ?? null,
    payer_claim_control_number: item.payerClaimControlNumber ?? null,
    service_date_from: item.serviceDateFrom ?? null,
    service_date_to: item.serviceDateTo ?? null,
    message: item.message ?? item.statusMessage ?? null,
    raw_stc_segment: { status: item, serviceLine },
    created_at: now,
  }));

  if (rows.length) {
    const { error: rowError } = await supabase.from("claim_status_response_lines").insert(rows);
    if (rowError) throw rowError;
  }

  if (params.response.transactionErrors?.length) {
    const events = params.response.transactionErrors.map((err) => ({
      id: uuid(),
      organization_id: params.organizationId,
      client_id: params.clientId,
      claim_id: params.claimId,
      event_type: "status_update",
      severity: "error",
      source: "clearinghouse",
      title: `Claim status error ${err.rejectReason?.codeValue ?? "unknown"}`,
      message: err.rejectReason?.description ?? err.followUpAction?.description ?? "Claim status transaction error.",
      normalized_code: err.rejectReason?.codeValue ?? null,
      raw_codes: err as Record<string, unknown>,
      is_resolved: false,
      created_at: now,
    }));
    const { error: eventError } = await supabase.from("clearinghouse_response_events").insert(events);
    if (eventError) throw eventError;
  }

  await supabase
    .from("claims")
    .update({ claim_status: normalizeClaimRecordStatus(inquiryStatus), updated_at: now })
    .eq("id", params.claimId);

  return inquiry;
}

export class AvailityJsonApiAdapter {
  readonly vendor = "availity" as const;
  readonly baseUrl: string;
  private readonly overrideApiKey: string | null;

  constructor(opts?: { apiKey?: string | null; baseUrl?: string | null }) {
    this.overrideApiKey = opts?.apiKey ?? null;
    const rawBase = opts?.baseUrl ?? null;
    this.baseUrl = rawBase ? rawBase.replace(/\/$/, "") : getBaseUrl();
  }

  /** Returns the API key for this adapter instance, falling back to the env-var if no
   *  per-instance credential was injected. Throws when neither source is configured. */
  private getApiKey(): string {
    const key = this.overrideApiKey ?? envApiKey();
    if (!key) {
      throw new Error(
        "No Availity API key configured. Set one via /settings/clearinghouse (preferred — stored in Vault) " +
          "or set AVAILITY_EDI_API_KEY as a legacy fallback.",
      );
    }
    return key;
  }

  private async request<T>(options: ApiRequestOptions): Promise<{ data: T; rawText: string; httpStatus: number }> {
    const startedAt = new Date().toISOString();
    const endpointUrl = `${this.baseUrl}${options.path}`;
    const method = options.method ?? "POST";
    const accept = options.accept ?? "application/json";
    const contentType = options.contentType ?? "application/json";
    const bodyText = serializeBody(options.body, contentType);

    try {
      const response = await fetch(endpointUrl, {
        method,
        headers: buildHeaders(this.getApiKey(), accept, contentType, options.idempotencyKey),
        body: method === "GET" ? undefined : bodyText,
      });
      const rawText = await response.text();
      let parsed: unknown = rawText;
      if (rawText && response.headers.get("content-type")?.includes("application/json")) {
        parsed = JSON.parse(rawText);
      }

      await insertApiAudit({
        organizationId: options.organizationId,
        operation: options.operation,
        endpointUrl,
        httpMethod: method,
        httpStatus: response.status,
        requestPayload: contentType === "text/plain" ? {} : options.body,
        responsePayload: typeof parsed === "object" && parsed !== null ? parsed : {},
        requestBody: bodyText,
        responseBody: rawText,
        rawResponseJson: typeof parsed === "object" && parsed !== null ? parsed : {},
        rawResponseX12: accept === "application/EDI-X12" ? rawText : null,
        status: response.ok ? "parsed" : "failed",
        errorMessage: response.ok ? null : rawText.slice(0, 1000),
        startedAt,
        completedAt: new Date().toISOString(),
        ediTransactionId: options.ediTransactionId ?? null,
      });

      if (!response.ok) {
        throw new Error(`Availity API ${options.operation} failed ${response.status}: ${rawText.slice(0, 1000)}`);
      }

      return { data: parsed as T, rawText, httpStatus: response.status };
    } catch (error) {
      await insertApiAudit({
        organizationId: options.organizationId,
        operation: options.operation,
        endpointUrl,
        httpMethod: method,
        requestPayload: contentType === "text/plain" ? {} : options.body,
        requestBody: bodyText,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Availity request failed",
        startedAt,
        completedAt: new Date().toISOString(),
        ediTransactionId: options.ediTransactionId ?? null,
      });
      throw error;
    }
  }

  async healthCheck(organizationId?: string | null): Promise<HealthCheckResult> {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const endpointUrl = `${this.baseUrl}/`;
    const supabase = createServerSupabaseAdminClient();

    try {
      const response = await fetch(endpointUrl, { method: "GET", headers: { [getApiKeyHeaderName()]: this.getApiKey() } });
      const raw = await response.text();
      const latencyMs = Date.now() - started;
      const result: HealthCheckResult = {
        status: response.ok ? "healthy" : "degraded",
        httpStatus: response.status,
        latencyMs,
        rawResponse: raw,
      };

      if (supabase) {
        await supabase.from("clearinghouse_health_checks").insert({
          id: uuid(),
          organization_id: organizationId ?? null,
          vendor: "availity",
          endpoint_name: "RealTime_HealthCheck",
          endpoint_url: endpointUrl,
          transport: "api",
          status: result.status,
          http_status: response.status,
          latency_ms: latencyMs,
          raw_response: raw,
          checked_at: startedAt,
          created_at: startedAt,
        });
      }

      return result;
    } catch (error) {
      const latencyMs = Date.now() - started;
      const message = error instanceof Error ? error.message : "Health check failed";
      if (supabase) {
        await supabase.from("clearinghouse_health_checks").insert({
          id: uuid(),
          organization_id: organizationId ?? null,
          vendor: "availity",
          endpoint_name: "RealTime_HealthCheck",
          endpoint_url: endpointUrl,
          transport: "api",
          status: "down",
          latency_ms: latencyMs,
          error_message: message,
          checked_at: startedAt,
          created_at: startedAt,
        });
      }
      return { status: "down", latencyMs, errorMessage: message };
    }
  }

  async runEligibility(params: {
    organizationId: string;
    clientId: string;
    appointmentId?: string | null;
    insurancePolicyId?: string | null;
    request: AvailityEligibilityRequest;
  }) {
    const response = await this.request<AvailityApiResponse<AvailityEligibilityResponse>>({
      organizationId: params.organizationId,
      operation: "RealTimeV2_RealTimeEligibility",
      path: "/v2/eligibility-benefits",
      body: params.request,
    });

    const payload = response.data.data ?? (response.data as AvailityEligibilityResponse);
    const eligibility = await persistEligibilityResponse({
      organizationId: params.organizationId,
      clientId: params.clientId,
      appointmentId: params.appointmentId,
      insurancePolicyId: params.insurancePolicyId,
      request: params.request,
      response: payload,
      rawX12: payload.x12 ?? null,
    });

    return { eligibility, normalized: payload, raw: response.rawText };
  }

  async runClaimStatus(params: {
    organizationId: string;
    clientId: string;
    claimId: string;
    request: AvailityClaimStatusRequest;
  }) {
    const response = await this.request<AvailityApiResponse<AvailityClaimStatusResponse>>({
      organizationId: params.organizationId,
      operation: "RealTimeV2_ClaimStatus",
      path: "/v2/claim-status",
      body: params.request,
      claimId: params.claimId,
      clientId: params.clientId,
    });

    const payload = response.data.data ?? (response.data as AvailityClaimStatusResponse);
    const inquiry = await persistClaimStatusResponse({
      organizationId: params.organizationId,
      clientId: params.clientId,
      claimId: params.claimId,
      request: params.request,
      response: payload,
      rawX12: payload.x12 ?? null,
    });

    return { inquiry, normalized: payload, raw: response.rawText };
  }

  async fetchPayerSearchOptions(params: { organizationId?: string | null; payerIds?: string[] | null }) {
    const response = await this.request<AvailityPayerSearchOptionInfo[]>({
      organizationId: params.organizationId,
      operation: "RealTime_PayerSearchOptionLookup",
      path: "/v1/realtime-eligibility/payer/search-options",
      body: { payerIds: params.payerIds ?? [] } satisfies AvailityPayerSearchOptionLookupRequest,
    });

    const supabase = createServerSupabaseAdminClient();
    if (supabase) {
      const now = new Date().toISOString();
      for (const item of response.data ?? []) {
        const payerId = item.payerId ?? "unknown";
        await supabase
          .from("payer_search_option_configs")
          .update({ archived_at: now, updated_at: now })
          .eq("vendor", "availity")
          .eq("payer_id", payerId)
          .is("archived_at", null);

        await supabase.from("payer_search_option_configs").insert({
          id: uuid(),
          organization_id: params.organizationId ?? null,
          vendor: "availity",
          payer_id: payerId,
          payer_name: item.payerName ?? null,
          search_options: item.searchOptions ?? [],
          raw_response_json: item as Record<string, unknown>,
          fetched_at: now,
          created_at: now,
          updated_at: now,
        });
      }
    }

    return response.data;
  }

  async submitProfessionalX12(params: { organizationId: string; x12: string; idempotencyKey?: string | null }) {
    return this.request({
      organizationId: params.organizationId,
      operation: "Claim_SubmitProfessionalX12",
      path: "/v1/claims/professional/x12",
      body: params.x12,
      contentType: "text/plain",
      idempotencyKey: params.idempotencyKey ?? null,
    });
  }

  /**
   * CORE-compliant eligibility via the Availity REST Coverages API
   * (OAuth2 client_credentials). Returns the same `Parsed271Response`
   * shape produced by the SOAP/X12 path so downstream consumers can
   * ignore transport.
   *
   * Endpoint defaults to `${baseUrl}/availity/v1/coverages` (overridable
   * via `AVAILITY_COVERAGES_PATH`). Credentials come from
   * `AVAILITY_OAUTH_CLIENT_ID` / `AVAILITY_OAUTH_CLIENT_SECRET` unless
   * passed in via `oauth`. The request body mirrors the rich
   * `Eligibility270Input` so the same caller can target either transport.
   */
  async runCoverages(params: {
    organizationId: string;
    clientId: string;
    appointmentId?: string | null;
    insurancePolicyId?: string | null;
    eligibility: Eligibility270Input;
    oauth?: AvailityOAuthConfig;
    coveragesPath?: string;
  }): Promise<{
    parsed: Parsed271Response;
    normalized: EligibilityResponseNormalized;
    raw: string;
    httpStatus: number;
    rawJson: AvailityEligibilityResponse;
  }> {
    const oauth: AvailityOAuthConfig = params.oauth ?? {
      clientId: process.env.AVAILITY_OAUTH_CLIENT_ID ?? "",
      clientSecret: process.env.AVAILITY_OAUTH_CLIENT_SECRET ?? "",
      tokenUrl: process.env.AVAILITY_OAUTH_TOKEN_URL ?? undefined,
      scope: process.env.AVAILITY_OAUTH_SCOPE ?? undefined,
    };
    if (!oauth.clientId || !oauth.clientSecret) {
      throw new Error(
        "Availity Coverages REST requires AVAILITY_OAUTH_CLIENT_ID and AVAILITY_OAUTH_CLIENT_SECRET (or oauth override).",
      );
    }

    const token = await getAvailityAccessToken(oauth);
    // baseUrl already includes `/availity/v1` by default; the Coverages REST
    // endpoint is therefore just `/coverages` relative to it. Override via
    // AVAILITY_COVERAGES_PATH if the deployed Availity tenant publishes a
    // different path (e.g., `/coverages` under a v2 base).
    const path = params.coveragesPath ?? process.env.AVAILITY_COVERAGES_PATH ?? "/coverages";
    const endpointUrl = `${this.baseUrl}${path}`;
    const startedAt = new Date().toISOString();
    const e = params.eligibility;

    const requestBody = {
      payerId: e.informationSource.payerId,
      provider: {
        npi: e.informationReceiver.npi,
        lastName: e.informationReceiver.lastNameOrOrg,
        firstName: e.informationReceiver.firstName ?? undefined,
      },
      subscriber: {
        firstName: e.subscriber.firstName,
        lastName: e.subscriber.lastName,
        memberId: e.subscriber.memberId,
        dob: e.subscriber.dob,
        gender: e.subscriber.gender ?? undefined,
      },
      serviceTypeCodes: e.serviceTypeCodes,
      asOfDate: e.serviceDate ?? undefined,
    } satisfies AvailityEligibilityRequest;

    const bodyText = JSON.stringify(requestBody);
    let response: Response;
    let rawText = "";
    try {
      response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          Authorization: `${token.tokenType} ${token.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: bodyText,
      });
      rawText = await response.text();
    } catch (err) {
      await insertApiAudit({
        organizationId: params.organizationId,
        operation: "RealTimeV1_Coverages",
        endpointUrl,
        httpMethod: "POST",
        requestPayload: requestBody as Record<string, unknown>,
        requestBody: bodyText,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Coverages request failed",
        startedAt,
      });
      throw err;
    }

    let parsedJson: AvailityEligibilityResponse;
    try {
      parsedJson = JSON.parse(rawText) as AvailityEligibilityResponse;
    } catch {
      await insertApiAudit({
        organizationId: params.organizationId,
        operation: "RealTimeV1_Coverages",
        endpointUrl,
        httpMethod: "POST",
        httpStatus: response.status,
        requestPayload: requestBody as Record<string, unknown>,
        requestBody: bodyText,
        responseBody: rawText,
        status: "failed",
        errorMessage: "Coverages response was not JSON",
        startedAt,
      });
      throw new Error(`Availity Coverages response was not JSON (${response.status}): ${rawText.slice(0, 300)}`);
    }

    await insertApiAudit({
      organizationId: params.organizationId,
      operation: "RealTimeV1_Coverages",
      endpointUrl,
      httpMethod: "POST",
      httpStatus: response.status,
      requestPayload: requestBody as Record<string, unknown>,
      responsePayload: parsedJson as Record<string, unknown>,
      requestBody: bodyText,
      responseBody: rawText,
      rawResponseJson: parsedJson as Record<string, unknown>,
      rawResponseX12: parsedJson.x12 ?? null,
      status: response.ok ? "parsed" : "failed",
      errorMessage: response.ok ? null : rawText.slice(0, 500),
      startedAt,
    });

    if (!response.ok) {
      throw new Error(`Availity Coverages failed ${response.status}: ${rawText.slice(0, 500)}`);
    }

    const parsed = mapAvailityJsonTo271(parsedJson);
    const normalized = parsed271ToLegacyNormalized(parsed, e.serviceTypeCodes[0] ?? "98");
    return { parsed, normalized, raw: rawText, httpStatus: response.status, rawJson: parsedJson };
  }

  async fetchEra835(params: { organizationId: string }): Promise<{ raw835: string; fileName: string }> {
    const response = await this.request<string>({
      organizationId: params.organizationId,
      operation: "ERA_DownloadLatest",
      method: "GET",
      path: "/v1/era/download",
      accept: "application/EDI-X12",
    });
    return { raw835: response.rawText, fileName: `era835-${new Date().toISOString().slice(0, 10)}.835` };
  }
}
