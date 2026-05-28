/**
 * Suggestion Engine — Task #108.
 *
 * Given an ERA claim payment row, produce a list of UI suggestions the biller
 * can apply with one click (or that auto-apply when unambiguous).
 *
 * Categories produced:
 *   - deductible / coinsurance / copay  (CARC 1 / 2 / 3 under PR)
 *   - contractual                       (CARC 45 under CO; large CO totals)
 *   - denial                            (zero paid, nonzero CAS, no PR)
 *   - reversal                          (group CR)
 *   - capitation                        (CARC 24)
 *   - sequestration                     (CARC 253)
 *   - cob_issue                         (CARC 22 / 23)
 *   - duplicate_payment                 (PCN already posted on another claim)
 *   - recoupment                        (negative payment + WO reference)
 *   - refund                            (negative payment with refund flag)
 *
 * Pure function (no DB) for the rule-based suggestions; DB-driven duplicate
 * detection lives in `detectDuplicatePostingSuggestion`.
 */

type SuggestionCategory =
  | "deductible"
  | "coinsurance"
  | "copay"
  | "contractual"
  | "denial"
  | "reversal"
  | "capitation"
  | "sequestration"
  | "cob_issue"
  | "duplicate_payment"
  | "recoupment"
  | "refund"
  | "interest"
  | "incentive";

type SuggestionAction = "auto_apply" | "review" | "block_until_acknowledged";

interface CasAdjustmentShape {
  groupCode?: string | null;
  reasonCode?: string | null;
  amount?: number | null;
  group_code?: string | null;
  reason_code?: string | null;
}

export interface SuggestionInput {
  clp02ClaimStatusCode: string | null;
  clp03TotalCharge: number;
  clp04PaymentAmount: number;
  clp05PatientResponsibility: number;
  casAdjustments: CasAdjustmentShape[];
}

export interface PostingSuggestion {
  category: SuggestionCategory;
  action: SuggestionAction;
  /** Confidence [0,1]. `auto_apply` only when ≥0.9 and no conflict. */
  confidence: number;
  /** Suggested target field on the posting row. */
  field: string;
  /** Suggested value to populate (numeric or text). */
  suggestedValue: number | string | null;
  /** Human description shown next to the suggestion. */
  reason: string;
  /** Conflicting field or signal (set when action='review'). */
  conflict: string | null;
  /** Raw CAS row(s) the suggestion derives from, for traceability. */
  sourceCas: Array<{ groupCode: string; reasonCode: string; amount: number }>;
}

