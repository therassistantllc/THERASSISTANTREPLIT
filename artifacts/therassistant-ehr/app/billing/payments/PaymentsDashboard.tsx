"use client";

/**
 * Master Payment Posting Dashboard (Task #111 / PP-5).
 *
 * Replaces the top of `/billing/payments` with a unified ERA + manual +
 * patient payments view. Filter chip bar + drawer, totals strip, unified
 * rows table with selection + bulk-action toolbar.
 *
 * The legacy PaymentsClient is reachable via the "Classic ERA queue" tab
 * below the dashboard so the existing detailed ERA workflow remains
 * available while the new dashboard handles cross-source ops.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import PaymentsClient from "./PaymentsClient";
import PaymentRowActions from "./PaymentRowActions";

type PaymentSource = "era" | "manual_insurance" | "patient";

interface DashboardRow {
  id: string;
  source: PaymentSource;
  paymentType: "insurance" | "patient";
  postingStatus: string;
  payerName: string | null;
  clientId: string | null;
  professionalClaimId: string | null;
  checkNumber: string | null;
  amount: number;
  depositDate: string | null;
  paymentDate: string | null;
  importedAt: string | null;
  remainingRecoupable: number | null;
}

interface DashboardTotals {
  imported: number;
  posted: number;
  unmatched: number;
  unapplied: number;
  denied: number;
  recoupments: number;
  refunds: number;
  pendingReview: number;
  amountPosted: number;
  amountPending: number;
}

interface DashboardResponse {
  rows: DashboardRow[];
  totals: DashboardTotals;
  rowCount: number;
}

interface Filters {
  paymentSource: PaymentSource[];
  paymentType: "" | "insurance" | "patient";
  postingStatus: string[];
  depositDateFrom: string;
  depositDateTo: string;
  paymentDateFrom: string;
  paymentDateTo: string;
  eraImportDateFrom: string;
  eraImportDateTo: string;
  eftCheckNumber: string;
  clientId: string;
  payerProfileId: string;
  providerNpi: string;
}

const EMPTY_FILTERS: Filters = {
  paymentSource: [],
  paymentType: "",
  postingStatus: [],
  depositDateFrom: "",
  depositDateTo: "",
  paymentDateFrom: "",
  paymentDateTo: "",
  eraImportDateFrom: "",
  eraImportDateTo: "",
  eftCheckNumber: "",
  clientId: "",
  payerProfileId: "",
  providerNpi: "",
};

function fmtMoney(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function fmtDate(s: string | null) {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function getOrgId() {
  if (typeof window === "undefined")
    return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function buildQueryString(orgId: string, f: Filters): string {
  const p = new URLSearchParams();
  p.set("organizationId", orgId);
  if (f.paymentSource.length) p.set("paymentSource", f.paymentSource.join(","));
  if (f.paymentType) p.set("paymentType", f.paymentType);
  if (f.postingStatus.length) p.set("postingStatus", f.postingStatus.join(","));
  if (f.depositDateFrom) p.set("depositDateFrom", f.depositDateFrom);
  if (f.depositDateTo) p.set("depositDateTo", f.depositDateTo);
  if (f.paymentDateFrom) p.set("paymentDateFrom", f.paymentDateFrom);
  if (f.paymentDateTo) p.set("paymentDateTo", f.paymentDateTo);
  if (f.eftCheckNumber) p.set("eftCheckNumber", f.eftCheckNumber);
  if (f.clientId) p.set("clientId", f.clientId);
  if (f.payerProfileId) p.set("payerProfileId", f.payerProfileId);
  if (f.providerNpi) p.set("providerNpi", f.providerNpi);
  if (f.eraImportDateFrom) p.set("eraImportDateFrom", f.eraImportDateFrom);
  if (f.eraImportDateTo) p.set("eraImportDateTo", f.eraImportDateTo);
  return p.toString();
}

const POSTING_STATUS_OPTIONS = [
  "pending",
  "ready",
  "posted",
  "partial",
  "blocked",
  "exception",
  "reversed",
  "voided",
];

const SOURCE_OPTIONS: { value: PaymentSource; label: string }[] = [
  { value: "era", label: "ERA 835" },
  { value: "manual_insurance", label: "Manual Insurance" },
  { value: "patient", label: "Patient" },
];

export default function PaymentsDashboard() {
  const orgId = useMemo(() => getOrgId(), []);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [showLegacy, setShowLegacy] = useState(false);
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);
  const [flash, setFlash] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);
  const [recoupTarget, setRecoupTarget] = useState<DashboardRow | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = buildQueryString(orgId, filters);
      const r = await fetch(`/api/billing/payments/dashboard?${qs}`, {
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "Dashboard load failed");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [orgId, filters]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleRow = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!data) return;
    if (selected.size === data.rows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(data.rows.map((r) => r.id)));
    }
  };

  const runBulk = async (path: string, extra: Record<string, unknown> = {}) => {
    if (selected.size === 0) return;
    setBusy(path);
    setFlash(null);
    try {
      const r = await fetch(`/api/billing/payments/bulk/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: orgId,
          ids: [...selected],
          ...extra,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "Bulk action failed");
      setFlash({
        tone: j.failed === 0 ? "ok" : "err",
        msg: `${path}: applied ${j.applied ?? 0}${j.failed ? `, failed ${j.failed}` : ""}`,
      });
      setSelected(new Set());
      await refresh();
    } catch (e) {
      setFlash({ tone: "err", msg: e instanceof Error ? e.message : "Bulk action failed" });
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = () => {
    const qs = buildQueryString(orgId, filters);
    window.open(`/api/billing/payments/export?${qs}`, "_blank");
  };

  const toggleSourceChip = (s: PaymentSource) => {
    setFilters((f) => {
      const has = f.paymentSource.includes(s);
      return {
        ...f,
        paymentSource: has
          ? f.paymentSource.filter((x) => x !== s)
          : [...f.paymentSource, s],
      };
    });
  };

  const clearFilters = () => setFilters(EMPTY_FILTERS);

  const totals = data?.totals;

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Payments — Master Dashboard</h1>
        <p style={{ margin: "4px 0 0", color: "#6b7280", fontSize: 13 }}>
          Unified view of ERA 835, manual insurance, and patient payments. Filter, select, and act in bulk.
        </p>
      </header>

      {/* Filter chip bar */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        {SOURCE_OPTIONS.map((s) => {
          const active = filters.paymentSource.includes(s.value);
          return (
            <button
              key={s.value}
              onClick={() => toggleSourceChip(s.value)}
              style={chipStyle(active)}
            >
              {s.label}
            </button>
          );
        })}
        <span style={{ width: 1, height: 20, background: "#e5e7eb" }} />
        {POSTING_STATUS_OPTIONS.slice(0, 5).map((st) => {
          const active = filters.postingStatus.includes(st);
          return (
            <button
              key={st}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  postingStatus: active
                    ? f.postingStatus.filter((x) => x !== st)
                    : [...f.postingStatus, st],
                }))
              }
              style={chipStyle(active)}
            >
              {st}
            </button>
          );
        })}
        <button
          onClick={() => setShowFilterDrawer((v) => !v)}
          style={{ ...chipStyle(showFilterDrawer), marginLeft: 8 }}
        >
          More filters…
        </button>
        <button onClick={clearFilters} style={{ ...chipStyle(false), marginLeft: 4 }}>
          Clear
        </button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={refresh} style={btnStyle(false)} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button onClick={exportCsv} style={btnStyle(false)}>
            Export CSV
          </button>
        </div>
      </div>

      {/* Filter drawer */}
      {showFilterDrawer ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
            padding: 12,
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          <Field label="Payment type">
            <select
              value={filters.paymentType}
              onChange={(e) =>
                setFilters((f) => ({ ...f, paymentType: e.target.value as Filters["paymentType"] }))
              }
              style={inputStyle}
            >
              <option value="">Any</option>
              <option value="insurance">Insurance</option>
              <option value="patient">Patient</option>
            </select>
          </Field>
          <Field label="EFT / check #">
            <input
              type="text"
              value={filters.eftCheckNumber}
              onChange={(e) => setFilters((f) => ({ ...f, eftCheckNumber: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="Client ID">
            <input
              type="text"
              value={filters.clientId}
              onChange={(e) => setFilters((f) => ({ ...f, clientId: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="Payer Profile ID">
            <input
              type="text"
              value={filters.payerProfileId}
              onChange={(e) => setFilters((f) => ({ ...f, payerProfileId: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="Provider NPI">
            <input
              type="text"
              value={filters.providerNpi}
              onChange={(e) => setFilters((f) => ({ ...f, providerNpi: e.target.value }))}
              style={inputStyle}
              placeholder="rendering or billing NPI"
            />
          </Field>
          <Field label="ERA import date from">
            <input
              type="date"
              value={filters.eraImportDateFrom}
              onChange={(e) => setFilters((f) => ({ ...f, eraImportDateFrom: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="ERA import date to">
            <input
              type="date"
              value={filters.eraImportDateTo}
              onChange={(e) => setFilters((f) => ({ ...f, eraImportDateTo: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="Deposit date from">
            <input
              type="date"
              value={filters.depositDateFrom}
              onChange={(e) => setFilters((f) => ({ ...f, depositDateFrom: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="Deposit date to">
            <input
              type="date"
              value={filters.depositDateTo}
              onChange={(e) => setFilters((f) => ({ ...f, depositDateTo: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="Payment date from">
            <input
              type="date"
              value={filters.paymentDateFrom}
              onChange={(e) => setFilters((f) => ({ ...f, paymentDateFrom: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="Payment date to">
            <input
              type="date"
              value={filters.paymentDateTo}
              onChange={(e) => setFilters((f) => ({ ...f, paymentDateTo: e.target.value }))}
              style={inputStyle}
            />
          </Field>
        </div>
      ) : null}

      {/* Totals strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Stat label="Imported" value={totals?.imported ?? 0} />
        <Stat label="Posted" value={totals?.posted ?? 0} />
        <Stat label="Unmatched" value={totals?.unmatched ?? 0} />
        <Stat label="Unapplied" value={totals?.unapplied ?? 0} />
        <Stat label="Denied" value={totals?.denied ?? 0} tone="danger" />
        <Stat label="Recoupments" value={totals?.recoupments ?? 0} />
        <Stat label="Refunds" value={totals?.refunds ?? 0} />
        <Stat label="Pending review" value={totals?.pendingReview ?? 0} tone="warn" />
      </div>

      {/* Flash + error */}
      {flash ? (
        <div
          style={{
            padding: 8,
            background: flash.tone === "ok" ? "#ecfdf5" : "#fef2f2",
            color: flash.tone === "ok" ? "#065f46" : "#991b1b",
            border: `1px solid ${flash.tone === "ok" ? "#a7f3d0" : "#fecaca"}`,
            borderRadius: 6,
            marginBottom: 8,
            fontSize: 13,
          }}
        >
          {flash.msg}
        </div>
      ) : null}
      {error ? (
        <div style={{ padding: 8, color: "#991b1b", background: "#fef2f2", borderRadius: 6, marginBottom: 8 }}>
          {error}
        </div>
      ) : null}

      {/* Bulk action toolbar */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: 8,
          background: selected.size > 0 ? "#eff6ff" : "#f9fafb",
          border: "1px solid " + (selected.size > 0 ? "#bfdbfe" : "#e5e7eb"),
          borderRadius: 6,
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 13, color: "#374151", marginRight: "auto" }}>
          {selected.size} selected
        </span>
        <button
          onClick={() =>
            runBulk("defer", {
              until: new Date(Date.now() + 7 * 86400000).toISOString(),
              reason: "Deferred from dashboard",
            })
          }
          disabled={selected.size === 0 || busy !== null}
          style={btnStyle(false)}
        >
          Defer 7d
        </button>
        <button
          onClick={() => {
            const sid = window.prompt("Assign to staff id (blank to unassign):") ?? "";
            runBulk("assign", { assignedToStaffId: sid || null });
          }}
          disabled={selected.size === 0 || busy !== null}
          style={btnStyle(false)}
        >
          Assign…
        </button>
        <button
          onClick={() => runBulk("reprocess")}
          disabled={selected.size === 0 || busy !== null}
          style={btnStyle(false)}
        >
          Reprocess
        </button>
        <button
          onClick={async () => {
            if (selected.size === 0) return;
            setBusy("export");
            try {
              const r = await fetch(`/api/billing/payments/bulk/export`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: orgId, ids: [...selected] }),
              });
              if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                throw new Error(j?.error ?? "Export failed");
              }
              const blob = await r.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `payments-selected-${Date.now()}.csv`;
              a.click();
              URL.revokeObjectURL(url);
              setFlash({ tone: "ok", msg: `Exported ${selected.size} rows` });
            } catch (e) {
              setFlash({ tone: "err", msg: e instanceof Error ? e.message : "Export failed" });
            } finally {
              setBusy(null);
            }
          }}
          disabled={selected.size === 0 || busy !== null}
          style={btnStyle(false)}
        >
          Export selected
        </button>
        <button
          onClick={() => {
            const dupId = window.prompt("Mark as duplicate of (payment id, optional):") ?? "";
            if (!confirm(`Mark ${selected.size} payments as duplicate? They will be archived.`)) return;
            runBulk("mark-duplicate", { duplicateOfId: dupId || null });
          }}
          disabled={selected.size === 0 || busy !== null}
          style={btnStyle(false)}
        >
          Mark duplicate
        </button>
        <button
          onClick={() => {
            if (!confirm(`Archive ${selected.size} payments?`)) return;
            runBulk("archive", { reason: "Archived from dashboard" });
          }}
          disabled={selected.size === 0 || busy !== null}
          style={btnStyle(true)}
        >
          Archive
        </button>
      </div>

      {/* Unified rows table */}
      <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 6 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f3f4f6" }}>
              <th style={thStyle}>
                <input
                  type="checkbox"
                  checked={Boolean(data && selected.size === data.rows.length && data.rows.length > 0)}
                  onChange={toggleAll}
                />
              </th>
              <th style={thStyle}>Source</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Payer / Method</th>
              <th style={thStyle}>Claim</th>
              <th style={thStyle}>Check / Ref</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
              <th style={thStyle}>Deposit</th>
              <th style={thStyle}>Payment</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {!data || data.rows.length === 0 ? (
              <tr>
                <td colSpan={11} style={{ padding: 20, textAlign: "center", color: "#6b7280" }}>
                  {loading ? "Loading…" : "No payments match these filters."}
                </td>
              </tr>
            ) : (
              data.rows.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={tdStyle}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleRow(r.id)}
                    />
                  </td>
                  <td style={tdStyle}>{r.source}</td>
                  <td style={tdStyle}>{r.paymentType}</td>
                  <td style={tdStyle}>{r.postingStatus}</td>
                  <td style={tdStyle}>{r.payerName ?? "—"}</td>
                  <td style={tdStyle}>
                    {r.professionalClaimId ? r.professionalClaimId.slice(0, 8) : "—"}
                  </td>
                  <td style={tdStyle}>{r.checkNumber ?? "—"}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{fmtMoney(r.amount)}</td>
                  <td style={tdStyle}>{fmtDate(r.depositDate)}</td>
                  <td style={tdStyle}>{fmtDate(r.paymentDate)}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
                      <a
                        href={`/billing/payments/posted/${encodeURIComponent(r.id)}?organizationId=${orgId}`}
                        style={{ color: "#2563eb", textDecoration: "none", fontSize: 12 }}
                      >
                        Open →
                      </a>
                      <PaymentRowActions
                        row={{
                          id: r.id,
                          paymentType: r.paymentType,
                          postingStatus: r.postingStatus,
                          amount: r.amount,
                          payerName: r.payerName,
                          source: r.source,
                        }}
                        orgId={orgId}
                        onChanged={refresh}
                        onFlash={(tone, msg) => setFlash({ tone, msg })}
                      />
                      {r.postingStatus === "posted" &&
                      (r.source === "era" || r.source === "patient") &&
                      (r.remainingRecoupable === null || r.remainingRecoupable > 0) ? (
                        <button
                          onClick={() => setRecoupTarget(r)}
                          style={{
                            padding: "2px 8px",
                            fontSize: 11,
                            fontWeight: 500,
                            border: "1px solid #d1d5db",
                            borderRadius: 4,
                            background: "white",
                            color: "#374151",
                            cursor: "pointer",
                          }}
                          title="Record a payer recoupment against this posted payment"
                        >
                          Record Recoupment
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Legacy ERA queue (collapsible) */}
      <div style={{ marginTop: 24 }}>
        <button onClick={() => setShowLegacy((v) => !v)} style={btnStyle(false)}>
          {showLegacy ? "Hide" : "Show"} classic ERA queue
        </button>
        {showLegacy ? (
          <div style={{ marginTop: 12 }}>
            <PaymentsClient />
          </div>
        ) : null}
      </div>

      {recoupTarget ? (
        <RecoupmentModal
          row={recoupTarget}
          organizationId={orgId}
          onClose={() => setRecoupTarget(null)}
          onSuccess={(msg) => {
            setRecoupTarget(null);
            setFlash({ tone: "ok", msg });
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

// ── Record Recoupment modal ─────────────────────────────────────────────────

interface RecoupResult {
  success: boolean;
  recoupment?: {
    recoupmentId: string | null;
    ledgerEntryId: string | null;
    workqueueItemId: string | null;
  } | null;
  recoupmentId?: string | null;
  ledgerEntryId?: string | null;
  workqueueItemId?: string | null;
  errors?: Array<{ field: string; message: string }>;
  error?: string;
}

function RecoupmentModal({
  row,
  organizationId,
  onClose,
  onSuccess,
}: {
  row: DashboardRow;
  organizationId: string;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  // Live-validate against the authoritative remaining-recoupable balance
  // returned by the posted-payment detail endpoint. Falls back to the
  // dashboard's row-level snapshot if the detail fetch fails so the form
  // is still usable; the API itself enforces the final cap.
  const [remaining, setRemaining] = useState<number | null>(row.remainingRecoupable);
  const [loadingRemaining, setLoadingRemaining] = useState(true);
  const [amount, setAmount] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [reasonCode, setReasonCode] = useState<string>("");
  const [offsetEra, setOffsetEra] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingRemaining(true);
    (async () => {
      try {
        const r = await fetch(
          `/api/billing/payments/posted/${encodeURIComponent(row.id)}?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        );
        const j = await r.json();
        if (!r.ok || !j?.success) throw new Error(j?.error ?? "Failed to load payment");
        const total = Number(j.totalImpact ?? row.amount ?? 0);
        const recoupsUsed = (j.recoupments ?? []).reduce(
          (s: number, x: { amount?: number }) => s + Number(x.amount ?? 0),
          0,
        );
        const refundsUsed = (j.refunds ?? [])
          .filter((x: { refund_status?: string }) => x.refund_status !== "cancelled")
          .reduce((s: number, x: { amount?: number }) => s + Number(x.amount ?? 0), 0);
        const rem = Math.max(0, Math.round((total - recoupsUsed - refundsUsed) * 100) / 100);
        if (!cancelled) setRemaining(rem);
      } catch {
        if (!cancelled && row.remainingRecoupable !== null) {
          setRemaining(row.remainingRecoupable);
        }
      } finally {
        if (!cancelled) setLoadingRemaining(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.id, row.amount, row.remainingRecoupable, organizationId]);

  const amtNum = Number(amount);
  const amtValid =
    amount.trim().length > 0 &&
    Number.isFinite(amtNum) &&
    amtNum > 0 &&
    (remaining === null || amtNum <= remaining + 0.005);
  const reasonValid = reason.trim().length > 0;
  const canSubmit =
    !submitting && amtValid && reasonValid && !loadingRemaining && (remaining ?? 0) > 0;

  const submit = async () => {
    setSubmitting(true);
    setFormError(null);
    try {
      const r = await fetch(
        `/api/billing/payments/posted/${encodeURIComponent(row.id)}/recoup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            amount: amtNum,
            reason: reason.trim(),
            reasonCode: reasonCode.trim() || null,
            offsetEraClaimPaymentId: offsetEra.trim() || null,
          }),
        },
      );
      const j: RecoupResult = await r.json();
      if (!r.ok || !j.success) {
        const msg =
          j.errors?.[0]?.message ??
          j.error ??
          `Recoupment failed (HTTP ${r.status})`;
        throw new Error(msg);
      }
      const rec = j.recoupment ?? {
        recoupmentId: j.recoupmentId ?? null,
        ledgerEntryId: j.ledgerEntryId ?? null,
        workqueueItemId: j.workqueueItemId ?? null,
      };
      const parts: string[] = [`Recoupment ${fmtMoney(amtNum)} recorded`];
      if (rec.recoupmentId) parts.push(`id ${rec.recoupmentId.slice(0, 8)}`);
      if (rec.ledgerEntryId) parts.push(`ledger ${rec.ledgerEntryId.slice(0, 8)}`);
      if (rec.workqueueItemId) parts.push(`workqueue ${rec.workqueueItemId.slice(0, 8)}`);
      onSuccess(parts.join(" · "));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Recoupment failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 8,
          padding: 20,
          width: 460,
          maxWidth: "90vw",
          boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
        }}
      >
        <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 600 }}>
          Record Recoupment
        </h2>
        <p style={{ margin: "0 0 12px", color: "#6b7280", fontSize: 12 }}>
          Payer takeback against{" "}
          {row.source === "era" ? "ERA 835" : "patient payment"}{" "}
          {row.checkNumber ? `(${row.checkNumber})` : ""} · original{" "}
          {fmtMoney(row.amount)}
        </p>

        <div
          style={{
            padding: 8,
            background: "#f3f4f6",
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 12,
            color: "#374151",
          }}
        >
          Remaining recoupable:{" "}
          <strong>
            {loadingRemaining
              ? "loading…"
              : remaining === null
                ? "unknown"
                : fmtMoney(remaining)}
          </strong>
        </div>

        {!loadingRemaining && (remaining ?? 0) <= 0 ? (
          <div
            style={{
              padding: 10,
              background: "#fef3c7",
              color: "#92400e",
              borderRadius: 6,
              marginBottom: 12,
              fontSize: 13,
            }}
          >
            This payment has no remaining recoupable balance.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
              <Field label="Amount (USD)">
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  style={inputStyle}
                  autoFocus
                />
              </Field>
              <Field label="Reason">
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  style={{ ...inputStyle, minHeight: 60, fontFamily: "inherit" }}
                  placeholder="e.g. Payer recouped via check reversal — claim 12345"
                />
              </Field>
              <Field label="Reason code (optional)">
                <input
                  type="text"
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value)}
                  style={inputStyle}
                  placeholder="e.g. WO, J1"
                />
              </Field>
              <Field label="Offset ERA claim payment id (optional)">
                <input
                  type="text"
                  value={offsetEra}
                  onChange={(e) => setOffsetEra(e.target.value)}
                  style={inputStyle}
                  placeholder="uuid of ERA where this takeback is netted"
                />
              </Field>
              {amount.length > 0 && !amtValid ? (
                <div style={{ color: "#991b1b", fontSize: 12 }}>
                  {amtNum <= 0
                    ? "Amount must be greater than zero."
                    : remaining !== null && amtNum > remaining + 0.005
                      ? `Amount exceeds remaining recoupable balance of ${fmtMoney(remaining)}.`
                      : "Enter a valid amount."}
                </div>
              ) : null}
            </div>
          </>
        )}

        {formError ? (
          <div
            style={{
              padding: 8,
              background: "#fef2f2",
              color: "#991b1b",
              borderRadius: 6,
              marginBottom: 12,
              fontSize: 12,
            }}
          >
            {formError}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={btnStyle(false)} disabled={submitting}>
            Cancel
          </button>
          <button
            onClick={submit}
            style={{
              ...btnStyle(false),
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? "pointer" : "not-allowed",
              background: canSubmit ? "#2563eb" : "#9ca3af",
              color: "white",
              border: `1px solid ${canSubmit ? "#1d4ed8" : "#9ca3af"}`,
            }}
            disabled={!canSubmit}
          >
            {submitting ? "Recording…" : "Record Recoupment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── small inline style helpers ───────────────────────────────────────────────

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 500,
    border: `1px solid ${active ? "#2563eb" : "#d1d5db"}`,
    background: active ? "#dbeafe" : "white",
    color: active ? "#1e40af" : "#374151",
    cursor: "pointer",
  };
}

function btnStyle(danger: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 500,
    borderRadius: 6,
    border: `1px solid ${danger ? "#dc2626" : "#d1d5db"}`,
    background: danger ? "#fef2f2" : "white",
    color: danger ? "#991b1b" : "#111827",
    cursor: "pointer",
  };
}

const thStyle: React.CSSProperties = {
  padding: 8,
  textAlign: "left",
  fontWeight: 600,
  fontSize: 12,
  color: "#374151",
  borderBottom: "1px solid #e5e7eb",
};
const tdStyle: React.CSSProperties = { padding: 8, color: "#111827" };
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  border: "1px solid #d1d5db",
  borderRadius: 4,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", fontSize: 12, color: "#374151" }}>
      <span style={{ display: "block", marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "danger" | "warn";
}) {
  const colors: Record<string, { bg: string; fg: string }> = {
    default: { bg: "#f3f4f6", fg: "#111827" },
    danger: { bg: "#fef2f2", fg: "#991b1b" },
    warn: { bg: "#fffbeb", fg: "#92400e" },
  };
  const c = colors[tone];
  return (
    <div
      style={{
        padding: 10,
        background: c.bg,
        borderRadius: 6,
        border: "1px solid #e5e7eb",
      }}
    >
      <div style={{ fontSize: 11, color: c.fg, opacity: 0.8 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: c.fg }}>{value}</div>
    </div>
  );
}
