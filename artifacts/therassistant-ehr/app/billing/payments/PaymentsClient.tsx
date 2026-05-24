"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Search,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Circle,
  Dot,
  FileText,
  Mail,
  Edit3,
  SplitSquareHorizontal,
  ArrowRightLeft,
} from "lucide-react";
import { DEFAULT_ORG_ID } from "@/lib/config";

/* ──────────────────────────────────────────────────────────────────────── */
/*  Types (mirror /api/billing/era-payments response)                        */
/* ──────────────────────────────────────────────────────────────────────── */

type QueueTab = "all" | "matched" | "unmatched" | "blocked" | "posted";

interface CasAdjustment {
  groupCode: string | null;
  reasonCode: string | null;
  amount: number;
  description: string | null;
}

interface ServiceLine {
  procedureCode: string | null;
  charge: number;
  allowed: number;
  paid: number;
  adjustment: number;
  adjustmentCode: string | null;
}

interface LedgerEntry {
  entryType: string;
  amount: number;
  groupCode: string | null;
  reasonCode: string | null;
  description: string | null;
  postedAt: string | null;
}

interface ProfessionalClaim {
  id: string;
  claimNumber: string | null;
  claimStatus: string | null;
  dateOfServiceFrom: string | null;
  dateOfServiceTo: string | null;
  readyToSubmitAt: string | null;
  submittedAt: string | null;
  acceptedAt: string | null;
  paidAt: string | null;
  deniedAt: string | null;
}

