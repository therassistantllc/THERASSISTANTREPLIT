// Server-only credential resolution for clearinghouse connections.
//
// Resolution order for the active credential for an (organization, vendor):
//   1. Vault-backed secret on the active connection row (the only acceptable source for production PHI).
//   2. Legacy plaintext fallback in `clearinghouse_connections.encrypted_credentials.api_key`
//      (transitional only — every row with this set should be migrated and the JSONB field cleared).
//   3. `AVAILITY_EDI_API_KEY` environment variable (legacy single-tenant fallback; logs a warning).
//
// All resolution paths return a `source` value so callers (and audit rows) can record which mechanism
// produced the key. A NULL return means there is no credential — the caller must reject the request.

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export type CredentialEnvironment = "sandbox" | "production";

export type ResolvedClearinghouseCredential = {
  apiKey: string;
  connectionId: string | null;
  vendor: string;
  environment: CredentialEnvironment;
  baseUrl: string | null;
  source: "vault" | "legacy_jsonb" | "env_fallback";
};

const MODE_TO_ENVIRONMENT: Record<string, CredentialEnvironment> = {
  production: "production",
  live: "production",
  sandbox: "sandbox",
  test: "sandbox",
};

const ENVIRONMENT_TO_MODES: Record<CredentialEnvironment, string[]> = {
  production: ["production", "live"],
  sandbox: ["sandbox", "test"],
};

function envFallbackKey(): string | null {
  return process.env.AVAILITY_EDI_API_KEY ?? null;
}

export async function resolveClearinghouseCredential(params: {
  organizationId: string;
  vendor?: string;
  environment?: CredentialEnvironment;
}): Promise<ResolvedClearinghouseCredential | null> {
  const vendor = params.vendor ?? "availity";

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    const envKey = envFallbackKey();
    if (!envKey) return null;
    console.warn(
      "[clearinghouse/credentials] Database unavailable; falling back to AVAILITY_EDI_API_KEY env var.",
    );
    return {
      apiKey: envKey,
      connectionId: null,
      vendor,
      environment: params.environment ?? "sandbox",
      baseUrl: process.env.AVAILITY_EDI_BASE_URL ?? null,
      source: "env_fallback",
    };
  }

  // Find the active connection for this org+vendor, optionally constrained to a specific environment.
  let query = supabase
    .from("clearinghouse_connections")
    .select("id, vendor, mode, api_base_url, vault_secret_id, encrypted_credentials")
    .eq("organization_id", params.organizationId)
    .eq("vendor", vendor)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1);

  if (params.environment) {
    query = query.in("mode", ENVIRONMENT_TO_MODES[params.environment]);
  }

  const { data: connection, error } = await query.maybeSingle();
  if (error) {
    console.error("[clearinghouse/credentials] Connection lookup failed:", error);
  }

  // 1. Vault-backed
  if (connection?.vault_secret_id) {
    const { data: secretData, error: secretErr } = await supabase.rpc("get_clearinghouse_api_key", {
      p_connection_id: connection.id,
    });
    if (secretErr) {
      console.error("[clearinghouse/credentials] vault read failed:", secretErr);
    } else if (typeof secretData === "string" && secretData.length > 0) {
      return {
        apiKey: secretData,
        connectionId: connection.id,
        vendor: String(connection.vendor ?? vendor),
        environment: MODE_TO_ENVIRONMENT[String(connection.mode ?? "sandbox")] ?? "sandbox",
        baseUrl: (connection.api_base_url as string | null) ?? null,
        source: "vault",
      };
    }
  }

  // 2. Legacy plaintext JSONB fallback — flag loudly; this is what T001 is replacing.
  const legacyCreds = connection?.encrypted_credentials as Record<string, unknown> | null | undefined;
  const legacyApiKey =
    legacyCreds && typeof legacyCreds === "object" && typeof legacyCreds.api_key === "string"
      ? (legacyCreds.api_key as string)
      : null;
  if (legacyApiKey) {
    console.warn(
      `[clearinghouse/credentials] Using legacy plaintext api_key from clearinghouse_connections.encrypted_credentials for connection ${connection?.id}. ` +
        "Re-save the connection via /settings/clearinghouse to move the key into Vault.",
    );
    return {
      apiKey: legacyApiKey,
      connectionId: connection?.id ?? null,
      vendor: String(connection?.vendor ?? vendor),
      environment: MODE_TO_ENVIRONMENT[String(connection?.mode ?? "sandbox")] ?? "sandbox",
      baseUrl: (connection?.api_base_url as string | null) ?? null,
      source: "legacy_jsonb",
    };
  }

  // 3. Env-var fallback (last resort).
  const envKey = envFallbackKey();
  if (envKey) {
    console.warn(
      `[clearinghouse/credentials] No vaulted credential for org=${params.organizationId} vendor=${vendor}; ` +
        "falling back to AVAILITY_EDI_API_KEY env var.",
    );
    return {
      apiKey: envKey,
      connectionId: connection?.id ?? null,
      vendor,
      environment: params.environment ?? "sandbox",
      baseUrl:
        (connection?.api_base_url as string | null) ?? process.env.AVAILITY_EDI_BASE_URL ?? null,
      source: "env_fallback",
    };
  }

  return null;
}

export async function storeClearinghouseApiKey(params: {
  connectionId: string;
  apiKey: string;
}): Promise<{ ok: true; vaultSecretId: string } | { ok: false; error: string }> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, error: "Database connection not available" };

  const { data, error } = await supabase.rpc("set_clearinghouse_api_key", {
    p_connection_id: params.connectionId,
    p_api_key: params.apiKey,
  });

  if (error) return { ok: false, error: error.message };
  if (typeof data !== "string") return { ok: false, error: "Vault did not return a secret id" };
  return { ok: true, vaultSecretId: data };
}

function modeToEnvironment(mode: string | null | undefined): CredentialEnvironment {
  return MODE_TO_ENVIRONMENT[String(mode ?? "sandbox")] ?? "sandbox";
}
