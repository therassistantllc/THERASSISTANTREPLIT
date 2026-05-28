"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type TelehealthPlatform = "zoom" | "google_meet";

type CredentialingRecord = {
  id: string;
  provider_name: string;
  credential_display: string | null;
  individual_npi: string | null;
  taxonomy_code: string | null;
  individual_medicaid_id: string | null;
  group_npi: string | null;
  practice_tax_id: string | null;
  practice_name: string | null;
  email: string | null;
  phone: string | null;
  primary_license_number: string | null;
  payer_revalidation_date: string | null;
  telehealth_url: string | null;
  stripe_payment_link_url: string | null;
  default_telehealth_platform: TelehealthPlatform | null;
  stripe_connect_account_id: string | null;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  stripe_details_submitted: boolean;
  stripe_requirements: { currently_due?: string[]; disabled_reason?: string | null } | null;
  stripe_account_status_updated_at: string | null;
  is_active: boolean;
  updated_at: string;
};

type TelehealthConnection = {
  platform: TelehealthPlatform;
  connectionId: string;
  accountEmail: string | null;
  status: string;
  expiresAt: string | null;
  lastError: string | null;
};

type TelehealthConnectionsResponse = {
  success?: boolean;
  error?: string;
  platformStatus?: Record<TelehealthPlatform, { configured: boolean; missingEnv: string[] }>;
  connections?: TelehealthConnection[];
};

type ConnectStatus = "not_connected" | "onboarding" | "connected" | "restricted";

function connectStatusOf(p: CredentialingRecord): ConnectStatus {
  if (!p.stripe_connect_account_id) return "not_connected";
  if (p.stripe_charges_enabled) {
    const due = p.stripe_requirements?.currently_due ?? [];
    return due.length > 0 ? "restricted" : "connected";
  }
  if (p.stripe_details_submitted) return "restricted";
  return "onboarding";
}

const CONNECT_LABEL: Record<ConnectStatus, string> = {
  not_connected: "Not connected",
  onboarding: "Onboarding in progress",
  connected: "Connected",
  restricted: "Action needed",
};

