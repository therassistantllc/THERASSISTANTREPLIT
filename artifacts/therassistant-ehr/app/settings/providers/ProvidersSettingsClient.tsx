"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type CredentialingRecord = {
  id: string;
  provider_name: string;
  credential_display: string | null;
  individual_npi: string | null;
  taxonomy_code: string | null;
  individual_medicaid_id: string | null;
  group_npi: string | null;
  practice_tax_id: string | null;
  primary_license_number: string | null;
  payer_revalidation_date: string | null;
  is_active: boolean;
  updated_at: string;
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function missing(value: string | null | undefined) {
  return !value ? (
    <span style={{ color: "var(--text-danger)", fontWeight: 600 }}>⚠ Missing</span>
  ) : (
    <span style={{ color: "var(--text-success)" }}>{value}</span>
  );
}

export default function ProvidersSettingsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [providers, setProviders] = useState<CredentialingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!organizationId) { setLoading(false); return; }
    fetch(`/api/providers/credentialing?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((json: { success?: boolean; providers?: CredentialingRecord[]; error?: string }) => {
        if (!json.success) throw new Error(json.error ?? "Failed to load providers");
        setProviders(json.providers ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [organizationId]);

  const warnings = useMemo(() => {
    const issues: string[] = [];
    providers.forEach((p) => {
      if (!p.individual_npi) issues.push(`${p.provider_name}: missing individual NPI`);
      if (!p.taxonomy_code) issues.push(`${p.provider_name}: missing taxonomy code`);
      if (!p.practice_tax_id) issues.push(`${p.provider_name}: missing practice Tax ID`);
    });
    return issues;
  }, [providers]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Provider Settings</h1>
          <p className="hero-copy">Credentialing profiles, NPI, taxonomy, payer enrollment status, and claim readiness.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-primary" href={`/admin/provider-credentialing${organizationId ? `?organizationId=${organizationId}` : ""}`}>
            Manage Credentialing
          </Link>
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      {!organizationId && <div className="alert-panel">No organization context.</div>}
      {error && <div className="alert-panel">{error}</div>}

      {warnings.length > 0 && (
        <div className="alert-panel">
          <strong>Claim readiness warnings:</strong>
          <ul style={{ margin: "8px 0 0 16px", fontSize: "var(--text-sm)" }}>
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      <section className="metric-grid">
        <article className="metric-card">
          <span>Total Credentialing Profiles</span>
          <strong>{loading ? "—" : providers.length}</strong>
        </article>
        <article className="metric-card">
          <span>Active</span>
          <strong>{loading ? "—" : providers.filter((p) => p.is_active !== false).length}</strong>
        </article>
        <article className="metric-card">
          <span>Missing NPI</span>
          <strong style={{ color: providers.filter((p) => !p.individual_npi).length > 0 ? "var(--text-danger)" : undefined }}>
            {loading ? "—" : providers.filter((p) => !p.individual_npi).length}
          </strong>
        </article>
        <article className="metric-card">
          <span>Missing Taxonomy</span>
          <strong style={{ color: providers.filter((p) => !p.taxonomy_code).length > 0 ? "var(--text-danger)" : undefined }}>
            {loading ? "—" : providers.filter((p) => !p.taxonomy_code).length}
          </strong>
        </article>
      </section>

      <section className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <h2>Credentialing Profiles</h2>
          <Link
            className="button button-primary"
            href={`/admin/provider-credentialing${organizationId ? `?organizationId=${organizationId}` : ""}`}
          >
            Add / Edit Profiles
          </Link>
        </div>

        {loading && <div className="empty-state">Loading…</div>}
        {!loading && providers.length === 0 && (
          <div className="alert-panel">
            No credentialing profiles found. Claims cannot be generated without provider NPI and taxonomy.
          </div>
        )}

        {providers.map((p) => (
          <article key={p.id} className="metric-card" style={{ marginBottom: "var(--space-3)", padding: "var(--space-4)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <strong>{p.provider_name}</strong>
                {p.credential_display && (
                  <span style={{ color: "var(--text-secondary)", marginLeft: "8px", fontSize: "var(--text-sm)" }}>
                    {p.credential_display}
                  </span>
                )}
              </div>
              <span className={p.is_active !== false ? "status status-green" : "status status-red"}>
                {p.is_active !== false ? "Active" : "Inactive"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "var(--space-2)", marginTop: "var(--space-3)", fontSize: "var(--text-sm)" }}>
              <div><strong>Individual NPI:</strong> {missing(p.individual_npi)}</div>
              <div><strong>Taxonomy:</strong> {missing(p.taxonomy_code)}</div>
              <div><strong>Group NPI:</strong> {missing(p.group_npi)}</div>
              <div><strong>Medicaid ID:</strong> {missing(p.individual_medicaid_id)}</div>
              <div><strong>Practice Tax ID:</strong> {missing(p.practice_tax_id)}</div>
              <div><strong>License:</strong> {missing(p.primary_license_number)}</div>
              {p.payer_revalidation_date && (
                <div><strong>Revalidation:</strong> {new Date(p.payer_revalidation_date).toLocaleDateString()}</div>
              )}
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
