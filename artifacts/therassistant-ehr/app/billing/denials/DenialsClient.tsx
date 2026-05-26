"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DEFAULT_ORG_ID } from "@/lib/config";

// ─── Types ───────────────────────────────────────────────────────────────────

interface DenialRow {
  id: string;
  claimId: string;
  claimNumber: string;
  claimStatus: string;
  clientId: string;
  clientName: string;
  payerName: string;
  providerName: string | null;
  dateOfService: string | null;
  totalCharge: number;
  allowedAmount: number;
  adjustmentAmount: number;
  patientResponsibility: number;
  payerPaid: number;
  amountPaid: number;
  denialReasonCode: string | null;
  denialReasonDescription: string | null;
  appealDeadline: string | null;
  correctionStatus: string | null;
  billingNotes: string | null;
  submittedAt: string | null;
  createdAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getOrgId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function fmt$(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function deadlineBadge(iso: string | null): { color: string; label: string } | null {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (days < 0) return { color: "var(--danger)", label: `Expired ${Math.abs(days)}d ago` };
  if (days <= 14) return { color: "#7a5000", label: `${days}d left` };
  return { color: "var(--muted)", label: `${days}d left` };
}

// ─── Bill-to-Patient Confirm Modal ───────────────────────────────────────────

function BillToPatientModal({
  row,
  onClose,
  onDone,
}: {
  row: DenialRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orgId = useMemo(() => getOrgId(), []);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/claims/${row.claimId}/bill-to-patient`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId: orgId }),
        },
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Failed");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: "var(--card)",
          borderRadius: 10,
          width: "100%",
          maxWidth: 420,
          padding: "28px 24px 20px",
          boxShadow: "0 8px 32px rgba(16,36,63,.18)",
        }}
      >
        <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "var(--navy)" }}>
          Bill to Patient
        </h3>
        <p style={{ margin: "0 0 6px", fontSize: 13, color: "var(--text)" }}>
          Move <strong>{row.claimNumber}</strong> for <strong>{row.clientName}</strong> to the
          Patient Balances queue.
        </p>
        <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--muted)" }}>
          Patient responsibility: <strong>{fmt$(row.patientResponsibility > 0 ? row.patientResponsibility : row.totalCharge)}</strong>
          . The claim status will change to <em>patient responsibility</em>.
        </p>

        {error && (
          <p style={{ fontSize: 12, color: "var(--danger)", margin: "0 0 12px" }}>{error}</p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--card)", fontSize: 13, cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={busy}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "none",
              background: "var(--danger)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Moving…" : "Bill to Patient"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div
      style={{
        position: "fixed",
        bottom: 28,
        right: 28,
        background: "#1e5e40",
        color: "#fff",
        padding: "10px 18px",
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        zIndex: 200,
        maxWidth: 340,
      }}
    >
      {msg}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DenialsClient() {
  const router = useRouter();
  const [rows, setRows] = useState<DenialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [carcFilter, setCarcFilter] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [billModal, setBillModal] = useState<DenialRow | null>(null);

  const orgId = useMemo(() => getOrgId(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/denied-claims?organizationId=${encodeURIComponent(orgId)}`);
      const json = await res.json();
      if (json.success) setRows(json.rows ?? []);
      else setError(json.error ?? "Failed to load");
    } catch {
      setError("Network error loading denials");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const carcCodes = useMemo(() => {
    const codes = new Set<string>();
    rows.forEach((r) => { if (r.denialReasonCode) codes.add(r.denialReasonCode); });
    return Array.from(codes).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return rows.filter((r) => {
      const matchesSearch =
        !q ||
        r.clientName.toLowerCase().includes(q) ||
        r.claimNumber.toLowerCase().includes(q) ||
        r.payerName.toLowerCase().includes(q) ||
        (r.denialReasonCode?.toLowerCase().includes(q) ?? false) ||
        (r.denialReasonDescription?.toLowerCase().includes(q) ?? false);
      const matchesCarc = !carcFilter || r.denialReasonCode === carcFilter;
      return matchesSearch && matchesCarc;
    });
  }, [rows, search, carcFilter]);

  // Summary
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          count: acc.count + 1,
          totalCharge: acc.totalCharge + r.totalCharge,
          byCarc: {
            ...acc.byCarc,
            [r.denialReasonCode ?? "—"]:
              (acc.byCarc[r.denialReasonCode ?? "—"] ?? 0) + 1,
          },
        }),
        { count: 0, totalCharge: 0, byCarc: {} as Record<string, number> },
      ),
    [rows],
  );

  const topCarc = useMemo(
    () =>
      Object.entries(totals.byCarc)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3),
    [totals.byCarc],
  );

  function handleCorrect(row: DenialRow) {
    router.push(`/billing/claims/${row.claimId}/correct`);
  }

  function handleAppeal(row: DenialRow) {
    router.push(`/billing/appeals?claimId=${encodeURIComponent(row.claimId)}`);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: "0 0 40px" }}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ padding: "24px 28px 0" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--navy)" }}>
          Denials
        </h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted)" }}>
          Claims denied by payer — correct, appeal, or bill to patient.
        </p>
      </div>

      {/* ── Summary Cards ────────────────────────────────────────────────── */}
      {!loading && rows.length > 0 && (
        <div style={{ display: "flex", gap: 12, padding: "16px 28px 0", flexWrap: "wrap" }}>
          <div style={summaryCard}>
            <div style={summaryLabel}>Total Denied</div>
            <div style={summaryValue}>{totals.count}</div>
            <div style={summaryNote}>open claims</div>
          </div>
          <div style={summaryCard}>
            <div style={summaryLabel}>Total Billed</div>
            <div style={summaryValue}>{fmt$(totals.totalCharge)}</div>
            <div style={summaryNote}>at risk</div>
          </div>
          {topCarc.map(([code, count]) => (
            <div key={code} style={summaryCard}>
              <div style={summaryLabel}>CARC {code}</div>
              <div style={{ ...summaryValue, fontSize: 20 }}>{count}</div>
              <div style={summaryNote}>{count === 1 ? "claim" : "claims"}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Filter Bar ───────────────────────────────────────────────────── */}
      <div style={{ padding: "16px 28px 0", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search patient, claim #, payer, CARC…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: "1 1 280px",
            maxWidth: 360,
            padding: "8px 12px",
            border: "1px solid var(--line)",
            borderRadius: 6,
            fontSize: 13,
            color: "var(--text)",
            background: "var(--card)",
          }}
        />
        {carcCodes.length > 0 && (
          <select
            value={carcFilter}
            onChange={(e) => setCarcFilter(e.target.value)}
            style={{
              padding: "8px 10px",
              border: "1px solid var(--line)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--text)",
              background: "var(--card)",
            }}
          >
            <option value="">All CARC codes</option>
            {carcCodes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={load}
          style={{
            padding: "8px 14px",
            border: "1px solid var(--line)",
            borderRadius: 6,
            background: "var(--card)",
            fontSize: 12,
            color: "var(--muted)",
            cursor: "pointer",
          }}
        >
          ↺ Refresh
        </button>
      </div>

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div style={{ padding: "12px 28px 0" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "var(--muted)", fontSize: 14 }}>
            Loading denials…
          </div>
        ) : error ? (
          <div style={{ textAlign: "center", padding: "40px 0", color: "var(--danger)", fontSize: 13 }}>
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "60px 20px",
              color: "var(--muted)",
              fontSize: 14,
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 8,
            }}
          >
            {rows.length === 0 ? "No denied claims found." : "No results match your filters."}
          </div>
        ) : (
          <div
            style={{
              overflowX: "auto",
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 8,
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                tableLayout: "fixed",
              }}
            >
              <colgroup>
                <col style={{ width: 150 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 95 }} />
                <col style={{ width: 95 }} />
                <col style={{ width: 95 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 95 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 170 }} />
              </colgroup>
              <thead>
                <tr style={{ background: "#fef2f2", borderBottom: "1px solid var(--line)" }}>
                  <th style={thStyle}>Patient Name</th>
                  <th style={thStyle}>Date of Service</th>
                  <th style={thStyle}>Provider</th>
                  <th style={thStyle}>CPT/HCPCS</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Charge</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Allowed</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Adjustment</th>
                  <th style={thStyle}>CARC/RARC</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Pt Resp</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Amt Paid</th>
                  <th style={thStyle}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, idx) => {
                  const deadline = deadlineBadge(row.appealDeadline);
                  return (
                    <tr
                      key={row.id}
                      style={{
                        background: idx % 2 === 0 ? "var(--card)" : "#fafafa",
                        borderBottom: "1px solid var(--line)",
                      }}
                    >
                      <td style={tdStyle}>
                        <Link
                          href={`/clients/${row.clientId}`}
                          style={{ color: "var(--navy)", fontWeight: 600, textDecoration: "none" }}
                        >
                          {row.clientName}
                        </Link>
                        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1 }}>
                          {row.claimNumber || "—"}
                        </div>
                        {deadline && (
                          <div
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              color: deadline.color,
                              marginTop: 2,
                              textTransform: "uppercase",
                              letterSpacing: ".03em",
                            }}
                          >
                            ⏱ {deadline.label}
                          </div>
                        )}
                      </td>
                      <td style={tdStyle}>{fmtDate(row.dateOfService)}</td>
                      <td style={{ ...tdStyle, color: "var(--muted)" }}>{row.providerName ?? "—"}</td>
                      <td style={{ ...tdStyle, color: "var(--muted)" }}>—</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{fmt$(row.totalCharge)}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{fmt$(row.allowedAmount)}</td>
                      <td style={{ ...tdStyle, textAlign: "right", color: "var(--muted)" }}>
                        {row.adjustmentAmount !== 0 ? fmt$(row.adjustmentAmount) : "—"}
                      </td>
                      <td style={tdStyle}>
                        {row.denialReasonCode ? (
                          <div>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "2px 6px",
                                borderRadius: 4,
                                background: "#fef2f2",
                                color: "var(--danger)",
                                fontSize: 10,
                                fontWeight: 700,
                                border: "1px solid #fecaca",
                              }}
                            >
                              {row.denialReasonCode}
                            </span>
                            {row.denialReasonDescription && (
                              <div
                                style={{
                                  fontSize: 9,
                                  color: "var(--muted)",
                                  marginTop: 2,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  maxWidth: 100,
                                }}
                                title={row.denialReasonDescription}
                              >
                                {row.denialReasonDescription}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {row.patientResponsibility > 0 ? fmt$(row.patientResponsibility) : "—"}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right", color: "var(--muted)" }}>
                        {row.amountPaid > 0 ? fmt$(row.amountPaid) : "—"}
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          <button
                            onClick={() => handleCorrect(row)}
                            style={actionBtn("var(--navy)")}
                            title="Edit & resubmit claim"
                          >
                            Correct
                          </button>
                          <button
                            onClick={() => handleAppeal(row)}
                            style={actionBtn("var(--sage)")}
                            title="File an appeal"
                          >
                            Appeal
                          </button>
                          <button
                            onClick={() => setBillModal(row)}
                            style={actionBtn("#7a5000")}
                            title="Bill the denied amount to the patient"
                          >
                            Bill Pt
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Bill-to-Patient Modal ────────────────────────────────────────── */}
      {billModal && (
        <BillToPatientModal
          row={billModal}
          onClose={() => setBillModal(null)}
          onDone={() => {
            setBillModal(null);
            setToast(`${billModal.clientName}'s claim moved to Patient Balances`);
            load();
          }}
        />
      )}

      {/* ── Toast ────────────────────────────────────────────────────────── */}
      {toast && <Toast msg={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

// ─── Shared Styles ────────────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
  padding: "8px 10px",
  textAlign: "left",
  fontSize: 10,
  fontWeight: 700,
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: ".05em",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "9px 10px",
  verticalAlign: "middle",
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const summaryCard: React.CSSProperties = {
  flex: "1 1 140px",
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: "12px 16px",
};
const summaryLabel: React.CSSProperties = {
  fontSize: 11,
  color: "var(--muted)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".05em",
};
const summaryValue: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  color: "var(--danger)",
  margin: "4px 0 2px",
};
const summaryNote: React.CSSProperties = { fontSize: 11, color: "var(--muted)" };

function actionBtn(bg: string): React.CSSProperties {
  return {
    padding: "4px 8px",
    border: "none",
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 700,
    background: bg,
    color: "#fff",
    cursor: "pointer",
    letterSpacing: ".03em",
    textTransform: "uppercase",
  };
}
