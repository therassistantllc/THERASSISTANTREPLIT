export type Era835CasAdjustment = {
  groupCode: string;
  reasonCode: string;
  amount: number;
  quantity?: number | null;
};

export type Era835ServiceLine = {
  procedureCode: string | null;
  chargeAmount: number;
  paidAmount: number;
  serviceDate?: string | null;
  adjustments: Era835CasAdjustment[];
  rawSegments: string[];
};

export type Era835ClaimPayment = {
  clp01ClaimControlNumber: string;
  clp02ClaimStatusCode: string | null;
  clp03TotalCharge: number;
  clp04PaymentAmount: number;
  clp05PatientResponsibility: number;
  payerClaimControlNumber: string | null;
  casAdjustments: Era835CasAdjustment[];
  serviceLines: Era835ServiceLine[];
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
        serviceLines: [],
        rawSegments: [segment],
      };
      continue;
    }

    if (!currentClaim) continue;
    currentClaim.rawSegments.push(segment);

    if (segmentId === "CAS") {
      const adjustments = parseCas(elements);
      if (currentServiceLine) currentServiceLine.adjustments.push(...adjustments);
      else currentClaim.casAdjustments.push(...adjustments);
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
    segmentCount: segments.length,
  };
}
