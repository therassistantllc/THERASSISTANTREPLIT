import "server-only";

/**
 * Availity environment configuration validation
 *
 * Ensures all required credentials are present before attempting OAuth requests.
 * This module is server-only and should never be imported in client components.
 */

export interface AvailityEnvironment {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scope?: string;
  env: string;
  apiBaseUrl: string;
}

export function getAvailityEnv(): AvailityEnvironment {
  const clientId = process.env.AVAILITY_CLIENT_ID;
  const clientSecret = process.env.AVAILITY_CLIENT_SECRET;
  const tokenUrl = process.env.AVAILITY_TOKEN_URL;
  const scope = process.env.AVAILITY_SCOPE;
  const env = process.env.AVAILITY_ENV || "demo";
  const apiBaseUrl =
    process.env.AVAILITY_API_BASE_URL ||
    "https://tst.api.availity.com";

  // Validate required credentials
  if (!clientId) {
    throw new Error(
      "Missing environment variable: AVAILITY_CLIENT_ID. Please set it in your .env.local file."
    );
  }

  if (!clientSecret) {
    throw new Error(
      "Missing environment variable: AVAILITY_CLIENT_SECRET. Please set it in your .env.local file."
    );
  }

  if (!tokenUrl) {
    throw new Error(
      "Missing environment variable: AVAILITY_TOKEN_URL. Please set it in your .env.local file."
    );
  }

  return {
    clientId,
    clientSecret,
    tokenUrl,
    scope,
    env,
    apiBaseUrl,
  };
}
