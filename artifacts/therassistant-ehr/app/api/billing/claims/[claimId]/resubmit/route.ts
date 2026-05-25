/**
 * POST /api/billing/claims/[claimId]/resubmit
 *
 * Moves a previously-submitted claim back to `ready_for_batch` so it is
 * picked up by the next 837P batch. Writes an audit note explaining the
 * action.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const text = (v: unknown) => String(v ?? "").trim();

interface Body {
  organizationId?: string;
  reason?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ claimId: string }> },
) {
  try {
    const { claimId } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as Body;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const reason = text(body.reason) || "Resubmitted from No Response queue";

    const { data: claim } = await (supabase as any)
      .from("professional_claims")
      .select("id, organization_id, claim_status")
      .eq("id", claimId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const { error: updateError } = await (supabase as any)
      .from("professional_claims")
      .update({
        claim_status: "ready_for_batch",
        defer_until: null,
        deferred_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimId)
      .eq("organization_id", organizationId);
    if (updateError) {
      return NextResponse.json(
        { success: false, error: updateError.message },
        { status: 500 },
      );
    }

    await insertClaimNote(supabase as any, {
      organizationId,
      claimId,
      body: `Resubmit queued: ${reason}`,
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
