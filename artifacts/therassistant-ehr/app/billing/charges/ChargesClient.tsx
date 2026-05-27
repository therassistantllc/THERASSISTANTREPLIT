"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type ClaimEntry = {
  id: string;
  claimNumber: string;
  status: string;
  totalCharge: number;
  practiceId: string | null;
};

type ChargeBatch = {
  id: string;
  batchNumber: string;
  status: string;
  claimCount: number;
  totalChargeAmount: number;
  generatedFileName: string | null;
  submittedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  payerProfileId: string | null;
  payerName: string;
  billingProviderTaxId: string | null;
  claims: ClaimEntry[];
};

type Payload = {
  success: boolean;
  error?: string;
  clinicianOnly?: boolean;
  canManage?: boolean;
  practiceOptions?: Array<{ value: string; label: string }>;
  batches?: ChargeBatch[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function formatMoney(amount: number) {
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

export default function ChargesClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [batches, setBatches] = useState<ChargeBatch[]>([]);
  const [practiceOptions, setPracticeOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [practice, setPractice] = useState<string>("");
  const [canManage, setCanManage] = useState<boolean>(true);
  const [clinicianOnly, setClinicianOnly] = useState<boolean>(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      if (practice) params.set("practice", practice);
      const res = await fetch(`/api/billing/charges/batches?${params.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as Payload;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load charge batches");
      }
      setBatches(json.batches ?? []);
      setPracticeOptions(json.practiceOptions ?? []);
      setCanManage(json.canManage !== false);
      setClinicianOnly(Boolean(json.clinicianOnly));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load charge batches");
      setBatches([]);
    } finally {
      setLoading(false);
    }
  }, [organizationId, practice]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      setToast(action === "mark-submitted" ? "Batch marked submitted." : "Submission queued.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to ${action}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page-shell" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <section className="hero-card" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0 }}>Charges</h1>
            <p className="hero-copy" style={{ marginBottom: 0 }}>
              Charges from signed notes are auto-batched by payer and billing TIN. Download 837 files for Availity upload,
              then manually mark submitted while electronic submit is being wired.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="practice-filter" style={{ fontSize: 12, color: "#334155" }}>Practice</label>
            <select
              id="practice-filter"
              value={practice}
              onChange={(e) => setPractice(e.target.value)}
              className="input"
              style={{ minWidth: 220 }}
            >
              <option value="">All practices</option>
              {practiceOptions.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <button className="button button-secondary" type="button" onClick={() => void load()} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
        {clinicianOnly ? (
          <p style={{ marginTop: 10, marginBottom: 0, fontSize: 12, color: "#475569" }}>
            Clinician scope active: only claims tied to your assigned clinical workload are shown.
          </p>
        ) : null}
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
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
              <th style={{ padding: "10px 8px" }}>Batch</th>
              <th style={{ padding: "10px 8px" }}>Payer</th>
              <th style={{ padding: "10px 8px" }}>TIN</th>
              <th style={{ padding: "10px 8px", textAlign: "right" }}>Claims</th>
              <th style={{ padding: "10px 8px", textAlign: "right" }}>Total</th>
              <th style={{ padding: "10px 8px" }}>Status</th>
              <th style={{ padding: "10px 8px" }}>Submitted</th>
              <th style={{ padding: "10px 8px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!loading && batches.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: 16, color: "#475569" }}>No charge batches found for this scope.</td>
              </tr>
            ) : null}
            {batches.map((batch) => {
              const downloadingUrl = `/api/billing/charges/batches/${encodeURIComponent(batch.id)}/download?organizationId=${encodeURIComponent(organizationId)}`;
              return (
                <tr key={batch.id} style={{ borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                  <td style={{ padding: "10px 8px" }}>
                    <div style={{ fontWeight: 600 }}>{batch.batchNumber}</div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>{formatDate(batch.createdAt)}</div>
                  </td>
                  <td style={{ padding: "10px 8px" }}>{batch.payerName}</td>
                  <td style={{ padding: "10px 8px", fontFamily: "monospace" }}>{batch.billingProviderTaxId ?? "-"}</td>
                  <td style={{ padding: "10px 8px", textAlign: "right" }}>{batch.claimCount}</td>
                  <td style={{ padding: "10px 8px", textAlign: "right" }}>{formatMoney(batch.totalChargeAmount)}</td>
                  <td style={{ padding: "10px 8px" }}>{batch.status}</td>
                  <td style={{ padding: "10px 8px" }}>{formatDate(batch.submittedAt)}</td>
                  <td style={{ padding: "10px 8px" }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <a className="button button-secondary" href={downloadingUrl} target="_blank" rel="noopener noreferrer">
                        Download 837
                      </a>
                      <button
                        className="button"
                        type="button"
                        disabled={!canManage || busyId === batch.id}
                        onClick={() => void postAction(batch.id, "submit")}
                      >
                        Submit batch
                      </button>
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={!canManage || busyId === batch.id}
                        onClick={() => void postAction(batch.id, "mark-submitted")}
                      >
                        Mark submitted
                      </button>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
                      {batch.claims.slice(0, 3).map((c) => c.claimNumber).join(", ")}
                      {batch.claims.length > 3 ? ` +${batch.claims.length - 3}` : ""}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
