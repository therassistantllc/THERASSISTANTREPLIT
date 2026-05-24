/**
 * POST /api/billing/paper-checks/[id]/actions
 *
 * Run a lifecycle action against a paper check.
 *
 * Actions:
 *   - upload_eob          { paper_eob_url, scanned_check_url? }
 *   - mark_deposited      { deposit_date?, deposit_notes? }
 *   - post_payment        { note? }       → status='posted' (claims must be matched)
 *   - match_claims        { claim_ids: string[], applied_amounts?: number[] }
 *   - resolve_mismatch    { resolution: 'returned'|'void'|'unmatched', note? }
 *
 * Every action writes a paper_check_events audit row and returns the
 * updated check row + matches so the client can patch the table in place.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }
    const { id: checkId } = await ctx.params;
    if (!checkId) {
      return NextResponse.json({ success: false, error: "Missing check id" }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const guard = await requireBillingAccess({
      requestedOrganizationId:
        typeof body.organizationId === "string" ? body.organizationId : null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    // Confirm the check belongs to this org.
    const { data: existing, error: getErr } = await (supabase as any)
      .from("paper_checks")
      .select("id, organization_id, posting_status, amount")
      .eq("id", checkId)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .maybeSingle();
    if (getErr) throw getErr;
    if (!existing) {
      return NextResponse.json({ success: false, error: "Paper check not found" }, { status: 404 });
    }

    const action = text(body.action);
    if (!action) {
      return NextResponse.json({ success: false, error: "Missing action" }, { status: 400 });
    }
    const today = new Date().toISOString().slice(0, 10);
    let patch: Record<string, unknown> = {};
    let eventMessage = "";
    const eventPayload: Record<string, unknown> = {};

    switch (action) {
      case "upload_eob": {
        const eobUrl = typeof body.paper_eob_url === "string" ? body.paper_eob_url.trim() : "";
        const scanUrl =
          typeof body.scanned_check_url === "string" ? body.scanned_check_url.trim() : "";
        if (!eobUrl && !scanUrl) {
          return NextResponse.json(
            { success: false, error: "Provide a paper EOB or scanned check URL" },
            { status: 400 },
          );
        }
        if (eobUrl) patch.paper_eob_url = eobUrl;
        if (scanUrl) patch.scanned_check_url = scanUrl;
        eventMessage = eobUrl ? "Paper EOB uploaded" : "Scanned check uploaded";
        eventPayload.paper_eob_url = eobUrl || undefined;
        eventPayload.scanned_check_url = scanUrl || undefined;
        break;
      }
      case "mark_deposited": {
        const depositDate =
          typeof body.deposit_date === "string" && body.deposit_date
            ? body.deposit_date
            : today;
        patch = {
          deposit_date: depositDate,
          posting_status: existing.posting_status === "posted" ? "posted" : "deposited",
        };
        if (typeof body.deposit_notes === "string" && body.deposit_notes.trim()) {
          patch.deposit_notes = body.deposit_notes.trim();
        }
        eventMessage = `Marked deposited on ${depositDate}`;
        eventPayload.deposit_date = depositDate;
        break;
      }
      case "post_payment": {
        // Require at least one match before posting.
        const { count, error: cntErr } = await (supabase as any)
          .from("paper_check_claim_matches")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .eq("paper_check_id", checkId);
        if (cntErr) throw cntErr;
        if ((count ?? 0) === 0) {
          return NextResponse.json(
            { success: false, error: "Match at least one claim before posting" },
            { status: 400 },
          );
        }
        patch = { posting_status: "posted" };
        eventMessage = "Payment posted";
        if (typeof body.note === "string" && body.note.trim()) {
          eventPayload.note = body.note.trim();
        }
        break;
      }
      case "match_claims": {
        const claimIds = Array.isArray(body.claim_ids)
          ? (body.claim_ids as unknown[]).map(text).filter(Boolean)
          : [];
        if (claimIds.length === 0) {
          return NextResponse.json(
            { success: false, error: "Provide at least one claim id" },
            { status: 400 },
          );
        }
        const amounts = Array.isArray(body.applied_amounts)
          ? (body.applied_amounts as unknown[]).map(money)
          : [];

        // Confirm claims belong to org.
        const { data: claimCheck, error: ccErr } = await (supabase as any)
          .from("professional_claims")
          .select("id")
          .eq("organization_id", organizationId)
          .in("id", claimIds);
        if (ccErr) throw ccErr;
        const validIds = new Set(((claimCheck ?? []) as DbRow[]).map((c) => text(c.id)));
        const rows = claimIds
          .filter((id) => validIds.has(id))
          .map((id, idx) => ({
            organization_id: organizationId,
            paper_check_id: checkId,
            claim_id: id,
            applied_amount: amounts[idx] ?? 0,
            matched_by_user_id: guard.userId,
          }));
        if (rows.length === 0) {
          return NextResponse.json(
            { success: false, error: "No valid claims to match" },
            { status: 400 },
          );
        }
        const { error: insErr } = await (supabase as any)
          .from("paper_check_claim_matches")
          .upsert(rows, { onConflict: "paper_check_id,claim_id" });
        if (insErr) throw insErr;
        // If the check was unmatched, move it to deposited (or keep posted).
        if (existing.posting_status === "unmatched") {
          patch = { posting_status: existing.posting_status === "posted" ? "posted" : "deposited" };
        }
        eventMessage = `Matched ${rows.length} claim(s)`;
        eventPayload.claim_ids = rows.map((r) => r.claim_id);
        break;
      }
      case "resolve_mismatch": {
        const resolution = text(body.resolution);
        if (!["returned", "void", "unmatched"].includes(resolution)) {
          return NextResponse.json(
            { success: false, error: "Invalid resolution" },
            { status: 400 },
          );
        }
        patch = { posting_status: resolution };
        eventMessage = `Marked ${resolution}`;
        if (typeof body.note === "string" && body.note.trim()) {
          eventPayload.note = body.note.trim();
        }
        break;
      }
      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }

    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      const { error: updErr } = await (supabase as any)
        .from("paper_checks")
        .update(patch)
        .eq("id", checkId)
        .eq("organization_id", organizationId);
      if (updErr) throw updErr;
    }

    await (supabase as any).from("paper_check_events").insert({
      organization_id: organizationId,
      paper_check_id: checkId,
      event_type: action,
      message: eventMessage,
      actor_user_id: guard.userId,
      payload: Object.keys(eventPayload).length ? eventPayload : null,
    });

    // Return the updated check + matches so the client can patch in place.
    const [{ data: updated }, { data: matches }] = await Promise.all([
      (supabase as any)
        .from("paper_checks")
        .select(
          "id, posting_status, deposit_date, deposit_notes, paper_eob_url, scanned_check_url, updated_at",
        )
        .eq("id", checkId)
        .eq("organization_id", organizationId)
        .single(),
      (supabase as any)
        .from("paper_check_claim_matches")
        .select("paper_check_id, claim_id, applied_amount")
        .eq("organization_id", organizationId)
        .eq("paper_check_id", checkId),
    ]);

    return NextResponse.json({ success: true, check: updated, matches: matches ?? [] });
  } catch (error) {
    console.error("Paper checks action error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Action failed",
      },
      { status: 500 },
    );
  }
}
