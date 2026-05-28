"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildClaimDetailHref } from "@/lib/claims/claimDetailRouting";
import { DEFAULT_ORG_ID } from "@/lib/config";

type BlockingFinding = {
  ruleId: string;
  category: string;
  message: string;
  fixRoute: string;
  whyItMatters: string;
  resolution: string;
};

type BlockedClaimItem = {
  claimId: string;
  claimNumber: string | null;
  claimStatus: string | null;
  payerName: string;
  payerProfileId: string | null;
  patientId: string | null;
  patientName: string;
  patientDob: string | null;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  totalChargeAmount: number;
  updatedAt: string | null;
  blockingCount: number;
  warningCount: number;
  blockingFindings: BlockingFinding[];
  engineError: string | null;
};

type Payload = {
  success: boolean;
  error?: string;
  organizationId?: string;
  generatedAt?: string;
  metrics?: {
    blockedClaims: number;
    totalBlockingFindings: number;
    candidatesEvaluated: number;
  };
  items?: BlockedClaimItem[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatDate(value: unknown): string {
  if (!value) return "Not set";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
}

function formatMoney(value: number): string {
  return Number(value ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function statusClass(status: string | null): string {
  const s = (status ?? "").toLowerCase();
  if (s.includes("failed") || s.includes("blocked")) return "status status-red";
  if (s.includes("ready") || s.includes("draft")) return "status status-yellow";
  return "status";
}

export default function ClaimEditDashboardClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowChecking, setRowChecking] = useState<Record<string, boolean>>({});
  const [rowMessages, setRowMessages] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!organizationId) {
        throw new Error(
          "Missing organizationId. Add ?organizationId=… to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.",
        );
      }
      const res = await fetch(
        `/api/billing/rejections?organizationId=${encodeURIComponent(
          organizationId,
        )}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as Payload;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load blocked claims");
      }
      setPayload(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load blocked claims");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const recheckRow = useCallback(
    async (claimId: string) => {
      setRowChecking((prev) => ({ ...prev, [claimId]: true }));
      setRowMessages((prev) => ({ ...prev, [claimId]: "" }));
      try {
        const res = await fetch(
          `/api/billing/rejections?organizationId=${encodeURIComponent(
            organizationId,
          )}&claimId=${encodeURIComponent(claimId)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as Payload;
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Recheck failed");
        }
        const updated = (json.items ?? [])[0] ?? null;
        setPayload((prev) => {
          if (!prev) return prev;
          const existingItems = prev.items ?? [];
          let nextItems: BlockedClaimItem[];
          if (updated) {
            // Replace existing row (or insert if it wasn't present).
            const idx = existingItems.findIndex((i) => i.claimId === claimId);
            if (idx >= 0) {
              nextItems = [...existingItems];
              nextItems[idx] = updated;
            } else {
              nextItems = [updated, ...existingItems];
            }
          } else {
            // No blocking findings anymore — the claim is now clean. Drop it.
            nextItems = existingItems.filter((i) => i.claimId !== claimId);
          }
          return {
            ...prev,
            items: nextItems,
            metrics: {
              blockedClaims: nextItems.length,
              totalBlockingFindings: nextItems.reduce(
                (sum, i) => sum + i.blockingCount,
                0,
              ),
              candidatesEvaluated: prev.metrics?.candidatesEvaluated ?? nextItems.length,
            },
            generatedAt: json.generatedAt ?? prev.generatedAt,
          };
        });
        setRowMessages((prev) => ({
          ...prev,
          [claimId]: updated
            ? `Still blocked: ${updated.blockingCount} finding(s).`
            : "Cleared — no blocking findings remain.",
        }));
      } catch (err) {
        setRowMessages((prev) => ({
          ...prev,
          [claimId]: err instanceof Error ? err.message : "Recheck failed",
        }));
      } finally {
        setRowChecking((prev) => ({ ...prev, [claimId]: false }));
      }
    },
    [organizationId],
  );

  const metrics = payload?.metrics ?? {
    blockedClaims: 0,
    totalBlockingFindings: 0,
    candidatesEvaluated: 0,
  };
  const items = payload?.items ?? [];

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Billing / Workqueue</p>
          <h1>Rejections</h1>
          <p className="hero-copy">
            Claims the clearinghouse or payer rejected before adjudication. Fix
            the issue on the claim, then resubmit on the 837P Batches page.
          </p>
        </div>
        <div className="hero-actions">
          <button
            className="button"
            type="button"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <Link className="button button-secondary" href="/billing/837p-batches">
            837P Batches
          </Link>
        </div>
      </section>

      {error ? <div className="alert-panel">{error}</div> : null}

      <section className="metric-grid">
        <article className="metric-card">
          <span>Rejected Claims</span>
          <strong>{loading ? "—" : metrics.blockedClaims}</strong>
        </article>
        <article className="metric-card">
          <span>Last Refreshed</span>
          <strong>
            {payload?.generatedAt
              ? new Date(payload.generatedAt).toLocaleTimeString()
              : "—"}
          </strong>
        </article>
      </section>

      <section className="panel">
        <h2>Rejected Claims</h2>
        {loading ? <div className="empty-state">Loading rejections…</div> : null}
        {!loading && items.length === 0 && !error ? (
          <div className="empty-state success-panel">
            No rejected claims. Everything submitted is currently moving through
            the payer.
          </div>
        ) : null}

        <div className="stack-list">
          {items.map((item) => (
            <article className="stack-item" key={item.claimId}>
              <div className="stack-row">
                <div>
                  <strong>{item.patientName}</strong>
                  <span>
                    Payer: {item.payerName} · DOS: {formatDate(item.serviceDateFrom)}
                    {item.serviceDateTo && item.serviceDateTo !== item.serviceDateFrom
                      ? ` – ${formatDate(item.serviceDateTo)}`
                      : ""}
                  </span>
                  <span>
                    Claim{" "}
                    {item.claimNumber ? `#${item.claimNumber}` : item.claimId.slice(0, 8)}{" "}
                    · DOB: {formatDate(item.patientDob)} · Total:{" "}
                    {formatMoney(item.totalChargeAmount)}
                  </span>
                </div>
                <div className="invoice-money-grid">
                  <span className={statusClass(item.claimStatus)}>
                    {item.claimStatus ?? "status not set"}
                  </span>
                  <span className="status status-red">
                    {item.blockingCount} blocking
                  </span>
                  {item.warningCount > 0 ? (
                    <span className="status status-yellow">
                      {item.warningCount} warning
                    </span>
                  ) : null}
                </div>
              </div>

              {item.engineError ? (
                <div className="alert-panel">
                  Validation engine error: {item.engineError}
                </div>
              ) : null}

              {item.blockingFindings.length > 0 ? (
                <div className="payment-history">
                  <strong>Reasons blocked</strong>
                  {item.blockingFindings.map((f) => (
                    <span key={`${item.claimId}-${f.ruleId}`}>
                      <strong>{f.message}</strong>
                      {f.whyItMatters ? ` — ${f.whyItMatters}` : ""}
                      {f.fixRoute ? (
                        <>
                          {" · "}
                          <Link href={f.fixRoute}>Open fix route</Link>
                        </>
                      ) : null}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="section-actions">
                <button
                  className="button"
                  type="button"
                  onClick={() => void recheckRow(item.claimId)}
                  disabled={rowChecking[item.claimId]}
                >
                  {rowChecking[item.claimId] ? "Rechecking…" : "Recheck"}
                </button>
                <Link
                  className="button button-secondary"
                  href={buildClaimDetailHref({
                    professionalClaimId: item.claimId,
                    organizationId,
                  })}
                >
                  Open Claim
                </Link>
                {item.patientId ? (
                  <Link
                    className="button button-secondary"
                    href={`/clients/${item.patientId}`}
                  >
                    Client Chart
                  </Link>
                ) : null}
                {item.payerProfileId ? (
                  <Link className="button button-secondary" href="/settings/payers">
                    Payer Settings
                  </Link>
                ) : null}
                {rowMessages[item.claimId] ? (
                  <span className="status muted-text">
                    {rowMessages[item.claimId]}
                  </span>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