const CONNECT_CLASS: Record<ConnectStatus, string> = {
  not_connected: "status status-grey",
  onboarding: "status status-yellow",
  connected: "status status-green",
  restricted: "status status-red",
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
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
  const [showAdd, setShowAdd] = useState(false);

  const reload = () => {
    if (!organizationId) return;
    fetch(`/api/providers/credentialing?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json: { success?: boolean; providers?: CredentialingRecord[]; error?: string }) => {
        if (!json.success) throw new Error(json.error ?? "Failed to load providers");
        setProviders(json.providers ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!organizationId) { setLoading(false); return; }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          <button type="button" className="button button-primary" onClick={() => setShowAdd(true)}>
            + Add Provider
          </button>
          <Link className="button button-secondary" href={`/admin/provider-credentialing${organizationId ? `?organizationId=${organizationId}` : ""}`}>
            Credentialing Details
          </Link>
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      {!organizationId && <div className="alert-panel">No organization context.</div>}
      {error && <div className="alert-panel">{error}</div>}

      <TelehealthConnectionsPanel />

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

      <ReturnFromStripeBanner organizationId={organizationId} onRefreshed={(updated) => setProviders((prev) => prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)))} />

      <section className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <h2>Credentialing Profiles</h2>
          <button type="button" className="button button-primary" onClick={() => setShowAdd(true)}>
            + Add Provider
          </button>
        </div>

        {loading && <div className="empty-state">Loading…</div>}
        {!loading && providers.length === 0 && (
          <div className="alert-panel">
            No credentialing profiles found. Claims cannot be generated without provider NPI and taxonomy.
          </div>
        )}

        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            organizationId={organizationId}
            onSaved={(updated) =>
              setProviders((prev) => prev.map((existing) => (existing.id === updated.id ? { ...existing, ...updated } : existing)))
            }
            onReload={reload}
          />
        ))}
      </section>

      {showAdd && (
        <ProviderProfileModal
          mode="create"
          organizationId={organizationId}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); reload(); }}
        />
      )}
    </main>
  );
}

type ProfileFormState = {
  provider_name: string;
  credential_display: string;
  individual_npi: string;
  taxonomy_code: string;
  email: string;
  phone: string;
  practice_name: string;
  practice_tax_id: string;
  group_npi: string;
  individual_medicaid_id: string;
  primary_license_number: string;
  telehealth_url: string;
  stripe_payment_link_url: string;
  is_active: boolean;
};

function emptyForm(): ProfileFormState {
  return {
    provider_name: "", credential_display: "", individual_npi: "", taxonomy_code: "",
    email: "", phone: "", practice_name: "", practice_tax_id: "", group_npi: "",
    individual_medicaid_id: "", primary_license_number: "", telehealth_url: "",
    stripe_payment_link_url: "", is_active: true,
  };
}

function fromRecord(p: CredentialingRecord): ProfileFormState {
  return {
    provider_name: p.provider_name ?? "",
    credential_display: p.credential_display ?? "",
    individual_npi: p.individual_npi ?? "",
    taxonomy_code: p.taxonomy_code ?? "",
    email: p.email ?? "",
    phone: p.phone ?? "",
    practice_name: p.practice_name ?? "",
    practice_tax_id: p.practice_tax_id ?? "",
    group_npi: p.group_npi ?? "",
    individual_medicaid_id: p.individual_medicaid_id ?? "",
    primary_license_number: p.primary_license_number ?? "",
    telehealth_url: p.telehealth_url ?? "",
    stripe_payment_link_url: p.stripe_payment_link_url ?? "",
    is_active: p.is_active !== false,
  };
}

function ProviderProfileModal({
  mode,
  organizationId,
  existing,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  organizationId: string;
  existing?: CredentialingRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ProfileFormState>(() =>
    mode === "edit" && existing ? fromRecord(existing) : emptyForm(),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update = <K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!form.provider_name.trim()) { setErr("Provider name is required."); return; }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        provider_name: form.provider_name.trim(),
        credential_display: form.credential_display.trim() || null,
        individual_npi: form.individual_npi.trim() || null,
        taxonomy_code: form.taxonomy_code.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        practice_name: form.practice_name.trim() || null,
        practice_tax_id: form.practice_tax_id.trim() || null,
        group_npi: form.group_npi.trim() || null,
        individual_medicaid_id: form.individual_medicaid_id.trim() || null,
        primary_license_number: form.primary_license_number.trim() || null,
        telehealth_url: form.telehealth_url.trim() || null,
        stripe_payment_link_url: form.stripe_payment_link_url.trim() || null,
        is_active: form.is_active,
      };
      const url = mode === "create"
        ? `/api/providers/credentialing?organizationId=${encodeURIComponent(organizationId)}`
        : `/api/providers/credentialing?organizationId=${encodeURIComponent(organizationId)}&id=${encodeURIComponent(existing!.id)}`;
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Save failed");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: keyof ProfileFormState, opts?: { type?: string; placeholder?: string; required?: boolean }) => (
    <label style={{ display: "block", fontSize: 12 }}>
      <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
        {label}{opts?.required ? " *" : ""}
      </span>
      <input
        type={opts?.type ?? "text"}
        value={String(form[key] ?? "")}
        onChange={(e) => update(key, e.target.value as never)}
        placeholder={opts?.placeholder}
        required={opts?.required}
        style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--border-default, #d8e1e9)", borderRadius: 4, fontSize: 13 }}
      />
    </label>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
      }}
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface, #fff)", borderRadius: 8, maxWidth: 720, width: "100%",
          maxHeight: "90vh", overflowY: "auto", padding: "20px 24px",
          boxShadow: "0 20px 50px rgba(15,23,42,0.25)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{mode === "create" ? "Add Provider" : "Edit Provider Profile"}</h2>
          <button type="button" className="button button-secondary" onClick={onClose} style={{ padding: "4px 10px", fontSize: 12 }}>
            ✕
          </button>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 0, marginBottom: 16 }}>
          Core profile, NPI, taxonomy, contact, telehealth, and Stripe payment link. Detailed credentialing dates and CAQH IDs live on the Credentialing Details screen.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
          {field("Provider name", "provider_name", { required: true, placeholder: "Jane Doe, LCSW" })}
          {field("Credentials display", "credential_display", { placeholder: "LCSW, PhD" })}
          {field("Individual NPI", "individual_npi", { placeholder: "10-digit" })}
          {field("Taxonomy code", "taxonomy_code", { placeholder: "103TC0700X" })}
          {field("Email", "email", { type: "email" })}
          {field("Phone", "phone", { type: "tel" })}
          {field("Practice name", "practice_name")}
          {field("Practice Tax ID", "practice_tax_id")}
          {field("Group NPI", "group_npi")}
          {field("Individual Medicaid ID", "individual_medicaid_id")}
          {field("Primary license number", "primary_license_number")}
          {field("Telehealth URL", "telehealth_url", { type: "url", placeholder: "https://…" })}
          {field("Stripe payment link", "stripe_payment_link_url", { type: "url", placeholder: "https://buy.stripe.com/…" })}
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, alignSelf: "end", paddingBottom: 4 }}>
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => update("is_active", e.target.checked)}
            />
            Active
          </label>
        </div>

        {err ? <div className="alert-panel" style={{ marginTop: 12 }}>{err}</div> : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={saving}>
            {saving ? "Saving…" : mode === "create" ? "Create Provider" : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ProviderCard({
  provider,
  organizationId,
  onSaved,
  onReload,
}: {
  provider: CredentialingRecord;
  organizationId: string;
  onSaved: (updated: Partial<CredentialingRecord> & { id: string }) => void;
  onReload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [telehealthUrl, setTelehealthUrl] = useState(provider.telehealth_url ?? "");
  const [stripeUrl, setStripeUrl] = useState(provider.stripe_payment_link_url ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [defaultPlatform, setDefaultPlatform] = useState<TelehealthPlatform | "">(
    provider.default_telehealth_platform ?? "",
  );
  const [savingDefault, setSavingDefault] = useState(false);

  const updateDefaultPlatform = async (next: TelehealthPlatform | "") => {
    setSavingDefault(true);
    try {
      const res = await fetch(`/api/settings/telehealth/default`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, platform: next === "" ? null : next }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to update default platform");
      setDefaultPlatform(next);
      onSaved({ id: provider.id, default_telehealth_platform: next === "" ? null : next });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to update default platform");
    } finally {
      setSavingDefault(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(
        `/api/providers/credentialing?organizationId=${encodeURIComponent(organizationId)}&id=${encodeURIComponent(provider.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            telehealth_url: telehealthUrl.trim() || null,
            stripe_payment_link_url: stripeUrl.trim() || null,
          }),
        },
      );
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Save failed");
      onSaved({
        id: provider.id,
        telehealth_url: telehealthUrl.trim() || null,
        stripe_payment_link_url: stripeUrl.trim() || null,
      });
      setEditing(false);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="metric-card" style={{ marginBottom: "var(--space-3)", padding: "var(--space-4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <strong>{provider.provider_name}</strong>
          {provider.credential_display && (
            <span style={{ color: "var(--text-secondary)", marginLeft: "8px", fontSize: "var(--text-sm)" }}>
              {provider.credential_display}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={provider.is_active !== false ? "status status-green" : "status status-red"}>
            {provider.is_active !== false ? "Active" : "Inactive"}
          </span>
          <button
            type="button"
            className="button button-secondary"
            style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={() => setEditingProfile(true)}
          >
            Edit Profile
          </button>
        </div>
      </div>
      {editingProfile && (
        <ProviderProfileModal
          mode="edit"
          existing={provider}
          organizationId={organizationId}
          onClose={() => setEditingProfile(false)}
          onSaved={() => { setEditingProfile(false); onReload(); }}
        />
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "var(--space-2)", marginTop: "var(--space-3)", fontSize: "var(--text-sm)" }}>
        <div><strong>Individual NPI:</strong> {missing(provider.individual_npi)}</div>
        <div><strong>Taxonomy:</strong> {missing(provider.taxonomy_code)}</div>
        <div><strong>Group NPI:</strong> {missing(provider.group_npi)}</div>
        <div><strong>Medicaid ID:</strong> {missing(provider.individual_medicaid_id)}</div>
        <div><strong>Practice Tax ID:</strong> {missing(provider.practice_tax_id)}</div>
        <div><strong>License:</strong> {missing(provider.primary_license_number)}</div>
        {provider.payer_revalidation_date && (
          <div><strong>Revalidation:</strong> {new Date(provider.payer_revalidation_date).toLocaleDateString()}</div>
        )}
      </div>

      <StripeConnectSection provider={provider} organizationId={organizationId} onUpdated={onSaved} />

      <div style={{ marginTop: "var(--space-4)", padding: "var(--space-3)", background: "var(--surface-muted, #f8fafc)", border: "1px solid var(--border-default, #e2e8f0)", borderRadius: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-2)" }}>
          <strong style={{ fontSize: "var(--text-sm)" }}>Telehealth &amp; Copay Collection</strong>
          {!editing ? (
            <button type="button" className="button button-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setEditing(true)}>
              Edit
            </button>
          ) : null}
        </div>

        {!editing ? (
          <div style={{ display: "grid", gap: 6, fontSize: "var(--text-sm)" }}>
            <div>
              <strong>Telehealth URL:</strong>{" "}
              {provider.telehealth_url ? (
                <a href={provider.telehealth_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-primary, #6366f1)" }}>
                  {provider.telehealth_url}
                </a>
              ) : (
                <span style={{ color: "var(--text-secondary)" }}>Not configured — Join Telehealth button will be disabled.</span>
              )}
            </div>
            <div>
              <strong>Stripe Payment Link:</strong>{" "}
              {provider.stripe_payment_link_url ? (
                <a href={provider.stripe_payment_link_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-primary, #6366f1)" }}>
                  {provider.stripe_payment_link_url}
                </a>
              ) : (
                <span style={{ color: "var(--text-secondary)" }}>Not configured — Collect Copay will only log manually.</span>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <label style={{ display: "block", fontSize: 12 }}>
              <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Telehealth URL</span>
              <input
                type="url"
                value={telehealthUrl}
                onChange={(e) => setTelehealthUrl(e.target.value)}
                placeholder="https://us02web.zoom.us/j/1234567890 or https://doxy.me/yourname"
                style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--border-default, #d8e1e9)", borderRadius: 4, fontSize: 13 }}
              />
              <small style={{ color: "var(--text-secondary)" }}>
                Your personal room URL — Zoom, Google Meet, Doxy.me, etc. Opens in a new tab when staff or clients click Join Telehealth.
              </small>
            </label>
            <label style={{ display: "block", fontSize: 12 }}>
              <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Stripe Payment Link</span>
              <input
                type="url"
                value={stripeUrl}
                onChange={(e) => setStripeUrl(e.target.value)}
                placeholder="https://buy.stripe.com/abc123"
                style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--border-default, #d8e1e9)", borderRadius: 4, fontSize: 13 }}
              />
              <small style={{ color: "var(--text-secondary)" }}>
                Create a Payment Link in your own Stripe dashboard. Funds settle to your Stripe account; we only log the transaction here.
              </small>
            </label>
            {saveError ? <div style={{ color: "var(--text-danger, #dc2626)", fontSize: 12 }}>{saveError}</div> : null}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="button button-primary" disabled={saving} onClick={handleSave}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={saving}
                onClick={() => {
                  setTelehealthUrl(provider.telehealth_url ?? "");
                  setStripeUrl(provider.stripe_payment_link_url ?? "");
                  setEditing(false);
                  setSaveError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div style={{ marginTop: "var(--space-3)", paddingTop: "var(--space-3)", borderTop: "1px dashed var(--border-default, #e2e8f0)" }}>
          <strong style={{ fontSize: "var(--text-sm)" }}>Default Telehealth Platform</strong>
          <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary)" }}>
            Used when staff click Join Telehealth — a meeting is auto-created on the chosen platform if the clinician is connected. Falls back to the static URL above when no platform is set or no connection exists.
          </div>
          <select
            value={defaultPlatform}
            disabled={savingDefault}
            onChange={(e) => void updateDefaultPlatform(e.target.value as TelehealthPlatform | "")}
            style={{ marginTop: 6, padding: "6px 10px", border: "1px solid var(--border-default, #d8e1e9)", borderRadius: 4, fontSize: 13 }}
          >
            <option value="">— None (use static URL) —</option>
            <option value="zoom">Zoom</option>
            <option value="google_meet">Google Meet</option>
          </select>
        </div>
      </div>
    </article>
  );
}

function TelehealthConnectionsPanel() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<TelehealthConnectionsResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    fetch("/api/telehealth/connections")
      .then((r) => r.json())
      .then((json: TelehealthConnectionsResponse) => setData(json))
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : "Failed to load connections"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("telehealth_error")) setActionError(`Connection failed: ${params.get("telehealth_error")}`);
    }
    refresh();
  }, []);

  const connectHref = (platform: TelehealthPlatform) => `/api/telehealth/oauth/${platform}/start`;
  const disconnect = async (platform: TelehealthPlatform) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/telehealth/oauth/${platform}/disconnect`, { method: "POST" });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Disconnect failed");
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Disconnect failed");
    }
  };

  const platforms: { key: TelehealthPlatform; label: string }[] = [
    { key: "zoom", label: "Zoom" },
    { key: "google_meet", label: "Google Meet" },
  ];

  const status = data?.platformStatus;
  const connections = data?.connections ?? [];

  return (
    <section className="panel" style={{ marginTop: "var(--space-4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }}>
        <h2 style={{ margin: 0 }}>My Telehealth Connections</h2>
        <button type="button" className="button button-secondary" onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginTop: 0 }}>
        Connect your personal Zoom or Google account so Join Telehealth auto-creates a meeting on your account, with token refresh handled for you. Tokens are encrypted at rest.
      </p>
      {actionError ? <div className="alert-panel" style={{ marginBottom: 12 }}>{actionError}</div> : null}
      <div style={{ display: "grid", gap: 12 }}>
        {platforms.map(({ key, label }) => {
          const conn = connections.find((c) => c.platform === key);
          const platformStatus = status?.[key];
          const notConfigured = platformStatus && !platformStatus.configured;
          return (
            <article key={key} className="metric-card" style={{ padding: "var(--space-3)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <strong>{label}</strong>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
                  {notConfigured ? (
                    <span style={{ color: "var(--text-danger, #dc2626)" }}>
                      OAuth credentials not configured. Add {platformStatus!.missingEnv.join(", ")} to project secrets to enable.
                    </span>
                  ) : conn ? (
                    <>
                      Connected as <strong>{conn.accountEmail ?? "unknown account"}</strong>
                      {conn.lastError ? <span style={{ color: "var(--text-danger, #dc2626)", marginLeft: 8 }}>(last error: {conn.lastError})</span> : null}
                    </>
                  ) : (
                    <span>Not connected.</span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {conn ? (
                  <button type="button" className="button button-secondary" onClick={() => void disconnect(key)}>
                    Disconnect
                  </button>
                ) : null}
                <a
                  className="button button-primary"
                  href={connectHref(key)}
                  aria-disabled={notConfigured ? "true" : undefined}
                  onClick={(e) => { if (notConfigured) e.preventDefault(); }}
                  style={notConfigured ? { opacity: 0.5, pointerEvents: "none" } : undefined}
                >
                  {conn ? "Reconnect" : "Connect"}
                </a>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function StripeConnectSection({
  provider,
  organizationId,
  onUpdated,
}: {
  provider: CredentialingRecord;
  organizationId: string;
  onUpdated: (updated: CredentialingRecord) => void;
}) {
  const [busy, setBusy] = useState<null | "connect" | "refresh">(null);
  const [error, setError] = useState<string | null>(null);
  const status = connectStatusOf(provider);
  const due = provider.stripe_requirements?.currently_due ?? [];
  const disabledReason = provider.stripe_requirements?.disabled_reason ?? null;

  async function startOnboarding() {
    setBusy("connect");
    setError(null);
    try {
      const resp = await fetch("/api/billing/stripe-connect/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, organizationId }),
      });
      const json = (await resp.json()) as { success?: boolean; url?: string; error?: string };
      if (!resp.ok || !json.success || !json.url) {
        throw new Error(json.error ?? `Onboarding failed (${resp.status})`);
      }
      window.location.href = json.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onboarding failed");
      setBusy(null);
    }
  }

  async function refreshStatus() {
    setBusy("refresh");
    setError(null);
    try {
      const resp = await fetch("/api/billing/stripe-connect/refresh-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, organizationId }),
      });
      const json = (await resp.json()) as {
        success?: boolean;
        stripe_charges_enabled?: boolean;
        stripe_payouts_enabled?: boolean;
        stripe_details_submitted?: boolean;
        stripe_requirements?: { currently_due?: string[]; disabled_reason?: string | null } | null;
        stripe_account_status_updated_at?: string;
        accountId?: string | null;
        error?: string;
      };
      if (!resp.ok || !json.success) throw new Error(json.error ?? `Refresh failed (${resp.status})`);
      onUpdated({
        ...provider,
        stripe_connect_account_id: json.accountId ?? provider.stripe_connect_account_id ?? null,
        stripe_charges_enabled: Boolean(json.stripe_charges_enabled),
        stripe_payouts_enabled: Boolean(json.stripe_payouts_enabled),
        stripe_details_submitted: Boolean(json.stripe_details_submitted),
        stripe_requirements: json.stripe_requirements ?? null,
        stripe_account_status_updated_at: json.stripe_account_status_updated_at ?? new Date().toISOString(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        marginTop: "var(--space-4)",
        padding: "var(--space-3)",
        background: "var(--surface-muted, #f8fafc)",
        border: "1px solid var(--border-default, #e2e8f0)",
        borderRadius: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-2)", gap: 8 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <strong style={{ fontSize: "var(--text-sm)" }}>Stripe Connect (in-app card payments)</strong>
          <span className={CONNECT_CLASS[status]} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999 }}>
            {CONNECT_LABEL[status]}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {status === "not_connected" && (
            <button type="button" className="button button-primary" disabled={busy !== null} onClick={startOnboarding} style={{ padding: "4px 10px", fontSize: 12 }}>
              {busy === "connect" ? "Opening Stripe…" : "Connect Stripe"}
            </button>
          )}
          {(status === "onboarding" || status === "restricted") && (
            <button type="button" className="button button-primary" disabled={busy !== null} onClick={startOnboarding} style={{ padding: "4px 10px", fontSize: 12 }}>
              {busy === "connect" ? "Opening Stripe…" : "Continue onboarding"}
            </button>
          )}
          {status !== "not_connected" && (
            <button type="button" className="button button-secondary" disabled={busy !== null} onClick={refreshStatus} style={{ padding: "4px 10px", fontSize: 12 }}>
              {busy === "refresh" ? "Refreshing…" : "Refresh status"}
            </button>
          )}
        </div>
      </div>

      <div style={{ fontSize: 12, color: "var(--text-muted, #475569)", display: "grid", gap: 4 }}>
        {provider.stripe_connect_account_id ? (
          <div>
            <strong>Account:</strong> <code>{provider.stripe_connect_account_id}</code>
          </div>
        ) : (
          <div>Connect a Stripe account so the “Collect Copay” button can charge client cards and route funds directly to this clinician.</div>
        )}
        {provider.stripe_connect_account_id && (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>Charges: <strong>{provider.stripe_charges_enabled ? "enabled" : "disabled"}</strong></span>
            <span>Payouts: <strong>{provider.stripe_payouts_enabled ? "enabled" : "disabled"}</strong></span>
            <span>Details submitted: <strong>{provider.stripe_details_submitted ? "yes" : "no"}</strong></span>
          </div>
        )}
        {due.length > 0 && (
          <div style={{ color: "var(--text-danger)" }}>
            Stripe needs: {due.join(", ")}
          </div>
        )}
        {disabledReason && (
          <div style={{ color: "var(--text-danger)" }}>Disabled reason: {disabledReason}</div>
        )}
        {provider.stripe_account_status_updated_at && (
          <div style={{ fontSize: 11, opacity: 0.7 }}>
            Last synced {new Date(provider.stripe_account_status_updated_at).toLocaleString()}
          </div>
        )}
        {error && <div style={{ color: "var(--text-danger)" }}>{error}</div>}
      </div>
    </div>
  );
}

function ReturnFromStripeBanner({
  organizationId,
  onRefreshed,
}: {
  organizationId: string;
  onRefreshed: (updated: Partial<CredentialingRecord> & { id: string }) => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const returned = url.searchParams.get("stripeConnect");
    const refreshed = url.searchParams.get("stripeConnectRefresh");
    const providerId = returned || refreshed;
    if (!providerId) return;
    url.searchParams.delete("stripeConnect");
    url.searchParams.delete("stripeConnectRefresh");
    window.history.replaceState({}, "", url.toString());
    setMsg(returned ? "Pulling updated Stripe account status…" : "Resuming Stripe onboarding…");
    fetch("/api/billing/stripe-connect/refresh-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, organizationId }),
    })
      .then((r) => r.json())
      .then((json: {
        success?: boolean;
        stripe_charges_enabled?: boolean;
        stripe_payouts_enabled?: boolean;
        stripe_details_submitted?: boolean;
        stripe_requirements?: { currently_due?: string[]; disabled_reason?: string | null } | null;
        stripe_account_status_updated_at?: string;
        accountId?: string | null;
        error?: string;
      }) => {
        if (!json.success) {
          setMsg(`Could not refresh Stripe status: ${json.error ?? "unknown error"}`);
          return;
        }
        onRefreshed({
          id: providerId,
          stripe_connect_account_id: json.accountId ?? null,
          stripe_charges_enabled: Boolean(json.stripe_charges_enabled),
          stripe_payouts_enabled: Boolean(json.stripe_payouts_enabled),
          stripe_details_submitted: Boolean(json.stripe_details_submitted),
          stripe_requirements: json.stripe_requirements ?? null,
          stripe_account_status_updated_at: json.stripe_account_status_updated_at ?? new Date().toISOString(),
        });
        setMsg(json.stripe_charges_enabled ? "Stripe account is ready to accept charges." : "Stripe status refreshed — onboarding still needed.");
      })
      .catch((e: unknown) => {
        setMsg(`Could not refresh Stripe status: ${e instanceof Error ? e.message : "error"}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!msg) return null;
  return (
    <div className="alert-panel" style={{ marginBottom: "var(--space-3)" }}>
      {msg}
    </div>
  );
}
