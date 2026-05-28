"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import {
  ChevronLeft,
  RefreshCw,
  PlayCircle,
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import styles from "../era.module.css";

/* ─── Types — match /api/billing/era-batches/[id] response ────────────── */

interface ValidationIssue {
  severity: "blocking" | "warning";
  code: string;
  field: string;
  message: string;
}
interface Suggestion {
  category: string;
  action: "auto_apply" | "review" | "block_until_acknowledged";
  confidence: number;
  field: string;
  suggestedValue: number | string | null;
  reason: string;
  conflict: string | null;
  sourceCas: Array<{ groupCode: string; reasonCode: string; amount: number }>;
}
interface CasAdjustment {
  groupCode: string | null;
  reasonCode: string | null;
  amount: number;
}
interface ServiceLine {
  procedure_code?: string;
  procedureCode?: string;
  charge?: number;
  paid?: number;
  allowed?: number;
}
interface ProfessionalClaim {
  id: string;
  claimNumber: string | null;
  claimStatus: string | null;
  dateOfServiceFrom: string | null;
  dateOfServiceTo: string | null;
  totalCharge: number;
}
interface Client {
  id: string;
  displayName: string;
}
interface ClaimPayment {
  id: string;
  eraImportBatchId: string;
  clp01ClaimControlNumber: string;
  clp02ClaimStatusCode: string | null;
  payerClaimControlNumber: string | null;
  totalCharge: number;
  paymentAmount: number;
  patientResponsibility: number;
  claimMatchStatus: string;
  postingStatus: string;
  casAdjustments: CasAdjustment[];
  serviceLines: ServiceLine[];
  rawSegments: string[];
  professionalClaim: ProfessionalClaim | null;
  client: Client | null;
  validation: { blocking: ValidationIssue[]; warning: ValidationIssue[] };
  suggestions: Suggestion[];
}
interface Adjustment {
  id: string;
  scope: "claim_level" | "provider_level" | "service_line";
  adjustmentType: string;
  groupCode: string | null;
  reasonCode: string | null;
  referenceId: string | null;
  amount: number;
  description: string | null;
  source: string;
  postedAt: string | null;
  eraClaimPaymentId: string | null;
  professionalClaimId: string | null;
}
interface BatchDetail {
  id: string;
  source: string;
  fileName: string | null;
  importStatus: string;
  payer: { identifier: string | null; name: string };
  eftOrCheckNumber: string | null;
  paymentMethodCode: string | null;
  paymentDate: string | null;
  receivedAt: string | null;
  rawContent: string;
  parsedSummary: Record<string, unknown> | null;
  archivedAt: string | null;
  summary: {
    totalPaymentAmount: number;
    totalAllocated: number;
    totalAdjustments: number;
    unallocated: number;
    totalClaims: number;
    matched: number;
    unmatched: number;
    posted: number;
    blocked: number;
  };
}

interface BatchResponse {
  success: boolean;
  batch: BatchDetail;
  claimPayments: ClaimPayment[];
  adjustments: Adjustment[];
  error?: string;
}

interface MatchCandidate {
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
  strategy: string;
  reasons: string[];
}

/* ──────────────────────────────────────────────────────────────────────── */

function currency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

interface EditedFields {
  paymentAmount?: number;
  patientResponsibility?: number;
}

const ADJUSTMENT_TYPES = [
  "interest",
  "sequestration",
  "recoupment",
  "forwarding_balance",
  "incentive",
  "capitation",
  "patient_responsibility_transfer",
  "contractual_obligation",
  "denial",
  "reversal",
  "refund",
  "unapplied_credit",
  "other",
];

