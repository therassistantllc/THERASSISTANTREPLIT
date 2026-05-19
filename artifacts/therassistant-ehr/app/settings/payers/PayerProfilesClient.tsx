"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Payer = {
  id: string;
  payer_name: string;
  office_ally_payer_id: string;
  payer_type: string | null;
  is_active: boolean;
  notes: string | null;
  updated_at: string;
};

type FormState = {
  payer_name: string;
  office_ally_payer_id: string;
  payer_type: string;
  is_active: boolean;
  notes: string;
};

const EMPTY_FORM: FormState = {
  payer_name: "",
  office_ally_payer_id: "",
  payer_type: "",
  is_active: true,
  notes: "",
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
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
    setForm({
      payer_name: p.payer_name,
      office_ally_payer_id: p.office_ally_payer_id,
      payer_type: p.payer_type ?? "",
      is_active: p.is_active,
      notes: p.notes ?? "",
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
    if (!form.payer_name.trim() || !form.office_ally_payer_id.trim()) {
      setStatusMsg({ type: "err", text: "Payer Name and Office Ally Payer ID are required." });
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      const url = editingId
        ? `/api/settings/payer-profiles?organizationId=${encodeURIComponent(organizationId)}&id=${encodeURIComponent(editingId)}`
        : `/api/settings/payer-profiles?organizationId=${encodeURIComponent(organizationId)}`;
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          payer_type: form.payer_type || null,
          notes: form.notes || null,
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
          <p className="hero-copy">Office Ally payer IDs and configuration for claim submission routing.</p>
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
                Office Ally Payer ID <span style={{ color: "var(--text-danger)" }}>*</span>
                <input
                  type="text"
                  value={form.office_ally_payer_id}
                  onChange={(e) => setForm((p) => ({ ...p, office_ally_payer_id: e.target.value }))}
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
            </div>
            <label className="checkbox-label" style={{ margin: "var(--space-3) 0" }}>
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
              />
              Active
            </label>
            <div style={{ display: "flex", gap: "var(--space-3)" }}>
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
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>Office Ally ID</th>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>Type</th>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>Status</th>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}>Notes</th>
              <th style={{ padding: "8px 12px", fontSize: "var(--text-sm)" }}></th>
            </tr>
          </thead>
          <tbody>
            {payers.map((p) => (
              <tr key={p.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                <td style={{ padding: "8px 12px" }}><strong>{p.payer_name}</strong></td>
                <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>{p.office_ally_payer_id}</td>
                <td style={{ padding: "8px 12px" }}>{p.payer_type ?? "—"}</td>
                <td style={{ padding: "8px 12px" }}>
                  <span className={p.is_active ? "status status-green" : "status status-red"}>
                    {p.is_active ? "Active" : "Inactive"}
                  </span>
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
