"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import styles from "./payments.module.css";

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
  professionalClaim: { id: string; claimNumber: string | null; claimStatus: string | null } | null;
  client: { id: string; displayName: string } | null;
  payer: { id: string | null; name: string };
  checkNumber: string | null;
  importedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function money(v: number) {
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
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

function postingStatusClass(status: string) {
  switch (status) {
    case "posted":
      return styles.qsPosted;
    case "ready":
      return styles.qsReady;
    case "blocked":
      return styles.qsException;
    case "partial":
      return styles.qsPartial;
    default:
      return styles.qsReview;
  }
}

function matchBadgeText(status: string) {
  if (status === "matched") return "Matched";
  if (status === "unmatched") return "Unmatched";
  return status;
}

export default function PaymentsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [tab, setTab] = useState<QueueTab>("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<EraPaymentItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [postFeedback, setPostFeedback] = useState<{ id: string; message: string; tone: "ok" | "err" } | null>(null);

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
      if (!res.ok || !json.success) throw new Error(json.error ?? `Request failed with ${res.status}`);
      const list = (json.items ?? []) as EraPaymentItem[];
      setItems(list);
      setSelectedId((prev) => prev && list.some((p) => p.id === prev) ? prev : list[0]?.id ?? null);
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
    if (tab === "matched") list = list.filter((p) => p.claimMatchStatus === "matched" && p.postingStatus !== "posted");
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

  const selected = useMemo(() => items.find((p) => p.id === selectedId) ?? null, [items, selectedId]);

  const kpi = useMemo(() => {
    const posted = items.filter((p) => p.postingStatus === "posted");
    const pending = items.filter((p) => p.postingStatus !== "posted");
    const blocked = items.filter((p) => p.postingStatus === "blocked" || p.claimMatchStatus !== "matched");
    const unapplied = items.filter((p) => p.claimMatchStatus === "matched" && p.postingStatus === "ready");
    const patientResp = items
      .filter((p) => p.postingStatus !== "posted")
      .reduce((s, p) => s + p.patientResponsibility, 0);
    return {
      postedTotal: money(posted.reduce((s, p) => s + p.paymentAmount, 0)),
      pendingCount: pending.length,
      unapplied: money(unapplied.reduce((s, p) => s + p.paymentAmount, 0)),
      pendingPatientResp: money(patientResp),
      blocked: blocked.length,
    };
  }, [items]);

  const handlePost = useCallback(
    async (id: string) => {
      setPostingId(id);
      setPostFeedback(null);
      try {
        const res = await fetch(`/api/billing/era-payments/${encodeURIComponent(id)}/post`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? json.errors?.[0]?.message ?? `Request failed with ${res.status}`);
        }
        const messageBits: string[] = [];
        if (json.alreadyPosted) messageBits.push("Already posted");
        else if (json.posted) messageBits.push("Payment posted");
        if (json.patientInvoiceCreated) messageBits.push("patient invoice created");
        if (json.workqueueItemsClosed > 0) messageBits.push(`${json.workqueueItemsClosed} workqueue item(s) closed`);
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

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.headerTitle}>Payments &amp; ERA</span>
        <div className={styles.headerSpacer} />
        <div className={styles.searchWrap}>
          <span className={styles.searchIcon}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          </span>
          <input className={styles.searchInput} placeholder="Search ERA claim #, patient, payer…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button type="button" className={styles.headerBtn} onClick={() => loadPayments()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <div className={styles.kpiRow}>
        <div className={styles.kpiCard}>
          <div className={`${styles.kpiValue} ${styles.kpiValueGreen}`}>{kpi.postedTotal}</div>
          <div className={styles.kpiLabel}>Posted (all-time)</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={`${styles.kpiValue} ${styles.kpiValueBlue}`}>{kpi.pendingCount}</div>
          <div className={styles.kpiLabel}>Pending ERAs</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={`${styles.kpiValue} ${styles.kpiValueAmber}`}>{kpi.unapplied}</div>
          <div className={styles.kpiLabel}>Ready to Post</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiValue}>{kpi.pendingPatientResp}</div>
          <div className={styles.kpiLabel}>Pending Pt. Responsibility</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={`${styles.kpiValue} ${styles.kpiValueRed}`}>{kpi.blocked}</div>
          <div className={styles.kpiLabel}>Blocked / Unmatched</div>
        </div>
      </div>

      {error ? <div style={{ padding: 12, color: "#B91C1C", fontSize: 12 }}>Error: {error}</div> : null}

      <div className={styles.body}>
        <div className={styles.queuePanel}>
          <div className={styles.queueTabs}>
            {(["all", "matched", "unmatched", "blocked", "posted"] as QueueTab[]).map((t) => (
              <button
                key={t}
                type="button"
                className={tab === t ? `${styles.queueTab} ${styles.queueTabActive}` : styles.queueTab}
                onClick={() => setTab(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div className={`${styles.queueList} text-[10px]`}>
            {loading && items.length === 0 ? (
              <div style={{ padding: 16, fontSize: 12, color: "#64748B" }}>Loading ERA payments…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 16, fontSize: 12, color: "#64748B" }}>No ERA payments match this filter.</div>
            ) : (
              filtered.map((pmt) => (
                <div
                  key={pmt.id}
                  className={`${styles.queueRow} ${selectedId === pmt.id ? styles.queueRowSelected : ""}`}
                  onClick={() => setSelectedId(pmt.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(pmt.id); }}
                >
                  <div className={`${styles.queueRowIcon} ${styles.queueRowIconEra}`}>
                    <span style={{ fontSize: 11, fontWeight: 700 }}>ERA</span>
                  </div>
                  <div className={styles.queueRowMain}>
                    <div className={styles.queueRowTop}>
                      <span className={styles.queueRowSource}>{pmt.claimControlNumber}</span>
                      <span className={styles.queueRowAmount}>{money(pmt.paymentAmount)}</span>
                    </div>
                    <div className={styles.queueRowMeta}>
                      {pmt.payer.name}
                      <span>·</span>
                      <span>{pmt.client?.displayName ?? "Unmatched"}</span>
                      <span>·</span>
                      <span>{formatDate(pmt.importedAt ?? pmt.createdAt)}</span>
                      <span className={`${styles.queueRowStatus} ${postingStatusClass(pmt.postingStatus)}`}>
                        {postingStatusLabel(pmt.postingStatus)}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className={styles.detailPanel}>
          {selected ? (
            <div className={styles.detailScroll}>
              <div className={styles.paymentSummaryCard}>
                <div className={styles.paymentSummaryHeader}>
                  <div className={styles.paymentSummaryTitle}>
                    ERA {selected.claimControlNumber}
                    {selected.professionalClaim?.claimNumber
                      ? ` · Claim ${selected.professionalClaim.claimNumber}`
                      : ""}
                  </div>
                  <span className={`${styles.paymentSummaryBadge} ${postingStatusClass(selected.postingStatus)}`}>
                    {postingStatusLabel(selected.postingStatus)}
                  </span>
                </div>
                <div className={styles.paymentSummaryMeta}>
                  <div className={styles.paymentSummaryField}>
                    <span className={styles.fieldLabel}>Payment</span>
                    <span className={styles.fieldValueLarge}>{money(selected.paymentAmount)}</span>
                  </div>
                  <div className={styles.paymentSummaryField}>
                    <span className={styles.fieldLabel}>Total Charge</span>
                    <span className={styles.fieldValue}>{money(selected.totalCharge)}</span>
                  </div>
                  <div className={styles.paymentSummaryField}>
                    <span className={styles.fieldLabel}>Patient Resp.</span>
                    <span className={styles.fieldValue}>{money(selected.patientResponsibility)}</span>
                  </div>
                  <div className={styles.paymentSummaryField}>
                    <span className={styles.fieldLabel}>Payer</span>
                    <span className={styles.fieldValue}>{selected.payer.name}</span>
                  </div>
                  {selected.client ? (
                    <div className={styles.paymentSummaryField}>
                      <span className={styles.fieldLabel}>Patient</span>
                      <span className={styles.fieldValue}>{selected.client.displayName}</span>
                    </div>
                  ) : null}
                  <div className={styles.paymentSummaryField}>
                    <span className={styles.fieldLabel}>Match Status</span>
                    <span className={styles.fieldValue}>{matchBadgeText(selected.claimMatchStatus)}</span>
                  </div>
                  <div className={styles.paymentSummaryField}>
                    <span className={styles.fieldLabel}>Received</span>
                    <span className={styles.fieldValue}>{formatDate(selected.importedAt ?? selected.createdAt)}</span>
                  </div>
                  {selected.checkNumber ? (
                    <div className={styles.paymentSummaryField}>
                      <span className={styles.fieldLabel}>Check / Trace</span>
                      <span className={styles.fieldValue}>{selected.checkNumber}</span>
                    </div>
                  ) : null}
                </div>
              </div>

              {selected.claimMatchStatus !== "matched" ? (
                <div className={styles.exceptionCard}>
                  <span className={styles.exceptionIcon}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                  </span>
                  <div className={styles.exceptionBody}>
                    <div className={styles.exceptionText}>
                      ⚠ This ERA payment is not matched to a claim and cannot be posted.
                    </div>
                  </div>
                </div>
              ) : null}

              <div className={styles.sectionPanel}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionTitle}>Service Lines</span>
                </div>
                <table className={styles.ledger}>
                  <thead>
                    <tr>
                      <th>CPT</th>
                      <th>Charge</th>
                      <th>Allowed</th>
                      <th>Paid</th>
                      <th>Adj</th>
                      <th>Code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.serviceLines.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", color: "#64748B", padding: 12 }}>
                          No service-line breakdown provided in ERA.
                        </td>
                      </tr>
                    ) : (
                      selected.serviceLines.map((line, i) => (
                        <tr key={i}>
                          <td className={styles.ledgerCpt}>{line.procedureCode ?? "—"}</td>
                          <td>{line.charge.toFixed(2)}</td>
                          <td>{line.allowed.toFixed(2)}</td>
                          <td className={line.paid > 0 ? styles.ledgerPaid : styles.ledgerZero}>{line.paid.toFixed(2)}</td>
                          <td className={line.adjustment > 0 ? styles.ledgerAdj : styles.ledgerZero}>{line.adjustment > 0 ? line.adjustment.toFixed(2) : "—"}</td>
                          <td>{line.adjustmentCode ?? "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className={styles.sectionPanel}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionTitle}>Posting Ledger</span>
                </div>
                <table className={styles.ledger}>
                  <thead>
                    <tr>
                      <th>Entry</th>
                      <th>Group</th>
                      <th>Reason</th>
                      <th>Amount</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.ledgerEntries.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: "center", color: "#64748B", padding: 12 }}>
                          No ledger entries yet — post this payment to create them.
                        </td>
                      </tr>
                    ) : (
                      selected.ledgerEntries.map((entry, i) => (
                        <tr key={i}>
                          <td>{entry.entryType}</td>
                          <td>{entry.groupCode ?? "—"}</td>
                          <td>{entry.reasonCode ?? "—"}</td>
                          <td className={entry.entryType === "insurance_payment" ? styles.ledgerPaid : entry.entryType === "patient_responsibility" ? styles.ledgerPtResp : styles.ledgerAdj}>
                            {entry.amount.toFixed(2)}
                          </td>
                          <td>{entry.description ?? "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>

                <div className={styles.postingActions}>
                  <button
                    type="button"
                    className={`${styles.postBtn} ${styles.postBtnPrimary}`}
                    onClick={() => handlePost(selected.id)}
                    disabled={
                      postingId === selected.id ||
                      selected.postingStatus === "posted" ||
                      selected.claimMatchStatus !== "matched"
                    }
                  >
                    {postingId === selected.id
                      ? "Posting…"
                      : selected.postingStatus === "posted"
                      ? "Already Posted"
                      : "Post Payment"}
                  </button>
                </div>

                {postFeedback && postFeedback.id === selected.id ? (
                  <div
                    style={{
                      marginTop: 8,
                      padding: "8px 12px",
                      borderRadius: 6,
                      fontSize: 12,
                      background: postFeedback.tone === "ok" ? "#ECFDF5" : "#FEF2F2",
                      color: postFeedback.tone === "ok" ? "#065F46" : "#B91C1C",
                      border: `1px solid ${postFeedback.tone === "ok" ? "#A7F3D0" : "#FECACA"}`,
                    }}
                  >
                    {postFeedback.message}
                  </div>
                ) : null}
              </div>

              {selected.casAdjustments.length > 0 ? (
                <div className={styles.sectionPanel}>
                  <div className={styles.sectionHeader}>
                    <span className={styles.sectionTitle}>CAS Adjustments (from 835)</span>
                  </div>
                  <table className={styles.ledger}>
                    <thead>
                      <tr>
                        <th>Group</th>
                        <th>Reason</th>
                        <th>Amount</th>
                        <th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.casAdjustments.map((adj, i) => (
                        <tr key={i}>
                          <td>{adj.groupCode ?? "—"}</td>
                          <td>{adj.reasonCode ?? "—"}</td>
                          <td>{adj.amount.toFixed(2)}</td>
                          <td>{adj.description ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : (
            <div className={styles.detailEmpty}>
              <div className={styles.detailEmptyIcon}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2" /><line x1="1" y1="10" x2="23" y2="10" /></svg>
              </div>
              <div className={styles.detailEmptyText}>Select an ERA payment to view detail and post</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