export default function EraPosterClient({ batchId }: { batchId: string }) {
  const organizationId = DEFAULT_ORG_ID;
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [claimPayments, setClaimPayments] = useState<ClaimPayment[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, EditedFields>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [matchModalFor, setMatchModalFor] = useState<string | null>(null);
  const [matchCandidates, setMatchCandidates] = useState<MatchCandidate[]>([]);
  const [matchLoading, setMatchLoading] = useState(false);
  const [posting, setPosting] = useState<string | null>(null);
  const [autoMatching, setAutoMatching] = useState(false);
  const [activeRawId, setActiveRawId] = useState<string | null>(null);
  const [adjustmentDraft, setAdjustmentDraft] = useState<{
    scope: "claim_level" | "provider_level" | "service_line";
    adjustmentType: string;
    amount: string;
    description: string;
    eraClaimPaymentId: string | null;
  }>({
    scope: "claim_level",
    adjustmentType: "interest",
    amount: "",
    description: "",
    eraClaimPaymentId: null,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(`/api/billing/era-batches/${batchId}`, window.location.origin);
      url.searchParams.set("organizationId", organizationId);
      const res = await fetch(url.toString());
      const json: BatchResponse = await res.json();
      if (!json.success) throw new Error(json.error ?? "Failed to load batch");
      setBatch(json.batch);
      setClaimPayments(json.claimPayments ?? []);
      setAdjustments(json.adjustments ?? []);
      setSelectedId((prev) => prev ?? json.claimPayments?.[0]?.id ?? null);
      setActiveRawId((prev) => prev ?? json.claimPayments?.[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load batch");
    } finally {
      setLoading(false);
    }
  }, [batchId, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const editedRow = (row: ClaimPayment): ClaimPayment => {
    const e = edits[row.id];
    if (!e) return row;
    return {
      ...row,
      paymentAmount: e.paymentAmount ?? row.paymentAmount,
      patientResponsibility: e.patientResponsibility ?? row.patientResponsibility,
    };
  };

  const updateEdit = (id: string, field: keyof EditedFields, value: number) => {
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [field]: value } }));
  };

  const resetEdit = (id: string) => {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const applySuggestion = (row: ClaimPayment, s: Suggestion) => {
    if (typeof s.suggestedValue !== "number") return;
    if (s.field === "deductible" || s.field === "coinsurance" || s.field === "copay") {
      const next = (edits[row.id]?.patientResponsibility ?? row.patientResponsibility) + 0;
      void next;
    }
    if (s.field === "clp05_patient_responsibility") {
      updateEdit(row.id, "patientResponsibility", s.suggestedValue);
    }
    setFlash(`Applied suggestion: ${s.reason}`);
  };

  const autoMatch = async () => {
    setAutoMatching(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/era-batches/${batchId}/auto-match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Auto-match failed");
      setFlash(`Auto-matched ${json.bound}/${json.processed} unmatched ERA claim payments.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Auto-match failed");
    } finally {
      setAutoMatching(false);
    }
  };

  const openMatchModal = async (eraClaimPaymentId: string) => {
    setMatchModalFor(eraClaimPaymentId);
    setMatchCandidates([]);
    setMatchLoading(true);
    try {
      const url = new URL(
        `/api/billing/era-payments/${eraClaimPaymentId}/match/suggestions`,
        window.location.origin,
      );
      url.searchParams.set("organizationId", organizationId);
      const res = await fetch(url.toString());
      const json = await res.json();
      if (json.success) {
        const merged: MatchCandidate[] = [];
        if (json.exact) merged.push(json.exact);
        for (const c of json.probable ?? []) merged.push(c);
        setMatchCandidates(merged);
      }
    } finally {
      setMatchLoading(false);
    }
  };

  const bindMatch = async (eraClaimPaymentId: string, candidate: MatchCandidate) => {
    try {
      const res = await fetch(`/api/billing/era-payments/${eraClaimPaymentId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          professionalClaimId: candidate.professionalClaimId,
          clientId: candidate.clientId,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Bind failed");
      setFlash("Match bound.");
      setMatchModalFor(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bind failed");
    }
  };

  const postOne = async (row: ClaimPayment) => {
    setPosting(row.id);
    setError(null);
    try {
      const e = edits[row.id];
      const overrides = e
        ? {
            paymentAmount: e.paymentAmount,
            patientResponsibility: e.patientResponsibility,
          }
        : undefined;
      const res = await fetch(`/api/billing/era-payments/${row.id}/post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, overrides }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Post failed");
      setFlash(`Posted ${row.clp01ClaimControlNumber}.`);
      resetEdit(row.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Post failed");
    } finally {
      setPosting(null);
    }
  };

  const postAllReady = async () => {
    const ready = claimPayments.filter(
      (r) =>
        r.postingStatus === "ready" &&
        r.claimMatchStatus === "matched" &&
        r.validation.blocking.length === 0,
    );
    if (ready.length === 0) {
      setFlash("Nothing ready to post.");
      return;
    }
    if (!window.confirm(`Post ${ready.length} claim payment(s)?`)) return;
    let ok = 0;
    let fail = 0;
    for (const row of ready) {
      try {
        const e = edits[row.id];
        const overrides = e
          ? { paymentAmount: e.paymentAmount, patientResponsibility: e.patientResponsibility }
          : undefined;
        const res = await fetch(`/api/billing/era-payments/${row.id}/post`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, overrides }),
        });
        const json = await res.json();
        if (json.success) ok += 1;
        else fail += 1;
      } catch {
        fail += 1;
      }
    }
    setFlash(`Posted ${ok}, failed ${fail}.`);
    await load();
  };

  const addAdjustment = async () => {
    const amt = Number(adjustmentDraft.amount);
    if (!Number.isFinite(amt) || amt === 0) {
      setError("Amount must be non-zero");
      return;
    }
    try {
      const res = await fetch("/api/billing/payment-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          scope: adjustmentDraft.scope,
          adjustmentType: adjustmentDraft.adjustmentType,
          amount: amt,
          description: adjustmentDraft.description || null,
          eraImportBatchId: batchId,
          eraClaimPaymentId: adjustmentDraft.eraClaimPaymentId,
          source: "manual",
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Create adjustment failed");
      setAdjustmentDraft({
        scope: "claim_level",
        adjustmentType: "interest",
        amount: "",
        description: "",
        eraClaimPaymentId: null,
      });
      await load();
      setFlash("Adjustment added.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create adjustment failed");
    }
  };

  const deleteAdjustment = async (id: string) => {
    if (!window.confirm("Delete adjustment?")) return;
    const url = new URL(`/api/billing/payment-adjustments/${id}`, window.location.origin);
    url.searchParams.set("organizationId", organizationId);
    await fetch(url.toString(), { method: "DELETE" });
    await load();
  };

  const rawByPaymentId = useMemo(() => {
    const map = new Map<string, { anchor: string; lines: string[] }>();
    for (const row of claimPayments) {
      map.set(row.id, {
        anchor: row.clp01ClaimControlNumber,
        lines: row.rawSegments ?? [],
      });
    }
    return map;
  }, [claimPayments]);

  const renderRawPanel = () => {
    if (!batch) return null;
    const blocks = claimPayments.map((row) => {
      const segments = rawByPaymentId.get(row.id)?.lines ?? [];
      const isActive = activeRawId === row.id;
      return (
        <div
          key={row.id}
          id={`raw-${row.id}`}
          className={`${styles.jumpAnchor} ${isActive ? styles.active : ""}`}
        >
          <div className={styles.tinyLabel}>
            CLP {row.clp01ClaimControlNumber}
            {row.payerClaimControlNumber ? ` · ICN ${row.payerClaimControlNumber}` : ""}
          </div>
          {segments.length > 0 ? (
            segments.map((seg, i) => (
              <div key={i} className={styles.mono} style={{ fontSize: 10 }}>
                {seg}
              </div>
            ))
          ) : (
            <div className={styles.muted} style={{ fontSize: 10 }}>(no raw segments captured)</div>
          )}
        </div>
      );
    });
    return (
      <>
        <div className={styles.tinyLabel} style={{ marginBottom: 6 }}>835 envelope</div>
        <div className={styles.mono} style={{ fontSize: 10, marginBottom: 12 }}>
          {(batch.rawContent ?? "").split("~").slice(0, 6).join("~\n")}…
        </div>
        <div className={styles.tinyLabel} style={{ marginBottom: 6 }}>Per-claim segments</div>
        {blocks}
      </>
    );
  };

  if (loading && !batch) {
    return <div className={styles.page}><div className={styles.emptyState}>Loading ERA…</div></div>;
  }
  if (!batch) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyState}>
          {error ?? "Batch not found."}
          <div style={{ marginTop: 12 }}>
            <Link href="/billing/era-import" className={styles.btn}>← Back to ERA Import</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/billing/era-import" className={styles.btnGhost}>
          <ChevronLeft size={14} /> ERA Import
        </Link>
        <div className={styles.title}>{batch.payer.name}</div>
        <span className={styles.crumb}>
          EFT <span className={styles.mono}>{batch.eftOrCheckNumber ?? "—"}</span> ·{" "}
          {formatDate(batch.paymentDate)} · {currency(batch.summary.totalPaymentAmount)}
        </span>
        <div className={styles.spacer} />
        <button className={styles.btn} onClick={() => void load()} disabled={loading}>
          <RefreshCw size={12} /> Refresh
        </button>
        <button className={styles.btn} onClick={() => void autoMatch()} disabled={autoMatching}>
          <Sparkles size={12} /> Auto-match
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void postAllReady()}>
          <PlayCircle size={12} /> Post all ready
        </button>
      </header>

      {error ? <div className={styles.errorBanner}>{error}</div> : null}
      {flash ? <div className={styles.flashBanner}>{flash}</div> : null}

      <div className={styles.summaryBar}>
        <div className={styles.summaryCell}>
          <span className={styles.summaryLabel}>Total payment</span>
          <span className={styles.summaryValue}>{currency(batch.summary.totalPaymentAmount)}</span>
        </div>
        <div className={styles.summaryCell}>
          <span className={styles.summaryLabel}>Allocated</span>
          <span className={`${styles.summaryValue} ${styles.summaryValuePositive}`}>
            {currency(batch.summary.totalAllocated)}
          </span>
        </div>
        <div className={styles.summaryCell}>
          <span className={styles.summaryLabel}>Unallocated</span>
          <span
            className={`${styles.summaryValue} ${
              batch.summary.unallocated > 0.01
                ? styles.summaryValueWarn
                : batch.summary.unallocated < -0.01
                ? styles.summaryValueNegative
                : ""
            }`}
          >
            {currency(batch.summary.unallocated)}
          </span>
        </div>
        <div className={styles.summaryCell}>
          <span className={styles.summaryLabel}>Adjustments</span>
          <span className={styles.summaryValue}>{currency(batch.summary.totalAdjustments)}</span>
        </div>
        <div className={styles.summaryCell}>
          <span className={styles.summaryLabel}>Claims</span>
          <span className={styles.summaryValue}>
            {batch.summary.matched}/{batch.summary.totalClaims} matched
          </span>
        </div>
        <div className={styles.summaryCell}>
          <span className={styles.summaryLabel}>Posted</span>
          <span className={styles.summaryValue}>
            {batch.summary.posted}/{batch.summary.totalClaims}
          </span>
        </div>
        <div className={styles.summaryCell}>
          <span className={styles.summaryLabel}>Blocked</span>
          <span
            className={`${styles.summaryValue} ${batch.summary.blocked > 0 ? styles.summaryValueNegative : ""}`}
          >
            {batch.summary.blocked}
          </span>
        </div>
      </div>

      <div className={styles.posterBody}>
        <div className={styles.posterMain}>
          <table className={styles.postingTable}>
            <thead>
              <tr>
                <th>Client / Claim</th>
                <th>CLP01 / ICN</th>
                <th>DOS</th>
                <th className={styles.numCell}>Charge</th>
                <th className={styles.numCell}>Paid</th>
                <th className={styles.numCell}>Pt resp</th>
                <th>CAS</th>
                <th>Suggestions</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {claimPayments.map((rawRow) => {
                const row = editedRow(rawRow);
                const e = edits[row.id];
                const isModified = Boolean(e);
                const isBlocked = row.validation.blocking.length > 0;
                const isPosted = row.postingStatus === "posted";
                const rowClass = isPosted
                  ? styles.posted
                  : isBlocked
                  ? styles.blocked
                  : isModified
                  ? styles.modified
                  : selectedId === row.id
                  ? styles.selected
                  : "";
                return (
                  <tr
                    key={row.id}
                    className={rowClass}
                    onClick={() => {
                      setSelectedId(row.id);
                      setActiveRawId(row.id);
                      const el = document.getElementById(`raw-${row.id}`);
                      if (el) el.scrollIntoView({ block: "nearest" });
                    }}
                  >
                    <td>
                      {row.client?.displayName ?? <span className={styles.muted}>Unmatched client</span>}
                      <div className={`${styles.muted} ${styles.mono}`} style={{ fontSize: 10 }}>
                        {row.professionalClaim?.claimNumber ?? "—"}
                      </div>
                    </td>
                    <td>
                      <div className={styles.mono}>{row.clp01ClaimControlNumber}</div>
                      {row.payerClaimControlNumber ? (
                        <div className={`${styles.muted} ${styles.mono}`} style={{ fontSize: 10 }}>
                          ICN {row.payerClaimControlNumber}
                        </div>
                      ) : null}
                    </td>
                    <td>{formatDate(row.professionalClaim?.dateOfServiceFrom)}</td>
                    <td className={styles.numCell}>{currency(row.totalCharge)}</td>
                    <td className={styles.numCell}>
                      <input
                        className={`${styles.inlineInput} ${
                          e?.paymentAmount !== undefined ? styles.modified : ""
                        } ${isBlocked ? styles.blocking : ""} ${isPosted ? styles.disabled : ""}`}
                        type="number"
                        step="0.01"
                        disabled={isPosted}
                        value={row.paymentAmount}
                        onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                          updateEdit(row.id, "paymentAmount", Number(ev.target.value))
                        }
                        onKeyDown={(ev: KeyboardEvent<HTMLInputElement>) => {
                          if (ev.key === "Enter") {
                            ev.preventDefault();
                            (ev.target as HTMLInputElement).blur();
                            setFlash(`Committed paymentAmount for ${rawRow.clp01ClaimControlNumber}.`);
                          } else if (ev.key === "Escape") {
                            ev.preventDefault();
                            resetEdit(rawRow.id);
                            (ev.target as HTMLInputElement).blur();
                          }
                        }}
                      />
                    </td>
                    <td className={styles.numCell}>
                      <input
                        className={`${styles.inlineInput} ${
                          e?.patientResponsibility !== undefined ? styles.modified : ""
                        } ${isPosted ? styles.disabled : ""}`}
                        type="number"
                        step="0.01"
                        disabled={isPosted}
                        value={row.patientResponsibility}
                        onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                          updateEdit(row.id, "patientResponsibility", Number(ev.target.value))
                        }
                        onKeyDown={(ev: KeyboardEvent<HTMLInputElement>) => {
                          if (ev.key === "Enter") {
                            ev.preventDefault();
                            (ev.target as HTMLInputElement).blur();
                            setFlash(`Committed patientResponsibility for ${rawRow.clp01ClaimControlNumber}.`);
                          } else if (ev.key === "Escape") {
                            ev.preventDefault();
                            resetEdit(rawRow.id);
                            (ev.target as HTMLInputElement).blur();
                          }
                        }}
                      />
                    </td>
                    <td className={styles.mono} style={{ fontSize: 10 }}>
                      {row.casAdjustments.length === 0 ? (
                        <span className={styles.muted}>—</span>
                      ) : (
                        row.casAdjustments.map((adj, i) => (
                          <div key={i}>
                            {adj.groupCode}-{adj.reasonCode} {currency(adj.amount)}
                          </div>
                        ))
                      )}
                    </td>
                    <td>
                      {row.suggestions.length === 0 ? (
                        <span className={styles.muted}>—</span>
                      ) : (
                        <div className={styles.suggestionsList}>
                          {row.suggestions.slice(0, 3).map((s, i) => (
                            <div
                              key={i}
                              className={`${styles.suggestionRow} ${
                                s.action === "review"
                                  ? styles.review
                                  : s.action === "block_until_acknowledged"
                                  ? styles.block
                                  : ""
                              }`}
                              title={s.reason}
                            >
                              <span className={styles.tinyLabel}>{s.category}</span>
                              <span className={styles.mono} style={{ fontSize: 10 }}>
                                {typeof s.suggestedValue === "number"
                                  ? currency(s.suggestedValue)
                                  : s.suggestedValue ?? ""}
                              </span>
                              <span className={styles.spacer} />
                              {s.action !== "block_until_acknowledged" ? (
                                <button
                                  className={styles.btnGhost}
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    applySuggestion(rawRow, s);
                                  }}
                                >
                                  Apply
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {row.validation.blocking.length > 0 ? (
                        <span title={row.validation.blocking.map((b) => b.message).join("\n")}>
                          <span className={`${styles.validationDot} ${styles.block}`} />
                          <span className={styles.tagBlock}>{row.validation.blocking.length} blocking</span>
                        </span>
                      ) : row.validation.warning.length > 0 ? (
                        <span title={row.validation.warning.map((w) => w.message).join("\n")}>
                          <span className={`${styles.validationDot} ${styles.warn}`} />
                          <span className={styles.tagWarn}>{row.validation.warning.length} warning</span>
                        </span>
                      ) : (
                        <span>
                          <span className={`${styles.validationDot} ${styles.ok}`} />
                          <span className={styles.tagInfo}>{row.postingStatus}</span>
                        </span>
                      )}
                      <div className={styles.tinyLabel}>{row.claimMatchStatus}</div>
                    </td>
                    <td>
                      <div className={styles.row}>
                        {row.claimMatchStatus !== "matched" ? (
                          <button
                            className={styles.btn}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              void openMatchModal(row.id);
                            }}
                          >
                            Match…
                          </button>
                        ) : null}
                        {!isPosted ? (
                          <button
                            className={`${styles.btn} ${styles.btnPrimary}`}
                            disabled={isBlocked || posting === row.id}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              void postOne(rawRow);
                            }}
                          >
                            Post
                          </button>
                        ) : (
                          <CheckCircle2 size={14} color="#166534" />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className={styles.adjustmentsSection}>
            <div className={styles.adjustmentsHeader}>
              <strong>Claim / provider-level adjustments</strong>
              <span className={styles.tinyLabel}>
                interest · sequestration · recoupment · capitation · refunds · etc.
              </span>
            </div>

            <table className={styles.adjustmentsTable}>
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Type</th>
                  <th>Group/Reason</th>
                  <th>Description</th>
                  <th className={styles.numCell}>Amount</th>
                  <th>Ref</th>
                  <th>Posted</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {adjustments.length === 0 ? (
                  <tr>
                    <td colSpan={8} className={styles.muted} style={{ padding: 12 }}>
                      No claim or provider-level adjustments recorded.
                    </td>
                  </tr>
                ) : (
                  adjustments.map((a) => (
                    <tr key={a.id}>
                      <td>{a.scope}</td>
                      <td>{a.adjustmentType}</td>
                      <td className={styles.mono}>
                        {[a.groupCode, a.reasonCode].filter(Boolean).join("-") || "—"}
                      </td>
                      <td>{a.description ?? "—"}</td>
                      <td className={styles.numCell}>{currency(a.amount)}</td>
                      <td className={styles.mono}>{a.referenceId ?? "—"}</td>
                      <td>{formatDate(a.postedAt)}</td>
                      <td>
                        <button className={styles.btnGhost} onClick={() => void deleteAdjustment(a.id)}>
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
                <tr>
                  <td>
                    <select
                      className={styles.smallSelect}
                      value={adjustmentDraft.scope}
                      onChange={(e) =>
                        setAdjustmentDraft({
                          ...adjustmentDraft,
                          scope: e.target.value as typeof adjustmentDraft.scope,
                        })
                      }
                    >
                      <option value="claim_level">claim_level</option>
                      <option value="provider_level">provider_level</option>
                      <option value="service_line">service_line</option>
                    </select>
                  </td>
                  <td>
                    <select
                      className={styles.smallSelect}
                      value={adjustmentDraft.adjustmentType}
                      onChange={(e) =>
                        setAdjustmentDraft({ ...adjustmentDraft, adjustmentType: e.target.value })
                      }
                    >
                      {ADJUSTMENT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={styles.muted}>—</td>
                  <td>
                    <input
                      className={styles.inlineInput}
                      style={{ width: 160, textAlign: "left" }}
                      placeholder="Description"
                      value={adjustmentDraft.description}
                      onChange={(e) =>
                        setAdjustmentDraft({ ...adjustmentDraft, description: e.target.value })
                      }
                    />
                  </td>
                  <td className={styles.numCell}>
                    <input
                      className={styles.inlineInput}
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      value={adjustmentDraft.amount}
                      onChange={(e) =>
                        setAdjustmentDraft({ ...adjustmentDraft, amount: e.target.value })
                      }
                    />
                  </td>
                  <td className={styles.muted}>—</td>
                  <td className={styles.muted}>—</td>
                  <td>
                    <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void addAdjustment()}>
                      <Plus size={12} /> Add
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <aside className={styles.posterPanel}>
          <div className={styles.posterPanelHeader}>
            Raw 835
            <span className={styles.spacer} />
            <span className={styles.tinyLabel}>{batch.fileName ?? "inline"}</span>
          </div>
          <div className={styles.posterPanelBody}>{renderRawPanel()}</div>
        </aside>
      </div>

      {matchModalFor ? (
        <div className={styles.modalScrim} onClick={() => setMatchModalFor(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>Match candidate claims</div>
            {matchLoading ? (
              <div className={styles.muted}>Searching…</div>
            ) : matchCandidates.length === 0 ? (
              <div className={styles.muted}>
                <AlertTriangle size={12} /> No probable matches. Try opening the claim manually from the 837P
                queue and posting from there.
              </div>
            ) : (
              <table className={styles.adjustmentsTable}>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Claim #</th>
                    <th>DOS</th>
                    <th className={styles.numCell}>Charge</th>
                    <th className={styles.numCell}>Confidence</th>
                    <th>Why</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {matchCandidates.map((c) => (
                    <tr key={c.professionalClaimId}>
                      <td>{c.patientDisplayName ?? "—"}</td>
                      <td className={styles.mono}>{c.claimNumber ?? "—"}</td>
                      <td>{formatDate(c.dateOfServiceFrom)}</td>
                      <td className={styles.numCell}>{currency(c.totalCharge)}</td>
                      <td className={styles.numCell}>{Math.round(c.confidence * 100)}%</td>
                      <td className={styles.muted}>{c.reasons.join(" · ")}</td>
                      <td>
                        <button
                          className={`${styles.btn} ${styles.btnPrimary}`}
                          onClick={() => void bindMatch(matchModalFor, c)}
                        >
                          Bind
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className={styles.modalActions}>
              <button className={styles.btn} onClick={() => setMatchModalFor(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
