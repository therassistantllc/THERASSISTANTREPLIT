"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type BillingRules = {
  requires_telehealth_modifier?: boolean;
  allowed_pos_codes?: string[] | null;
  requires_rendering_provider_taxonomy?: boolean;
  requires_subscriber_relationship?: boolean;
  timely_filing_days?: number | null;
  appeal_deadline_days?: number | null;
  corrected_claim_days?: number | null;
  allowed_cpt_codes?: string[] | null;
  denied_cpt_codes?: string[] | null;
};

type Payer = {
  id: string;
  payer_name: string;
  availity_payer_id: string;
  payer_type: string | null;
  is_active: boolean;
  notes: string | null;
  requires_authorization: boolean | null;
  billing_rules: BillingRules | null;
  fax_number: string | null;
  claims_phone: string | null;
  claims_fax: string | null;
  provider_services_phone: string | null;
  adjudication_sla_days: number | null;
  updated_at: string;
};

type FormState = {
  payer_name: string;
  availity_payer_id: string;
  payer_type: string;
  is_active: boolean;
  notes: string;
  requires_authorization: boolean;
  fax_number: string;
  claims_phone: string;
  claims_fax: string;
  provider_services_phone: string;
  adjudication_sla_days_text: string;
  // Billing-rules edit fields. Lists are entered as comma-separated text
  // and split server-side so the UI stays simple.
  requires_telehealth_modifier: boolean;
  allowed_pos_codes_text: string;
  requires_rendering_provider_taxonomy: boolean;
  requires_subscriber_relationship: boolean;
  timely_filing_days_text: string;
  appeal_deadline_days_text: string;
  corrected_claim_days_text: string;
  allowed_cpt_codes_text: string;
  denied_cpt_codes_text: string;
};

const EMPTY_FORM: FormState = {
  payer_name: "",
  availity_payer_id: "",
  payer_type: "",
  is_active: true,
  notes: "",
  requires_authorization: false,
  fax_number: "",
  claims_phone: "",
  claims_fax: "",
  provider_services_phone: "",
  adjudication_sla_days_text: "",
  requires_telehealth_modifier: false,
  allowed_pos_codes_text: "",
  requires_rendering_provider_taxonomy: false,
  requires_subscriber_relationship: false,
  timely_filing_days_text: "",
  appeal_deadline_days_text: "",
  corrected_claim_days_text: "",
  allowed_cpt_codes_text: "",
  denied_cpt_codes_text: "",
};

function splitCsv(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x.length > 0);
}

function joinList(arr: string[] | null | undefined): string {
  if (!arr || arr.length === 0) return "";
  return arr.join(", ");
}

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

