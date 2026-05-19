import type { BillingProviderInput } from "@/lib/claims/claimReadinessService";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type DbRow = Record<string, unknown>;

export interface ResolveProviderCredentialingInput {
  organizationId: string;
  providerId?: string | null;
  renderingProviderId?: string | null;
}

export interface ResolvedProviderCredentialing {
  ok: boolean;
  providerCredentialingProfileId: string | null;
  billingProvider: BillingProviderInput | null;
  renderingProviderNpi: string | null;
  taxonomyCode: string | null;
  errors: Array<{ field: string; message: string }>;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function billingProviderFromProfile(profile: DbRow): BillingProviderInput {
  const address = text(profile.practice_address);
  const zipMatch = address.match(/\b\d{5}(?:-\d{4})?\b/);
  const stateMatch = address.match(/\b[A-Z]{2}\b(?=\s+\d{5})/);
  const cityStateZipIndex = stateMatch?.index ?? -1;
  const cityStateZip = cityStateZipIndex >= 0 ? address.slice(cityStateZipIndex).trim() : "";
  const address1 = cityStateZipIndex > 0 ? address.slice(0, cityStateZipIndex).trim() : address;

  return {
    name: text(profile.practice_name),
    npi: text(profile.group_npi) || text(profile.individual_npi),
    taxId: text(profile.practice_tax_id),
    taxIdType: "EI",
    address1,
    address2: null,
    city: cityStateZip ? text(address.slice(address1.length, cityStateZipIndex).trim()) : "",
    state: stateMatch?.[0] ?? "",
    zip: zipMatch?.[0] ?? "",
  };
}

async function getProviderNpiFromStaffId(organizationId: string, providerId: string | null | undefined) {
  if (!providerId) return null;
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const possibleTables = ["providers", "staff", "profiles"];
  for (const table of possibleTables) {
    const { data, error } = await supabase
      .from(table)
      .select("id, npi, individual_npi")
      .eq("id", providerId)
      .limit(1)
      .maybeSingle();

    if (!error && data) return text((data as DbRow).npi) || text((data as DbRow).individual_npi) || null;
  }

  return null;
}

export async function resolveProviderCredentialingProfile(
  input: ResolveProviderCredentialingInput,
): Promise<ResolvedProviderCredentialing> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      providerCredentialingProfileId: null,
      billingProvider: null,
      renderingProviderNpi: null,
      taxonomyCode: null,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const requestedNpi = await getProviderNpiFromStaffId(
    input.organizationId,
    input.renderingProviderId ?? input.providerId ?? null,
  );

  let profile: DbRow | null = null;
  if (requestedNpi) {
    const { data } = await supabase
      .from("provider_credentialing_profiles")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("individual_npi", requestedNpi)
      .eq("is_active", true)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();
    profile = (data as DbRow | null) ?? null;
  }

  if (!profile) {
    const { data } = await supabase
      .from("provider_credentialing_profiles")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("is_active", true)
      .is("archived_at", null)
      .order("provider_name", { ascending: true })
      .limit(1)
      .maybeSingle();
    profile = (data as DbRow | null) ?? null;
  }

  if (!profile) {
    return {
      ok: false,
      providerCredentialingProfileId: null,
      billingProvider: null,
      renderingProviderNpi: null,
      taxonomyCode: null,
      errors: [{ field: "provider_credentialing_profiles", message: "No active provider credentialing profile found" }],
    };
  }

  const billingProvider = billingProviderFromProfile(profile);
  const errors: Array<{ field: string; message: string }> = [];
  if (!billingProvider.name) errors.push({ field: "billing_provider.name", message: "Practice name is missing" });
  if (!billingProvider.npi) errors.push({ field: "billing_provider.npi", message: "Group or individual NPI is missing" });
  if (!billingProvider.taxId) errors.push({ field: "billing_provider.tax_id", message: "Practice tax ID is missing" });
  if (!billingProvider.address1) errors.push({ field: "billing_provider.address1", message: "Practice address is missing" });
  if (!billingProvider.state) errors.push({ field: "billing_provider.state", message: "Practice state is missing" });
  if (!billingProvider.zip) errors.push({ field: "billing_provider.zip", message: "Practice ZIP is missing" });

  return {
    ok: errors.length === 0,
    providerCredentialingProfileId: text(profile.id),
    billingProvider,
    renderingProviderNpi: text(profile.individual_npi) || null,
    taxonomyCode: text(profile.taxonomy_code) || null,
    errors,
  };
}
