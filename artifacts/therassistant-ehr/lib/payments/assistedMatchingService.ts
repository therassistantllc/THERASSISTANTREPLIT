/**
 * Assisted Matching Engine — Task #108.
 *
 * Given an ERA claim payment (CLP01/CLP07 + parsed claim data), find the
 * most likely `professional_claims` row(s) it belongs to.
 *
 * Strategy (ordered):
 *   1. Exact match on payer_claim_control_number  (CLP07 ↔ PCN)
 *   2. Exact match on internal claim_number       (CLP01 ↔ claim_number)
 *   3. Exact match on patient_account_number      (CLP01/PCN ↔ patient_account_number)
 *   4. Probable match: payer + DOS overlap + total_charge ± $0.50 + patient last name fuzzy
 *
 * Returns confidence in [0,1] and the strategy that produced the match.
 *
 * Pure DB reads — no writes. The caller decides whether to bind the match
 * (auto-bind ≥0.95) or surface candidates to the biller.
 */

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type MatchStrategy =
  | "payer_claim_control_number"
  | "claim_number"
  | "patient_account_number"
  | "probable_dos_charge_name";

export interface MatchCandidate {
  professionalClaimId: string;
  clientId: string | null;
  claimNumber: string | null;
  patientAccountNumber: string | null;
  payerClaimControlNumber: string | null;
  payerProfileId: string | null;
  totalCharge: number;
  dateOfServiceFrom: string | null;
  dateOfServiceTo: string | null;
  patientDisplayName: string | null;
  confidence: number;
  strategy: MatchStrategy;
  reasons: string[];
}

export interface AssistedMatchInput {
  organizationId: string;
  eraClaimPaymentId: string;
  /** CLP01 internal control number from 835. */
  clp01ClaimControlNumber: string;
  /** CLP07 payer-assigned ICN. */
  payerClaimControlNumber: string | null;
  /** Expected total charge for fuzzy fallback (CLP03). */
  totalCharge: number;
  /** Payer profile id from the batch (optional — narrows search). */
  payerProfileId: string | null;
  /** Service date(s) from the SVC*DTM*472 segments if known. */
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  /** Patient last name from NM1*QC (when present). */
  patientLastName: string | null;
}

export interface AssistedMatchResult {
  exact: MatchCandidate | null;
  probable: MatchCandidate[];
  unmatched: boolean;
}

interface ProfessionalClaimRow {
  id: string;
  patient_id: string | null;
  payer_profile_id: string | null;
  claim_number: string | null;
  patient_account_number: string | null;
  total_charge: number | string | null;
  date_of_service_from: string | null;
  date_of_service_to: string | null;
}

interface ClientRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

const CHARGE_TOLERANCE = 0.5;

function toNum(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function dateOverlaps(
  candidateFrom: string | null,
  candidateTo: string | null,
  targetFrom: string | null,
  targetTo: string | null,
): boolean {
  if (!candidateFrom || !targetFrom) return false;
  const cFrom = candidateFrom;
  const cTo = candidateTo ?? candidateFrom;
  const tFrom = targetFrom;
  const tTo = targetTo ?? targetFrom;
  return cFrom <= tTo && tFrom <= cTo;
}

function fuzzyLastNameMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function findCandidatesForEraClaimPayment(
  input: AssistedMatchInput,
): Promise<AssistedMatchResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return { exact: null, probable: [], unmatched: true };
  }

  // ── Strategy 1: payer_claim_control_number (CLP07) ────────────────────────
  if (input.payerClaimControlNumber) {
    const { data: pcnRows } = await supabase
      .from("professional_claims")
      .select(
        "id, patient_id, payer_profile_id, claim_number, patient_account_number, total_charge, date_of_service_from, date_of_service_to",
      )
      .eq("organization_id", input.organizationId)
      .eq("patient_account_number", input.payerClaimControlNumber)
      .limit(2);
    const rows = (pcnRows ?? []) as ProfessionalClaimRow[];
    if (rows.length === 1) {
      const claim = rows[0];
      return {
        exact: await toCandidate(
          supabase,
          claim,
          1.0,
          "payer_claim_control_number",
          [
            `Payer claim control number ${input.payerClaimControlNumber} matched patient_account_number`,
          ],
          input.organizationId,
        ),
        probable: [],
        unmatched: false,
      };
    }
  }

  // ── Strategy 2: claim_number (CLP01) ─────────────────────────────────────
  {
    const { data: cnRows } = await supabase
      .from("professional_claims")
      .select(
        "id, patient_id, payer_profile_id, claim_number, patient_account_number, total_charge, date_of_service_from, date_of_service_to",
      )
      .eq("organization_id", input.organizationId)
      .eq("claim_number", input.clp01ClaimControlNumber)
      .limit(2);
    const rows = (cnRows ?? []) as ProfessionalClaimRow[];
    if (rows.length === 1) {
      const claim = rows[0];
      return {
        exact: await toCandidate(
          supabase,
          claim,
          1.0,
          "claim_number",
          [`CLP01 ${input.clp01ClaimControlNumber} matched internal claim_number`],
          input.organizationId,
        ),
        probable: [],
        unmatched: false,
      };
    }
  }

  // ── Strategy 3: patient_account_number (CLP01 reused) ────────────────────
  {
    const { data: panRows } = await supabase
      .from("professional_claims")
      .select(
        "id, patient_id, payer_profile_id, claim_number, patient_account_number, total_charge, date_of_service_from, date_of_service_to",
      )
      .eq("organization_id", input.organizationId)
      .eq("patient_account_number", input.clp01ClaimControlNumber)
      .limit(2);
    const rows = (panRows ?? []) as ProfessionalClaimRow[];
    if (rows.length === 1) {
      const claim = rows[0];
      return {
        exact: await toCandidate(
          supabase,
          claim,
          0.97,
          "patient_account_number",
          [`CLP01 ${input.clp01ClaimControlNumber} matched patient_account_number`],
          input.organizationId,
        ),
        probable: [],
        unmatched: false,
      };
    }
  }

  // ── Strategy 4: probable match (payer + DOS + charge ± tolerance) ────────
  let query = supabase
    .from("professional_claims")
    .select(
      "id, patient_id, payer_profile_id, claim_number, patient_account_number, total_charge, date_of_service_from, date_of_service_to",
    )
    .eq("organization_id", input.organizationId);

  if (input.payerProfileId) {
    query = query.eq("payer_profile_id", input.payerProfileId);
  }
  if (input.totalCharge > 0) {
    query = query
      .gte("total_charge", input.totalCharge - CHARGE_TOLERANCE)
      .lte("total_charge", input.totalCharge + CHARGE_TOLERANCE);
  }
  const { data: probableRows } = await query.limit(20);
  const candidates = (probableRows ?? []) as ProfessionalClaimRow[];

  const scored: MatchCandidate[] = [];
  for (const claim of candidates) {
    const dosOverlap = dateOverlaps(
      input.serviceDateFrom,
      input.serviceDateTo,
      claim.date_of_service_from,
      claim.date_of_service_to,
    );
    const chargeDelta = Math.abs(input.totalCharge - toNum(claim.total_charge));
    const chargeMatch = chargeDelta <= CHARGE_TOLERANCE;

    let confidence = 0.5;
    const reasons: string[] = [];
    if (chargeMatch) {
      confidence += 0.15;
      reasons.push(`Charge ${toNum(claim.total_charge).toFixed(2)} ≈ ${input.totalCharge.toFixed(2)}`);
    }
    if (dosOverlap) {
      confidence += 0.2;
      reasons.push("Date of service overlaps");
    }
    if (input.payerProfileId && claim.payer_profile_id === input.payerProfileId) {
      confidence += 0.1;
      reasons.push("Payer matches");
    }
    if (input.patientLastName && claim.patient_id) {
      const { data: clientRow } = await supabase
        .from("clients")
        .select("id, first_name, last_name")
        .eq("organization_id", input.organizationId)
        .eq("id", claim.patient_id)
        .maybeSingle();
      if (clientRow && fuzzyLastNameMatch((clientRow as ClientRow).last_name, input.patientLastName)) {
        confidence += 0.15;
        reasons.push(`Patient last name "${input.patientLastName}" matches`);
      }
    }

    if (confidence >= 0.6) {
      const candidate = await toCandidate(
        supabase,
        claim,
        Math.min(confidence, 0.94),
        "probable_dos_charge_name",
        reasons,
        input.organizationId,
      );
      if (candidate) scored.push(candidate);
    }
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  const top = scored.slice(0, 5);

  return {
    exact: null,
    probable: top,
    unmatched: top.length === 0,
  };
}

