type UUID = string;

type AppointmentStatus = "scheduled" | "checked_in" | "completed" | "cancelled" | "no_show";
type EncounterStatus = "draft" | "in_review" | "signed" | "ready_to_bill" | "billed" | "corrected" | "voided";
type DocumentationStatus = "not_started" | "in_progress" | "complete" | "signed" | "addendum_needed";
type BillingStatus = "hold" | "ready" | "scrubbed" | "claim_created" | "submitted" | "paid" | "denied";
type ClaimStatus = "draft" | "ready" | "submitted" | "accepted" | "rejected" | "denied" | "paid" | "appealed" | "voided";

interface PatientChartSummary {
  patient: Record<string, unknown>;
  documents: Record<string, unknown>[];
  policies: Record<string, unknown>[];
  billingTransactions: Record<string, unknown>[];
  appointments: Record<string, unknown>[];
  encounters: Record<string, unknown>[];
  workqueueItems: Record<string, unknown>[];
}

export interface PipelineResult {
  ok: boolean;
  appointmentId?: UUID;
  encounterId?: UUID;
  noteId?: UUID;
  claimId?: UUID;
  workqueueItemId?: UUID;
  message: string;
  missing?: string[];
}
