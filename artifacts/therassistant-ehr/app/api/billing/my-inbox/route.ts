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
        i.work_type === "eligibility_routed_clinician" ? "clinician" : "admin",
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
      eligibilityHref: appt?.id
        ? `/billing/eligibility-issues?appointmentId=${encodeURIComponent(appt.id)}`
        : `/billing/eligibility-issues`,
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
  if (action !== "resolve") {
    return NextResponse.json(
      { success: false, error: `Unsupported action: ${action}` },
      { status: 400 },
    );
  }

  // Make sure the item belongs to the current user before resolving — we
  // never want one user closing another user's routed handoff.
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
    .select("id, assigned_to_user_id, work_type, organization_id")
    .eq("id", itemId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();

  if (!owned) {
    return NextResponse.json(
      { success: false, error: "Inbox item not found" },
      { status: 404 },
    );
  }
  if ((owned as { assigned_to_user_id: string | null }).assigned_to_user_id !== ctx.staffId) {
    return NextResponse.json(
      { success: false, error: "This inbox item is assigned to someone else" },
      { status: 403 },
    );
  }
  if (!INBOX_WORK_TYPES.includes((owned as { work_type: string }).work_type)) {
    return NextResponse.json(
      { success: false, error: "Not an eligibility inbox item" },
      { status: 400 },
    );
  }

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
