"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type Batch837P = {
  id: string;
  batchNumber?: unknown;
  status?: unknown;
  claimCount: number;
  submittedAt?: unknown;
};

type ReadinessMetrics = {
  total: number;
  blocked: number;
  readyForClaim: number;
  claimCreated: number;
  validationFailed: number;
  readyForBatch: number;
};

type BatchMetrics = {
  total: number;
  readyToGenerate: number;
  generated: number;
  submitted: number;
  rejected: number;
};

type BatchPayload = {
  success: boolean;
  error?: string;
  metrics?: BatchMetrics;
  batches?: Batch837P[];
};

type ReadinessPayload = {
  success: boolean;
  error?: string;
  metrics?: ReadinessMetrics;
};

type SubmissionQueueMetrics = {
  secondaryClaims: number;
  eraExceptions: number;
};

type SubmissionQueuePayload = {
  success: boolean;
  error?: string;
  metrics?: SubmissionQueueMetrics;
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
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
  const [batchPayload, setBatchPayload] = useState<BatchPayload | null>(null);
  const [readinessPayload, setReadinessPayload] = useState<ReadinessPayload | null>(null);
  const [queuePayload, setQueuePayload] = useState<SubmissionQueuePayload | null>(null);
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const missingOrgMessage = "Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.";

  useEffect(() => {
    if (!organizationId) return;

    let cancelled = false;
    async function load() {
      try {
        const [batchRes, readinessRes, queueRes] = await Promise.all([
          fetch(`/api/billing/837p-batches?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" }),
          fetch(`/api/billing/claim-readiness?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" }),
          fetch(`/api/billing/submission-queues?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" }),
        ]);

        const [batchJson, readinessJson, queueJson] = await Promise.all([
          batchRes.json() as Promise<BatchPayload>,
          readinessRes.json() as Promise<ReadinessPayload>,
          queueRes.json() as Promise<SubmissionQueuePayload>,
        ]);

        if (cancelled) return;

        if (!batchRes.ok || !batchJson.success) throw new Error(batchJson.error ?? "Failed to load 837P batch data");
        if (!readinessRes.ok || !readinessJson.success) throw new Error(readinessJson.error ?? "Failed to load claim readiness data");
        if (!queueRes.ok || !queueJson.success) throw new Error(queueJson.error ?? "Failed to load submission queues");

        setBatchPayload(batchJson);
        setReadinessPayload(readinessJson);
        setQueuePayload(queueJson);
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

  const batchMetrics = batchPayload?.metrics ?? { total: 0, readyToGenerate: 0, generated: 0, submitted: 0, rejected: 0 };
  const readinessMetrics = readinessPayload?.metrics ?? { total: 0, blocked: 0, readyForClaim: 0, claimCreated: 0, validationFailed: 0, readyForBatch: 0 };
  const queueMetrics = queuePayload?.metrics ?? { secondaryClaims: 0, eraExceptions: 0 };
  const batches = batchPayload?.batches ?? [];
  const orgQuery = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";

  const readyToSubmit = readinessMetrics.readyForClaim + readinessMetrics.readyForBatch + batchMetrics.readyToGenerate + batchMetrics.generated;
  const validationErrors = readinessMetrics.validationFailed;

  // "accepted" = clearinghouse accepted the submission, so it counts as submitted too
  const SUBMITTED_STATUSES = new Set(["submitted", "accepted"]);
  const submittedBatches = batches.filter((b) => SUBMITTED_STATUSES.has(String(b.status ?? "")));
  const rejectedBatches = batches.filter((b) => String(b.status ?? "") === "rejected");
  const submittedClaims = submittedBatches.reduce((sum, b) => sum + b.claimCount, 0);
  const rejectedClaims = rejectedBatches.reduce((sum, b) => sum + b.claimCount, 0);

  const aging = submittedBatches.reduce<Record<string, number>>((acc, batch) => {
    const bucket = agingBucket(batch.submittedAt);
    acc[bucket] = (acc[bucket] ?? 0) + batch.claimCount;
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
        <article className="metric-card"><span>Ready to Submit</span><strong>{loading ? "-" : readyToSubmit}</strong></article>
        <article className="metric-card"><span>Validation Errors</span><strong>{loading ? "-" : validationErrors}</strong></article>
        <article className="metric-card"><span>Submitted Claims</span><strong>{loading ? "-" : submittedClaims}</strong></article>
        <article className="metric-card"><span>Rejections</span><strong>{loading ? "-" : rejectedClaims}</strong></article>
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
            <p><strong>Secondary Claims:</strong> {loading ? "-" : queueMetrics.secondaryClaims}</p>
            <p><strong>ERA Exceptions:</strong> {loading ? "-" : queueMetrics.eraExceptions}</p>
          </div>
        </article>
        <article className="panel">
          <h2>Claim Inspector</h2>
          <div className="detail-list">
            {batches.slice(0, 5).map((batch) => {
              const params = new URLSearchParams();
              if (organizationId) params.set("organizationId", organizationId);
              params.set("batchId", batch.id);
              return (
                <Link
                  key={batch.id}
                  href={`/billing/837p-batches?${params.toString()}`}
                  style={{
                    display: "block",
                    padding: "10px 12px",
                    margin: "4px 0",
                    border: "1px solid #E5E7EB",
                    borderRadius: 6,
                    color: "#111827",
                    textDecoration: "none",
                    background: "#fff",
                    transition: "background 0.15s, border-color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#F3F4F6";
                    e.currentTarget.style.borderColor = "#3B82F6";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "#fff";
                    e.currentTarget.style.borderColor = "#E5E7EB";
                  }}
                >
                  <strong style={{ color: "#3B82F6" }}>{String(batch.batchNumber ?? batch.id.slice(0, 8))}</strong>
                  {" · "}{String(batch.status ?? "pending")} · {batch.claimCount} claim(s)
                </Link>
              );
            })}
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
