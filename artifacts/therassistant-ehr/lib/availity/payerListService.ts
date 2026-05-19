import "server-only";

import { availityFetch } from "./client";
import {
  createAvailityTransactionLog,
  completeAvailityTransactionLog,
  failAvailityTransactionLog,
} from "./transactionLogger";

/**
 * Normalized payer record structure
 */
export interface NormalizedPayer {
  payerId: string;
  payerName: string;
  aliases?: string[];
  supportedTransactions?: string[];
  states?: string[];
  raw?: unknown;
}

/**
 * Search parameters for payer lookup
 */
export interface PayerSearchParams {
  payerName?: string;
  payerId?: string;
  transactionType?: string;
  state?: string;
  limit?: number;
}

/**
 * Response from payer search/lookup
 */
export interface PayerSearchResponse {
  ok: boolean;
  payers?: NormalizedPayer[];
  error?: string;
  errorType?: string;
}

function resolveAvailityEnvironment(): "demo" | "production" | "sandbox" | "test" {
  const env = process.env.AVAILITY_ENV;
  if (env === "demo" || env === "production" || env === "sandbox" || env === "test") {
    return env;
  }
  return "demo";
}

/**
 * Normalize payer data from Availity response into standard format
 */
function normalizePayer(rawPayer: unknown): NormalizedPayer | null {
  if (typeof rawPayer !== "object" || rawPayer === null) {
    return null;
  }

  const payer = rawPayer as Record<string, unknown>;

  // Map various possible field names
  const payerId = payer.payerId || payer.payer_id || payer.id;
  const payerName = payer.payerName || payer.payer_name || payer.name;

  if (!payerId || !payerName) {
    return null;
  }

  return {
    payerId: String(payerId),
    payerName: String(payerName),
    aliases: Array.isArray(payer.aliases) ? payer.aliases.map(String) : undefined,
    supportedTransactions: Array.isArray(payer.supportedTransactions)
      ? payer.supportedTransactions.map(String)
      : undefined,
    states: Array.isArray(payer.states) ? payer.states.map(String) : undefined,
    raw: payer,
  };
}

/**
 * Get mock payer records for UI development
 */
function getMockPayers(state?: string): NormalizedPayer[] {
  const allMockPayers: NormalizedPayer[] = [
    {
      payerId: "CO-ACC",
      payerName: "Colorado Access",
      aliases: ["CO Access"],
      supportedTransactions: ["270", "271", "276", "277", "837P"],
      states: ["CO"],
    },
    {
      payerId: "CO-CCHA",
      payerName: "CCHA",
      aliases: ["Colorado Community Health Alliance"],
      supportedTransactions: ["270", "271", "276", "277", "837P"],
      states: ["CO"],
    },
    {
      payerId: "CO-HCO",
      payerName: "Health Colorado",
      aliases: ["Health Colorado Inc"],
      supportedTransactions: ["270", "271", "276", "277", "837P"],
      states: ["CO"],
    },
    {
      payerId: "CO-RMHP",
      payerName: "Rocky Mountain Health Plans",
      aliases: ["RMHP", "Rocky Mountain"],
      supportedTransactions: ["270", "271", "276", "277", "837P"],
      states: ["CO"],
    },
    {
      payerId: "UHC-NATL",
      payerName: "UnitedHealthcare",
      aliases: ["UHC", "United Healthcare"],
      supportedTransactions: ["270", "271", "276", "277", "837P"],
      states: ["CO", "WY", "NM", "UT"],
    },
    {
      payerId: "AET-NATL",
      payerName: "Aetna",
      aliases: ["Aetna Inc"],
      supportedTransactions: ["270", "271", "276", "277", "837P"],
      states: ["CO", "WY", "NM", "UT", "ID"],
    },
    {
      payerId: "CIG-NATL",
      payerName: "Cigna",
      aliases: ["Cigna Corporation"],
      supportedTransactions: ["270", "271", "276", "277", "837P"],
      states: ["CO", "WY", "NM", "UT", "ID", "MT"],
    },
    {
      payerId: "ANT-CARE",
      payerName: "Anthem / Carelon",
      aliases: ["Anthem", "Carelon", "Blue Cross"],
      supportedTransactions: ["270", "271", "276", "277", "837P"],
      states: ["CO", "WY", "NM", "UT", "ID", "MT"],
    },
  ];

  // Filter by state if provided
  if (state) {
    const upperState = state.toUpperCase();
    return allMockPayers.filter((payer) =>
      payer.states?.some((s) => s.toUpperCase() === upperState)
    );
  }

  return allMockPayers;
}

/**
 * Search for Availity payers
 */
