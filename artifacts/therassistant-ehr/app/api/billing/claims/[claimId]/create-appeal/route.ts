/**
 * POST /api/billing/claims/[claimId]/create-appeal
 *
 * Opens an "appeal" workqueue item for the claim, stamps
 * appeal_submitted_at, and writes an audit note. Idempotent — re-running
 * updates the existing workqueue item instead of duplicating it.
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

    const reason =
      text(body.reason) ||
      "Appeal opened from Timely Filing Risk queue";

    const { data: claim } = await (supabase as any)
      .from("professional_claims")
      .select("id, organization_id, patient_id, appeal_submitted_at")
      .eq("id", claimId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const nowIso = new Date().toISOString();
    if (!claim.appeal_submitted_at) {
      await (supabase as any)
        .from("professional_claims")
        .update({ appeal_submitted_at: nowIso, updated_at: nowIso })
        .eq("id", claimId)
        .eq("organization_id", organizationId);
    }

    const { data: existing } = await (supabase as any)
      .from("claim_workqueue_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .eq("item_status", "appeal")
      .is("archived_at", null)
      .maybeSingle();

    if (existing) {
      await (supabase as any)
        .from("claim_workqueue_items")
        .update({
          priority: "high",
          action_taken: `Appeal updated: ${reason}`,
          updated_at: nowIso,
        })
        .eq("id", existing.id);
    } else {
      const { error } = await (supabase as any)
        .from("claim_workqueue_items")
        .insert({
          organization_id: organizationId,
          claim_id: claimId,
          client_id: claim.patient_id ?? null,
          item_status: "appeal",
          priority: "high",
          action_taken: `Appeal opened: ${reason}`,
        });
      if (error) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: 422 },
        );
      }
    }

    await insertClaimNote(supabase as any, {
      organizationId,
      claimId,
      authorUserId: guard.userId ?? null,
      authorDisplayName: "Timely Filing workqueue",
      body: `[System] Appeal created — ${reason}`,
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
