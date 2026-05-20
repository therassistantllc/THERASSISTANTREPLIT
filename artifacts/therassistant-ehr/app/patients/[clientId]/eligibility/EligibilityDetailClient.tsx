"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type Policy = {
  id: string;
  planName: string;
  policyNumber: string;
  priority: string;
  active: boolean;
  effectiveDate: string;
  terminationDate: string;
  payerName: string;
  clearinghousePayerId: string;
};

type EligibilityCheck = {
  id: string;
  status: string;
  checkedAt: string;
  copayAmount: number | null;
  deductibleRemaining: number | null;
  coverageStartDate: string;
  coverageEndDate: string;
  coverageLevel?: string | null;
  serviceTypeCode: string;
  responseSummary: unknown;
  rawResponse: unknown;
  errorMessage: string;
  insurancePolicyId: string;
};

type EligibilityResponse = {
  success?: boolean;
  patient?: { id: string; name: string; dateOfBirth: string; email: string; phone: string };
  policies?: Policy[];
  latestEligibility?: EligibilityCheck | null;
  eligibilityHistory?: EligibilityCheck[];
  error?: string;
};

const STALE_DAYS = 30;

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function money(value: number | null) {
  if (value === null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatDate(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function statusClass(status: string) {
  const value = status.toLowerCase();
  if (value.includes("active")) return "status status-green";
  if (value.includes("inactive") || value.includes("error")) return "status status-red";
  return "status status-yellow";
}

function compactJson(value: unknown) {
  if (!value) return "No parsed details available.";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unable to display eligibility payload.";
  }
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

type Banner = { tone: "warn" | "error" | "info"; message: string };

function deriveBanner(latest: EligibilityCheck | null): Banner | null {
  if (!latest) {
    return { tone: "warn", message: "No eligibility check on file. Run a real-time check before the visit." };
  }
  const status = (latest.status || "").toLowerCase();
  if (status === "error") {
    return { tone: "error", message: latest.errorMessage || "Last eligibility check failed. Retry below." };
  }
  const days = daysSince(latest.checkedAt);
  if (days !== null && days > STALE_DAYS) {
    return { tone: "warn", message: `Last eligibility check was ${days} days ago (older than ${STALE_DAYS} days). Re-check before billing.` };
  }
  if (status === "inactive") {
    return { tone: "error", message: "Payer reports coverage is INACTIVE. Verify insurance with patient." };
  }
  return null;
}

export default function EligibilityDetailClient({ clientId }: { clientId: string }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [data, setData] = useState<EligibilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null); // policyId being checked, or "any"
  const [runError, setRunError] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const response = await fetch(`/api/patients/${clientId}/eligibility?organizationId=${encodeURIComponent(organizationId)}`);
    const json = (await response.json()) as EligibilityResponse;
    if (!response.ok || !json.success) {
      setError(json.error || "Unable to load eligibility.");
    } else {
      setData(json);
    }
    setLoading(false);
  }, [clientId, organizationId]);

  useEffect(() => {
    if (organizationId && clientId) {
      void load();
    } else {
      setError("Missing organizationId or clientId.");
      setLoading(false);
    }
  }, [clientId, organizationId, load]);

  const runCheck = useCallback(async (insurancePolicyId?: string | null) => {
    setRunning(insurancePolicyId ?? "any");
    setRunError(null);
    setRunMessage(null);
    try {
      const res = await fetch(`/api/clearinghouse/eligibility/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patientId: clientId,
          insurancePolicyId: insurancePolicyId ?? null,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setRunError(json?.error || "Eligibility check failed.");
      } else {
        const status = json?.normalized?.status ?? "completed";
        setRunMessage(`Eligibility check ${status}.`);
        await load();
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Eligibility check failed.");
    } finally {
      setRunning(null);
    }
  }, [clientId, load]);

  const patient = data?.patient;
  const latest = data?.latestEligibility ?? null;
  const banner = deriveBanner(latest);
  const isRunningAny = running !== null;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Eligibility</p>
          <h1>{patient?.name || "Patient eligibility"}</h1>
          <p className="hero-copy">Coverage, copay, deductible, and benefit history for the visit workflow.</p>
        </div>
        <div className="hero-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={isRunningAny}
            onClick={() => runCheck(null)}
          >
            {isRunningAny ? "Checking…" : "Check eligibility"}
          </button>
          <Link className="button button-secondary" href={`/clients/${clientId}`}>Patient Chart</Link>
          <Link className="button button-secondary" href={`/workqueue/new?clientId=${clientId}&organizationId=${organizationId}&reason=eligibility_question`}>Route Issue</Link>
        </div>
      </section>

      {banner ? (
        <div
          className="alert-panel"
          style={{
            background: banner.tone === "error" ? "#fef2f2" : banner.tone === "warn" ? "#fffbeb" : "#eff6ff",
            borderColor: banner.tone === "error" ? "#fecaca" : banner.tone === "warn" ? "#fde68a" : "#bfdbfe",
            color: banner.tone === "error" ? "#991b1b" : banner.tone === "warn" ? "#92400e" : "#1e40af",
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            {banner.tone === "error" ? "Eligibility issue" : banner.tone === "warn" ? "Eligibility attention" : "Eligibility"}
          </strong>
          <span>{banner.message}</span>
        </div>
      ) : null}

      {runError ? (
        <div className="alert-panel" style={{ background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          <strong style={{ display: "block", marginBottom: 4 }}>Eligibility check failed</strong>
          <span>{runError}</span>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="button button-secondary" onClick={() => runCheck(null)} disabled={isRunningAny}>
              {isRunningAny ? "Retrying…" : "Retry"}
            </button>
          </div>
        </div>
      ) : null}

      {runMessage ? (
        <div className="alert-panel" style={{ background: "#ecfdf5", borderColor: "#a7f3d0", color: "#065f46" }}>
          {runMessage}
        </div>
      ) : null}

      {loading ? <div className="empty-state">Loading eligibility…</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}

      {!loading && !error ? (
        <>
          <section className="metric-grid">
            <div className="metric-card">
              <span>Status</span>
              <strong className="metric-text">{latest?.status || "not checked"}</strong>
            </div>
            <div className="metric-card">
              <span>Copay</span>
              <strong>{money(latest?.copayAmount ?? null)}</strong>
            </div>
            <div className="metric-card">
              <span>Deductible Remaining</span>
              <strong>{money(latest?.deductibleRemaining ?? null)}</strong>
            </div>
            <div className="metric-card">
              <span>Last Checked</span>
              <strong className="metric-text">{formatDate(latest?.checkedAt || "")}</strong>
            </div>
          </section>

          <section className="chart-grid">
            <div className="panel">
              <div className="panel-header">
                <div>
                  <h2>Current eligibility</h2>
                  <p>{patient?.dateOfBirth ? `DOB ${formatDate(patient.dateOfBirth)}` : "Patient benefit detail"}</p>
                </div>
                <span className={statusClass(latest?.status || "not_checked")}>{latest?.status || "not checked"}</span>
              </div>
              <div className="detail-list">
                <p><strong>Coverage start:</strong> {formatDate(latest?.coverageStartDate || "")}</p>
                <p><strong>Coverage end:</strong> {formatDate(latest?.coverageEndDate || "")}</p>
                <p><strong>Coverage type:</strong> {latest?.coverageLevel || "—"}</p>
                <p><strong>Service type:</strong> {latest?.serviceTypeCode || "98"}</p>
                <p><strong>Error:</strong> {latest?.errorMessage || "—"}</p>
              </div>
            </div>

            <div className="panel">
              <h2>Insurance policies</h2>
              <div className="stack-list">
                {(data?.policies || []).map((policy) => (
                  <div className="stack-item" key={policy.id}>
                    <strong>{policy.payerName || policy.planName || "Insurance policy"}</strong>
                    <span>{policy.priority || "policy"} · {policy.active ? "active" : "inactive"}</span>
                    <span>Policy: {policy.policyNumber || "—"}</span>
                    <span>Payer ID: {policy.clearinghousePayerId || "—"}</span>
                    <span>{formatDate(policy.effectiveDate)} – {formatDate(policy.terminationDate)}</span>
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={isRunningAny}
                        onClick={() => runCheck(policy.id)}
                      >
                        {running === policy.id ? "Checking…" : "Check this policy"}
                      </button>
                    </div>
                  </div>
                ))}
                {(data?.policies || []).length === 0 ? <div className="empty-state">No insurance policies found.</div> : null}
              </div>
            </div>

            <div className="panel wide-panel">
              <h2>Eligibility history</h2>
              <div className="stack-list">
                {(data?.eligibilityHistory || []).map((check) => (
                  <div className="stack-item" key={check.id}>
                    <div className="stack-row">
                      <div>
                        <strong>{formatDate(check.checkedAt)}</strong>
                        <span>Service type {check.serviceTypeCode || "98"}</span>
                      </div>
                      <span className={statusClass(check.status)}>{check.status || "unknown"}</span>
                    </div>
                    <div className="detail-list compact-detail-list">
                      <p><strong>Copay:</strong> {money(check.copayAmount)}</p>
                      <p><strong>Deductible:</strong> {money(check.deductibleRemaining)}</p>
                      <p><strong>Coverage:</strong> {formatDate(check.coverageStartDate)} – {formatDate(check.coverageEndDate)}</p>
                    </div>
                  </div>
                ))}
                {(data?.eligibilityHistory || []).length === 0 ? <div className="empty-state">No eligibility checks found.</div> : null}
              </div>
            </div>

            <div className="panel wide-panel">
              <h2>Response summary</h2>
              <pre className="json-panel">{compactJson(latest?.responseSummary ?? latest?.rawResponse)}</pre>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
