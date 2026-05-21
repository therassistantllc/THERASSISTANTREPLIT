"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

/**
 * Per-payer trading-partner enrollment tracker.
 *
 * Displays a payer × transaction-type × environment matrix with status pills, and an inline
 * editor for the most common operator action ("Office Ally just approved this combo — mark
 * it approved with the OA enrollment reference").
 *
 * Source of truth: `payer_enrollments`. Production 837P submission is hard-gated on this
 * table in the batch submit route — see lib/clearinghouse/payerEnrollmentGate.ts.
 */

type Payer = { id: string; payer_name: string; office_ally_payer_id: string | null; is_active: boolean };
type Enrollment = {
  id: string;
  payer_profile_id: string;
  transaction_type: string;
  environment: "sandbox" | "production";
  status: "pending" | "submitted" | "approved" | "rejected" | "terminated";
  oa_enrollment_reference: string | null;
  approved_at: string | null;
  expires_at: string | null;
  notes: string | null;
  updated_at: string;
};

const TRANSACTION_TYPES = ["837P", "835", "270", "276", "999"] as const;
const ENVIRONMENTS = ["sandbox", "production"] as const;
const STATUSES = ["pending", "submitted", "approved", "rejected", "terminated"] as const;

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function StatusBadge({ status }: { status: Enrollment["status"] | "none" }) {
  const map: Record<string, { color: string; label: string }> = {
    approved: { color: "var(--status-green, #16a34a)", label: "Approved" },
    submitted: { color: "var(--status-blue, #2563eb)", label: "Submitted" },
    pending: { color: "var(--status-yellow, #ca8a04)", label: "Pending" },
    rejected: { color: "var(--status-red, #dc2626)", label: "Rejected" },
    terminated: { color: "var(--text-secondary, #6b7280)", label: "Terminated" },
    none: { color: "var(--text-secondary, #6b7280)", label: "Not enrolled" },
  };
  const m = map[status] ?? map.none;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "999px",
        background: m.color,
        color: "#fff",
        fontSize: "11px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      {m.label}
    </span>
  );
}

