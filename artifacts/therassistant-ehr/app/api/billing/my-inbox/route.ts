/**
 * My Inbox API — workqueue_items routed to the current staff member
 * from the Eligibility Issues queue.
 *
 * GET  /api/billing/my-inbox                 → list open items
 * GET  /api/billing/my-inbox?countOnly=1     → just `{ count }` for badge
 * PATCH /api/billing/my-inbox                → { id, action: "resolve" }
 *
 * The list is scoped to the requesting user (assigned_to_user_id =
 * session staffId) so admins/clinicians can only ever see their own
 * routed eligibility handoffs.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { resolveWorkqueueItem } from "@/lib/workqueue/workqueueActionService";

const INBOX_WORK_TYPES = [
  "eligibility_routed_clinician",
  "eligibility_routed_admin",
  "provider_approval_needed",
];
const OPEN_STATUSES = ["open", "in_progress", "blocked"];

type WorkqueueRow = {
  id: string;
  work_type: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  source_object_type: string;
  source_object_id: string;
  client_id: string | null;
  claim_id: string | null;
  professional_claim_id: string | null;
  created_at: string;
  updated_at: string;
  context_payload: Record<string, unknown> | null;
};

type AppointmentRow = {
  id: string;
  scheduled_start_at: string | null;
  appointment_type: string | null;
  client_id: string;
  provider_id: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
};

function staffOrError(
  guard: Awaited<ReturnType<typeof requireBillingAccess>>,
): { ok: true; organizationId: string; staffId: string; userId: string | null } | NextResponse {
  if (guard instanceof NextResponse) return guard;
  if (!guard.staffId) {
    // Dev passthrough / unauthenticated context can't have a personal inbox.
    return NextResponse.json(
      { success: false, error: "Sign in to view your inbox" },
      { status: 401 },
    );
  }
  return {
    ok: true,
    organizationId: guard.organizationId,
    staffId: guard.staffId,
    userId: guard.userId,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const countOnly = url.searchParams.get("countOnly") === "1";

  const guard = await requireBillingAccess({
    requestedOrganizationId: url.searchParams.get("organizationId"),
  });
  const ctx = staffOrError(guard);
  if (ctx instanceof NextResponse) {
    // For the badge, swallow auth errors as `{count:0}` so the nav doesn't
    // flash an error when the user isn't logged in / no staff record.
    if (countOnly) return NextResponse.json({ count: 0 });
    return ctx;
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

  if (countOnly) {
    const { count } = await sb
      .from("workqueue_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ctx.organizationId)
      .eq("assigned_to_user_id", ctx.staffId)
      .in("work_type", INBOX_WORK_TYPES)
      .in("status", OPEN_STATUSES)
      .is("archived_at", null);
    return NextResponse.json({ count: count ?? 0 });
  }

  const { data: itemsData, error: itemsErr } = await sb
    .from("workqueue_items")
    .select(
      "id, work_type, title, description, status, priority, source_object_type, source_object_id, client_id, claim_id, professional_claim_id, created_at, updated_at, context_payload",
    )
    .eq("organization_id", ctx.organizationId)
    .eq("assigned_to_user_id", ctx.staffId)
    .in("work_type", INBOX_WORK_TYPES)
    .in("status", OPEN_STATUSES)
    .is("archived_at", null)
    .order("priority", { ascending: false })
    .order("updated_at", { ascending: false });

  if (itemsErr) {
    return NextResponse.json(
      { success: false, error: itemsErr.message ?? "Failed to load inbox" },
      { status: 500 },
    );
  }

  const items = (itemsData ?? []) as WorkqueueRow[];

  // One grouped query for comment counts so we don't fan out N requests
  // from the client to render a badge per row.
  const commentCountByItem = new Map<string, number>();
  const reminderStatsByItem = new Map<
    string,
    { count: number; lastSentAt: string | null }
  >();
  if (items.length) {
    const ids = items.map((i) => i.id);
    const { data: cmts } = await sb
      .from("workqueue_item_comments")
      .select("workqueue_item_id")
      .eq("organization_id", ctx.organizationId)
      .in("workqueue_item_id", ids);
    for (const c of ((cmts ?? []) as { workqueue_item_id: string }[])) {
      commentCountByItem.set(
        c.workqueue_item_id,
        (commentCountByItem.get(c.workqueue_item_id) ?? 0) + 1,
      );
    }

    // Task #740: per-item reminder history so assignees see they've been
    // nudged. Pull every reminder log row for these items in one query.
    const { data: reminders } = await sb
      .from("eligibility_routing_reminders")
      .select("workqueue_item_id, sent_at")
      .eq("organization_id", ctx.organizationId)
      .in("workqueue_item_id", ids);
    for (const r of ((reminders ?? []) as {
      workqueue_item_id: string;
      sent_at: string | null;
    }[])) {
      const prev = reminderStatsByItem.get(r.workqueue_item_id) ?? {
        count: 0,
        lastSentAt: null as string | null,
      };
      prev.count += 1;
      if (r.sent_at && (!prev.lastSentAt || r.sent_at > prev.lastSentAt)) {
        prev.lastSentAt = r.sent_at;
      }
      reminderStatsByItem.set(r.workqueue_item_id, prev);
    }
  }

  // Enrich rows that point at appointments so the inbox can show
  // a real date + patient name without the user clicking through.
  const appointmentIds = Array.from(
    new Set(
      items
        .filter((i) => i.source_object_type === "appointment")
        .map((i) => i.source_object_id)
        .filter(Boolean),
    ),
  );

  const apptById = new Map<string, AppointmentRow>();
  if (appointmentIds.length) {
    const { data: appts } = await sb
      .from("appointments")
      .select("id, scheduled_start_at, appointment_type, client_id, provider_id")
      .eq("organization_id", ctx.organizationId)
      .in("id", appointmentIds);
    for (const a of (appts ?? []) as AppointmentRow[]) {
      apptById.set(a.id, a);
    }
  }

  const clientIds = Array.from(
    new Set(
      [
        ...items.map((i) => i.client_id).filter(Boolean),
        ...Array.from(apptById.values()).map((a) => a.client_id).filter(Boolean),
      ] as string[],
    ),
  );

  const clientById = new Map<string, ClientRow>();
  if (clientIds.length) {
    const { data: clients } = await sb
      .from("clients")
      .select("id, first_name, last_name, preferred_name")
      .eq("organization_id", ctx.organizationId)
      .in("id", clientIds);
    for (const c of (clients ?? []) as ClientRow[]) {
      clientById.set(c.id, c);
    }
  }

  function patientName(clientId: string | null): string | null {
    if (!clientId) return null;
    const c = clientById.get(clientId);
    if (!c) return null;
    const name =
      c.preferred_name ||
      [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
    return name || null;
  }

  const rows = items.map((i) => {
    const appt = i.source_object_type === "appointment"
      ? apptById.get(i.source_object_id) ?? null
      : null;
    const effectiveClientId = i.client_id ?? appt?.client_id ?? null;
    const ctxPayload = (i.context_payload ?? {}) as Record<string, unknown>;
    return {
      id: i.id,
      workType: i.work_type,
      kind:
        i.work_type === "eligibility_routed_clinician" || i.work_type === "provider_approval_needed"
          ? "clinician"
          : "admin",
      title: i.title,
      description: i.description,
      status: i.status,
      priority: i.priority,
      appointmentId: appt?.id ?? (i.source_object_type === "appointment" ? i.source_object_id : null),
      appointmentAt: appt?.scheduled_start_at ?? null,
      appointmentType: appt?.appointment_type ?? null,
      clientId: effectiveClientId,
      clientName: patientName(effectiveClientId),
      claimId: i.claim_id ?? i.professional_claim_id ?? null,
      routedByUserId: (ctxPayload.routed_by_user_id as string | null) ?? null,
      note: (ctxPayload.note as string | null) ?? null,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      eligibilityHref: i.work_type === "provider_approval_needed"
        ? `/billing/patient-balances`
        : appt?.id
        ? `/billing/eligibility-issues?appointmentId=${encodeURIComponent(appt.id)}`
        : `/billing/eligibility-issues`,
      billingComment: i.work_type === "provider_approval_needed"
        ? ((ctxPayload.billingComment as string | null) ?? null)
        : null,
      patientResponsibility: i.work_type === "provider_approval_needed"
        ? ((ctxPayload.patientResponsibility as number | null) ?? null)
        : null,
      commentCount: commentCountByItem.get(i.id) ?? 0,
      reminderCount: reminderStatsByItem.get(i.id)?.count ?? 0,
      lastRemindedAt: reminderStatsByItem.get(i.id)?.lastSentAt ?? null,
    };
  });

  return NextResponse.json({ success: true, items: rows, count: rows.length });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    action?: string;
    organizationId?: string;
    comment?: string | null;
  };
  const guard = await requireBillingAccess({
    requestedOrganizationId: body.organizationId,
  });
  const ctx = staffOrError(guard);
  if (ctx instanceof NextResponse) return ctx;

  const itemId = (body.id ?? "").trim();
  if (!itemId) {
    return NextResponse.json(
      { success: false, error: "id is required" },
      { status: 400 },
    );
  }

  const action = body.action ?? "resolve";
  const validActions = ["resolve", "approve", "charity_care", "discount"];
  if (!validActions.includes(action)) {
    return NextResponse.json(
      { success: false, error: `Unsupported action: ${action}` },
      { status: 400 },
    );
  }

  // Make sure the item belongs to the current user before acting.
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { success: false, error: "Database connection not available" },
      { status: 500 },
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };
  const { data: owned } = await sb
    .from("workqueue_items")
    .select("id, assigned_to_user_id, work_type, organization_id, claim_id, context_payload")
    .eq("id", itemId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();

  if (!owned) {
    return NextResponse.json(
      { success: false, error: "Inbox item not found" },
      { status: 404 },
    );
  }
  if (!INBOX_WORK_TYPES.includes((owned as { work_type: string }).work_type)) {
    return NextResponse.json(
      { success: false, error: "Not a valid inbox item" },
      { status: 400 },
    );
  }

  // Provider approval actions — for items with work_type = provider_approval_needed
  if (["approve", "charity_care", "discount"].includes(action)) {
    const ownedTyped = owned as {
      work_type: string;
      claim_id: string | null;
      context_payload: Record<string, unknown> | null;
    };
    if (ownedTyped.work_type !== "provider_approval_needed") {
      return NextResponse.json(
        { success: false, error: "Action only valid for provider approval items" },
        { status: 400 },
      );
    }
    const claimId = ownedTyped.claim_id;
    if (!claimId) {
      return NextResponse.json(
        { success: false, error: "No claim linked to this approval item" },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();

    if (action === "approve") {
      // Mark workqueue item resolved; return claim to patient balances queue
      await sb
        .from("workqueue_items")
        .update({ status: "resolved", resolved_at: now, updated_at: now })
        .eq("id", itemId);
      return NextResponse.json({ success: true, action, claimId });
    }

    if (action === "charity_care") {
      // Write off the patient balance as charity care
      const { error: wErr } = await sb
        .from("professional_claims")
        .update({
          patient_responsibility_amount: 0,
          write_off_amount: null, // handled by existing write_off columns if available
          billing_notes: `[Charity care write-off by provider — ${now.split("T")[0]}]`,
          updated_at: now,
        })
        .eq("id", claimId)
        .eq("organization_id", ctx.organizationId);
      if (wErr) throw wErr;
      await sb
        .from("workqueue_items")
        .update({ status: "resolved", resolved_at: now, updated_at: now })
        .eq("id", itemId);
      return NextResponse.json({ success: true, action, claimId });
    }

    if (action === "discount") {
      // Provider sends back a new approved patient amount
      const discountedAmount = Number((body as { discountedAmount?: unknown }).discountedAmount ?? 0);
      if (!Number.isFinite(discountedAmount) || discountedAmount < 0) {
        return NextResponse.json(
          { success: false, error: "discountedAmount must be a non-negative number" },
          { status: 400 },
        );
      }
      const { error: dErr } = await sb
        .from("professional_claims")
        .update({
          patient_responsibility_amount: discountedAmount,
          billing_notes: `[Discounted to $${discountedAmount.toFixed(2)} by provider — ${now.split("T")[0]}]`,
          updated_at: now,
        })
        .eq("id", claimId)
        .eq("organization_id", ctx.organizationId);
      if (dErr) throw dErr;
      await sb
        .from("workqueue_items")
        .update({ status: "resolved", resolved_at: now, updated_at: now })
        .eq("id", itemId);
      return NextResponse.json({
        success: true,
        action,
        claimId,
        newPatientResponsibility: discountedAmount,
      });
    }
  }

  // Standard resolve action
  const result = await resolveWorkqueueItem({
    organizationId: ctx.organizationId,
    workqueueItemId: itemId,
    userId: ctx.userId,
    comment: body.comment ?? "Resolved from My Inbox",
  });

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.errors[0]?.message ?? "Resolve failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ success: true, status: result.status });
}
