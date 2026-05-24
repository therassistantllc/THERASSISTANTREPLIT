/**
 * Shared mapping for the 277CA Rejections workqueue.
 *
 * The 277CA Health Care Claim Acknowledgement carries a Status Information
 * (STC) segment with three codes — STC01-1 (category), STC01-2 (status), and
 * STC01-3 (entity). We map those, plus the human-readable rejection message,
 * into the six tabs from the spec.
 */

export type Rejection277CaTabId =
  | "rejected_by_clearinghouse"
  | "rejected_by_payer"
  | "invalid_member"
  | "invalid_provider"
  | "invalid_payer_id"
  | "invalid_claim_data";

export const REJECTION_277CA_TABS: Array<{ id: Rejection277CaTabId; label: string }> = [
  { id: "rejected_by_clearinghouse", label: "Rejected by Clearinghouse" },
  { id: "rejected_by_payer", label: "Rejected by Payer" },
  { id: "invalid_member", label: "Invalid Member" },
  { id: "invalid_provider", label: "Invalid Provider" },
  { id: "invalid_payer_id", label: "Invalid Payer ID" },
  { id: "invalid_claim_data", label: "Invalid Claim Data" },
];

const MEMBER_KEYWORDS = [
  "subscriber",
  "insured",
  "member id",
  "member number",
  "patient id",
  "patient gender",
  "patient dob",
  "date of birth",
  "eligibility",
  "policy number",
  "hicn",
];

const PROVIDER_KEYWORDS = [
  "provider",
  "npi",
  "taxonomy",
  "rendering",
  "billing provider",
  "referring",
  "supervising",
  "facility npi",
];

const PAYER_ID_KEYWORDS = [
  "payer id",
  "payer identification",
  "payor id",
  "receiver",
  "trading partner",
  "submitter id",
];

function lower(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

/**
 * Decide which tab a 277CA rejection belongs to. Order of precedence:
 *   1. If the rejection came from the clearinghouse (A3 / clearinghouse
 *      entity), it lands in "Rejected by Clearinghouse".
 *   2. Otherwise, look for member / provider / payer-id keywords in the
 *      message; those go to their dedicated tabs.
 *   3. If we can confirm the payer (not the CH) issued the reject (A7/A8
 *      with entity_code=PR), it falls into "Rejected by Payer".
 *   4. Anything else — "Invalid Claim Data".
 */
export function classifyRejection277Ca(input: {
  message: string | null;
  categoryCode?: string | null;
  statusCode?: string | null;
  entityCode?: string | null;
  source?: string | null;
}): Rejection277CaTabId {
  const msg = lower(input.message);
  const category = lower(input.categoryCode);
  const entity = lower(input.entityCode);
  const source = lower(input.source);

  // Clearinghouse first: explicit entity = "clearinghouse" or source carries
  // an A3-style ack from the CH layer.
  const fromClearinghouse =
    entity === "ch" ||
    entity === "clearinghouse" ||
    source === "clearinghouse" ||
    category === "a3";

  // Keyword classification on the message wins over the generic "by payer"
  // bucket so the user sees the actionable tab.
  if (MEMBER_KEYWORDS.some((k) => msg.includes(k))) return "invalid_member";
  if (PROVIDER_KEYWORDS.some((k) => msg.includes(k))) return "invalid_provider";
  if (PAYER_ID_KEYWORDS.some((k) => msg.includes(k))) return "invalid_payer_id";

  if (fromClearinghouse) return "rejected_by_clearinghouse";

  const fromPayer =
    entity === "pr" ||
    entity === "payer" ||
    source === "payer" ||
    category === "a7" ||
    category === "a8";
  if (fromPayer) return "rejected_by_payer";

  return "invalid_claim_data";
}

export function rejection277CaTabLabel(id: Rejection277CaTabId): string {
  return REJECTION_277CA_TABS.find((t) => t.id === id)?.label ?? id;
}

/**
 * Human-readable "category" string we put in the Category column. Combines
 * the STC category and status codes when present, else falls back to the
 * tab label.
 */
export function rejection277CaCategoryLabel(
  categoryCode: string | null,
  statusCode: string | null,
  tab: Rejection277CaTabId,
): string {
  const parts = [categoryCode, statusCode].map((v) => String(v ?? "").trim()).filter(Boolean);
  if (parts.length > 0) return parts.join(" / ");
  return rejection277CaTabLabel(tab);
}
