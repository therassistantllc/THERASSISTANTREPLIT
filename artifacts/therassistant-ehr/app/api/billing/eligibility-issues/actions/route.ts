import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import {
  deliverEligibilityRoutingNotification,
  type NotificationDeliveryResult,
} from "@/lib/billing/eligibilityRoutingNotifier";

type ActionName =
  | "mark_verified"
  | "route_to_clinician"
  | "route_to_admin"
  | "hold_claim"
  | "release_claim"
  | "assign_biller"
  | "set_follow_up";

interface ActionBody {
  organizationId?: string;
  action?: ActionName;
  appointmentId?: string;
  clientId?: string;
  claimId?: string | null;
  note?: string;
  providerId?: string | null;
  billerId?: string | null;
  followUpDueAt?: string | null;
  // For route_to_clinician / route_to_admin — the staff_profiles.id of
  // the user that should own the eligibility issue.
  assignedToUserId?: string | null;
}

const text = (v: unknown) => String(v ?? "").trim();

async function writeAudit(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  args: {
    organizationId: string;
    userId: string | null;
    action: string;
    appointmentId: string | null;
    claimId: string | null;
    clientId: string | null;
    summary: string;
    metadata?: Record<string, unknown>;
  },
) {
  if (!supabase) return;
  try {
    await (supabase as unknown as { from: (t: string) => { insert: (v: unknown) => Promise<unknown> } })
      .from("audit_logs")
      .insert({
        organization_id: args.organizationId,
        user_id: args.userId,
        action: args.action,
        event_type: "eligibility_workqueue",
        event_summary: args.summary,
        event_metadata: args.metadata ?? {},
        appointment_id: args.appointmentId,
        claim_id: args.claimId,
        patient_id: args.clientId,
        object_type: "eligibility_check",
        object_id: args.appointmentId,
      });
  } catch (e) {
    console.warn("eligibility-issues audit failed:", e);
  }
}

interface ResolvedAssignee {
  staffId: string;
  name: string;
  email: string | null;
  roles: string[];
}

// Resolve & validate a staff_profiles.id, ensuring it belongs to the org,
// is active, and (for clinician/admin routes) holds the right role.
async function resolveAssignee(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: { from: (t: string) => any },
  organizationId: string,
  staffId: string,
  requireRoles: string[],
): Promise<{ assignee: ResolvedAssignee | null; error?: string }> {
  const { data: staff } = await sb
    .from("staff_profiles")
    .select("id, first_name, last_name, email, is_active")
    .eq("id", staffId)
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .maybeSingle();
  if (!staff) return { assignee: null, error: "Assignee not found in this organization" };
  if (staff.is_active === false) return { assignee: null, error: "Assignee is not active" };

  const { data: roleRows } = await sb
    .from("staff_roles")
    .select("id, role_code")
    .eq("organization_id", organizationId)
    .is("archived_at", null);
  const roleCodeById = new Map<string, string>(
    ((roleRows as Array<{ id: string; role_code: string }> | null) ?? []).map((r) => [
      text(r.id),
      text(r.role_code),
    ]),
  );
  const { data: assignments } = await sb
    .from("staff_role_assignments")
    .select("staff_role_id")
    .eq("organization_id", organizationId)
    .eq("staff_id", staffId)
    .is("archived_at", null);
  const roles = ((assignments as Array<{ staff_role_id: string }> | null) ?? [])
    .map((a) => roleCodeById.get(text(a.staff_role_id)) ?? "")
    .filter(Boolean);

  if (requireRoles.length && !requireRoles.some((r) => roles.includes(r))) {
    return {
      assignee: null,
      error: `Assignee must hold one of these roles: ${requireRoles.join(", ")}`,
    };
  }

  const name =
    [text(staff.first_name), text(staff.last_name)].filter(Boolean).join(" ") ||
    text(staff.email) ||
    text(staff.id);

  return {
    assignee: {
      staffId: text(staff.id),
      name,
      email: (staff.email as string | null) ?? null,
      roles,
    },
  };
}

