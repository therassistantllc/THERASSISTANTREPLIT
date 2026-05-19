/**
 * Derive encounter workflow status from actual appointment, encounter, note, charge, claim, and payment data.
 * This is the single source of truth for workflow state throughout the application.
 */

import type {
  AppointmentRecord,
  EncounterRecord,
  ClaimRecord,
} from "@/lib/types";

export interface WorkflowInput {
  appointment?: AppointmentRecord | null;
  encounter?: EncounterRecord | null;
  note?: {
    id: string;
    status?: string | null;
    signed_at?: string | null;
  } | null;
  charge?: {
    id: string;
    status?: string | null;
    amount?: number | null;
  } | null;
  claim?: ClaimRecord | null;
  payment?: {
    id: string;
    amount?: number | null;
    posted_at?: string | null;
  } | null;
  alerts?: string[];
  eligibility?: {
    status?: string | null;
    checked_at?: string | null;
  } | null;
  patientBalance?: number | null;
  insuranceBalance?: number | null;
}

export type WorkflowStepStatus =
  | "not_started"
  | "in_progress"
  | "complete"
  | "blocked"
  | "needs_review";

export type PrimaryAction =
  | "create_encounter"
  | "start_note"
  | "continue_note"
  | "sign_note"
  | "generate_charge"
  | "create_claim"
  | "open_claim"
  | "view_claim_status"
  | "post_payment"
  | "none";

export interface WorkflowStatus {
  appointmentStatus: WorkflowStepStatus;
  encounterStatus: WorkflowStepStatus;
  noteStatus: WorkflowStepStatus;
  chargeStatus: WorkflowStepStatus;
  claimStatus: WorkflowStepStatus;
  paymentStatus: WorkflowStepStatus;
  primaryAction: PrimaryAction;
  primaryActionLabel: string;
  blockedReasons: string[];
  warnings: string[];
  nextRecommendedAction: string;
  overallProgress: number; // 0-100 percentage
}

