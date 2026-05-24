type AvailityClaimMode = "test" | "production";

export interface AvailityConnection {
  id?: string;
  organization_id: string;
  clearinghouse_name?: string;
  mode: AvailityClaimMode;
  submitter_id: string;
  submitter_name?: string | null;
  sender_qualifier: "30" | "ZZ";
  receiver_qualifier: "30" | "ZZ";
  receiver_id: string;
  receiver_name: string;
  gs_receiver_code: string;
  x12_version: string;
  isa_usage_indicator: "T" | "P";
  // Loop 1000A PER — Submitter EDI Contact Information (TR3 005010X222A1 requires
  // at least one of TE/EM/FX). Persisted on the clearinghouse connection so the
  // generator can emit a valid PER segment.
  submitter_contact_phone?: string | null;
  submitter_contact_email?: string | null;
  sftp_host?: string | null;
  sftp_port?: number | null;
  sftp_username?: string | null;
  inbound_folder?: string | null;
  outbound_folder?: string | null;
  is_active?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProfessionalClaim {
  id: string;
  organization_id: string;
  patient_id?: string | null;
  appointment_id?: string | null;
  payer_profile_id?: string | null;
  claim_number?: string | null;
  patient_account_number?: string | null;
  claim_status?: string | null;
  // 2300/CLM05-3 frequency: '1' original, '7' replacement of prior claim,
  // '8' void/cancel of prior claim. Defaults to '1' when null. For '7'/'8'
  // the generator must also emit a 2300 REF*F8 with the payer's original
  // claim control number (ICN), supplied via original_payer_claim_control_number.
  claim_frequency_code?: string | null;
  // Payer-assigned Claim Control Number (CLP07 on the 835 for the prior
  // claim). Required on corrected children (frequency 7/8) so payers can
  // tie the resubmission to the original instead of treating it as a dup.
  original_payer_claim_control_number?: string | null;
  total_charge?: number | string | null;
  place_of_service?: string | null;
  diagnosis_codes?: string[] | null;
  prior_authorization_number?: string | null;
  accept_assignment?: boolean | null;
  benefits_assignment?: boolean | null;
  release_of_information?: boolean | null;
  signature_on_file?: boolean | null;
  validation_errors?: unknown;
  last_validated_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  // COB (Coordination of Benefits) fields — populated on child claims
  // created by `cobBilling.billSecondary`. When `cob_billing_role` is
  // 'secondary' AND the `prior_payer_*` fields are populated, the 837P
  // generator emits Loop 2320/2330A/2330B + per-line 2430 SVD/CAS/DTP*573.
  cob_billing_role?: "primary" | "secondary" | "tertiary" | null;
  original_claim_id?: string | null;
  prior_payer_profile_id?: string | null;
  prior_payer_paid_amount?: number | string | null;
  prior_payer_adjustment_amount?: number | string | null;
  prior_payer_patient_responsibility_amount?: number | string | null;
  // Structured payload — see `cobSegments.deriveCobFromClaim` for the
  // expected fields (primary_payer_name/id, primary_subscriber_*, ERA
  // cas_adjustments[], per-line service_lines[]).
  prior_payer_eob_data?: Record<string, unknown> | null;
}

export interface ProfessionalClaimServiceLine {
  id: string;
  claim_id: string;
  line_number: number;
  service_date_from: string;
  service_date_to?: string | null;
  procedure_code: string;
  modifiers?: string[] | null;
  charge_amount: number | string;
  units: number | string;
  diagnosis_pointers?: string[] | null;
  place_of_service?: string | null;
  rendering_provider_npi?: string | null;
  authorization_number?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ClaimPartiesSnapshot {
  id: string;
  claim_id: string;
  billing_provider_entity_type: "1" | "2";
  billing_provider_name: string;
  billing_provider_first_name?: string | null;
  billing_provider_npi: string;
  billing_provider_tax_id: string;
  billing_provider_tax_id_type: "EI" | "SY";
  billing_provider_address1: string;
  billing_provider_address2?: string | null;
  billing_provider_city: string;
  billing_provider_state: string;
  billing_provider_zip: string;
  subscriber_last_name: string;
  subscriber_first_name: string;
  subscriber_member_id: string;
  subscriber_dob: string;
  subscriber_gender?: "F" | "M" | "U" | null;
  subscriber_address1: string;
  subscriber_city: string;
  subscriber_state: string;
  subscriber_zip: string;
  patient_is_subscriber: boolean;
  patient_last_name?: string | null;
  patient_first_name?: string | null;
  patient_dob?: string | null;
  patient_gender?: "F" | "M" | "U" | null;
  patient_address1?: string | null;
  patient_city?: string | null;
  patient_state?: string | null;
  patient_zip?: string | null;
  payer_name: string;
  payer_id: string;
  rendering_same_as_billing: boolean;
  rendering_provider_entity_type?: "1" | "2" | null;
  rendering_provider_last_name_or_org?: string | null;
  rendering_provider_first_name?: string | null;
  rendering_provider_npi?: string | null;
  service_facility_same_as_billing: boolean;
  service_facility_name?: string | null;
  service_facility_npi?: string | null;
  service_facility_address1?: string | null;
  service_facility_city?: string | null;
  service_facility_state?: string | null;
  service_facility_zip?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface Availity837PValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
  loop?: string;
  segment?: string;
}

export interface Availity837PValidationResult {
  isValid: boolean;
  errors: Availity837PValidationError[];
  warnings: Availity837PValidationError[];
}

export interface Availity837PGenerationInput {
  connection: AvailityConnection;
  submitterName: string;
  claim: ProfessionalClaim;
  serviceLines: ProfessionalClaimServiceLine[];
  parties: ClaimPartiesSnapshot;
  payerProfile: {
    id: string;
    organization_id: string;
    payer_name: string;
    availity_payer_id: string;
    payer_type?: string | null;
    is_active?: boolean | null;
    notes?: string | null;
  };
}

export interface Generated837PBatch {
  batchType: "837P";
  notes: string;
  mode: AvailityClaimMode;
  fileName: string;
  fileContent: string;
  claimCount: number;
  isaControlNumber: string;
  gsControlNumber: string;
  stControlNumber: string;
  validation: Availity837PValidationResult;
}
