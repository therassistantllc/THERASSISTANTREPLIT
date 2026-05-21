import type { FactLoader } from "../types";
import { organizationFact } from "./organization";
import { providersFact } from "./providers";
import { locationsFact } from "./locations";
import { payersFact } from "./payers";
import { clearinghouseFact } from "./clearinghouse";
import { feeSchedulesFact } from "./feeSchedules";
import { billingDefaultsFact } from "./billingDefaults";
import { tradingPartnerFact } from "./tradingPartner";

/**
 * All registered fact loaders. The engine registers each as a dynamic fact
 * keyed by `loader.name`; rules reference that name (plus an optional JSONPath
 * via the `path` field) when defining conditions.
 *
 * To extend the engine for the future claim scrubber, append additional
 * loaders here (e.g. per-claim facts loaded from the scrubber's input).
 */
export const factLoaders: FactLoader[] = [
  organizationFact,
  providersFact,
  locationsFact,
  payersFact,
  clearinghouseFact,
  feeSchedulesFact,
  billingDefaultsFact,
  tradingPartnerFact,
];
