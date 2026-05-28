// File: types/clearinghouse.ts
type ClearinghouseVendor = "availity" | "change_healthcare" | "mock";

export interface ClearinghouseConnection {
  id: string;
  organization_id: string;
  vendor: ClearinghouseVendor;
  connection_name?: string | null;
  mode: "test" | "live";
  submitter_id?: string | null;
  receiver_id?: string | null;
  api_base_url?: string | null;
  auth_type?: "api_key" | "oauth2" | "sftp" | "basic" | "mock" | null;
  encrypted_credentials?: Record<string, unknown>;
  is_active?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface EdiTransaction {
  id: string;
  organization_id: string;
  client_id?: string | null;
  patient_id?: string | null;
  appointment_id?: string | null;
  encounter_id?: string | null;
  claim_id?: string | null;
  clearinghouse_connection_id?: string | null;
  transaction_type: "270" | "271" | "276" | "277" | "837" | "835" | "999" | "277CA";
  direction: "outbound" | "inbound";
  status: "created" | "sent" | "received" | "parsed" | "failed";
  control_number?: string | null;
  correlation_id?: string | null;
  request_payload?: Record<string, unknown>;
  response_payload?: Record<string, unknown>;
  raw_request?: string | null;
  raw_response?: string | null;
  parsed_summary?: Record<string, unknown>;
  error_message?: string | null;
  sent_at?: string | null;
  received_at?: string | null;
  created_at?: string | null;
}

export interface EligibilityCheck {
  id: string;
  organization_id: string;
  client_id: string;
  appointment_id?: string | null;
  insurance_policy_id?: string | null;
  clearinghouse_connection_id?: string | null;
  edi_270_transaction_id?: string | null;
  edi_271_transaction_id?: string | null;
  payer_name?: string | null;
  payer_id?: string | null;
  service_type_code?: string | null;
  status?: "active" | "inactive" | "not_checked" | "not_found" | "error" | "unknown";
  eligibility_status: "active" | "inactive" | "not_checked" | "not_found" | "error" | "unknown";
  plan_name?: string | null;
  member_id?: string | null;
  subscriber_name?: string | null;
  effective_date?: string | null;
  termination_date?: string | null;
  copay_amount?: number | null;
  deductible_total?: number | null;
  deductible_remaining?: number | null;
  coinsurance_percent?: number | null;
  out_of_pocket_remaining?: number | null;
  // Phase 5 — CAQH CORE Data Content Rule §1.3.2.5–§1.3.2.13.
  out_of_pocket_total?: number | null;
  telemedicine_covered?: boolean | null;
  authorization_required?: boolean | null;
  benefit_tier?: string | null;
  max_coverage_amount?: number | null;
  max_coverage_period?: string | null;
  remaining_coverage_amount?: number | null;
  remaining_coverage_period?: string | null;
  raw_benefits?: Record<string, unknown>;
  checked_at?: string | null;
  created_at?: string | null;
}

/**
 * Row shape for `public.eligibility_benefit_segments`. Matches the
 * legacy schema introduced by `20260505030000_office_ally_response_schemas.sql`
 * plus the Phase 5 categorization columns added by
 * `20260522020000_eligibility_financial_responsibility.sql`. Both the
 * X12 path (ClearinghouseService) and the Coverages JSON path
 * (AvailityJsonApiAdapter) write into this table.
 */
interface EligibilityBenefitSegment {
  id?: string;
  organization_id: string;
  eligibility_check_id: string;
  client_id?: string | null;
  payer_id?: string | null;
  payer_name?: string | null;
  service_type_code?: string | null;
  service_type_description?: string | null;
  benefit_information_code?: string | null;
  benefit_description?: string | null;
  coverage_level_code?: string | null;
  insurance_type_code?: string | null;
  plan_coverage_description?: string | null;
  time_period_qualifier?: string | null;
  monetary_amount?: number | null;
  percent_amount?: number | null;
  quantity_qualifier?: string | null;
  quantity?: number | null;
  authorization_or_certification_required?: boolean | null;
  in_plan_network_indicator?: string | null;
  eligibility_date_from?: string | null;
  eligibility_date_to?: string | null;
  messages?: unknown[];
  raw_eb_segment?: Record<string, unknown>;
  // Phase 5 categorization columns (CORE Data Content Rule §1.3.2.5–§1.3.2.13).
  segment_index?: number | null;
  category?:
    | "active_coverage"
    | "inactive_coverage"
    | "copay"
    | "coinsurance"
    | "deductible"
    | "out_of_pocket"
    | "limitation"
    | "exclusion"
    | "non_covered"
    | "max_coverage"
    | "remaining_coverage"
    | "telemedicine"
    | "authorization"
    | "benefit_description"
    | "other"
    | null;
  is_remaining?: boolean | null;
  is_in_network?: boolean | null;
  benefit_tier?: string | null;
  telemedicine_flag?: boolean | null;
  message_text?: string | null;
  created_at?: string | null;
  archived_at?: string | null;
}

interface ClaimStatusInquiry {
  id: string;
  organization_id: string;
  claim_id: string;
  client_id?: string | null;
  patient_id?: string | null;
  payer_name?: string | null;
  payer_id?: string | null;
  inquiry_status?: "created" | "sent" | "received" | "parsed" | "failed" | "not_found" | "pending" | "paid" | "denied" | "rejected" | "needs_info" | "unknown";
  status?: "accepted" | "pending" | "paid" | "denied" | "rejected" | "not_found" | "needs_info" | "error" | "unknown";
  external_transaction_id?: string | null;
  duplicate_detection_key?: string | null;
  payer_status_code?: string | null;
  payer_status_text?: string | null;
  response_summary?: string | null;
  status_category_code?: string | null;
  status_code?: string | null;
  entity_code?: string | null;
  billed_amount?: number | null;
  paid_amount?: number | null;
  check_eft_number?: string | null;
  finalized_date?: string | null;
  raw_status?: Record<string, unknown>;
  requested_at?: string | null;
  received_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
}

export type ClaimStatusCheck = ClaimStatusInquiry;

export interface ClearinghouseResponseEvent {
  id: string;
  organization_id: string;
  claim_id?: string | null;
  client_id?: string | null;
  edi_transaction_id?: string | null;
  event_type: "acknowledgment" | "rejection" | "status_update" | "denial" | "payment" | "eligibility_result" | "error";
  severity?: "info" | "warning" | "error" | "critical";
  source?: "clearinghouse" | "payer" | "system" | null;
  title: string;
  message?: string | null;
  normalized_code?: string | null;
  raw_codes?: Record<string, unknown>;
  is_resolved?: boolean;
  created_at?: string | null;
}

export interface EligibilityRequestInput {
  organizationId: string;
  clientId?: string | null;
  patientId?: string | null;
  appointmentId?: string | null;
  insurancePolicyId?: string | null;
  clearinghouseConnectionId?: string | null;
  payerName?: string | null;
  payerId?: string | null;
  memberId?: string | null;
  subscriberName?: string | null;
  clientName?: string | null;
  patientName?: string | null;
  serviceTypeCode?: string;
  providerNpi?: string | null;
}

export interface NormalizedBenefitSegment {
  segmentIndex: number;
  category: EligibilityBenefitSegment["category"];
  isRemaining: boolean;
  isInNetwork?: boolean | null;
  eligibilityCode: string;
  coverageLevelCode?: string | null;
  serviceTypeCode?: string | null;
  insuranceTypeCode?: string | null;
  planCoverageDescription?: string | null;
  timePeriodQualifier?: string | null;
  monetaryAmount?: number | null;
  percent?: number | null;
  quantityQualifier?: string | null;
  quantity?: number | null;
  authorizationRequired?: boolean | null;
  inPlanNetworkCode?: string | null;
  benefitTier?: string | null;
  telemedicineFlag?: boolean | null;
  messageText?: string | null;
  raw?: Record<string, unknown>;
}

export interface EligibilityResponseNormalized {
  status: "active" | "inactive" | "not_found" | "error" | "unknown";
  payerName?: string | null;
  payerId?: string | null;
  planName?: string | null;
  memberId?: string | null;
  subscriberName?: string | null;
  effectiveDate?: string | null;
  terminationDate?: string | null;
  copayAmount?: number | null;
  deductibleTotal?: number | null;
  deductibleRemaining?: number | null;
  coinsurancePercent?: number | null;
  outOfPocketRemaining?: number | null;
  // Phase 5 — additional financial-responsibility values from
  // CAQH CORE Data Content Rule vEB.2.1 §1.3.2.5–§1.3.2.13.
  outOfPocketTotal?: number | null;
  telemedicineCovered?: boolean | null;
  authorizationRequired?: boolean | null;
  benefitTier?: string | null;
  maxCoverageAmount?: number | null;
  maxCoveragePeriod?: string | null;
  remainingCoverageAmount?: number | null;
  remainingCoveragePeriod?: string | null;
  /** Per-benefit normalized rows to persist into eligibility_benefit_segments. */
  benefitSegments?: NormalizedBenefitSegment[];
  /**
   * AAA reject errors with human-readable descriptions (X12 271 AAA
   * segment). Surfaced in the UI when status is `error` or `not_found`.
   */
  aaaErrors?: Array<{
    code: string;
    description: string;
    followUpAction?: string | null;
    loop?: string | null;
  }>;
  /**
   * Single Client Attribution Rule vEB.1.0 §4.2–§4.3 — identifies
   * whether the response carries content for the subscriber or for a
   * dependent under the subscriber's HL.
   */
  attribution?: {
    target: "subscriber" | "dependent";
    subscriberName?: string | null;
    subscriberMemberId?: string | null;
    dependentName?: string | null;
    dependentDob?: string | null;
    /** Raw subscriber loop identity preserved for downstream attribution matching. */
    subscriber?: {
      firstName: string | null;
      lastName: string | null;
      memberId: string | null;
      dob: string | null;
      gender: string | null;
    };
    /** Raw dependent loop identity preserved for downstream attribution matching. */
    dependent?: {
      firstName: string | null;
      lastName: string | null;
      dob: string | null;
      gender: string | null;
    } | null;
  };
  serviceTypeCode?: string | null;
  /**
   * Coverage type / level returned by the payer (e.g. "individual", "family",
   * "employee only"). Parsed from the X12 271 EB02 (coverage level code) or
   * INS segment depending on the payer. Surfaced in UI summary panels.
   */
  coverageLevel?: string | null;
  message?: string | null;
  rawBenefits?: Record<string, unknown>;
  /**
   * Additional payers reported by the 271 (EB*R subloops or Availity
   * JSON `otherPayers` bucket). Task #457 — persisted onto
   * `eligibility_checks.other_payers` so `/api/billing/cob-issues` can
   * prefer real signals over the policy-count heuristic.
   */
  otherPayers?: Array<{
    name: string | null;
    payerId: string | null;
    effectiveDate: string | null;
    terminationDate: string | null;
  }>;
}

export interface ClaimStatusRequestInput {
  organizationId: string;
  claimId: string;
  clientId?: string | null;
  patientId?: string | null;
  clearinghouseConnectionId?: string | null;
  payerName?: string | null;
  payerId?: string | null;
  claimAmount?: number | null;
  memberId?: string | null;
  currentClaimStatus?: string | null;
  providerNpi?: string | null;
  dateOfService?: string | null;
}

export interface ClaimStatusResponseNormalized {
  status: "accepted" | "pending" | "paid" | "denied" | "rejected" | "not_found" | "needs_info" | "error" | "unknown";
  payerName?: string | null;
  payerId?: string | null;
  statusCategoryCode?: string | null;
  statusCode?: string | null;
  entityCode?: string | null;
  billedAmount?: number | null;
  paidAmount?: number | null;
  checkEftNumber?: string | null;
  finalizedDate?: string | null;
  payerMessage?: string | null;
  rawStatus?: Record<string, unknown>;
}
