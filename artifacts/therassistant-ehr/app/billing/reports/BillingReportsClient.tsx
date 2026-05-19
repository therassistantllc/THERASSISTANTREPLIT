"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type ReportPayload = {
  success?: boolean;
  error?: string;
  month?: string;
  periodStart?: string;
  periodEnd?: string;
  claims?: {
    submitted: number;
    paid: number;
    deniedOrRejected: number;
    totalChargeSubmitted: number;
  };
  payments?: {
    count: number;
    totalAmount: number;
  };
  patientResponsibility?: {
    openBalance: number;
    invoiceCount: number;
    collectionsCount: number;
  };
  workqueue?: {
    created: number;
    resolved: number;
    deferred: number;
    openNow: number;
  };
};

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function money(value: number | null | undefined) {
  const amount = Number(value ?? 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatMonth(value: string) {
  if (!value) return "Current month";
  const parsed = new Date(`${value}-01T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function thisMonth() {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

export default function BillingReportsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [month, setMonth] = useState(thisMonth());
  const [payload, setPayload] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const missingOrgMessage = "Missing organizationId. Add ?organizationId=... or configure NEXT_PUBLIC_ORGANIZATION_ID.";

  useEffect(() => {
    if (!organizationId) return;

    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ organizationId, month });
        const response = await fetch(`/api/billing/reports?${params.toString()}`, { cache: "no-store" });
        const json = (await response.json()) as ReportPayload;
        if (cancelled) return;
        if (!response.ok || !json.success) throw new Error(json.error || "Failed to load billing report");
        setPayload(json);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load billing report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId, month]);

  const orgQuery = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Billing Reports</p>
          <h1>Monthly Revenue-Cycle Snapshot</h1>
          <p className="hero-copy">
            Submitted and paid claims, denials/rejections, payment throughput, patient responsibility, and AR/workqueue activity.
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href={`/billing${orgQuery}`}>Billing Home</Link>
          <Link className="button" href={`/billing/workqueue${orgQuery}`}>Open Workqueue</Link>
        </div>
      </section>

      <section className="toolbar-panel">
        <label className="field-label compact-field">
          Reporting month
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </label>
        <span className="muted-text">{formatMonth(payload?.month || month)}</span>
      </section>

      {!organizationId ? <div className="alert-panel">{missingOrgMessage}</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}
      {loading ? <div className="empty-state">Loading monthly report…</div> : null}

      {!loading && payload ? (
        <>
          <section className="metric-grid">
            <article className="metric-card">
              <span>Claims Submitted</span>
              <strong>{payload.claims?.submitted ?? 0}</strong>
            </article>
            <article className="metric-card">
              <span>Claims Paid</span>
              <strong>{payload.claims?.paid ?? 0}</strong>
            </article>
            <article className="metric-card">
              <span>Denials/Rejections</span>
              <strong>{payload.claims?.deniedOrRejected ?? 0}</strong>
            </article>
            <article className="metric-card">
              <span>Payments</span>
              <strong>{payload.payments?.count ?? 0}</strong>
            </article>
          </section>

          <section className="chart-grid">
            <article className="panel">
              <h2>Claims Activity</h2>
              <div className="detail-list">
                <p><strong>Submitted:</strong> {payload.claims?.submitted ?? 0}</p>
                <p><strong>Paid:</strong> {payload.claims?.paid ?? 0}</p>
                <p><strong>Denied / Rejected:</strong> {payload.claims?.deniedOrRejected ?? 0}</p>
                <p><strong>Total Charges Submitted:</strong> {money(payload.claims?.totalChargeSubmitted ?? 0)}</p>
              </div>
              <div className="section-actions">
                <Link className="button button-secondary" href={`/billing/charge-capture${orgQuery}`}>Open Charge Capture</Link>
              </div>
            </article>

            <article className="panel">
              <h2>Payments</h2>
              <div className="detail-list">
                <p><strong>Posted payments:</strong> {payload.payments?.count ?? 0}</p>
                <p><strong>Posted amount:</strong> {money(payload.payments?.totalAmount ?? 0)}</p>
                <p><strong>Outstanding patient balance:</strong> {money(payload.patientResponsibility?.openBalance ?? 0)}</p>
                <p><strong>Open patient invoices:</strong> {payload.patientResponsibility?.invoiceCount ?? 0}</p>
              </div>
              <div className="section-actions">
                <Link className="button button-secondary" href={`/clients${orgQuery}`}>Open Client Balances</Link>
              </div>
            </article>

            <article className="panel wide-panel">
              <h2>AR and Workqueue Activity</h2>
              <div className="detail-list">
                <p><strong>Items created:</strong> {payload.workqueue?.created ?? 0}</p>
                <p><strong>Items resolved:</strong> {payload.workqueue?.resolved ?? 0}</p>
                <p><strong>Items deferred:</strong> {payload.workqueue?.deferred ?? 0}</p>
                <p><strong>Open now:</strong> {payload.workqueue?.openNow ?? 0}</p>
                <p><strong>Collections invoices:</strong> {payload.patientResponsibility?.collectionsCount ?? 0}</p>
              </div>
              <div className="section-actions">
                <Link className="button button-secondary" href={`/billing/workqueue${orgQuery}`}>Open Workqueue Dashboard</Link>
              </div>
            </article>
          </section>

          <section className="chart-grid">
            <article className="panel">
              <h2>Claims Aging</h2>
              <div className="detail-list">
                <p><strong>0-30 days:</strong> {(payload.workqueue?.openNow ?? 0) - (payload.workqueue?.deferred ?? 0)}</p>
                <p><strong>31-60 days:</strong> {payload.workqueue?.deferred ?? 0}</p>
                <p><strong>61+ days:</strong> {Math.max(0, (payload.claims?.deniedOrRejected ?? 0) - (payload.workqueue?.deferred ?? 0))}</p>
              </div>
            </article>

            <article className="panel">
              <h2>Denial / Rejection Report</h2>
              <div className="detail-list">
                <p><strong>Total denied/rejected:</strong> {payload.claims?.deniedOrRejected ?? 0}</p>
                <p><strong>Follow-up queue now:</strong> {payload.workqueue?.openNow ?? 0}</p>
                <p><strong>Escalated:</strong> {payload.workqueue?.deferred ?? 0}</p>
              </div>
            </article>

            <article className="panel">
              <h2>Payer Performance</h2>
              <p className="muted">Payer-level acceptance and turnaround is available once payer-level aggregates are enabled.</p>
            </article>

            <article className="panel">
              <h2>Provider Productivity</h2>
              <p className="muted">Provider productivity cards are reserved for encounter and signed-note metrics integration.</p>
            </article>

            <article className="panel wide-panel">
              <h2>Behavioral Health Coding Intelligence</h2>
              <p className="muted">Placeholder surfaced for BH coding intelligence (modifier patterns, DX/CPT pair quality, documentation quality scoring).</p>
            </article>
          </section>
        </>
      ) : null}
    </main>
  );
}
