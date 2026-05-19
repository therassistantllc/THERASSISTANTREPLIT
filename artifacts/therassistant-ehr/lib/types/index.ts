// File: lib/types/index.ts
export interface ClientRecord {
  id: string;
  organization_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  middle_name?: string | null;
  preferred_name?: string | null;
  date_of_birth?: string | null;
  email?: string | null;
  phone?: string | null;
  mrn?: string | null;
  sex_at_birth?: string | null;
  gender_identity?: string | null;
  pronouns?: string | null;
  preferred_language?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  external_client_ref?: string | null;
  primary_clinician_user_id?: string | null;
  deceased_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface InsurancePolicyRecord {
  id: string;
  organization_id?: string | null;
  client_id?: string | null;
  payer_id?: string | null;
  policy_number?: string | null;
  subscriber_id?: string | null;
  priority?: string | number | null;
  plan_name?: string | null;
  effective_date?: string | null;
  termination_date?: string | null;
  active_flag?: boolean | null;
  deductible_amount?: string | null;
  copay_amount?: string | null;
  coinsurance_percent?: string | null;
  out_of_pocket_max?: string | null;
  legacy_availity_plan_code?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface AppointmentRecord {
  id: string;
  organization_id?: string | null;
  client_id?: string | null;
  provider_id?: string | null;
  provider_location_id?: string | null;
  insurance_policy_id?: string | null;
  scheduled_start_at?: string | null;
  scheduled_end_at?: string | null;
  appointment_status?: string | null;
  appointment_type?: string | null;
  service_location?: string | null;
  reason?: string | null;
  internal_note?: string | null;
  check_in_at?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
  telehealth_url?: string | null;
  telehealth_session_token?: string | null;
  reminder_email_enabled?: boolean | null;
  reminder_sms_enabled?: boolean | null;
  reminder_portal_enabled?: boolean | null;
  reminder_lead_hours?: number | null;
  series_id?: string | null;
  recurrence_index?: number | null;
  recurrence_frequency?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface EncounterRecord {
  id: string;
  organization_id?: string | null;
  appointment_id?: string | null;
  client_id?: string | null;
  provider_id?: string | null;
  encounter_status?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  service_date?: string | null;
  required_billing_fields_complete?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface EncounterDiagnosisRecord {
  id: string;
  organization_id?: string | null;
  encounter_id?: string | null;
  diagnosis_code?: string | null;
  diagnosis_description?: string | null;
  is_primary?: boolean | null;
  sequence_number?: number | null;
  present_on_claim?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface EncounterServiceLineRecord {
  id: string;
  organization_id?: string | null;
  encounter_id?: string | null;
  service_date?: string | null;
  sequence_number?: number | null;
  cpt_hcpcs_code?: string | null;
  modifier_1?: string | null;
  modifier_2?: string | null;
  modifier_3?: string | null;
  modifier_4?: string | null;
  units?: string | number | null;
  charge_amount?: string | null;
  place_of_service_code?: string | null;
  rendering_provider_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface ClaimRecord {
  id: string;
  organization_id?: string | null;
  encounter_id?: string | null;
  client_id?: string | null;
  insurance_policy_id?: string | null;
  claim_number?: string | null;
  claim_status?: string | null;
  total_charge_amount?: string | null;
  date_of_service_from?: string | null;
  date_of_service_to?: string | null;
  claim_frequency_code?: string | null;
  duplicate_detection_key?: string | null;
  last_blocker_codes?: string[] | null;
  ready_to_submit_at?: string | null;
  submitted_at?: string | null;
  accepted_at?: string | null;
  denied_at?: string | null;
  paid_at?: string | null;
  patient_responsibility_amount?: string | null;
  payer_responsibility_amount?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface ClaimServiceLineRecord {
  id: string;
  organization_id?: string | null;
  claim_id?: string | null;
  encounter_service_line_id?: string | null;
  service_date?: string | null;
  sequence_number?: number | null;
  cpt_hcpcs_code?: string | null;
  modifier_1?: string | null;
  modifier_2?: string | null;
  modifier_3?: string | null;
  modifier_4?: string | null;
  units?: string | number | null;
  charge_amount?: string | null;
  allowed_amount?: string | null;
  paid_amount?: string | null;
  service_line_status?: string | null;
  place_of_service_code?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface ClaimSubmissionRecord {
  id: string;
  organization_id?: string | null;
  claim_id?: string | null;
  submission_status?: string | null;
  clearinghouse_reference?: string | null;
  external_transaction_id?: string | null;
  payer_claim_reference?: string | null;
  submission_sequence?: number | null;
  duplicate_detection_key?: string | null;
  response_summary?: string | null;
  submitted_at?: string | null;
  acknowledged_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface ClaimStatusInquiryRecord {
  id: string;
  organization_id?: string | null;
  claim_id?: string | null;
  inquiry_status?: string | null;
  external_transaction_id?: string | null;
  duplicate_detection_key?: string | null;
  payer_status_code?: string | null;
  payer_status_text?: string | null;
  response_summary?: string | null;
  requested_at?: string | null;
  received_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface PaymentPostingRecord {
  id: string;
  organization_id?: string | null;
  payment_import_item_id?: string | null;
  posting_status?: string | null;
  posting_reference?: string | null;
  total_posted_amount?: string | null;
  note?: string | null;
  posted_at?: string | null;
  reversed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface EligibilityCheckRecord {
  id: string;
  organization_id?: string | null;
  client_id?: string | null;
  insurance_policy_id?: string | null;
  appointment_id?: string | null;
  encounter_id?: string | null;
  eligibility_status?: string | null;
  checked_at?: string | null;
  coverage_start_date?: string | null;
  coverage_end_date?: string | null;
  copay_amount?: string | null;
  deductible_remaining?: string | null;
  out_of_pocket_remaining?: string | null;
  external_transaction_id?: string | null;
  raw_status_text?: string | null;
  response_summary?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface WorkqueueItemRecord {
  id: string;
  organization_id?: string | null;
  source_object_type?: string | null;
  source_object_id?: string | null;
  client_id?: string | null;
  encounter_id?: string | null;
  claim_id?: string | null;
  priority?: string | null;
  status?: string | null;
  work_type?: string | null;
  title?: string | null;
  description?: string | null;
  assigned_to_user_id?: string | null;
  due_at?: string | null;
  resolved_at?: string | null;
  closed_at?: string | null;
  context_payload?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}

export interface SupportTicketRecord {
  id: string;
  organization_id?: string | null;
  workqueue_item_id?: string | null;
  source_object_type?: string | null;
  source_object_id?: string | null;
  requestor_user_id?: string | null;
  assigned_to_user_id?: string | null;
  status?: string | null;
  category?: string | null;
  priority?: string | null;
  title?: string | null;
  description?: string | null;
  due_at?: string | null;
  resolved_at?: string | null;
  closed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  archived_at?: string | null;
}
