import type { FactContext, FactLoader } from "../types";
import { isValidNpi } from "../npi";

const BILLING_PROFILE_KEY = "organization.billing_profile";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidEin(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length === 9;
}

function isValidEmail(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  // Pragmatic, not RFC-strict — matches the front-end validator.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isValidPhone(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  return value.replace(/\D/g, "").length === 10;
}

/**
 * Trading Partner fact loader. Reads the `organization.billing_profile` JSONB blob from
 * `system_settings` (where /settings/organization persists billing identifiers today) and
 * derives the boolean flags that the Trading Partner readiness rules consume.
 *
 * Surfaces both presence and format-validity for the four Office Ally trading-partner
 * essentials: billing NPI (with Luhn checksum), EIN (9 digits), billing address, and
 * authorized representative contact.
 */
export const tradingPartnerFact: FactLoader = {
  name: "tradingPartner",
  async load({ organizationId, supabase }: FactContext) {
    const { data, error } = await supabase
      .from("system_settings")
      .select("setting_value")
      .eq("organization_id", organizationId)
      .eq("setting_key", BILLING_PROFILE_KEY)
      .maybeSingle();

    if (error) {
      throw new Error(`trading partner billing_profile lookup failed: ${error.message}`);
    }

    const profile: Record<string, unknown> =
      data?.setting_value && typeof data.setting_value === "object" && !Array.isArray(data.setting_value)
        ? (data.setting_value as Record<string, unknown>)
        : {};

    const npi = profile.billing_provider_npi as unknown;
    const ein = profile.billing_tax_id as unknown;
    const addrLine1 = profile.billing_address_line1 as unknown;
    const city = profile.billing_city as unknown;
    const state = profile.billing_state as unknown;
    const zip = profile.billing_zip as unknown;
    const repName = profile.authorized_rep_name as unknown;
    const repEmail = profile.authorized_rep_email as unknown;
    const repPhone = profile.authorized_rep_phone as unknown;

    return {
      hasBillingNpi: isNonEmptyString(npi),
      billingNpiValid: isNonEmptyString(npi) && isValidNpi(npi),
      hasEin: isNonEmptyString(ein),
      einValid: isValidEin(ein),
      hasBillingAddress:
        isNonEmptyString(addrLine1) && isNonEmptyString(city) && isNonEmptyString(state) && isNonEmptyString(zip),
      hasAuthorizedRep: isNonEmptyString(repName),
      authorizedRepContactValid:
        isNonEmptyString(repName) && isValidEmail(repEmail) && isValidPhone(repPhone),
    };
  },
};
