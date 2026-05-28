"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type AuditEntry = {
  id: string;
  createdAt: string;
  patientId: string | null;
  patientName: string | null;
  field: string | null;
  fieldLabel: string;
  beforeValue: string | null;
  afterValue: string | null;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  userRole: string | null;
};

type FieldOption = { value: string; label: string };
type ActorOption = { id: string; name: string; email: string | null };

type Pagination = {
  limit: number;
  offset: number;
  returned: number;
  totalCount: number | null;
  hasMore: boolean;
};

type ApiResponse = {
  success: boolean;
  error?: string;
  entries?: AuditEntry[];
  pagination?: Pagination;
  filterOptions?: { fields: FieldOption[]; actors: ActorOption[] };
};

const PAGE_SIZE = 100;

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString();
  } catch {
    return iso;
  }
}

function formatValue(value: string | null): string {
  if (value === null || value === "") return "—";
  return value;
}

export default function DemographicsAuditClient() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [fieldOptions, setFieldOptions] = useState<FieldOption[]>([]);
  const [actorOptions, setActorOptions] = useState<ActorOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [field, setField] = useState("");
  const [actorId, setActorId] = useState("");
  const [page, setPage] = useState(0);
  const [pagination, setPagination] = useState<Pagination | null>(null);

  const filterKey = useMemo(
    () => JSON.stringify({ from, to, field, actorId }),
    [from, to, field, actorId],
  );

  // Reset to first page when filters change.
  useEffect(() => {
    setPage(0);
  }, [filterKey]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (field) params.set("field", field);
      if (actorId) params.set("actorId", actorId);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const response = await fetch(`/api/admin/audit/demographics?${params.toString()}`, {
        cache: "no-store",
      });
      const json = (await response.json()) as ApiResponse;
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load audit log");
      }
      setEntries(json.entries ?? []);
      setPagination(json.pagination ?? null);
      if (json.filterOptions) {
        setFieldOptions(json.filterOptions.fields);
        setActorOptions(json.filterOptions.actors);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }, [from, to, field, actorId, page]);

  useEffect(() => {
    load();
  }, [load]);

  function resetFilters() {
    setFrom("");
    setTo("");
    setField("");
    setActorId("");
    setPage(0);
  }

  const totalCount = pagination?.totalCount ?? null;
  const offset = pagination?.offset ?? page * PAGE_SIZE;
  const returned = pagination?.returned ?? entries.length;
  const hasMore = pagination?.hasMore ?? false;
  const rangeStart = returned === 0 ? 0 : offset + 1;
  const rangeEnd = offset + returned;

  return (
    <div className="page-container" style={{ padding: "1.5rem", maxWidth: 1200, margin: "0 auto" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ margin: 0 }}>Demographics audit log</h1>
        <p style={{ color: "#555", marginTop: "0.5rem" }}>
          Every demographic change recorded across all clients in your organization. Use the
          filters below to narrow by date, field, or staff member.
        </p>
      </header>

      <section
        aria-label="Filters"
        style={{
          background: "#f7f7f9",
          border: "1px solid #e3e3e8",
          borderRadius: 8,
          padding: "1rem",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1rem",
          marginBottom: "1rem",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>From</span>
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="input"
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>To</span>
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="input"
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Field</span>
          <select
            value={field}
            onChange={(event) => setField(event.target.value)}
            className="input"
          >
            <option value="">All fields</option>
            {fieldOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Staff member</span>
          <select
            value={actorId}
            onChange={(event) => setActorId(event.target.value)}
            className="input"
          >
            <option value="">All staff</option>
            {actorOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.email ? `${option.name} (${option.email})` : option.name}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: "flex", alignItems: "end", gap: "0.5rem" }}>
          <button type="button" className="button button-secondary" onClick={resetFilters}>
            Reset
          </button>
          <button type="button" className="button button-primary" onClick={() => load()}>
            Refresh
          </button>
        </div>
      </section>

      {error ? (
        <div
          role="alert"
          style={{
            background: "#fdecec",
            border: "1px solid #f5c2c2",
            color: "#8a1c1c",
            padding: "0.75rem 1rem",
            borderRadius: 6,
            marginBottom: "1rem",
          }}
        >
          {error}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          margin: "0.5rem 0",
          color: "#555",
          fontSize: "0.9rem",
        }}
      >
        <span>
          {loading
            ? "Loading…"
            : returned === 0
              ? "0 results"
              : totalCount !== null
                ? `Showing ${rangeStart}–${rangeEnd} of ${totalCount.toLocaleString()}`
                : `Showing ${rangeStart}–${rangeEnd}`}
        </span>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            className="button button-secondary"
            disabled={loading || page === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            Previous
          </button>
          <span>Page {page + 1}</span>
          <button
            type="button"
            className="button button-secondary"
            disabled={loading || !hasMore}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </button>
        </div>
      </div>

      {loading ? (
        <p>Loading audit log…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: "#666" }}>No demographic changes match the current filters.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
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
                <th style={{ padding: "0.5rem 0.75rem" }}>Client</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Field</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Before</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>After</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Changed by</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} style={{ borderTop: "1px solid #e5e5ea" }}>
                  <td style={{ padding: "0.5rem 0.75rem", whiteSpace: "nowrap" }}>
                    {formatTimestamp(entry.createdAt)}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem" }}>
                    {entry.patientId ? (
                      <Link href={`/clients/${entry.patientId}`} className="inline-link">
                        {entry.patientName ?? entry.patientId}
                      </Link>
                    ) : (
                      <span style={{ color: "#888" }}>Unknown</span>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem" }}>{entry.fieldLabel}</td>
                  <td style={{ padding: "0.5rem 0.75rem", color: "#555" }}>
                    {formatValue(entry.beforeValue)}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem" }}>{formatValue(entry.afterValue)}</td>
                  <td style={{ padding: "0.5rem 0.75rem" }}>
                    <div>{entry.actorName ?? entry.actorEmail ?? "Unknown"}</div>
                    {entry.userRole ? (
                      <div style={{ fontSize: "0.8rem", color: "#666" }}>{entry.userRole}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
