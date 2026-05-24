/**
 * /api/billing/denials-by-carc/action
 *
 * Bulk actions invoked from the Denied Claims by CARC workqueue.
 *
 * Supported actions:
 *   - assign          — set claim_workqueue_items.assigned_to_user_id on every
 *                       claim in the list (creates a CARC-tagged item if none
 *                       exists yet).
 *   - appeal          — append an "APPEAL DRAFT" claim_note on each claim and
 *                       mark the workqueue item action_taken='appeal_drafted'.
 *   - correct         — mark each workqueue item item_status='in_progress' with
 *                       action_taken='correction_queued' and log a claim_note.
 *   - create_rule     — record a payer-rule proposal as a claim_note on the
 *                       first claim and a billing_alert visible to billers
 *                       (no new schema introduced — this is the audit trail).
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const text = (v: unknown) => String(v ?? "").trim();

type ActionKind = "assign" | "appeal" | "correct" | "create_rule";

interface Body {
  organizationId?: string;
  action?: ActionKind;
  claimIds?: string[];
  carcCode?: string;
  /** assign */
  assignedToUserId?: string | null;
  /** appeal */
  appealBody?: string;
  /** correct */
  correctionNote?: string;
  /** create_rule */
  payer?: string;
  ruleSummary?: string;
}

