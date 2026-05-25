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
 *   - create_rule     — write an active row to `payer_rules` so the
 *                       pre-submission Claim Content Validation engine
 *                       auto-flags (or blocks) future claims for this
 *                       payer + CARC. Also records the audit alert+note.
 *   - promote_rule_proposal — promote an existing billing_alert of type
 *                       'payer_rule_proposal' into an active payer_rules
 *                       row and resolve the alert.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const text = (v: unknown) => String(v ?? "").trim();

type ActionKind = "assign" | "appeal" | "correct" | "create_rule" | "promote_rule_proposal";

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
  /** create_rule: 'warn' (default) flags claims; 'block' prevents submission. */
  ruleAction?: "warn" | "block";
  /** create_rule: explicit payer_profile_id (preferred over payer name lookup). */
  payerProfileId?: string;
  /** promote_rule_proposal */
  alertId?: string;
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
    if (
      !["assign", "appeal", "correct", "create_rule", "promote_rule_proposal"].includes(action)
    ) {
      return NextResponse.json(
        { success: false, error: "Unknown action" },
        { status: 400 },
      );
    }

    const claimIds = Array.isArray(body.claimIds)
      ? body.claimIds.map(text).filter(Boolean)
      : [];
    if (
      claimIds.length === 0 &&
      action !== "create_rule" &&
      action !== "promote_rule_proposal"
    ) {
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
        await insertClaimNote(supabase as any, {
          organizationId,
          claimId,
          authorUserId: guard.userId,
          authorDisplayName: authorName,
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
        await insertClaimNote(supabase as any, {
          organizationId,
          claimId,
          authorUserId: guard.userId,
          authorDisplayName: authorName,
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
        await insertClaimNote(supabase as any, {
          organizationId,
          claimId,
          authorUserId: guard.userId,
          authorDisplayName: authorName,
          body: `CORRECTION QUEUED (CARC ${carcCode ?? "UNKNOWN"}): ${correctionNote}`,
        });
        updated += 1;
      }
      return NextResponse.json({ success: true, updated });
    }

    if (action === "create_rule") {
      const payer = text(body.payer);
      const ruleSummary = text(body.ruleSummary);
      const ruleAction: "warn" | "block" = body.ruleAction === "block" ? "block" : "warn";
      if (!payer || !ruleSummary) {
        return NextResponse.json(
          { success: false, error: "payer and ruleSummary are required" },
          { status: 400 },
        );
      }

      // Resolve payer_profile_id: explicit body field wins; otherwise pull
      // from the first valid claim; otherwise look up by payer name in the
      // org's payer_profiles. We require a real payer_profile_id because
      // the engine joins active rules by it.
      let payerProfileId = text(body.payerProfileId) || null;
      const anchorClaimId = validIds[0] ?? null;
      if (!payerProfileId && anchorClaimId) {
        const { data: claimRow } = await (supabase as any)
          .from("professional_claims")
          .select("payer_profile_id")
          .eq("id", anchorClaimId)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (claimRow?.payer_profile_id) payerProfileId = text(claimRow.payer_profile_id);
      }
      if (!payerProfileId) {
        const { data: pp } = await (supabase as any)
          .from("payer_profiles")
          .select("id")
          .eq("organization_id", organizationId)
          .ilike("payer_name", payer)
          .limit(1)
          .maybeSingle();
        if (pp?.id) payerProfileId = text(pp.id);
      }
      if (!payerProfileId) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Could not resolve a payer_profile_id for this rule. Pass payerProfileId or select claims with the target payer.",
          },
          { status: 422 },
        );
      }

      // Idempotent: there is a partial unique index on
      // (organization_id, payer_profile_id, coalesce(carc_code,''))
      // WHERE status='active'. Postgrest's `.is()` / `.eq()` chain is
      // awkward for NULL equality on carc_code, so we fetch the active
      // rules for this payer and match the CARC in-memory.
      const { data: dupRows } = await (supabase as any)
        .from("payer_rules")
        .select("id, rule, carc_code")
        .eq("organization_id", organizationId)
        .eq("payer_profile_id", payerProfileId)
        .eq("status", "active")
        .is("archived_at", null);
      const dup = (Array.isArray(dupRows) ? dupRows : []).find(
        (r: any) => text(r.carc_code) === text(carcCode),
      );

      let ruleId: string | null = null;
      if (dup?.id) {
        ruleId = text(dup.id);
        const merged = dup.rule && !dup.rule.includes(ruleSummary)
          ? `${dup.rule}\n\n— ${authorName}: ${ruleSummary}`
          : ruleSummary;
        await (supabase as any)
          .from("payer_rules")
          .update({
            rule: merged,
            action: ruleAction,
            updated_at: new Date().toISOString(),
          })
          .eq("id", ruleId)
          .eq("organization_id", organizationId);
      } else {
        const { data: inserted, error: insertErr } = await (supabase as any)
          .from("payer_rules")
          .insert({
            organization_id: organizationId,
            payer_profile_id: payerProfileId,
            carc_code: carcCode || null,
            rule: ruleSummary,
            action: ruleAction,
            status: "active",
            source_claim_id: anchorClaimId,
            created_by_user_id: guard.userId ?? null,
          })
          .select("id")
          .single();
        if (insertErr) {
          return NextResponse.json(
            { success: false, error: `Failed to create payer rule: ${insertErr.message}` },
            { status: 500 },
          );
        }
        ruleId = text(inserted?.id);
      }

      const verbLabel = ruleAction === "block" ? "BLOCK" : "FLAG";
      const noteBody =
        `PAYER RULE (${verbLabel}) — ${payer} / CARC ${carcCode ?? "UNKNOWN"}:\n${ruleSummary}\n` +
        `(Active rule id: ${ruleId})`;
      if (anchorClaimId) {
        await insertClaimNote(supabase as any, {
          organizationId,
          claimId: anchorClaimId,
          authorUserId: guard.userId,
          authorDisplayName: authorName,
          body: noteBody,
        });
      }
      await (supabase as any).from("billing_alerts").insert({
        organization_id: organizationId,
        alert_type: "payer_rule_active",
        severity: ruleAction === "block" ? "warning" : "info",
        alert_status: "resolved",
        title: `Payer rule active: ${payer} — CARC ${carcCode ?? "UNKNOWN"}`,
        description: `${ruleSummary}\n\nAction: ${ruleAction.toUpperCase()}. Pre-submission claims to this payer will be ${
          ruleAction === "block" ? "blocked" : "flagged"
        }.`,
        claim_id: anchorClaimId,
      });
      return NextResponse.json({ success: true, ruleId, ruleAction });
    }

    if (action === "promote_rule_proposal") {
      const alertId = text(body.alertId);
      if (!alertId) {
        return NextResponse.json(
          { success: false, error: "alertId is required" },
          { status: 400 },
        );
      }
      const { data: alert } = await (supabase as any)
        .from("billing_alerts")
        .select("id, organization_id, claim_id, title, description, alert_type")
        .eq("id", alertId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!alert || alert.alert_type !== "payer_rule_proposal") {
        return NextResponse.json(
          { success: false, error: "Proposal not found" },
          { status: 404 },
        );
      }

      // Title was written as: "Payer rule: <payerName> — CARC <code>"
      const title = text(alert.title);
      let payerName = "";
      let carcFromTitle: string | null = null;
      const titleMatch = title.match(/^Payer rule:\s+(.+?)\s+—\s+CARC\s+(\S+)\s*$/);
      if (titleMatch) {
        payerName = titleMatch[1].trim();
        carcFromTitle = titleMatch[2].trim();
        if (carcFromTitle === "UNKNOWN") carcFromTitle = null;
      }

      let payerProfileId: string | null = null;
      if (alert.claim_id) {
        const { data: claimRow } = await (supabase as any)
          .from("professional_claims")
          .select("payer_profile_id")
          .eq("id", alert.claim_id)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (claimRow?.payer_profile_id) payerProfileId = text(claimRow.payer_profile_id);
      }
      if (!payerProfileId && payerName) {
        const { data: pp } = await (supabase as any)
          .from("payer_profiles")
          .select("id")
          .eq("organization_id", organizationId)
          .ilike("payer_name", payerName)
          .limit(1)
          .maybeSingle();
        if (pp?.id) payerProfileId = text(pp.id);
      }
      if (!payerProfileId) {
        return NextResponse.json(
          { success: false, error: "Could not resolve payer_profile_id for this proposal" },
          { status: 422 },
        );
      }

      const ruleAction: "warn" | "block" = body.ruleAction === "block" ? "block" : "warn";
      const ruleSummary = text(alert.description) || title;
      const effectiveCarc = carcCode ?? carcFromTitle;

      const { data: dupRows } = await (supabase as any)
        .from("payer_rules")
        .select("id, rule")
        .eq("organization_id", organizationId)
        .eq("payer_profile_id", payerProfileId)
        .eq("status", "active")
        .is("archived_at", null);
      const dup = (Array.isArray(dupRows) ? dupRows : []).find(
        (r: any) => text(r.carc_code) === text(effectiveCarc),
      );

      let ruleId: string | null = null;
      if (dup?.id) {
        ruleId = text(dup.id);
        await (supabase as any)
          .from("payer_rules")
          .update({
            action: ruleAction,
            source_alert_id: alertId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", ruleId)
          .eq("organization_id", organizationId);
      } else {
        const { data: inserted, error: insertErr } = await (supabase as any)
          .from("payer_rules")
          .insert({
            organization_id: organizationId,
            payer_profile_id: payerProfileId,
            carc_code: effectiveCarc || null,
            rule: ruleSummary,
            action: ruleAction,
            status: "active",
            source_alert_id: alertId,
            source_claim_id: alert.claim_id ?? null,
            created_by_user_id: guard.userId ?? null,
          })
          .select("id")
          .single();
        if (insertErr) {
          return NextResponse.json(
            { success: false, error: `Failed to promote proposal: ${insertErr.message}` },
            { status: 500 },
          );
        }
        ruleId = text(inserted?.id);
      }

      await (supabase as any)
        .from("billing_alerts")
        .update({ alert_status: "resolved" })
        .eq("id", alertId)
        .eq("organization_id", organizationId);

      return NextResponse.json({ success: true, ruleId, ruleAction });
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
