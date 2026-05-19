"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type BillingDefaults = {
  claim_frequency_code: string;
  default_pos: string;
  default_diagnosis_behavior: string;
  default_procedure_charge_behavior: string;
  eligibility_recheck_days: number;
  claim_hold_days: number;
  aging_bucket_rules: string;
  auto_route_missing_info: boolean;
};

const INITIAL: BillingDefaults = {
  claim_frequency_code: "1",
  default_pos: "11",
  default_diagnosis_behavior: "first_encounter",
  default_procedure_charge_behavior: "manual",
  eligibility_recheck_days: 30,
  claim_hold_days: 3,
  aging_bucket_rules: "30/60/90/120",
  auto_route_missing_info: true,
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

export default function BillingDefaultsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [form, setForm] = useState<BillingDefaults>(INITIAL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!organizationId) { setLoading(false); return; }
    fetch(`/api/settings/billing-defaults?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((json: { billing_defaults?: BillingDefaults }) => {
        if (json.billing_defaults) setForm((prev) => ({ ...prev, ...json.billing_defaults }));
      })
      .catch(() => setStatusMsg({ type: "err", text: "Failed to load billing defaults." }))
      .finally(() => setLoading(false));
  }, [organizationId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch(
        `/api/settings/billing-defaults?organizationId=${encodeURIComponent(organizationId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        },
      );
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "Save failed");
      setStatusMsg({ type: "ok", text: "Billing defaults saved." });
    } catch (err) {
      setStatusMsg({ type: "err", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }, [form, organizationId]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Billing Defaults</h1>
          <p className="hero-copy">Default claim values, eligibility rechecks, and workqueue automation rules.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      {!organizationId && <div className="alert-panel">No organization context.</div>}
      {statusMsg && (
        <div className={statusMsg.type === "ok" ? "alert-panel alert-panel-success" : "alert-panel"}>{statusMsg.text}</div>
      )}

      {loading ? (
        <div className="panel"><div className="empty-state">Loading…</div></div>
      ) : (
        <>
          <section className="panel form-panel">
            <h2>Claim Defaults</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
              Stored in <code>system_settings</code> under key <code>billing.defaults</code>.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <label className="field-label">
                Claim Frequency Code
                <select
                  value={form.claim_frequency_code}
                  onChange={(e) => setForm((p) => ({ ...p, claim_frequency_code: e.target.value }))}
                >
                  <option value="1">1 – Original</option>
                  <option value="7">7 – Replacement</option>
                  <option value="8">8 – Void/Cancel</option>
                </select>
              </label>
              <label className="field-label">
                Default Place of Service
                <select value={form.default_pos} onChange={(e) => setForm((p) => ({ ...p, default_pos: e.target.value }))}>
                  <option value="02">02 – Telehealth</option>
                  <option value="10">10 – Telehealth (Patient Home)</option>
                  <option value="11">11 – Office</option>
                  <option value="12">12 – Home</option>
                  <option value="49">49 – Independent Clinic</option>
                  <option value="53">53 – Community Mental Health Center</option>
                </select>
              </label>
              <label className="field-label">
                Default Diagnosis Behavior
                <select
                  value={form.default_diagnosis_behavior}
                  onChange={(e) => setForm((p) => ({ ...p, default_diagnosis_behavior: e.target.value }))}
                >
                  <option value="first_encounter">Use first encounter diagnosis</option>
                  <option value="most_recent">Use most recent diagnosis</option>
                  <option value="manual">Manual selection only</option>
                </select>
              </label>
              <label className="field-label">
                Default Procedure Charge Behavior
                <select
                  value={form.default_procedure_charge_behavior}
                  onChange={(e) => setForm((p) => ({ ...p, default_procedure_charge_behavior: e.target.value }))}
                >
                  <option value="manual">Manual entry</option>
                  <option value="auto_from_encounter">Auto from encounter</option>
                  <option value="fee_schedule">Use fee schedule</option>
                </select>
              </label>
            </div>
          </section>

          <section className="panel form-panel">
            <h2>Timing &amp; Aging</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <label className="field-label">
                Eligibility Recheck Interval (days)
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={form.eligibility_recheck_days}
                  onChange={(e) => setForm((p) => ({ ...p, eligibility_recheck_days: Number(e.target.value) }))}
                />
              </label>
              <label className="field-label">
                Claim Hold Period (days before submission)
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={form.claim_hold_days}
                  onChange={(e) => setForm((p) => ({ ...p, claim_hold_days: Number(e.target.value) }))}
                />
              </label>
              <label className="field-label">
                Aging Bucket Rules
                <input
                  type="text"
                  value={form.aging_bucket_rules}
                  placeholder="30/60/90/120"
                  onChange={(e) => setForm((p) => ({ ...p, aging_bucket_rules: e.target.value }))}
                />
              </label>
            </div>
          </section>

          <section className="panel form-panel">
            <h2>Workqueue Automation</h2>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={form.auto_route_missing_info}
                onChange={(e) => setForm((p) => ({ ...p, auto_route_missing_info: e.target.checked }))}
              />
              Auto-route claims with missing information to workqueue
            </label>
          </section>

          <div style={{ padding: "0 var(--space-6) var(--space-6)" }}>
            <button className="button button-primary" onClick={handleSave} disabled={saving || !organizationId}>
              {saving ? "Saving…" : "Save Billing Defaults"}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
