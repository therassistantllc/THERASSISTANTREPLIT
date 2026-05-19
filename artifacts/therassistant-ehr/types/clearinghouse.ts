// File: types/clearinghouse.ts
export type ClearinghouseVendor = "office_ally" | "availity" | "change_healthcare" | "mock";

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
  raw_benefits?: Record<string, unknown>;
  checked_at?: string | null;
  created_at?: string | null;
}

export interface ClaimStatusInquiry {
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
  serviceTypeCode?: string | null;
  message?: string | null;
  rawBenefits?: Record<string, unknown>;
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