async function ensureWorkqueueItem(
  supabase: any,
  organizationId: string,
  claimId: string,
  carcCode: string | null,
): Promise<string | null> {
  // Try to find an existing open item.
  const { data: existing } = await supabase
    .from("claim_workqueue_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("claim_id", claimId)
    .is("archived_at", null)
    .neq("item_status", "resolved")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return text(existing.id);

  const { data: inserted, error } = await supabase
    .from("claim_workqueue_items")
    .insert({
      organization_id: organizationId,
      claim_id: claimId,
      carc_code: carcCode || null,
      item_status: "open",
      priority: "normal",
    })
    .select("id")
    .single();
  if (error) return null;
  return text(inserted?.id);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const action = (body.action ?? "") as ActionKind;
    if (!["assign", "appeal", "correct", "create_rule"].includes(action)) {
      return NextResponse.json(
        { success: false, error: "Unknown action" },
        { status: 400 },
      );
    }

    const claimIds = Array.isArray(body.claimIds)
      ? body.claimIds.map(text).filter(Boolean)
      : [];
    if (claimIds.length === 0 && action !== "create_rule") {
      return NextResponse.json(
        { success: false, error: "claimIds is required" },
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

    // Verify every claim belongs to the org.
    const { data: ownedRows } = await (supabase as any)
      .from("professional_claims")
      .select("id")
      .eq("organization_id", organizationId)
      .in("id", claimIds.length ? claimIds : ["00000000-0000-0000-0000-000000000000"]);
    const ownedIds = new Set<string>(
      ((ownedRows as Array<{ id: string }>) ?? []).map((r) => text(r.id)),
    );
    const validIds = claimIds.filter((id) => ownedIds.has(id));

    const carcCode = body.carcCode === "UNKNOWN" ? null : text(body.carcCode) || null;

    let authorName = "Staff";
    if (guard.staffId) {
      const { data: staffRow } = await (supabase as any)
        .from("staff_profiles")
        .select("first_name, last_name, email")
        .eq("id", guard.staffId)
        .maybeSingle();
      if (staffRow) {
        const composed = [staffRow.first_name, staffRow.last_name]
          .map((v: any) => text(v))
          .filter(Boolean)
          .join(" ");
        authorName = composed || text(staffRow.email) || "Staff";
      }
    }

    if (action === "assign") {
      const assignedToUserId = body.assignedToUserId ? text(body.assignedToUserId) : null;
      let updated = 0;
      const errors: string[] = [];
      for (const claimId of validIds) {
        const itemId = await ensureWorkqueueItem(supabase, organizationId, claimId, carcCode);
        if (!itemId) {
          errors.push(claimId);
          continue;
        }
        const { error } = await (supabase as any)
          .from("claim_workqueue_items")
          .update({
            assigned_to_user_id: assignedToUserId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", itemId)
          .eq("organization_id", organizationId);
        if (error) errors.push(claimId);
        else updated += 1;
      }
      // Audit trail
      for (const claimId of validIds) {
        await (supabase as any).from("claim_notes").insert({
          organization_id: organizationId,
          claim_id: claimId,
          author_user_id: guard.userId,
          author_display_name: authorName,
          body: `[CARC ${carcCode ?? "UNKNOWN"}] Bulk assigned${
            assignedToUserId ? ` to user ${assignedToUserId}` : " (unassigned)"
          }.`,
        });
      }
      return NextResponse.json({ success: errors.length === 0, updated, errors });
    }

    if (action === "appeal") {
      const appealBody = text(body.appealBody);
      if (!appealBody) {
        return NextResponse.json(
          { success: false, error: "appealBody is required" },
          { status: 400 },
        );
      }
      let drafted = 0;
      for (const claimId of validIds) {
        await (supabase as any).from("claim_notes").insert({
          organization_id: organizationId,
          claim_id: claimId,
          author_user_id: guard.userId,
          author_display_name: authorName,
          body: `APPEAL DRAFT (CARC ${carcCode ?? "UNKNOWN"}):\n\n${appealBody}`,
        });
        const itemId = await ensureWorkqueueItem(supabase, organizationId, claimId, carcCode);
        if (itemId) {
          await (supabase as any)
            .from("claim_workqueue_items")
            .update({
              action_taken: "appeal_drafted",
              updated_at: new Date().toISOString(),
            })
            .eq("id", itemId)
            .eq("organization_id", organizationId);
        }
        drafted += 1;
      }
      return NextResponse.json({ success: true, drafted });
    }

    if (action === "correct") {
      const correctionNote =
        text(body.correctionNote) ||
        `Correction queued for CARC ${carcCode ?? "UNKNOWN"} denial.`;
      let updated = 0;
      for (const claimId of validIds) {
        const itemId = await ensureWorkqueueItem(supabase, organizationId, claimId, carcCode);
        if (itemId) {
          await (supabase as any)
            .from("claim_workqueue_items")
            .update({
              item_status: "in_progress",
              action_taken: "correction_queued",
              updated_at: new Date().toISOString(),
            })
            .eq("id", itemId)
            .eq("organization_id", organizationId);
        }
        await (supabase as any).from("claim_notes").insert({
          organization_id: organizationId,
          claim_id: claimId,
          author_user_id: guard.userId,
          author_display_name: authorName,
          body: `CORRECTION QUEUED (CARC ${carcCode ?? "UNKNOWN"}): ${correctionNote}`,
        });
        updated += 1;
      }
      return NextResponse.json({ success: true, updated });
    }

    if (action === "create_rule") {
      const payer = text(body.payer);
      const ruleSummary = text(body.ruleSummary);
      if (!payer || !ruleSummary) {
        return NextResponse.json(
          { success: false, error: "payer and ruleSummary are required" },
          { status: 400 },
        );
      }
      const noteBody = `PAYER RULE PROPOSAL — ${payer} / CARC ${carcCode ?? "UNKNOWN"}:\n${ruleSummary}`;
      const anchorClaimId = validIds[0] ?? null;
      if (anchorClaimId) {
        await (supabase as any).from("claim_notes").insert({
          organization_id: organizationId,
          claim_id: anchorClaimId,
          author_user_id: guard.userId,
          author_display_name: authorName,
          body: noteBody,
        });
      }
      await (supabase as any).from("billing_alerts").insert({
        organization_id: organizationId,
        alert_type: "payer_rule_proposal",
        severity: "info",
        alert_status: "open",
        title: `Payer rule: ${payer} — CARC ${carcCode ?? "UNKNOWN"}`,
        description: ruleSummary,
        claim_id: anchorClaimId,
      });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: "Unhandled action" }, { status: 400 });
  } catch (e) {
    console.error("denials-by-carc action error:", e);
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Action failed" },
      { status: 500 },
    );
  }
}
