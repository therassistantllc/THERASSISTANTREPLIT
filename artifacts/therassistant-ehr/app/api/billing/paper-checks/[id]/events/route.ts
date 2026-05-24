/**
 * GET /api/billing/paper-checks/[id]/events
 *
 * Audit/event timeline for a single paper check — surfaced in the detail
 * panel's "Deposit notes" tab.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }
    const { id } = await ctx.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;

    const { data, error } = await (supabase as any)
      .from("paper_check_events")
      .select("id, event_type, message, payload, actor_display_name, created_at")
      .eq("organization_id", guard.organizationId)
      .eq("paper_check_id", id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return NextResponse.json({ success: true, events: data ?? [] });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load events",
      },
      { status: 500 },
    );
  }
}