async function toCandidate(
  supabase: NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>,
  claim: ProfessionalClaimRow,
  confidence: number,
  strategy: MatchStrategy,
  reasons: string[],
  organizationId?: string,
): Promise<MatchCandidate> {
  let patientDisplayName: string | null = null;
  if (claim.patient_id) {
    let q = supabase
      .from("clients")
      .select("id, first_name, last_name, organization_id")
      .eq("id", claim.patient_id);
    if (organizationId) q = q.eq("organization_id", organizationId);
    const { data: client } = await q.maybeSingle();
    if (client) {
      const c = client as ClientRow;
      patientDisplayName =
        [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null;
    }
  }
  return {
    professionalClaimId: claim.id,
    clientId: claim.patient_id,
    claimNumber: claim.claim_number,
    patientAccountNumber: claim.patient_account_number,
    payerClaimControlNumber: null,
    payerProfileId: claim.payer_profile_id,
    totalCharge: toNum(claim.total_charge),
    dateOfServiceFrom: claim.date_of_service_from,
    dateOfServiceTo: claim.date_of_service_to,
    patientDisplayName,
    confidence,
    strategy,
    reasons,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure scoring helpers — exported for unit testing                            */
/* ────────────────────────────────────────────────────────────────────────── */

export interface ScoringInput {
  totalCharge: number;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  payerProfileId: string | null;
  patientLastName: string | null;
}

export interface ScoringCandidate {
  totalCharge: number;
  dateOfServiceFrom: string | null;
  dateOfServiceTo: string | null;
  payerProfileId: string | null;
  patientLastName: string | null;
}

export function scoreProbableMatch(
  input: ScoringInput,
  candidate: ScoringCandidate,
): { confidence: number; reasons: string[] } {
  let confidence = 0.5;
  const reasons: string[] = [];

  if (
    input.totalCharge > 0 &&
    Math.abs(input.totalCharge - candidate.totalCharge) <= CHARGE_TOLERANCE
  ) {
    confidence += 0.15;
    reasons.push("Charge match");
  }
  if (
    dateOverlaps(
      input.serviceDateFrom,
      input.serviceDateTo,
      candidate.dateOfServiceFrom,
      candidate.dateOfServiceTo,
    )
  ) {
    confidence += 0.2;
    reasons.push("DOS overlap");
  }
  if (input.payerProfileId && candidate.payerProfileId === input.payerProfileId) {
    confidence += 0.1;
    reasons.push("Payer match");
  }
  if (
    input.patientLastName &&
    candidate.patientLastName &&
    fuzzyLastNameMatch(candidate.patientLastName, input.patientLastName)
  ) {
    confidence += 0.15;
    reasons.push("Patient last name match");
  }

  return { confidence: Math.min(confidence, 0.94), reasons };
}

export { dateOverlaps as _dateOverlaps };
