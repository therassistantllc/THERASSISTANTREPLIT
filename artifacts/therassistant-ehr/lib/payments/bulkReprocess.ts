/**
 * Bulk-reprocess core loop, extracted from
 * `app/api/billing/payments/bulk/reprocess/route.ts` so it can be
 * exercised end-to-end against a fake Supabase in tests (see
 * `lib/payments/__tests__/bulkReprocessStress.test.ts`).
 *
 * The route stays a thin wrapper: parse body → auth → call
 * `reprocessBulkTargets` with the real admin client and the real
 * `matchProfessionalClaim`. All behavioural logic lives here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyWorkqueueRules } from "./postingEngine/workqueueRules";
import { writePaymentAuditLog } from "./postingEngine/audit";
import type { PostingActor } from "./postingEngine";

type BulkReprocessTargetKind =
  | "era_835"
  | "insurance_manual"
  | "client_payment";

export interface BulkReprocessTarget {
  kind: BulkReprocessTargetKind;
  id: string;
}

interface BulkReprocessClaimMatch {
  id: string;
  patient_id: string | null;
}

export interface BulkReprocessDeps {
  /**
   * Injected so tests can stub out matching without touching the
   * production `matchProfessionalClaim` (which constructs its own
   * admin Supabase client and is therefore not test-friendly).
   */
  matchClaim: (
    organizationId: string,
    claimControlNumber: string,
  ) => Promise<BulkReprocessClaimMatch | null>;
}

/**
 * Bounded concurrency for the per-target pool. Tuned to ~8 because each
 * target does 2–4 sequential Supabase round-trips (~50–200ms each), so
 * 8-way fan-out keeps the connection pool comfortable while collapsing
 * 200 targets from ~10–40s of strict-serial wall time down to ~1–5s.
 */
const BULK_REPROCESS_CONCURRENCY = 8;

export interface BulkReprocessSummary {
  reprocessed: number;
  itemsCreated: number;
  /**
   * Per-target failures. Includes both the outer try/catch failures
   * (id = `${kind}:${id}`) AND the per-emission rule-engine failures
   * that `applyWorkqueueRules` collects into its own `result.errors`
   * (id = `${kind}:${id}:rule:${ruleKind}`). Without bubbling the
   * rule-engine errors up, a biller running bulk reprocess could see
   * "N reprocessed, 0 errors" while individual workqueue_items inserts
   * silently failed.
   */
  errors: Array<{ id: string; message: string }>;
}

function collectRuleErrors(
  summary: BulkReprocessSummary,
  kind: BulkReprocessTargetKind,
  targetId: string,
  ruleErrors: Array<{ rule: string; message: string }>,
) {
  for (const e of ruleErrors) {
    summary.errors.push({
      id: `${kind}:${targetId}:rule:${e.rule}`,
      message: e.message,
    });
  }
}

export async function reprocessBulkTargets(args: {
  supabase: SupabaseClient;
  organizationId: string;
  actor: PostingActor;
  targets: BulkReprocessTarget[];
  deps: BulkReprocessDeps;
}): Promise<BulkReprocessSummary> {
  const { supabase, organizationId, actor, targets, deps } = args;
  const summary: BulkReprocessSummary = {
    reprocessed: 0,
    itemsCreated: 0,
    errors: [],
  };

  const processOne = async (t: BulkReprocessTarget): Promise<void> => {
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
        if (!data) return;
        const row = data as Record<string, unknown>;

        let claimMatchStatus = (row.claim_match_status as string | null) ?? null;
        let professionalClaimId = (row.professional_claim_id as string | null) ?? null;
        let clientId = (row.client_id as string | null) ?? null;
        if (claimMatchStatus !== "matched") {
          const ccn = (row.clp01_claim_control_number as string | null) ?? null;
          if (ccn) {
            try {
              const match = await deps.matchClaim(organizationId, ccn);
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
              // best-effort
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
        const adj = cas
          .filter(
            (c) =>
              ((c.groupCode ?? c.group_code ?? "").toString().toUpperCase()) === "CO",
          )
          .reduce((s, c) => s + Number(c.amount ?? 0), 0);
        let postedPayerProfileId: string | null = null;
        if (professionalClaimId) {
          try {
            const { data: claim } = await supabase
              .from("professional_claims")
              .select("payer_profile_id")
              .eq("id", professionalClaimId)
              .eq("organization_id", organizationId)
              .maybeSingle();
            postedPayerProfileId =
              (claim as { payer_profile_id: string | null } | null)?.payer_profile_id ?? null;
          } catch {
            // best-effort
          }
        }
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
          postedPayerProfileId,
          actor,
        });
        summary.reprocessed++;
        summary.itemsCreated += r.itemsCreated;
        collectRuleErrors(summary, t.kind, t.id, r.errors);
        await writePaymentAuditLog(supabase, {
          organizationId,
          actor,
          action: "payment_adjusted",
          objectType: "era_claim_payment",
          objectId: t.id,
          claimId: professionalClaimId,
          afterValue: {
            claim_match_status: claimMatchStatus,
            workqueue_items_created: r.itemsCreated,
          },
          summary: `Bulk reprocess (ERA): ${r.itemsCreated} workqueue item(s) emitted`,
          metadata: { source: "bulk_reprocess" },
        });
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
        if (!data) return;
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
        collectRuleErrors(summary, t.kind, t.id, r.errors);
        await writePaymentAuditLog(supabase, {
          organizationId,
          actor,
          action: "payment_adjusted",
          objectType: "insurance_manual_payment",
          objectId: t.id,
          claimId: (row.claim_id as string | null) ?? null,
          afterValue: { workqueue_items_created: r.itemsCreated },
          summary: `Bulk reprocess (manual): ${r.itemsCreated} workqueue item(s) emitted`,
          metadata: { source: "bulk_reprocess" },
        });
      }
      // client_payment kind: not eligible for reprocess (no underpayment /
      // denial signal). Silently skipped — matches prior route behaviour.
    } catch (err) {
      summary.errors.push({
        id: `${t.kind}:${t.id}`,
        message: err instanceof Error ? err.message : "reprocess failed",
      });
    }
  };

  // Bounded-concurrency pool: N workers pull from a shared cursor so a
  // slow target only blocks its own slot, not the whole batch. Workers
  // never throw (processOne already records its own errors into
  // summary.errors), so Promise.all here only awaits completion.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const i = cursor++;
      await processOne(targets[i]);
    }
  };
  const poolSize = Math.min(BULK_REPROCESS_CONCURRENCY, targets.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return summary;
}
