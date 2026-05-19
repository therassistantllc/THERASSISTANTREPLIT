
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";

interface PayerConfig {
  id: string;
  organization_id: string;
  payer_id: string;
  payer_name: string;
  payer_aliases: string[];
  supported_transactions: string[];
  states: string[];
  source: string;
  environment: string;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

export async function GET(req: NextRequest) {
  try {
    const organizationId = req.nextUrl.searchParams.get("organization_id") || null;

    const supabase = await createServerSupabaseAdminClientTyped();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 503 }
      );
    }
    
    let query = supabase
      .from("payer_configurations")
      .select("*", { count: "exact" })
      .eq("is_active", true)
      .order("payer_name", { ascending: true });

    if (organizationId) {
      query = query.eq("organization_id", organizationId);
    }

    const { data, error: dbError, count } = await query;

    // Handle table not found gracefully
    if (dbError) {
      const errorMsg = dbError?.message || "";
      if (
        errorMsg.includes("Could not find the table") ||
        errorMsg.includes("does not exist") ||
        errorMsg.includes("schema cache")
      ) {
        return NextResponse.json({
          ok: true,
          message: "Payer configuration table not yet initialized",
          count: 0,
          payers: [],
        });
      }
      throw dbError;
    }

    return NextResponse.json({
      ok: true,
      count: count || 0,
      payers: (data ?? []) as PayerConfig[],
    });
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error) || "Unknown error";
    console.error("[GET /api/settings/payers]", errorMsg);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      organization_id,
      payer_id,
      payer_name,
      payer_aliases,
      supported_transactions,
      states,
      notes,
    } = body;

    // Validate required fields
    if (!organization_id || !payer_id || !payer_name) {
      return NextResponse.json(
        { error: "Missing required fields: organization_id, payer_id, payer_name" },
        { status: 400 }
      );
    }

    const supabase = await createServerSupabaseAdminClientTyped();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 503 }
      );
    }

    // Check for duplicate
    const { data: existing, error: checkError } = await supabase
      .from("payer_configurations")
      .select("id")
      .eq("organization_id", organization_id)
      .eq("payer_id", payer_id)
      .maybeSingle();

    if (checkError) {
      const errorMsg = checkError?.message || "";
      if (
        errorMsg.includes("Could not find the table") ||
        errorMsg.includes("does not exist")
      ) {
        return NextResponse.json(
          {
            error: "Payer configuration table not yet initialized. Migration pending.",
          },
          { status: 503 }
        );
      }
      throw checkError;
    }

    if (existing) {
      return NextResponse.json(
        { error: "Payer already configured for this organization" },
        { status: 409 }
      );
    }

    // Insert new payer configuration
    const { data, error: insertError } = await supabase
      .from("payer_configurations")
      .insert({
        organization_id,
        payer_id,
        payer_name,
        payer_aliases: payer_aliases ?? [],
        supported_transactions: supported_transactions ?? [],
        states: states ?? [],
        source: "availity",
        environment: process.env.AVAILITY_ENV ?? "demo",
        is_active: true,
        notes: notes ?? null,
      })
      .select()
      .single();

    if (insertError) {
      const errorMsg = insertError?.message || "";
      if (
        errorMsg.includes("Could not find the table") ||
        errorMsg.includes("does not exist")
      ) {
        return NextResponse.json(
          {
            error: "Payer configuration table not yet initialized. Migration pending.",
          },
          { status: 503 }
        );
      }
      throw insertError;
    }

    return NextResponse.json(
      {
        ok: true,
        message: "Payer configuration created successfully",
        payer: data,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error) || "Unknown error";
    console.error("[POST /api/settings/payers]", errorMsg);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
