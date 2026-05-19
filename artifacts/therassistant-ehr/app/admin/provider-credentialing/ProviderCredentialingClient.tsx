"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type ProviderCredentialingRecord = {
  id: string;
  provider_name?: string | null;
  credential_display?: string | null;
  individual_npi?: string | null;
  email?: string | null;
  practice_name?: string | null;
  practice_address?: string | null;
  practice_tax_id?: string | null;
  group_npi?: string | null;
  group_medicaid_id?: string | null;
  phone?: string | null;
  taxonomy_code?: string | null;
  individual_medicaid_id?: string | null;
  caqh_id?: string | null;
  other_payer_id?: string | null;
  primary_license_number?: string | null;
  primary_license_effective_date?: string | null;
  payer_effective_date?: string | null;
  payer_revalidation_date?: string | null;
  secondary_license_number?: string | null;
  secondary_license_effective_date?: string | null;
  is_active?: boolean | null;
  updated_at?: string | null;
};

type ProviderCredentialingPayload = {
  success: boolean;
  error?: string;
  providers?: ProviderCredentialingRecord[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not listed";
  const date = new Date(`${value}`.includes("T") ? value : `${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function statusClass(value: boolean | null | undefined) {
  return value === false ? "status status-red" : "status status-green";
}

export default function ProviderCredentialingClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [providers, setProviders] = useState<ProviderCredentialingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadProviders() {
      if (!organizationId) {
        setError("Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.");
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/providers/credentialing?organizationId=${encodeURIComponent(organizationId)}`, {
          cache: "no-store",
        });
        const json = (await response.json()) as ProviderCredentialingPayload;
        if (cancelled) return;
        if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load provider credentialing records");
        setProviders(json.providers ?? []);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load provider credentialing records");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadProviders();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const activeCount = useMemo(
    () => providers.filter((provider) => provider.is_active !== false).length,
    [providers],
  );
  const expiringCount = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now();
    return providers.filter((provider) => {
      if (!provider.payer_revalidation_date) return false;
      const date = new Date(`${provider.payer_revalidation_date}T00:00:00`);
      if (Number.isNaN(date.getTime())) return false;
      const days = (date.getTime() - now) / (1000 * 60 * 60 * 24);
      return days <= 120;
    }).length;
  }, [providers]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Provider Credentialing</h1>
          <p className="hero-copy">Provider identifiers, practice affiliations, taxonomy, license, and payer credentialing dates.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/">Home</Link>
        </div>
      </section>

      {error ? <div className="alert-panel">{error}</div> : null}

      <section className="metric-grid">
        <article className="metric-card">
          <span>Total Providers</span>
          <strong>{loading ? "—" : providers.length}</strong>
        </article>
        <article className="metric-card">
          <span>Active</span>
          <strong>{loading ? "—" : activeCount}</strong>
        </article>
        <article className="metric-card">
          <span>Due Soon</span>
          <strong>{loading ? "—" : expiringCount}</strong>
        </article>
        <article className="metric-card">
          <span>Practices</span>
          <strong>{loading ? "—" : new Set(providers.map((provider) => provider.practice_name).filter(Boolean)).size}</strong>
        </article>
      </section>

      <section className="panel">
        <h2>Credentialing Records</h2>
        {loading ? <div className="empty-state">Loading provider records…</div> : null}
        {!loading && providers.length === 0 ? <div className="empty-state">No provider credentialing records found.</div> : null}

        <div className="provider-grid">
          {providers.map((provider) => (
            <article className="provider-card" key={provider.id}>
              <div className="provider-card-header">
                <div>
                  <h3>{provider.provider_name ?? "Provider"}</h3>
                  <p>{provider.credential_display ?? "Credentials not listed"}</p>
                </div>
                <span className={statusClass(provider.is_active)}>{provider.is_active === false ? "Inactive" : "Active"}</span>
              </div>

              <div className="detail-list compact-detail-list">
                <p><strong>Practice:</strong> {provider.practice_name ?? "Not listed"}</p>
                <p><strong>Email:</strong> {provider.email ?? "Not listed"}</p>
                <p><strong>Phone:</strong> {provider.phone ?? "Not listed"}</p>
                <p><strong>Individual NPI:</strong> {provider.individual_npi ?? "Not listed"}</p>
                <p><strong>Group NPI:</strong> {provider.group_npi ?? "Not listed"}</p>
                <p><strong>Group Medicaid ID:</strong> {provider.group_medicaid_id ?? "Not listed"}</p>
                <p><strong>Individual Medicaid ID:</strong> {provider.individual_medicaid_id ?? "Not listed"}</p>
                <p><strong>Taxonomy:</strong> {provider.taxonomy_code ?? "Not listed"}</p>
                <p><strong>License:</strong> {provider.primary_license_number ?? "Not listed"}</p>
                <p><strong>License effective:</strong> {formatDate(provider.primary_license_effective_date)}</p>
                <p><strong>Payer effective:</strong> {formatDate(provider.payer_effective_date)}</p>
                <p><strong>Revalidation:</strong> {formatDate(provider.payer_revalidation_date)}</p>
                <p><strong>Secondary license:</strong> {provider.secondary_license_number ?? "Not listed"}</p>
                <p><strong>Secondary effective:</strong> {formatDate(provider.secondary_license_effective_date)}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
