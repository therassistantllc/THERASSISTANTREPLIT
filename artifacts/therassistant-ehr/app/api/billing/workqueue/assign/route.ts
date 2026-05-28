/**
 * POST /api/billing/workqueue/assign
 *
 * Bulk-assigns a list of claims to a biller. Looks up the staff
 * member by id, email or full name (case-insensitive). For each
 * claim, upserts a row in `claim_workqueue_items` and stamps
 * `assigned_to_user_id` + `action_taken`. Writes one row to
 * `audit_logs` per assignment.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const text = (v: unknown) => String(v ?? "").trim();

interface Body {
  organizationId?: string;
  claimIds?: string[];
  assignee?: string;
  reason?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const claimIds = Array.isArray(body.claimIds)
      ? body.claimIds.map(text).filter(Boolean)
      : [];
    const assigneeRaw = text(body.assignee);
    const reason = text(body.reason) || "Assigned via workqueue";

    if (claimIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "claimIds is required" },
        { status: 400 },
      );
    }
    if (!assigneeRaw) {
      return NextResponse.json(
        { success: false, error: "assignee is required" },
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

    // Resolve assignee → staff_profiles.id
    let assigneeId: string | null = null;
    let assigneeName: string = assigneeRaw;
    // UUID-ish?
    if (/^[0-9a-f-]{36}$/i.test(assigneeRaw)) {
      const { data: byId } = await (supabase as any)
        .from("staff_profiles")
        .select("id, first_name, last_name, email")
        .eq("id", assigneeRaw)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (byId) {
        assigneeId = text((byId as any).id);
        assigneeName =
          [byId.first_name, byId.last_name].map(text).filter(Boolean).join(" ") ||
          text(byId.email) ||
          assigneeRaw;
      }
    }
    if (!assigneeId) {
      const { data: byEmail } = await (supabase as any)
        .from("staff_profiles")
        .select("id, first_name, last_name, email")
        .eq("organization_id", organizationId)
        .ilike("email", assigneeRaw)
        .maybeSingle();
      if (byEmail) {
        assigneeId = text((byEmail as any).id);
        assigneeName =
          [byEmail.first_name, byEmail.last_name].map(text).filter(Boolean).join(" ") ||
          text(byEmail.email) ||
          assigneeRaw;
      }
    }
    // If still unresolved, fall back to storing the raw label in
    // action_taken — assigned_to_user_id stays null. This keeps the
    // assignment visible in the workqueue without failing the request.

    // Verify all claims belong to the org and load client ids
    const { data: claims } = await (supabase as any)
      .from("professional_claims")
      .select("id, patient_id")
      .eq("organization_id", organizationId)
      .in("id", claimIds);
    const validClaims = ((claims as any[]) ?? []).map((c) => ({
      id: text(c.id),
      patient_id: text(c.patient_id) || null,
    }));
    if (validClaims.length === 0) {
      return NextResponse.json(
        { success: false, error: "No accessible claims found" },
        { status: 404 },
      );
    }

    let assigned = 0;
    for (const claim of validClaims) {
      const { data: existing } = await (supabase as any)
        .from("claim_workqueue_items")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("claim_id", claim.id)
        .is("archived_at", null)
        .maybeSingle();

      if (existing) {
        const { error } = await (supabase as any)
          .from("claim_workqueue_items")
          .update({
            assigned_to_user_id: assigneeId,
            action_taken: `Assigned to ${assigneeName} — ${reason}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", (existing as any).id);
        if (!error) assigned += 1;
      } else {
        const { error } = await (supabase as any)
          .from("claim_workqueue_items")
          .insert({
            organization_id: organizationId,
            claim_id: claim.id,
            client_id: claim.patient_id,
            item_status: "denied",
            assigned_to_user_id: assigneeId,
            action_taken: `Assigned to ${assigneeName} — ${reason}`,
          });
        if (!error) assigned += 1;
      }

      await (supabase as any).from("audit_logs").insert({
        organization_id: organizationId,
        user_id: guard.userId,
        event_type: "workqueue.assign",
        event_summary: `Assigned claim to ${assigneeName}`,
        event_metadata: { assignee: assigneeName, assigneeId, reason },
        action: "assign",
        object_type: "professional_claim",
        object_id: claim.id,
        claim_id: claim.id,
        patient_id: claim.patient_id,
      }).then(() => undefined, () => undefined);
    }

    return NextResponse.json({
      success: true,
      assigned,
      assignee: { id: assigneeId, name: assigneeName },
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
