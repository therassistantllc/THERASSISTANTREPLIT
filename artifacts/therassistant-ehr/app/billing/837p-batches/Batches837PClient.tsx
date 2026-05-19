"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type BatchClaim = {
  id: string;
  patientId: string;
  patientName: string;
  dateOfBirth?: string | null;
  claimNumber?: unknown;
  status?: unknown;
  totalChargeAmount: number;
  updatedAt?: unknown;
};

type Batch837P = {
  id: string;
  batchNumber?: unknown;
  status?: unknown;
  claimCount: number;
  totalChargeAmount: number;
  generatedFileName?: unknown;
  submittedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  claims: BatchClaim[];
};

type Payload = {
  success: boolean;
  error?: string;
  metrics?: {
    total: number;
    readyToGenerate: number;
    generated: number;
    submitted: number;
    rejected: number;
  };
  batches?: Batch837P[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function formatDate(value: unknown) {
  if (!value) return "Not listed";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

function formatMoney(value: number) {
  return Number(value ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function statusClass(value: unknown) {
  const status = String(value ?? "").toLowerCase();
  if (status.includes("accepted") || status.includes("generated") || status.includes("submitted")) return "status status-green";
  if (status.includes("rejected") || status.includes("failed")) return "status status-red";
  return "status status-yellow";
}

export default function Batches837PClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!organizationId) {
      setError("Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.");
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(`/api/billing/837p-batches?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
      const json = (await response.json()) as Payload;
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load 837P batches");
      setPayload(json);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load 837P batches");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  const metrics = payload?.metrics ?? { total: 0, readyToGenerate: 0, generated: 0, submitted: 0, rejected: 0 };
  const batches = payload?.batches ?? [];

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Billing</p>
          <h1>Claim Submission</h1>
          <p className="hero-copy">Submit and monitor 837P batch transmissions using existing clearinghouse integration workflows.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/billing/charge-capture">Charge Capture</Link>
          <Link className="button button-secondary" href="/calendar">Calendar</Link>
        </div>
      </section>

      {error ? <div className="alert-panel">{error}</div> : null}

      <section className="metric-grid">
        <article className="metric-card"><span>Total Batches</span><strong>{loading ? "—" : metrics.total}</strong></article>
        <article className="metric-card"><span>Ready to Generate</span><strong>{loading ? "—" : metrics.readyToGenerate}</strong></article>
        <article className="metric-card"><span>Submitted</span><strong>{loading ? "—" : metrics.submitted}</strong></article>
        <article className="metric-card"><span>Rejected</span><strong>{loading ? "—" : metrics.rejected}</strong></article>
      </section>

      <section className="panel">
        <h2>Submission Queue</h2>
        {loading ? <div className="empty-state">Loading 837P batches…</div> : null}
        {!loading && batches.length === 0 ? <div className="empty-state">No 837P batches found.</div> : null}

        <div className="stack-list">
          {batches.map((batch) => (
            <article className="stack-item" key={batch.id}>
              <div className="stack-row">
                <div>
                  <strong>{String(batch.batchNumber ?? "837P Batch")}</strong>
                  <span>Created: {formatDate(batch.createdAt)} · Claims: {batch.claimCount}</span>
                  <span>Total charge: {formatMoney(batch.totalChargeAmount)}</span>
                  {batch.generatedFileName ? <span>File: {String(batch.generatedFileName)}</span> : null}
                </div>
                <div className="invoice-money-grid">
                  <span className={statusClass(batch.status)}>{String(batch.status ?? "status not set")}</span>
                  {batch.submittedAt ? <span>Submitted {formatDate(batch.submittedAt)}</span> : <span>Not submitted</span>}
                </div>
              </div>

              {batch.claims.length > 0 ? (
                <div className="payment-history">
                  <strong>Claims in Batch</strong>
                  {batch.claims.map((claim) => (
                    <span key={claim.id}>
                      {claim.patientName} · Claim {String(claim.claimNumber ?? claim.id.slice(0, 8))} · {String(claim.status ?? "status not set")} · {formatMoney(claim.totalChargeAmount)}
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
