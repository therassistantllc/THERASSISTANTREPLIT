import { NextResponse, NextRequest } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";

function errMsg(e: unknown) {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message?: unknown }).message ?? "Unknown error");
  return "Unknown error";
}

/**
 * POST { organizationId, claimNumber?, claimId? }
 * Manually attaches a professional_claim to an ERA payment row.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = createServerSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ success: false, error: "Service role key not configured" }, { status: 503 });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* allow empty */ }
  const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
  const claimNumber = typeof body.claimNumber === "string" ? body.claimNumber.trim() : "";
  const claimIdInput = typeof body.claimId === "string" ? body.claimId.trim() : "";

  if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
  if (!claimNumber && !claimIdInput) return NextResponse.json({ success: false, error: "claimNumber or claimId is required" }, { status: 400 });

  try {
    let claimId = claimIdInput;
    if (!claimId) {
      const { data: claim, error: claimErr } = await supabase
        .from("professional_claims")
        .select("id, claim_number")
        .eq("organization_id", organizationId)
        .eq("claim_number", claimNumber)
        .maybeSingle();
      if (claimErr) throw claimErr;
      if (!claim?.id) {
        return NextResponse.json({ success: false, error: `No claim found with number "${claimNumber}" in this organization.` }, { status: 404 });
      }
      claimId = String(claim.id);
    }

    const { data, error } = await supabase
      .from("era_payments")
      .update({
        professional_claim_id: claimId,
        claim_match_status: "matched",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select("id, professional_claim_id, claim_match_status")
      .single();
    if (error) throw error;

    return NextResponse.json({ success: true, payment: data });
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 });
  }
}
