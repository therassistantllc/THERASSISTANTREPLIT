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
  "client id",
  "client gender",
  "client dob",
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
 * X12 277CA STC03 entity identifier codes we use to auto-route a
 * rejection at intake time, before any biller has read the message.
 *
 *   - "IL" → Insured / Subscriber (member problem)
 *   - "QC" → Client (also a member problem)
 *   - "82" → Rendering Provider
 *   - "85" → Billing Provider
 *   - "71" → Attending Physician
 *   - "DK" → Ordering Physician
 *   - "DN" → Referring Provider
 *   - "P3" → Primary Care Provider
 *   - "FA" → Facility / Service Location
 *   - "77" → Service Location
 *   - "PR" → Payer
 *   - "40" → Receiver / Trading Partner (payer id problem)
 *   - "CH" → Clearinghouse
 *
 * Anything else falls through to the message-keyword classifier.
 */
const MEMBER_ENTITY_CODES = new Set(["IL", "QC"]);
const PROVIDER_ENTITY_CODES = new Set([
  "82", "85", "71", "DK", "DN", "P3", "FA", "77",
]);
const PAYER_ID_ENTITY_CODES = new Set(["40"]);

type StcEntry = {
  category?: string | null;
  status?: string | null;
  entity?: string | null;
};

/**
 * Pick a single auto-route tab from the parsed STC entries on a 277CA
 * acknowledgement. Returns null when no STC entry maps cleanly — that
 * lets the caller leave the item in the regular "Rejected by Payer" /
 * "Rejected by Clearinghouse" bucket and rely on the biller to choose
 * a hand-off manually.
 *
 * Precedence mirrors the spec: a member problem auto-routes to
 * eligibility, a provider problem auto-routes to credentialing, and a
 * payer-id problem stays in the 277CA queue under "Invalid Payer ID"
 * (no dedicated downstream queue today, so we don't auto-defer it).
 */
export function classifyRejection277CaFromStcEntries(
  entries: StcEntry[] | null | undefined,
): Rejection277CaTabId | null {
  if (!entries || entries.length === 0) return null;

  let sawMember = false;
  let sawProvider = false;
  let sawPayerId = false;

  for (const entry of entries) {
    const category = String(entry.category ?? "").trim().toUpperCase();
    const status = String(entry.status ?? "").trim();
    const entity = String(entry.entity ?? "").trim().toUpperCase();

    // Only look at entries that actually indicate a reject. A1/A2/A5 are
    // accepts and must not contribute to auto-routing decisions.
    const isReject =
      ["A3", "A6", "A7", "A8", "E0"].includes(category) ||
      ["562", "U", "R"].includes(status.toUpperCase());
    if (!isReject) continue;

    if (MEMBER_ENTITY_CODES.has(entity)) sawMember = true;
    if (PROVIDER_ENTITY_CODES.has(entity)) sawProvider = true;
    if (PAYER_ID_ENTITY_CODES.has(entity)) sawPayerId = true;
  }

  if (sawMember) return "invalid_member";
  if (sawProvider) return "invalid_provider";
  if (sawPayerId) return "invalid_payer_id";
  return null;
}

/**
 * Decide which hand-off queue (if any) a freshly-arrived 277CA rejection
 * should auto-defer into. Combines the structured STC entity-code path
 * with the existing message-keyword classifier as a fallback.
 *
 * Returns `null` when no automatic hand-off applies — the caller should
 * then leave the item in the 277CA queue for the biller to triage.
 */
export function pickAutoRouteForRejection277Ca(input: {
  stcEntries?: StcEntry[] | null;
  message?: string | null;
  categoryCode?: string | null;
  statusCode?: string | null;
  entityCode?: string | null;
}): { tab: Rejection277CaTabId; reason: "routed_to_eligibility" | "routed_to_credentialing" } | null {
  const fromStc = classifyRejection277CaFromStcEntries(input.stcEntries ?? null);
  const fromMessage = classifyRejection277Ca({
    message: input.message ?? null,
    categoryCode: input.categoryCode ?? null,
    statusCode: input.statusCode ?? null,
    entityCode: input.entityCode ?? null,
    source: "277CA",
  });

  // Prefer the structured STC signal; fall back to the keyword classifier
  // (which only auto-routes when it picked one of the two actionable tabs).
  const tab = fromStc
    ?? (fromMessage === "invalid_member" || fromMessage === "invalid_provider"
      ? fromMessage
      : null);

  if (tab === "invalid_member") return { tab, reason: "routed_to_eligibility" };
  if (tab === "invalid_provider") return { tab, reason: "routed_to_credentialing" };
  return null;
}

export type Rejection277CaAutoRouteSettings = {
  enabled: boolean;
  routeInvalidMember: boolean;
  routeInvalidProvider: boolean;
};

export const REJECTION_277CA_AUTOROUTE_DEFAULTS: Rejection277CaAutoRouteSettings = {
  enabled: true,
  routeInvalidMember: true,
  routeInvalidProvider: true,
};

export const REJECTION_277CA_AUTOROUTE_SETTING_KEY = "billing.rejections_277ca_autoroute";

/**
 * Read the per-org auto-routing config out of `system_settings`. Defaults
 * to "on" so newly-onboarded practices benefit automatically; a practice
 * that prefers manual routing can flip `enabled` to false (or disable a
 * single tab) in their settings row.
 */
export async function loadRejection277CaAutoRouteSettings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  organizationId: string,
): Promise<Rejection277CaAutoRouteSettings> {
  try {
    const { data, error } = await supabase
      .from("system_settings")
      .select("setting_value")
      .eq("organization_id", organizationId)
      .eq("setting_key", REJECTION_277CA_AUTOROUTE_SETTING_KEY)
      .maybeSingle();
    if (error || !data?.setting_value || typeof data.setting_value !== "object") {
      return { ...REJECTION_277CA_AUTOROUTE_DEFAULTS };
    }
    const raw = data.setting_value as Record<string, unknown>;
    return {
      enabled:
        typeof raw.enabled === "boolean" ? raw.enabled : REJECTION_277CA_AUTOROUTE_DEFAULTS.enabled,
      routeInvalidMember:
        typeof raw.route_invalid_member === "boolean"
          ? raw.route_invalid_member
          : REJECTION_277CA_AUTOROUTE_DEFAULTS.routeInvalidMember,
      routeInvalidProvider:
        typeof raw.route_invalid_provider === "boolean"
          ? raw.route_invalid_provider
          : REJECTION_277CA_AUTOROUTE_DEFAULTS.routeInvalidProvider,
    };
  } catch {
    return { ...REJECTION_277CA_AUTOROUTE_DEFAULTS };
  }
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
