import { NextRequest, NextResponse } from "next/server";
import { getAvailityAccessToken } from "@/lib/availity/tokenService";
import { getAvailityEnv } from "@/lib/availity/env";
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
 * Internal test endpoint for Availity token generation.
 *
 * GET /api/integrations/availity/token-test
 *
 * Returns token generation status without exposing credentials.
 * Useful for health checks and configuration verification.
 *
 * Logs all requests to availity_transactions table (token_test type).
 */
export async function GET(_request: NextRequest) {
  let transactionId: string | null = null;

  try {
    // Create transaction log for token test
    transactionId = await createAvailityTransactionLog({
      transactionType: "token_test",
      transactionDirection: "internal",
      environment: resolveAvailityEnvironment(),
      requestMethod: "GET",
      requestUrl: _request.nextUrl.pathname,
    });
  } catch (logError) {
    console.error("Failed to create token-test transaction log:", logError);
    // Continue despite logging failure
  }

  try {
    const env = getAvailityEnv();
    const token = await getAvailityAccessToken();

    const responseData = {
      ok: true,
      provider: "availity",
      environment: env.env,
      hasToken: true,
      tokenPreview: `${token.slice(0, 8)}...`,
      checkedAt: new Date().toISOString(),
    };

    if (transactionId) {
      await completeAvailityTransactionLog({
        transactionId,
        responseStatus: 200,
        responseBody: {
          ok: true,
          provider: "availity",
          environment: env.env,
          hasToken: true,
          checkedAt: new Date().toISOString(),
        },
      });
    }

    return NextResponse.json(responseData);
  } catch (error) {
    let errorMessage =
      error instanceof Error ? error.message : String(error);

    // Make error message more informative without exposing secrets
    if (errorMessage.includes("fetch failed")) {
      errorMessage =
        "Network error: Unable to reach Availity token endpoint. Check internet connectivity and AVAILITY_TOKEN_URL configuration.";
    }

    if (transactionId) {
      await failAvailityTransactionLog({
        transactionId,
        errorMessage,
        errorType: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        responseStatus: 500,
        responseBody: {
          ok: false,
          provider: "availity",
          message: errorMessage,
        },
      });
    }

    // Return safe error message without exposing secrets
    return NextResponse.json(
      {
        ok: false,
        provider: "availity",
        error: errorMessage,
        vars: {
          clientIdPresent: !!process.env.AVAILITY_CLIENT_ID,
          clientSecretPresent: !!process.env.AVAILITY_CLIENT_SECRET,
          tokenUrlConfigured: !!process.env.AVAILITY_TOKEN_URL,
        },
      },
      { status: 500 }
    );
  }
}
