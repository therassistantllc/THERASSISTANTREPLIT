/**
 * providerBillingIdentity.ts
 *
 * Canonical helpers for resolving provider billing identity from the
 * THERASSISTANT EHR provider table hierarchy.
 *
 * Table hierarchy (for claim purposes):
 *   providers                       — generic operational roster
 *   provider_credentialing_profiles — canonical BILLING identity (NPI, tax ID, address, taxonomy)
 *   claim_parties_snapshot          — frozen-at-submission identity; do not read back from here
 *
 * Non-destructive. Read-only queries only. No schema mutations.
 *
 * See docs/provider-billing-identity.md for full architecture documentation.
 */

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import type { BillingProviderInput } from "@/lib/claims/claimReadinessService";
import { resolveProviderCredentialingProfile } from "@/lib/providers/providerCredentialingResolverService";

type DbRow = Record<string, unknown>;

function str(v: unknown): string {
  return String(v ?? "").trim();
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RenderingProviderIdentity {
  /** Individual NPI (10-digit). Null if not resolved. */
  npi: string | null;
  firstName: string | null;
  lastName: string | null;
  taxonomyCode: string | null;
  /** 1 = individual, 2 = organization (always "1" for rendering providers). */
  entityType: "1" | "2";
  /** True when rendering provider is identical to billing provider. */
  sameAsBilling: boolean;
}

export interface ResolveRenderingProviderInput {
  organizationId: string;
  /** NPI already known — fastest path. */
  renderingProviderNpi?: string | null;
  /** providers.id — resolved via DB lookup when NPI is not yet known. */
  renderingProviderId?: string | null;
}

export interface BillingProviderIdentity {
  ok: boolean;
  /** provider_credentialing_profiles.id that was used for resolution. */
  profileId: string | null;
  billingProvider: BillingProviderInput | null;
  taxonomyCode: string | null;
  errors: Array<{ field: string; message: string }>;
}

export interface ResolveBillingProviderInput {
  organizationId: string;
  /** providers.id of the individual clinician. */
  providerId?: string | null;
  /** providers.id when the rendering clinician differs from the billing entity. */
  renderingProviderId?: string | null;
}

export interface ProviderTaxonomyResult {
  taxonomyCode: string | null;
  /** Which table the value was resolved from. */
  source: "credentialing_profile" | "providers_table" | "none";
}

export interface ResolveProviderTaxonomyInput {
  organizationId: string;
  /** Individual NPI for direct credentialing profile lookup. */
  npi?: string | null;
  /** providers.id fallback when NPI is not available. */
  providerId?: string | null;
}

export interface ProviderMedicaidIdentity {
  individualMedicaidId: string | null;
  groupMedicaidId: string | null;
  /**
   * Preferred ID for Medicaid claim submission.
   * Prefers individual_medicaid_id; falls back to group_medicaid_id.
   */
  preferredMedicaidId: string | null;
  source: "credentialing_profile" | "providers_table" | "none";
}

export interface ResolveProviderMedicaidInput {
  organizationId: string;
  /** NPI for credentialing profile lookup (most reliable path). */
  npi?: string | null;
  /** providers.id fallback. */
  providerId?: string | null;
}

// ── resolveRenderingProviderIdentity ─────────────────────────────────────────

/**
 * Returns the rendering provider identity for a service line.
 *
 * Lookup order:
 *   1. If `renderingProviderNpi` is supplied — look up credentialing profile directly.
 *   2. If `renderingProviderId` is supplied — look up `providers` for NPI, then
 *      cross-reference `provider_credentialing_profiles` for taxonomy.
 *   3. Returns `{ npi: null, ... }` when nothing resolves.
 *
 * The caller should compare `npi` against the billing provider NPI and set
 * `sameAsBilling` accordingly before writing to `claim_parties_snapshot`.
 *
 * @example
 * const rendering = await resolveRenderingProviderIdentity({
 *   organizationId,
 *   renderingProviderId: encounter.providerId,
 * });
 * if (rendering.npi && rendering.npi !== billingProviderNpi) {
 *   // write NM1*82 segment
 * }
 */
export async function resolveRenderingProviderIdentity(
  input: ResolveRenderingProviderInput,
): Promise<RenderingProviderIdentity> {
  const supabase = createServerSupabaseAdminClient();
  const fallback: RenderingProviderIdentity = {
    npi: null,
    firstName: null,
    lastName: null,
    taxonomyCode: null,
    entityType: "1",
    sameAsBilling: false,
  };
  if (!supabase) return fallback;

  // --- Path 1: NPI supplied — look up credentialing profile for taxonomy ---
  if (input.renderingProviderNpi) {
    const { data } = await supabase
      .from("provider_credentialing_profiles")
      .select("individual_npi, provider_name, taxonomy_code")
      .eq("organization_id", input.organizationId)
      .eq("individual_npi", input.renderingProviderNpi)
      .eq("is_active", true)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();

    if (data) {
      const row = data as DbRow;
      const fullName = str(row.provider_name);
      const spaceIdx = fullName.indexOf(" ");
      return {
        npi: input.renderingProviderNpi,
        firstName: spaceIdx > 0 ? fullName.slice(0, spaceIdx) : fullName,
        lastName: spaceIdx > 0 ? fullName.slice(spaceIdx + 1) : null,
        taxonomyCode: str(row.taxonomy_code) || null,
        entityType: "1",
        sameAsBilling: false,
      };
    }
    // NPI not in credentialing profiles yet — still return it
    return { ...fallback, npi: input.renderingProviderNpi };
  }

  // --- Path 2: Provider ID — look up providers table for NPI ---
  if (input.renderingProviderId) {
    const { data: provRow } = await supabase
      .from("providers")
      .select("npi, first_name, last_name, taxonomy_code")
      .eq("id", input.renderingProviderId)
      .limit(1)
      .maybeSingle();

    if (provRow) {
      const row = provRow as DbRow;
      const npi = str(row.npi) || null;
      if (npi) {
        // Cross-reference credentialing profile for authoritative taxonomy
        const { data: credRow } = await supabase
          .from("provider_credentialing_profiles")
          .select("taxonomy_code")
          .eq("organization_id", input.organizationId)
          .eq("individual_npi", npi)
          .eq("is_active", true)
          .is("archived_at", null)
          .limit(1)
          .maybeSingle();

        const taxonomy =
          str((credRow as DbRow | null)?.taxonomy_code) ||
          str(row.taxonomy_code) ||
          null;

        return {
          npi,
          firstName: str(row.first_name) || null,
          lastName: str(row.last_name) || null,
          taxonomyCode: taxonomy,
          entityType: "1",
          sameAsBilling: false,
        };
      }
    }
  }

  return fallback;
}

// ── resolveBillingProviderIdentity ───────────────────────────────────────────

/**
 * Returns the canonical billing provider identity for 837P claim generation.
 *
 * Delegates to `resolveProviderCredentialingProfile` (the existing resolver)
 * to avoid duplicating address-parsing logic. Wraps the result in a cleaner
 * surface type.
 *
 * Call `hasValidClaimIdentity(result.billingProvider)` to confirm all
 * required 837P fields are present before writing to `claim_parties_snapshot`.
 *
 * @example
 * const billing = await resolveBillingProviderIdentity({ organizationId });
 * if (!billing.ok || !hasValidClaimIdentity(billing.billingProvider)) {
 *   return { error: "Billing provider identity incomplete" };
 * }
 */
export async function resolveBillingProviderIdentity(
  input: ResolveBillingProviderInput,
): Promise<BillingProviderIdentity> {
  const result = await resolveProviderCredentialingProfile({
    organizationId: input.organizationId,
    providerId: input.providerId ?? null,
    renderingProviderId: input.renderingProviderId ?? null,
  });

  return {
    ok: result.ok,
    profileId: result.providerCredentialingProfileId,
    billingProvider: result.billingProvider,
    taxonomyCode: result.taxonomyCode,
    errors: result.errors,
  };
}

// ── resolveProviderTaxonomy ───────────────────────────────────────────────────

/**
 * Returns the canonical taxonomy code for a provider.
 *
 * Lookup order (most authoritative first):
 *   1. `provider_credentialing_profiles.taxonomy_code` (by NPI)
 *   2. `providers.taxonomy_code` (by provider ID)
 *   3. `providers.taxonomy_code` (by NPI)
 *
 * The PRV*BI segment in an 837P claim is optional but strongly recommended.
 * If this returns `null`, omit the PRV segment rather than submitting blank.
 *
 * @example
 * const { taxonomyCode } = await resolveProviderTaxonomy({ organizationId, npi });
 */
export async function resolveProviderTaxonomy(
  input: ResolveProviderTaxonomyInput,
): Promise<ProviderTaxonomyResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { taxonomyCode: null, source: "none" };

  // 1. Credentialing profile by NPI (most authoritative)
  if (input.npi) {
    const { data } = await supabase
      .from("provider_credentialing_profiles")
      .select("taxonomy_code")
      .eq("organization_id", input.organizationId)
      .eq("individual_npi", input.npi)
      .eq("is_active", true)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();

    const code = str((data as DbRow | null)?.taxonomy_code);
    if (code) return { taxonomyCode: code, source: "credentialing_profile" };
  }

  // 2. providers table by provider ID
  if (input.providerId) {
    const { data } = await supabase
      .from("providers")
      .select("taxonomy_code")
      .eq("id", input.providerId)
      .limit(1)
      .maybeSingle();

    const code = str((data as DbRow | null)?.taxonomy_code);
    if (code) return { taxonomyCode: code, source: "providers_table" };
  }

  // 3. providers table by NPI
  if (input.npi) {
    const { data } = await supabase
      .from("providers")
      .select("taxonomy_code")
      .eq("npi", input.npi)
      .limit(1)
      .maybeSingle();

    const code = str((data as DbRow | null)?.taxonomy_code);
    if (code) return { taxonomyCode: code, source: "providers_table" };
  }

  return { taxonomyCode: null, source: "none" };
}

