import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

    const [secondaryRes, eraRes] = await Promise.all([
      supabase
        .from("insurance_policies")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("priority", "secondary")
        .eq("active_flag", true)
        .is("archived_at", null),
      supabase
        .from("era_claim_payments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .or("claim_match_status.eq.unmatched,claim_match_status.eq.ambiguous,posting_status.eq.blocked,posting_status.eq.failed"),
    ]);

    if (secondaryRes.error) throw secondaryRes.error;
    if (eraRes.error) throw eraRes.error;

    return NextResponse.json({
      success: true,
      organizationId,
      metrics: {
        secondaryClaims: secondaryRes.count ?? 0,
        eraExceptions: eraRes.count ?? 0,
      },
    });
  } catch (error) {
    console.error("Submission queues API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Submission queues API failed" },
      { status: 500 },
    );
  }
}
