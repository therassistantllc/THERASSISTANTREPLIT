// Availity REST OAuth2 client_credentials token cache.
//
// Per Availity Developer Portal (api.availity.com), the Coverages REST API
// uses OAuth2 client_credentials grant against:
//   POST https://api.availity.com/v1/token
//   Content-Type: application/x-www-form-urlencoded
//   body: grant_type=client_credentials&client_id=...&client_secret=...&scope=hipaa
// → { access_token, token_type: "Bearer", expires_in, scope }
//
// We cache the token in-process keyed by clientId. Tokens are refreshed
// ~60s before expiry to avoid clock skew with the auth server. Concurrent
// callers share the same in-flight refresh promise.

export interface AvailityOAuthConfig {
  tokenUrl?: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

export interface AvailityAccessToken {
  accessToken: string;
  expiresAt: number;
  tokenType: string;
  scope: string | null;
}

const DEFAULT_TOKEN_URL = "https://api.availity.com/v1/token";
const DEFAULT_SCOPE = "hipaa";
const REFRESH_LEAD_MS = 60_000;

const tokenCache = new Map<string, AvailityAccessToken>();
const inflightRefresh = new Map<string, Promise<AvailityAccessToken>>();

function cacheKey(config: AvailityOAuthConfig): string {
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
  const scope = config.scope ?? DEFAULT_SCOPE;
  return `${tokenUrl}|${config.clientId}|${scope}`;
}

async function requestNewToken(config: AvailityOAuthConfig): Promise<AvailityAccessToken> {
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
  const scope = config.scope ?? DEFAULT_SCOPE;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope,
  });
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Availity OAuth token request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  let parsed: { access_token?: string; expires_in?: number; token_type?: string; scope?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Availity OAuth token response was not JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed.access_token) {
    throw new Error("Availity OAuth response missing access_token.");
  }
  const ttlMs = (parsed.expires_in ?? 300) * 1_000;
  return {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + ttlMs,
    tokenType: parsed.token_type ?? "Bearer",
    scope: parsed.scope ?? null,
  };
}

export async function getAvailityAccessToken(config: AvailityOAuthConfig): Promise<AvailityAccessToken> {
  const key = cacheKey(config);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - Date.now() > REFRESH_LEAD_MS) {
    return cached;
  }
  const inflight = inflightRefresh.get(key);
  if (inflight) return inflight;

  const promise = requestNewToken(config)
    .then((token) => {
      tokenCache.set(key, token);
      inflightRefresh.delete(key);
      return token;
    })
    .catch((err) => {
      inflightRefresh.delete(key);
      throw err;
    });
  inflightRefresh.set(key, promise);
  return promise;
}

/** Test-only: drop the cached token for a given client to force a refresh. */
export function clearAvailityTokenCache(clientId?: string): void {
  if (!clientId) {
    tokenCache.clear();
    return;
  }
  for (const k of Array.from(tokenCache.keys())) {
    if (k.includes(`|${clientId}|`)) tokenCache.delete(k);
  }
}
