import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

// ── Constants ──────────────────────────────────────────────────────────────────

export const DEFAULT_SERVICE_TYPE_CODE = "98";
export const DEFAULT_SERVICE_TYPE_DESCRIPTION = "Professional Services";
export const ELIGIBILITY_RECHECK_DAYS = 30;

// ── Types ──────────────────────────────────────────────────────────────────────

export type EligibilityStatus = "not_checked" | "active" | "inactive" | "pending" | "error";

export type EligibilityComputedStatus =
  | "not_checked"
  | "stale"
  | "active"
  | "inactive"
  | "pending"
  | "error";

export interface EligibilityValidationError {
  field: string;
  message: string;
}

export interface EligibilityCheckInput {
  clientId: string;
  organizationId: string;
  /** Optional — linked appointment, if running pre-appointment eligibility */
  appointmentId?: string | null;
  /** Override service type code. Defaults to "98" (Professional Services). */
  serviceTypeCode?: string | null;
  /**
   * Mode controls whether a live clearinghouse call is attempted.
   * "mock" stores a placeholder record without a live request.
   * Future: "live" will submit to Office Ally 270.
   */
  mode?: "mock" | "live";
}

export interface ResolvedEligibilityInput {
  clientId: string;
  organizationId: string;
  clientFirstName: string;
  clientLastName: string;
  clientDob: string;
  policyId: string;
  payerId: string | null;
  payerName: string | null;
  subscriberMemberId: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  subscriberDob: string;
  serviceTypeCode: string;
}

export interface CreateEligibilityCheckResult {
  ok: boolean;
  checkId: string | null;
  resolvedInput: ResolvedEligibilityInput | null;
  errors: EligibilityValidationError[];
}

export interface LatestEligibilityCheckResult {
  checkId: string | null;
  clientId: string;
  policyId: string | null;
  payerName: string | null;
  subscriberMemberId: string | null;
  eligibilityStatus: EligibilityStatus | null;
  computedStatus: EligibilityComputedStatus;
  checkedAt: string | null;
  daysSinceChecked: number | null;
  coverageStartDate: string | null;
  coverageEndDate: string | null;
  copayAmount: number | null;
  deductibleRemaining: number | null;
  outOfPocketRemaining: number | null;
  serviceTypeCode: string;
  serviceTypeDescription: string;
  needsRecheck: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function computeDaysSince(isoString: string | null): number | null {
  if (!isoString) return null;
  const t = new Date(isoString);
  if (Number.isNaN(t.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - t.getTime()) / 86_400_000));
}

function deriveComputedStatus(
  eligibilityStatus: string | null,
  checkedAt: string | null
): EligibilityComputedStatus {
  if (!checkedAt) return "not_checked";
  const days = computeDaysSince(checkedAt);
  if (days !== null && days > ELIGIBILITY_RECHECK_DAYS) return "stale";
  const s = String(eligibilityStatus ?? "").toLowerCase() as EligibilityComputedStatus;
  if (["active", "inactive", "pending", "error", "not_checked"].includes(s)) return s;
  return "not_checked";
}

// ── Main validation + resolve ──────────────────────────────────────────────────

/**
 * Validates a client has sufficient data for an eligibility check and resolves
 * the full request input from live DB records. Returns structured errors if data
 * is incomplete — never throws for missing data.
 */