export async function searchAvailityPayers(
  params: PayerSearchParams
): Promise<PayerSearchResponse> {
  const limit = params.limit || 25;

  // Create transaction log
  let transactionId: string | null = null;
  try {
    transactionId = await createAvailityTransactionLog({
      transactionType: "payer_list",
      transactionDirection: "outbound",
      environment: resolveAvailityEnvironment(),
      requestMethod: "GET",
      requestUrl: "/payers/search",
      requestBody: {
        payerName: params.payerName,
        payerId: params.payerId,
        transactionType: params.transactionType,
        state: params.state,
        limit,
      },
    });
  } catch (logError) {
    console.error("Failed to create payer_list transaction log:", logError);
  }

  try {
    // Build query parameters
    const queryParams = new URLSearchParams();
    if (params.payerName) queryParams.append("payerName", params.payerName);
    if (params.payerId) queryParams.append("payerId", params.payerId);
    if (params.transactionType) queryParams.append("transactionType", params.transactionType);
    if (params.state) queryParams.append("state", params.state);
    queryParams.append("limit", String(limit));

    // Call Availity API
    const response = await availityFetch(`/payers/search?${queryParams.toString()}`, {
      method: "GET",
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorMessage = `Availity payer search failed with status ${response.status}`;

      if (transactionId) {
        await failAvailityTransactionLog({
          transactionId,
          errorMessage,
          errorType: "HTTP_ERROR",
          responseStatus: response.status,
          responseBody: { error: errorText },
        });
      }

      return {
        ok: false,
        error: errorMessage,
        errorType: "HTTP_ERROR",
      };
    }

    const data: unknown = await response.json();

    // Extract payers array defensively
    let payersArray: unknown[] = [];
    if (Array.isArray(data)) {
      payersArray = data;
    } else if (typeof data === "object" && data !== null) {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.payers)) {
        payersArray = obj.payers;
      } else if (Array.isArray(obj.data)) {
        payersArray = obj.data;
      }
    }

    // Normalize payers
    const normalizedPayers = payersArray
      .map((p) => normalizePayer(p))
      .filter((p): p is NormalizedPayer => p !== null);

    // Log successful response
    if (transactionId) {
      await completeAvailityTransactionLog({
        transactionId,
        responseStatus: 200,
        responseBody: {
          ok: true,
          count: normalizedPayers.length,
        },
      });
    }

    return {
      ok: true,
      payers: normalizedPayers,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    if (transactionId) {
      await failAvailityTransactionLog({
        transactionId,
        errorMessage,
        errorType: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      });
    }

    return {
      ok: false,
      error: errorMessage,
      errorType: error instanceof Error ? error.name : "UNKNOWN_ERROR",
    };
  }
}

/**
 * Get a specific payer by ID
 */
export async function getAvailityPayerById(
  payerId: string
): Promise<PayerSearchResponse> {
  return searchAvailityPayers({ payerId });
}

/**
 * Get mock payers (for UI development without hitting live API)
 */
export async function getMockAvailityPayers(
  params: PayerSearchParams
): Promise<PayerSearchResponse> {
  // Create transaction log for mock request
  let transactionId: string | null = null;
  try {
    transactionId = await createAvailityTransactionLog({
      transactionType: "payer_list",
      transactionDirection: "internal",
      environment: resolveAvailityEnvironment(),
      requestMethod: "GET",
      requestUrl: "/payers/search (MOCK)",
      requestBody: {
        mock: true,
        limit: params.limit || 25,
        state: params.state,
      },
    });
  } catch (logError) {
    console.error("Failed to create mock payer_list transaction log:", logError);
  }

  try {
    // Get mock payers
    const mockPayers = getMockPayers(params.state);

    // Filter by name if provided
    let filtered = mockPayers;
    if (params.payerName) {
      const searchTerm = params.payerName.toLowerCase();
      filtered = mockPayers.filter(
        (p) =>
          p.payerName.toLowerCase().includes(searchTerm) ||
          p.aliases?.some((alias) => alias.toLowerCase().includes(searchTerm))
      );
    }

    // Filter by ID if provided
    if (params.payerId) {
      filtered = filtered.filter((p) => p.payerId === params.payerId);
    }

    // Apply limit
    const limit = params.limit || 25;
    filtered = filtered.slice(0, limit);

    // Log successful mock response
    if (transactionId) {
      await completeAvailityTransactionLog({
        transactionId,
        responseStatus: 200,
        responseBody: {
          ok: true,
          count: filtered.length,
          mock: true,
        },
      });
    }

    return {
      ok: true,
      payers: filtered,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    if (transactionId) {
      await failAvailityTransactionLog({
        transactionId,
        errorMessage,
        errorType: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      });
    }

    return {
      ok: false,
      error: errorMessage,
    };
  }
}
