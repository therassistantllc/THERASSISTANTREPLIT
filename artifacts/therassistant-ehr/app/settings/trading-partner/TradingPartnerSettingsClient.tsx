"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

/**
 * Trading Partner readiness page.
 *
 * Compliance dashboard that surfaces the five Office Ally trading-partner essentials
 * (billing NPI, EIN, pay-to address, authorized representative, contact info) with
 * green/red status pills. The underlying data lives in `system_settings.organization.billing_profile`;
 * NPI, EIN, and pay-to address are edited on /settings/organization. This page edits
 * the authorized-representative fields inline (the only fields not exposed elsewhere)
 * so an operator can complete the TPA without leaving the page.
 */

type BAA = {
  id: string;
  counterparty_type: string;
  counterparty_name: string;
  status: "not_started" | "draft" | "executed" | "expired" | "terminated";
  expires_at: string | null;
};

type BillingProfile = {
  billing_provider_npi?: string;
  billing_tax_id?: string;
  billing_address_line1?: string;
  billing_city?: string;
  billing_state?: string;
  billing_zip?: string;
  authorized_rep_name?: string;
  authorized_rep_email?: string;
  authorized_rep_phone?: string;
};

type Organization = { id: string; name?: string; legal_name?: string | null };

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function isNpiValid(npi: string | undefined): boolean {
  if (!npi) return false;
  const digits = npi.replace(/\D/g, "");
  if (digits.length !== 10) return false;
  // Luhn against "80840" + first 9 digits, matching lib/validation/npi.ts.
  const base = "80840" + digits.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    let n = Number(base.charAt(i));
    if ((base.length - i) % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits.charAt(9));
}

function isEinValid(ein: string | undefined): boolean {
  if (!ein) return false;
  return ein.replace(/\D/g, "").length === 9;
}

