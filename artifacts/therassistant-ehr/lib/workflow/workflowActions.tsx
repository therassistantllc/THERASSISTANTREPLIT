/**
 * Workflow Actions
 * 
 * Core workflow functions that power the client journey:
 * Appointment → Encounter → Note → Claim → Submission → Payment
 * 
 * These functions can be used in:
 * - API endpoints
 * - Server actions
 * - Test scripts
 * - Background jobs
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Types
export interface CreateAppointmentParams {
  organizationId: string;
  patientId: string;
  providerId: string;
  appointmentType: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  notes?: string;
}

export interface CreateEncounterParams {
  organizationId: string;
  appointmentId: string;
  patientId: string;
  providerId?: string;
  serviceDate?: string;
}

export interface CreateNoteParams {
  organizationId: string;
  encounterId: string;
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  status: "draft" | "signed";
  riskAssessment?: string;
}

export interface CreateClaimParams {
  encounterId: string;
  status?: string;
}

export interface PostPaymentParams {
  organizationId: string;
  claimId: string;
  amount: number;
  postingReference?: string;
}

/**
 * Create a new appointment
 */
async function createAppointment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  params: CreateAppointmentParams
) {
  const { data, error } = await supabase
    .from("appointments")
    .insert({
      organization_id: params.organizationId,
      client_id: params.patientId,
      provider_id: params.providerId,
      appointment_type: params.appointmentType,
      scheduled_start_at: params.scheduledStartAt,
      scheduled_end_at: params.scheduledEndAt,
      appointment_status: "scheduled",
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create appointment: ${error.message}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data as any;
}

/**
 * Create encounter from appointment
 */
async function createEncounter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  params: CreateEncounterParams
) {
  const { data, error } = await supabase
    .from("encounters")
    .insert({
      organization_id: params.organizationId,
      client_id: params.patientId,
      provider_id: params.providerId,
      appointment_id: params.appointmentId,
      service_date: params.serviceDate || new Date().toISOString().split("T")[0],
      encounter_status: "in_progress",
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create encounter: ${error.message}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data as any;
}

/**
 * Create clinical note
 */
async function createNote(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  params: CreateNoteParams
) {
  const signedAt = params.status === "signed" ? new Date().toISOString() : null;

  // Insert encounter_notes header record
  const { data: note, error: noteError } = await supabase
    .from("encounter_notes")
    .insert({
      organization_id: params.organizationId,
      encounter_id: params.encounterId,
      status: params.status,
      signed_at: signedAt,
    })
    .select()
    .single();

  if (noteError) throw new Error(`Failed to create note: ${noteError.message}`);

  // Insert SOAP content into clinical_notes
  if (params.subjective || params.objective || params.assessment || params.plan) {
    await supabase.from("clinical_notes").insert({
      encounter_id: params.encounterId,
      subjective: params.subjective,
      objective: params.objective,
      assessment: params.assessment,
      plan: params.plan,
      risk_assessment: params.riskAssessment,
      signed_at: signedAt,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return note as any;
}

/**
 * Create claim with service lines
 */
async function createClaim(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  params: CreateClaimParams
) {
  // Get encounter details
  const { data: encounter, error: encounterError } = await supabase
    .from("encounters")
    .select("organization_id, client_id, service_date")
    .eq("id", params.encounterId)
    .single();

  if (encounterError) throw new Error(`Failed to fetch encounter: ${encounterError.message}`);
  if (!encounter) throw new Error("Encounter not found");

  // Get active insurance (lowest priority number = primary)
  const { data: insurance, error: insuranceError } = await supabase
    .from("insurance_policies")
    .select("id")
    .eq("client_id", encounter.client_id)
    .eq("active_flag", true)
    .is("archived_at", null)
    .order("priority", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (insuranceError) throw new Error(`Failed to fetch insurance: ${insuranceError.message}`);
  if (!insurance) throw new Error("No active insurance found for client");

  const serviceDate = encounter.service_date || new Date().toISOString().split("T")[0];

  // Create claim
  const { data: claim, error: claimError } = await supabase
.from("professional_claims")    .insert({
      organization_id: encounter.organization_id,
      encounter_id: params.encounterId,
      client_id: encounter.client_id,
      insurance_policy_id: insurance.id,
      claim_number: `CLM-${Date.now()}`,
      claim_status: params.status || "ready_to_submit",
      total_charge_amount: "0.00",
      date_of_service_from: serviceDate,
      date_of_service_to: serviceDate,
      duplicate_detection_key: `${encounter.client_id}_${params.encounterId}_${serviceDate}`,
    })
    .select()
    .single();

  if (claimError) throw new Error(`Failed to create claim: ${claimError.message}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return claim as any;
}

/**
 * Submit claim to clearinghouse
 */
async function submitClaim(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  claimId: string
) {
  // Update claim status
  const { data, error } = await supabase
    .from("professional_claims")
    .update({
      claim_status: "submitted",
    })
    .eq("id", claimId)
    .select()
    .single();

  if (error) throw new Error(`Failed to submit claim: ${error.message}`);

  // Create submission record
  await supabase.from("claim_submissions").insert({
    claim_id: claimId,
    submission_status: "submitted",
    submitted_at: new Date().toISOString(),
    submission_sequence: 1,
    duplicate_detection_key: `${claimId}_${Date.now()}`,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data as any;
}

/**
 * Post payment to claim
 */
async function postPayment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  params: PostPaymentParams
) {
  // Get claim details
  const { data: claim, error: claimError } = await supabase
    .from("professional_claims")
    .select("id")
    .eq("id", params.claimId)
    .single();

  if (claimError) throw new Error(`Failed to fetch claim: ${claimError.message}`);
  if (!claim) throw new Error("Claim not found");

  // Create payment posting record
  const { data, error } = await supabase
    .from("payment_postings")
    .insert({
      organization_id: params.organizationId,
      posting_status: "posted",
      posting_reference: params.postingReference || `PAY-${Date.now()}`,
      total_posted_amount: params.amount.toFixed(2),
      note: `Payment for claim ${params.claimId}`,
      posted_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to post payment: ${error.message}`);

  // Mark claim as paid
  await supabase
    .from("professional_claims")
    .update({
      claim_status: "paid",
    })
    .eq("id", params.claimId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data as any;
}

/**
 * Complete workflow: Execute all steps in sequence.
 * Requires organizationId so all DB inserts satisfy NOT NULL constraints.
 */
export async function executeCompleteWorkflow(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
  patientId: string,
  providerId: string
) {
  // Step 1: Create appointment
  const appointment = await createAppointment(supabase, {
    organizationId,
    patientId,
    providerId,
    appointmentType: "Initial Consultation",
    scheduledStartAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    scheduledEndAt: new Date(Date.now() + 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
  });

  // Step 2: Create encounter
  const encounter = await createEncounter(supabase, {
    organizationId,
    appointmentId: appointment.id,
    patientId,
    providerId,
  });

  // Step 3: Create note
  const note = await createNote(supabase, {
    organizationId,
    encounterId: encounter.id,
    status: "signed",
    subjective: "Client reports improved symptoms.",
    objective: "Client appears stable.",
    assessment: "Condition improving.",
    plan: "Continue current treatment.",
  });

  // Step 4: Create claim
  const claim = await createClaim(supabase, {
    encounterId: encounter.id,
    status: "ready_to_submit",
  });

  // Step 5: Submit claim
  await submitClaim(supabase, claim.id);

  // Step 6: Post payment
  const payment = await postPayment(supabase, {
    organizationId,
    claimId: claim.id,
    amount: 100.0,
  });

  return {
    appointment,
    encounter,
    note,
    claim,
    payment,
  };
}
