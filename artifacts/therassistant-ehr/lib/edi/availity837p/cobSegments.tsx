/**
 * Shared 837P coordination-of-benefits segment builders.
 *
 * Encapsulates Loop 2320 (other-subscriber adjudication summary), Loops
 * 2330A/2330B (other subscriber + other payer), and the per-line 2430
 * SVD/CAS/DTP*573 (line-level adjudication). Used by:
 *   - generate837pSecondary (dedicated secondary-only builder)
 *   - generate837p / generate837pMultiClaimBatch (multi-claim batch path)
 *     when a child claim has `cob_billing_role='secondary'` and
 *     `prior_payer_*` columns + `prior_payer_eob_data` are populated.
 *
 * The "primary" data used by the COB loops is derived from the child
 * claim's prior_payer_* columns (CLP04/CLP05 totals) plus the structured
 * payload in prior_payer_eob_data (CAS adjustments + per-line ERA
 * breakdown + identifying primary subscriber/payer name+id stashed by
 * cobBilling.billSecondary).
 *
 * Without these loops the secondary payer either rejects the claim
 * outright or pays as primary (incorrectly), causing downstream takebacks.
 */
import type { ProfessionalClaim, ProfessionalClaimServiceLine } from "./types";
import { X12, buildSegment, formatDateYYYYMMDD, formatMoney, sanitizeX12 } from "./x12";

export interface CobAdjustment {
  group_code: string;
  reason_code: string;
  amount: number | string;
  quantity?: number | string | null;
}

export interface CobServiceLine {
  service_line_id?: string | null;
  procedure_code?: string | null;
  paid_amount: number | string;
  original_units?: number | string | null;
  cas_adjustments?: CobAdjustment[];
}

export interface CobPrimaryData {
  payer_name: string;
  payer_id: string;
  subscriber_last_name: string;
  subscriber_first_name?: string | null;
  subscriber_member_id: string;
  adjudication_date?: string | null;
  payer_paid_amount: number;
  patient_responsibility_amount: number;
  cas_adjustments: CobAdjustment[];
  service_lines: CobServiceLine[];
}

function toProcedureComposite(line: ProfessionalClaimServiceLine): string {
  const modifiers = (line.modifiers ?? [])
    .filter(Boolean)
    .slice(0, 4)
    .map((m) => sanitizeX12(m));
  return ["HC", sanitizeX12(line.procedure_code), ...modifiers].join(X12.componentSeparator);
}

export function emitCasSegments(adjustments: CobAdjustment[] | null | undefined): string[] {
  const out: string[] = [];
  for (const adj of adjustments ?? []) {
    if (!adj || !adj.group_code || !adj.reason_code) continue;
    const els: Array<string | number> = [
      "CAS",
      sanitizeX12(adj.group_code),
      sanitizeX12(adj.reason_code),
      formatMoney(Number(adj.amount ?? 0)),
    ];
    if (adj.quantity !== null && adj.quantity !== undefined && adj.quantity !== "") {
      els.push(Number(adj.quantity));
    }
    out.push(buildSegment(els));
  }
  return out;
}

/**
 * Loop 2320 + 2330A + 2330B — primary payer adjudication summary.
 */
export function emitClaimCobLoops(primary: CobPrimaryData): string[] {
  const segments: string[] = [];

  // 2320 SBR — this OTHER payer paid as primary.
  segments.push(buildSegment(["SBR", "P", "18", "", "", "", "", "", "", "CI"]));

  // Claim-level CAS adjustments from the primary ERA.
  for (const seg of emitCasSegments(primary.cas_adjustments)) segments.push(seg);

  // AMT*D — primary payer paid amount (CLP04 on the 835).
  segments.push(buildSegment(["AMT", "D", formatMoney(Number(primary.payer_paid_amount ?? 0))]));
  // AMT*F2 — client responsibility amount (CLP05 on the 835).
  segments.push(
    buildSegment([
      "AMT",
      "F2",
      formatMoney(Number(primary.patient_responsibility_amount ?? 0)),
    ]),
  );

  // OI***Y***Y — release of info / benefits assignment for the OTHER payer.
  segments.push(buildSegment(["OI", "", "", "Y", "", "", "Y"]));

  // 2330A Other Subscriber Name (PRIMARY subscriber).
  segments.push(
    buildSegment([
      "NM1",
      "IL",
      "1",
      sanitizeX12(primary.subscriber_last_name),
      sanitizeX12(primary.subscriber_first_name ?? ""),
      "",
      "",
      "",
      "MI",
      sanitizeX12(primary.subscriber_member_id),
    ]),
  );

  // 2330B Other Payer Name (PRIMARY payer).
  segments.push(
    buildSegment([
      "NM1",
      "PR",
      "2",
      sanitizeX12(primary.payer_name),
      "",
      "",
      "",
      "",
      "PI",
      sanitizeX12(primary.payer_id),
    ]),
  );

  return segments;
}

/**
 * Loop 2430 — per-line SVD + CAS + DTP*573 emitted from the stored ERA
 * service-line breakdown. Returns [] when no ERA line matches.
 */