function casGroup(adj: CasAdjustmentShape): string {
  return (adj.groupCode ?? adj.group_code ?? "").toString().toUpperCase();
}
function casReason(adj: CasAdjustmentShape): string {
  return (adj.reasonCode ?? adj.reason_code ?? "").toString();
}
function casAmount(adj: CasAdjustmentShape): number {
  const n = Number(adj.amount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function findCas(adjs: CasAdjustmentShape[], group: string, reason: string) {
  return adjs.find(
    (a) => casGroup(a) === group && casReason(a) === reason && casAmount(a) > 0,
  );
}

function sumCas(adjs: CasAdjustmentShape[], group?: string) {
  return adjs
    .filter((a) => !group || casGroup(a) === group)
    .reduce((s, a) => s + casAmount(a), 0);
}

export function generatePostingSuggestions(input: SuggestionInput): PostingSuggestion[] {
  const suggestions: PostingSuggestion[] = [];
  const adjs = input.casAdjustments ?? [];

  // ── PR-1 Deductible ──────────────────────────────────────────────────────
  const pr1 = findCas(adjs, "PR", "1");
  if (pr1) {
    suggestions.push({
      category: "deductible",
      action: "auto_apply",
      confidence: 0.95,
      field: "deductible",
      suggestedValue: casAmount(pr1),
      reason: `CAS PR-1 ${casAmount(pr1).toFixed(2)} → client deductible`,
      conflict: null,
      sourceCas: [{ groupCode: "PR", reasonCode: "1", amount: casAmount(pr1) }],
    });
  }

  // ── PR-2 Coinsurance ─────────────────────────────────────────────────────
  const pr2 = findCas(adjs, "PR", "2");
  if (pr2) {
    suggestions.push({
      category: "coinsurance",
      action: "auto_apply",
      confidence: 0.95,
      field: "coinsurance",
      suggestedValue: casAmount(pr2),
      reason: `CAS PR-2 ${casAmount(pr2).toFixed(2)} → client coinsurance`,
      conflict: null,
      sourceCas: [{ groupCode: "PR", reasonCode: "2", amount: casAmount(pr2) }],
    });
  }

  // ── PR-3 Copay ───────────────────────────────────────────────────────────
  const pr3 = findCas(adjs, "PR", "3");
  if (pr3) {
    suggestions.push({
      category: "copay",
      action: "auto_apply",
      confidence: 0.95,
      field: "copay",
      suggestedValue: casAmount(pr3),
      reason: `CAS PR-3 ${casAmount(pr3).toFixed(2)} → client copay`,
      conflict: null,
      sourceCas: [{ groupCode: "PR", reasonCode: "3", amount: casAmount(pr3) }],
    });
  }

  // ── PR total vs CLP05 conflict ───────────────────────────────────────────
  const prSum = sumCas(adjs, "PR");
  if (prSum > 0 && Math.abs(prSum - input.clp05PatientResponsibility) > 0.02) {
    suggestions.push({
      category: "coinsurance",
      action: "review",
      confidence: 0.7,
      field: "clp05_patient_responsibility",
      suggestedValue: prSum,
      reason: `Sum of PR adjustments (${prSum.toFixed(2)}) does not match CLP05 (${input.clp05PatientResponsibility.toFixed(2)}).`,
      conflict: "patient_responsibility_mismatch",
      sourceCas: adjs
        .filter((a) => casGroup(a) === "PR")
        .map((a) => ({ groupCode: "PR", reasonCode: casReason(a), amount: casAmount(a) })),
    });
  }

  // ── CO Contractual ───────────────────────────────────────────────────────
  const coSum = sumCas(adjs, "CO");
  if (coSum > 0) {
    suggestions.push({
      category: "contractual",
      action: "auto_apply",
      confidence: 0.9,
      field: "contractual",
      suggestedValue: coSum,
      reason: `CAS CO total ${coSum.toFixed(2)} → contractual adjustment (write-off).`,
      conflict: null,
      sourceCas: adjs
        .filter((a) => casGroup(a) === "CO")
        .map((a) => ({ groupCode: "CO", reasonCode: casReason(a), amount: casAmount(a) })),
    });
  }

  // ── Denial (zero paid + nonzero CAS + no PR) ─────────────────────────────
  if (
    input.clp04PaymentAmount === 0 &&
    sumCas(adjs) > 0 &&
    input.clp05PatientResponsibility === 0
  ) {
    suggestions.push({
      category: "denial",
      action: "review",
      confidence: 0.85,
      field: "claim_status",
      suggestedValue: "denied",
      reason: "Zero payment with adjustments and no client responsibility — looks like a denial.",
      conflict: null,
      sourceCas: adjs.map((a) => ({
        groupCode: casGroup(a),
        reasonCode: casReason(a),
        amount: casAmount(a),
      })),
    });
  }

  // ── Reversal (group CR) ──────────────────────────────────────────────────
  if (adjs.some((a) => casGroup(a) === "CR")) {
    suggestions.push({
      category: "reversal",
      action: "block_until_acknowledged",
      confidence: 0.9,
      field: "claim_status",
      suggestedValue: "reversed",
      reason: "CAS CR group detected — this is a correction or reversal of a prior payment.",
      conflict: "needs_reversal_workflow",
      sourceCas: adjs
        .filter((a) => casGroup(a) === "CR")
        .map((a) => ({ groupCode: "CR", reasonCode: casReason(a), amount: casAmount(a) })),
    });
  }

  // ── Capitation (CARC 24) ─────────────────────────────────────────────────
  const cap = adjs.find((a) => casReason(a) === "24" && casAmount(a) > 0);
  if (cap) {
    suggestions.push({
      category: "capitation",
      action: "auto_apply",
      confidence: 0.85,
      field: "adjustment_type",
      suggestedValue: "capitation",
      reason: `CARC 24 ${casAmount(cap).toFixed(2)} → capitation.`,
      conflict: null,
      sourceCas: [{ groupCode: casGroup(cap), reasonCode: "24", amount: casAmount(cap) }],
    });
  }

  // ── Sequestration (CARC 253) ─────────────────────────────────────────────
  const seq = adjs.find((a) => casReason(a) === "253" && casAmount(a) > 0);
  if (seq) {
    suggestions.push({
      category: "sequestration",
      action: "auto_apply",
      confidence: 0.95,
      field: "adjustment_type",
      suggestedValue: "sequestration",
      reason: `CARC 253 ${casAmount(seq).toFixed(2)} → Medicare sequestration.`,
      conflict: null,
      sourceCas: [{ groupCode: casGroup(seq), reasonCode: "253", amount: casAmount(seq) }],
    });
  }

  // ── COB issue (CARC 22 / 23) ─────────────────────────────────────────────
  const cob = adjs.find((a) => ["22", "23"].includes(casReason(a)) && casAmount(a) > 0);
  if (cob) {
    suggestions.push({
      category: "cob_issue",
      action: "review",
      confidence: 0.8,
      field: "claim_status",
      suggestedValue: "cob_required",
      reason: `CARC ${casReason(cob)} indicates coordination-of-benefits with another payer.`,
      conflict: "secondary_billing_required",
      sourceCas: [{ groupCode: casGroup(cob), reasonCode: casReason(cob), amount: casAmount(cob) }],
    });
  }

  // ── Recoupment (negative payment) ────────────────────────────────────────
  if (input.clp04PaymentAmount < 0) {
    suggestions.push({
      category: "recoupment",
      action: "block_until_acknowledged",
      confidence: 0.95,
      field: "claim_status",
      suggestedValue: "recouped",
      reason: `Negative CLP04 ${input.clp04PaymentAmount.toFixed(2)} → payer recoupment.`,
      conflict: "negative_payment_requires_review",
      sourceCas: [],
    });
  }

  // ── CLP02 status code overrides ──────────────────────────────────────────
  const status = (input.clp02ClaimStatusCode ?? "").toString();
  if (status === "4") {
    suggestions.push({
      category: "denial",
      action: "review",
      confidence: 0.9,
      field: "claim_status",
      suggestedValue: "denied",
      reason: "CLP02 status code 4 — claim was denied by the payer.",
      conflict: null,
      sourceCas: [],
    });
  }
  if (status === "22") {
    suggestions.push({
      category: "reversal",
      action: "block_until_acknowledged",
      confidence: 0.95,
      field: "claim_status",
      suggestedValue: "reversed",
      reason: "CLP02 status code 22 — reversal of previous payment.",
      conflict: "needs_reversal_workflow",
      sourceCas: [],
    });
  }

  return dedupeAndSortSuggestions(suggestions);
}

function dedupeAndSortSuggestions(list: PostingSuggestion[]): PostingSuggestion[] {
  const seen = new Set<string>();
  const out: PostingSuggestion[] = [];
  for (const s of list) {
    const key = `${s.category}:${s.field}:${s.conflict ?? ""}:${s.suggestedValue ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  // Sort by confidence desc; auto_apply first within ties.
  out.sort((a, b) => {
    if (Math.abs(a.confidence - b.confidence) > 0.001) return b.confidence - a.confidence;
    if (a.action === "auto_apply" && b.action !== "auto_apply") return -1;
    if (b.action === "auto_apply" && a.action !== "auto_apply") return 1;
    return 0;
  });
  return out;
}

/**
 * DB-backed duplicate detection — looks for another era_claim_payments row
 * with the same payer_claim_control_number that is already posted.
 *
 * Returns a single suggestion (or null) — the caller appends it to the list
 * from `generatePostingSuggestions`.
 */
export interface DuplicateDetectionInput {
  organizationId: string;
  selfEraClaimPaymentId: string;
  payerClaimControlNumber: string | null;
}

export async function detectDuplicatePostingSuggestion(
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, value: string) => {
          eq: (col: string, value: string) => {
            neq: (col: string, value: string) => {
              limit: (n: number) => Promise<{ data: Array<{ id: string; posting_status: string }> | null }>;
            };
          };
        };
      };
    };
  },
  input: DuplicateDetectionInput,
): Promise<PostingSuggestion | null> {
  if (!input.payerClaimControlNumber) return null;
  const { data } = await supabase
    .from("era_claim_payments")
    .select("id, posting_status")
    .eq("organization_id", input.organizationId)
    .eq("payer_claim_control_number", input.payerClaimControlNumber)
    .neq("id", input.selfEraClaimPaymentId)
    .limit(5);
  const rows = data ?? [];
  const alreadyPosted = rows.filter((r) => r.posting_status === "posted");
  if (alreadyPosted.length === 0) return null;
  return {
    category: "duplicate_payment",
    action: "block_until_acknowledged",
    confidence: 0.95,
    field: "posting_status",
    suggestedValue: "blocked",
    reason: `Payer claim control number ${input.payerClaimControlNumber} is already posted on ${alreadyPosted.length} other ERA claim payment(s).`,
    conflict: "duplicate_pcn_already_posted",
    sourceCas: [],
  };
}
