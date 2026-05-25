/**
 * POST /api/billing/duplicate-claim-review/[claimId]
 *
 * Action endpoint for the Duplicate Claim Review workqueue. The body shape
 * is { organizationId, action, otherClaimId?, reason? } where action is one of:
 *
 *   submit_anyway     — set claim_status='ready_for_batch' + audit + reason note
 *   void_duplicate    — set claim_status='voided' + archived_at=now() + audit
 *   merge             — archive the *current* claim, leaving the original
 *                       intact; logs a reconciliation note on both sides
 *   hold              — defer the claim 30 days + add a hold note
 *   mark_not_duplicate — drop the pair from the worklist (claim_note marker)
 *
 * Every action writes an audit_logs entry tagged with object_type='claim'.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

type Action =
  | "submit_anyway"
  | "void_duplicate"
  | "merge"
  | "hold"
  | "mark_not_duplicate";

const VALID_ACTIONS: Action[] = [
  "submit_anyway",
  "void_duplicate",
  "merge",
  "hold",
  "mark_not_duplicate",
];

const text = (v: unknown) => String(v ?? "").trim();

interface Body {
  organizationId?: string;
  action?: Action;
  otherClaimId?: string;
  reason?: string;
}

async function loadClaim(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  organizationId: string,
  claimId: string,
) {
  if (!supabase) return null;
  const { data } = await (supabase as any)
    .from("professional_claims")
    .select("id, organization_id, claim_status, archived_at, patient_id")
    .eq("id", claimId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data;
}

async function resolveAuthorName(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  staffId: string | null,
) {
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

async function writeNote(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  args: {
    organizationId: string;
    claimId: string;
    authorUserId: string | null;
    authorDisplayName: string;
    body: string;
  },
) {
  if (!supabase) return null;
  return insertClaimNote(supabase as any, {
    organizationId: args.organizationId,
    claimId: args.claimId,
    authorUserId: args.authorUserId,
    authorDisplayName: args.authorDisplayName,
    body: args.body,
    returning: "id",
  });
}

async function writeAudit(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  args: {
    organizationId: string;
    claimId: string;
    patientId: string | null;
    action: string;
    summary: string;
    metadata: Record<string, unknown>;
    userId: string | null;
    userRole: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
) {
  if (!supabase) return;
  await (supabase as any).from("audit_logs").insert({
    organization_id: args.organizationId,
    claim_id: args.claimId,
    patient_id: args.patientId,
    object_type: "claim",
    object_id: args.claimId,
    action: args.action,
    event_type: "duplicate_review_action",
    event_summary: args.summary,
    event_metadata: args.metadata,
    user_id: args.userId,
    user_role: args.userRole,
    before_value: args.before ?? null,
    after_value: args.after ?? null,
  });
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

    const action = body.action;
    if (!action || !VALID_ACTIONS.includes(action)) {
      return NextResponse.json(
        { success: false, error: `action must be one of ${VALID_ACTIONS.join(", ")}` },
        { status: 400 },
      );
    }

    const otherClaimId = body.otherClaimId ? text(body.otherClaimId) : null;
    const reason = text(body.reason).slice(0, 500) || null;

    if ((action === "submit_anyway" || action === "mark_not_duplicate") && !reason) {
      return NextResponse.json(
        { success: false, error: "A reason is required for this action" },
        { status: 400 },
      );
    }
    if ((action === "merge" || action === "mark_not_duplicate") && !otherClaimId) {
      return NextResponse.json(
        { success: false, error: "otherClaimId is required for this action" },
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

    const claim = await loadClaim(supabase, organizationId, claimId);
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const authorName = await resolveAuthorName(supabase, guard.staffId ?? null);
    const nowIso = new Date().toISOString();

    let updatePatch: Record<string, unknown> | null = null;
    let noteBody = "";
    let summary = "";

    switch (action) {
      case "submit_anyway": {
        updatePatch = { claim_status: "ready_for_batch", updated_at: nowIso };
        // Marker the list endpoint suppresses on subsequent loads so the
        // pair doesn't reappear after the user submits with override.
        noteBody = otherClaimId
          ? `DUP_OVERRIDE:${otherClaimId} — submit anyway: ${reason}`
          : `DUP_OVERRIDE submit-anyway: ${reason}`;
        summary = `Duplicate review: submitted anyway. ${reason ?? ""}`;
        break;
      }
      case "void_duplicate": {
        updatePatch = {
          claim_status: "voided",
          archived_at: nowIso,
          updated_at: nowIso,
        };
        noteBody = `DUP_VOID: ${reason ?? "Voided as duplicate"}${
          otherClaimId ? ` (kept original ${otherClaimId})` : ""
        }`;
        summary = "Duplicate review: claim voided as duplicate";
        break;
      }
      case "merge": {
        updatePatch = {
          claim_status: "voided",
          archived_at: nowIso,
          updated_at: nowIso,
        };
        noteBody = `DUP_MERGE: Reconciled into claim ${otherClaimId}. ${reason ?? ""}`.trim();
        summary = `Duplicate review: merged into claim ${otherClaimId}`;
        break;
      }
      case "hold": {
        const holdUntil = new Date(Date.now() + 30 * 24 * 3600 * 1000)
          .toISOString()
          .slice(0, 10);
        // professional_claims has no defer_until column, so the hold marker
        // lives in claim_notes + audit_logs. The list endpoint suppresses
        // pairs with a DUP_HOLD:<otherId>:<untilISO> marker until the date
        // has passed, so the row stays out of the queue for the hold window.
        updatePatch = { updated_at: nowIso };
        noteBody = otherClaimId
          ? `DUP_HOLD:${otherClaimId}:${holdUntil} — ${reason ?? "Pending biller review"}`
          : `DUP_HOLD until ${holdUntil}: ${reason ?? "Pending biller review"}`;
        summary = `Duplicate review: held until ${holdUntil}`;
        break;
      }
      case "mark_not_duplicate": {
        // Persist a dismissal marker the list endpoint reads on both sides.
        noteBody = `DUP_DISMISS:${otherClaimId} — ${reason}`;
        summary = `Duplicate review: marked not a duplicate of ${otherClaimId}`;
        break;
      }
    }

    if (updatePatch) {
      const before = { claim_status: claim.claim_status, archived_at: claim.archived_at };
      const { error: updErr } = await (supabase as any)
        .from("professional_claims")
        .update(updatePatch)
        .eq("id", claimId)
        .eq("organization_id", organizationId);
      if (updErr) {
        return NextResponse.json(
          { success: false, error: updErr.message },
          { status: 422 },
        );
      }
      await writeAudit(supabase, {
        organizationId,
        claimId,
        patientId: text(claim.patient_id) || null,
        action,
        summary,
        metadata: {
          otherClaimId,
          reason,
          patch: updatePatch,
        },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
        before,
        after: updatePatch,
      });
    } else {
      await writeAudit(supabase, {
        organizationId,
        claimId,
        patientId: text(claim.patient_id) || null,
        action,
        summary,
        metadata: { otherClaimId, reason },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
      });
    }

    if (noteBody) {
      const result = await writeNote(supabase, {
        organizationId,
        claimId,
        authorUserId: guard.userId ?? null,
        authorDisplayName: authorName,
        body: noteBody,
      });
      if (result && (result as any).error) {
        // Don't fail the action on note failure — note is best-effort log.
        console.warn("Duplicate review note insert failed", (result as any).error);
      }
    }

    // For merge: also append a "merged-into" marker on the surviving claim
    // so its audit trail shows the reconciliation from both sides.
    if (action === "merge" && otherClaimId) {
      const survivor = await loadClaim(supabase, organizationId, otherClaimId);
      if (survivor) {
        await writeNote(supabase, {
          organizationId,
          claimId: otherClaimId,
          authorUserId: guard.userId ?? null,
          authorDisplayName: authorName,
          body: `DUP_MERGE_INTO: Absorbed duplicate claim ${claimId}. ${reason ?? ""}`.trim(),
        });
        await writeAudit(supabase, {
          organizationId,
          claimId: otherClaimId,
          patientId: text(survivor.patient_id) || null,
          action: "merge_absorbed",
          summary: `Duplicate review: absorbed claim ${claimId}`,
          metadata: { mergedFromClaimId: claimId, reason },
          userId: guard.userId ?? null,
          userRole: guard.roles?.[0] ?? null,
        });
      }
    }

    return NextResponse.json({ success: true, action, claimId, otherClaimId });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Action failed" },
      { status: 500 },
    );
  }
}
