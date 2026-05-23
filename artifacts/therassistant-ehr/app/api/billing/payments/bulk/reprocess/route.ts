/**
 * POST /api/billing/payments/bulk/reprocess
 * Body: { organizationId, ids: string[] }
 *
 * Re-runs the PP-1 intake/matching path for each selected payment:
 *   1. For unmatched ERA rows, re-attempt claim matching against
 *      professional_claims by clp01_claim_control_number / patient_account.
 *      If a match is found, write it back to era_claim_payments.
 *   2. Re-run the PP-5 workqueue rule engine so any rule changes (new
 *      thresholds, new rules, etc.) take effect against the now-current
 *      row state. The ledger itself is idempotent and is NOT re-written —
 *      reprocess is a re-evaluation, not a re-post.
 *
 * Only era_claim_payments and insurance_manual_payments are eligible
 * (patient_payments don't have the underpayment/denial signal).
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireAuthenticatedPaymentPoster } from "@/lib/payments/postingEngine";
import { applyWorkqueueRules } from "@/lib/payments/postingEngine/workqueueRules";
import { matchProfessionalClaim } from "@/lib/payments/era835IntakeService";
import { parseTargets } from "../_shared";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const organizationId = String((body as { organizationId?: string }).organizationId ?? "");
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }
  const { targets, errors: parseErrors } = parseTargets((body as { ids?: unknown }).ids);
  if (targets.length === 0) {
    return NextResponse.json({ error: "No valid targets", parseErrors }, { status: 400 });
  }

  let actor;
  try {
    actor = await requireAuthenticatedPaymentPoster(organizationId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Forbidden" },
      { status: 403 },
    );
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const summary = {
    reprocessed: 0,
    itemsCreated: 0,
    errors: [] as Array<{ id: string; message: string }>,
  };

  for (const t of targets) {
    try {
      if (t.kind === "era_835") {
        const { data } = await supabase
          .from("era_claim_payments")
          .select(
            "id, professional_claim_id, client_id, claim_match_status, clp01_claim_control_number, clp03_total_charge, clp04_payment_amount, cas_adjustments",
          )
          .eq("organization_id", organizationId)
          .eq("id", t.id)
          .is("archived_at", null)
          .maybeSingle();
        if (!data) continue;
        const row = data as Record<string, unknown>;

        // PP-1 intake step: if the row is unmatched, re-run the same
        // claim matcher used by the live ERA intake path. If a match
        // is now found (e.g. the claim was created after intake), write
        // it back so downstream rules + the dashboard reflect reality.
        let claimMatchStatus = (row.claim_match_status as string | null) ?? null;
        let professionalClaimId = (row.professional_claim_id as string | null) ?? null;
        let clientId = (row.client_id as string | null) ?? null;
        if (claimMatchStatus !== "matched") {
          const ccn = (row.clp01_claim_control_number as string | null) ?? null;
          if (ccn) {
            try {
              const match = await matchProfessionalClaim(organizationId, ccn);
              if (match) {
                await supabase
                  .from("era_claim_payments")
                  .update({
                    professional_claim_id: match.id,
                    client_id: match.patient_id,
                    claim_match_status: "matched",
                    posting_status: "ready",
                  })
                  .eq("organization_id", organizationId)
                  .eq("id", t.id);
                claimMatchStatus = "matched";
                professionalClaimId = match.id;
                clientId = match.patient_id ?? clientId;
              }
            } catch {
              // Match attempt is best-effort; fall through to rule re-eval.
            }
          }
        }
        const cas =
          (row.cas_adjustments as Array<{
            amount?: number;
            groupCode?: string;
            group_code?: string;
          }> | null) ?? [];
        const totalCharge = Number(row.clp03_total_charge ?? 0);
        // Match the live commit path (sumContractualAdjustments in
        // postingEngine/index.ts): only CO-group CAS rows count toward the
        // contractual write-off used for the allowed-amount derivation.
        // Otherwise underpayment outcomes drift between post and reprocess.
        const adj = cas
          .filter(
            (c) =>
              ((c.groupCode ?? c.group_code ?? "").toString().toUpperCase()) === "CO",
          )
          .reduce((s, c) => s + Number(c.amount ?? 0), 0);
        const r = await applyWorkqueueRules(supabase, {
          organizationId,
          sourceObjectType: "era_claim_payment",
          sourceObjectId: t.id,
          professionalClaimId,
          clientId,
          insurancePaymentAmount: Number(row.clp04_payment_amount ?? 0),
          allowedAmount: totalCharge > 0 ? totalCharge - adj : null,
          totalChargeAmount: totalCharge,
          casAdjustments: cas as never,
          claimMatchStatus,
          sourceKind: "era_835",
          actor,
        });
        summary.reprocessed++;
        summary.itemsCreated += r.itemsCreated;
      } else if (t.kind === "insurance_manual") {
        const { data } = await supabase
          .from("insurance_manual_payments")
          .select(
            "id, claim_id, client_id, paid_amount, allowed_amount, adjustment_amount, payer_profile_id",
          )
          .eq("organization_id", organizationId)
          .eq("id", t.id)
          .is("archived_at", null)
          .maybeSingle();
        if (!data) continue;
        const row = data as Record<string, unknown>;
        const allowed = Number(row.allowed_amount ?? 0);
        const r = await applyWorkqueueRules(supabase, {
          organizationId,
          sourceObjectType: "insurance_manual_payment",
          sourceObjectId: t.id,
          professionalClaimId: (row.claim_id as string | null) ?? null,
          clientId: (row.client_id as string | null) ?? null,
          insurancePaymentAmount: Number(row.paid_amount ?? 0),
          allowedAmount: allowed > 0 ? allowed : null,
          totalChargeAmount: null,
          casAdjustments: null,
          sourceKind: "manual_insurance",
          postedPayerProfileId: (row.payer_profile_id as string | null) ?? null,
          actor,
        });
        summary.reprocessed++;
        summary.itemsCreated += r.itemsCreated;
      }
    } catch (err) {
      summary.errors.push({
        id: `${t.kind}:${t.id}`,
        message: err instanceof Error ? err.message : "reprocess failed",
      });
    }
  }

  return NextResponse.json({ ok: summary.errors.length === 0, parseErrors, ...summary });
}
