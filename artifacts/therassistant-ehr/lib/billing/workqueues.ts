/**
 * Central registry of all 37 billing workqueues, grouped by lifecycle stage.
 * Each entry is referenced by the billing left navigation and by individual
 * workqueue pages (so the page can pull its title/description from one place).
 *
 * status:
 *   "live"        — page exists and is wired to data
 *   "coming_soon" — appears in nav as a placeholder; route may 404
 */

export type WorkqueueStage =
  | "executive"
  | "pre_submission"
  | "submission_rejections"
  | "adjudication_denials"
  | "payments_era"
  | "patient_oversight";

export type WorkqueueStatus = "live" | "coming_soon";

export interface WorkqueueDef {
  id: string;
  title: string;
  description: string;
  href: string;
  stage: WorkqueueStage;
  status: WorkqueueStatus;
}

export const WORKQUEUE_STAGES: Array<{ id: WorkqueueStage; label: string }> = [
  { id: "executive", label: "Executive" },
  { id: "pre_submission", label: "Pre-submission" },
  { id: "submission_rejections", label: "Submission & Rejections" },
  { id: "adjudication_denials", label: "Adjudication & Denials" },
  { id: "payments_era", label: "Payments & ERA" },
  { id: "patient_oversight", label: "Patient & Oversight" },
];

