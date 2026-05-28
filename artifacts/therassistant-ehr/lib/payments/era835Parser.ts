type Era835CasAdjustment = {
  groupCode: string;
  reasonCode: string;
  amount: number;
  quantity?: number | null;
};

/**
 * One provider-level adjustment parsed from an 835 PLB segment.
 *
 * PLB segments encode adjustments that apply to the provider as a whole
 * (not to a specific claim) — most commonly payer take-backs / recoupments
 * (`WO` = overpayment recovery, `FB` = forwarding balance, `J1` =
 * nonreimbursable, `72` = authorized return). PLB04 carries a signed
 * amount: a positive value REDUCES the check (the payer is taking money
 * back), a negative value INCREASES it. We persist the raw signed amount
 * and let downstream consumers (the takeback auto-seeder) interpret sign.
 *
 * `referenceIdentifier` is the right half of the PLB03 composite (after
 * `:` / `>`), typically the original payer-claim-control-number being
 * recouped. Empty when the payer omits a reference.
 */
export type Era835ProviderAdjustment = {
  adjustmentReasonCode: string;
  referenceIdentifier: string | null;
  amount: number;
};

type Era835ServiceLine = {
  procedureCode: string | null;
  chargeAmount: number;
  paidAmount: number;
  serviceDate?: string | null;
  adjustments: Era835CasAdjustment[];
  rawSegments: string[];
};

/**
 * Coordination-of-benefits signals extracted from a single 835 CLP loop.
 * Task #457 — surfaced so era835IntakeService can persist into
 * `claim_cob_signals` for /api/billing/cob-issues.
 *
 * - `coveredByOtherPayer` flips true when any CAS group has reason code
 *   22 ("This care may be covered by another payer per coordination of
 *   benefits"). The CO-22 amounts are summed across claim-level and
 *   service-line CAS segments.
 * - `otherPayerPaidAmount` carries the dollar amount the prior payer
 *   already paid, sourced from the MOA segment when present (Medicare
 *   Outclient Adjudication MOA*…) or from claim-level AMT*I/AMT*AAE
 *   "other-payer paid" qualifiers.
 * - `otherPayerName` / `otherPayerId` are populated from a CLP-loop
 *   NM1*TT (Transfer-To) or NM1*PR-as-other when the payer identifies
 *   the other carrier in the remittance.
 */
export type Era835CobSignals = {
  coveredByOtherPayer: boolean;
  co22Amount: number;
  otherPayerPaidAmount: number | null;
  otherPayerName: string | null;
  otherPayerId: string | null;
  /** MOA / AMT segment that produced `otherPayerPaidAmount`, for audit. */
  sourceSegment: string | null;
};

export type Era835ClaimPayment = {
  clp01ClaimControlNumber: string;
  clp02ClaimStatusCode: string | null;
  clp03TotalCharge: number;
  clp04PaymentAmount: number;
  clp05PatientResponsibility: number;
  payerClaimControlNumber: string | null;
  casAdjustments: Era835CasAdjustment[];
  /**
   * Remittance Advice Remark Codes (RARCs) attached to the claim. Pulled
   * from claim-level LQ segments (qualifier HE = remark code) and from
   * MIA / MOA segments. Service-line remarks are flattened into this set
   * too so downstream consumers (medical-review seeding, denials queue)
   * have a single per-claim list to inspect.
   */
  remarkCodes: string[];
  serviceLines: Era835ServiceLine[];
  cobSignals: Era835CobSignals;
  rawSegments: string[];
};

