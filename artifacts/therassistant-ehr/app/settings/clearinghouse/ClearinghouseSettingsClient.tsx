"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type Connection = {
  id: string;
  vendor: string;
  clearinghouse_name: string;
  connection_name: string | null;
  mode: string;
  submitter_id: string | null;
  sender_qualifier: string;
  receiver_qualifier: string;
  receiver_id: string | null;
  receiver_name: string;
  gs_receiver_code: string;
  x12_version: string;
  isa_usage_indicator: string;
  sftp_host: string | null;
  sftp_port: number | null;
  sftp_username: string | null;
  inbound_folder: string | null;
  outbound_folder: string | null;
  api_base_url: string | null;
  auth_type: string | null;
  eligibility_service_type_code: string;
  eligibility_transaction_set: string;
  is_active: boolean;
  has_credentials: boolean;
  credential_source: "vault" | "legacy_jsonb" | "none";
};

type FormState = Omit<Connection, "id" | "has_credentials" | "credential_source"> & {
  sftp_password: string;
  api_key: string;
};

const EMPTY_FORM: FormState = {
  vendor: "office_ally",
  clearinghouse_name: "Office Ally",
  connection_name: null,
  mode: "production",
  submitter_id: null,
  sender_qualifier: "ZZ",
  receiver_qualifier: "ZZ",
  receiver_id: null,
  receiver_name: "OFFICE ALLY",
  gs_receiver_code: "",
  x12_version: "005010X222A1",
  isa_usage_indicator: "P",
  sftp_host: null,
  sftp_port: null,
  sftp_username: null,
  sftp_password: "",
  api_key: "",
  inbound_folder: null,
  outbound_folder: null,
  api_base_url: "https://edi.officeally.io",
  auth_type: "api_key",
  eligibility_service_type_code: "98",
  eligibility_transaction_set: "270",
  is_active: true,
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function fieldStr(label: string, value: string | null, onChange: (v: string) => void, hint?: string) {
  return (
    <label className="field-label">
      {label}
      {hint && <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-xs)", marginLeft: "4px" }}>{hint}</span>}
      <input type="text" value={value ?? ""} onChange={(e) => onChange(e.target.value || null as unknown as string)} />
    </label>
  );
}

export default function ClearinghouseSettingsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadConnections = useCallback(() => {
    if (!organizationId) { setLoading(false); return; }
    fetch(`/api/settings/clearinghouse?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((json: { connections?: Connection[] }) => setConnections(json.connections ?? []))
      .catch(() => setStatusMsg({ type: "err", text: "Failed to load connections." }))
      .finally(() => setLoading(false));
  }, [organizationId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadConnections(); }, [loadConnections]);

  function startEdit(c: Connection) {
    setForm({ ...EMPTY_FORM, ...c, sftp_password: "", api_key: "" });
    setEditingId(c.id);
    setShowNew(false);
  }

  function startNew() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowNew(true);
  }

  function cancelForm() {
    setEditingId(null);
    setShowNew(false);
    setForm(EMPTY_FORM);
  }

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatusMsg(null);
    try {
      const url = editingId
        ? `/api/settings/clearinghouse?organizationId=${encodeURIComponent(organizationId)}&id=${encodeURIComponent(editingId)}`
        : `/api/settings/clearinghouse?organizationId=${encodeURIComponent(organizationId)}`;
      const method = editingId ? "PATCH" : "POST";
      const body: Record<string, unknown> = { ...form };
      if (!form.sftp_password) delete body.sftp_password;
      if (!form.api_key) delete body.api_key;

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "Save failed");
      setStatusMsg({ type: "ok", text: editingId ? "Connection updated." : "Connection created." });
      cancelForm();
      loadConnections();
    } catch (err) {
      setStatusMsg({ type: "err", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }, [editingId, form, organizationId, loadConnections]);

  function f(key: keyof FormState) {
    return (v: string) => setForm((prev) => ({ ...prev, [key]: v || null }));
  }

  const showForm = showNew || editingId !== null;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Clearinghouse / Office Ally</h1>
          <p className="hero-copy">EDI connection configuration, SFTP routing, and eligibility defaults.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      {!organizationId && (
        <div className="alert-panel">No organization context. Add <code>?organizationId=…</code> or set <code>NEXT_PUBLIC_ORGANIZATION_ID</code>.</div>
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
              <h2>Connections ({connections.length})</h2>
              {!showForm && (
                <button className="button button-primary" onClick={startNew}>+ Add Connection</button>
              )}
            </div>

            {connections.length === 0 && !showForm && (
              <div className="alert-panel">
                <strong>No clearinghouse connection configured.</strong> Claims and eligibility requests cannot be
                transmitted until at least one connection is set up with a valid Submitter ID and Receiver ID.
              </div>
            )}

            {connections.map((c) => (
              <article key={c.id} className="metric-card" style={{ marginBottom: "var(--space-3)", padding: "var(--space-4)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <strong>{c.clearinghouse_name}</strong>
                    {c.connection_name && <span style={{ color: "var(--text-secondary)", marginLeft: "8px" }}>{c.connection_name}</span>}
                    <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: "4px" }}>
                      Mode: <strong>{c.mode}</strong> · ISA: <strong>{c.isa_usage_indicator}</strong> ·
                      Submitter ID: <strong>{c.submitter_id ?? "⚠ Not set"}</strong> ·
                      Receiver ID: <strong>{c.receiver_id ?? "⚠ Not set"}</strong>
                    </div>
                    <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: "2px" }}>
                      SFTP: {c.sftp_host ? `${c.sftp_username}@${c.sftp_host}:${c.sftp_port ?? 22}` : "Not configured"} ·
                      API key:{" "}
                      <strong>
                        {c.credential_source === "vault"
                          ? "Stored in Vault"
                          : c.credential_source === "legacy_jsonb"
                            ? "⚠ Legacy plaintext — re-save to migrate to Vault"
                            : "Not set"}
                      </strong>
                    </div>
                    <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: "2px" }}>
                      Eligibility service type: <strong>{c.eligibility_service_type_code}</strong> ·
                      Transaction set: <strong>{c.eligibility_transaction_set}</strong>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                    <span className={c.is_active ? "status status-green" : "status status-red"}>
                      {c.is_active ? "Active" : "Inactive"}
                    </span>
                    <button className="button button-secondary" onClick={() => startEdit(c)}>Edit</button>
                  </div>
                </div>
              </article>
            ))}
          </section>

          {showForm && (
            <section className="panel form-panel">
              <h2>{editingId ? "Edit Connection" : "New Connection"}</h2>

              <h3 style={{ marginBottom: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Identity</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)", marginBottom: "var(--space-5)" }}>
                {fieldStr("Clearinghouse Name", form.clearinghouse_name, f("clearinghouse_name"))}
                {fieldStr("Connection Name (optional label)", form.connection_name, f("connection_name"))}
                {fieldStr("Vendor", form.vendor, f("vendor"))}
                <label className="field-label">
                  Mode
                  <select value={form.mode} onChange={(e) => setForm((p) => ({ ...p, mode: e.target.value }))}>
                    <option value="production">Production</option>
                    <option value="test">Test / Sandbox</option>
                  </select>
                </label>
              </div>

              <h3 style={{ marginBottom: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>EDI Identifiers</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)", marginBottom: "var(--space-5)" }}>
                {fieldStr("Submitter ID", form.submitter_id, f("submitter_id"), "(required for claims)")}
                {fieldStr("Receiver ID", form.receiver_id, f("receiver_id"))}
                {fieldStr("Receiver Name", form.receiver_name, f("receiver_name"))}
                {fieldStr("GS Receiver Code", form.gs_receiver_code, f("gs_receiver_code"))}
                {fieldStr("Sender Qualifier", form.sender_qualifier, f("sender_qualifier"))}
                {fieldStr("Receiver Qualifier", form.receiver_qualifier, f("receiver_qualifier"))}
              </div>

              <h3 style={{ marginBottom: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Transmission Defaults</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)", marginBottom: "var(--space-5)" }}>
                <label className="field-label">
                  ISA Usage Indicator
                  <select value={form.isa_usage_indicator} onChange={(e) => setForm((p) => ({ ...p, isa_usage_indicator: e.target.value }))}>
                    <option value="P">P – Production</option>
                    <option value="T">T – Test</option>
                  </select>
                </label>
                {fieldStr("X12 Version", form.x12_version, f("x12_version"))}
                {fieldStr("Eligibility Service Type Code", form.eligibility_service_type_code, f("eligibility_service_type_code"), "(98 = mental health)")}
                {fieldStr("Eligibility Transaction Set", form.eligibility_transaction_set, f("eligibility_transaction_set"))}
              </div>

              <h3 style={{ marginBottom: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>API / JSON</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)", marginBottom: "var(--space-5)" }}>
                {fieldStr("API Base URL", form.api_base_url, f("api_base_url"))}
                {fieldStr("Auth Type", form.auth_type, f("auth_type"))}
                <label className="field-label" style={{ gridColumn: "1 / -1" }}>
                  API Key
                  <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-xs)", marginLeft: "4px" }}>
                    {editingId
                      ? "(leave blank to keep existing; entering a new value rotates the Vault secret)"
                      : "(stored encrypted in Supabase Vault; never echoed back)"}
                  </span>
                  <input
                    type="password"
                    value={form.api_key}
                    autoComplete="new-password"
                    placeholder={editingId ? "•••••••• (unchanged)" : "Paste Office Ally API key"}
                    onChange={(e) => setForm((p) => ({ ...p, api_key: e.target.value }))}
                  />
                </label>
              </div>

              <h3 style={{ marginBottom: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>SFTP</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)", marginBottom: "var(--space-5)" }}>
                {fieldStr("SFTP Host", form.sftp_host, f("sftp_host"))}
                <label className="field-label">
                  SFTP Port
                  <input
                    type="number"
                    value={form.sftp_port ?? ""}
                    onChange={(e) => setForm((p) => ({ ...p, sftp_port: e.target.value ? Number(e.target.value) : null }))}
                  />
                </label>
                {fieldStr("SFTP Username", form.sftp_username, f("sftp_username"))}
                <label className="field-label">
                  SFTP Password
                  <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-xs)", marginLeft: "4px" }}>
                    {editingId ? "(leave blank to keep existing)" : "(stored server-side only)"}
                  </span>
                  <input
                    type="password"
                    value={form.sftp_password}
                    autoComplete="new-password"
                    onChange={(e) => setForm((p) => ({ ...p, sftp_password: e.target.value }))}
                  />
                </label>
                {fieldStr("Inbound Folder", form.inbound_folder, f("inbound_folder"))}
                {fieldStr("Outbound Folder", form.outbound_folder, f("outbound_folder"))}
              </div>

              <label className="checkbox-label" style={{ marginBottom: "var(--space-5)" }}>
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
                />
                Connection is active
              </label>

              <div style={{ display: "flex", gap: "var(--space-3)" }}>
                <button className="button button-primary" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : editingId ? "Update Connection" : "Create Connection"}
                </button>
                <button className="button button-secondary" onClick={cancelForm} disabled={saving}>Cancel</button>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
