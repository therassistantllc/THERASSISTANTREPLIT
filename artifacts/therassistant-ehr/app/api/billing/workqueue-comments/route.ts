/**
 * Workqueue item comments — view + add.
 *
 * GET  /api/billing/workqueue-comments?workqueueItemId=<uuid>
 *   Any billing-capable user in the org can read the comment thread for a
 *   workqueue item that belongs to their org. Used by:
 *     - My Inbox (so the assignee can see prior comments before adding one)
 *     - Eligibility Issues (so the original biller can see what the
 *       assignee said back without leaving the row).
 *
 * POST /api/billing/workqueue-comments
 *   Body: { workqueueItemId, comment, organizationId? }
 *   Two roles may post in the thread (both must have VIEW_BILLING):
 *     (a) the user currently assigned to the item (the assignee), and
 *     (b) the biller who originally routed the item (workqueue_items.
 *         routed_by_user_id matches the caller's auth user id).
 *   Anyone else with VIEW_BILLING can still read the thread via GET but
 *   may not write — keeps the conversation scoped to the two people
 *   actually doing the handoff.
 *   Writes to workqueue_item_comments through the existing
 *   addWorkqueueComment service so the timeline / activity log keeps a
 *   single source of truth.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { addWorkqueueComment } from "@/lib/workqueue/workqueueActionService";

type StaffRow = {
  id: string;
  user_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

type CommentRow = {
  id: string;
  workqueue_item_id: string;
  comment_body: string;
  comment_type: string;
  created_at: string;
  created_by_user_id: string | null;
};

function staffName(s: StaffRow | undefined): string {
  if (!s) return "Unknown user";
  const full = [s.first_name, s.last_name]
    .map((v) => (v ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return full || (s.email ?? "").trim() || "Unknown user";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const workqueueItemId = (url.searchParams.get("workqueueItemId") ?? "").trim();
  if (!workqueueItemId) {
    return NextResponse.json(
      { success: false, error: "workqueueItemId is required" },
      { status: 400 },
    );
  }

  const guard = await requireBillingAccess({
    requestedOrganizationId: url.searchParams.get("organizationId"),
  });
  if (guard instanceof NextResponse) return guard;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { success: false, error: "Database connection not available" },
      { status: 500 },
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };

  // Make sure the item belongs to this org before exposing comments.
  const { data: item } = await sb
    .from("workqueue_items")
    .select("id, organization_id, assigned_to_user_id, routed_by_user_id")
    .eq("id", workqueueItemId)
    .eq("organization_id", guard.organizationId)
    .maybeSingle();

  if (!item) {
    return NextResponse.json(
      { success: false, error: "Workqueue item not found" },
      { status: 404 },
    );
  }

  const { data: rawComments, error: commentsErr } = await sb
    .from("workqueue_item_comments")
    .select("id, workqueue_item_id, comment_body, comment_type, created_at, created_by_user_id")
    .eq("organization_id", guard.organizationId)
    .eq("workqueue_item_id", workqueueItemId)
    .order("created_at", { ascending: true });

  if (commentsErr) {
    return NextResponse.json(
      { success: false, error: commentsErr.message ?? "Failed to load comments" },
      { status: 500 },
    );
  }

  const comments = (rawComments ?? []) as CommentRow[];
  const userIds = Array.from(
    new Set(comments.map((c) => c.created_by_user_id).filter((v): v is string => !!v)),
  );

  const staffByUserId = new Map<string, StaffRow>();
  const staffByStaffId = new Map<string, StaffRow>();
  if (userIds.length) {
    // created_by_user_id may be either an auth user_id OR a staff_profiles.id
    // depending on the action path that wrote it (the workqueue service
    // passes whatever `userId` the caller hands it). Look both up so the
    // author label is correct either way.
    const [{ data: byUser }, { data: byStaff }] = await Promise.all([
      sb
        .from("staff_profiles")
        .select("id, user_id, first_name, last_name, email")
        .eq("organization_id", guard.organizationId)
        .in("user_id", userIds),
      sb
        .from("staff_profiles")
        .select("id, user_id, first_name, last_name, email")
        .eq("organization_id", guard.organizationId)
        .in("id", userIds),
    ]);
    for (const s of ((byUser ?? []) as StaffRow[])) {
      if (s.user_id) staffByUserId.set(s.user_id, s);
    }
    for (const s of ((byStaff ?? []) as StaffRow[])) {
      staffByStaffId.set(s.id, s);
    }
  }

  const rows = comments.map((c) => {
    const staff = c.created_by_user_id
      ? staffByUserId.get(c.created_by_user_id) ?? staffByStaffId.get(c.created_by_user_id)
      : undefined;
    return {
      id: c.id,
      body: c.comment_body,
      type: c.comment_type,
      createdAt: c.created_at,
      authorUserId: c.created_by_user_id,
      authorName: staffName(staff),
    };
  });

  const assignedToUserId =
    (item as { assigned_to_user_id: string | null }).assigned_to_user_id ?? null;
  const routedByUserId =
    (item as { routed_by_user_id: string | null }).routed_by_user_id ?? null;

  // assigned_to_user_id stores staff_profiles.id (see upsertInboxItem),
  // routed_by_user_id stores the auth user id — compare each against the
  // matching field on the guard.
  const isAssignee = assignedToUserId !== null && assignedToUserId === guard.staffId;
  const isRouter = routedByUserId !== null && routedByUserId === guard.userId;

  return NextResponse.json({
    success: true,
    workqueueItemId,
    assignedToUserId,
    routedByUserId,
    canComment: isAssignee || isRouter,
    commentRole: isAssignee ? "assignee" : isRouter ? "router" : null,
    comments: rows,
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    workqueueItemId?: string;
    organizationId?: string;
    comment?: string;
  };

  const workqueueItemId = (body.workqueueItemId ?? "").trim();
  const commentText = (body.comment ?? "").trim();
  if (!workqueueItemId) {
    return NextResponse.json(
      { success: false, error: "workqueueItemId is required" },
      { status: 400 },
    );
  }
  if (!commentText) {
    return NextResponse.json(
      { success: false, error: "comment is required" },
      { status: 400 },
    );
  }

  const guard = await requireBillingAccess({
    requestedOrganizationId: body.organizationId,
  });
  if (guard instanceof NextResponse) return guard;

  if (!guard.staffId) {
    return NextResponse.json(
      { success: false, error: "Sign in to add a comment" },
      { status: 401 },
    );
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { success: false, error: "Database connection not available" },
      { status: 500 },
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };

  const { data: item } = await sb
    .from("workqueue_items")
    .select("id, organization_id, assigned_to_user_id, routed_by_user_id")
    .eq("id", workqueueItemId)
    .eq("organization_id", guard.organizationId)
    .maybeSingle();

  if (!item) {
    return NextResponse.json(
      { success: false, error: "Workqueue item not found" },
      { status: 404 },
    );
  }

  const assignedToUserId =
    (item as { assigned_to_user_id: string | null }).assigned_to_user_id ?? null;
  const routedByUserId =
    (item as { routed_by_user_id: string | null }).routed_by_user_id ?? null;
  const isAssignee = assignedToUserId !== null && assignedToUserId === guard.staffId;
  const isRouter = routedByUserId !== null && routedByUserId === guard.userId;
  if (!isAssignee && !isRouter) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Only the current assignee or the biller who routed this item can post a comment",
      },
      { status: 403 },
    );
  }

  const result = await addWorkqueueComment({
    organizationId: guard.organizationId,
    workqueueItemId,
    userId: guard.userId,
    comment: commentText,
  });

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.errors[0]?.message ?? "Failed to add comment" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