export async function resolveEligibilityInput(
  clientId: string,
  organizationId: string
): Promise<{ resolved: ResolvedEligibilityInput | null; errors: EligibilityValidationError[] }> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      resolved: null,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const errors: EligibilityValidationError[] = [];

  // 1) Load client
  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, organization_id, first_name, last_name, date_of_birth")
    .eq("id", clientId)
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .maybeSingle();

  if (clientError || !client) {
    return {
      resolved: null,
      errors: [{ field: "client_id", message: "Client not found" }],
    };
  }

  if (!client.first_name || !String(client.first_name).trim()) {
    errors.push({ field: "client.first_name", message: "Client is missing a first name" });
  }
  if (!client.last_name || !String(client.last_name).trim()) {
    errors.push({ field: "client.last_name", message: "Client is missing a last name" });
  }
  if (!client.date_of_birth) {
    errors.push({ field: "client.date_of_birth", message: "Client is missing a date of birth" });
  }

  // 2) Load primary active insurance policy
  const { data: policy, error: policyError } = await supabase
    .from("insurance_policies")
    .select("id, payer_id, subscriber_id, plan_name, policy_number, active_flag")
    .eq("client_id", clientId)
    .eq("organization_id", organizationId)
    .eq("priority", "primary")
    .eq("active_flag", true)
    .is("archived_at", null)
    .maybeSingle();

  if (policyError || !policy) {
    errors.push({
      field: "insurance_policy",
      message: "No active primary insurance policy found for this client",
    });
  }

  // 3) Load payer
  let payerName: string | null = null;
  let payerId: string | null = null;

  if (policy?.payer_id) {
    const { data: payer } = await supabase
      .from("insurance_payers")
      .select("id, payer_name, payer_id")
      .eq("id", policy.payer_id)
      .is("archived_at", null)
      .maybeSingle();

    if (payer) {
      payerName = payer.payer_name ? String(payer.payer_name) : null;
      payerId = payer.payer_id ? String(payer.payer_id) : null;
    } else {
      errors.push({ field: "payer", message: "Payer record not found for this insurance policy" });
    }
  } else if (policy) {
    errors.push({ field: "policy.payer_id", message: "Insurance policy has no linked payer" });
  }

  // 4) Load subscriber
  let subscriberMemberId: string | null = null;
  let subscriberFirstName: string | null = null;
  let subscriberLastName: string | null = null;
  let subscriberDob: string | null = null;

  if (policy?.subscriber_id) {
    const { data: subscriber } = await supabase
      .from("insurance_subscribers")
      .select("id, member_id, first_name, last_name, date_of_birth")
      .eq("id", policy.subscriber_id)
      .is("archived_at", null)
      .maybeSingle();

    if (subscriber) {
      subscriberMemberId = subscriber.member_id ? String(subscriber.member_id) : null;
      subscriberFirstName = subscriber.first_name ? String(subscriber.first_name) : null;
      subscriberLastName = subscriber.last_name ? String(subscriber.last_name) : null;
      subscriberDob = subscriber.date_of_birth ? String(subscriber.date_of_birth) : null;
      if (!subscriberMemberId) {
        errors.push({
          field: "subscriber.member_id",
          message: "Subscriber record is missing a member/subscriber ID",
        });
      }
    } else {
      errors.push({
        field: "policy.subscriber_id",
        message: "Subscriber record not found for this insurance policy",
      });
    }
  } else if (policy) {
    errors.push({
      field: "policy.subscriber_id",
      message: "Insurance policy has no linked subscriber",
    });
  }

  if (errors.length > 0) {
    return { resolved: null, errors };
  }

  return {
    resolved: {
      clientId,
      organizationId,
      clientFirstName: String(client.first_name),
      clientLastName: String(client.last_name),
      clientDob: String(client.date_of_birth),
      policyId: String(policy!.id),
      payerId,
      payerName,
      subscriberMemberId: subscriberMemberId!,
      subscriberFirstName: subscriberFirstName!,
      subscriberLastName: subscriberLastName!,
      subscriberDob: subscriberDob!,
      serviceTypeCode: DEFAULT_SERVICE_TYPE_CODE,
    },
    errors: [],
  };
}

// ── Create eligibility check record ───────────────────────────────────────────

/**
 * Creates an eligibility_checks record for the given client. Validates all
 * required data is present before writing. Returns structured errors if
 * validation fails — never throws for missing data.
 *
 * In "mock" mode (default), stores a `not_checked` check record without
 * making a live 270 request. The record can later be updated by a live
 * Office Ally 270/271 round-trip.
 */
