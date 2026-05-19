import { NextRequest, NextResponse } from "next/server";
import { searchAvailityPayers, getMockAvailityPayers } from "@/lib/availity/payerListService";
import { getAvailityEnv } from "@/lib/availity/env";

/**
 * Availity payer list lookup endpoint
 * GET /api/integrations/availity/payers
 *
 * Query parameters:
 * - payerName: string (optional)
 * - payerId: string (optional)
 * - transactionType: string (optional)
 * - state: string (optional, e.g., "CO")
 * - limit: number (optional, default 25)
 * - mock: boolean (optional, use mock data for UI development)
 *
 * Returns:
 * {
 *   ok: true,
 *   provider: "availity",
 *   environment: "demo",
 *   count: number,
 *   payers: [...]
 * }
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;

    // Check if mock mode is requested
    const mockMode = searchParams.get("mock") === "true";

    // Parse search parameters
    const params = {
      payerName: searchParams.get("payerName") || undefined,
      payerId: searchParams.get("payerId") || undefined,
      transactionType: searchParams.get("transactionType") || undefined,
      state: searchParams.get("state") || undefined,
      limit: searchParams.get("limit")
        ? parseInt(searchParams.get("limit") || "25", 10)
        : undefined,
    };

    // Get environment
    const env = getAvailityEnv();

    // Call appropriate service
    const result = mockMode
      ? await getMockAvailityPayers(params)
      : await searchAvailityPayers(params);

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          provider: "availity",
          error: result.error || "Unknown error",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      provider: "availity",
      environment: env.env,
      count: result.payers?.length || 0,
      payers: result.payers || [],
      isMock: mockMode,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    return NextResponse.json(
      {
        ok: false,
        provider: "availity",
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}
