"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type ServiceLocation = {
  id: string;
  name: string;
  location_type: string;
  place_of_service_code: string;
  address_line1: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  phone: string | null;
  fax: string | null;
  npi: string | null;
  is_default: boolean;
  is_active: boolean;
};

type FormState = {
  name: string;
  location_type: string;
  place_of_service_code: string;
  address_line1: string;
  address_city: string;
  address_state: string;
  address_zip: string;
  phone: string;
  fax: string;
  npi: string;
  is_default: boolean;
  is_active: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  location_type: "office",
  place_of_service_code: "11",
  address_line1: "",
  address_city: "",
  address_state: "",
  address_zip: "",
  phone: "",
  fax: "",
  npi: "",
  is_default: false,
  is_active: true,
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

export default function ServiceLocationsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [locations, setLocations] = useState<ServiceLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(() => {
    if (!organizationId) { setLoading(false); return; }
    fetch(`/api/settings/service-locations?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((json: { service_locations?: ServiceLocation[] }) => setLocations(json.service_locations ?? []))
      .catch(() => setStatusMsg({ type: "err", text: "Failed to load service locations." }))
      .finally(() => setLoading(false));
  }, [organizationId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  function startEdit(loc: ServiceLocation) {
    setForm({
      name: loc.name,
      location_type: loc.location_type,
      place_of_service_code: loc.place_of_service_code,
      address_line1: loc.address_line1 ?? "",
      address_city: loc.address_city ?? "",
      address_state: loc.address_state ?? "",
      address_zip: loc.address_zip ?? "",
      phone: loc.phone ?? "",
      fax: loc.fax ?? "",
      npi: loc.npi ?? "",
      is_default: loc.is_default,
      is_active: loc.is_active,
    });
    setEditingId(loc.id);
    setShowNew(false);
  }

  function cancelForm() {
    setEditingId(null);
    setShowNew(false);
    setForm(EMPTY_FORM);
  }

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) { setStatusMsg({ type: "err", text: "Name is required." }); return; }
    setSaving(true);
    setStatusMsg(null);
    try {
      const body = {
        ...form,
        address_line1: form.address_line1 || null,
        address_city: form.address_city || null,
        address_state: form.address_state || null,
        address_zip: form.address_zip || null,
        phone: form.phone || null,
        fax: form.fax || null,
        npi: form.npi || null,
      };
      const url = editingId
        ? `/api/settings/service-locations?organizationId=${encodeURIComponent(organizationId)}&id=${encodeURIComponent(editingId)}`
        : `/api/settings/service-locations?organizationId=${encodeURIComponent(organizationId)}`;
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "Save failed");
      setStatusMsg({ type: "ok", text: editingId ? "Location updated." : "Location created." });
      cancelForm();
      load();
    } catch (err) {
      setStatusMsg({ type: "err", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }, [editingId, form, organizationId, load]);

  const showForm = showNew || editingId !== null;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Service Locations</h1>
          <p className="hero-copy">Office locations and place-of-service codes used on claims.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      {!organizationId && <div className="alert-panel">No organization context.</div>}
      {statusMsg && (
        <div className={statusMsg.type === "ok" ? "alert-panel alert-panel-success" : "alert-panel"}>{statusMsg.text}</div>
      )}

      <section className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <h2>Locations ({loading ? "…" : locations.length})</h2>
          {!showForm && (
            <button className="button button-primary" onClick={() => { setShowNew(true); setEditingId(null); setForm(EMPTY_FORM); }}>
              + Add Location
            </button>
          )}
        </div>

        {loading && <div className="empty-state">Loading…</div>}
        {!loading && locations.length === 0 && (
          <div className="alert-panel">
            <strong>No service locations configured.</strong> Add at least one to associate with claims and encounters.
          </div>
        )}

        {showForm && (
          <article className="panel form-panel" style={{ marginBottom: "var(--space-5)", border: "1px solid var(--border-color)" }}>
            <h3>{editingId ? "Edit Location" : "New Service Location"}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <label className="field-label">
                Location Name <span style={{ color: "var(--text-danger)" }}>*</span>
                <input type="text" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
              </label>
              <label className="field-label">
                Location Type
                <select value={form.location_type} onChange={(e) => setForm((p) => ({ ...p, location_type: e.target.value }))}>
                  <option value="office">Office</option>
                  <option value="telehealth">Telehealth</option>
                  <option value="home">Home</option>
                  <option value="clinic">Clinic</option>
                  <option value="hospital">Hospital</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="field-label">
                Place of Service Code
                <select value={form.place_of_service_code} onChange={(e) => setForm((p) => ({ ...p, place_of_service_code: e.target.value }))}>
                  <option value="02">02 – Telehealth</option>
                  <option value="10">10 – Telehealth (Client Home)</option>
                  <option value="11">11 – Office</option>
                  <option value="12">12 – Home</option>
                  <option value="21">21 – Inclient Hospital</option>
                  <option value="49">49 – Independent Clinic</option>
                  <option value="53">53 – Community Mental Health Center</option>
                </select>
              </label>
              <label className="field-label">
                NPI
                <input type="text" value={form.npi} onChange={(e) => setForm((p) => ({ ...p, npi: e.target.value }))} />
              </label>
              <label className="field-label">
                Address Line 1
                <input type="text" value={form.address_line1} onChange={(e) => setForm((p) => ({ ...p, address_line1: e.target.value }))} />
              </label>
              <label className="field-label">
                City
                <input type="text" value={form.address_city} onChange={(e) => setForm((p) => ({ ...p, address_city: e.target.value }))} />
              </label>
              <label className="field-label">
                State
                <input type="text" value={form.address_state} maxLength={2} onChange={(e) => setForm((p) => ({ ...p, address_state: e.target.value }))} />
              </label>
              <label className="field-label">
                ZIP
                <input type="text" value={form.address_zip} onChange={(e) => setForm((p) => ({ ...p, address_zip: e.target.value }))} />
              </label>
              <label className="field-label">
                Phone
                <input type="text" value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} />
              </label>
              <label className="field-label">
                Fax
                <input type="text" value={form.fax} onChange={(e) => setForm((p) => ({ ...p, fax: e.target.value }))} />
              </label>
            </div>
            <div style={{ display: "flex", gap: "var(--space-5)", margin: "var(--space-3) 0" }}>
              <label className="checkbox-label">
                <input type="checkbox" checked={form.is_default} onChange={(e) => setForm((p) => ({ ...p, is_default: e.target.checked }))} />
                Default location
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))} />
                Active
              </label>
            </div>
            <div style={{ display: "flex", gap: "var(--space-3)" }}>
              <button className="button button-primary" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : editingId ? "Update" : "Create"}
              </button>
              <button className="button button-secondary" onClick={cancelForm} disabled={saving}>Cancel</button>
            </div>
          </article>
        )}

        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {locations.map((loc) => (
            <article key={loc.id} className="metric-card" style={{ padding: "var(--space-4)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <strong>{loc.name}</strong>
                  {loc.is_default && <span style={{ marginLeft: "8px", fontSize: "var(--text-xs)", background: "var(--accent-light)", color: "var(--accent)", padding: "2px 6px", borderRadius: "4px" }}>Default</span>}
                  <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: "4px" }}>
                    POS: <strong>{loc.place_of_service_code}</strong> · Type: {loc.location_type}
                    {loc.address_line1 && ` · ${loc.address_line1}, ${loc.address_city ?? ""} ${loc.address_state ?? ""} ${loc.address_zip ?? ""}`}
                    {loc.npi && ` · NPI: ${loc.npi}`}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                  <span className={loc.is_active ? "status status-green" : "status status-red"}>
                    {loc.is_active ? "Active" : "Inactive"}
                  </span>
                  <button className="button button-secondary" onClick={() => startEdit(loc)}>Edit</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
