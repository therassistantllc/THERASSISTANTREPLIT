/**
 * POST /api/billing/aging/[claimId]/action
 *
 * Aging-queue mutations. Body shape:
 *   { organizationId, action: "move_to_appeal" | "mark_resolved", reason? }
 *
 * Both actions upsert a claim_workqueue_items row and write a
 * claim_status_events audit-trail entry tagged source='biller'.
 *
 *   - move_to_appeal : item_status='appeal_needed', priority='high'
 *   - mark_resolved  : item_status='resolved' on the open WQ row
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const text = (v: unknown) => String(v ?? "").trim();

type ActionId = "move_to_appeal" | "mark_resolved";

const ALLOWED: ActionId[] = ["move_to_appeal", "mark_resolved"];

interface Body {
  organizationId?: string;
  action?: string;
  reason?: string;
}

async function resolveActorName(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  staffId: string | null,
): Promise<string> {
  if (!supabase || !staffId) return "Staff";
  const { data } = await (supabase as any)
    .from("staff_profiles")
    .select("first_name, last_name, email")
    .eq("id", staffId)
    .maybeSingle();
  if (!data) return "Staff";
  const composed = [data.first_name, data.last_name].map((v: unknown) => text(v)).filter(Boolean).join(" ");
  return composed || text(data.email) || "Staff";
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

    const action = text(body.action) as ActionId;
    if (!ALLOWED.includes(action)) {
      return NextResponse.json(
        { success: false, error: `Unknown action: ${text(body.action) || "(none)"}` },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

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

    const actorName = await resolveActorName(supabase, guard.staffId);
    const reason = text(body.reason);
    const nowIso = new Date().toISOString();

    const { data: existing } = await (supabase as any)
      .from("claim_workqueue_items")
      .select("id, item_status, priority")
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .is("archived_at", null)
      .maybeSingle();

    let nextStatus: string;
    let nextPriority: string;
    let auditStatus: string;
    let auditMessage: string;

    if (action === "move_to_appeal") {
      nextStatus = "appeal_needed";
      nextPriority = "high";
      auditStatus = "moved_to_appeal";
      auditMessage = `Moved to appeal by ${actorName}${reason ? ` — ${reason}` : ""}`;
    } else {
      nextStatus = "resolved";
      nextPriority = text(existing?.priority) || "normal";
      auditStatus = "marked_resolved";
      auditMessage = `Marked resolved by ${actorName}${reason ? ` — ${reason}` : ""}`;
    }

    if (existing) {
      const { error } = await (supabase as any)
        .from("claim_workqueue_items")
        .update({
          item_status: nextStatus,
          priority: nextPriority,
          action_taken: auditMessage,
          updated_at: nowIso,
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
          item_status: nextStatus,
          priority: nextPriority,
          action_taken: auditMessage,
        });
      if (error) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: 422 },
        );
      }
    }

    await (supabase as any).from("claim_status_events").insert({
      claim_id: claimId,
      source: "biller",
      status: auditStatus,
      status_message: auditMessage,
      raw_payload: {
        action,
        actor_user_id: guard.userId,
        actor_display_name: actorName,
        reason: reason || null,
      },
    });

    await insertClaimNote(supabase as any, {
      organizationId,
      claimId,
      authorUserId: guard.userId,
      authorDisplayName: actorName,
      body: `[Aging] ${auditMessage}`,
    });

    return NextResponse.json({ success: true, action, item_status: nextStatus });
  } catch (e) {
    console.error("Aging action error:", e);
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
