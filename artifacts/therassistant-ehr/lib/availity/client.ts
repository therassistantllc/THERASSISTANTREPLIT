import "server-only";

import { getAvailityAccessToken } from "./tokenService";
import { getAvailityEnv } from "./env";

export interface AvailityFetchOptions extends Omit<RequestInit, "body" | "headers"> {
  body?: Record<string, unknown> | string | FormData;
  headers?: Record<string, string>;
  /** Enable mock response for demo testing */
  mockResponse?: boolean;
  /** Mock scenario ID for demo testing */
  mockScenarioId?: string;
}

/**
 * Backend-only Availity API client.
 *
 * Automatically handles:
 * - Bearer token authentication
 * - Content-Type and Accept headers
 * - Demo mock headers for testing
 * - Full URL or path-based requests
 *
 * Example usage:
 * const response = await availityFetch("/organizations");
 * const data = await response.json();
 */
export async function availityFetch(
  pathOrUrl: string,
  options: AvailityFetchOptions = {}
): Promise<Response> {
  const env = getAvailityEnv();
  const token = await getAvailityAccessToken();

  // Determine full URL
  let url: string;
  if (pathOrUrl.startsWith("http")) {
    url = pathOrUrl;
  } else {
    url = `${env.apiBaseUrl}${pathOrUrl}`;
  }

  // Prepare headers
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...options.headers,
  };

  // Handle body serialization
  let body: string | FormData | undefined;
  if (options.body) {
    if (typeof options.body === "string") {
      body = options.body;
    } else if (options.body instanceof FormData) {
      body = options.body;
    } else {
      // Plain object - JSON serialize it
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }
  }

  // Add mock headers if requested (for demo testing)
  if (options.mockResponse === true) {
    headers["X-Api-Mock-Response"] = "true";
  }
  if (options.mockScenarioId) {
    headers["X-Api-Mock-Scenario-ID"] = options.mockScenarioId;
  }

  // Remove body and headers from options to avoid duplication
  const { mockResponse: _mockResponse, mockScenarioId: _mockScenarioId, headers: _headers, ...fetchOptions } = options;

  return fetch(url, {
    ...fetchOptions,
    headers,
    body,
  });
}
