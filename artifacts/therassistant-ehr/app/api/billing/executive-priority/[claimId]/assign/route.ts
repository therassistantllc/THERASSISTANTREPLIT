/**
 * POST /api/billing/executive-priority/[claimId]/assign
 *
 * Assigns (or unassigns) a claim within the Executive / Priority queue.
 * Stores `staff_profiles.id` in `claim_workqueue_items.assigned_to_user_id`
 * so the queue can resolve names without auth-table lookups. Upserts a
 * workqueue row if the claim doesn't have one yet. Audit-trails the
 * change as a [System] claim note.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const text = (v: unknown) => String(v ?? "").trim();

interface Body {
  organizationId?: string;
  assigneeId?: string | null;
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

    const assigneeId = body.assigneeId ? text(body.assigneeId) : null;

    // Verify claim ownership
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

    // Verify assignee if provided
    let assigneeName = "Unassigned";
    if (assigneeId) {
      const { data: staff } = await (supabase as any)
        .from("staff_profiles")
        .select("id, first_name, last_name, email")
        .eq("id", assigneeId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!staff) {
        return NextResponse.json(
          { success: false, error: "Assignee not found" },
          { status: 404 },
        );
      }
      assigneeName =
        [staff.first_name, staff.last_name].map(text).filter(Boolean).join(" ") ||
        text(staff.email) ||
        assigneeId;
    }

    // Find or create the workqueue row.
    const { data: existing } = await (supabase as any)
      .from("claim_workqueue_items")
      .select("id, assigned_to_user_id")
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .is("archived_at", null)
      .maybeSingle();

    let wqId: string;
    if (existing) {
      wqId = text(existing.id);
      const { error } = await (supabase as any)
        .from("claim_workqueue_items")
        .update({
          assigned_to_user_id: assigneeId,
          action_taken: assigneeId ? `Assigned to ${assigneeName}` : "Unassigned",
          updated_at: new Date().toISOString(),
        })
        .eq("id", wqId);
      if (error) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: 422 },
        );
      }
    } else {
      const { data: inserted, error } = await (supabase as any)
        .from("claim_workqueue_items")
        .insert({
          organization_id: organizationId,
          claim_id: claimId,
          client_id: claim.patient_id ?? null,
          item_status: "no_response",
          priority: "normal",
          assigned_to_user_id: assigneeId,
          action_taken: assigneeId ? `Assigned to ${assigneeName}` : null,
        })
        .select("id")
        .single();
      if (error) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: 422 },
        );
      }
      wqId = text(inserted.id);
    }

    // Audit trail
    await insertClaimNote(supabase as any, {
      organizationId,
      claimId,
      authorUserId: guard.userId,
      authorDisplayName: "Executive workqueue",
      body: `[System] Assigned to ${assigneeName}.`,
    });

    return NextResponse.json({
      success: true,
      workqueueItemId: wqId,
      assigneeId,
      assigneeName: assigneeId ? assigneeName : null,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