function StatusPill({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) {
  const cls = ok ? "status status-green" : warn ? "status status-yellow" : "status status-red";
  return (
    <span className={cls}>
      {ok ? "✓" : warn ? "!" : "✗"} {label}
    </span>
  );
}

export default function TradingPartnerSettingsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [org, setOrg] = useState<Organization | null>(null);
  const [profile, setProfile] = useState<BillingProfile>({});
  const [baas, setBaas] = useState<BAA[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [repForm, setRepForm] = useState({
    authorized_rep_name: "",
    authorized_rep_email: "",
    authorized_rep_phone: "",
  });

  const load = useCallback(() => {
    if (!organizationId) {
      setLoading(false);
      return;
    }
    Promise.all([
      fetch(`/api/settings/organization?organizationId=${encodeURIComponent(organizationId)}`).then((r) => r.json()),
      fetch(`/api/settings/baa?organizationId=${encodeURIComponent(organizationId)}`)
        .then((r) => r.json())
        .catch(() => ({ agreements: [] })),
    ])
      .then(([orgJson, baaJson]: [
        { organization?: Organization; billing_profile?: BillingProfile },
        { agreements?: BAA[] },
      ]) => {
        setOrg(orgJson.organization ?? null);
        const bp = orgJson.billing_profile ?? {};
        setProfile(bp);
        setRepForm({
          authorized_rep_name: bp.authorized_rep_name ?? "",
          authorized_rep_email: bp.authorized_rep_email ?? "",
          authorized_rep_phone: bp.authorized_rep_phone ?? "",
        });
        setBaas(baaJson.agreements ?? []);
      })
      .catch(() => setStatusMsg({ type: "err", text: "Failed to load trading partner profile." }))
      .finally(() => setLoading(false));
  }, [organizationId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    load();
  }, [load]);

  const saveRep = useCallback(async () => {
    setSaving(true);
    setStatusMsg(null);
    try {
      const merged: BillingProfile = {
        ...profile,
        authorized_rep_name: repForm.authorized_rep_name || undefined,
        authorized_rep_email: repForm.authorized_rep_email || undefined,
        authorized_rep_phone: repForm.authorized_rep_phone || undefined,
      };
      const res = await fetch(
        `/api/settings/organization?organizationId=${encodeURIComponent(organizationId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ billing_profile: merged }),
        },
      );
      if (!res.ok) {
        const json = (await res.json()) as { error?: string; fields?: Record<string, string> };
        const msg = json.error ?? "Save failed";
        const fieldMsg = json.fields ? Object.values(json.fields).join(" · ") : "";
        throw new Error([msg, fieldMsg].filter(Boolean).join(" — "));
      }
      setStatusMsg({ type: "ok", text: "Authorized representative saved." });
      load();
    } catch (err) {
      setStatusMsg({ type: "err", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }, [organizationId, profile, repForm, load]);

  const npiOk = isNpiValid(profile.billing_provider_npi);
  const einOk = isEinValid(profile.billing_tax_id);
  const addrOk = Boolean(
    profile.billing_address_line1 && profile.billing_city && profile.billing_state && profile.billing_zip,
  );
  const repOk = Boolean(profile.authorized_rep_name);
  const repContactOk = Boolean(
    profile.authorized_rep_name &&
      profile.authorized_rep_email &&
      profile.authorized_rep_phone &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.authorized_rep_email) &&
      (profile.authorized_rep_phone ?? "").replace(/\D/g, "").length === 10,
  );

  const allBlockingResolved = npiOk && einOk && addrOk;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Trading Partner Profile</h1>
          <p className="hero-copy">
            Office Ally requires every claim submitter to register a trading-partner profile containing the billing
            provider NPI, the practice EIN, the pay-to address, and an authorized representative. This page surfaces
            those values from your organization billing profile and lets you complete the authorized-rep fields inline.
          </p>
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

      {statusMsg && (
        <div className={statusMsg.type === "ok" ? "alert-panel alert-panel-success" : "alert-panel"}>
          {statusMsg.text}
        </div>
      )}

      {loading ? (
        <div className="panel"><div className="empty-state">Loading…</div></div>
      ) : (
        <>
          <section className="panel">
            <h2>Compliance status</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
              {allBlockingResolved
                ? "All blocking trading-partner fields are present."
                : "One or more blocking fields are missing or invalid. Claims will be blocked until all of these are green."}
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
              <div className="metric-card" style={{ padding: "var(--space-4)" }}>
                <StatusPill ok={npiOk} label="Billing NPI" />
                <div style={{ marginTop: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                  {profile.billing_provider_npi
                    ? <code>{profile.billing_provider_npi}</code>
                    : <em style={{ color: "var(--text-secondary)" }}>Not set</em>}
                  {profile.billing_provider_npi && !npiOk && (
                    <div style={{ color: "var(--status-red)", marginTop: "4px" }}>Fails Luhn checksum.</div>
                  )}
                </div>
                <Link href="/settings/organization" className="button button-link" style={{ marginTop: "var(--space-2)" }}>
                  Edit on Organization →
                </Link>
              </div>

              <div className="metric-card" style={{ padding: "var(--space-4)" }}>
                <StatusPill ok={einOk} label="Tax ID / EIN" />
                <div style={{ marginTop: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                  {profile.billing_tax_id
                    ? <code>{profile.billing_tax_id}</code>
                    : <em style={{ color: "var(--text-secondary)" }}>Not set</em>}
                  {profile.billing_tax_id && !einOk && (
                    <div style={{ color: "var(--status-red)", marginTop: "4px" }}>Must be 9 digits.</div>
                  )}
                </div>
                <Link href="/settings/organization" className="button button-link" style={{ marginTop: "var(--space-2)" }}>
                  Edit on Organization →
                </Link>
              </div>

              <div className="metric-card" style={{ padding: "var(--space-4)" }}>
                <StatusPill ok={addrOk} label="Pay-to address" />
                <div style={{ marginTop: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                  {addrOk
                    ? <>{profile.billing_address_line1}, {profile.billing_city}, {profile.billing_state} {profile.billing_zip}</>
                    : <em style={{ color: "var(--text-secondary)" }}>Incomplete</em>}
                </div>
                <Link href="/settings/organization" className="button button-link" style={{ marginTop: "var(--space-2)" }}>
                  Edit on Organization →
                </Link>
              </div>

              <div className="metric-card" style={{ padding: "var(--space-4)" }}>
                <StatusPill ok={repContactOk} warn={repOk && !repContactOk} label="Authorized representative" />
                <div style={{ marginTop: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                  {repOk ? (
                    <>
                      <div><strong>{profile.authorized_rep_name}</strong></div>
                      <div>{profile.authorized_rep_email ?? <em>email missing</em>}</div>
                      <div>{profile.authorized_rep_phone ?? <em>phone missing</em>}</div>
                    </>
                  ) : (
                    <em style={{ color: "var(--text-secondary)" }}>Not set</em>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="panel form-panel">
            <h2>Authorized representative</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
              The person Office Ally will contact for enrollment changes, password resets, and TPA renewals. This is
              typically the practice owner or compliance officer.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)", marginBottom: "var(--space-4)" }}>
              <label className="field-label" style={{ gridColumn: "1 / -1" }}>
                Full name
                <input
                  type="text"
                  value={repForm.authorized_rep_name}
                  onChange={(e) => setRepForm((p) => ({ ...p, authorized_rep_name: e.target.value }))}
                />
              </label>
              <label className="field-label">
                Email
                <input
                  type="email"
                  value={repForm.authorized_rep_email}
                  onChange={(e) => setRepForm((p) => ({ ...p, authorized_rep_email: e.target.value }))}
                />
              </label>
              <label className="field-label">
                Phone (10 digits)
                <input
                  type="tel"
                  value={repForm.authorized_rep_phone}
                  placeholder="555-555-5555"
                  onChange={(e) => setRepForm((p) => ({ ...p, authorized_rep_phone: e.target.value }))}
                />
              </label>
            </div>

            <div style={{ display: "flex", gap: "var(--space-3)" }}>
              <button className="button button-primary" onClick={saveRep} disabled={saving}>
                {saving ? "Saving…" : "Save authorized representative"}
              </button>
            </div>
          </section>

          <section className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>Business Associate Agreements</h2>
              <Link href="/settings/baa" className="button button-link">Manage →</Link>
            </div>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
              HIPAA-mandated signed BAAs with PHI-processing vendors.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
              {["office_ally", "supabase", "google_workspace", "hosting"].map((type) => {
                const baa = baas.find((b) => b.counterparty_type === type);
                const isExecuted = baa?.status === "executed";
                const daysLeft = baa?.expires_at
                  ? Math.floor((new Date(baa.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                  : null;
                const isExpiringSoon = isExecuted && daysLeft !== null && daysLeft >= 0 && daysLeft < 60;
                const isExpired = isExecuted && daysLeft !== null && daysLeft < 0;
                const ok = isExecuted && !isExpiringSoon && !isExpired;
                const warn = isExpiringSoon;
                const label = isExpired
                  ? "Expired"
                  : isExpiringSoon
                    ? `${daysLeft}d to expiry`
                    : isExecuted
                      ? "Executed"
                      : baa?.status === "draft"
                        ? "Draft"
                        : "Not signed";
                return (
                  <div key={type} className="metric-card" style={{ padding: "var(--space-3)" }}>
                    <StatusPill ok={ok} warn={warn} label={baa?.counterparty_name ?? type} />
                    <div style={{ marginTop: "var(--space-2)", fontSize: "var(--text-sm)" }}>{label}</div>
                  </div>
                );
              })}
            </div>
          </section>

          {org && (
            <section className="panel">
              <h3>Organization</h3>
              <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                {org.name}
                {org.legal_name && org.legal_name !== org.name ? <> (legal: {org.legal_name})</> : null}
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}
