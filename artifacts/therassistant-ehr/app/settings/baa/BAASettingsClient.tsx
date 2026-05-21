"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

/**
 * Business Associate Agreement settings page.
 *
 * Displays the four mandatory BAA counterparties (Office Ally, Supabase, Google Workspace,
 * hosting) with status pills and editable signed/effective/expires dates. The first GET for
 * an org seeds these four rows at status='not_started' so the operator always sees what's
 * outstanding.
 */

type Agreement = {
  id: string;
  counterparty_type: string;
  counterparty_name: string;
  status: "not_started" | "draft" | "executed" | "expired" | "terminated";
  signed_at: string | null;
  effective_at: string | null;
  expires_at: string | null;
  contact_name: string | null;
  contact_email: string | null;
  document_url: string | null;
  notes: string | null;
  updated_at: string;
};

const STATUSES = ["not_started", "draft", "executed", "expired", "terminated"] as const;

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function StatusPill({ status, expires_at }: { status: Agreement["status"]; expires_at: string | null }) {
  let color = "#6b7280";
  let label: string = status.replace("_", " ");
  if (status === "executed") {
    color = "#16a34a";
    label = "Executed";
    if (expires_at) {
      const daysLeft = Math.floor((new Date(expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysLeft < 0) {
        color = "#dc2626";
        label = `Expired ${Math.abs(daysLeft)}d ago`;
      } else if (daysLeft < 60) {
        color = "#ca8a04";
        label = `Expires in ${daysLeft}d`;
      }
    }
  } else if (status === "draft") {
    color = "#2563eb";
    label = "Draft";
  } else if (status === "expired") {
    color = "#dc2626";
    label = "Expired";
  } else if (status === "terminated") {
    color = "#6b7280";
    label = "Terminated";
  } else if (status === "not_started") {
    color = "#dc2626";
    label = "Not started";
  }
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "999px",
        background: color,
        color: "#fff",
        fontSize: "11px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </span>
  );
}

export default function BAASettingsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Agreement | null>(null);

  const load = useCallback(() => {
    if (!organizationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/api/settings/baa?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((json: { agreements?: Agreement[]; error?: string }) => {
        if (json.error) throw new Error(json.error);
        setAgreements(json.agreements ?? []);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, [organizationId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    if (!editor) return;
    setSavingId(editor.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/settings/baa?organizationId=${encodeURIComponent(organizationId)}&id=${encodeURIComponent(editor.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            counterparty_name: editor.counterparty_name,
            status: editor.status,
            signed_at: editor.signed_at,
            effective_at: editor.effective_at,
            expires_at: editor.expires_at,
            contact_name: editor.contact_name,
            contact_email: editor.contact_email,
            document_url: editor.document_url,
            notes: editor.notes,
          }),
        },
      );
      if (!res.ok) {
        const json = (await res.json()) as { error?: string; fields?: Record<string, string> };
        const fieldMsg = json.fields ? Object.values(json.fields).join(" · ") : "";
        throw new Error([json.error ?? "Save failed", fieldMsg].filter(Boolean).join(" — "));
      }
      setEditor(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingId(null);
    }
  }, [editor, organizationId, load]);

  const updateEditor = <K extends keyof Agreement>(k: K, v: Agreement[K]) =>
    setEditor((p) => p && { ...p, [k]: v });

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Business Associate Agreements</h1>
          <p className="hero-copy">
            HIPAA requires a signed BAA with every vendor that processes PHI on your behalf. This page tracks the
            four mandatory counterparties (Office Ally, Supabase, Google Workspace, hosting) and any additional
            agreements you maintain. The Trading Partner page surfaces a green/yellow/red summary of the four required BAAs.
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

      {error && <div className="alert-panel">{error}</div>}

      {loading ? (
        <div className="panel"><div className="empty-state">Loading…</div></div>
      ) : (
        <section className="panel">
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Counterparty</th>
                  <th>Status</th>
                  <th>Signed</th>
                  <th>Expires</th>
                  <th>Contact</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {agreements.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.counterparty_name}</strong>
                      <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{a.counterparty_type}</div>
                    </td>
                    <td><StatusPill status={a.status} expires_at={a.expires_at} /></td>
                    <td>{a.signed_at ?? <em style={{ color: "var(--text-secondary)" }}>—</em>}</td>
                    <td>{a.expires_at ?? <em style={{ color: "var(--text-secondary)" }}>—</em>}</td>
                    <td>
                      {a.contact_email ? (
                        <a href={`mailto:${a.contact_email}`}>{a.contact_email}</a>
                      ) : (
                        <em style={{ color: "var(--text-secondary)" }}>—</em>
                      )}
                    </td>
                    <td>
                      <button
                        className="button button-link"
                        onClick={() => setEditor({ ...a })}
                        disabled={savingId === a.id}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
                {agreements.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state">No agreements yet.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editor && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}
          onClick={() => setEditor(null)}
        >
          <div
            className="panel"
            style={{ maxWidth: 540, width: "100%", margin: "var(--space-4)", maxHeight: "90vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginTop: 0 }}>Edit BAA</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
              {editor.counterparty_type}
            </p>

            <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
              <label className="field-label">
                Counterparty name
                <input
                  type="text"
                  value={editor.counterparty_name}
                  onChange={(e) => updateEditor("counterparty_name", e.target.value)}
                />
              </label>

              <label className="field-label">
                Status
                <select
                  value={editor.status}
                  onChange={(e) => updateEditor("status", e.target.value as Agreement["status"])}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--space-3)" }}>
                <label className="field-label">
                  Signed
                  <input
                    type="date"
                    value={editor.signed_at ?? ""}
                    onChange={(e) => updateEditor("signed_at", e.target.value || null)}
                  />
                </label>
                <label className="field-label">
                  Effective
                  <input
                    type="date"
                    value={editor.effective_at ?? ""}
                    onChange={(e) => updateEditor("effective_at", e.target.value || null)}
                  />
                </label>
                <label className="field-label">
                  Expires
                  <input
                    type="date"
                    value={editor.expires_at ?? ""}
                    onChange={(e) => updateEditor("expires_at", e.target.value || null)}
                  />
                </label>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
                <label className="field-label">
                  Contact name
                  <input
                    type="text"
                    value={editor.contact_name ?? ""}
                    onChange={(e) => updateEditor("contact_name", e.target.value || null)}
                  />
                </label>
                <label className="field-label">
                  Contact email
                  <input
                    type="email"
                    value={editor.contact_email ?? ""}
                    onChange={(e) => updateEditor("contact_email", e.target.value || null)}
                  />
                </label>
              </div>

              <label className="field-label">
                Document URL
                <input
                  type="url"
                  value={editor.document_url ?? ""}
                  placeholder="https://…"
                  onChange={(e) => updateEditor("document_url", e.target.value || null)}
                />
              </label>

              <label className="field-label">
                Notes
                <textarea
                  rows={3}
                  value={editor.notes ?? ""}
                  onChange={(e) => updateEditor("notes", e.target.value || null)}
                />
              </label>
            </div>

            <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)", justifyContent: "flex-end" }}>
              <button className="button button-secondary" onClick={() => setEditor(null)}>Cancel</button>
              <button className="button button-primary" onClick={save} disabled={savingId !== null}>
                {savingId !== null ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
