import type { RuleSpec } from "../types";
import organization from "./organization.json";
import providers from "./providers.json";
import locations from "./locations.json";
import payers from "./payers.json";
import clearinghouse from "./clearinghouse.json";
import feeSchedules from "./feeSchedules.json";
import billingDefaults from "./billingDefaults.json";
import tradingPartner from "./tradingPartner.json";

/**
 * Aggregated rule registry. Each entry is a serializable JSON rule that the
 * engine compiles into a json-rules-engine Rule whose `event.type` is the
 * rule id and whose `event.params` carry the user-facing metadata
 * (severity, category, fixRoute, whyItMatters, resolution).
 *
 * Add new JSON rule files alongside this index and import them here to
 * extend coverage. Future claim-scrubber rules can live in a sibling
 * folder (e.g. `rules/claim/`) and be loaded into a different engine
 * instance that shares the same fact-loader infrastructure.
 */
export const allRules: RuleSpec[] = [
  ...(organization as RuleSpec[]),
  ...(providers as RuleSpec[]),
  ...(locations as RuleSpec[]),
  ...(payers as RuleSpec[]),
  ...(clearinghouse as RuleSpec[]),
  ...(feeSchedules as RuleSpec[]),
  ...(billingDefaults as RuleSpec[]),
  ...(tradingPartner as RuleSpec[]),
];