export default function PayerEnrollmentsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    payer_profile_id: string;
    transaction_type: string;
    environment: "sandbox" | "production";
    status: Enrollment["status"];
    oa_enrollment_reference: string;
    approved_at: string;
    expires_at: string;
    notes: string;
  } | null>(null);

  const load = useCallback(() => {
    if (!organizationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/api/settings/payer-enrollments?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((json: { payers?: Payer[]; enrollments?: Enrollment[]; error?: string }) => {
        if (json.error) throw new Error(json.error);
        setPayers(json.payers ?? []);
        setEnrollments(json.enrollments ?? []);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, [organizationId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    load();
  }, [load]);

  const enrollmentMap = useMemo(() => {
    const m = new Map<string, Enrollment>();
    for (const e of enrollments) {
      if (e.status === "terminated") continue;
      m.set(`${e.payer_profile_id}::${e.transaction_type}::${e.environment}`, e);
    }
    return m;
  }, [enrollments]);

  const openEditor = useCallback(
    (payerId: string, transactionType: string, environment: "sandbox" | "production") => {
      const existing = enrollmentMap.get(`${payerId}::${transactionType}::${environment}`);
      setEditor({
        payer_profile_id: payerId,
        transaction_type: transactionType,
        environment,
        status: existing?.status ?? "pending",
        oa_enrollment_reference: existing?.oa_enrollment_reference ?? "",
        approved_at: existing?.approved_at ? existing.approved_at.slice(0, 10) : "",
        expires_at: existing?.expires_at ? existing.expires_at.slice(0, 10) : "",
        notes: existing?.notes ?? "",
      });
    },
    [enrollmentMap],
  );

  const save = useCallback(async () => {
    if (!editor) return;
    setSavingKey(`${editor.payer_profile_id}::${editor.transaction_type}::${editor.environment}`);
    setError(null);
    try {
      const res = await fetch(
        `/api/settings/payer-enrollments?organizationId=${encodeURIComponent(organizationId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payer_profile_id: editor.payer_profile_id,
            transaction_type: editor.transaction_type,
            environment: editor.environment,
            status: editor.status,
            oa_enrollment_reference: editor.oa_enrollment_reference || null,
            approved_at: editor.approved_at ? new Date(editor.approved_at).toISOString() : null,
            expires_at: editor.expires_at ? new Date(editor.expires_at).toISOString() : null,
            notes: editor.notes || null,
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
      setSavingKey(null);
    }
  }, [editor, organizationId, load]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Payer Enrollments</h1>
          <p className="hero-copy">
            Track the Office Ally trading-partner enrollment status for each payer × transaction type. Production
            837P submission is blocked at the API layer for any payer whose production enrollment is not
            <strong> Approved</strong>. Sandbox submissions always pass.
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
      ) : payers.length === 0 ? (
        <div className="panel">
          <div className="empty-state">
            No payers configured yet.{" "}
            <Link href="/settings/payers" className="button button-link">Add a payer →</Link>
          </div>
        </div>
      ) : (
        ENVIRONMENTS.map((env) => (
          <section key={env} className="panel" style={{ marginBottom: "var(--space-4)" }}>
            <h2 style={{ textTransform: "capitalize" }}>{env}</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
              {env === "production"
                ? "Approved enrollments here are required for live claims to transmit."
                : "Sandbox enrollments are tracked for visibility but never block transmission."}
            </p>
            <div style={{ overflowX: "auto", marginTop: "var(--space-3)" }}>
              <table className="data-table" style={{ minWidth: "640px" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Payer</th>
                    {TRANSACTION_TYPES.map((t) => (
                      <th key={t} style={{ textAlign: "center" }}>{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payers.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.payer_name}</strong>
                        {p.office_ally_payer_id && (
                          <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                            OA {p.office_ally_payer_id}
                          </div>
                        )}
                      </td>
                      {TRANSACTION_TYPES.map((t) => {
                        const key = `${p.id}::${t}::${env}`;
                        const e = enrollmentMap.get(key);
                        const isSaving = savingKey === key;
                        return (
                          <td key={t} style={{ textAlign: "center" }}>
                            <button
                              onClick={() => openEditor(p.id, t, env)}
                              disabled={isSaving}
                              style={{
                                background: "transparent",
                                border: "none",
                                cursor: "pointer",
                                padding: "4px",
                              }}
                              title="Click to edit"
                            >
                              <StatusBadge status={e?.status ?? "none"} />
                              {e?.oa_enrollment_reference && (
                                <div style={{ fontSize: "10px", color: "var(--text-secondary)", marginTop: 2 }}>
                                  {e.oa_enrollment_reference}
                                </div>
                              )}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      {editor && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setEditor(null)}
        >
          <div
            className="panel"
            style={{ maxWidth: 480, width: "100%", margin: "var(--space-4)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginTop: 0 }}>Edit enrollment</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
              {payers.find((p) => p.id === editor.payer_profile_id)?.payer_name} · {editor.transaction_type} ·{" "}
              <span style={{ textTransform: "capitalize" }}>{editor.environment}</span>
            </p>

            <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
              <label className="field-label">
                Status
                <select
                  value={editor.status}
                  onChange={(e) => setEditor((p) => p && { ...p, status: e.target.value as Enrollment["status"] })}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                OA enrollment reference
                <input
                  type="text"
                  value={editor.oa_enrollment_reference}
                  placeholder="e.g. OA-ENRL-12345"
                  onChange={(e) => setEditor((p) => p && { ...p, oa_enrollment_reference: e.target.value })}
                />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
                <label className="field-label">
                  Approved on
                  <input
                    type="date"
                    value={editor.approved_at}
                    onChange={(e) => setEditor((p) => p && { ...p, approved_at: e.target.value })}
                  />
                </label>
                <label className="field-label">
                  Expires on
                  <input
                    type="date"
                    value={editor.expires_at}
                    onChange={(e) => setEditor((p) => p && { ...p, expires_at: e.target.value })}
                  />
                </label>
              </div>
              <label className="field-label">
                Notes
                <textarea
                  rows={3}
                  value={editor.notes}
                  onChange={(e) => setEditor((p) => p && { ...p, notes: e.target.value })}
                />
              </label>
            </div>

            <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)", justifyContent: "flex-end" }}>
              <button className="button button-secondary" onClick={() => setEditor(null)}>Cancel</button>
              <button className="button button-primary" onClick={save} disabled={savingKey !== null}>
                {savingKey !== null ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
