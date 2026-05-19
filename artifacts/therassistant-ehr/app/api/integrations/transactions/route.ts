// File: app/api/integrations/transactions/route.ts
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import type { ExternalTransaction } from "@/types/integrations";

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const transactionType = searchParams.get("transaction_type");
    const processingStatus = searchParams.get("processing_status");
    const processingMode = searchParams.get("processing_mode");
    const limit = parseInt(searchParams.get("limit") || "100", 10);

    let query = supabase
      .from("external_transactions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (transactionType && transactionType !== "all") {
      query = query.eq("transaction_type", transactionType);
    }

    if (processingStatus && processingStatus !== "all") {
      query = query.eq("processing_status", processingStatus);
    }

    if (processingMode && processingMode !== "all") {
      query = query.eq("processing_mode", processingMode);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      transactions: (data || []) as ExternalTransaction[],
      count: data?.length || 0,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load transactions" },
      { status: 500 }
    );
  }
}
