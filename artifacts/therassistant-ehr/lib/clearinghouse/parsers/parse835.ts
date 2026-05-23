// File: lib/clearinghouse/parsers/parse835.ts

type Segment = {
  id: string;
  elements: string[];
  raw: string;
};

type Parsed835Adjustment = {
  groupCode: string | null;
  reasonCode: string | null;
  amount: number | null;
  quantity: number | null;
  raw: string;
};

type Parsed835ServiceLine = {
  procedureCode: string | null;
  modifiers: string[];
  chargeAmount: number | null;
  paidAmount: number | null;
  revenueCode: string | null;
  units: number | null;
  serviceDate: string | null;
  adjustments: Parsed835Adjustment[];
  raw: Record<string, unknown>;
};

type Parsed835ClaimPayment = {
  patientControlNumber: string | null;
  claimStatusCode: string | null;
  totalChargeAmount: number | null;
  paidAmount: number | null;
  patientResponsibilityAmount: number | null;
  payerClaimControlNumber: string | null;
  claimFilingIndicatorCode: string | null;
  payerName: string | null;
  payeeName: string | null;
  checkOrEftNumber: string | null;
  traceNumber: string | null;
  paymentDate: string | null;
  serviceLines: Parsed835ServiceLine[];
  adjustments: Parsed835Adjustment[];
  raw: Record<string, unknown>;
};

export type Parsed835File = {
  payerName: string | null;
  payeeName: string | null;
  checkOrEftNumber: string | null;
  traceNumber: string | null;
  paymentDate: string | null;
  totalPaymentAmount: number | null;
  claims: Parsed835ClaimPayment[];
  rawSegmentCount: number;
};

function parseSegments(raw835: string): Segment[] {
  return String(raw835 ?? "")
    .replace(/\r?\n/g, "")
    .split("~")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const parts = raw.split("*");
      return { id: parts[0] ?? "", elements: parts.slice(1), raw };
    });
}

function money(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function x12Date(value: string | null | undefined): string | null {
  const v = String(value ?? "").replace(/\D/g, "");
  if (v.length !== 8) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

function findDate(elements: Array<string | null | undefined>) {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const parsed = x12Date(elements[index]);
    if (parsed) return parsed;
  }

  return null;
}

function parseComposite(value: string | null | undefined) {
  return String(value ?? "").split(":");
}

function parseCas(seg: Segment): Parsed835Adjustment[] {
  const groupCode = seg.elements[0] ?? null;
  const out: Parsed835Adjustment[] = [];

  for (let i = 1; i < seg.elements.length; i += 3) {
    const reasonCode = seg.elements[i] ?? null;
    const amount = money(seg.elements[i + 1]);
    const quantity = money(seg.elements[i + 2]);
    if (!reasonCode && amount == null && quantity == null) continue;
    out.push({ groupCode, reasonCode, amount, quantity, raw: seg.raw });
  }

  return out;
}

export function parse835(raw835: string): Parsed835File {
  const segments = parseSegments(raw835);

  let payerName: string | null = null;
  let payeeName: string | null = null;
  let checkOrEftNumber: string | null = null;
  let traceNumber: string | null = null;
  let paymentDate: string | null = null;
  let totalPaymentAmount: number | null = null;

  const claims: Parsed835ClaimPayment[] = [];
  let currentClaim: Parsed835ClaimPayment | null = null;
  let currentServiceLine: Parsed835ServiceLine | null = null;

  for (const seg of segments) {
    if (seg.id === "BPR") {
      totalPaymentAmount = money(seg.elements[1]);
      paymentDate = findDate(seg.elements) ?? paymentDate;
      continue;
    }

    if (seg.id === "TRN") {
      traceNumber = seg.elements[1] ?? traceNumber;
      checkOrEftNumber = seg.elements[1] ?? checkOrEftNumber;
      continue;
    }

    if (seg.id === "N1") {
      const entity = seg.elements[0];
      if (entity === "PR") payerName = seg.elements[1] ?? payerName;
      if (entity === "PE") payeeName = seg.elements[1] ?? payeeName;
      continue;
    }

    if (seg.id === "DTM" && seg.elements[0] === "405") {
      paymentDate = x12Date(seg.elements[1]) ?? paymentDate;
      continue;
    }

    if (seg.id === "CLP") {
      currentServiceLine = null;
      currentClaim = {
        patientControlNumber: seg.elements[0] ?? null,
        claimStatusCode: seg.elements[1] ?? null,
        totalChargeAmount: money(seg.elements[2]),
        paidAmount: money(seg.elements[3]),
        patientResponsibilityAmount: money(seg.elements[4]),
        payerClaimControlNumber: seg.elements[6] ?? null,
        claimFilingIndicatorCode: seg.elements[5] ?? null,
        payerName,
        payeeName,
        checkOrEftNumber,
        traceNumber,
        paymentDate,
        serviceLines: [],
        adjustments: [],
        raw: { clp: seg.raw },
      };
      claims.push(currentClaim);
      continue;
    }

    if (!currentClaim) continue;

    if (seg.id === "CAS") {
      const adjustments = parseCas(seg);
      if (currentServiceLine) currentServiceLine.adjustments.push(...adjustments);
      else currentClaim.adjustments.push(...adjustments);
      continue;
    }

    if (seg.id === "SVC") {
      const composite = parseComposite(seg.elements[0]);
      currentServiceLine = {
        procedureCode: composite[1] ?? composite[0] ?? null,
        modifiers: composite.slice(2).filter(Boolean),
        chargeAmount: money(seg.elements[1]),
        paidAmount: money(seg.elements[2]),
        revenueCode: composite[0] ?? null,
        units: money(seg.elements[4]),
        serviceDate: null,
        adjustments: [],
        raw: { svc: seg.raw },
      };
      currentClaim.serviceLines.push(currentServiceLine);
      continue;
    }

    if (seg.id === "DTM" && currentServiceLine) {
      if (seg.elements[0] === "472") currentServiceLine.serviceDate = x12Date(seg.elements[1]);
      continue;
    }

    if (seg.id === "REF") {
      currentClaim.raw = {
        ...currentClaim.raw,
        refs: [...((currentClaim.raw.refs as string[] | undefined) ?? []), seg.raw],
      };
    }
  }

  return {
    payerName,
    payeeName,
    checkOrEftNumber,
    traceNumber,
    paymentDate,
    totalPaymentAmount,
    claims,
    rawSegmentCount: segments.length,
  };
}
