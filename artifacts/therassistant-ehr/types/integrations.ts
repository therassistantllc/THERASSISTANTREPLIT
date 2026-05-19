// File: types/integrations.ts
// New integration and external transaction types for Office Ally sandbox

export interface IntegrationConnection {
  id: string;
  organization_id: string;
  integration_name: string; // e.g., "office_ally", "availity"
  connection_status: "not_configured" | "sandbox_configured" | "live_configured" | "active" | "error";
  mode: "sandbox" | "live";
  supported_transactions?: string[]; // e.g., ["270/271", "276/277", "837P", "835"]
  live_transactions_enabled: boolean;
  credentials_storage: "server_side_only" | "encrypted";
  api_base_url?: string | null;
  sender_id?: string | null;
  receiver_id?: string | null;
  last_checked_at?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ExternalTransaction {
  id: string;
  organization_id: string;
  integration_connection_id?: string | null;
  transaction_type: "eligibility" | "claim_status" | "claim_submission" | "payment_posting" | "test_connection";
  payload_type: "270" | "271" | "276" | "277" | "837" | "835" | "test_connection" | "generic";
  message_format: "x12" | "json" | "xml" | "hl7";
  envelope_format: "none" | "soap" | "rest" | "sftp";
  processing_mode: "sandbox" | "live";
  processing_status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  sender_id?: string | null;
  receiver_id?: string | null;
  source_object_type?: string | null; // e.g., "eligibility_check", "claim", "appointment"
  source_object_id?: string | null;
  request_payload?: Record<string, unknown>;
  response_payload?: Record<string, unknown>;
  parsed_response_summary?: Record<string, unknown>;
  error_message?: string | null;
  request_timestamp?: string;
  response_timestamp?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ExternalTransactionAttempt {
  id: string;
  external_transaction_id: string;
  attempt_number: number;
  attempt_status: "started" | "sent" | "received" | "parsed" | "failed" | "timeout";
  http_status_code?: number | null;
  request_headers?: Record<string, unknown>;
  response_headers?: Record<string, unknown>;
  raw_request?: string | null;
  raw_response?: string | null;
  error_detail?: string | null;
  attempt_started_at?: string;
  attempt_completed_at?: string;
  created_at?: string;
}

export interface ExternalMessageEnvelope {
  id: string;
  external_transaction_id?: string | null;
  envelope_type: "isa_gs" | "soap" | "json_wrapper" | "none";
  control_number?: string | null;
  sender_qualifier?: string | null;
  sender_id?: string | null;
  receiver_qualifier?: string | null;
  receiver_id?: string | null;
  interchange_control_version?: string | null;
  test_indicator?: boolean;
  envelope_data?: Record<string, unknown>;
  created_at?: string;
}

export interface TestConnectionRequest {
  organizationId: string;
  integrationName?: string;
}

export interface TestConnectionResponse {
  success: boolean;
  message: string;
  connectionStatus: string;
  transactionId?: string;
  lastCheckedAt?: string;
}

export interface EligibilityCheckRequest {
  appointmentId?: string | null;
  eligibilityCheckId?: string | null;
  organizationId: string;
}

export interface EligibilityCheckResponse {
  success: boolean;
  message: string;
  eligibilityCheck: {
    id: string;
    eligibility_status: string;
    checked_at: string;
    coverage_start_date?: string | null;
    coverage_end_date?: string | null;
    copay_amount?: number | null;
    deductible_remaining?: number | null;
    out_of_pocket_remaining?: number | null;
    response_summary?: Record<string, unknown>;
    external_transaction_id?: string | null;
  };
  transactionId?: string;
}