export function emitServiceLineCobLoops(
  line: ProfessionalClaimServiceLine,
  primary: CobPrimaryData,
): string[] {
  if (!primary.service_lines || primary.service_lines.length === 0) return [];

  const matched = primary.service_lines.find((sl) => {
    if (sl.service_line_id && line.id && String(sl.service_line_id) === String(line.id)) {
      return true;
    }
    if (
      sl.procedure_code &&
      line.procedure_code &&
      String(sl.procedure_code).toUpperCase() === String(line.procedure_code).toUpperCase()
    ) {
      return true;
    }
    return false;
  });
  if (!matched) return [];

  const segments: string[] = [];
  segments.push(
    buildSegment([
      "SVD",
      sanitizeX12(primary.payer_id),
      formatMoney(Number(matched.paid_amount ?? 0)),
      toProcedureComposite(line),
      "",
      matched.original_units !== null && matched.original_units !== undefined
        ? Number(matched.original_units)
        : Number(line.units),
    ]),
  );
  for (const seg of emitCasSegments(matched.cas_adjustments ?? [])) segments.push(seg);
  if (primary.adjudication_date) {
    segments.push(
      buildSegment(["DTP", "573", "D8", formatDateYYYYMMDD(primary.adjudication_date)]),
    );
  }
  return segments;
}

/**
 * Coerce raw `cas_adjustments` data (mixed shapes from ERA parsers / manual
 * EOB JSON) into the canonical CobAdjustment[] shape used by the segment
 * builders. Tolerates both `reason_code` and `reason_codes[]` variants.
 */
export function normalizeCasAdjustments(raw: unknown): CobAdjustment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a: any) => {
    if (!a || typeof a !== "object") return [] as CobAdjustment[];
    const group = String(a.group_code ?? a.groupCode ?? "");
    const reasons: string[] = Array.isArray(a.reason_codes ?? a.reasonCodes)
      ? (a.reason_codes ?? a.reasonCodes).map(String)
      : a.reason_code || a.reasonCode || a.code
        ? [String(a.reason_code ?? a.reasonCode ?? a.code)]
        : [];
    const amount = Number(a.amount ?? a.adjustment_amount ?? 0);
    if (!group || reasons.length === 0 || !Number.isFinite(amount)) return [] as CobAdjustment[];
    return reasons.map<CobAdjustment>((r) => ({
      group_code: group,
      reason_code: r,
      amount,
      quantity: a.quantity ?? null,
    }));
  });
}

function normalizeEraServiceLines(raw: unknown): CobServiceLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((sl: any) => ({
    service_line_id: sl?.service_line_id ?? sl?.line_id ?? null,
    procedure_code: sl?.procedure_code ?? sl?.cpt ?? null,
    paid_amount: Number(sl?.paid_amount ?? sl?.line_paid ?? sl?.payment_amount ?? 0),
    original_units: sl?.units ?? sl?.original_units ?? null,
    cas_adjustments: normalizeCasAdjustments(sl?.cas_adjustments ?? sl?.adjustments),
  }));
}

/**
 * Derive a CobPrimaryData payload from the persisted child-claim columns.
 * Returns null when the claim is not a secondary child or doesn't have the
 * minimum identifying primary subscriber/payer fields stashed in
 * prior_payer_eob_data (no useful COB loops can be emitted without them).
 *
 * Expected shape of claim.prior_payer_eob_data (set by
 * cobBilling.billSecondary):
 *   {
 *     source: "era" | "manual",
 *     primary_payer_name: string,
 *     primary_payer_id: string,
 *     primary_subscriber_last_name: string,
 *     primary_subscriber_first_name?: string,
 *     primary_subscriber_member_id: string,
 *     posted_at?: string,          // ERA created_at, used as adjudication_date
 *     cas_adjustments?: unknown[], // claim-level
 *     service_lines?: unknown[],   // per-line ERA breakdown
 *     ...
 *   }
 */
export function deriveCobFromClaim(claim: ProfessionalClaim): CobPrimaryData | null {
  if (claim.cob_billing_role !== "secondary") return null;
  const eob = (claim.prior_payer_eob_data ?? {}) as Record<string, unknown>;
  const payerName = String(eob.primary_payer_name ?? "").trim();
  const payerId = String(eob.primary_payer_id ?? "").trim();
  const subLast = String(eob.primary_subscriber_last_name ?? "").trim();
  const memberId = String(eob.primary_subscriber_member_id ?? "").trim();
  if (!payerName || !payerId || !subLast || !memberId) return null;
  const subFirst = eob.primary_subscriber_first_name
    ? String(eob.primary_subscriber_first_name)
    : null;
  const adjudicationDate =
    (typeof eob.adjudication_date === "string" && eob.adjudication_date) ||
    (typeof eob.posted_at === "string" && eob.posted_at) ||
    null;
  return {
    payer_name: payerName,
    payer_id: payerId,
    subscriber_last_name: subLast,
    subscriber_first_name: subFirst,
    subscriber_member_id: memberId,
    adjudication_date: adjudicationDate,
    payer_paid_amount: Number(claim.prior_payer_paid_amount ?? 0),
    patient_responsibility_amount: Number(
      claim.prior_payer_patient_responsibility_amount ?? 0,
    ),
    cas_adjustments: normalizeCasAdjustments(eob.cas_adjustments),
    service_lines: normalizeEraServiceLines(eob.service_lines),
  };
}
