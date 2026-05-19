import "server-only";

import { getAvailityEnv } from "./env";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

/**
 * In-memory token cache for Availity access tokens.
 *
 * IMPORTANT DESIGN NOTES:
 * - Availity tokens are short-lived (valid for ~5 minutes).
 * - This cache is stored in server memory only, not persisted.
 * - In production deployments with multiple server instances,
 *   each instance will independently request and cache its own token.
 * - Do not persist access tokens in the database unless there is
 *   a specific audit or security requirement to do so.
 * - Cache is automatically refreshed when approaching expiration (1 minute buffer).
 */
let tokenCache: TokenCache | null = null;

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Refresh token early using a 1-minute safety buffer.
 * If token expires in less than 60 seconds, consider it expired.
 */
const REFRESH_BUFFER_MS = 60 * 1000; // 1 minute

export async function getAvailityAccessToken(): Promise<string> {
  const now = Date.now();

  // Return cached token if still valid
  if (
    tokenCache &&
    tokenCache.expiresAt > now + REFRESH_BUFFER_MS
  ) {
    return tokenCache.accessToken;
  }

  // Request new token
  const env = getAvailityEnv();

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.clientId,
    client_secret: env.clientSecret,
  });

  // Add scope if provided
  if (env.scope) {
    body.append("scope", env.scope);
  }

  try {
    const response = await fetch(env.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const safeError = await response.text();
      throw new Error(
        `Availity token request failed with status ${response.status}. Response: ${safeError}`
      );
    }

    const data: TokenResponse = await response.json();

    if (!data.access_token) {
      throw new Error(
        "Availity token response missing access_token field"
      );
    }

    // Calculate expiration time
    const expiresInSeconds = data.expires_in || 300; // Default 5 minutes
    const expiresAt = now + expiresInSeconds * 1000;

    // Cache the token
    tokenCache = {
      accessToken: data.access_token,
      expiresAt,
    };

    return data.access_token;
  } catch (error) {
    // Clear any stale cache on error
    tokenCache = null;
    throw error;
  }
}

/**
 * Clear the in-memory token cache.
 * Useful for testing or forcing a fresh token request.
 */
export function clearAvailityTokenCache(): void {
  tokenCache = null;
}
