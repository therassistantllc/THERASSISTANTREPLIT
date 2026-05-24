import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

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
}

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
      case "route_to_clinician": {
        // Resolve the appointment's provider so the row reflects a real owner.
        let providerId = body.providerId ?? null;
        if (!providerId) {
          const { data: appt } = await sb
            .from("appointments")
            .select("provider_id")
            .eq("id", appointmentId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          providerId = appt ? String(appt.provider_id ?? "") || null : null;
        }
        const display = providerId ? `Clinician ${providerId.slice(0, 8)}` : "Clinician";
        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "eligibility_routed_clinician",
          appointmentId,
          claimId,
          clientId,
          summary: note || `Routed to ${display}`,
          metadata: { note, providerId, assignedToDisplay: display, kind: "clinician" },
        });
        return NextResponse.json({
          success: true,
          assignment: { kind: "clinician", display, userId: providerId },
        });
      }
      case "route_to_admin": {
        const display = "Admin pool";
        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "eligibility_routed_admin",
          appointmentId,
          claimId,
          clientId,
          summary: note || `Routed to ${display}`,
          metadata: { note, assignedToDisplay: display, kind: "admin" },
        });
        return NextResponse.json({
          success: true,
          assignment: { kind: "admin", display, userId: null },
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
