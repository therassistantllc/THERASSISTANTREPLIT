export type ID = string;

type UserRole = "admin" | "clinician" | "biller" | "supervisor" | "credentialing" | "owner";

interface Organization {
  id: ID;
  legal_name: string;
  dba_name: string;
  npi: string;
  tax_id_last4: string;
  taxonomy_code: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  billing_provider_name: string;
  billing_provider_npi: string;
  created_at: string;
  updated_at: string;
}

interface AppUser {
  id: ID;
  organization_id: ID;
  full_name: string;
  email: string;
  role: UserRole;
  credentials: string;
  npi: string;
  taxonomy_code: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface Client {
  id: ID;
  organization_id: ID;
  first_name: string;
  middle_name: string;
  last_name: string;
  preferred_name: string;
  dob: string;
  sex_at_birth: string;
  gender_identity: string;
  pronouns: string;
  phone: string;
  email: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  status: "active" | "inactive" | "discharged" | "prospective";
  created_at: string;
  updated_at: string;
}

interface Payer {
  id: ID;
  payer_name: string;
  payer_type: "medicaid" | "medicare" | "commercial" | "rae" | "tricare";
  clearinghouse_payer_id: string;
  availity_payer_id: string;
  state: string;
  is_active: boolean;
}

interface InsurancePolicy {
  id: ID;
  patient_id: ID;
  payer_id: ID;
  priority: number;
  member_id: string;
  group_number: string;
  plan_name: string;
  subscriber_first_name: string;
  subscriber_last_name: string;
  subscriber_dob: string;
  subscriber_relationship: string;
  effective_date: string;
  termination_date: string | null;
  policy_status: "active" | "inactive" | "unknown";
  created_at: string;
  updated_at: string;
}

export interface EligibilityCheck {
  id: ID;
  patient_id: ID;
  insurance_policy_id: ID;
  payer_id: ID;
  service_type_code: string;
  request_control_number: string;
  response_control_number: string;
  eligibility_status: "active" | "inactive" | "error" | "unknown";
  copay_amount: number;
  deductible_amount: number;
  deductible_remaining: number;
  coinsurance_percent: number;
  effective_date: string;
  termination_date: string | null;
  raw_270: Record<string, unknown>;
  raw_271: Record<string, unknown>;
  checked_at: string;
  checked_by: ID;
}

interface Appointment {
  id: ID;
  organization_id: ID;
  patient_id: ID;
  clinician_id: ID;
  location_id: ID | null;
  scheduled_start: string;
  scheduled_end: string;
  appointment_type: string;
  status: "scheduled" | "checked_in" | "completed" | "cancelled" | "no_show";
  reason_for_visit: string;
  insurance_policy_id: ID;
  eligibility_check_id: ID | null;
  created_at: string;
  updated_at: string;
}

export interface Encounter {
  id: ID;
  organization_id: ID;
  patient_id: ID;
  appointment_id: ID;
  clinician_id: ID;
  supervisor_id: ID | null;
  date_of_service: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  place_of_service_code: string;
  service_location: string;
  encounter_status: "draft" | "in_review" | "signed" | "ready_to_bill" | "billed" | "corrected" | "voided";
  documentation_status: "not_started" | "in_progress" | "complete" | "signed" | "addendum_needed";
  billing_status: "hold" | "ready" | "claim_created" | "submitted" | "paid" | "denied";
  primary_diagnosis_code: string;
  medical_necessity_summary: string;
  created_at: string;
  updated_at: string;
}

export interface ClinicalNote {
  id: ID;
  encounter_id: ID;
  note_type: "progress" | "intake" | "treatment_plan" | "discharge" | "addendum";
  note_format: "dap" | "soap" | "birp" | "narrative";
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  interventions: string;
  client_response: string;
  risk_assessment: string;
  progress_toward_goals: string;
  next_steps: string;
  signed_by: ID | null;
  signed_at: string | null;
  locked: boolean;
  created_at: string;
  updated_at: string;
}

interface EncounterDiagnosis {
  id: ID;
  encounter_id: ID;
  diagnosis_code: string;
  diagnosis_description: string;
  diagnosis_order: number;
  is_primary: boolean;
}

export interface EncounterServiceLine {
  id: ID;
  encounter_id: ID;
  code_type: "CPT" | "HCPCS";
  procedure_code: string;
  modifier_1: string;
  modifier_2: string;
  modifier_3: string;
  modifier_4: string;
  units: number;
  minutes: number;
  charge_amount: number;
  diagnosis_pointer: string;
  documentation_support_status: "supported" | "weak" | "unsupported" | "needs_review";
  billing_status: "hold" | "ready" | "submitted" | "paid" | "denied";
  created_at: string;
  updated_at: string;
}

interface TreatmentPlan {
  id: ID;
  patient_id: ID;
  organization_id: ID;
  clinician_id: ID;
  plan_start_date: string;
  plan_review_date: string;
  status: "active" | "reviewed" | "expired" | "discontinued";
  diagnosis_summary: string;
  clinical_summary: string;
  signed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TreatmentPlanGoal {
  id: ID;
  treatment_plan_id: ID;
  goal_text: string;
  objective_text: string;
  intervention_text: string;
  target_date: string;
  status: "active" | "met" | "modified" | "discontinued";
}

interface EncounterTreatmentPlanLink {
  id: ID;
  encounter_id: ID;
  treatment_plan_id: ID;
  goal_id: ID;
}

export interface Claim {
  id: ID;
  organization_id: ID;
  patient_id: ID;
  encounter_id: ID;
  payer_id: ID;
  insurance_policy_id: ID;
  claim_number: string;
  clearinghouse_trace_id: string | null;
  payer_claim_control_number: string | null;
  claim_type: "837P";
  claim_status: "draft" | "ready" | "submitted" | "accepted" | "rejected" | "denied" | "paid" | "appealed" | "voided";
  total_charge_amount: number;
  total_paid_amount: number;
  total_adjustment_amount: number;
  patient_responsibility_amount: number;
  submission_date: string | null;
  accepted_date: string | null;
  adjudicated_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimServiceLine {
  id: ID;
  claim_id: ID;
  encounter_service_line_id: ID;
  line_number: number;
  procedure_code: string;
  modifiers: string[];
  units: number;
  charge_amount: number;
  allowed_amount: number;
  paid_amount: number;
  adjustment_amount: number;
  patient_responsibility_amount: number;
  service_date: string;
  place_of_service_code: string;
  line_status: "submitted" | "paid" | "denied" | "rejected" | "adjusted";
}

export interface ClaimSubmission {
  id: ID;
  claim_id: ID;
  transaction_type: "837P";
  submission_method: "availity" | "availity" | "manual" | "batch";
  batch_id: ID | null;
  control_number: string;
  raw_837: Record<string, unknown>;
  edi_payload: string;
  response_status: string;
  submitted_at: string;
  submitted_by: ID;
}

export interface ClaimStatusEvent {
  id: ID;
  claim_id: ID;
  source: "clearinghouse" | "payer" | "portal" | "manual";
  transaction_type: "999" | "277CA" | "276" | "277" | "portal";
  status_code: string;
  status_text: string;
  event_at: string;
  raw_event: Record<string, unknown>;
}

export interface EraFile {
  id: ID;
  organization_id: ID;
  payer_id: ID;
  file_name: string;
  trace_number: string;
  raw_835: Record<string, unknown>;
  imported_at: string;
  imported_by: ID;
}

export interface EraClaimPayment {
  id: ID;
  era_file_id: ID;
  claim_id: ID;
  payer_claim_control_number: string;
  billed_amount: number;
  paid_amount: number;
  patient_responsibility_amount: number;
  claim_status_code: string;
  posted: boolean;
  posted_at: string | null;
}

export interface EraLinePayment {
  id: ID;
  era_claim_payment_id: ID;
  claim_service_line_id: ID;
  procedure_code: string;
  billed_amount: number;
  allowed_amount: number;
  paid_amount: number;
  adjustment_amount: number;
  patient_responsibility_amount: number;
}

interface ClaimAdjustment {
  id: ID;
  claim_id: ID;
  claim_service_line_id: ID | null;
  group_code: string;
  reason_code: string;
  amount: number;
  description: string;
  created_at: string;
}

type WorkqueueType =
  // AR Aging buckets
  | "no_response"
  | "aging_0_30"
  | "aging_31_60"
  | "aging_61_90"
  | "aging_91_120"
  | "aging_120_plus"
  // Payer response
  | "denied"
  | "clearinghouse_rejection"
  | "payer_rejection"
  | "appeal_needed"
  | "recoupment"
  // Eligibility
  | "eligibility_issue"
  | "eligibility_needed"
  // ERA
  | "era_mismatch"
  | "era_unmatched_claim"
  | "era_recoupment_review"
  // Billing
  | "ready_to_bill"
  | "biller_review"
  // Legacy (kept for backwards compat)
  | "rejection"
  | "denial"
  | "authorization_needed"
  | "underpayment"
  | "patient_balance"
  | "documentation_hold";

export interface WorkqueueItem {
  id: ID;
  organization_id: ID;
  patient_id: ID | null;
  encounter_id: ID | null;
  claim_id: ID | null;
  professional_claim_id: ID | null;
  payer_id: ID | null;
  queue_type: WorkqueueType;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "in_progress" | "deferred" | "resolved" | "closed";
  title: string;
  description: string;
  assigned_to: ID | null;
  due_date: string | null;
  defer_until: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkqueueEvent {
  id: ID;
  workqueue_item_id: ID;
  event_type: "created" | "assigned" | "note_added" | "deferred" | "status_changed" | "resolved";
  note: string;
  created_by: ID;
  created_at: string;
}

export interface SupportTicket {
  id: ID;
  organization_id: ID;
  patient_id: ID | null;
  encounter_id: ID | null;
  claim_id: ID | null;
  category: "billing" | "eligibility" | "credentialing" | "documentation" | "payment" | "system";
  subject: string;
  description: string;
  status: "open" | "waiting" | "resolved" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  created_by: ID;
  assigned_to: ID | null;
  created_at: string;
  updated_at: string;
}

export interface TicketMessage {
  id: ID;
  ticket_id: ID;
  sender_id: ID;
  message_body: string;
  internal_only: boolean;
  created_at: string;
}

interface AuditLog {
  id: ID;
  organization_id: ID;
  user_id: ID;
  entity_type: string;
  entity_id: ID;
  action: "view" | "create" | "update" | "delete" | "sign" | "submit" | "export";
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  ip_address: string;
  user_agent: string;
  created_at: string;
}

interface DocumentRecord {
  id: ID;
  organization_id: ID;
  patient_id: ID | null;
  encounter_id: ID | null;
  claim_id: ID | null;
  document_type: "consent" | "intake" | "id_card" | "appeal" | "eob" | "clinical_upload";
  file_url: string;
  file_name: string;
  uploaded_by: ID;
  created_at: string;
}

export interface CanonicalEhrState {
  organizations: Organization[];
  users: AppUser[];
  clients: Client[];
  payers: Payer[];
  insurance_policies: InsurancePolicy[];
  eligibility_checks: EligibilityCheck[];
  appointments: Appointment[];
  encounters: Encounter[];
  clinical_notes: ClinicalNote[];
  encounter_diagnoses: EncounterDiagnosis[];
  encounter_service_lines: EncounterServiceLine[];
  treatment_plans: TreatmentPlan[];
  treatment_plan_goals: TreatmentPlanGoal[];
  encounter_treatment_plan_links: EncounterTreatmentPlanLink[];
  claims: Claim[];
  claim_service_lines: ClaimServiceLine[];
  claim_submissions: ClaimSubmission[];
  claim_status_events: ClaimStatusEvent[];
  era_files: EraFile[];
  era_claim_payments: EraClaimPayment[];
  era_line_payments: EraLinePayment[];
  claim_adjustments: ClaimAdjustment[];
  workqueue_items: WorkqueueItem[];
  workqueue_events: WorkqueueEvent[];
  support_tickets: SupportTicket[];
  ticket_messages: TicketMessage[];
  audit_logs: AuditLog[];
  documents: DocumentRecord[];
}

type CanonicalView = "dashboard" | "scheduling" | "clients" | "client-chart" | "encounters" | "encounter-workspace" | "claims" | "payments" | "workqueue" | "schema";
