/**
 * POST /api/billing/claims/[claimId]/uncollectible
 *
 * Marks a claim uncollectible with a structured reason. Used by the
 * Timely Filing Risk queue when the filing window has closed and the
 * balance can no longer be collected. Writes an audit note.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const text = (v: unknown) => String(v ?? "").trim();

const ALLOWED_REASONS = new Set([
  "timely_filing_expired",
  "no_authorization",
  "bad_debt",
  "patient_deceased",
  "other",
]);

interface Body {
  organizationId?: string;
  reason?: string;
  comment?: string;
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

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const reason = text(body.reason) || "timely_filing_expired";
    if (!ALLOWED_REASONS.has(reason)) {
      return NextResponse.json(
        { success: false, error: "Invalid reason" },
        { status: 400 },
      );
    }
    const comment = text(body.comment);

    const { data: claim } = await (supabase as any)
      .from("professional_claims")
      .select("id, total_charge")
      .eq("id", claimId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const nowIso = new Date().toISOString();
    const writeOffReason =
      reason === "timely_filing_expired" ? "timely_filing" : reason;

    const { error: updateErr } = await (supabase as any)
      .from("professional_claims")
      .update({
        claim_status: "uncollectible",
        write_off_amount: Number(claim.total_charge) || 0,
        write_off_reason: writeOffReason,
        write_off_comment: comment || null,
        write_off_at: nowIso,
        write_off_by_user_id: guard.userId ?? null,
        updated_at: nowIso,
      })
      .eq("id", claimId)
      .eq("organization_id", organizationId);

    if (updateErr) {
      // Fall back: many orgs don't have write_off_* columns. Just stamp status.
      await (supabase as any)
        .from("professional_claims")
        .update({ claim_status: "uncollectible", updated_at: nowIso })
        .eq("id", claimId)
        .eq("organization_id", organizationId);
    }

    // Archive any open workqueue items for this claim
    await (supabase as any)
      .from("claim_workqueue_items")
      .update({
        archived_at: nowIso,
        resolved_at: nowIso,
        resolved_by_user_id: guard.userId ?? null,
        action_taken: `Marked uncollectible (${reason})`,
        updated_at: nowIso,
      })
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .is("archived_at", null);

    await insertClaimNote(supabase as any, {
      organizationId,
      claimId,
      authorUserId: guard.userId ?? null,
      authorDisplayName: "Timely Filing workqueue",
      body: `[System] Marked uncollectible — reason: ${reason}${
        comment ? ` — ${comment}` : ""
      }`,
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
