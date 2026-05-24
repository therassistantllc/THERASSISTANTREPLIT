/**
 * /api/billing/rejections-999/action
 *
 * POST — execute a row/panel action for the 999 Rejections workqueue:
 *   - assign           : assign the workqueue item to a staff user
 *   - note             : add a free-text note (workqueue_item_comments)
 *   - resubmit         : reset the underlying claim to ready_for_batch
 *                        and resolve the workqueue item
 *   - rebuild_837      : reset the underlying claim to ready_for_batch
 *                        and add a rebuild audit comment (does not resolve)
 *   - correct          : mark the item in_progress and add an audit note;
 *                        the UI navigates to the claim-edit dashboard
 *
 * Every action writes a workqueue_item_comments row so the timeline
 * stays auditable.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, any>;

const text = (v: unknown) => String(v ?? "").trim();

type ActionName = "assign" | "note" | "resubmit" | "rebuild_837" | "correct";

const VALID_ACTIONS: ActionName[] = ["assign", "note", "resubmit", "rebuild_837", "correct"];

async function addComment(
  supabase: any,
  params: {
    organizationId: string;
    workqueueItemId: string;
    body: string;
    type: "note" | "status_change" | "assignment" | "resolution";
    userId: string | null;
  },
) {
  const body = params.body.trim();
  if (!body) return;
  const { error } = await supabase.from("workqueue_item_comments").insert({
    organization_id: params.organizationId,
    workqueue_item_id: params.workqueueItemId,
    comment_body: body,
    comment_type: params.type,
    created_by_user_id: params.userId,
  });
  if (error) throw new Error(error.message);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = text(body.action) as ActionName;
    if (!VALID_ACTIONS.includes(action)) {
      return NextResponse.json(
        { success: false, error: `action must be one of: ${VALID_ACTIONS.join(", ")}` },
        { status: 400 },
      );
    }

    const workqueueItemId = text(body.workqueueItemId);
    if (!workqueueItemId) {
      return NextResponse.json(
        { success: false, error: "workqueueItemId is required" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const guard = await requireBillingAccess({
      requestedOrganizationId: text(body.organizationId) || null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { data: item, error: loadErr } = await (supabase as any)
      .from("workqueue_items")
      .select(
        "id, status, professional_claim_id, source_object_id, assigned_to_user_id, context_payload",
      )
      .eq("organization_id", organizationId)
      .eq("id", workqueueItemId)
      .eq("work_type", "clearinghouse_rejection")
      .is("archived_at", null)
      .maybeSingle();

    if (loadErr) throw loadErr;
    if (!item) {
      return NextResponse.json(
        { success: false, error: "999 rejection workqueue item not found" },
        { status: 404 },
      );
    }

    const claimId =
      text((item as DbRow).professional_claim_id) ||
      text((item as DbRow).source_object_id) ||
      null;

    const now = new Date().toISOString();
    const userId = text(body.userId) || null;

    if (action === "assign") {
      const assigneeUserId = text(body.assignedToUserId) || null;
      const { error } = await (supabase as any)
        .from("workqueue_items")
        .update({
          assigned_to_user_id: assigneeUserId,
          status: assigneeUserId && (item as DbRow).status === "open"
            ? "in_progress"
            : (item as DbRow).status,
          updated_at: now,
        })
        .eq("organization_id", organizationId)
        .eq("id", workqueueItemId);
      if (error) throw error;

      await addComment(supabase, {
        organizationId,
        workqueueItemId,
        body: assigneeUserId
          ? `Assigned to ${text(body.assigneeDisplayName) || assigneeUserId}`
          : "Unassigned",
        type: "assignment",
        userId,
      });

      return NextResponse.json({
        success: true,
        patch: {
          assignedToUserId: assigneeUserId,
          assignedToDisplayName: text(body.assigneeDisplayName) || null,
          status:
            assigneeUserId && (item as DbRow).status === "open"
              ? "in_progress"
              : (item as DbRow).status,
        },
      });
    }

    if (action === "note") {
      const noteBody = text(body.body);
      if (!noteBody) {
        return NextResponse.json(
          { success: false, error: "body is required for a note" },
          { status: 400 },
        );
      }
      await addComment(supabase, {
        organizationId,
        workqueueItemId,
        body: noteBody,
        type: "note",
        userId,
      });
      return NextResponse.json({ success: true });
    }

    if (action === "resubmit" || action === "rebuild_837") {
      if (claimId) {
        const { error: claimErr } = await (supabase as any)
          .from("professional_claims")
          .update({ claim_status: "ready_for_batch", updated_at: now })
          .eq("organization_id", organizationId)
          .eq("id", claimId);
        if (claimErr) throw claimErr;
      }

      const resolved = action === "resubmit";
      const { error: updErr } = await (supabase as any)
        .from("workqueue_items")
        .update({
          status: resolved ? "resolved" : "in_progress",
          resolved_at: resolved ? now : null,
          updated_at: now,
        })
        .eq("organization_id", organizationId)
        .eq("id", workqueueItemId);
      if (updErr) throw updErr;

      await addComment(supabase, {
        organizationId,
        workqueueItemId,
        body:
          action === "resubmit"
            ? "Claim queued for resubmission (status reset to ready_for_batch)."
            : "Claim queued for 837P rebuild (status reset to ready_for_batch).",
        type: resolved ? "resolution" : "status_change",
        userId,
      });

      return NextResponse.json({
        success: true,
        patch: {
          status: resolved ? "resolved" : "in_progress",
          claimStatus: claimId ? "ready_for_batch" : undefined,
        },
        removeFromQueue: resolved,
      });
    }

    if (action === "correct") {
      const { error: updErr } = await (supabase as any)
        .from("workqueue_items")
        .update({ status: "in_progress", updated_at: now })
        .eq("organization_id", organizationId)
        .eq("id", workqueueItemId);
      if (updErr) throw updErr;

      await addComment(supabase, {
        organizationId,
        workqueueItemId,
        body: "Opened claim editor to correct the 999 rejection.",
        type: "status_change",
        userId,
      });

      return NextResponse.json({
        success: true,
        patch: { status: "in_progress" },
        navigateTo: claimId
          ? `/billing/claim-edit-dashboard?claimId=${encodeURIComponent(claimId)}`
          : "/billing/claim-edit-dashboard",
      });
    }

    return NextResponse.json({ success: false, error: "Unhandled action" }, { status: 400 });
  } catch (error) {
    console.error("999 Rejections action error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "999 Rejections action failed",
      },
      { status: 500 },
    );
  }
}
