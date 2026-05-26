/**
 * Task #783: per-inbox-item reminder history.
 *
 * GET /api/billing/my-inbox/reminders?workqueueItemId=...
 *   → { reminders: [{ id, sentAt, reminderNumber, emailSent,
 *                      channelAttempts, assignedToStaffId }] }
 *
 * Visibility: the assignee can read history for their own item; an
 * admin can read history for any workqueue item in their org. Anyone
 * else gets a 403 so this can't be used to enumerate other staff's
 * routed items.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const INBOX_WORK_TYPES = [
  "eligibility_routed_clinician",
  "eligibility_routed_admin",
];

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
  if (!guard.staffId) {
    return NextResponse.json(
      { success: false, error: "Sign in to view reminder history" },
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
    .select("id, organization_id, assigned_to_user_id, work_type")
    .eq("id", workqueueItemId)
    .eq("organization_id", guard.organizationId)
    .maybeSingle();

  if (!item) {
    return NextResponse.json(
      { success: false, error: "Inbox item not found" },
      { status: 404 },
    );
  }
  const row = item as {
    assigned_to_user_id: string | null;
    work_type: string;
  };
  if (!INBOX_WORK_TYPES.includes(row.work_type)) {
    return NextResponse.json(
      { success: false, error: "Not an eligibility inbox item" },
      { status: 400 },
    );
  }

  const isAssignee = row.assigned_to_user_id === guard.staffId;
  const isAdmin = guard.roles.includes("admin");
  if (!isAssignee && !isAdmin) {
    return NextResponse.json(
      { success: false, error: "Not allowed to view this item's reminders" },
      { status: 403 },
    );
  }

  const { data: reminders, error } = await sb
    .from("eligibility_routing_reminders")
    .select(
      "id, sent_at, reminder_number, email_sent, channel_attempts, assigned_to_staff_id",
    )
    .eq("organization_id", guard.organizationId)
    .eq("workqueue_item_id", workqueueItemId)
    .order("sent_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { success: false, error: error.message ?? "Failed to load reminders" },
      { status: 500 },
    );
  }

  type ReminderRow = {
    id: string;
    sent_at: string;
    reminder_number: number | null;
    email_sent: boolean | null;
    channel_attempts: unknown;
    assigned_to_staff_id: string | null;
  };

  const rows = ((reminders ?? []) as ReminderRow[]).map((r) => ({
    id: r.id,
    sentAt: r.sent_at,
    reminderNumber: r.reminder_number ?? null,
    emailSent: Boolean(r.email_sent),
    channelAttempts: Array.isArray(r.channel_attempts) ? r.channel_attempts : [],
    assignedToStaffId: r.assigned_to_staff_id,
  }));

  return NextResponse.json({
    success: true,
    reminders: rows,
    canView: { asAssignee: isAssignee, asAdmin: isAdmin },
  });
}
