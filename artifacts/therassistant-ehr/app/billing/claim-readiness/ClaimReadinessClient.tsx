"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { buildClaimDetailHref } from "@/lib/claims/claimDetailRouting";

type ClaimReadinessItem = {
  chargeCaptureId: string;
  encounterId: string;
  clientId: string;
  patientName: string;
  dateOfBirth?: string | null;
  serviceDate?: string | null;
  chargeStatus?: string | null;
  totalCharge: number;
  diagnosisCount: number;
  serviceLineCount: number;
  blockers: Array<{ field?: string; message?: string }>;
  updatedAt?: string | null;
  claim: { id: string; claimNumber?: unknown; status?: unknown; totalChargeAmount: number; updatedAt?: unknown } | null;
};

type Payload = {
  success: boolean;
  error?: string;
  metrics?: {
    total: number;
    blocked: number;
    readyForClaim: number;
    claimCreated: number;
    validationFailed: number;
    readyForBatch: number;
  };
  items?: ClaimReadinessItem[];
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
  if (status.includes("ready") || status.includes("created")) return "status status-green";
  if (status.includes("blocked") || status.includes("failed")) return "status status-red";
  return "status status-yellow";
}

export default function ClaimReadinessClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [batching, setBatching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimStatusChecking, setClaimStatusChecking] = useState<Record<string, boolean>>({});
  const [claimStatusResults, setClaimStatusResults] = useState<Record<string, string>>({});

  async function load() {
    try {
      if (!organizationId) {
        throw new Error("Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.");
      }
      const response = await fetch(`/api/billing/claim-readiness?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
      const json = (await response.json()) as Payload;
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load charge capture queue");
      setPayload(json);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load charge capture queue");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  async function checkClaimStatus(item: ClaimReadinessItem) {
    if (!item.claim?.id || !item.clientId) return;
    const claimId = item.claim.id;
    setClaimStatusChecking((prev) => ({ ...prev, [claimId]: true }));
    setClaimStatusResults((prev) => ({ ...prev, [claimId]: "" }));
    try {
      const response = await fetch("/api/clearinghouse/office-ally/claim-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, clientId: item.clientId, claimId }),
      });
      const json = (await response.json()) as { success: boolean; error?: string };
      setClaimStatusResults((prev) => ({
        ...prev,
        [claimId]: json.success ? "Claim status submitted" : (json.error ?? "Claim status check failed"),
      }));
    } catch {
      setClaimStatusResults((prev) => ({ ...prev, [claimId]: "Claim status check failed" }));
    } finally {
      setClaimStatusChecking((prev) => ({ ...prev, [claimId]: false }));
    }
  }

  async function create837PBatch() {
    setBatching(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/billing/claim-readiness/create-837p-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      const json = (await response.json()) as { success?: boolean; error?: string; batchNumber?: string; claimCount?: number };
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to create 837P batch");
      setMessage(`Created batch ${json.batchNumber} with ${json.claimCount ?? 0} claims.`);
      await load();
    } catch (batchError) {
      setError(batchError instanceof Error ? batchError.message : "Failed to create 837P batch");
    } finally {
      setBatching(false);
    }
  }

  const metrics = payload?.metrics ?? { total: 0, blocked: 0, readyForClaim: 0, claimCreated: 0, validationFailed: 0, readyForBatch: 0 };
  const items = payload?.items ?? [];

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Billing/Admin</p>
          <h1>Charge Capture</h1>
          <p className="hero-copy">Review blocked charge capture, claim validation failures, and claims ready for batching.</p>
        </div>
        <div className="hero-actions">
          <button className="button" type="button" onClick={create837PBatch} disabled={batching || metrics.readyForBatch === 0}>
            {batching ? "Creating Batch…" : "Create 837P Batch"}
          </button>
          <Link className="button button-secondary" href="/calendar">Calendar</Link>
        </div>
      </section>

      {message ? <div className="empty-state success-panel">{message}</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}

      <section className="metric-grid">
        <article className="metric-card"><span>Total</span><strong>{loading ? "—" : metrics.total}</strong></article>
        <article className="metric-card"><span>Blocked</span><strong>{loading ? "—" : metrics.blocked}</strong></article>
        <article className="metric-card"><span>Validation Failed</span><strong>{loading ? "—" : metrics.validationFailed}</strong></article>
        <article className="metric-card"><span>Ready for Batch</span><strong>{loading ? "—" : metrics.readyForBatch}</strong></article>
      </section>

      <section className="panel">
        <h2>Charge Capture / Claim Queue</h2>
        {loading ? <div className="empty-state">Loading charge capture queue…</div> : null}
        {!loading && items.length === 0 ? <div className="empty-state">No charge capture items found.</div> : null}

        <div className="stack-list">
          {items.map((item) => (
            <article className="stack-item" key={item.chargeCaptureId}>
              <div className="stack-row">
                <div>
                  <strong>{item.patientName}</strong>
                  <span>DOB: {formatDate(item.dateOfBirth)} · Service: {formatDate(item.serviceDate)}</span>
                  <span>Diagnosis count: {item.diagnosisCount} · Service lines: {item.serviceLineCount} · Total: {formatMoney(item.totalCharge)}</span>
                </div>
                <div className="invoice-money-grid">
                  <span className={statusClass(item.chargeStatus)}>{item.chargeStatus ?? "status not set"}</span>
                  {item.claim ? <span className={statusClass(item.claim.status)}>Claim {String(item.claim.status ?? "status not set")}</span> : <span className="status">No claim</span>}
                </div>
              </div>

              {item.blockers.length > 0 ? (
                <div className="payment-history">
                  <strong>Blockers</strong>
                  {item.blockers.map((blocker, index) => (
                    <span key={`${item.chargeCaptureId}-blocker-${index + 1}`}>{blocker.field ?? "field"}: {blocker.message ?? "Needs review"}</span>
                  ))}
                </div>
              ) : null}

              <div className="section-actions">
                <Link className="button button-secondary" href={`/encounters/${item.encounterId}`}>Open Note</Link>
                <Link className="button button-secondary" href={`/encounters/${item.encounterId}/billing`}>Billing Details</Link>
                {item.clientId ? <Link className="button button-secondary" href={`/clients/${item.clientId}`}>Patient Chart</Link> : null}
                {item.claim?.id ? (
                  <Link
                    className="button button-secondary"
                    href={buildClaimDetailHref({
                      professionalClaimId: item.claim.id,
                      organizationId,
                    })}
                  >
                    Open Claim Detail
                  </Link>
                ) : null}
                {item.claim?.id && item.clientId ? (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={claimStatusChecking[item.claim.id]}
                    onClick={() => void checkClaimStatus(item)}
                  >
                    {claimStatusChecking[item.claim.id] ? "Checking…" : "Check Claim Status"}
                  </button>
                ) : null}
                {item.claim?.id && claimStatusResults[item.claim.id] ? (
                  <span className="status muted-text">{claimStatusResults[item.claim.id]}</span>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
