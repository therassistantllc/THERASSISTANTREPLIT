"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type MailroomConfig = {
  // canonical_status_column: which column new writes target
  canonical_status_column: "mail_status" | "status";
  default_document_scope: string;
  default_source: string;
};

const DEFAULTS: MailroomConfig = {
  canonical_status_column: "mail_status",
  default_document_scope: "general",
  default_source: "upload",
};

const SETTING_KEY = "mailroom.config";

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

export default function MailroomSettingsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [config, setConfig] = useState<MailroomConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!organizationId) { setLoading(false); return; }
    fetch(`/api/settings/system-settings?organizationId=${encodeURIComponent(organizationId)}&key=${encodeURIComponent(SETTING_KEY)}`)
      .then((r) => r.json())
      .then((json: { value?: Partial<MailroomConfig> }) => {
        if (json.value) setConfig((prev) => ({ ...prev, ...json.value }));
      })
      .catch(() => {/* silently use defaults */})
      .finally(() => setLoading(false));
  }, [organizationId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch(
        `/api/settings/system-settings?organizationId=${encodeURIComponent(organizationId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: SETTING_KEY, value: config }),
        },
      );
      if (!res.ok) throw new Error("Save failed");
      setStatusMsg({ type: "ok", text: "Mailroom settings saved." });
    } catch {
      setStatusMsg({ type: "err", text: "Failed to save mailroom settings." });
    } finally {
      setSaving(false);
    }
  }, [config, organizationId]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Mail Room Settings</h1>
          <p className="hero-copy">Document routing, status column canonicalization, and mailroom defaults.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/mailroom">Open Mailroom</Link>
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      {!organizationId && <div className="alert-panel">No organization context.</div>}
      {statusMsg && (
        <div className={statusMsg.type === "ok" ? "alert-panel alert-panel-success" : "alert-panel"}>
          {statusMsg.text}
        </div>
      )}

      {loading ? (
        <div className="panel"><div className="empty-state">Loading…</div></div>
      ) : (
        <>
          <section className="panel form-panel">
            <h2>Status Column Configuration</h2>
            <label className="field-label">
              Canonical Status Column (new writes target this column)
              <select
                value={config.canonical_status_column}
                onChange={(e) =>
                  setConfig((p) => ({
                    ...p,
                    canonical_status_column: e.target.value as "mail_status" | "status",
                  }))
                }
              >
                <option value="mail_status">mail_status (recommended — used by mailroom UI)</option>
                <option value="status">status (legacy — used by some older workflows)</option>
              </select>
            </label>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginTop: "var(--space-2)" }}>
              Both columns will continue to exist. This setting controls which one the mailroom uses for new
              routing decisions. The other column is not written to but remains readable.
            </p>
          </section>

          <section className="panel form-panel">
            <h2>Routing Defaults</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <label className="field-label">
                Default Document Scope
                <select
                  value={config.default_document_scope}
                  onChange={(e) => setConfig((p) => ({ ...p, default_document_scope: e.target.value }))}
                >
                  <option value="general">General</option>
                  <option value="clinical">Clinical</option>
                  <option value="billing">Billing</option>
                  <option value="eob">EOB / Remittance</option>
                  <option value="auth">Authorization</option>
                  <option value="correspondence">Correspondence</option>
                </select>
              </label>
              <label className="field-label">
                Default Source
                <select
                  value={config.default_source}
                  onChange={(e) => setConfig((p) => ({ ...p, default_source: e.target.value }))}
                >
                  <option value="upload">Manual Upload</option>
                  <option value="fax">Fax</option>
                  <option value="email">Email</option>
                  <option value="era">ERA / Remittance</option>
                  <option value="payer">Payer Portal</option>
                </select>
              </label>
            </div>
          </section>

          <section className="panel">
            <h2>Status Values Reference</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-3)" }}>
              These are the recognized status values for mailroom items. No custom values can be added without a schema migration.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {["unsorted", "pending_action", "routed", "filed", "archived"].map((s) => (
                <span
                  key={s}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "var(--radius)",
                    background: "var(--surface-2)",
                    fontSize: "var(--text-sm)",
                    fontFamily: "monospace",
                  }}
                >
                  {s}
                </span>
              ))}
            </div>
          </section>

          <div style={{ padding: "0 var(--space-6) var(--space-6)" }}>
            <button className="button button-primary" onClick={handleSave} disabled={saving || !organizationId}>
              {saving ? "Saving…" : "Save Mailroom Settings"}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
