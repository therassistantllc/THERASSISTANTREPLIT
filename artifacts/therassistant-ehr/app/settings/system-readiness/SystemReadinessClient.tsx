"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type ReadinessCheck = {
  key: string;
  label: string;
  pass: boolean;
  detail: string;
};

type Warning = {
  key: string;
  label: string;
  type: "info";
  detail: string;
};

type ReadinessPayload = {
  org_name: string | null;
  checks: ReadinessCheck[];
  warnings: Warning[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    ready: boolean;
  };
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

const FIX_LINKS: Record<string, string> = {
  org_billing_profile: "/settings/organization",
  active_provider: "/settings/providers",
  provider_npi_taxonomy: "/settings/providers",
  service_location: "/settings/service-locations",
  payer_profile: "/settings/payers",
  clearinghouse_connection: "/settings/clearinghouse",
  submitter_id: "/settings/clearinghouse",
  receiver_id: "/settings/clearinghouse",
  eligibility_service_type: "/settings/clearinghouse",
  fee_schedule_or_billing_defaults: "/settings/billing-defaults",
};

export default function SystemReadinessClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [data, setData] = useState<ReadinessPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!organizationId) { setLoading(false); return; }
    setLoading(true);
    fetch(`/api/settings/system-readiness?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((json: ReadinessPayload) => setData(json))
      .catch(() => setError("Failed to load system readiness status."))
      .finally(() => setLoading(false));
  }, [organizationId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>System Readiness</h1>
          <p className="hero-copy">
            Configuration checklist — all items must pass before the system can generate and transmit claims.
          </p>
        </div>
        <div className="hero-actions">
          <button className="button button-secondary" onClick={load} disabled={loading}>
            {loading ? "Checking…" : "Refresh"}
          </button>
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      {!organizationId && <div className="alert-panel">No organization context.</div>}
      {error && <div className="alert-panel">{error}</div>}

      {loading && <div className="panel"><div className="empty-state">Running checks…</div></div>}

      {!loading && data && (
        <>
          <section className="metric-grid">
            <article className="metric-card">
              <span>Total Checks</span>
              <strong>{data.summary.total}</strong>
            </article>
            <article className="metric-card">
              <span>Passed</span>
              <strong style={{ color: "var(--text-success)" }}>{data.summary.passed}</strong>
            </article>
            <article className="metric-card">
              <span>Failed</span>
              <strong style={{ color: data.summary.failed > 0 ? "var(--text-danger)" : undefined }}>
                {data.summary.failed}
              </strong>
            </article>
            <article className="metric-card">
              <span>Overall Status</span>
              <strong>
                {data.summary.ready ? (
                  <span style={{ color: "var(--text-success)" }}>✓ Ready</span>
                ) : (
                  <span style={{ color: "var(--text-danger)" }}>⚠ Not Ready</span>
                )}
              </strong>
            </article>
          </section>

          {!data.summary.ready && (
            <div className="alert-panel">
              <strong>{data.summary.failed} configuration item{data.summary.failed !== 1 ? "s" : ""} must be resolved before claim submission.</strong>
              {" "}Use the links below to fix each failing check.
            </div>
          )}

          <section className="panel">
            <h2>Configuration Checks</h2>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-color)", textAlign: "left" }}>
                  <th style={{ padding: "10px 12px", fontSize: "var(--text-sm)" }}>Status</th>
                  <th style={{ padding: "10px 12px", fontSize: "var(--text-sm)" }}>Check</th>
                  <th style={{ padding: "10px 12px", fontSize: "var(--text-sm)" }}>Detail</th>
                  <th style={{ padding: "10px 12px", fontSize: "var(--text-sm)" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {data.checks.map((check) => (
                  <tr key={check.key} style={{ borderBottom: "1px solid var(--border-color)" }}>
                    <td style={{ padding: "10px 12px" }}>
                      {check.pass ? (
                        <span style={{ color: "var(--text-success)", fontSize: "1.1em" }}>✓</span>
                      ) : (
                        <span style={{ color: "var(--text-danger)", fontSize: "1.1em" }}>✗</span>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", fontWeight: check.pass ? undefined : 600 }}>{check.label}</td>
                    <td style={{ padding: "10px 12px", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>{check.detail}</td>
                    <td style={{ padding: "10px 12px" }}>
                      {!check.pass && FIX_LINKS[check.key] && (
                        <Link
                          href={`${FIX_LINKS[check.key]}${organizationId ? `?organizationId=${organizationId}` : ""}`}
                          style={{ color: "var(--accent)", fontSize: "var(--text-sm)", textDecoration: "underline" }}
                        >
                          Fix →
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h2>Schema Notices</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
              These are informational notices about legacy table overlap. No tables have been deleted or altered.
            </p>
            {data.warnings.map((w) => (
              <article key={w.key} style={{ padding: "var(--space-4)", background: "var(--surface-2)", borderRadius: "var(--radius)", marginBottom: "var(--space-3)", borderLeft: "3px solid var(--accent)" }}>
                <strong style={{ fontSize: "var(--text-sm)" }}>ℹ {w.label}</strong>
                <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginTop: "4px" }}>{w.detail}</p>
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
