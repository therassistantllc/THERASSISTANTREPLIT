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
import { commitPosting, type PostingActor } from "@/lib/payments/postingEngine";

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
      .select(
        "id, organization_id, posting_status, amount, payer_profile_id, check_number, check_date, paper_eob_url",
      )
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
        // Route every matched claim through the central posting engine so
        // paper-check posts produce the same downstream effects as ERA 835
        // and the standalone manual-EOB form: insurance_manual_payments +
        // era_posting_ledger_entries rows, professional_claims.claim_status
        // flip, patient_invoices for residual PR, and applyWorkqueueRules.
        const { data: matchRows, error: matchErr } = await (supabase as any)
          .from("paper_check_claim_matches")
          .select(
            "claim_id, applied_amount, adjustment_amount, patient_responsibility_amount",
          )
          .eq("organization_id", organizationId)
          .eq("paper_check_id", checkId);
        if (matchErr) throw matchErr;
        const matchList = (matchRows ?? []) as DbRow[];
        if (matchList.length === 0) {
          return NextResponse.json(
            { success: false, error: "Match at least one claim before posting" },
            { status: 400 },
          );
        }
        const noteText =
          typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

        // Hydrate claim → client_id so we can hand the engine a clientId
        // (insurance_manual_payments.client_id is NOT NULL).
        const claimIds = matchList.map((m) => text(m.claim_id));
        const { data: claimRows, error: claimErr } = await (supabase as any)
          .from("professional_claims")
          .select("id, patient_id")
          .eq("organization_id", organizationId)
          .in("id", claimIds);
        if (claimErr) throw claimErr;
        const clientByClaim = new Map<string, string | null>(
          ((claimRows ?? []) as DbRow[]).map((c) => [
            text(c.id),
            (c.patient_id as string | null) ?? null,
          ]),
        );

        // Up-front validation pass: every matched claim must belong to this
        // org, have a client linkage, and a positive applied_amount. Bail
        // before any engine call so we never half-post a check or mark it
        // "posted" with zero ledger impact.
        const missingClient = matchList
          .map((m) => text(m.claim_id))
          .filter((cid) => !clientByClaim.get(cid));
        if (missingClient.length > 0) {
          return NextResponse.json(
            {
              success: false,
              error: `Cannot post: claim(s) ${missingClient.join(", ")} have no client linkage.`,
            },
            { status: 400 },
          );
        }
        const nonPositive = matchList
          .filter((m) => money(m.applied_amount) <= 0)
          .map((m) => text(m.claim_id));
        if (nonPositive.length > 0) {
          return NextResponse.json(
            {
              success: false,
              error: `Cannot post: claim(s) ${nonPositive.join(", ")} have a zero or negative applied amount. Set a positive applied amount on each match before posting.`,
            },
            { status: 400 },
          );
        }

        // Idempotency: every manual-payment row we route through the engine
        // for this check is tagged with this deterministic marker. If a row
        // with this (org, eob_reference, claim_id) already exists, the
        // engine has already produced its ledger entries / claim-status
        // flip / client invoice for that (check, claim) — skip so a
        // re-press of "Post payment" doesn't double-post.
        const eobMarker = `paper_check:${checkId}`;
        const { data: alreadyPosted, error: dupErr } = await (supabase as any)
          .from("insurance_manual_payments")
          .select("claim_id")
          .eq("organization_id", organizationId)
          .eq("eob_reference", eobMarker)
          .is("archived_at", null);
        if (dupErr) throw dupErr;
        const postedClaimSet = new Set(
          ((alreadyPosted ?? []) as DbRow[]).map((r) => text(r.claim_id)),
        );

        const postingActor: PostingActor = {
          staffId: guard.staffId ?? null,
          userId: guard.userId ?? null,
          role: (guard.roles?.[0] as string | undefined) ?? null,
          source: "ui:paper-check-post",
        };

        const postedClaimIds: string[] = [];
        const skippedClaimIds: string[] = [];
        const failedClaimIds: string[] = [];
        const failureMessages: string[] = [];

        const invoicedClaimIds: string[] = [];

        for (const m of matchList) {
          const claimId = text(m.claim_id);
          const appliedAmount = money(m.applied_amount);
          const adjustmentAmount = money(m.adjustment_amount);
          const patientRespAmount = money(m.patient_responsibility_amount);

          if (postedClaimSet.has(claimId)) {
            skippedClaimIds.push(claimId);
            continue;
          }

          const result = await commitPosting({
            organizationId,
            actor: postingActor,
            source: {
              type: "manual_insurance",
              professionalClaimId: claimId,
              clientId: clientByClaim.get(claimId) ?? null,
              payerPaymentAmount: appliedAmount,
              patientResponsibilityAmount: patientRespAmount,
              contractualAdjustmentAmount: adjustmentAmount,
              // Billers split each matched line into Paid + Adj + PR at
              // match time. Hand all three to the engine so its balance
              // check (paid + adj + pr == charge) passes and the engine
              // can spawn the PR invoice for residual client
              // responsibility itself — same behaviour as the manual-EOB
              // posting form. The recognised charge is the sum so a
              // partial payment on a larger claim still balances.
              totalChargeAmount:
                appliedAmount + adjustmentAmount + patientRespAmount,
              checkOrEftNumber: (existing.check_number as string | null) ?? null,
              paymentDate: (existing.check_date as string | null) ?? today,
              eobReference: eobMarker,
              payerProfileId: (existing.payer_profile_id as string | null) ?? null,
              note: noteText,
            },
          });

          if (!result.ok) {
            failedClaimIds.push(claimId);
            failureMessages.push(
              ...result.errors.map((e) => `${claimId}: ${e.message}`),
            );
            continue;
          }
          // PR > 0 means the engine spawned a patient_invoices row for
          // this claim (manualInsurance posting path). Track it on the
          // audit event so billers can see which claims produced an
          // invoice.
          if (patientRespAmount > 0) {
            invoicedClaimIds.push(claimId);
          }
          postedClaimIds.push(claimId);
        }

        if (failedClaimIds.length > 0) {
          // Any engine failure aborts the "posted" flip so the biller can
          // fix the bad claim and retry. Already-successful claims stay
          // posted (their insurance_manual_payments row + eobMarker block
          // double-posts on the retry).
          return NextResponse.json(
            {
              success: false,
              error: `Failed to post claim(s) ${failedClaimIds.join(", ")}: ${failureMessages.join("; ")}`,
              posted_claim_ids: postedClaimIds,
              skipped_claim_ids: skippedClaimIds,
            },
            { status: 422 },
          );
        }

        patch = { posting_status: "posted" };
        const totalAffected = postedClaimIds.length;
        eventMessage =
          totalAffected > 0
            ? `Payment posted to ${totalAffected} claim(s)`
            : "Payment already posted (no new claims)";
        if (noteText) eventPayload.note = noteText;
        eventPayload.posted_claim_ids = postedClaimIds;
        if (skippedClaimIds.length > 0) {
          eventPayload.skipped_claim_ids = skippedClaimIds;
        }
        if (invoicedClaimIds.length > 0) {
          eventPayload.invoiced_claim_ids = invoicedClaimIds;
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
        const adjustments = Array.isArray(body.adjustment_amounts)
          ? (body.adjustment_amounts as unknown[]).map(money)
          : [];
        const patientResps = Array.isArray(body.patient_responsibility_amounts)
          ? (body.patient_responsibility_amounts as unknown[]).map(money)
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
          .map((id, idx) => {
            // Position-aligned: each claim id has matching applied/adj/PR
            // entries in the parallel arrays. Missing entries default to 0
            // so legacy callers (pre-split) keep working.
            const originalIdx = claimIds.indexOf(id);
            return {
              organization_id: organizationId,
              paper_check_id: checkId,
              claim_id: id,
              applied_amount: amounts[originalIdx] ?? 0,
              adjustment_amount: adjustments[originalIdx] ?? 0,
              patient_responsibility_amount: patientResps[originalIdx] ?? 0,
              matched_by_user_id: guard.userId,
            };
          });
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
        .select(
          "paper_check_id, claim_id, applied_amount, adjustment_amount, patient_responsibility_amount",
        )
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
