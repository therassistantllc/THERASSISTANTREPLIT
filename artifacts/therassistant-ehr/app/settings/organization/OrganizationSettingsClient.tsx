"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type OrgFields = {
  name: string;
  legal_name: string;
  slug: string;
  default_state: string;
  timezone: string;
  tax_id_last4: string;
  is_active: boolean;
};

type BillingProfile = {
  billing_provider_name: string;
  billing_provider_npi: string;
  billing_tax_id: string;
  billing_tax_id_type: string;
  billing_address_line1: string;
  billing_address_line2: string;
  billing_city: string;
  billing_state: string;
  billing_zip: string;
  billing_phone: string;
  default_pos: string;
  default_service_location_id: string;
};

const EMPTY_ORG: OrgFields = {
  name: "",
  legal_name: "",
  slug: "",
  default_state: "",
  timezone: "America/New_York",
  tax_id_last4: "",
  is_active: true,
};

const EMPTY_BILLING: BillingProfile = {
  billing_provider_name: "",
  billing_provider_npi: "",
  billing_tax_id: "",
  billing_tax_id_type: "EIN",
  billing_address_line1: "",
  billing_address_line2: "",
  billing_city: "",
  billing_state: "",
  billing_zip: "",
  billing_phone: "",
  default_pos: "11",
  default_service_location_id: "",
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

export default function OrganizationSettingsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [org, setOrg] = useState<OrgFields>(EMPTY_ORG);
  const [billing, setBilling] = useState<BillingProfile>(EMPTY_BILLING);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [statusMsg, setStatusMsg] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!organizationId) { setLoading(false); return; }
    fetch(`/api/settings/organization?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((json: { organization?: Partial<OrgFields>; billing_profile?: Partial<BillingProfile> }) => {
        if (json.organization) setOrg((prev) => ({ ...prev, ...json.organization }));
        if (json.billing_profile) setBilling((prev) => ({ ...prev, ...json.billing_profile }));
      })
      .catch(() => setStatusMsg("Failed to load settings."))
      .finally(() => setLoading(false));
  }, [organizationId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus("idle");
    try {
      const res = await fetch(
        `/api/settings/organization?organizationId=${encodeURIComponent(organizationId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...org, billing_profile: billing }),
        },
      );
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "Save failed");
      setStatus("saved");
      setStatusMsg("Settings saved.");
    } catch (err) {
      setStatus("error");
      setStatusMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [organizationId, org, billing]);

  function tf(field: keyof OrgFields, label: string, type = "text") {
    return (
      <label className="field-label">
        {label}
        <input
          type={type}
          value={String(org[field] ?? "")}
          onChange={(e) => setOrg((prev) => ({ ...prev, [field]: e.target.value }))}
        />
      </label>
    );
  }

  function bf(field: keyof BillingProfile, label: string, type = "text") {
    return (
      <label className="field-label">
        {label}
        <input
          type={type}
          value={String(billing[field] ?? "")}
          onChange={(e) => setBilling((prev) => ({ ...prev, [field]: e.target.value }))}
        />
      </label>
    );
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Organization Settings</h1>
          <p className="hero-copy">Practice identity, billing provider details, and transmission defaults.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      {!organizationId && (
        <div className="alert-panel">
          No organization context. Add <code>?organizationId=…</code> or set <code>NEXT_PUBLIC_ORGANIZATION_ID</code>.
        </div>
      )}

      {loading ? (
        <div className="panel"><div className="empty-state">Loading…</div></div>
      ) : (
        <>
          <section className="panel form-panel">
            <h2>Practice Identity</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              {tf("name", "Display / Practice Name")}
              {tf("legal_name", "Legal Name")}
              {tf("slug", "Slug")}
              {tf("default_state", "Default State (2-letter)")}
              {tf("timezone", "Timezone")}
              {tf("tax_id_last4", "Tax ID Last 4 Digits")}
            </div>
            <label className="checkbox-label" style={{ marginTop: "var(--space-3)" }}>
              <input
                type="checkbox"
                checked={org.is_active}
                onChange={(e) => setOrg((prev) => ({ ...prev, is_active: e.target.checked }))}
              />
              Organization is active
            </label>
          </section>

          <section className="panel form-panel">
            <h2>Billing Provider Profile</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
              These values populate claim headers. Stored in system settings under{" "}
              <code>organization.billing_profile</code>.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              {bf("billing_provider_name", "Billing Provider Name")}
              {bf("billing_provider_npi", "Billing Provider NPI (10 digits)")}
              {bf("billing_tax_id", "Tax ID / EIN (9 digits)")}
              <label className="field-label">
                Tax ID Type
                <select
                  value={billing.billing_tax_id_type}
                  onChange={(e) => setBilling((prev) => ({ ...prev, billing_tax_id_type: e.target.value }))}
                >
                  <option value="EIN">EIN</option>
                  <option value="SSN">SSN</option>
                </select>
              </label>
              {bf("billing_phone", "Billing Phone")}
              <label className="field-label">
                Default Place of Service Code
                <select
                  value={billing.default_pos}
                  onChange={(e) => setBilling((prev) => ({ ...prev, default_pos: e.target.value }))}
                >
                  <option value="02">02 – Telehealth</option>
                  <option value="10">10 – Telehealth (patient home)</option>
                  <option value="11">11 – Office</option>
                  <option value="12">12 – Home</option>
                  <option value="49">49 – Independent Clinic</option>
                </select>
              </label>
            </div>
          </section>

          <section className="panel form-panel">
            <h2>Billing Address</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              {bf("billing_address_line1", "Address Line 1")}
              {bf("billing_address_line2", "Address Line 2")}
              {bf("billing_city", "City")}
              {bf("billing_state", "State (2-letter)")}
              {bf("billing_zip", "ZIP Code")}
            </div>
          </section>

          {status !== "idle" && (
            <div className={status === "saved" ? "alert-panel alert-panel-success" : "alert-panel"}>
              {statusMsg}
            </div>
          )}

          <div style={{ padding: "0 var(--space-6) var(--space-6)" }}>
            <button className="button button-primary" onClick={handleSave} disabled={saving || !organizationId}>
              {saving ? "Saving…" : "Save Organization Settings"}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
