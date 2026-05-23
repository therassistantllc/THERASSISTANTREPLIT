import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

/**
 * Lightweight org-scoped list of `insurance_payers` rows used by in-chart
 * policy editors that need a payer picker. Returns only active (non-archived)
 * payers, sorted by name.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const { data, error } = await supabase
      .from("insurance_payers")
      .select("id, payer_name, payer_id, payer_category")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("payer_name", { ascending: true });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, payers: data ?? [] });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load payers",
      },
      { status: 500 },
    );
  }
}