// ── resolveProviderMedicaidIdentity ──────────────────────────────────────────

/**
 * Returns individual and group Medicaid IDs for a provider.
 *
 * Lookup order:
 *   1. `provider_credentialing_profiles` (has both individual + group IDs)
 *   2. `providers.medicaid_id` (legacy single-field fallback)
 *
 * Use `preferredMedicaidId` when building the REF*1D segment in an
 * 837P Medicaid claim. Individual ID is preferred; group ID is the fallback.
 *
 * @example
 * const { preferredMedicaidId } = await resolveProviderMedicaidIdentity({
 *   organizationId,
 *   npi: rendering.npi,
 * });
 */
export async function resolveProviderMedicaidIdentity(
  input: ResolveProviderMedicaidInput,
): Promise<ProviderMedicaidIdentity> {
  const supabase = createServerSupabaseAdminClient();
  const empty: ProviderMedicaidIdentity = {
    individualMedicaidId: null,
    groupMedicaidId: null,
    preferredMedicaidId: null,
    source: "none",
  };
  if (!supabase) return empty;

  // 1. Credentialing profile — has both individual + group Medicaid IDs
  if (input.npi) {
    const { data } = await supabase
      .from("provider_credentialing_profiles")
      .select("individual_medicaid_id, group_medicaid_id")
      .eq("organization_id", input.organizationId)
      .eq("individual_npi", input.npi)
      .eq("is_active", true)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();

    if (data) {
      const row = data as DbRow;
      const ind = str(row.individual_medicaid_id) || null;
      const grp = str(row.group_medicaid_id) || null;
      return {
        individualMedicaidId: ind,
        groupMedicaidId: grp,
        preferredMedicaidId: ind ?? grp,
        source: "credentialing_profile",
      };
    }
  }

  // 2. providers.medicaid_id (legacy single field)
  if (input.providerId) {
    const { data } = await supabase
      .from("providers")
      .select("medicaid_id")
      .eq("id", input.providerId)
      .limit(1)
      .maybeSingle();

    const id = str((data as DbRow | null)?.medicaid_id) || null;
    if (id) {
      return {
        individualMedicaidId: id,
        groupMedicaidId: null,
        preferredMedicaidId: id,
        source: "providers_table",
      };
    }
  }

  return empty;
}

