"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type DashboardPayload = {
  success?: boolean;
  error?: string;
  totals?: {
    needsBillingAction: number;
    readyToSend: number;
    waitingForResponse: number;
    payerAccepted: number;
    eraNeedsPosting: number;
    openPatientInvoices: number;
  };
};

type BillingTile = {
  title: string;
  href: string;
  description: string;
};

const BILLING_TILES: BillingTile[] = [
  {
    title: "Charge Capture",
    href: "/billing/charge-capture",
    description: "Validate encounters, diagnosis, and coding before batching.",
  },
  {
    title: "Claim Submission",
    href: "/billing/claim-submission",
    description: "Generate and track 837P submission lifecycle through clearinghouse responses.",
  },
  {
    title: "Workqueue",
    href: "/billing/workqueue",
    description: "Triage routed billing tasks, denials, and follow-up actions.",
  },
  {
    title: "Reports",
    href: "/billing/reports",
    description: "Claim status, payment activity, and monthly revenue-cycle performance.",
  },
];

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

export default function BillingLandingClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [totals, setTotals] = useState<DashboardPayload["totals"] | null>(null);
  const missingOrgMessage = "Missing organizationId. Add ?organizationId=... or configure NEXT_PUBLIC_ORGANIZATION_ID.";

  useEffect(() => {
    if (!organizationId) return;

    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/billing/workflow-dashboard?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
        const json = (await response.json()) as DashboardPayload;
        if (cancelled) return;
        if (!response.ok || !json.success) throw new Error(json.error || "Failed to load billing dashboard");
        setTotals(json.totals || null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load billing dashboard");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const orgQuery = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Revenue Cycle</p>
          <h1>Billing Workspace</h1>
          <p className="hero-copy">
            OpenMRS-style billing hub for claim readiness, batching, AR follow-up, payment operations, and reporting.
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href={`/billing/workqueue${orgQuery}`}>Open Workqueue</Link>
          <Link className="button" href={`/billing/reports${orgQuery}`}>Open Reports</Link>
        </div>
      </section>

      {!organizationId ? <div className="alert-panel">{missingOrgMessage}</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}

      <section className="metric-grid">
        <article className="metric-card">
          <span>Needs Action</span>
          <strong>{loading ? "-" : totals?.needsBillingAction ?? 0}</strong>
        </article>
        <article className="metric-card">
          <span>Ready To Send</span>
          <strong>{loading ? "-" : totals?.readyToSend ?? 0}</strong>
        </article>
        <article className="metric-card">
          <span>Waiting Response</span>
          <strong>{loading ? "-" : totals?.waitingForResponse ?? 0}</strong>
        </article>
        <article className="metric-card">
          <span>Open Patient Invoices</span>
          <strong>{loading ? "-" : totals?.openPatientInvoices ?? 0}</strong>
        </article>
      </section>

      <section className="chart-grid">
        {BILLING_TILES.map((tile) => (
          <article key={tile.title} className="panel">
            <h2>{tile.title}</h2>
            <p className="muted">{tile.description}</p>
            <div className="section-actions">
              <Link className="button button-secondary" href={`${tile.href}${orgQuery}`}>Open {tile.title}</Link>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