export async function createEligibilityCheck(
  input: EligibilityCheckInput
): Promise<CreateEligibilityCheckResult> {
  const { resolved, errors } = await resolveEligibilityInput(
    input.clientId,
    input.organizationId
  );

  if (errors.length > 0 || !resolved) {
    return { ok: false, checkId: null, resolvedInput: null, errors };
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      checkId: null,
      resolvedInput: resolved,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const serviceTypeCode = input.serviceTypeCode ?? DEFAULT_SERVICE_TYPE_CODE;
  const now = new Date().toISOString();

  const checkPayload = {
    organization_id: resolved.organizationId,
    client_id: resolved.clientId,
    insurance_policy_id: resolved.policyId,
    appointment_id: input.appointmentId ?? undefined,
    // For mock mode, status is `not_checked` until a live 270/271 is attempted.
    // For live mode (future), status would transition to `pending` then `active`/`inactive`.
    eligibility_status: "not_checked" as const,
    checked_at: now,
    response_summary: {
      mode: input.mode ?? "mock",
      service_type_code: serviceTypeCode,
      service_type_description: DEFAULT_SERVICE_TYPE_DESCRIPTION,
      subscriber_member_id: resolved.subscriberMemberId,
      subscriber_first_name: resolved.subscriberFirstName,
      subscriber_last_name: resolved.subscriberLastName,
      subscriber_dob: resolved.subscriberDob,
      payer_name: resolved.payerName,
      payer_id: resolved.payerId,
      client_first_name: resolved.clientFirstName,
      client_last_name: resolved.clientLastName,
      client_dob: resolved.clientDob,
      source: "client_eligibility_service",
    },
  };

  const { data: inserted, error: insertError } = await supabase
    .from("eligibility_checks")
    .insert(checkPayload)
    .select("id")
    .single();

  if (insertError || !inserted) {
    return {
      ok: false,
      checkId: null,
      resolvedInput: resolved,
      errors: [
        {
          field: "eligibility_checks",
          message: insertError?.message ?? "Failed to create eligibility check record",
        },
      ],
    };
  }

  return {
    ok: true,
    checkId: String(inserted.id),
    resolvedInput: resolved,
    errors: [],
  };
}

// ── Latest eligibility lookup ──────────────────────────────────────────────────

/**
 * Returns the most recent eligibility check for a client (from
 * eligibility_with_staleness view), including staleness computation.
 * If no check exists, returns a `not_checked` result without error.
 */
export async function getLatestEligibilityForClient(
  clientId: string,
  organizationId: string,
  policyId?: string | null
): Promise<LatestEligibilityCheckResult> {
  const notChecked: LatestEligibilityCheckResult = {
    checkId: null,
    clientId,
    policyId: policyId ?? null,
    payerName: null,
    subscriberMemberId: null,
    eligibilityStatus: null,
    computedStatus: "not_checked",
    checkedAt: null,
    daysSinceChecked: null,
    coverageStartDate: null,
    coverageEndDate: null,
    copayAmount: null,
    deductibleRemaining: null,
    outOfPocketRemaining: null,
    serviceTypeCode: DEFAULT_SERVICE_TYPE_CODE,
    serviceTypeDescription: DEFAULT_SERVICE_TYPE_DESCRIPTION,
    needsRecheck: true,
  };

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return notChecked;

  let query = supabase
    .from("eligibility_with_staleness")
    .select(
      "id, client_id, insurance_policy_id, eligibility_status, computed_status, checked_at, coverage_start_date, coverage_end_date, copay_amount, deductible_remaining, out_of_pocket_remaining, response_summary"
    )
    .eq("client_id", clientId)
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("checked_at", { ascending: false })
    .limit(1);

  if (policyId) {
    query = query.eq("insurance_policy_id", policyId);
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data) return notChecked;

  const checkedAt = data.checked_at ? String(data.checked_at) : null;
  const daysSinceChecked = computeDaysSince(checkedAt);
  const computedStatus = deriveComputedStatus(
    data.eligibility_status,
    checkedAt
  );
  const needsRecheck =
    computedStatus === "not_checked" ||
    computedStatus === "stale" ||
    computedStatus === "error";

  const responseSummary = (data.response_summary ?? {}) as Record<string, unknown>;
  const payerName = responseSummary.payer_name ? String(responseSummary.payer_name) : null;
  const subscriberMemberId = responseSummary.subscriber_member_id
    ? String(responseSummary.subscriber_member_id)
    : null;
  const serviceTypeCode = responseSummary.service_type_code
    ? String(responseSummary.service_type_code)
    : DEFAULT_SERVICE_TYPE_CODE;
  const serviceTypeDescription = responseSummary.service_type_description
    ? String(responseSummary.service_type_description)
    : DEFAULT_SERVICE_TYPE_DESCRIPTION;

  return {
    checkId: String(data.id),
    clientId,
    policyId: data.insurance_policy_id ? String(data.insurance_policy_id) : null,
    payerName,
    subscriberMemberId,
    eligibilityStatus: data.eligibility_status ? (String(data.eligibility_status) as EligibilityStatus) : null,
    computedStatus,
    checkedAt,
    daysSinceChecked,
    coverageStartDate: data.coverage_start_date ? String(data.coverage_start_date) : null,
    coverageEndDate: data.coverage_end_date ? String(data.coverage_end_date) : null,
    copayAmount: toNumber(data.copay_amount),
    deductibleRemaining: toNumber(data.deductible_remaining),
    outOfPocketRemaining: toNumber(data.out_of_pocket_remaining),
    serviceTypeCode,
    serviceTypeDescription,
    needsRecheck,
  };
}