export const WORKQUEUES: WorkqueueDef[] = [
  // ── Executive ───────────────────────────────────────────────────────────
  {
    id: "executive_priority",
    title: "Executive / Priority",
    description: "High-level action list for owners and admins — the highest-impact claims across every stage.",
    href: "/billing/executive-priority",
    stage: "executive",
    status: "live",
  },

  // ── Pre-submission ──────────────────────────────────────────────────────
  {
    id: "charge_capture",
    title: "Charge Capture",
    description: "Unsigned and unreleased charges waiting on documentation, codes, or provider review.",
    href: "/billing/charge-capture",
    stage: "pre_submission",
    status: "live",
  },
  {
    id: "documentation_pending",
    title: "Documentation Pending",
    description: "Encounters released to billing but missing a signed clinical note.",
    href: "/billing/documentation-pending",
    stage: "pre_submission",
    status: "live",
  },
  {
    id: "eligibility_issues",
    title: "Eligibility Issues",
    description: "Patients whose latest 270/271 eligibility check failed or returned a coverage problem.",
    href: "/billing/eligibility-issues",
    stage: "pre_submission",
    status: "live",
  },
  {
    id: "authorization_required",
    title: "Authorization Required",
    description: "Services that require a prior authorization but none is on file or it has expired.",
    href: "/billing/authorization-required",
    stage: "pre_submission",
    status: "live",
  },
  {
    id: "claim_hold",
    title: "Claim Hold",
    description: "Manually held claims — awaiting biller review, follow-up, or supervisor sign-off.",
    href: "/billing/claim-hold",
    stage: "pre_submission",
    status: "live",
  },
  {
    id: "ready_to_generate",
    title: "Ready to Generate",
    description: "Charges that have passed all gates and are ready to be turned into 837P claims.",
    href: "/billing/ready-to-generate",
    stage: "pre_submission",
    status: "live",
  },
  {
    id: "claim_build_errors",
    title: "Claim Build Errors",
    description: "Claims that failed automated 837P assembly — bad NPIs, missing loops, etc.",
    href: "/billing/claim-build-errors",
    stage: "pre_submission",
    status: "live",
  },
  {
    id: "duplicate_claim_review",
    title: "Duplicate Claim Review",
    description: "Potential duplicates blocked before submission so billers can confirm or merge.",
    href: "/billing/duplicate-claim-review",
    stage: "pre_submission",
    status: "live",
  },

  // ── Submission & Rejections ─────────────────────────────────────────────
  {
    id: "batch_review",
    title: "Batch Review",
    description: "All 837P batches — draft, ready to submit, submitted, failed, and partially accepted.",
    href: "/billing/837p-batches",
    stage: "submission_rejections",
    status: "live",
  },
  {
    id: "submitted_claims",
    title: "Submitted Claims",
    description: "Individual claims that have been transmitted and are awaiting payer response.",
    href: "/billing/submitted-claims",
    stage: "submission_rejections",
    status: "coming_soon",
  },
  {
    id: "clearinghouse_rejections",
    title: "Clearinghouse Rejections",
    description: "Claims rejected by the clearinghouse (999/277CA) before reaching the payer.",
    href: "/billing/claim-edit-dashboard",
    stage: "submission_rejections",
    status: "live",
  },
  {
    id: "rejections_999",
    title: "999 Rejections",
    description: "Claims and batches rejected at the file/syntax level on the 999 acknowledgement.",
    href: "/billing/rejections-999",
    stage: "submission_rejections",
    status: "live",
  },
  {
    id: "payer_rejections",
    title: "Payer Rejections",
    description: "Claims the payer rejected for front-end edits — fix and resubmit.",
    href: "/billing/payer-rejections",
    stage: "submission_rejections",
    status: "coming_soon",
  },
  {
    id: "resubmission_queue",
    title: "Resubmission Queue",
    description: "Corrected claims queued for resubmission with the appropriate frequency code.",
    href: "/billing/resubmissions",
    stage: "submission_rejections",
    status: "coming_soon",
  },

  // ── Adjudication & Denials ──────────────────────────────────────────────
  {
    id: "no_response_aging",
    title: "No Response (Aging)",
    description: "Submitted claims with no payer response past the aging threshold.",
    href: "/billing/claim-readiness",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "denials",
    title: "Denials",
    description: "Denied claims — add notes, draft appeals, write off, or bill the patient.",
    href: "/billing/claim-submission",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "partial_denials",
    title: "Partial Denials",
    description: "Claims paid in part — investigate underpaid lines and pursue remainder.",
    href: "/billing/partial-denials",
    stage: "adjudication_denials",
    status: "coming_soon",
  },
  {
    id: "appeals_pending",
    title: "Appeals Pending",
    description: "Open appeals with the payer — track timely-filing deadlines and statuses.",
    href: "/billing/appeals",
    stage: "adjudication_denials",
    status: "coming_soon",
  },
  {
    id: "underpayments",
    title: "Underpayments",
    description: "Lines reimbursed below the contracted fee schedule.",
    href: "/billing/underpayments",
    stage: "adjudication_denials",
    status: "coming_soon",
  },
  {
    id: "adjustments_review",
    title: "Adjustments Review",
    description: "Suspicious or non-contractual adjustments flagged for biller review.",
    href: "/billing/adjustments-review",
    stage: "adjudication_denials",
    status: "coming_soon",
  },
  {
    id: "medical_necessity",
    title: "Medical Necessity",
    description: "Claims denied for medical-necessity reasons — gather records and appeal.",
    href: "/billing/medical-necessity",
    stage: "adjudication_denials",
    status: "coming_soon",
  },
  {
    id: "coordination_of_benefits",
    title: "Coordination of Benefits",
    description: "Claims requiring COB updates before secondary/tertiary billing.",
    href: "/billing/cob",
    stage: "adjudication_denials",
    status: "coming_soon",
  },

  // ── Payments & ERA ──────────────────────────────────────────────────────
  {
    id: "era_posting",
    title: "ERA Posting",
    description: "Incoming 835 remittances awaiting auto-post or manual review.",
    href: "/billing/era-posting",
    stage: "payments_era",
    status: "coming_soon",
  },
  {
    id: "manual_payments",
    title: "Manual Payments",
    description: "Posted manual / paper EOBs and the associated allocations.",
    href: "/billing/payments",
    stage: "payments_era",
    status: "live",
  },
  {
    id: "unposted_payments",
    title: "Unposted Payments",
    description: "Payments received but not yet matched to a claim.",
    href: "/billing/unposted-payments",
    stage: "payments_era",
    status: "coming_soon",
  },
  {
    id: "patient_payments",
    title: "Patient Payments",
    description: "Patient-side payments — copays, deductibles, self-pay, and portal pays.",
    href: "/billing/patient-payments",
    stage: "payments_era",
    status: "coming_soon",
  },
  {
    id: "refund_requests",
    title: "Refund Requests",
    description: "Pending refunds — patient and payer — awaiting approval or processing.",
    href: "/billing/refund-requests",
    stage: "payments_era",
    status: "coming_soon",
  },
  {
    id: "recoupments",
    title: "Recoupments",
    description: "Payer take-backs applied against future remittances.",
    href: "/billing/recoupments",
    stage: "payments_era",
    status: "coming_soon",
  },
  {
    id: "credit_balances",
    title: "Credit Balances",
    description: "Accounts with a credit balance that should be refunded or transferred.",
    href: "/billing/credit-balances",
    stage: "payments_era",
    status: "coming_soon",
  },
  {
    id: "reconciliation_exceptions",
    title: "Reconciliation Exceptions",
    description: "Bank-to-EHR mismatches that block daily reconciliation.",
    href: "/billing/reconciliation-exceptions",
    stage: "payments_era",
    status: "coming_soon",
  },

  // ── Patient & Oversight ─────────────────────────────────────────────────
  {
    id: "patient_statements",
    title: "Patient Statements",
    description: "Statements queued for delivery — paper and electronic.",
    href: "/billing/patient-statements",
    stage: "patient_oversight",
    status: "coming_soon",
  },
  {
    id: "patient_collections",
    title: "Patient Collections",
    description: "Self-pay balances past the collections threshold.",
    href: "/billing/patient-collections",
    stage: "patient_oversight",
    status: "coming_soon",
  },
  {
    id: "bad_debt_review",
    title: "Bad Debt Review",
    description: "Balances proposed for bad-debt write-off pending supervisor approval.",
    href: "/billing/bad-debt-review",
    stage: "patient_oversight",
    status: "coming_soon",
  },
  {
    id: "write_offs",
    title: "Write-offs",
    description: "Recent write-offs and reversals for audit.",
    href: "/billing/write-offs",
    stage: "patient_oversight",
    status: "coming_soon",
  },
  {
    id: "audit_queue",
    title: "Audit Queue",
    description: "Claims selected for internal pre-bill or post-payment audit.",
    href: "/billing/audit-queue",
    stage: "patient_oversight",
    status: "coming_soon",
  },
  {
    id: "compliance_holds",
    title: "Compliance Holds",
    description: "Claims paused by compliance — false-claims risk, sanctioned provider, etc.",
    href: "/billing/compliance-holds",
    stage: "patient_oversight",
    status: "coming_soon",
  },
  {
    id: "reports_analytics",
    title: "Reports & Analytics",
    description: "Cross-queue dashboards, KPIs, and exportable reports.",
    href: "/billing/reports",
    stage: "patient_oversight",
    status: "live",
  },
];

export function getWorkqueue(id: string): WorkqueueDef | undefined {
  return WORKQUEUES.find((w) => w.id === id);
}

export function workqueuesByStage(): Array<{ stage: WorkqueueStage; label: string; items: WorkqueueDef[] }> {
  return WORKQUEUE_STAGES.map((s) => ({
    stage: s.id,
    label: s.label,
    items: WORKQUEUES.filter((w) => w.stage === s.id),
  }));
}

/**
 * Universal filter ids — every workqueue accepts the same filter set
 * (queue-specific filters can be added on top).
 */
export const UNIVERSAL_FILTER_IDS = [
  "practice",
  "clinician",
  "payer",
  "client",
  "dosFrom",
  "dosTo",
  "status",
  "assignedBiller",
  "minAmount",
  "maxAmount",
  "agingBucket",
  "carcRarc",
  "priority",
  "followUpDue",
] as const;

export type UniversalFilterId = (typeof UNIVERSAL_FILTER_IDS)[number];
