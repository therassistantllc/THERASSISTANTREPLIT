"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const DEFAULT_ORG_ID = "default";

type ChargeRow = {
  chargeId: string;
  claimId: string;
  patientName: string;
  dateOfService: string | null;
  providerName: string;
  cptCode: string;
  billedAmount: number;
  status: string;
  batchId: string;
  submitDate: string | null;
  notes: string;
};

type ChargeBatch = {
  id: string;
  batchNumber: string;
  status: string;
  claimCount: number;
  totalChargeAmount: number;
  submittedAt: string | null;
};

type Payload = {
  success: boolean;
  error?: string;
  clinicianOnly?: boolean;
  canManage?: boolean;
  practiceOptions?: Array<{ value: string; label: string }>;
  totals?: {
    totalUnbilledCharges: number;
    pendingBatches: number;
    readyToSubmit: number;
  };
  chargeRows?: ChargeRow[];
  batches?: ChargeBatch[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function formatMoney(value: number) {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

export default function ChargesClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(true);
  const [clinicianOnly, setClinicianOnly] = useState(false);
  const [practiceOptions, setPracticeOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [practice, setPractice] = useState("");
  const [chargeRows, setChargeRows] = useState<ChargeRow[]>([]);
  const [batches, setBatches] = useState<ChargeBatch[]>([]);
  const [totals, setTotals] = useState({ totalUnbilledCharges: 0, pendingBatches: 0, readyToSubmit: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      if (practice) params.set("practice", practice);
      const res = await fetch(`/api/billing/charges/batches?${params.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as Payload;
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load charges");
      setPracticeOptions(json.practiceOptions ?? []);
      setChargeRows(json.chargeRows ?? []);
      setBatches(json.batches ?? []);
      setTotals(json.totals ?? { totalUnbilledCharges: 0, pendingBatches: 0, readyToSubmit: 0 });
      setCanManage(json.canManage !== false);
      setClinicianOnly(Boolean(json.clinicianOnly));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load charges");
      setChargeRows([]);
      setBatches([]);
      setTotals({ totalUnbilledCharges: 0, pendingBatches: 0, readyToSubmit: 0 });
    } finally {
      setLoading(false);
    }
  }, [organizationId, practice]);

  useEffect(() => {
    void load();
  }, [load]);

  async function postAction(batchId: string, action: "submit" | "mark-submitted") {
    setBusyId(batchId);
    setError(null);
    setToast(null);
    try {
      const res = await fetch(`/api/billing/charges/batches/${encodeURIComponent(batchId)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? `Failed to ${action}`);
      setToast(action === "mark-submitted" ? "Batch marked submitted." : "Submission endpoint is pending; batch action recorded.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to ${action}`);
    } finally {
      setBusyId(null);
    }
  }

  function renderBatchActions(batchId: string) {
  if (!batchId) return "—";

  const batch = batches.find((b) => b.id === batchId);
  if (!batch) return "—";

  const downloadUrl = `/api/billing/charges/batches/${encodeURIComponent(batch.id)}/download?organizationId=${encodeURIComponent(organizationId)}`;

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <a
        className="button button-secondary"
        href={downloadUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        Download Batch
      </a>

      <button
        className="button button-secondary"
        type="button"
        onClick={() => void postAction(batch.id, "submit")}
        disabled={!canManage || busyId === batch.id}
      >
        Submit Batch
      </button>

      <button
        className="button"
        type="button"
        onClick={() => void postAction(batch.id, "mark-submitted")}
        disabled={!canManage || busyId === batch.id}
      >
        Mark Submitted
      </button>
    </div>
  );
}

  return (
    <div className="page-shell" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <section className="hero-card" style={{ padding: 16 }}>
        <h1 style={{ marginTop: 0, marginBottom: 6 }}>Charges Work Queue</h1>
        <p className="hero-copy" style={{ marginBottom: 0 }}>
          Charges are auto-batched by payer ID and billing provider TIN as claim-ready notes come in.
          Download 837 batches for Availity upload, then manually mark submitted while direct submission wiring is finalized.
        </p>
        {clinicianOnly ? (
          <p style={{ marginTop: 8, marginBottom: 0, fontSize: 12, color: "#475569" }}>
            Clinician scope active: only charges tied to your assigned practice/provider scope are shown.
          </p>
        ) : null}
      </section>

      <section className="card" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, color: "#64748b" }}>Total Unbilled Charges</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{formatMoney(totals.totalUnbilledCharges)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#64748b" }}>Pending Batches</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{totals.pendingBatches}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#64748b" }}>Ready to Submit</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{totals.readyToSubmit}</div>
        </div>
      </section>

      <section className="card" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label htmlFor="practice-filter" style={{ fontSize: 12, color: "#334155" }}>Practice</label>
        <select id="practice-filter" value={practice} onChange={(e) => setPractice(e.target.value)} className="input" style={{ minWidth: 220 }}>
          <option value="">All practices</option>
          {practiceOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <button className="button button-secondary" type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </section>

      {toast ? (
        <div style={{ padding: "10px 12px", border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#166534", borderRadius: 8 }}>
          {toast}
        </div>
      ) : null}
      {error ? (
        <div style={{ padding: "10px 12px", border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b", borderRadius: 8 }}>
          {error}
        </div>
      ) : null}

      <section className="card" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1600 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
              <th style={{ padding: "10px 8px" }}>Charge ID</th>
              <th style={{ padding: "10px 8px" }}>Patient Name</th>
              <th style={{ padding: "10px 8px" }}>Date of Service</th>
              <th style={{ padding: "10px 8px" }}>Provider</th>
              <th style={{ padding: "10px 8px" }}>CPT Code</th>
              <th style={{ padding: "10px 8px", textAlign: "right" }}>Billed Amount</th>
              <th style={{ padding: "10px 8px" }}>Status</th>
              <th style={{ padding: "10px 8px" }}>Batch ID</th>
              <th style={{ padding: "10px 8px" }}>Submit Date</th>
              <th style={{ padding: "10px 8px" }}>Notes</th>
              <th style={{ padding: "10px 8px" }}>Batch Actions</th>
            </tr>
          </thead>
          <tbody>
            {!loading && chargeRows.length === 0 ? (
              <tr>
                <td colSpan={11} style={{ padding: 16, color: "#475569" }}>No charges found for this scope.</td>
              </tr>
            ) : null}
            {chargeRows.map((row) => (
              <tr key={row.chargeId} style={{ borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                <td style={{ padding: "10px 8px", fontFamily: "monospace" }}>{row.chargeId}</td>
                <td style={{ padding: "10px 8px" }}>{row.patientName}</td>
                <td style={{ padding: "10px 8px" }}>{formatDate(row.dateOfService)}</td>
                <td style={{ padding: "10px 8px" }}>{row.providerName || "—"}</td>
                <td style={{ padding: "10px 8px" }}>{row.cptCode || "—"}</td>
                <td style={{ padding: "10px 8px", textAlign: "right" }}>{formatMoney(row.billedAmount)}</td>
                <td style={{ padding: "10px 8px" }}>{row.status || "—"}</td>
                <td style={{ padding: "10px 8px", fontFamily: "monospace" }}>{row.batchId || "—"}</td>
                <td style={{ padding: "10px 8px" }}>{formatDate(row.submitDate)}</td>
                <td style={{ padding: "10px 8px" }}>{row.notes || "—"}</td>
                <td style={{ padding: "10px 8px" }}>{renderBatchActions(row.batchId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}