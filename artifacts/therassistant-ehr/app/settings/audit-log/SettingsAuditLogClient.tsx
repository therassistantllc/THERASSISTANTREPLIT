"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const PAGE_SIZE = 50;

interface AuditEntry {
  id: string;
  createdAt: string;
  action: string | null;
  settingKey: string | null;
  field: string | null;
  fieldLabel: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  summary: string | null;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  userRole: string | null;
}

interface Pagination {
  limit: number;
  offset: number;
  returned: number;
  totalCount: number | null;
  hasMore: boolean;
}

interface FilterOptions {
  settingKeys: string[];
  actors: Array<{ id: string; name: string; email: string | null }>;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value || "—";
  if (typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default function SettingsAuditLogClient() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [options, setOptions] = useState<FilterOptions>({ settingKeys: [], actors: [] });
  const [settingKey, setSettingKey] = useState("");
  const [actorId, setActorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (settingKey) params.set("settingKey", settingKey);
      if (actorId) params.set("actorId", actorId);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const resp = await fetch(`/api/settings/audit-log?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await resp.json();
      if (!resp.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load settings audit log");
      }
      setEntries(json.entries as AuditEntry[]);
      setPagination(json.pagination as Pagination);
      setOptions(json.filterOptions as FilterOptions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load settings audit log");
    } finally {
      setLoading(false);
    }
  }, [settingKey, actorId, from, to, page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalCount = pagination?.totalCount ?? null;
  const offset = pagination?.offset ?? page * PAGE_SIZE;
  const returned = pagination?.returned ?? entries.length;
  const hasMore = pagination?.hasMore ?? false;
  const rangeStart = returned === 0 ? 0 : offset + 1;
  const rangeEnd = offset + returned;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">
            <Link href="/settings" style={{ color: "inherit" }}>
              Administration
            </Link>{" "}
            / Settings audit log
          </p>
          <h1>Settings audit log</h1>
          <p className="hero-copy">
            Every change to a system setting in one place — billing defaults,
            277CA auto-routing, payer connections, and any future page that
            writes to <code>system_settings</code>. Read-only.
          </p>
        </div>
      </section>

      <section
        aria-label="Filters"
        className="panel"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "var(--space-3)",
          marginBottom: "var(--space-4)",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Setting</span>
          <select
            className="input"
            value={settingKey}
            onChange={(e) => {
              setSettingKey(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All settings</option>
            {options.settingKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>User</span>
          <select
            className="input"
            value={actorId}
            onChange={(e) => {
              setActorId(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All users</option>
            {options.actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email ? `${a.name} (${a.email})` : a.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>From</span>
          <input
            className="input"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>To</span>
          <input
            className="input"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <div style={{ display: "flex", alignItems: "end", gap: "0.5rem" }}>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setSettingKey("");
              setActorId("");
              setFrom("");
              setTo("");
              setPage(0);
            }}
          >
            Reset
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => load()}
          >
            Refresh
          </button>
        </div>
      </section>

      {error ? (
        <div
          className="alert-panel"
          role="alert"
          style={{ borderLeft: "4px solid var(--color-danger, #b91c1c)" }}
        >
          {error}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          margin: "var(--space-2) 0",
          color: "var(--text-secondary, #555)",
          fontSize: "0.9rem",
        }}
      >
        <span>
          {loading
            ? "Loading…"
            : returned === 0
              ? "0 changes"
              : totalCount !== null
                ? `Showing ${rangeStart}–${rangeEnd} of ${totalCount.toLocaleString()}`
                : `Showing ${rangeStart}–${rangeEnd}`}
        </span>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            className="button button-secondary"
            disabled={loading || page === 0}
            onClick={() => setPage((c) => Math.max(0, c - 1))}
          >
            Previous
          </button>
          <span>Page {page + 1}</span>
          <button
            type="button"
            className="button button-secondary"
            disabled={loading || !hasMore}
            onClick={() => setPage((c) => c + 1)}
          >
            Next
          </button>
        </div>
      </div>

      {loading ? (
        <p>Loading settings audit log…</p>
      ) : entries.length === 0 ? (
        <div className="empty-state" style={{ padding: "var(--space-4)" }}>
          No settings changes match the current filters.
        </div>
      ) : (
        <div className="panel" style={{ overflowX: "auto", padding: 0 }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.92rem",
            }}
          >
            <thead>
              <tr style={{ background: "#f0f0f4", textAlign: "left" }}>
                <th style={{ padding: "0.5rem 0.75rem" }}>When</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Setting</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Field</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Before → After</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Who</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const actor =
                  e.actorName ?? e.actorEmail ?? (e.actorId ? `User ${e.actorId.slice(0, 8)}` : "Unknown");
                return (
                  <tr
                    key={e.id}
                    style={{ borderTop: "1px solid #e5e5ea", verticalAlign: "top" }}
                  >
                    <td style={{ padding: "0.5rem 0.75rem", whiteSpace: "nowrap" }}>
                      {formatTimestamp(e.createdAt)}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem" }}>
                      <div style={{ fontFamily: "var(--font-mono, monospace)" }}>
                        {e.settingKey ?? "—"}
                      </div>
                      {e.summary ? (
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-secondary, #666)",
                            marginTop: 2,
                          }}
                        >
                          {e.summary}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem" }}>
                      {e.fieldLabel ?? e.field ?? "—"}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem" }}>
                      <code>{formatValue(e.beforeValue)}</code>{" "}
                      <span aria-hidden="true">→</span>{" "}
                      <code>{formatValue(e.afterValue)}</code>
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem" }}>
                      <div>{actor}</div>
                      {e.userRole ? (
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-secondary, #666)",
                          }}
                        >
                          {e.userRole}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