export type Era835ParsedFile = {
  transactionSetControlNumber: string | null;
  paymentAmount: number;
  paymentMethod: string | null;
  traceNumber: string | null;
  /** BPR16 — settlement effective date (YYYYMMDD from 835). */
  paymentDate: string | null;
  /** N1*PR NM103 — payer name. */
  payerName: string | null;
  /** N1*PR NM109 — payer identifier (typically tax ID or assigned payer ID). */
  payerIdentifier: string | null;
  claims: Era835ClaimPayment[];
  /**
   * Provider-level adjustments collected from PLB segments at the end of
   * the transaction. Empty when the payer included no PLB. Take-back
   * auto-detection inspects this list for recoupment-class reason codes
   * (WO / FB / J1 / 72).
   */
  providerAdjustments: Era835ProviderAdjustment[];
  segmentCount: number;
};

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100) / 100;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function splitSegments(rawContent: string): string[] {
  return rawContent
    .replace(/\r?\n/g, "")
    .split("~")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function splitElements(segment: string): string[] {
  return segment.split("*").map((element) => element.trim());
}

function parseCompositeProcedure(value: string | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const parts = raw.split(":");
  return parts.length > 1 ? parts[1] || null : parts[0] || null;
}

function parseCas(elements: string[]): Era835CasAdjustment[] {
  const groupCode = clean(elements[1]);
  const adjustments: Era835CasAdjustment[] = [];

  for (let index = 2; index < elements.length; index += 3) {
    const reasonCode = clean(elements[index]);
    const amount = toNumber(elements[index + 1]);
    const quantityValue = elements[index + 2];
    if (!reasonCode && amount === 0) continue;

    adjustments.push({
      groupCode,
      reasonCode,
      amount,
      quantity: quantityValue == null || quantityValue === "" ? null : toNumber(quantityValue),
    });
  }

  return adjustments;
}

function finalizeServiceLine(current: Era835ServiceLine | null, target: Era835ServiceLine[]) {
  if (current) target.push(current);
}

function finalizeClaim(current: Era835ClaimPayment | null, target: Era835ClaimPayment[]) {
  if (current) target.push(current);
}

export function parseEra835(rawContent: string): Era835ParsedFile {
  const segments = splitSegments(rawContent);
  const claims: Era835ClaimPayment[] = [];
  let currentClaim: Era835ClaimPayment | null = null;
  let currentServiceLine: Era835ServiceLine | null = null;
  let transactionSetControlNumber: string | null = null;
  let paymentAmount = 0;
  let paymentMethod: string | null = null;
  let traceNumber: string | null = null;
  let paymentDate: string | null = null;
  let payerName: string | null = null;
  let payerIdentifier: string | null = null;
  let inPayerN1 = false;
  const providerAdjustments: Era835ProviderAdjustment[] = [];

  for (const segment of segments) {
    const elements = splitElements(segment);
    const segmentId = elements[0];

    if (segmentId === "ST") transactionSetControlNumber = clean(elements[2]) || null;
    if (segmentId === "BPR") {
      paymentAmount = toNumber(elements[2]);
      paymentMethod = clean(elements[4]) || null;
      // BPR16 — settlement effective date (YYYYMMDD).
      const rawDate = clean(elements[16]);
      if (/^\d{8}$/.test(rawDate)) {
        paymentDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
      }
    }
    if (segmentId === "TRN") traceNumber = clean(elements[2]) || null;

    // N1*PR*PAYER NAME*XV*ID  → payer identity for dedupe key.
    if (segmentId === "N1" && clean(elements[1]) === "PR") {
      payerName = clean(elements[2]) || null;
      payerIdentifier = clean(elements[4]) || null;
      inPayerN1 = true;
    } else if (segmentId === "N1") {
      inPayerN1 = false;
    } else if (inPayerN1 && segmentId === "REF" && !payerIdentifier) {
      payerIdentifier = clean(elements[2]) || null;
    }

    if (segmentId === "CLP") {
      finalizeServiceLine(currentServiceLine, currentClaim?.serviceLines ?? []);
      currentServiceLine = null;
      finalizeClaim(currentClaim, claims);

      currentClaim = {
        clp01ClaimControlNumber: clean(elements[1]),
        clp02ClaimStatusCode: clean(elements[2]) || null,
        clp03TotalCharge: toNumber(elements[3]),
        clp04PaymentAmount: toNumber(elements[4]),
        clp05PatientResponsibility: toNumber(elements[5]),
        payerClaimControlNumber: clean(elements[7]) || null,
        casAdjustments: [],
        remarkCodes: [],
        serviceLines: [],
        cobSignals: {
          coveredByOtherPayer: false,
          co22Amount: 0,
          otherPayerPaidAmount: null,
          otherPayerName: null,
          otherPayerId: null,
          sourceSegment: null,
        },
        rawSegments: [segment],
      };
      continue;
    }

    // PLB — provider-level adjustments. Appear AFTER the last CLP and
    // before SE. PLB03+ are repeating composites: each pair is
    // (adjReasonCode>refIdentifier, signedAmount). Sweep all such pairs.
    if (segmentId === "PLB") {
      for (let idx = 3; idx + 1 < elements.length; idx += 2) {
        const composite = clean(elements[idx]);
        const amt = toNumber(elements[idx + 1]);
        if (!composite && amt === 0) continue;
        const parts = composite.split(/[:>]/);
        const adjReason = clean(parts[0]).toUpperCase();
        const refId = clean(parts[1]) || null;
        if (!adjReason && amt === 0) continue;
        providerAdjustments.push({
          adjustmentReasonCode: adjReason,
          referenceIdentifier: refId,
          amount: amt,
        });
      }
      continue;
    }

    if (!currentClaim) continue;
    currentClaim.rawSegments.push(segment);

    if (segmentId === "CAS") {
      const adjustments = parseCas(elements);
      if (currentServiceLine) currentServiceLine.adjustments.push(...adjustments);
      else currentClaim.casAdjustments.push(...adjustments);
      // Task #457 — CAS group "CO" with reason code 22 means the payer
      // is refusing this charge because it should have been routed to
      // another payer first (or paid by them already). Track the signal
      // on the claim regardless of whether it arrived at the claim or
      // service-line level.
      for (const adj of adjustments) {
        if (adj.groupCode === "CO" && adj.reasonCode === "22") {
          currentClaim.cobSignals.coveredByOtherPayer = true;
          currentClaim.cobSignals.co22Amount =
            Math.round((currentClaim.cobSignals.co22Amount + adj.amount) * 100) / 100;
          if (!currentClaim.cobSignals.sourceSegment) {
            currentClaim.cobSignals.sourceSegment = segment;
          }
        }
      }
      continue;
    }

    // MOA — Medicare Outclient Adjudication. MOA03–MOA09 carry MIA/MOA
    // remark codes; MOA02 is the reimbursement rate, but several payers
    // also place the prior-payer paid amount here when the claim was
    // adjudicated as secondary. We capture MOA03 = MA-series remark
    // codes alongside the dollar value for audit context.
    if (segmentId === "MOA") {
      const amount = toNumber(elements[2]);
      if (amount > 0 && currentClaim.cobSignals.otherPayerPaidAmount == null) {
        currentClaim.cobSignals.otherPayerPaidAmount = amount;
        currentClaim.cobSignals.sourceSegment = segment;
      }
      continue;
    }

    // AMT — Monetary Amount Information. Inside a CLP loop only
    // qualifier "I" ("Interest" in some payer flavors, but used as
    // *Other Payer Prior Payment Amount* under X12 005010X221A1 COB
    // conventions) is a true prior-payer paid dollar value. Other
    // qualifiers like AAE ("Coordination of Benefits Total Submitted
    // Charges") are submitted-charge totals, NOT paid amounts —
    // mapping them here would falsely trigger eob_needed in
    // /api/billing/cob-issues.
    if (segmentId === "AMT" && !currentServiceLine) {
      const qual = clean(elements[1]);
      const amount = toNumber(elements[2]);
      if (qual === "I" && amount > 0 && currentClaim.cobSignals.otherPayerPaidAmount == null) {
        currentClaim.cobSignals.otherPayerPaidAmount = amount;
        currentClaim.cobSignals.sourceSegment = segment;
      }
      continue;
    }

    // NM1*TT inside a CLP loop names the other payer the claim was
    // transferred to (X12 835 Loop 2100 Crossover Carrier). NM1*PR
    // appearing under CLP is occasionally used by payers to identify
    // the other carrier in a COB scenario.
    if (segmentId === "NM1") {
      const entityCode = clean(elements[1]);
      if ((entityCode === "TT" || entityCode === "PR") && !currentClaim.cobSignals.otherPayerName) {
        const name = clean(elements[3]) || null;
        const idQual = clean(elements[8]);
        const idValue = clean(elements[9]) || null;
        if (name) currentClaim.cobSignals.otherPayerName = name;
        if (idValue && (idQual === "PI" || idQual === "XV" || idQual === "FI" || idQual === "")) {
          currentClaim.cobSignals.otherPayerId = idValue;
        }
      }
      continue;
    }

    // LQ*HE*N706 — claim or service-line remittance remark. Qualifier
    // HE = remark code. Other qualifiers (RX, etc.) are not RARCs and
    // are ignored.
    if (segmentId === "LQ" && clean(elements[1]).toUpperCase() === "HE") {
      const code = clean(elements[2]).toUpperCase();
      if (code) currentClaim.remarkCodes.push(code);
      continue;
    }

    // MIA / MOA segments carry inclient / outclient remark codes in
    // positions MIA20-MIA23 and MOA03-MOA07 respectively. Sweep both
    // ranges and collect anything that looks like a remark code (alpha
    // prefix + digits).
    if (segmentId === "MIA" || segmentId === "MOA") {
      for (let idx = 1; idx < elements.length; idx += 1) {
        const candidate = clean(elements[idx]).toUpperCase();
        if (/^(N|M|MA)\d{1,4}$/.test(candidate)) {
          currentClaim.remarkCodes.push(candidate);
        }
      }
      continue;
    }

    if (segmentId === "SVC") {
      finalizeServiceLine(currentServiceLine, currentClaim.serviceLines);
      currentServiceLine = {
        procedureCode: parseCompositeProcedure(elements[1]),
        chargeAmount: toNumber(elements[2]),
        paidAmount: toNumber(elements[3]),
        serviceDate: null,
        adjustments: [],
        rawSegments: [segment],
      };
      continue;
    }

    if (currentServiceLine) {
      currentServiceLine.rawSegments.push(segment);
      if (segmentId === "DTM" && elements[1] === "472") currentServiceLine.serviceDate = clean(elements[2]) || null;
    }
  }

  finalizeServiceLine(currentServiceLine, currentClaim?.serviceLines ?? []);
  finalizeClaim(currentClaim, claims);

  return {
    transactionSetControlNumber,
    paymentAmount,
    paymentMethod,
    traceNumber,
    paymentDate,
    payerName,
    payerIdentifier,
    claims,
    providerAdjustments,
    segmentCount: segments.length,
  };
}
