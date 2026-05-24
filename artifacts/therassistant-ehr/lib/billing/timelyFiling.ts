/**
 * Helpers for the "Timely Filing Risk" workqueue.
 *
 * Filing deadline = oldest DOS + payer's timely_filing_days (from
 * payer_profiles.billing_rules). When the payer's rule is missing, a
 * conservative org-wide default is used so the queue stays useful.
 */

export const DEFAULT_TIMELY_FILING_DAYS = 90;
export const DEFAULT_APPEAL_DEADLINE_DAYS = 180;
export const DEFAULT_CORRECTED_CLAIM_DAYS = 180;

export type TimelyFilingTab =
  | "remaining_0_15"
  | "remaining_16_30"
  | "expired"
  | "appeal_risk"
  | "corrected_risk";

export const TIMELY_FILING_TABS: Array<{ id: TimelyFilingTab; label: string }> = [
  { id: "remaining_0_15", label: "0–15 Days Remaining" },
  { id: "remaining_16_30", label: "16–30 Days Remaining" },
  { id: "expired", label: "Expired — Review" },
  { id: "appeal_risk", label: "Appeal Deadline Risk" },
  { id: "corrected_risk", label: "Corrected Claim Deadline Risk" },
];

function readPositiveIntField(
  billingRules: unknown,
  key: string,
): number | null {
  const obj =
    billingRules && typeof billingRules === "object"
      ? (billingRules as Record<string, unknown>)
      : {};
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  return null;
}

export function readTimelyFilingDays(billingRules: unknown): number | null {
  return readPositiveIntField(billingRules, "timely_filing_days");
}

export function readAppealDeadlineDays(billingRules: unknown): number | null {
  return readPositiveIntField(billingRules, "appeal_deadline_days");
}

export function readCorrectedClaimDays(billingRules: unknown): number | null {
  return readPositiveIntField(billingRules, "corrected_claim_days");
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenISO(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * "Reason not filed" — short human-readable label derived from claim status.
 * The queue is meaningful when a claim has NOT been transmitted to the
 * payer yet (or was denied and needs a corrected/appeal submission).
 */
export function reasonNotFiled(claimStatus: string | null): string {
  switch ((claimStatus ?? "").toLowerCase()) {
    case "draft":
      return "Draft – not yet built";
    case "validation_errors":
    case "validation_failed":
      return "Validation errors";
    case "ready_for_batch":
      return "Awaiting batch send";
    case "on_hold":
    case "claim_hold":
      return "Manual hold";
    case "documentation_pending":
      return "Awaiting documentation";
    case "needs_authorization":
      return "Needs authorization";
    case "denied":
      return "Denied — needs appeal/correction";
    case "rejected_oa":
    case "rejected_payer":
      return "Rejected — needs correction";
    case "submitted":
    case "accepted_oa":
    case "accepted_payer":
      return "Submitted — at payer";
    default:
      return claimStatus ? claimStatus.replace(/_/g, " ") : "Unknown";
  }
}

/** Statuses we consider "not yet filed" for the main timely-filing tabs. */
export const UNFILED_STATUSES = new Set<string>([
  "draft",
  "validation_errors",
  "validation_failed",
  "ready_for_batch",
  "on_hold",
  "claim_hold",
  "documentation_pending",
  "needs_authorization",
  "rejected_oa",
  "rejected_payer",
]);