// ── hasValidClaimIdentity ─────────────────────────────────────────────────────

const NPI_RE = /^\d{10}$/;
const ZIP_RE = /^\d{5}(?:-\d{4})?$/;
const STATE_RE = /^[A-Z]{2}$/;

/**
 * Returns true if the billing provider object contains all required fields
 * for a valid 837P submission.
 *
 * Validates:
 *   - name present
 *   - npi is exactly 10 digits
 *   - taxId present
 *   - address1 present
 *   - city present
 *   - state is 2 uppercase characters
 *   - zip matches 5-digit or 9-digit (ZIP+4) format
 *
 * Use as a pre-flight guard before writing to `claim_parties_snapshot`:
 *
 * @example
 * const billing = await resolveBillingProviderIdentity({ organizationId });
 * if (!hasValidClaimIdentity(billing.billingProvider)) {
 *   throw new Error("Billing provider identity is incomplete");
 * }
 */
export function hasValidClaimIdentity(
  provider: BillingProviderInput | null | undefined,
): boolean {
  if (!provider) return false;
  if (!provider.name?.trim()) return false;
  if (!NPI_RE.test(provider.npi?.trim() ?? "")) return false;
  if (!provider.taxId?.trim()) return false;
  if (!provider.address1?.trim()) return false;
  if (!provider.city?.trim()) return false;
  if (!STATE_RE.test(provider.state?.trim() ?? "")) return false;
  if (!ZIP_RE.test(provider.zip?.trim() ?? "")) return false;
  return true;
}