export function deriveEncounterWorkflowStatus(input: WorkflowInput): WorkflowStatus {
  const {
    appointment,
    encounter,
    note,
    charge,
    claim,
    payment,
    alerts = [],
    eligibility,
    patientBalance,
    insuranceBalance,
  } = input;

  const blockedReasons: string[] = [];
  const warnings: string[] = [];

  // Determine appointment status
  let appointmentStatus: WorkflowStepStatus = "not_started";
  if (appointment) {
    const status = appointment.appointment_status?.toLowerCase();
    if (status === "completed") {
      appointmentStatus = "complete";
    } else if (status === "cancelled" || status === "no_show") {
      appointmentStatus = "blocked";
      blockedReasons.push(`Appointment ${status}`);
    } else if (status === "checked_in") {
      appointmentStatus = "in_progress";
    } else if (status === "scheduled") {
      appointmentStatus = "in_progress";
    }
  }

  // Determine encounter status
  let encounterStatus: WorkflowStepStatus = "not_started";
  if (encounter) {
    const status = encounter.encounter_status?.toLowerCase();
    if (status === "signed" || status === "completed") {
      encounterStatus = "complete";
    } else if (status === "draft" || status === "in_progress") {
      encounterStatus = "in_progress";
    } else {
      encounterStatus = "in_progress";
    }
  } else if (appointment && appointmentStatus === "complete") {
    encounterStatus = "needs_review";
    warnings.push("Appointment completed but no encounter created");
  }

  // Determine note status
  let noteStatus: WorkflowStepStatus = "not_started";
  if (note) {
    if (note.signed_at) {
      noteStatus = "complete";
    } else {
      const status = note.status?.toLowerCase();
      if (status === "draft" || status === "in_progress") {
        noteStatus = "in_progress";
      } else if (status === "ready_for_review") {
        noteStatus = "needs_review";
      } else {
        noteStatus = "in_progress";
      }
    }
  } else if (encounter && encounterStatus === "in_progress") {
    noteStatus = "not_started";
  }

  // Determine charge status
  let chargeStatus: WorkflowStepStatus = "not_started";
  if (charge) {
    const status = charge.status?.toLowerCase();
    if (status === "generated" || status === "complete") {
      chargeStatus = "complete";
    } else if (status === "error" || status === "failed") {
      chargeStatus = "blocked";
      blockedReasons.push("Charge generation failed");
    } else {
      chargeStatus = "in_progress";
    }
  } else if (noteStatus === "complete") {
    chargeStatus = "needs_review";
    warnings.push("Note signed but charge not generated");
  }

  // Determine claim status
  let claimStatus: WorkflowStepStatus = "not_started";
  if (claim) {
    const status = claim.claim_status?.toLowerCase();
    if (status === "paid" || status === "completed") {
      claimStatus = "complete";
    } else if (status === "denied" || status === "rejected") {
      claimStatus = "blocked";
      blockedReasons.push(`Claim ${status}`);
    } else if (status === "submitted" || status === "accepted") {
      claimStatus = "in_progress";
    } else if (status === "draft" || status === "pending") {
      claimStatus = "in_progress";
    } else {
      claimStatus = "in_progress";
    }
  } else if (chargeStatus === "complete") {
    claimStatus = "needs_review";
    warnings.push("Charge generated but claim not created");
  }

  // Determine payment status
  let paymentStatus: WorkflowStepStatus = "not_started";
  if (payment) {
    if (payment.posted_at) {
      paymentStatus = "complete";
    } else {
      paymentStatus = "in_progress";
    }
  } else if (claimStatus === "complete") {
    paymentStatus = "needs_review";
  }

  // Add eligibility warnings
  if (eligibility) {
    const status = eligibility.status?.toLowerCase();
    if (status === "inactive" || status === "not_found") {
      warnings.push("Eligibility check failed");
    } else if (!eligibility.checked_at) {
      warnings.push("Eligibility not checked");
    } else {
      const checkedDate = new Date(eligibility.checked_at);
      const daysSinceCheck = (Date.now() - checkedDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceCheck > 30) {
        warnings.push("Eligibility check is over 30 days old");
      }
    }
  } else if (appointment && !encounter) {
    warnings.push("Eligibility not checked");
  }

  // Add balance warnings
  if (patientBalance && patientBalance > 0) {
    warnings.push(`Patient balance: $${patientBalance.toFixed(2)}`);
  }
  if (insuranceBalance && insuranceBalance > 0) {
    warnings.push(`Insurance balance: $${insuranceBalance.toFixed(2)}`);
  }

  // Add custom alerts
  warnings.push(...alerts);

  // Determine primary action
  let primaryAction: PrimaryAction = "none";
  let primaryActionLabel = "";
  let nextRecommendedAction = "";

  if (!encounter && appointment) {
    primaryAction = "create_encounter";
    primaryActionLabel = "Create Encounter";
    nextRecommendedAction = "Create an encounter from this appointment to begin documentation";
  } else if (encounter && !note) {
    primaryAction = "start_note";
    primaryActionLabel = "Start Note";
    nextRecommendedAction = "Start clinical documentation for this encounter";
  } else if (note && noteStatus === "in_progress") {
    primaryAction = "continue_note";
    primaryActionLabel = "Continue Note";
    nextRecommendedAction = "Complete and sign the clinical note";
  } else if (note && noteStatus === "needs_review") {
    primaryAction = "sign_note";
    primaryActionLabel = "Sign Note";
    nextRecommendedAction = "Review and sign the clinical note";
  } else if (noteStatus === "complete" && !charge) {
    primaryAction = "generate_charge";
    primaryActionLabel = "Generate Charge";
    nextRecommendedAction = "Generate billable charges from the signed note";
  } else if (chargeStatus === "complete" && !claim) {
    primaryAction = "create_claim";
    primaryActionLabel = "Create Claim";
    nextRecommendedAction = "Create an insurance claim from the charges";
  } else if (claim && !claim.submitted_at) {
    primaryAction = "open_claim";
    primaryActionLabel = "Open Claim";
    nextRecommendedAction = "Review and submit the claim";
  } else if (claim && claim.submitted_at) {
    primaryAction = "view_claim_status";
    primaryActionLabel = "View Claim Status";
    nextRecommendedAction = "Monitor claim status and adjudication";
  } else if (claimStatus === "complete" && !payment) {
    primaryAction = "post_payment";
    primaryActionLabel = "Post Payment";
    nextRecommendedAction = "Post payment received from payer";
  } else if (paymentStatus === "complete") {
    primaryAction = "none";
    primaryActionLabel = "Workflow Complete";
    nextRecommendedAction = "This encounter workflow is complete";
  }

  // Calculate overall progress
  const steps = [
    appointmentStatus,
    encounterStatus,
    noteStatus,
    chargeStatus,
    claimStatus,
    paymentStatus,
  ];
  const completedSteps = steps.filter((s) => s === "complete").length;
  const overallProgress = Math.round((completedSteps / steps.length) * 100);

  return {
    appointmentStatus,
    encounterStatus,
    noteStatus,
    chargeStatus,
    claimStatus,
    paymentStatus,
    primaryAction,
    primaryActionLabel,
    blockedReasons,
    warnings,
    nextRecommendedAction,
    overallProgress,
  };
}