interface EraPaymentItem {
  id: string;
  eraImportBatchId: string;
  claimControlNumber: string;
  payerClaimControlNumber: string | null;
  totalCharge: number;
  paymentAmount: number;
  patientResponsibility: number;
  claimMatchStatus: string;
  postingStatus: string;
  casAdjustments: CasAdjustment[];
  serviceLines: ServiceLine[];
  ledgerEntries: LedgerEntry[];
  professionalClaim: ProfessionalClaim | null;
  client: { id: string; displayName: string } | null;
  payer: { id: string | null; name: string };
  checkNumber: string | null;
  importedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

function getOrganizationId() {
  if (typeof window === "undefined")
    return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function money(v: number, opts: { signed?: boolean } = {}) {
  const abs = Math.abs(v).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
  if (!opts.signed) return abs;
  if (v > 0) return `+${abs}`;
  if (v < 0) return `−${abs}`;
  return abs;
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

function formatShortDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
}

function postingStatusLabel(status: string) {
  switch (status) {
    case "posted":
      return "Posted";
    case "ready":
      return "Ready to Post";
    case "blocked":
      return "Blocked";
    case "partial":
      return "Partially Applied";
    case "exception":
      return "Exception";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

function postingStatusPill(status: string): string {
  switch (status) {
    case "posted":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
    case "ready":
      return "bg-amber-50 text-amber-800 ring-1 ring-amber-200";
    case "blocked":
      return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
    case "partial":
      return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
    default:
      return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  }
}

function carcDescription(code: string | null): string {
  if (!code) return "";
  const map: Record<string, string> = {
    "1": "Deductible",
    "2": "Coinsurance",
    "3": "Co-payment",
    "45": "Charge exceeds fee schedule",
    "97": "Service not covered",
    "23": "Impact of prior payer adjudication",
    "24": "Charges covered under capitation",
  };
  return map[code] ?? "";
}

function groupCodeLabel(group: string | null): string {
  if (!group) return "";
  const map: Record<string, string> = {
    CO: "Contractual",
    PR: "Patient Resp.",
    OA: "Other Adj.",
    PI: "Payer Initiated",
    CR: "Correction/Reversal",
  };
  return map[group] ?? group;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Derived ledger model — one financial event stream per service line       */
/* ──────────────────────────────────────────────────────────────────────── */

type LedgerEventKind =
  | "charge"
  | "allowed"
  | "insurance_payment"
  | "contractual_adjustment"
  | "patient_responsibility";

interface LedgerEvent {
  kind: LedgerEventKind;
  label: string;
  amount: number; // signed: + for charges/patient resp, − for payments/adjustments
  meta?: string | null;
  codeBadge?: string | null;
  informational?: boolean; // 'allowed' is reference only, not summed
}

interface ServiceLineLedger {
  index: number;
  procedureCode: string | null;
  events: LedgerEvent[];
  charged: number;
  paid: number;
  adjusted: number;
  patientResp: number;
  balance: number; // charge − paid − adjusted − patientResp
}

function deriveServiceLineLedger(
  line: ServiceLine,
  index: number,
  payerName: string,
  ptRespShare: number,
  casForLine: CasAdjustment[],
): ServiceLineLedger {
  const events: LedgerEvent[] = [];
  events.push({
    kind: "charge",
    label: "Charge posted",
    amount: line.charge,
    meta: line.procedureCode ? `CPT ${line.procedureCode}` : null,
  });
  if (line.allowed > 0) {
    events.push({
      kind: "allowed",
      label: "Allowed amount",
      amount: line.allowed,
      informational: true,
    });
  }
  if (line.paid > 0) {
    events.push({
      kind: "insurance_payment",
      label: `Insurance payment · ${payerName}`,
      amount: -line.paid,
    });
  }
  // Prefer detailed CAS entries when available, fall back to summary line.adjustment
  // PR (patient responsibility) group code → patient_responsibility event
  // CO / OA / PI → contractual_adjustment event (with semantic label)
  let casPatientResp = 0;
  if (casForLine.length > 0) {
    for (const c of casForLine) {
      if (!c.amount) continue;
      const isPR = (c.groupCode || "").toUpperCase() === "PR";
      if (isPR) {
        casPatientResp += Math.abs(c.amount);
        continue;
      }
      events.push({
        kind: "contractual_adjustment",
        label:
          c.description ||
          carcDescription(c.reasonCode) ||
          groupCodeLabel(c.groupCode) ||
          "Adjustment",
        amount: -Math.abs(c.amount),
        codeBadge: c.groupCode && c.reasonCode ? `${c.groupCode}-${c.reasonCode}` : c.reasonCode,
      });
    }
  } else if (line.adjustment > 0) {
    events.push({
      kind: "contractual_adjustment",
      label: carcDescription(line.adjustmentCode) || "Contractual adjustment",
      amount: -line.adjustment,
      codeBadge: line.adjustmentCode,
    });
  }
  // CAS PR entries are authoritative when present (they already make up the
  // claim-level patientResponsibility). Fall back to the proportional share
  // only when this line has no CAS PR signal.
  const patientResp = +(casPatientResp > 0 ? casPatientResp : ptRespShare).toFixed(2);
  if (patientResp > 0) {
    events.push({
      kind: "patient_responsibility",
      label: "Patient responsibility",
      amount: patientResp,
    });
  }

  const charged = line.charge;
  const paid = line.paid;
  const adjusted = casForLine.length
    ? casForLine
        .filter((c) => (c.groupCode || "").toUpperCase() !== "PR")
        .reduce((s, c) => s + Math.abs(c.amount || 0), 0)
    : line.adjustment;
  const balance = +(charged - paid - adjusted - patientResp).toFixed(2);
  return {
    index,
    procedureCode: line.procedureCode,
    events,
    charged,
    paid,
    adjusted,
    patientResp,
    balance,
  };
}

/* Parse a line adjustment code that may be formatted as "CO-45", "CO45",
   or just "45" into its reason-code portion for matching against CAS.    */
function parseAdjReason(code: string | null): string | null {
  if (!code) return null;
  const trimmed = code.trim().toUpperCase();
  const m = trimmed.match(/^(?:[A-Z]{2}[- ]?)?([A-Z0-9]+)$/);
  return m ? m[1] : trimmed;
}

/* CAS adjustments live on the claim, not the line — split them across lines.
   Strategy:
   1. Try exact match by parsed reason code (e.g., line "CO-45" ↔ cas reason "45").
   2. Distribute remaining CAS across lines proportionally to charge, with
      cent-level reconciliation so per-line sums equal the original CAS total. */
function distributeCasAdjustments(
  cas: CasAdjustment[],
  lines: ServiceLine[],
): CasAdjustment[][] {
  if (lines.length === 0) return [];
  if (lines.length === 1) return [cas];
  const out: CasAdjustment[][] = lines.map(() => []);
  const usedCas = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const lineReason = parseAdjReason(lines[i].adjustmentCode);
    if (!lineReason) continue;
    cas.forEach((c, idx) => {
      if (usedCas.has(idx)) return;
      const casReason = (c.reasonCode || "").trim().toUpperCase();
      if (casReason && casReason === lineReason) {
        out[i].push(c);
        usedCas.add(idx);
      }
    });
  }
  // Distribute remaining CAS proportionally with cent reconciliation
  const totalCharge = lines.reduce((s, l) => s + l.charge, 0);
  cas.forEach((c, idx) => {
    if (usedCas.has(idx)) return;
    if (!c.amount) return;
    const totalAmt = Math.round(c.amount * 100); // cents, preserve sign
    if (totalCharge <= 0) {
      // No basis for proportional split — assign to first line
      out[0].push(c);
      return;
    }
    const shares: number[] = lines.map((l) =>
      Math.round((totalAmt * l.charge) / totalCharge),
    );
    let remainder = totalAmt - shares.reduce((s, v) => s + v, 0);
    // Distribute remainder cent-by-cent to the highest-charge lines deterministically
    const order = lines
      .map((l, i) => ({ i, w: l.charge }))
      .sort((a, b) => b.w - a.w || a.i - b.i);
    let oi = 0;
    while (remainder !== 0 && order.length) {
      const step = remainder > 0 ? 1 : -1;
      shares[order[oi % order.length].i] += step;
      remainder -= step;
      oi++;
    }
    shares.forEach((cents, i) => {
      if (cents === 0) return;
      out[i].push({ ...c, amount: cents / 100 });
    });
  });
  return out;
}

/* Chronology built from claim + batch + ledger entry timestamps */
interface ChronoEvent {
  date: string | null;
  label: string;
  detail?: string | null;
  amount?: number;
  state: "done" | "current" | "pending";
}

function deriveChronology(payment: EraPaymentItem): ChronoEvent[] {
  const claim = payment.professionalClaim;
  const events: ChronoEvent[] = [];
  if (claim?.dateOfServiceFrom) {
    events.push({
      date: claim.dateOfServiceFrom,
      label: "Service rendered",
      detail: claim.dateOfServiceTo && claim.dateOfServiceTo !== claim.dateOfServiceFrom
        ? `through ${formatShortDate(claim.dateOfServiceTo)}`
        : null,
      amount: payment.totalCharge,
      state: "done",
    });
  }
  if (claim?.readyToSubmitAt) {
    events.push({
      date: claim.readyToSubmitAt,
      label: "Charge captured",
      detail: claim.claimNumber ?? null,
      state: "done",
    });
  }
  if (claim?.submittedAt) {
    events.push({
      date: claim.submittedAt,
      label: "Claim submitted",
      detail: claim.claimNumber ?? null,
      state: "done",
    });
  }
  if (claim?.acceptedAt) {
    events.push({
      date: claim.acceptedAt,
      label: "Claim accepted by payer",
      state: "done",
    });
  }
  if (payment.importedAt) {
    events.push({
      date: payment.importedAt,
      label: "ERA received",
      detail: payment.checkNumber ? `Check ${payment.checkNumber}` : null,
      amount: payment.paymentAmount,
      state: "done",
    });
  }
  if (claim?.deniedAt) {
    events.push({
      date: claim.deniedAt,
      label: "Claim denied",
      state: "done",
    });
  }
  if (payment.ledgerEntries.length > 0) {
    const postedAt =
      payment.ledgerEntries
        .map((e) => e.postedAt)
        .filter(Boolean)
        .sort()[0] ?? payment.updatedAt;
    const insTotal = payment.ledgerEntries
      .filter((e) => e.entryType === "insurance_payment")
      .reduce((s, e) => s + e.amount, 0);
    events.push({
      date: postedAt,
      label: "Payment applied to ledger",
      amount: insTotal || payment.paymentAmount,
      state: "done",
    });
    if (payment.patientResponsibility > 0) {
      events.push({
        date: postedAt,
        label: "Patient invoice created",
        amount: payment.patientResponsibility,
        state: "done",
      });
    }
  } else if (payment.claimMatchStatus === "matched") {
    events.push({
      date: null,
      label: "Awaiting posting",
      state: "current",
    });
  } else {
    events.push({
      date: null,
      label: "Unmatched — manual reconciliation required",
      state: "current",
    });
  }
  // Sort by date (nulls last, in insertion order)
  return events.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Component                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

export default function PaymentsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [tab, setTab] = useState<QueueTab>("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<EraPaymentItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [postFeedback, setPostFeedback] = useState<
    { id: string; message: string; tone: "ok" | "err" } | null
  >(null);
  const [expandedLines, setExpandedLines] = useState<Record<string, boolean>>({});
  const [matchingId, setMatchingId] = useState<string | null>(null);

  const loadPayments = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/era-payments?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success)
        throw new Error(json.error ?? `Request failed with ${res.status}`);
      const list = (json.items ?? []) as EraPaymentItem[];
      setItems(list);
      setSelectedId((prev) =>
        prev && list.some((p) => p.id === prev) ? prev : list[0]?.id ?? null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load ERA payments");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    loadPayments();
  }, [loadPayments]);

  const filtered = useMemo(() => {
    let list = items;
    if (tab === "matched")
      list = list.filter(
        (p) => p.claimMatchStatus === "matched" && p.postingStatus !== "posted",
      );
    if (tab === "unmatched") list = list.filter((p) => p.claimMatchStatus !== "matched");
    if (tab === "blocked") list = list.filter((p) => p.postingStatus === "blocked");
    if (tab === "posted") list = list.filter((p) => p.postingStatus === "posted");
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.claimControlNumber.toLowerCase().includes(q) ||
          p.payer.name.toLowerCase().includes(q) ||
          (p.client?.displayName ?? "").toLowerCase().includes(q) ||
          (p.professionalClaim?.claimNumber ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [items, tab, search]);

  const selected = useMemo(
    () => items.find((p) => p.id === selectedId) ?? null,
    [items, selectedId],
  );

  const counts = useMemo(() => {
    const c: Record<QueueTab, number> = {
      all: items.length,
      matched: 0,
      unmatched: 0,
      blocked: 0,
      posted: 0,
    };
    for (const p of items) {
      if (p.claimMatchStatus === "matched" && p.postingStatus !== "posted") c.matched++;
      if (p.claimMatchStatus !== "matched") c.unmatched++;
      if (p.postingStatus === "blocked") c.blocked++;
      if (p.postingStatus === "posted") c.posted++;
    }
    return c;
  }, [items]);

  const kpi = useMemo(() => {
    const posted = items.filter((p) => p.postingStatus === "posted");
    const pending = items.filter((p) => p.postingStatus !== "posted");
    const blocked = items.filter(
      (p) => p.postingStatus === "blocked" || p.claimMatchStatus !== "matched",
    );
    const unapplied = items.filter(
      (p) => p.claimMatchStatus === "matched" && p.postingStatus === "ready",
    );
    const patientResp = items
      .filter((p) => p.postingStatus !== "posted")
      .reduce((s, p) => s + p.patientResponsibility, 0);
    return {
      postedTotal: posted.reduce((s, p) => s + p.paymentAmount, 0),
      pendingCount: pending.length,
      unappliedTotal: unapplied.reduce((s, p) => s + p.paymentAmount, 0),
      unappliedCount: unapplied.length,
      pendingPatientResp: patientResp,
      blocked: blocked.length,
    };
  }, [items]);

  const handlePost = useCallback(
    async (id: string) => {
      setPostingId(id);
      setPostFeedback(null);
      try {
        const res = await fetch(
          `/api/billing/era-payments/${encodeURIComponent(id)}/post`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organizationId }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(
            json.error ?? json.errors?.[0]?.message ?? `Request failed with ${res.status}`,
          );
        }
        const messageBits: string[] = [];
        if (json.alreadyPosted) messageBits.push("Already posted");
        else if (json.posted) messageBits.push("Payment posted");
        if (json.patientInvoiceCreated) messageBits.push("patient invoice created");
        if (json.workqueueItemsClosed > 0)
          messageBits.push(`${json.workqueueItemsClosed} workqueue item(s) closed`);
        setPostFeedback({
          id,
          message: messageBits.join(" · ") || "Payment posted",
          tone: "ok",
        });
        await loadPayments();
      } catch (err) {
        setPostFeedback({
          id,
          message: err instanceof Error ? err.message : "Failed to post payment",
          tone: "err",
        });
      } finally {
        setPostingId(null);
      }
    },
    [organizationId, loadPayments],
  );

  const handleMatchClaim = useCallback(
    async (id: string) => {
      if (matchingId) return;
      const claimNumber = typeof window !== "undefined"
        ? window.prompt("Enter the claim number to match this ERA payment to:")
        : null;
      if (!claimNumber || !claimNumber.trim()) return;
      setMatchingId(id);
      setPostFeedback(null);
      try {
        const res = await fetch(`/api/billing/era-payments/${encodeURIComponent(id)}/match`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, claimNumber: claimNumber.trim() }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error ?? "Match failed");
        setPostFeedback({ id, message: `Matched to claim ${claimNumber.trim()}.`, tone: "ok" });
        await loadPayments();
      } catch (err) {
        setPostFeedback({ id, message: err instanceof Error ? err.message : "Match failed", tone: "err" });
      } finally {
        setMatchingId(null);
      }
    },
    [matchingId, organizationId, loadPayments],
  );

  /* Derived ledger for the selected ERA */
  const selectedLedger = useMemo(() => {
    if (!selected) return null;
    const lines = selected.serviceLines;
    const totalCharge = lines.reduce((s, l) => s + l.charge, 0) || 1;
    const casPerLine = distributeCasAdjustments(selected.casAdjustments, lines);
    const lineLedgers = lines.map((line, i) => {
      const ptShare =
        lines.length === 1
          ? selected.patientResponsibility
          : +((line.charge / totalCharge) * selected.patientResponsibility).toFixed(2);
      return deriveServiceLineLedger(line, i, selected.payer.name, ptShare, casPerLine[i] ?? []);
    });
    return lineLedgers;
  }, [selected]);

  const balancing = useMemo(() => {
    if (!selected) return null;
    const eraTotal = selected.paymentAmount;
    const applied = selected.ledgerEntries
      .filter((e) => e.entryType === "insurance_payment")
      .reduce((s, e) => s + e.amount, 0);
    const remaining = +(eraTotal - applied).toFixed(2);
    return { eraTotal, applied, remaining };
  }, [selected]);

  /* ────────────────────────────────────────────────────────────────────── */
  return (
    <div className="flex h-full min-h-screen flex-col bg-slate-50 text-slate-900">
      {/* Header */}
      <header className="flex h-12 items-center gap-3 border-b border-slate-200 bg-white px-4">
        <span className="text-[13px] font-semibold tracking-tight text-slate-900">
          Payments &amp; ERA
        </span>
        <span className="text-[11px] text-slate-400">Posting workspace</span>
        <a
          href="/billing/era-import"
          className="inline-flex h-7 items-center gap-1.5 rounded border border-teal-300 bg-teal-50 px-2.5 text-[11px] font-semibold text-teal-800 hover:bg-teal-100"
        >
          Open ERA queue →
        </a>
        <a
          href="/billing/payments/manual-insurance"
          className="inline-flex h-7 items-center gap-1.5 rounded border border-indigo-300 bg-indigo-50 px-2.5 text-[11px] font-semibold text-indigo-800 hover:bg-indigo-100"
        >
          Post manual EOB
        </a>
        <a
          href="/billing/payments/patient"
          className="inline-flex h-7 items-center gap-1.5 rounded border border-amber-300 bg-amber-50 px-2.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
        >
          Patient payment
        </a>
        <div className="flex-1" />
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            strokeWidth={2}
          />
          <input
            className="h-7 w-72 rounded border border-slate-300 bg-white pl-8 pr-2 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
            placeholder="Search ERA #, claim #, patient, payer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          onClick={() => loadPayments()}
          disabled={loading}
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} strokeWidth={2.2} />
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-5 gap-px border-b border-slate-200 bg-slate-200">
        <Kpi label="Posted (all-time)" value={money(kpi.postedTotal)} tone="emerald" />
        <Kpi label="Pending ERAs" value={String(kpi.pendingCount)} tone="slate" />
        <Kpi
          label="Ready to post"
          value={money(kpi.unappliedTotal)}
          sub={`${kpi.unappliedCount} ERA${kpi.unappliedCount === 1 ? "" : "s"}`}
          tone="amber"
        />
        <Kpi
          label="Pending pt. resp."
          value={money(kpi.pendingPatientResp)}
          tone="orange"
        />
        <Kpi label="Blocked / unmatched" value={String(kpi.blocked)} tone="rose" />
      </div>

      {error ? (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-[11px] font-medium text-rose-700">
          Error: {error}
        </div>
      ) : null}

      {/* Body: 3 panes */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* ───────────── Left: Work queue ───────────── */}
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-1.5">
            {(["all", "matched", "unmatched", "blocked", "posted"] as QueueTab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex-1 rounded px-1.5 py-1 text-[10.5px] font-medium capitalize transition ${
                  tab === t
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {t}
                <span
                  className={`ml-1 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-sm px-1 text-[9px] font-semibold tabular-nums ${
                    tab === t
                      ? "bg-white/20 text-white"
                      : "bg-slate-200 text-slate-600"
                  }`}
                >
                  {counts[t]}
                </span>
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="p-4 text-[11px] text-slate-500">Loading ERA payments…</div>
            ) : filtered.length === 0 ? (
              <div className="p-4 text-[11px] text-slate-500">
                No ERA payments match this filter.
              </div>
            ) : (
              filtered.map((pmt) => {
                const isSel = selectedId === pmt.id;
                const isMatched = pmt.claimMatchStatus === "matched";
                return (
                  <button
                    key={pmt.id}
                    type="button"
                    onClick={() => setSelectedId(pmt.id)}
                    className={`group flex w-full items-stretch gap-2 border-b border-slate-100 px-2.5 py-2 text-left transition ${
                      isSel
                        ? "bg-blue-50/70 ring-inset ring-1 ring-blue-200"
                        : "hover:bg-slate-50"
                    }`}
                  >
                    <div
                      className={`flex w-1 shrink-0 rounded-sm ${
                        pmt.postingStatus === "posted"
                          ? "bg-emerald-500"
                          : pmt.postingStatus === "blocked" || !isMatched
                            ? "bg-rose-500"
                            : pmt.postingStatus === "ready"
                              ? "bg-amber-500"
                              : "bg-slate-300"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      {/* Amount-first row */}
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[11px] font-medium text-slate-600">
                          {pmt.payer.name}
                        </span>
                        <span className="shrink-0 text-[15px] font-semibold tabular-nums tracking-tight text-slate-900">
                          {money(pmt.paymentAmount)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-[10.5px] text-slate-500">
                          {pmt.client?.displayName ?? (
                            <em className="not-italic text-rose-600">Unmatched patient</em>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-[9.5px] text-slate-400">
                          {pmt.claimControlNumber}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[9.5px] font-medium ${postingStatusPill(
                            pmt.postingStatus,
                          )}`}
                        >
                          {pmt.postingStatus === "posted" ? (
                            <CheckCircle2 className="h-2.5 w-2.5" strokeWidth={2.4} />
                          ) : !isMatched || pmt.postingStatus === "blocked" ? (
                            <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2.4} />
                          ) : null}
                          {postingStatusLabel(pmt.postingStatus)}
                        </span>
                        <span className="text-[9.5px] text-slate-400">
                          DOS {formatShortDate(pmt.professionalClaim?.dateOfServiceFrom)}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* ───────────── Middle: ledger ───────────── */}
        <main className="flex-1 overflow-y-auto bg-slate-50">
          {selected ? (
            <div className="mx-auto max-w-[1000px] p-4">
              {/* Claim header */}
              <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
                <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10.5px] font-medium uppercase tracking-wide text-slate-500">
                        {selected.professionalClaim?.claimNumber
                          ? `Claim ${selected.professionalClaim.claimNumber}`
                          : `ERA ${selected.claimControlNumber}`}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${postingStatusPill(
                          selected.postingStatus,
                        )}`}
                      >
                        {postingStatusLabel(selected.postingStatus)}
                      </span>
                      {selected.claimMatchStatus !== "matched" ? (
                        <span className="inline-flex items-center gap-1 rounded bg-rose-50 px-1.5 py-0.5 text-[9.5px] font-semibold text-rose-700 ring-1 ring-rose-200">
                          Unmatched
                        </span>
                      ) : null}
                    </div>
                    <h1 className="mt-1 truncate text-[18px] font-semibold tracking-tight text-slate-900">
                      {selected.client?.displayName ?? "Unmatched patient"}
                      <span className="ml-2 text-[12px] font-normal text-slate-500">
                        {selected.payer.name}
                      </span>
                    </h1>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                      <span>
                        DOS {formatDate(selected.professionalClaim?.dateOfServiceFrom)}
                        {selected.professionalClaim?.dateOfServiceTo &&
                        selected.professionalClaim.dateOfServiceTo !==
                          selected.professionalClaim.dateOfServiceFrom
                          ? ` – ${formatShortDate(selected.professionalClaim.dateOfServiceTo)}`
                          : null}
                      </span>
                      <Dot className="h-3 w-3 text-slate-300" />
                      <span>ERA {selected.claimControlNumber}</span>
                      {selected.checkNumber ? (
                        <>
                          <Dot className="h-3 w-3 text-slate-300" />
                          <span>Check {selected.checkNumber}</span>
                        </>
                      ) : null}
                      <Dot className="h-3 w-3 text-slate-300" />
                      <span>Received {formatDate(selected.importedAt)}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                      ERA payment
                    </div>
                    <div className="text-[26px] font-bold tabular-nums tracking-tight text-emerald-700">
                      {money(selected.paymentAmount)}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      of {money(selected.totalCharge)} billed
                    </div>
                  </div>
                </div>

                {/* Chronology rail */}
                <Chronology events={deriveChronology(selected)} />
              </div>

              {selected.claimMatchStatus !== "matched" ? (
                <div className="mt-4 flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" strokeWidth={2.2} />
                  <div className="flex-1 text-[12px] text-rose-800">
                    <div className="font-semibold">
                      This ERA payment is not matched to a claim.
                    </div>
                    <div className="text-rose-700/90">
                      Match it manually before posting. Searching by claim # {selected.claimControlNumber} or
                      payer-assigned ID {selected.payerClaimControlNumber ?? "—"} usually resolves
                      this.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleMatchClaim(selected.id)}
                    disabled={matchingId === selected.id}
                    className="shrink-0 rounded border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                  >
                    {matchingId === selected.id ? "Matching…" : "Match claim →"}
                  </button>
                </div>
              ) : null}

              {/* Service-line ledger trees */}
              <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/60 px-4 py-2">
                  <div>
                    <div className="text-[12px] font-semibold text-slate-900">
                      Transaction ledger
                    </div>
                    <div className="text-[10.5px] text-slate-500">
                      {selectedLedger?.length ?? 0} service line
                      {selectedLedger?.length === 1 ? "" : "s"} · expand to view financial events
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (!selectedLedger) return;
                        const allOpen = selectedLedger.every(
                          (l) => expandedLines[`${selected.id}:${l.index}`],
                        );
                        const next: Record<string, boolean> = { ...expandedLines };
                        for (const l of selectedLedger) {
                          next[`${selected.id}:${l.index}`] = !allOpen;
                        }
                        setExpandedLines(next);
                      }}
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[10px] font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Expand all
                    </button>
                  </div>
                </div>

                {(selectedLedger ?? []).length === 0 ? (
                  <div className="px-4 py-6 text-center text-[12px] text-slate-500">
                    No service-line breakdown provided in ERA.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {(selectedLedger ?? []).map((line) => {
                      const key = `${selected.id}:${line.index}`;
                      const isOpen = expandedLines[key] ?? line.index === 0; // first open by default
                      return (
                        <LedgerLine
                          key={key}
                          line={line}
                          serviceDate={selected.professionalClaim?.dateOfServiceFrom}
                          isOpen={isOpen}
                          onToggle={() =>
                            setExpandedLines((m) => ({ ...m, [key]: !isOpen }))
                          }
                        />
                      );
                    })}
                  </div>
                )}

                {/* Inline interactions hint */}
                <div className="flex flex-wrap items-center gap-1 border-t border-slate-100 bg-slate-50/60 px-3 py-2 text-[10.5px] text-slate-500">
                  <span className="mr-1 font-medium text-slate-600">Inline actions:</span>
                  <InlineAction icon={Edit3} label="Edit patient resp." />
                  <InlineAction icon={SplitSquareHorizontal} label="Split payment" />
                  <InlineAction icon={ArrowRightLeft} label="Transfer balance" />
                  <InlineAction icon={FileText} label="Apply adjustment" />
                </div>
              </div>

              {postFeedback && postFeedback.id === selected.id ? (
                <div
                  className={`mt-3 rounded border px-3 py-2 text-[11.5px] ${
                    postFeedback.tone === "ok"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-rose-200 bg-rose-50 text-rose-700"
                  }`}
                >
                  {postFeedback.message}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-[12px] text-slate-500">
              <div>
                <Mail className="mx-auto mb-2 h-6 w-6 text-slate-300" strokeWidth={1.6} />
                Select an ERA from the work queue to view its ledger.
              </div>
            </div>
          )}
        </main>

        {/* ───────────── Right: sticky balancing rail ───────────── */}
        {selected ? (
          <aside className="hidden w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-slate-200 bg-white p-4 lg:flex">
            <BalancingRail
              balancing={balancing}
              ledger={selectedLedger}
              payment={selected}
            />

            <KeyFacts payment={selected} />

            <button
              type="button"
              onClick={() => handlePost(selected.id)}
              disabled={
                postingId === selected.id ||
                selected.postingStatus === "posted" ||
                selected.claimMatchStatus !== "matched"
              }
              className={`w-full rounded-md px-3 py-2 text-[12px] font-semibold transition ${
                selected.postingStatus === "posted"
                  ? "cursor-not-allowed bg-slate-100 text-slate-500"
                  : selected.claimMatchStatus !== "matched"
                    ? "cursor-not-allowed bg-slate-100 text-slate-400"
                    : postingId === selected.id
                      ? "cursor-wait bg-emerald-600 text-white"
                      : "bg-emerald-600 text-white hover:bg-emerald-700"
              }`}
            >
              {postingId === selected.id
                ? "Posting…"
                : selected.postingStatus === "posted"
                  ? "✓ Posted to ledger"
                  : selected.claimMatchStatus !== "matched"
                    ? "Match claim to post"
                    : "Post payment to ledger"}
            </button>

            {selected.postingStatus === "posted" && selected.ledgerEntries.length > 0 ? (
              <div className="rounded border border-slate-200 bg-slate-50/50 p-2.5 text-[10.5px]">
                <div className="mb-1 font-semibold text-slate-700">Posted ledger entries</div>
                <ul className="space-y-1">
                  {selected.ledgerEntries.map((e, i) => (
                    <li key={i} className="flex justify-between gap-2 tabular-nums">
                      <span className="truncate text-slate-600">
                        {e.entryType.replace(/_/g, " ")}
                        {e.groupCode || e.reasonCode ? (
                          <span className="ml-1 text-slate-400">
                            ({[e.groupCode, e.reasonCode].filter(Boolean).join("-")})
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={
                          e.entryType === "insurance_payment"
                            ? "text-emerald-700"
                            : e.entryType === "patient_responsibility"
                              ? "text-orange-700"
                              : "text-slate-500"
                        }
                      >
                        {money(e.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Subcomponents                                                            */
/* ──────────────────────────────────────────────────────────────────────── */

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "emerald" | "amber" | "rose" | "orange" | "slate";
}) {
  const tones: Record<typeof tone, string> = {
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    rose: "text-rose-700",
    orange: "text-orange-700",
    slate: "text-slate-900",
  } as const;
  return (
    <div className="bg-white px-3.5 py-2">
      <div className={`text-[18px] font-bold tabular-nums tracking-tight ${tones[tone]}`}>
        {value}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
        {sub ? <span className="text-slate-400 normal-case">· {sub}</span> : null}
      </div>
    </div>
  );
}

function Chronology({ events }: { events: ChronoEvent[] }) {
  if (events.length === 0) return null;
  return (
    <ol className="flex items-stretch overflow-x-auto px-4 py-2.5">
      {events.map((ev, i) => (
        <li key={i} className="flex min-w-0 flex-1 items-start gap-2 pr-3">
          <div className="flex flex-col items-center pt-0.5">
            {ev.state === "done" ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.4} />
            ) : ev.state === "current" ? (
              <Circle className="h-3.5 w-3.5 animate-pulse text-amber-500" strokeWidth={2.4} />
            ) : (
              <Circle className="h-3.5 w-3.5 text-slate-300" strokeWidth={2} />
            )}
            {i < events.length - 1 ? (
              <div
                className={`mt-0.5 w-px flex-1 ${
                  ev.state === "done" ? "bg-emerald-200" : "bg-slate-200"
                }`}
                style={{ minHeight: 18 }}
              />
            ) : null}
          </div>
          <div className="min-w-0 flex-1 pb-1.5">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[10px] font-medium tabular-nums text-slate-500">
                {formatShortDate(ev.date)}
              </span>
              {ev.amount !== undefined ? (
                <span className="text-[10.5px] font-semibold tabular-nums text-slate-700">
                  {money(ev.amount)}
                </span>
              ) : null}
            </div>
            <div className="truncate text-[11.5px] font-medium text-slate-800">
              {ev.label}
            </div>
            {ev.detail ? (
              <div className="truncate text-[10px] text-slate-500">{ev.detail}</div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function LedgerLine({
  line,
  serviceDate,
  isOpen,
  onToggle,
}: {
  line: ServiceLineLedger;
  serviceDate?: string | null;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const balanceTone =
    line.balance === 0
      ? "text-emerald-700"
      : line.balance > 0
        ? "text-rose-700"
        : "text-slate-500";

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-label={`${isOpen ? "Collapse" : "Expand"} ledger for service line ${line.procedureCode ?? line.index + 1}`}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-slate-50"
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-slate-500" strokeWidth={2.2} />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-slate-500" strokeWidth={2.2} />
        )}
        <span className="font-mono text-[10.5px] font-semibold text-slate-700">
          {line.procedureCode ?? "—"}
        </span>
        <span className="text-[10.5px] text-slate-500">
          DOS {formatShortDate(serviceDate)}
        </span>
        <span className="text-[10.5px] text-slate-400">·</span>
        <span className="text-[10.5px] text-slate-500 tabular-nums">
          Charged {money(line.charged)}
        </span>
        <div className="flex-1" />
        <span className="text-[10.5px] tabular-nums text-slate-500">
          Bal&nbsp;
          <span className={`font-semibold ${balanceTone}`}>{money(line.balance)}</span>
        </span>
        {line.balance === 0 ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-600" strokeWidth={2.4} />
        ) : null}
      </button>

      {isOpen ? (
        <div className="border-t border-slate-100 bg-slate-50/40 px-3 py-1.5">
          <table className="w-full text-[12px] tabular-nums">
            <tbody>
              {line.events.map((ev, i) => {
                const isCharge = ev.kind === "charge";
                const isAllowed = ev.kind === "allowed";
                const isPay = ev.kind === "insurance_payment";
                const isAdj = ev.kind === "contractual_adjustment";
                const isPt = ev.kind === "patient_responsibility";

                const labelColor = isAllowed ? "text-slate-400" : "text-slate-700";
                const amountColor = isPay
                  ? "text-emerald-700 font-semibold"
                  : isAdj
                    ? "text-slate-500"
                    : isPt
                      ? "text-orange-700 font-semibold"
                      : isCharge
                        ? "text-slate-900 font-semibold"
                        : "text-slate-400";

                return (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="w-5 py-1 align-top">
                      <span
                        className={`mt-1 inline-block h-1.5 w-1.5 rounded-full ${
                          isPay
                            ? "bg-emerald-500"
                            : isAdj
                              ? "bg-slate-400"
                              : isPt
                                ? "bg-orange-500"
                                : isCharge
                                  ? "bg-slate-900"
                                  : "bg-slate-300"
                        }`}
                      />
                    </td>
                    <td className={`py-1 pr-2 ${labelColor}`}>
                      {ev.label}
                      {ev.codeBadge ? (
                        <span className="ml-1.5 inline-flex items-center rounded-sm bg-slate-200 px-1 py-px font-mono text-[9.5px] font-semibold text-slate-600">
                          {ev.codeBadge}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1 text-right">
                      {isAllowed ? (
                        <span className="text-[11px] text-slate-400">
                          {money(ev.amount)}
                        </span>
                      ) : (
                        <span className={amountColor}>{money(ev.amount, { signed: true })}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {/* Balance footer */}
              <tr className="bg-slate-100/60">
                <td />
                <td className="py-1.5 pr-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                  Line balance
                </td>
                <td className={`py-1.5 text-right text-[13px] font-bold ${balanceTone}`}>
                  {money(line.balance)}
                  {line.balance === 0 ? (
                    <CheckCircle2 className="ml-1 inline h-3 w-3 -translate-y-px text-emerald-600" strokeWidth={2.6} />
                  ) : null}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function BalancingRail({
  balancing,
  ledger,
  payment,
}: {
  balancing: { eraTotal: number; applied: number; remaining: number } | null;
  ledger: ServiceLineLedger[] | null;
  payment: EraPaymentItem;
}) {
  if (!balancing) return null;
  const isBalanced = Math.abs(balancing.remaining) < 0.005;
  const totalCharged = ledger?.reduce((s, l) => s + l.charged, 0) ?? payment.totalCharge;
  const totalPaid = ledger?.reduce((s, l) => s + l.paid, 0) ?? 0;
  const totalAdj = ledger?.reduce((s, l) => s + l.adjusted, 0) ?? 0;
  const totalPt = ledger?.reduce((s, l) => s + l.patientResp, 0) ?? payment.patientResponsibility;
  const lineBalance = +(totalCharged - totalPaid - totalAdj - totalPt).toFixed(2);

  return (
    <div className="sticky top-0 rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Balancing rail
        </div>
      </div>
      <div className="space-y-2 px-3 py-3 text-[12px] tabular-nums">
        <Row label="ERA total" value={money(balancing.eraTotal)} bold />
        <Row label="Applied to claim" value={money(balancing.applied)} tone="emerald" />
        <div className="border-t border-dashed border-slate-200" />
        <Row
          label="Remaining to apply"
          value={money(balancing.remaining)}
          tone={isBalanced ? "emerald" : "rose"}
          bold
        />
        <div
          className={`mt-1.5 flex items-center justify-center gap-1.5 rounded-md py-1 text-[11px] font-semibold ${
            isBalanced
              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
              : "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
          }`}
        >
          {isBalanced ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.4} /> Balanced
            </>
          ) : (
            <>
              <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.4} /> Out of balance
            </>
          )}
        </div>
      </div>
      <div className="border-t border-slate-200 px-3 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Claim totals
        </div>
        <div className="mt-1.5 space-y-1 text-[11.5px] tabular-nums">
          <Row label="Charges" value={money(totalCharged)} small />
          <Row label="Insurance paid" value={money(-totalPaid, { signed: true })} small tone="emerald" />
          <Row
            label="Adjustments"
            value={money(-totalAdj, { signed: true })}
            small
            tone="slate"
          />
          <Row
            label="Patient resp."
            value={money(totalPt, { signed: true })}
            small
            tone="orange"
          />
          <div className="border-t border-slate-200 pt-1">
            <Row
              label="Claim balance"
              value={money(lineBalance)}
              small
              tone={Math.abs(lineBalance) < 0.005 ? "emerald" : "rose"}
              bold
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  small,
  tone = "slate",
}: {
  label: string;
  value: string;
  bold?: boolean;
  small?: boolean;
  tone?: "slate" | "emerald" | "rose" | "orange";
}) {
  const tones = {
    slate: "text-slate-800",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    orange: "text-orange-700",
  } as const;
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={`${small ? "text-[11px]" : ""} text-slate-500`}>{label}</span>
      <span className={`${tones[tone]} ${bold ? "font-bold" : "font-medium"}`}>{value}</span>
    </div>
  );
}

function KeyFacts({ payment }: { payment: EraPaymentItem }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        ERA details
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2.5 text-[11px]">
        <Fact term="Payer" def={payment.payer.name} />
        <Fact
          term="Patient"
          def={payment.client?.displayName ?? "Unmatched"}
        />
        <Fact term="Claim #" def={payment.professionalClaim?.claimNumber ?? "—"} />
        <Fact term="Match" def={payment.claimMatchStatus} />
        <Fact term="ERA #" def={payment.claimControlNumber} />
        <Fact term="Check #" def={payment.checkNumber ?? "—"} />
      </dl>
    </div>
  );
}

function Fact({ term, def }: { term: string; def: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9.5px] font-medium uppercase tracking-wide text-slate-400">
        {term}
      </dt>
      <dd className="truncate text-[11px] text-slate-800">{def}</dd>
    </div>
  );
}

function InlineAction({
  icon: Icon,
  label,
}: {
  icon: typeof Edit3;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled
      title="Coming soon — use the chart's claim editor to make these adjustments today"
      className="inline-flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-[10px] text-slate-400 cursor-not-allowed"
    >
      <Icon className="h-3 w-3" strokeWidth={2.2} />
      {label}
    </button>
  );
}
