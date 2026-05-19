/**
 * Workflow Functions
 * 
 * WORKING workflow logic extracted from test-complete-workflow.ts
 * These functions use the ACTUAL live database schema.
 * 
 * DO NOT modify these functions unless the database schema changes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mapLegacyClaimInputToProfessionalClaim } from "@/lib/claims/createProfessionalClaimFromLegacyInput";

export interface WorkflowContext {
  organizationId: string;
  clientId: string;
  providerId: string;
  insurancePolicyId: string | null;
}

export interface WorkflowResult {
  success: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  error?: string;
}

/**
 * Step 2: Create encounter from appointment
 */
export async function createEncounter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  ctx: WorkflowContext,
  appointmentId: string
): Promise<WorkflowResult> {
  const serviceDate = new Date().toISOString().split("T")[0];

  const encounterData = {
    organization_id: ctx.organizationId,
    client_id: ctx.clientId,
    provider_id: ctx.providerId,
    appointment_id: appointmentId,
    service_date: serviceDate,
    encounter_status: "in_progress",
  };

  const { data, error } = await supabase
    .from("encounters")
    .insert(encounterData)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data };
}

/**
 * Step 3: Create and sign clinical note
 */
export async function createNote(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  ctx: WorkflowContext,
  encounterId: string
): Promise<WorkflowResult> {
  const noteData = {
    organization_id: ctx.organizationId,
    encounter_id: encounterId,
  };

  const { data, error } = await supabase
    .from("encounter_notes")
    .insert(noteData)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data };
}

/**
 * Step 4: Create encounter service line
 */
export async function createServiceLine(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  ctx: WorkflowContext,
  encounterId: string
): Promise<WorkflowResult> {
  const serviceDate = new Date().toISOString().split("T")[0];

  const serviceLineData = {
    organization_id: ctx.organizationId,
    encounter_id: encounterId,
    service_date: serviceDate,
    sequence_number: 1,
    cpt_hcpcs_code: "90834",
    units: 1,
    charge_amount: "150.00",
    place_of_service_code: "11",
    rendering_provider_id: ctx.providerId,
  };

  const { data, error } = await supabase
    .from("encounter_service_lines")
    .insert(serviceLineData)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data };
}

/**
 * Step 5: Create claim with service line
 */
export async function createClaim(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  ctx: WorkflowContext,
  encounterId: string
): Promise<WorkflowResult> {
  const serviceDate = new Date().toISOString().split("T")[0];

  // Create claim
  const claimData = {
    ...mapLegacyClaimInputToProfessionalClaim({
      organization_id: ctx.organizationId,
      encounter_id: encounterId,
      client_id: ctx.clientId,
      claim_number: `CLM-${Date.now()}`,
      claim_status: "ready_to_submit",
      total_charge_amount: "150.00",
    }),
  };

  const { data: claim, error: claimError } = await supabase
    .from("professional_claims")
    .insert(claimData)
    .select()
    .single();

  if (claimError) {
    return { success: false, error: claimError.message };
  }

  // Create claim service line
  const claimServiceLineData = {
    organization_id: ctx.organizationId,
    claim_id: claim.id,
    service_date: serviceDate,
    sequence_number: 1,
    cpt_hcpcs_code: "90834",
    units: 1,
    charge_amount: "150.00",
  };

  const { error: serviceLineError } = await supabase
    .from("claim_service_lines")
    .insert(claimServiceLineData);

  if (serviceLineError) {
    return { success: false, error: serviceLineError.message };
  }

  return { success: true, data: claim };
}

/**
 * Step 7: Submit claim
 */
export async function submitClaim(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  ctx: WorkflowContext,
  claimId: string
): Promise<WorkflowResult> {
  // Update claim status
  const { error: updateError } = await supabase
    .from("professional_claims")
    .update({
      claim_status: "submitted",
    })
    .eq("id", claimId);

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  // Create submission record
  const submissionData = {
    organization_id: ctx.organizationId,
    claim_id: claimId,
    submitted_at: new Date().toISOString(),
    submission_sequence: 1,
    duplicate_detection_key: `${claimId}_${Date.now()}`,
  };

  const { data, error: submissionError } = await supabase
    .from("claim_submissions")
    .insert(submissionData)
    .select()
    .single();

  if (submissionError) {
    return { success: false, error: submissionError.message };
  }

  // Create workqueue item
  const workqueueData = {
    organization_id: ctx.organizationId,
    source_object_type: "claim",
    source_object_id: claimId,
    client_id: ctx.clientId,
    claim_id: claimId,
    work_type: "claim_follow_up",
    title: "Follow up on submitted claim",
    description: "Monitor claim status and payment",
    priority: "medium" as const,
  };

  await supabase.from("workqueue_items").insert(workqueueData);

  return { success: true, data };
}

/**
 * Step 9: Post payment
 */
export async function postPayment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  ctx: WorkflowContext,
  claimId: string
): Promise<WorkflowResult> {
  // Create payment_postings record
  const paymentPostingData = {
    organization_id: ctx.organizationId,
    posting_status: "posted",
    posting_reference: `PAY-${Date.now()}`,
    total_posted_amount: "100.00",
    note: "Insurance payment for completed service",
    posted_at: new Date().toISOString(),
  };

  const { data: paymentPosting, error: postingError } = await supabase
    .from("payment_postings")
    .insert(paymentPostingData)
    .select()
    .single();

  if (postingError) {
    return { success: false, error: postingError.message };
  }

  // Update claim to paid
  const { error: claimUpdateError } = await supabase
    .from("professional_claims")
    .update({
      claim_status: "paid",
    })
    .eq("id", claimId);

  if (claimUpdateError) {
    console.warn("Could not update claim status to paid:", claimUpdateError.message);
  }

  return { success: true, data: paymentPosting };
}
