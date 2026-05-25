/**
 * POST /api/billing/compliance-audit/[claimId]/action
 *
 * Body: { organizationId, action, ruleId?, reason?, assigneeUserId?,
 *         assigneeDisplayName? }
 *
 * Supported actions (spec):
 *   - route_to_clinician   : assign to rendering clinician & flag
 *   - hold_claim           : place compliance hold on the claim
 *   - correct_claim        : mark as in-progress correction
 *   - document_override    : record biller-acknowledged override w/ reason
 *   - supervisor_review    : escalate to supervisor with priority=high
 *
 * Every action upserts a row in `claim_workqueue_items` and writes a
 * `claim_status_events` audit-trail entry (source='biller'), plus a
 * `claim_notes` row for the timeline.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const text = (v: unknown) => String(v ?? "").trim();

type ActionId =
  | "route_to_clinician"
  | "hold_claim"
  | "correct_claim"
  | "document_override"
  | "supervisor_review";

const ALLOWED: ActionId[] = [
  "route_to_clinician",
  "hold_claim",
  "correct_claim",
  "document_override",
  "supervisor_review",
];

interface Body {
  organizationId?: string;
  action?: string;
  ruleId?: string;
  reason?: string;
  assigneeUserId?: string;
  assigneeDisplayName?: string;
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
  const composed = [data.first_name, data.last_name]
    .map((v: unknown) => text(v))
    .filter(Boolean)
    .join(" ");
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
      .select("id, organization_id, patient_id, encounter_id, appointment_id, claim_status")
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
    const ruleId = text(body.ruleId) || "compliance.unspecified";
    const nowIso = new Date().toISOString();

    // Compute clinician assignee for route_to_clinician (look up
    // encounter.provider_id or appointment.provider_id).
    let clinicianId: string | null = null;
    let clinicianName: string | null = null;
    if (action === "route_to_clinician") {
      let providerId: string | null = null;
      if (claim.encounter_id) {
        const { data: enc } = await (supabase as any)
          .from("encounters")
          .select("provider_id")
          .eq("id", claim.encounter_id)
          .maybeSingle();
        providerId = text(enc?.provider_id) || null;
      }
      if (!providerId && claim.appointment_id) {
        const { data: appt } = await (supabase as any)
          .from("appointments")
          .select("provider_id")
          .eq("id", claim.appointment_id)
          .maybeSingle();
        providerId = text(appt?.provider_id) || null;
      }
      if (providerId) {
        clinicianId = providerId;
        clinicianName = await resolveActorName(supabase, providerId);
      } else if (body.assigneeUserId) {
        clinicianId = text(body.assigneeUserId);
        clinicianName = text(body.assigneeDisplayName) || clinicianId.slice(0, 8);
      }
    }

    // ── Determine WQ row update for this action ──
    let nextStatus = "deferred";
    let nextPriority = "normal";
    let auditStatus = "compliance_action";
    let auditMessage = "";
    let assignToUserId: string | null = null;

    switch (action) {
      case "route_to_clinician":
        nextStatus = "deferred";
        nextPriority = "high";
        auditStatus = "routed_to_clinician";
        assignToUserId = clinicianId;
        auditMessage = `Routed to clinician ${clinicianName ?? "(unassigned)"} by ${actorName} — rule ${ruleId}${reason ? `: ${reason}` : ""}`;
        break;
      case "hold_claim":
        nextStatus = "deferred";
        nextPriority = "high";
        auditStatus = "on_hold";
        auditMessage = `Placed on compliance hold by ${actorName} — rule ${ruleId}${reason ? `: ${reason}` : ""}`;
        break;
      case "correct_claim":
        nextStatus = "rejected"; // closest valid item_status — "needs correction"
        nextPriority = "high";
        auditStatus = "queued_for_correction";
        auditMessage = `Queued for correction by ${actorName} — rule ${ruleId}${reason ? `: ${reason}` : ""}`;
        break;
      case "document_override":
        nextStatus = "resolved";
        nextPriority = "normal";
        auditStatus = "override_documented";
        if (!reason) {
          return NextResponse.json(
            { success: false, error: "An override reason is required" },
            { status: 400 },
          );
        }
        auditMessage = `Compliance override documented by ${actorName} — rule ${ruleId}: ${reason}`;
        break;
      case "supervisor_review":
        nextStatus = "deferred";
        nextPriority = "urgent";
        auditStatus = "supervisor_review";
        auditMessage = `Escalated to supervisor review by ${actorName} — rule ${ruleId}${reason ? `: ${reason}` : ""}`;
        break;
    }

    // Upsert claim_workqueue_items row.
    const { data: existing } = await (supabase as any)
      .from("claim_workqueue_items")
      .select("id, item_status, priority")
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .is("archived_at", null)
      .maybeSingle();

    if (existing) {
      const patch: Record<string, unknown> = {
        item_status: nextStatus,
        priority: nextPriority,
        action_taken: auditMessage,
        updated_at: nowIso,
      };
      if (action === "route_to_clinician" && assignToUserId) {
        patch.assigned_to_user_id = assignToUserId;
      }
      const { error } = await (supabase as any)
        .from("claim_workqueue_items")
        .update(patch)
        .eq("id", existing.id);
      if (error) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: 422 },
        );
      }
    } else {
      const insert: Record<string, unknown> = {
        organization_id: organizationId,
        claim_id: claimId,
        client_id: claim.patient_id ?? null,
        encounter_id: claim.encounter_id ?? null,
        item_status: nextStatus,
        priority: nextPriority,
        action_taken: auditMessage,
        denial_reason: ruleId,
      };
      if (action === "route_to_clinician" && assignToUserId) {
        insert.assigned_to_user_id = assignToUserId;
      }
      const { error } = await (supabase as any)
        .from("claim_workqueue_items")
        .insert(insert);
      if (error) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: 422 },
        );
      }
    }

    // For hold_claim, also flip the claim itself to on_hold w/ compliance category.
    if (action === "hold_claim") {
      const { error } = await (supabase as any)
        .from("professional_claims")
        .update({
          claim_status: "on_hold",
          hold_category: "compliance",
          hold_reason: reason || `Compliance hold — rule ${ruleId}`,
          held_by_user_id: guard.userId,
          held_by_display_name: actorName,
          hold_started_at: nowIso,
          hold_priority: "high",
          updated_at: nowIso,
        })
        .eq("id", claimId)
        .eq("organization_id", organizationId);
      if (error) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: 422 },
        );
      }
    }

    // Audit trail entry on the claim timeline.
    await (supabase as any).from("claim_status_events").insert({
      claim_id: claimId,
      source: "biller",
      status: auditStatus,
      status_message: auditMessage,
      raw_payload: {
        action,
        rule_id: ruleId,
        actor_user_id: guard.userId,
        actor_display_name: actorName,
        reason: reason || null,
        assignee_user_id: assignToUserId,
        assignee_display_name: clinicianName,
      },
    });

    // Note for biller comms log.
    await insertClaimNote(supabase as any, {
      organizationId,
      claimId,
      authorUserId: guard.userId,
      authorDisplayName: actorName,
      body: `[Compliance] ${auditMessage}`,
    });

    return NextResponse.json({
      success: true,
      action,
      item_status: nextStatus,
      priority: nextPriority,
      assigned_to_user_id: assignToUserId,
      assigned_to_display_name: clinicianName,
    });
  } catch (e) {
    console.error("Compliance & Audit action error:", e);
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
