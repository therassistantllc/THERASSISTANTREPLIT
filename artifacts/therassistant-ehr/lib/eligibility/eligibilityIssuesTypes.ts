export type EligibilityIssueType =
  | "inactive_coverage"
  | "stale_eligibility"
  | "cob_issue"
  | "missing_subscriber_info"
  | "terminated_plan"
  | "payer_mismatch";

export const ELIGIBILITY_ISSUE_TABS: Array<{ id: EligibilityIssueType; label: string }> = [
  { id: "inactive_coverage", label: "Inactive Coverage" },
  { id: "stale_eligibility", label: "Stale Eligibility" },
  { id: "cob_issue", label: "COB Issue" },
  { id: "missing_subscriber_info", label: "Missing Subscriber Info" },
  { id: "terminated_plan", label: "Terminated Plan" },
  { id: "payer_mismatch", label: "Payer Mismatch" },
];

export interface EligibilityIssueRow {
  id: string;
  appointmentId: string | null;
  eligibilityCheckId: string | null;
  insurancePolicyId: string | null;
  clientId: string;
  clientName: string;
  payerId: string | null;
  payerName: string;
  memberId: string;
  dateOfService: string | null;
  lastEligibilityCheck: string | null;
  eligibilityStatus: string;
  issueType: EligibilityIssueType;
  issueLabel: string;
  copay: number | null;
  deductible: number | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  relatedClaimId: string | null;
  relatedClaimNumber: string | null;
  relatedAppointmentStart: string | null;
  totalCharge: number;
  claimStatus: string | null;
  daysSinceCheck: number | null;
  policyCount: number;
  manuallyVerifiedAt: string | null;
  holdNote: string | null;
  providerId: string | null;
  practiceId: string | null;
  assignedTo: string | null;
  assignedToKind: "clinician" | "admin" | "biller" | null;
  assignedToUserId: string | null;
  assignedToEmail: string | null;
  routedByUserId: string | null;
  inboxItemId: string | null;
  assignedBillerId: string | null;
  followUpDueAt: string | null;
  denialCode: string | null;
}

export interface EligibilityIssueFilters {
  practice?: string;
  clinician?: string;
  client?: string;
  payer?: string;
  dosFrom?: string;
  dosTo?: string;
  status?: string;
  priority?: string;
  minAmount?: string;
  maxAmount?: string;
  agingBucket?: string;
  assignedBiller?: string;
  carcRarc?: string;
  followUpDue?: string;
}
