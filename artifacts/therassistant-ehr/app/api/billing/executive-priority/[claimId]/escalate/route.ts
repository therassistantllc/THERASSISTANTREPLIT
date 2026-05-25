/**
 * POST /api/billing/executive-priority/[claimId]/escalate
 *
 * Bumps a claim's workqueue priority to "urgent" (or to the supplied
 * level) and writes an audit note. Creates a workqueue row if one
 * doesn't exist yet.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const text = (v: unknown) => String(v ?? "").trim();
const VALID_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
type Priority = (typeof VALID_PRIORITIES)[number];

interface Body {
  organizationId?: string;
  priority?: Priority;
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

    const priority: Priority = (
      VALID_PRIORITIES as readonly string[]
    ).includes(text(body.priority))
      ? (text(body.priority) as Priority)
      : "urgent";
    const reason = text(body.reason);

    const { data: claim } = await (supabase as any)
      .from("professional_claims")
      .select("id, organization_id, patient_id")
      .eq("id", claimId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const { data: existing } = await (supabase as any)
      .from("claim_workqueue_items")
      .select("id, priority")
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .is("archived_at", null)
      .maybeSingle();

    if (existing) {
      const { error } = await (supabase as any)
        .from("claim_workqueue_items")
        .update({
          priority,
          action_taken: reason ? `Escalated: ${reason}` : "Escalated",
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: 422 },
        );
      }
    } else {
      const { error } = await (supabase as any)
        .from("claim_workqueue_items")
        .insert({
          organization_id: organizationId,
          claim_id: claimId,
          client_id: claim.patient_id ?? null,
          item_status: "no_response",
          priority,
          action_taken: reason ? `Escalated: ${reason}` : "Escalated",
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
      authorUserId: guard.userId,
      authorDisplayName: "Executive workqueue",
      body: `[System] Escalated to ${priority}${reason ? ` — ${reason}` : ""}.`,
    });

    return NextResponse.json({ success: true, priority });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
