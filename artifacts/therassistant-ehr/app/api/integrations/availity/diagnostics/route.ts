import { NextRequest, NextResponse } from "next/server";
import {
  createAvailityTransactionLog,
  completeAvailityTransactionLog,
  failAvailityTransactionLog,
} from "@/lib/availity/transactionLogger";

function resolveAvailityEnvironment(): "demo" | "production" | "sandbox" | "test" {
  const env = process.env.AVAILITY_ENV;
  if (env === "demo" || env === "production" || env === "sandbox" || env === "test") {
    return env;
  }
  return "demo";
}

/**
 * Safe network diagnostics endpoint for Availity API connectivity.
 *
 * GET /api/integrations/availity/diagnostics
 *
 * Checks:
 * - Whether AVAILITY_TOKEN_URL is configured
 * - Whether the Availity host is reachable
 *
 * Does NOT:
 * - Send client_id or client_secret
 * - Request a token
 * - Expose any credentials
 *
 * Logs all requests to availity_transactions table (diagnostics type).
 */
export async function GET(_request: NextRequest) {
  const tokenUrl = process.env.AVAILITY_TOKEN_URL;

  // Create transaction log for diagnostics request
  let transactionId: string | null = null;

  try {
    transactionId = await createAvailityTransactionLog({
      transactionType: "diagnostics",
      transactionDirection: "internal",
      environment: resolveAvailityEnvironment(),
      requestMethod: "GET",
      requestUrl: _request.nextUrl.pathname,
    });
  } catch (logError) {
    console.error("Failed to create diagnostics transaction log:", logError);
    // Continue despite logging failure - don't break the endpoint
  }

  // Check if URL is configured
  if (!tokenUrl) {
    const errorMessage = "AVAILITY_TOKEN_URL not configured";

    if (transactionId) {
      await failAvailityTransactionLog({
        transactionId,
        errorMessage,
        errorType: "CONFIGURATION_ERROR",
      });
    }

    return NextResponse.json(
      {
        ok: false,
        provider: "availity",
        diagnostics: {
          configuredTokenUrl: false,
          message: errorMessage,
        },
      },
      { status: 400 }
    );
  }

  // Extract host from URL for connectivity test
  let hostUrl: string;
  try {
    const url = new URL(tokenUrl);
    hostUrl = `${url.protocol}//${url.host}`;
  } catch {
    const errorMessage = "AVAILITY_TOKEN_URL is not a valid URL";

    if (transactionId) {
      await failAvailityTransactionLog({
        transactionId,
        errorMessage,
        errorType: "INVALID_URL",
      });
    }

    return NextResponse.json(
      {
        ok: false,
        provider: "availity",
        diagnostics: {
          configuredTokenUrl: true,
          validTokenUrl: false,
          message: errorMessage,
        },
      },
      { status: 400 }
    );
  }

  // Test connectivity to host without credentials
  try {
    const response = await fetch(hostUrl, {
      method: "HEAD",
      // Short timeout to avoid hanging
      signal: AbortSignal.timeout(5000),
    });

    // Any response (including 404, 401, etc.) means the host is reachable
    const reachable = true;

    const diagnosticsResponse = {
      ok: true,
      provider: "availity",
      diagnostics: {
        configuredTokenUrl: true,
        validTokenUrl: true,
        hostReachable: reachable,
        host: hostUrl,
        statusCode: response.status,
        message: "Availity host is reachable. Token service can attempt authentication.",
      },
      checkedAt: new Date().toISOString(),
    };

    if (transactionId) {
      await completeAvailityTransactionLog({
        transactionId,
        responseStatus: response.status,
        responseBody: diagnosticsResponse,
      });
    }

    return NextResponse.json(diagnosticsResponse);
  } catch (error) {
    const errorType =
      error instanceof Error
        ? error.name
        : typeof error === "string"
          ? error
          : "unknown";

    let message = "Unable to reach Availity host";
    if (errorType === "AbortError") {
      message = "Request timeout: host did not respond within 5 seconds";
    } else if (errorType === "TypeError") {
      message = "Network error: check internet connectivity and hostname";
    }

    if (transactionId) {
      await failAvailityTransactionLog({
        transactionId,
        errorMessage: message,
        errorType,
      });
    }

    return NextResponse.json(
      {
        ok: false,
        provider: "availity",
        diagnostics: {
          configuredTokenUrl: true,
          validTokenUrl: true,
          hostReachable: false,
          host: hostUrl,
          message,
          errorType,
        },
      },
      { status: 503 }
    );
  }
}
