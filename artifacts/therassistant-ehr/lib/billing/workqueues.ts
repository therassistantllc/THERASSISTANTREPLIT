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
    id: "my_inbox",
    title: "My Inbox",
    description: "Eligibility issues routed to you for clinician verification or admin follow-up.",
    href: "/billing/my-inbox",
    stage: "executive",
    status: "live",
  },
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
  {
    id: "provider_enrollment_issues",
    title: "Provider Enrollment Issues",
    description: "Claims impacted by credentialing, enrollment, or payer setup problems for the rendering or billing provider.",
    href: "/billing/provider-enrollment-issues",
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
    id: "transmission_failures",
    title: "Transmission Failures",
    description: "Technical failures before or during claim transmission — API, SFTP, or malformed batches.",
    href: "/billing/transmission-failures",
    stage: "submission_rejections",
    status: "live",
  },
  {
    id: "submitted_claims",
    title: "Submitted Claims",
    description: "Individual claims that have been transmitted and are awaiting payer response.",
    href: "/billing/submitted-claims",
    stage: "submission_rejections",
    status: "live",
  },
  {
    id: "payer_received",
    title: "Payer Received",
    description: "Claims accepted by the payer but not yet adjudicated — track 276/277 status and follow up.",
    href: "/billing/payer-received",
    stage: "submission_rejections",
    status: "live",
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
    id: "rejections_277ca",
    title: "277CA Rejections",
    description: "Claims rejected after clearinghouse / payer claim-level validation (277CA acknowledgements).",
    href: "/billing/rejections-277ca",
    stage: "submission_rejections",
    status: "live",
  },
  {
    id: "payer_rejections",
    title: "Payer Rejections",
    description: "Claims the payer rejected for front-end edits — fix and resubmit.",
    href: "/billing/payer-rejections",
    stage: "submission_rejections",
    status: "live",
  },
  {
    id: "resubmission_queue",
    title: "Resubmission Queue",
    description: "Corrected claims queued for resubmission with the appropriate frequency code.",
    href: "/billing/resubmissions",
    stage: "submission_rejections",
    status: "live",
  },
  {
    id: "corrected_claims",
    title: "Corrected Claims",
    description: "Denied or rejected claims that need a corrected resubmission — replacement (frequency 7) or void (frequency 8).",
    href: "/billing/corrected-claims",
    stage: "submission_rejections",
    status: "live",
  },

  // ── Adjudication & Denials ──────────────────────────────────────────────
  {
    id: "no_response_aging",
    title: "No Response (Aging)",
    description: "Submitted claims with no payer response past the aging threshold.",
    href: "/billing/no-response",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "aging",
    title: "Aging",
    description: "Time-based follow-up on every open claim, bucketed by age in days.",
    href: "/billing/aging",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "denials_by_carc",
    title: "Denied Claims by CARC",
    description: "Denied claims grouped by Claim Adjustment Reason Code — drill into a CARC to bulk assign, appeal, or correct.",
    href: "/billing/denials-by-carc",
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
    id: "denials_by_rarc",
    title: "Denied Claims by RARC",
    description: "Denials grouped by Remittance Advice Remark Code — explanation-first view with recommended actions.",
    href: "/billing/denials-by-rarc",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "partial_denials",
    title: "Partial Denials",
    description: "Claims paid in part — investigate underpaid lines and pursue remainder.",
    href: "/billing/partial-denials",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "appeals_needed",
    title: "Appeals Needed",
    description: "Claims requiring formal payer appeal — draft, send, track, and decide.",
    href: "/billing/appeals",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "underpayments",
    title: "Underpayments",
    description: "Lines reimbursed below the contracted fee schedule.",
    href: "/billing/underpayments",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "adjustments_review",
    title: "Adjustments Review",
    description: "Suspicious or non-contractual adjustments flagged for biller review.",
    href: "/billing/adjustments-review",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "medical_necessity",
    title: "Medical Necessity",
    description: "Claims denied for medical-necessity reasons — gather records and appeal.",
    href: "/billing/medical-necessity",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "medical_review",
    title: "Medical Review / Documentation Requested",
    description: "Claims where the payer requested records, treatment plans, notes, or other clinical support.",
    href: "/billing/medical-review",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "timely_filing",
    title: "Timely Filing Risk",
    description: "Claims approaching the payer's filing deadline — submit, appeal, or write off before the window closes.",
    href: "/billing/timely-filing",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "coordination_of_benefits",
    title: "COB Issues",
    description: "Claims requiring COB updates before secondary/tertiary billing.",
    href: "/billing/cob-issues",
    stage: "adjudication_denials",
    status: "live",
  },
  {
    id: "secondary_billing",
    title: "Secondary Billing Needed",
    description: "Generate secondary claims after primary payer adjudication.",
    href: "/billing/secondary-billing",
    stage: "adjudication_denials",
    status: "live",
  },

  // ── Payments & ERA ──────────────────────────────────────────────────────
  {
    id: "era_import",
    title: "ERA Import",
    description: "Incoming 835 remittances — review, match, and post the resulting payments.",
    href: "/billing/era-import",
    stage: "payments_era",
    status: "live",
  },
  {
    id: "unmatched_era_claims",
    title: "Unmatched ERA Claims",
    description: "ERA claim-payment lines that could not be auto-matched to an internal claim — review, match, or create the missing record.",
    href: "/billing/unmatched-era",
    stage: "payments_era",
    status: "live",
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
    id: "partial_payments",
    title: "Partial Payments",
    description: "Review claims paid in part — investigate ERA adjustments, pursue remainder, or transfer to patient.",
    href: "/billing/partial-payments",
    stage: "payments_era",
    status: "live",
  },
  {
    id: "paper_checks",
    title: "Paper Checks",
    description: "Physical / paper checks received from payers — track receipt, deposit, posting, and unmatched items.",
    href: "/billing/paper-checks",
    stage: "payments_era",
    status: "live",
  },
  {
    id: "unposted_payments",
    title: "Unposted Payments",
    description: "Payments received but not yet matched to a claim.",
    href: "/billing/unposted-payments",
    stage: "payments_era",
    status: "live",
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
    title: "Refund / Overpayment",
    description: "Manage credit balances and payer / patient refunds — approve, issue, or apply to balance.",
    href: "/billing/refunds",
    stage: "payments_era",
    status: "live",
  },
  {
    id: "recoupments",
    title: "Recoupments / Takebacks",
    description: "Payer take-backs and overpayment recovery — disputes, accepted adjustments, and offsets against future remittances.",
    href: "/billing/recoupments",
    stage: "payments_era",
    status: "live",
  },
  {
    id: "credit_balances",
    title: "Credit Balances",
    description: "Accounts with a credit balance that should be refunded or transferred.",
    href: "/billing/credit-balances",
    stage: "payments_era",
    status: "live",
  },
  {
    id: "vcc",
    title: "VCC",
    description: "Virtual credit card payments from payers — track receipt, fee review, ERA match, and posting.",
    href: "/billing/vcc",
    stage: "payments_era",
    status: "live",
  },
  {
    id: "reconciliation_exceptions",
    title: "Reconciliation Exceptions",
    description: "Bank-to-EHR mismatches that block daily reconciliation.",
    href: "/billing/reconciliation-exceptions",
    stage: "payments_era",
    status: "live",
  },

  // ── Patient & Oversight ─────────────────────────────────────────────────
  {
    id: "patient_responsibility",
    title: "Patient Responsibility Generated",
    description: "Insurance has adjudicated — move the remaining balance to patient billing (deductible, copay, coinsurance, noncovered).",
    href: "/billing/patient-responsibility",
    stage: "patient_oversight",
    status: "live",
  },
  {
    id: "patient_billing",
    title: "Patient Billing",
    description: "Self-pay balances after insurance processing — statements, payments, plans, and collections review.",
    href: "/billing/patient-billing",
    stage: "patient_oversight",
    status: "live",
  },
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
    status: "live",
  },
  {
    id: "write_offs",
    title: "Write-offs",
    description: "Recent write-offs and reversals for audit.",
    href: "/billing/write-offs",
    stage: "patient_oversight",
    status: "live",
  },
  {
    id: "audit_queue",
    title: "Audit Queue",
    description: "Claims selected for internal pre-bill or post-payment audit.",
    href: "/billing/audit-queue",
    stage: "patient_oversight",
    status: "live",
  },
  {
    id: "compliance_audit",
    title: "Compliance & Audit",
    description: "Pre- and post-submission billing risk — missing signatures, modifier audits, diagnosis audits, late docs, overlaps, and high-risk patterns.",
    href: "/billing/compliance-audit",
    stage: "patient_oversight",
    status: "live",
  },
  {
    id: "compliance_holds",
    title: "Compliance Holds",
    description: "Claims paused by compliance — false-claims risk, sanctioned provider, etc.",
    href: "/billing/compliance-holds",
    stage: "patient_oversight",
    status: "live",
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
