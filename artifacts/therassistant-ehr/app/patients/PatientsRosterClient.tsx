"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type ClientRecord = {
  id: string;
  name: string;
  preferredName?: unknown;
  email?: unknown;
  phone?: unknown;
  status?: unknown;
  intakeStatus?: unknown;
  openBalance: number;
  updatedAt?: unknown;
};

type Payload = {
  success: boolean;
  error?: string;
  metrics?: { total: number; active: number; intakeIncomplete: number; withBalance: number };
  clients?: ClientRecord[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function formatMoney(value: number) {
  return Number(value ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function statusClass(value: unknown) {
  const status = String(value ?? "").toLowerCase();
  if (status.includes("active") || status.includes("complete")) return "status status-green";
  if (status.includes("inactive") || status.includes("incomplete")) return "status status-red";
  return "status status-yellow";
}

export default function PatientsRosterClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "deceased">("all");
  const [balanceFilter, setBalanceFilter] = useState<"all" | "with-balance">("all");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadClients(search = query) {
    if (!organizationId) {
      setError("Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      if (search.trim()) params.set("q", search.trim());
      const response = await fetch(`/api/clients?${params.toString()}`, { cache: "no-store" });
      const json = (await response.json()) as Payload;
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load clients");
      setPayload(json);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load clients");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadClients("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  const metrics = payload?.metrics ?? { total: 0, active: 0, intakeIncomplete: 0, withBalance: 0 };
  const clients = payload?.clients ?? [];
  const filteredClients = clients.filter((client) => {
    if (statusFilter !== "all" && String(client.status ?? "") !== statusFilter) return false;
    if (balanceFilter === "with-balance" && Number(client.openBalance ?? 0) <= 0) return false;
    return true;
  });
  const organizationQuery = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";

  function clientHref(clientId: string, path = "") {
    const base = `/clients/${clientId}${path}`;
    return organizationId ? `${base}${organizationQuery}` : base;
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Clients</p>
          <h1>Client Roster</h1>
          <p className="hero-copy">Master client list with chart entry, intake status, contact details, and balance visibility.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/clinician/agenda">Agenda</Link>
          <Link className="button button-secondary" href="/">Home</Link>
        </div>
      </section>

      <section className="toolbar-panel">
        <label className="field-label compact-field">
          Search clients
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, email, phone..." />
        </label>
        <label className="field-label compact-field">
          Status
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | "active" | "deceased")}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="deceased">Deceased</option>
          </select>
        </label>
        <label className="field-label compact-field">
          Balance
          <select value={balanceFilter} onChange={(event) => setBalanceFilter(event.target.value as "all" | "with-balance")}>
            <option value="all">All</option>
            <option value="with-balance">With Outstanding Balance</option>
          </select>
        </label>
        <button className="button" type="button" onClick={() => loadClients(query)}>Search</button>
        <button className="button button-secondary" type="button" onClick={() => { setQuery(""); setStatusFilter("all"); setBalanceFilter("all"); loadClients(""); }}>Clear</button>
        {!loading ? <span className="muted-text">Showing {filteredClients.length} of {clients.length} clients</span> : null}
      </section>

      {error ? <div className="alert-panel">{error}</div> : null}

      <section className="metric-grid">
        <article className="metric-card"><span>Total</span><strong>{loading ? "—" : metrics.total}</strong></article>
        <article className="metric-card"><span>Active</span><strong>{loading ? "—" : metrics.active}</strong></article>
        <article className="metric-card"><span>Intake Incomplete</span><strong>{loading ? "—" : metrics.intakeIncomplete}</strong></article>
        <article className="metric-card"><span>With Balance</span><strong>{loading ? "—" : metrics.withBalance}</strong></article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 style={{ margin: 0 }}>Roster</h2>
        </div>
        {loading ? <div className="empty-state">Loading clients…</div> : null}
        {!loading && filteredClients.length === 0 ? <div className="empty-state">No clients found for current filters.</div> : null}

        {filteredClients.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Intake</th>
                <th style={{ textAlign: "right" }}>Balance</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredClients.map((client) => (
                <tr key={client.id}>
                  <td>
                    <strong>{client.name}</strong>
                    {client.preferredName ? <span style={{ display: "block", color: "var(--muted)", fontSize: "12px" }}>Preferred: {String(client.preferredName)}</span> : null}
                  </td>
                  <td style={{ color: "var(--muted)", fontSize: "13px" }}>
                    <span style={{ display: "block" }}>{String(client.email ?? "No email")}</span>
                    <span style={{ display: "block" }}>{String(client.phone ?? "No phone")}</span>
                  </td>
                  <td><span className={statusClass(client.status)}>{String(client.status ?? "active")}</span></td>
                  <td><span className={statusClass(client.intakeStatus)}>{String(client.intakeStatus ?? "not set")}</span></td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatMoney(client.openBalance)}</td>
                  <td className="col-actions">
                    <div className="hero-actions">
                      <Link className="button button-secondary" href={clientHref(client.id)}>Chart</Link>
                      <Link className="button button-secondary" href={clientHref(client.id, "/appointments")}>Appointments</Link>
                      <Link className="button button-secondary" href={clientHref(client.id, "/notes")}>Notes</Link>
                      <Link className="button button-secondary" href={clientHref(client.id, "/eligibility")}>Eligibility</Link>
                      <Link className="button button-secondary" href={clientHref(client.id, "/claims")}>Claims</Link>
                      <Link className="button button-secondary" href={clientHref(client.id, "/balance")}>Balance</Link>
                      <Link className="button button-secondary" href={clientHref(client.id, "/documents")}>Documents</Link>
                      <Link className="button button-secondary" href={clientHref(client.id, "/workqueue")}>Workqueue</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </main>
  );
}
