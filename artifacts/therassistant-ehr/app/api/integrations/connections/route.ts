// File: app/api/integrations/connections/route.ts
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import type { IntegrationConnection } from "@/types/integrations";

export async function GET() {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 500 }
      );
    }

    const { data, error } = await supabase
      .from("integration_connections")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      connections: (data || []) as IntegrationConnection[],
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load connections" },
      { status: 500 }
    );
  }
}