export default function PayerProfilesClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadPayers = useCallback(() => {
    if (!organizationId) { setLoading(false); return; }
    fetch(`/api/settings/payer-profiles?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((json: { payers?: Payer[] }) => setPayers(json.payers ?? []))
      .catch(() => setStatusMsg({ type: "err", text: "Failed to load payers." }))
      .finally(() => setLoading(false));
  }, [organizationId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadPayers(); }, [loadPayers]);

  function startEdit(p: Payer) {
    const br = p.billing_rules ?? {};
    setForm({
      payer_name: p.payer_name,
      availity_payer_id: p.availity_payer_id,
      payer_type: p.payer_type ?? "",
      is_active: p.is_active,
      notes: p.notes ?? "",
      requires_authorization: p.requires_authorization === true,
      fax_number: p.fax_number ?? "",
      claims_phone: p.claims_phone ?? "",
      claims_fax: p.claims_fax ?? "",
      provider_services_phone: p.provider_services_phone ?? "",
      adjudication_sla_days_text:
        typeof p.adjudication_sla_days === "number" && p.adjudication_sla_days > 0
          ? String(p.adjudication_sla_days)
          : "",
      requires_telehealth_modifier: br.requires_telehealth_modifier === true,
      allowed_pos_codes_text: joinList(br.allowed_pos_codes ?? []),
      requires_rendering_provider_taxonomy:
        br.requires_rendering_provider_taxonomy === true,
      requires_subscriber_relationship:
        br.requires_subscriber_relationship === true,
      timely_filing_days_text:
        typeof br.timely_filing_days === "number" && br.timely_filing_days > 0
          ? String(br.timely_filing_days)
          : "",
      appeal_deadline_days_text:
        typeof br.appeal_deadline_days === "number" && br.appeal_deadline_days > 0
          ? String(br.appeal_deadline_days)
          : "",
      corrected_claim_days_text:
        typeof br.corrected_claim_days === "number" && br.corrected_claim_days > 0
          ? String(br.corrected_claim_days)
          : "",
      allowed_cpt_codes_text: joinList(br.allowed_cpt_codes ?? []),
      denied_cpt_codes_text: joinList(br.denied_cpt_codes ?? []),
    });
    setEditingId(p.id);
    setShowNew(false);
  }

  function cancelForm() {
    setEditingId(null);
    setShowNew(false);
    setForm(EMPTY_FORM);
  }

  const handleSave = useCallback(async () => {
    if (!form.payer_name.trim() || !form.availity_payer_id.trim()) {
      setStatusMsg({ type: "err", text: "Payer Name and Availity Payer ID are required." });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      const url = editingId
        ? `/api/settings/payer-profiles?organizationId=${encodeURIComponent(organizationId)}&id=${encodeURIComponent(editingId)}`
        : `/api/settings/payer-profiles?organizationId=${encodeURIComponent(organizationId)}`;
      const timely = form.timely_filing_days_text.trim();
      const parsedTimely = timely ? Number(timely) : null;
      const appealDays = form.appeal_deadline_days_text.trim();
      const parsedAppeal = appealDays ? Number(appealDays) : null;
      const correctedDays = form.corrected_claim_days_text.trim();
      const parsedCorrected = correctedDays ? Number(correctedDays) : null;
      const slaText = form.adjudication_sla_days_text.trim();
      const parsedSla = slaText ? Number(slaText) : null;
      if (
        slaText &&
        (parsedSla == null || !Number.isFinite(parsedSla) || parsedSla < 1 || parsedSla > 365)
      ) {
        setStatusMsg({
          type: "err",
          text: "Adjudication SLA must be a whole number of days between 1 and 365.",
        });
        setSaving(false);
        return;
      }
      const billing_rules = {
        requires_telehealth_modifier: form.requires_telehealth_modifier,
        allowed_pos_codes: splitCsv(form.allowed_pos_codes_text),
        requires_rendering_provider_taxonomy:
          form.requires_rendering_provider_taxonomy,
        requires_subscriber_relationship: form.requires_subscriber_relationship,
        timely_filing_days:
          parsedTimely != null && Number.isFinite(parsedTimely) && parsedTimely > 0
            ? Math.floor(parsedTimely)
            : null,
        appeal_deadline_days:
          parsedAppeal != null && Number.isFinite(parsedAppeal) && parsedAppeal > 0
            ? Math.floor(parsedAppeal)
            : null,
        corrected_claim_days:
          parsedCorrected != null && Number.isFinite(parsedCorrected) && parsedCorrected > 0
            ? Math.floor(parsedCorrected)
            : null,
        allowed_cpt_codes: splitCsv(form.allowed_cpt_codes_text),
        denied_cpt_codes: splitCsv(form.denied_cpt_codes_text),
      };
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payer_name: form.payer_name,
          availity_payer_id: form.availity_payer_id,
          payer_type: form.payer_type || null,
          is_active: form.is_active,
          notes: form.notes || null,
          requires_authorization: form.requires_authorization,
          fax_number: form.fax_number.trim() || null,
          claims_phone: form.claims_phone.trim() || null,
          claims_fax: form.claims_fax.trim() || null,
          provider_services_phone: form.provider_services_phone.trim() || null,
          adjudication_sla_days:
            parsedSla != null && Number.isFinite(parsedSla) ? Math.floor(parsedSla) : null,
          billing_rules,
        }),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "Save failed");
      setStatusMsg({ type: "ok", text: editingId ? "Payer updated." : "Payer created." });
      cancelForm();
      loadPayers();
    } catch (err) {
      setStatusMsg({ type: "err", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }, [editingId, form, organizationId, loadPayers]);

  const handleDeactivate = useCallback(async (id: string) => {
    const res = await fetch(
      `/api/settings/payer-profiles?organizationId=${encodeURIComponent(organizationId)}&id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (res.ok) loadPayers();
    else setStatusMsg({ type: "err", text: "Failed to deactivate payer." });
  }, [organizationId, loadPayers]);

  const showForm = showNew || editingId !== null;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Payer Profiles</h1>
          <p className="hero-copy">Availity payer IDs and configuration for claim submission routing.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      {!organizationId && (
        <div className="alert-panel">No organization context.</div>
      )}
      {statusMsg && (
        <div className={statusMsg.type === "ok" ? "alert-panel alert-panel-success" : "alert-panel"}>
          {statusMsg.text}
        </div>
      )}

      <section className="metric-grid">
        <article className="metric-card">
          <span>Total Payers</span>
          <strong>{loading ? "—" : payers.length}</strong>
        </article>
        <article className="metric-card">
          <span>Active</span>
          <strong>{loading ? "—" : payers.filter((p) => p.is_active).length}</strong>
        </article>
      </section>

      <section className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <h2>Payer List</h2>
          {!showForm && (
            <button className="button button-primary" onClick={() => { setShowNew(true); setEditingId(null); setForm(EMPTY_FORM); }}>
              + Add Payer
            </button>
          )}
        </div>

        {loading && <div className="empty-state">Loading…</div>}
        {!loading && payers.length === 0 && (
          <div className="alert-panel">No payer profiles configured. Claims will fail without at least one active payer.</div>
        )}

        {showForm && (
          <article className="panel form-panel" style={{ marginBottom: "var(--space-5)", border: "1px solid var(--border-color)" }}>
            <h3>{editingId ? "Edit Payer" : "New Payer Profile"}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <label className="field-label">
                Payer Name <span style={{ color: "var(--text-danger)" }}>*</span>
                <input
                  type="text"
                  value={form.payer_name}
                  onChange={(e) => setForm((p) => ({ ...p, payer_name: e.target.value }))}
                />
              </label>
              <label className="field-label">
                Availity Payer ID <span style={{ color: "var(--text-danger)" }}>*</span>
                <input
                  type="text"
                  value={form.availity_payer_id}
                  onChange={(e) => setForm((p) => ({ ...p, availity_payer_id: e.target.value }))}
                />
              </label>
              <label className="field-label">
                Payer Type
                <select value={form.payer_type} onChange={(e) => setForm((p) => ({ ...p, payer_type: e.target.value }))}>
                  <option value="">— Select —</option>
                  <option value="commercial">Commercial</option>
                  <option value="medicaid">Medicaid</option>
                  <option value="medicare">Medicare</option>
                  <option value="tricare">TRICARE</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="field-label">
                Notes
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                />
              </label>
              <label className="field-label">
                Fax number (legacy / general)
                <input
                  type="text"
                  value={form.fax_number}
                  onChange={(e) => setForm((p) => ({ ...p, fax_number: e.target.value }))}
                  placeholder="e.g. 555-123-4567"
                />
              </label>
              <label className="field-label">
                Claims phone
                <input
                  type="text"
                  value={form.claims_phone}
                  onChange={(e) => setForm((p) => ({ ...p, claims_phone: e.target.value }))}
                  placeholder="e.g. 800-555-0100"
                />
              </label>
              <label className="field-label">
                Claims fax
                <input
                  type="text"
                  value={form.claims_fax}
                  onChange={(e) => setForm((p) => ({ ...p, claims_fax: e.target.value }))}
                  placeholder="e.g. 800-555-0101"
                />
              </label>
              <label className="field-label">
                Provider services phone
                <input
                  type="text"
                  value={form.provider_services_phone}
                  onChange={(e) => setForm((p) => ({ ...p, provider_services_phone: e.target.value }))}
                  placeholder="e.g. 800-555-0102"
                />
              </label>
              <label className="field-label">
                Adjudication SLA (days)
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={form.adjudication_sla_days_text}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, adjudication_sla_days_text: e.target.value }))
                  }
                  placeholder="default 30 (Medicare ~14, Medicaid ~60)"
                />
              </label>
            </div>
            <label className="checkbox-label" style={{ margin: "var(--space-3) 0" }}>
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
              />
              Active
            </label>

            <fieldset style={{ marginTop: "var(--space-4)", padding: "var(--space-4)", border: "1px solid var(--border-color)", borderRadius: 6 }}>
              <legend style={{ padding: "0 var(--space-2)", fontWeight: 600 }}>
                Billing Rules (denial prevention)
              </legend>
              <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginTop: 0 }}>
                These rules run against every claim for this payer before submission. Blocking findings appear in the claim readiness panel.
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={form.requires_authorization}
                    onChange={(e) => setForm((p) => ({ ...p, requires_authorization: e.target.checked }))}
                  />
                  Requires prior authorization
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={form.requires_telehealth_modifier}
                    onChange={(e) => setForm((p) => ({ ...p, requires_telehealth_modifier: e.target.checked }))}
                  />
                  Requires telehealth modifier on telehealth lines
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={form.requires_subscriber_relationship}
                    onChange={(e) => setForm((p) => ({ ...p, requires_subscriber_relationship: e.target.checked }))}
                  />
                  Requires subscriber relationship details
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={form.requires_rendering_provider_taxonomy}
                    onChange={(e) => setForm((p) => ({ ...p, requires_rendering_provider_taxonomy: e.target.checked }))}
                  />
                  Requires rendering provider taxonomy
                </label>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)", marginTop: "var(--space-3)" }}>
                <label className="field-label">
                  Timely filing days (blank = no limit)
                  <input
                    type="number"
                    min={1}
                    value={form.timely_filing_days_text}
                    onChange={(e) => setForm((p) => ({ ...p, timely_filing_days_text: e.target.value }))}
                    placeholder="e.g. 90"
                  />
                </label>
                <label className="field-label">
                  Appeal deadline days (blank = org default of 180)
                  <input
                    type="number"
                    min={1}
                    value={form.appeal_deadline_days_text}
                    onChange={(e) => setForm((p) => ({ ...p, appeal_deadline_days_text: e.target.value }))}
                    placeholder="e.g. 60, 90, 180, 365"
                  />
                </label>
                <label className="field-label">
                  Corrected-claim days (blank = org default of 180)
                  <input
                    type="number"
                    min={1}
                    value={form.corrected_claim_days_text}
                    onChange={(e) => setForm((p) => ({ ...p, corrected_claim_days_text: e.target.value }))}
                    placeholder="e.g. 90, 180, 365"
                  />
                </label>
                <label className="field-label">
                  Allowed POS codes (comma-separated, blank = any)
                  <input
                    type="text"
                    value={form.allowed_pos_codes_text}
                    onChange={(e) => setForm((p) => ({ ...p, allowed_pos_codes_text: e.target.value }))}
                    placeholder="e.g. 11, 02, 10"
                  />
                </label>
                <label className="field-label">
                  Allowed CPT/HCPCS codes (comma-separated, blank = any)
                  <input
                    type="text"
                    value={form.allowed_cpt_codes_text}
                    onChange={(e) => setForm((p) => ({ ...p, allowed_cpt_codes_text: e.target.value }))}
                    placeholder="e.g. 90791, 90834, 90837"
                  />
                </label>
                <label className="field-label">
                  Denied CPT/HCPCS codes (comma-separated)
                  <input
                    type="text"
                    value={form.denied_cpt_codes_text}
                    onChange={(e) => setForm((p) => ({ ...p, denied_cpt_codes_text: e.target.value }))}
                    placeholder="e.g. 99999"
                  />
                </label>
              </div>
            </fieldset>

            <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
              <button className="button button-primary" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : editingId ? "Update" : "Create"}
              </button>
              <button className="button button-secondary" onClick={cancelForm} disabled={saving}>Cancel</button>
            </div>
          </article>
        )}

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border-color)", textAlign: "left" }}>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>Payer Name</th>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>Availity ID</th>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>Type</th>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>Status</th>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>SLA (days)</th>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>Notes</th>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}></th>
            </tr>
          </thead>
          <tbody>
            {payers.map((p) => (
              <tr key={p.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                <td style={{ padding: "8px 12px" }}><strong>{p.payer_name}</strong></td>
                <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>{p.availity_payer_id}</td>
                <td style={{ padding: "8px 12px" }}>{p.payer_type ?? "—"}</td>
                <td style={{ padding: "8px 12px" }}>
                  <span className={p.is_active ? "status status-green" : "status status-red"}>
                    {p.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>
                  {p.adjudication_sla_days ?? 30}
                </td>
                <td style={{ padding: "8px 12px", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>{p.notes ?? "—"}</td>
                <td style={{ padding: "8px 12px" }}>
                  <button className="button button-secondary" style={{ fontSize: "var(--text-sm)", padding: "2px 10px" }} onClick={() => startEdit(p)}>Edit</button>
                  {p.is_active && (
                    <button
                      className="button button-secondary"
                      style={{ fontSize: "var(--text-sm)", padding: "2px 10px", marginLeft: "6px", color: "var(--text-danger)" }}
                      onClick={() => handleDeactivate(p.id)}
                    >
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
