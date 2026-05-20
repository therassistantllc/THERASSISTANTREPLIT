"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

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
    collectionsBalance: number;
    averageOpenBalance: number;
  };
  workqueue?: {
    created: number;
    resolved: number;
    deferred: number;
    openNow: number;
  };
  aging?: {
    bucket0to30: { count: number; totalCharge: number };
    bucket31to60: { count: number; totalCharge: number };
    bucket61Plus: { count: number; totalCharge: number };
    totalOutstanding: number;
  };
  denials?: {
    totalAdjustmentAmount: number;
    totalAdjustmentCount: number;
    breakdown: Array<{
      groupCode: string;
      reasonCode: string;
      carcCode: string;
      occurrences: number;
      totalAmount: number;
    }>;
  };
  payerPerformance?: Array<{
    payerProfileId: string | null;
    payerName: string;
    totalClaims: number;
    acceptedClaims: number;
    paidClaims: number;
    rejectedClaims: number;
    acceptanceRate: number;
    averageTurnaroundDays: number | null;
    totalCharge: number;
  }>;
};

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
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
              <p><strong>Average open balance:</strong> {money(payload.patientResponsibility?.averageOpenBalance ?? 0)}</p>
              <p><strong>Collections balance:</strong> {money(payload.patientResponsibility?.collectionsBalance ?? 0)}</p>
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
              <p className="muted-text">By days since claim was submitted ({payload.aging?.totalOutstanding ?? 0} outstanding).</p>
              <div className="detail-list">
                <p>
                  <strong>0-30 days:</strong> {payload.aging?.bucket0to30.count ?? 0} claims · {money(payload.aging?.bucket0to30.totalCharge ?? 0)}
                </p>
                <p>
                  <strong>31-60 days:</strong> {payload.aging?.bucket31to60.count ?? 0} claims · {money(payload.aging?.bucket31to60.totalCharge ?? 0)}
                </p>
                <p>
                  <strong>61+ days:</strong> {payload.aging?.bucket61Plus.count ?? 0} claims · {money(payload.aging?.bucket61Plus.totalCharge ?? 0)}
                </p>
              </div>
            </article>

            <article className="panel">
              <h2>Denial / Rejection Report</h2>
              <p className="muted-text">
                CARC adjustments from ERA payments this month ({payload.denials?.totalAdjustmentCount ?? 0} total · {money(payload.denials?.totalAdjustmentAmount ?? 0)}).
              </p>
              {payload.denials && payload.denials.breakdown.length > 0 ? (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>CARC</th>
                      <th>Group</th>
                      <th>Reason</th>
                      <th>Count</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.denials.breakdown.map((row) => (
                      <tr key={row.carcCode}>
                        <td>{row.carcCode}</td>
                        <td>{row.groupCode || "—"}</td>
                        <td>{row.reasonCode || "—"}</td>
                        <td>{row.occurrences}</td>
                        <td>{money(row.totalAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">No ERA adjustments recorded for this month.</p>
              )}
            </article>

            <article className="panel wide-panel">
              <h2>Payer Performance</h2>
              <p className="muted-text">Acceptance rate and average payer turnaround for claims submitted this month.</p>
              {payload.payerPerformance && payload.payerPerformance.length > 0 ? (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Payer</th>
                      <th>Claims</th>
                      <th>Accepted</th>
                      <th>Paid</th>
                      <th>Rejected</th>
                      <th>Acceptance</th>
                      <th>Avg turnaround</th>
                      <th>Total charge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.payerPerformance.map((row) => (
                      <tr key={row.payerProfileId ?? row.payerName}>
                        <td>{row.payerName}</td>
                        <td>{row.totalClaims}</td>
                        <td>{row.acceptedClaims}</td>
                        <td>{row.paidClaims}</td>
                        <td>{row.rejectedClaims}</td>
                        <td>{row.acceptanceRate.toFixed(1)}%</td>
                        <td>{row.averageTurnaroundDays === null ? "—" : `${row.averageTurnaroundDays} d`}</td>
                        <td>{money(row.totalCharge)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">No claims have been submitted to a payer this month yet.</p>
              )}
            </article>
          </section>
        </>
      ) : null}
    </main>
  );
}
