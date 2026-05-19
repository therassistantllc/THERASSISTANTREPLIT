"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Batch837P = {
  id: string;
  batchNumber?: unknown;
  status?: unknown;
  claimCount: number;
  submittedAt?: unknown;
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
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function agingBucket(value: unknown) {
  if (!value) return "No Response / Missing 999";
  const submitted = new Date(String(value));
  if (Number.isNaN(submitted.getTime())) return "No Response / Missing 999";
  const days = Math.floor((Date.now() - submitted.getTime()) / 86400000);
  if (days <= 7) return "0-7 days";
  if (days <= 14) return "8-14 days";
  if (days <= 30) return "15-30 days";
  return "31+ days";
}

export default function ClaimSubmissionClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const missingOrgMessage = "Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.";

  useEffect(() => {
    if (!organizationId) return;

    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/billing/837p-batches?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
        const json = (await response.json()) as Payload;
        if (cancelled) return;
        if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load claim submission center");
        setPayload(json);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load claim submission center");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const metrics = payload?.metrics ?? { total: 0, readyToGenerate: 0, generated: 0, submitted: 0, rejected: 0 };
  const batches = payload?.batches ?? [];
  const orgQuery = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";

  const aging = batches.reduce<Record<string, number>>((acc, batch) => {
    const bucket = agingBucket(batch.submittedAt);
    acc[bucket] = (acc[bucket] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Billing</p>
          <h1>Claim Submission Center</h1>
          <p className="hero-copy">
            Uses existing 837P and clearinghouse workflows to monitor readiness, submissions, rejections, and follow-up queues.
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button" href={`/billing/837p-batches${orgQuery}`}>Open 837P Batches</Link>
          <Link className="button button-secondary" href={`/billing/workqueue${orgQuery}`}>Open Workqueue</Link>
        </div>
      </section>

      {!organizationId ? <div className="alert-panel">{missingOrgMessage}</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}

      <section className="metric-grid">
        <article className="metric-card"><span>Ready to Submit</span><strong>{loading ? "-" : metrics.readyToGenerate + metrics.generated}</strong></article>
        <article className="metric-card"><span>Validation Errors</span><strong>{loading ? "-" : metrics.rejected}</strong></article>
        <article className="metric-card"><span>Submitted Claims</span><strong>{loading ? "-" : metrics.submitted}</strong></article>
        <article className="metric-card"><span>Rejections</span><strong>{loading ? "-" : metrics.rejected}</strong></article>
      </section>

      <section className="chart-grid">
        <article className="panel">
          <h2>Submission Queues</h2>
          <div className="detail-list">
            <p><strong>No Response / Missing 999:</strong> {loading ? "-" : (aging["No Response / Missing 999"] ?? 0)}</p>
            <p><strong>Aging 0-7:</strong> {loading ? "-" : (aging["0-7 days"] ?? 0)}</p>
            <p><strong>Aging 8-14:</strong> {loading ? "-" : (aging["8-14 days"] ?? 0)}</p>
            <p><strong>Aging 15-30:</strong> {loading ? "-" : (aging["15-30 days"] ?? 0)}</p>
            <p><strong>Aging 31+:</strong> {loading ? "-" : (aging["31+ days"] ?? 0)}</p>
            <p><strong>Secondary Claims:</strong> Placeholder until secondary payer queue is mapped.</p>
            <p><strong>ERA Exceptions:</strong> Use billing workqueue ERA categories.</p>
          </div>
        </article>
        <article className="panel">
          <h2>Claim Inspector</h2>
          <p className="muted">Right-side claim inspector placeholder until dedicated /billing/claims/[id] detail page is enabled.</p>
          <div className="detail-list">
            {batches.slice(0, 5).map((batch) => (
              <p key={batch.id}><strong>{String(batch.batchNumber ?? batch.id.slice(0, 8))}</strong> · {String(batch.status ?? "pending")} · {batch.claimCount} claim(s)</p>
            ))}
            {!loading && batches.length === 0 ? <p>No recent batches.</p> : null}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/billing/reports${orgQuery}`}>Open Reports</Link>
          </div>
        </article>
      </section>
    </main>
  );
}
