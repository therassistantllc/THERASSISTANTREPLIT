/**
 * /api/billing/appeals/action
 *
 * POST — execute a row / detail-panel action on the Appeals Needed
 * workqueue. Every action upserts the latest public.claim_appeals row
 * for the claim and writes a public.claim_notes entry so the timeline
 * stays auditable.
 *
 * Actions:
 *   generate         : create / overwrite the draft appeal letter
 *                      (status → 'draft_ready')
 *   attach_documents : bump attachments_count (records the intent —
 *                      real upload pipeline lives in the docs panel)
 *   submit           : mark the appeal sent (status → 'sent',
 *                      submitted_at = now) and optionally queue a fax
 *   track            : flip status → 'pending' (waiting on payer)
 *   escalate_doi     : status → 'escalated_doi', bump level
 *   mark_resolved    : status → 'won' | 'lost' with optional note
 *   assign           : assign the appeal to a staff user
 *   set_deadline     : set / clear the appeal deadline
 *   note             : add a free-text claim note (no status change)
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, any>;

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const ACTIONS = [
  "generate",
  "attach_documents",
  "submit",
  "track",
  "escalate_doi",
  "mark_resolved",
  "assign",
  "set_deadline",
  "note",
] as const;
type ActionName = (typeof ACTIONS)[number];

async function addClaimNote(
  supabase: any,
  params: {
    organizationId: string;
    claimId: string;
    body: string;
    userId: string | null;
    authorDisplayName: string | null;
  },
) {
  const body = params.body.trim();
  if (!body) return;
  const { error } = await supabase.from("claim_notes").insert({
    organization_id: params.organizationId,
    claim_id: params.claimId,
    body,
    author_user_id: params.userId,
    author_display_name: params.authorDisplayName,
  });
  if (error) throw new Error(error.message);
}

async function loadOrCreateAppeal(
  supabase: any,
  params: {
    organizationId: string;
    claimId: string;
    seedStatus: string;
  },
): Promise<DbRow> {
  // Latest existing appeal for this claim
  const { data, error } = await supabase
    .from("claim_appeals")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("claim_id", params.claimId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const existing = (data as DbRow[])?.[0];
  if (existing) return existing;

  // Pull denial reason / amount snapshot from the claim
  const { data: claim, error: claimErr } = await supabase
    .from("professional_claims")
    .select("id, total_charge, write_off_amount")
    .eq("organization_id", params.organizationId)
    .eq("id", params.claimId)
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claim) throw new Error("Claim not found");
  const denied = money((claim as DbRow).total_charge) - money((claim as DbRow).write_off_amount);

  const { data: created, error: insertErr } = await supabase
    .from("claim_appeals")
    .insert({
      organization_id: params.organizationId,
      claim_id: params.claimId,
      status: params.seedStatus,
      level: 1,
      denied_amount: Math.max(0, Math.round(denied * 100) / 100),
    })
    .select("*")
    .single();
  if (insertErr) throw new Error(insertErr.message);
  return created as DbRow;
}

function buildRowPatch(appeal: DbRow, extras: Partial<DbRow> = {}) {
  const STATUS_LABEL: Record<string, string> = {
    draft_needed: "Draft needed",
    draft_ready: "Draft ready",
    sent: "Sent",
    pending: "Pending decision",
    won: "Won",
    lost: "Lost",
    escalated_doi: "Escalated (DOI)",
  };
  const status = text(appeal.status);
  return {
    appealId: text(appeal.id),
    appealStatus: status,
    appealStatusLabel: STATUS_LABEL[status] ?? status,
    appealLevel: Number(appeal.level ?? 1),
    appealDeadline: text(appeal.deadline) || null,
    appealSubmittedAt: text(appeal.submitted_at) || null,
    appealDecision: text(appeal.decision) || null,
    appealDecisionAt: text(appeal.decision_at) || null,
    assignedToUserId: text(appeal.assigned_to_user_id) || null,
    letterBody: text(appeal.letter_body) || "",
    templateId: text(appeal.template_id) || null,
    attachmentsCount: Number(appeal.attachments_count ?? 0),
    ...extras,
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = text(body.action) as ActionName;
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return NextResponse.json(
        { success: false, error: `action must be one of: ${ACTIONS.join(", ")}` },
        { status: 400 },
      );
    }

    const claimId = text(body.claimId);
    if (!claimId) {
      return NextResponse.json(
        { success: false, error: "claimId is required" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const guard = await requireBillingAccess({
      requestedOrganizationId: text(body.organizationId) || null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const userId = (guard as any).userId ?? text(body.userId) ?? null;
    const authorDisplay = text(body.actorDisplayName) || null;
    const now = new Date().toISOString();

    // ── generate ────────────────────────────────────────────────────────────
    if (action === "generate") {
      const letter = text(body.letterBody);
      const templateId = text(body.templateId) || null;
      const deadline = text(body.deadline) || null;
      const denialReason = text(body.denialReason) || null;
      if (!letter) {
        return NextResponse.json(
          { success: false, error: "letterBody is required" },
          { status: 400 },
        );
      }
      const existing = await loadOrCreateAppeal(supabase as any, {
        organizationId,
        claimId,
        seedStatus: "draft_ready",
      });
      const { data: updated, error } = await (supabase as any)
        .from("claim_appeals")
        .update({
          letter_body: letter,
          template_id: templateId,
          deadline,
          denial_reason: denialReason ?? existing.denial_reason,
          status: ["won", "lost"].includes(text(existing.status)) ? "draft_ready" : "draft_ready",
          updated_at: now,
        })
        .eq("organization_id", organizationId)
        .eq("id", text(existing.id))
        .select("*")
        .single();
      if (error) throw error;
      await addClaimNote(supabase as any, {
        organizationId,
        claimId,
        body: "Appeal draft generated — status: draft_ready.",
        userId,
        authorDisplayName: authorDisplay,
      });
      return NextResponse.json({ success: true, patch: buildRowPatch(updated as DbRow) });
    }

    // ── attach_documents ───────────────────────────────────────────────────
    if (action === "attach_documents") {
      const delta = Math.max(1, Number(body.delta ?? 1) || 1);
      const note = text(body.note) || `Attached ${delta} document(s) to appeal packet.`;
      const existing = await loadOrCreateAppeal(supabase as any, {
        organizationId,
        claimId,
        seedStatus: "draft_ready",
      });
      const next = Number(existing.attachments_count ?? 0) + delta;
      const { data: updated, error } = await (supabase as any)
        .from("claim_appeals")
        .update({ attachments_count: next, updated_at: now })
        .eq("organization_id", organizationId)
        .eq("id", text(existing.id))
        .select("*")
        .single();
      if (error) throw error;
      await addClaimNote(supabase as any, {
        organizationId,
        claimId,
        body: note,
        userId,
        authorDisplayName: authorDisplay,
      });
      return NextResponse.json({ success: true, patch: buildRowPatch(updated as DbRow) });
    }

    // ── submit ─────────────────────────────────────────────────────────────
    if (action === "submit") {
      const existing = await loadOrCreateAppeal(supabase as any, {
        organizationId,
        claimId,
        seedStatus: "draft_ready",
      });
      if (!text(existing.letter_body)) {
        return NextResponse.json(
          { success: false, error: "Appeal letter is empty — generate it first." },
          { status: 400 },
        );
      }
      const { data: updated, error } = await (supabase as any)
        .from("claim_appeals")
        .update({
          status: "sent",
          submitted_at: now,
          updated_at: now,
        })
        .eq("organization_id", organizationId)
        .eq("id", text(existing.id))
        .select("*")
        .single();
      if (error) throw error;
      await addClaimNote(supabase as any, {
        organizationId,
        claimId,
        body: `Appeal submitted to payer (level ${Number(existing.level ?? 1)}).`,
        userId,
        authorDisplayName: authorDisplay,
      });
      return NextResponse.json({
        success: true,
        patch: buildRowPatch(updated as DbRow),
      });
    }

    // ── track ──────────────────────────────────────────────────────────────
    if (action === "track") {
      const existing = await loadOrCreateAppeal(supabase as any, {
        organizationId,
        claimId,
        seedStatus: "draft_ready",
      });
      const { data: updated, error } = await (supabase as any)
        .from("claim_appeals")
        .update({ status: "pending", updated_at: now })
        .eq("organization_id", organizationId)
        .eq("id", text(existing.id))
        .select("*")
        .single();
      if (error) throw error;
      await addClaimNote(supabase as any, {
        organizationId,
        claimId,
        body: "Appeal moved to pending — awaiting payer decision.",
        userId,
        authorDisplayName: authorDisplay,
      });
      return NextResponse.json({ success: true, patch: buildRowPatch(updated as DbRow) });
    }

    // ── escalate_doi ───────────────────────────────────────────────────────
    if (action === "escalate_doi") {
      const reason = text(body.note) || "Escalated to DOI / ombudsman.";
      const existing = await loadOrCreateAppeal(supabase as any, {
        organizationId,
        claimId,
        seedStatus: "draft_ready",
      });
      const nextLevel = Math.min(3, Number(existing.level ?? 1) + 1);
      const { data: updated, error } = await (supabase as any)
        .from("claim_appeals")
        .update({
          status: "escalated_doi",
          level: nextLevel,
          updated_at: now,
        })
        .eq("organization_id", organizationId)
        .eq("id", text(existing.id))
        .select("*")
        .single();
      if (error) throw error;
      await addClaimNote(supabase as any, {
        organizationId,
        claimId,
        body: reason,
        userId,
        authorDisplayName: authorDisplay,
      });
      return NextResponse.json({ success: true, patch: buildRowPatch(updated as DbRow) });
    }

    // ── mark_resolved ──────────────────────────────────────────────────────
    if (action === "mark_resolved") {
      const outcome = text(body.outcome);
      if (outcome !== "won" && outcome !== "lost") {
        return NextResponse.json(
          { success: false, error: "outcome must be 'won' or 'lost'" },
          { status: 400 },
        );
      }
      const existing = await loadOrCreateAppeal(supabase as any, {
        organizationId,
        claimId,
        seedStatus: "draft_ready",
      });
      const { data: updated, error } = await (supabase as any)
        .from("claim_appeals")
        .update({
          status: outcome,
          decision: text(body.note) || outcome,
          decision_at: now,
          updated_at: now,
        })
        .eq("organization_id", organizationId)
        .eq("id", text(existing.id))
        .select("*")
        .single();
      if (error) throw error;

      // If the appeal was WON, optimistically flip the claim out of 'denied'
      // (no payment posting here — that's the ERA flow's job).
      if (outcome === "won") {
        await (supabase as any)
          .from("professional_claims")
          .update({ claim_status: "appeal_won", updated_at: now })
          .eq("organization_id", organizationId)
          .eq("id", claimId);
      }

      await addClaimNote(supabase as any, {
        organizationId,
        claimId,
        body: `Appeal marked ${outcome}.${text(body.note) ? ` Note: ${text(body.note)}` : ""}`,
        userId,
        authorDisplayName: authorDisplay,
      });

      return NextResponse.json({
        success: true,
        patch: buildRowPatch(updated as DbRow, {
          claimStatus: outcome === "won" ? "appeal_won" : "denied",
        }),
        removeFromQueue: false,
      });
    }

    // ── assign ─────────────────────────────────────────────────────────────
    if (action === "assign") {
      const assigneeUserId = text(body.assignedToUserId) || null;
      const existing = await loadOrCreateAppeal(supabase as any, {
        organizationId,
        claimId,
        seedStatus: "draft_ready",
      });
      const { data: updated, error } = await (supabase as any)
        .from("claim_appeals")
        .update({ assigned_to_user_id: assigneeUserId, updated_at: now })
        .eq("organization_id", organizationId)
        .eq("id", text(existing.id))
        .select("*")
        .single();
      if (error) throw error;
      await addClaimNote(supabase as any, {
        organizationId,
        claimId,
        body: assigneeUserId
          ? `Appeal assigned to ${text(body.assigneeDisplayName) || assigneeUserId}.`
          : "Appeal unassigned.",
        userId,
        authorDisplayName: authorDisplay,
      });
      return NextResponse.json({
        success: true,
        patch: buildRowPatch(updated as DbRow, {
          assignedToDisplayName: text(body.assigneeDisplayName) || null,
        }),
      });
    }

    // ── set_deadline ───────────────────────────────────────────────────────
    if (action === "set_deadline") {
      const deadline = text(body.deadline) || null;
      const existing = await loadOrCreateAppeal(supabase as any, {
        organizationId,
        claimId,
        seedStatus: "draft_ready",
      });
      const { data: updated, error } = await (supabase as any)
        .from("claim_appeals")
        .update({ deadline, updated_at: now })
        .eq("organization_id", organizationId)
        .eq("id", text(existing.id))
        .select("*")
        .single();
      if (error) throw error;
      await addClaimNote(supabase as any, {
        organizationId,
        claimId,
        body: deadline
          ? `Appeal deadline set to ${deadline}.`
          : "Appeal deadline cleared.",
        userId,
        authorDisplayName: authorDisplay,
      });
      return NextResponse.json({ success: true, patch: buildRowPatch(updated as DbRow) });
    }

    // ── note ───────────────────────────────────────────────────────────────
    if (action === "note") {
      const noteBody = text(body.body);
      if (!noteBody) {
        return NextResponse.json(
          { success: false, error: "body is required" },
          { status: 400 },
        );
      }
      await addClaimNote(supabase as any, {
        organizationId,
        claimId,
        body: noteBody,
        userId,
        authorDisplayName: authorDisplay,
      });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: "Unhandled action" }, { status: 400 });
  } catch (error) {
    console.error("Appeals action error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Appeals action failed",
      },
      { status: 500 },
    );
  }
}
