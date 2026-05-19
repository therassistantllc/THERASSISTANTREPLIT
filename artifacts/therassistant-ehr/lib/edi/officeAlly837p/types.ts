export type OfficeAllyClaimMode = "test" | "production";

export interface OfficeAllyConnection {
  id?: string;
  organization_id: string;
  clearinghouse_name?: string;
  mode: OfficeAllyClaimMode;
  submitter_id: string;
  submitter_name?: string | null;
  sender_qualifier: "30" | "ZZ";
  receiver_qualifier: "30" | "ZZ";
  receiver_id: string;
  receiver_name: string;
  gs_receiver_code: string;
  x12_version: string;
  isa_usage_indicator: "T" | "P";
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

export interface OfficeAlly837PValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
  loop?: string;
  segment?: string;
}

export interface OfficeAlly837PValidationResult {
  isValid: boolean;
  errors: OfficeAlly837PValidationError[];
  warnings: OfficeAlly837PValidationError[];
}

export interface OfficeAlly837PGenerationInput {
  connection: OfficeAllyConnection;
  submitterName: string;
  claim: ProfessionalClaim;
  serviceLines: ProfessionalClaimServiceLine[];
  parties: ClaimPartiesSnapshot;
  payerProfile: {
    id: string;
    organization_id: string;
    payer_name: string;
    office_ally_payer_id: string;
    payer_type?: string | null;
    is_active?: boolean | null;
    notes?: string | null;
  };
}

export interface Generated837PBatch {
  batchType: "837P";
  notes: string;
  mode: OfficeAllyClaimMode;
  fileName: string;
  fileContent: string;
  claimCount: number;
  isaControlNumber: string;
  gsControlNumber: string;
  stControlNumber: string;
  validation: OfficeAlly837PValidationResult;
}