// Create or refresh an inbox item (workqueue_items row) for the assignee so
// the routing handoff has a named owner that shows up in their queue. We
// reuse an open row keyed on (appointment, assignee, work_type) so repeated
// routing to the same person doesn't create duplicates.
async function upsertInboxItem(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: { from: (t: string) => any },
  args: {
    organizationId: string;
    appointmentId: string;
    clientId: string | null;
    claimId: string | null;
    assignee: ResolvedAssignee;
    kind: "clinician" | "admin";
    routedByUserId: string | null;
    note: string;
    issueLabel?: string;
  },
): Promise<string | null> {
  const workType =
    args.kind === "clinician" ? "eligibility_routed_clinician" : "eligibility_routed_admin";
  const title =
    args.kind === "clinician"
      ? "Verify client insurance for upcoming visit"
      : "Resolve eligibility issue (admin)";
  const description =
    args.note ||
    args.issueLabel ||
    "Eligibility issue routed for review and follow-up before billing.";

  const { data: existing } = await sb
    .from("workqueue_items")
    .select("id")
    .eq("organization_id", args.organizationId)
    .eq("source_object_type", "appointment")
    .eq("source_object_id", args.appointmentId)
    .eq("work_type", workType)
    .eq("assigned_to_user_id", args.assignee.staffId)
    .in("status", ["open", "in_progress", "blocked"])
    .is("archived_at", null)
    .maybeSingle();

  const nowIso = new Date().toISOString();
  const contextPayload = {
    source: "eligibility_issues_workqueue",
    routed_by_user_id: args.routedByUserId,
    assigned_to_staff_id: args.assignee.staffId,
    assigned_to_name: args.assignee.name,
    kind: args.kind,
    note: args.note,
    issue_label: args.issueLabel ?? null,
  };

  if (existing) {
    const id = text((existing as { id: string }).id);
    await sb
      .from("workqueue_items")
      .update({
        title,
        description,
        updated_at: nowIso,
        updated_by_user_id: args.routedByUserId,
        context_payload: contextPayload,
        priority: "high",
      })
      .eq("id", id);
    return id;
  }

  const { data: inserted, error } = await sb
    .from("workqueue_items")
    .insert({
      organization_id: args.organizationId,
      work_type: workType,
      title,
      description,
      status: "open",
      priority: "high",
      source_object_type: "appointment",
      source_object_id: args.appointmentId,
      client_id: args.clientId,
      assigned_to_user_id: args.assignee.staffId,
      created_by_user_id: args.routedByUserId,
      updated_by_user_id: args.routedByUserId,
      context_payload: contextPayload,
    })
    .select("id")
    .single();
  if (error || !inserted) {
    console.warn("eligibility-issues inbox upsert failed:", error?.message);
    return null;
  }
  return text((inserted as { id: string }).id);
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const body = (await request.json()) as ActionBody;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const userId = guard.userId;

    const action = body.action;
    const appointmentId = body.appointmentId ?? null;
    const claimId = body.claimId ?? null;
    const clientId = body.clientId ?? null;
    const note = (body.note ?? "").trim();

    if (!action || !appointmentId) {
      return NextResponse.json(
        { success: false, error: "action and appointmentId are required" },
        { status: 400 },
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };

    switch (action) {
      case "mark_verified": {
        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "eligibility_marked_verified",
          appointmentId,
          claimId,
          clientId,
          summary: note || "Marked eligibility verified manually",
        });
        return NextResponse.json({ success: true });
      }
      case "route_to_clinician":
      case "route_to_admin": {
        const kind = action === "route_to_clinician" ? "clinician" : "admin";
        const assignedToUserId = text(body.assignedToUserId);
        if (!assignedToUserId) {
          return NextResponse.json(
            { success: false, error: "assignedToUserId is required to route this issue" },
            { status: 400 },
          );
        }

        const requireRoles = kind === "clinician" ? ["clinician"] : ["admin", "supervisor"];
        const { assignee, error: resolveErr } = await resolveAssignee(
          sb,
          organizationId,
          assignedToUserId,
          requireRoles,
        );
        if (!assignee) {
          return NextResponse.json(
            { success: false, error: resolveErr ?? "Invalid assignee" },
            { status: 400 },
          );
        }

        const inboxItemId = await upsertInboxItem(sb, {
          organizationId,
          appointmentId,
          clientId,
          claimId,
          assignee,
          kind,
          routedByUserId: userId,
          note,
        });

        // Look up enrichment data for the email body — client name + the
        // routed-by display name. Best-effort: any failure here just drops
        // the field; we never want enrichment to break the routing call.
        let patientName: string | null = null;
        let appointmentAt: string | null = null;
        let routedByName: string | null = null;
        try {
          if (clientId) {
            const { data: c } = await sb
              .from("clients")
              .select("first_name, last_name, preferred_name")
              .eq("id", clientId)
              .eq("organization_id", organizationId)
              .maybeSingle();
            if (c) {
              const row = c as {
                first_name: string | null;
                last_name: string | null;
                preferred_name: string | null;
              };
              patientName =
                row.preferred_name ||
                [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
                null;
            }
          }
          if (appointmentId) {
            const { data: a } = await sb
              .from("appointments")
              .select("scheduled_start_at")
              .eq("id", appointmentId)
              .eq("organization_id", organizationId)
              .maybeSingle();
            if (a) {
              appointmentAt =
                (a as { scheduled_start_at: string | null }).scheduled_start_at ?? null;
            }
          }
          if (userId) {
            const { data: s } = await sb
              .from("staff_profiles")
              .select("first_name, last_name, email")
              .eq("auth_user_id", userId)
              .eq("organization_id", organizationId)
              .maybeSingle();
            if (s) {
              const row = s as {
                first_name: string | null;
                last_name: string | null;
                email: string | null;
              };
              routedByName =
                [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
                row.email ||
                null;
            }
          }
        } catch (e) {
          console.warn("eligibility-issues notification enrichment failed:", e);
        }

        let notification: NotificationDeliveryResult | null = null;
        try {
          notification = await deliverEligibilityRoutingNotification({
            sb,
            organizationId,
            assignee,
            kind,
            inboxItemId,
            routedByName,
            patientName,
            appointmentAt,
            note,
          });
        } catch (e) {
          console.warn("eligibility-issues notification delivery failed:", e);
        }

        const summary = note
          ? `Routed to ${assignee.name}: ${note}`
          : `Routed to ${assignee.name}`;

        await writeAudit(supabase, {
          organizationId,
          userId,
          action:
            kind === "clinician"
              ? "eligibility_routed_clinician"
              : "eligibility_routed_admin",
          appointmentId,
          claimId,
          clientId,
          summary,
          metadata: {
            note,
            kind,
            assignedToUserId: assignee.staffId,
            assignedToName: assignee.name,
            assignedToEmail: assignee.email,
            assignedToRoles: assignee.roles,
            routedByUserId: userId,
            inboxItemId,
            // Keep `providerId` for backwards-compat with older readers of
            // the audit log; only the clinician path actually carries one.
            providerId: kind === "clinician" ? body.providerId ?? null : null,
            assignedToDisplay: assignee.name,
            // Task #625: record whether the routing notification went out so
            // admins can audit "did the assignee actually get pinged?".
            notification: notification ?? { attempts: [], emailSent: false, inAppSent: false },
          },
        });

        return NextResponse.json({
          success: true,
          assignment: {
            kind,
            display: assignee.name,
            userId: assignee.staffId,
            email: assignee.email,
          },
          inboxItemId,
          notification,
        });
      }
      case "assign_biller": {
        const billerId = (body.billerId ?? userId ?? "").trim();
        if (!billerId) {
          return NextResponse.json(
            { success: false, error: "billerId is required" },
            { status: 400 },
          );
        }
        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "eligibility_assigned_biller",
          appointmentId,
          claimId,
          clientId,
          summary: note || `Assigned to biller ${billerId}`,
          metadata: { billerId, note },
        });
        return NextResponse.json({ success: true, billerId });
      }
      case "set_follow_up": {
        const dueAt = (body.followUpDueAt ?? "").trim();
        if (!dueAt) {
          return NextResponse.json(
            { success: false, error: "followUpDueAt is required" },
            { status: 400 },
          );
        }
        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "eligibility_follow_up_set",
          appointmentId,
          claimId,
          clientId,
          summary: note || `Follow-up due ${dueAt}`,
          metadata: { dueAt, note },
        });
        return NextResponse.json({ success: true, dueAt });
      }
      case "hold_claim": {
        if (claimId) {
          const { data: existing } = await sb
            .from("professional_claims")
            .select("billing_notes")
            .eq("id", claimId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          const prior = (existing?.billing_notes as string | null) ?? "";
          const marker = `[HOLD - eligibility ${new Date().toISOString()}] ${note || "Held pending eligibility verification"}`;
          const merged = prior ? `${prior}\n${marker}` : marker;
          const { error } = await sb
            .from("professional_claims")
            .update({ claim_status: "draft", billing_notes: merged })
            .eq("id", claimId)
            .eq("organization_id", organizationId);
          if (error) {
            return NextResponse.json(
              { success: false, error: error.message ?? "Failed to hold claim" },
              { status: 500 },
            );
          }
        }
        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "claim_held_eligibility",
          appointmentId,
          claimId,
          clientId,
          summary: note || "Held claim pending eligibility verification",
        });
        return NextResponse.json({ success: true });
      }
      case "release_claim": {
        if (claimId) {
          const { data: existing } = await sb
            .from("professional_claims")
            .select("billing_notes")
            .eq("id", claimId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          const prior = (existing?.billing_notes as string | null) ?? "";
          const marker = `[RELEASED - eligibility ${new Date().toISOString()}] ${note || "Released after eligibility verification"}`;
          const merged = prior ? `${prior}\n${marker}` : marker;
          const { error } = await sb
            .from("professional_claims")
            .update({ claim_status: "ready_for_validation", billing_notes: merged })
            .eq("id", claimId)
            .eq("organization_id", organizationId);
          if (error) {
            return NextResponse.json(
              { success: false, error: error.message ?? "Failed to release claim" },
              { status: 500 },
            );
          }
        }
        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "claim_released_eligibility",
          appointmentId,
          claimId,
          clientId,
          summary: note || "Released claim after eligibility verification",
        });
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Action failed",
      },
      { status: 500 },
    );
  }
}
