"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type EligibilityState = {
  status: "none" | "active" | "inactive" | "pending" | "error" | "stale";
  checkedAt: string | null;
  daysSinceChecked: number | null;
  copayAmount: number | null;
  isStale: boolean;
};

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
  eligibility: EligibilityState;
  nextAppointmentAt: string | null;
  openWorkqueueCount: number;
  claimIssueCount: number;
};

type Metrics = {
  total: number;
  active: number;
  intakeIncomplete: number;
  withBalance: number;
  needsEligibility: number;
  staleEligibility: number;
  claimIssues: number;
  openWorkqueue: number;
};

type Payload = {
  success: boolean;
  error?: string;
  metrics?: Metrics;
  clients?: ClientRecord[];
};

type NeedsFilter =
  | "all"
  | "needs-eligibility"
  | "stale-eligibility"
  | "intake-incomplete"
  | "balance-due"
  | "claim-issues"
  | "open-workqueue";

function resolveOrganizationId(initialOrganizationId?: string): string {
  if (initialOrganizationId) return initialOrganizationId;
  if (typeof window !== "undefined") {
    const fromUrl = new URLSearchParams(window.location.search).get("organizationId");
    if (fromUrl) return fromUrl;
  }
  return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function formatMoney(value: number) {
  return Number(value ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function eligibilityBadge(state: EligibilityState) {
  const map: Record<EligibilityState["status"], { label: string; className: string }> = {
    none: { label: "Not checked", className: "status status-red" },
    active: { label: "Active", className: "status status-green" },
    inactive: { label: "Inactive", className: "status status-red" },
    pending: { label: "Pending", className: "status status-yellow" },
    error: { label: "Error", className: "status status-red" },
    stale: { label: `Stale (${state.daysSinceChecked ?? "?"}d)`, className: "status status-yellow" },
  };
  return map[state.status];
}

function intakeBadge(value: unknown) {
  const v = String(value ?? "not_started").toLowerCase();
  if (v === "complete") return { label: "Complete", className: "status status-green" };
  if (v === "in_progress" || v === "sent") return { label: "In progress", className: "status status-yellow" };
  return { label: "Not started", className: "status status-red" };
}

function statusBadge(value: unknown) {
  const v = String(value ?? "active").toLowerCase();
  if (v === "deceased") return { label: "Deceased", className: "status status-red" };
  return { label: "Active", className: "status status-green" };
}

export default function PatientsRosterClient({
  initialOrganizationId,
}: {
  initialOrganizationId?: string;
} = {}) {
  const organizationId = useMemo(
    () => resolveOrganizationId(initialOrganizationId),
    [initialOrganizationId],
  );
  const [query, setQuery] = useState("");
  const [needsFilter, setNeedsFilter] = useState<NeedsFilter>("all");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadClients(search = query) {
    if (!organizationId) {
      setError("Could not determine your organization. Please sign in again.");
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

  const metrics: Metrics = payload?.metrics ?? {
    total: 0, active: 0, intakeIncomplete: 0, withBalance: 0,
    needsEligibility: 0, staleEligibility: 0, claimIssues: 0, openWorkqueue: 0,
  };
  const clients = payload?.clients ?? [];
  const filteredClients = clients.filter((c) => {
    switch (needsFilter) {
      case "needs-eligibility": return c.eligibility.status === "none";
      case "stale-eligibility": return c.eligibility.status === "stale";
      case "intake-incomplete": return String(c.intakeStatus ?? "") !== "complete";
      case "balance-due":       return Number(c.openBalance ?? 0) > 0;
      case "claim-issues":      return c.claimIssueCount > 0;
      case "open-workqueue":    return c.openWorkqueueCount > 0;
      default:                  return true;
    }
  });
  const organizationQuery = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";

  function clientHref(clientId: string, path = "") {
    const base = `/clients/${clientId}${path}`;
    return organizationId ? `${base}${organizationQuery}` : base;
  }

  const chips: { key: NeedsFilter; label: string; count: number }[] = [
    { key: "all",                label: "All",                count: metrics.total },
    { key: "needs-eligibility",  label: "Needs eligibility",  count: metrics.needsEligibility },
    { key: "stale-eligibility",  label: "Stale eligibility",  count: metrics.staleEligibility },
    { key: "intake-incomplete",  label: "Intake incomplete",  count: metrics.intakeIncomplete },
    { key: "balance-due",        label: "Balance due",        count: metrics.withBalance },
    { key: "claim-issues",       label: "Claim issues",       count: metrics.claimIssues },
    { key: "open-workqueue",     label: "Has open WQ",        count: metrics.openWorkqueue },
  ];

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Patient Operations</p>
          <h1>Patient Operations Workspace</h1>
          <p className="hero-copy">
            One place to drive front-desk and billing work across every patient: intake, eligibility, balances,
            claim issues, and open workqueue items.
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/clinician/agenda">Agenda</Link>
          <Link className="button button-secondary" href="/">Home</Link>
        </div>
      </section>

      <section className="toolbar-panel">
        <label className="field-label compact-field" style={{ flex: 1, minWidth: 220 }}>
          Search
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") loadClients(query); }}
            placeholder="Name, email, phone..."
          />
        </label>
        <button className="button" type="button" onClick={() => loadClients(query)}>Search</button>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => { setQuery(""); setNeedsFilter("all"); loadClients(""); }}
        >
          Clear
        </button>
        {!loading ? <span className="muted-text">Showing {filteredClients.length} of {clients.length}</span> : null}
      </section>

      {error ? <div className="alert-panel">{error}</div> : null}

      <section
        className="panel"
        style={{ padding: "10px 12px", display: "flex", gap: 8, flexWrap: "wrap" }}
        aria-label="Operations filters"
      >
        {chips.map((chip) => {
          const active = needsFilter === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => setNeedsFilter(chip.key)}
              className={active ? "button" : "button button-secondary"}
              style={{ padding: "4px 10px", fontSize: 12 }}
            >
              {chip.label} ({loading ? "…" : chip.count})
            </button>
          );
        })}
      </section>

      <section className="metric-grid">
        <article className="metric-card"><span>Total</span><strong>{loading ? "—" : metrics.total}</strong></article>
        <article className="metric-card"><span>Needs Eligibility</span><strong>{loading ? "—" : metrics.needsEligibility}</strong></article>
        <article className="metric-card"><span>Stale Eligibility</span><strong>{loading ? "—" : metrics.staleEligibility}</strong></article>
        <article className="metric-card"><span>Intake Incomplete</span><strong>{loading ? "—" : metrics.intakeIncomplete}</strong></article>
        <article className="metric-card"><span>Balance Due</span><strong>{loading ? "—" : metrics.withBalance}</strong></article>
        <article className="metric-card"><span>Claim Issues</span><strong>{loading ? "—" : metrics.claimIssues}</strong></article>
        <article className="metric-card"><span>Open Workqueue</span><strong>{loading ? "—" : metrics.openWorkqueue}</strong></article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 style={{ margin: 0 }}>Roster</h2>
        </div>
        {loading ? <div className="empty-state">Loading patients…</div> : null}
        {!loading && filteredClients.length === 0 ? (
          <div className="empty-state">No patients match this filter.</div>
        ) : null}

        {filteredClients.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Intake</th>
                <th>Eligibility</th>
                <th>Next Visit</th>
                <th style={{ textAlign: "right" }}>Balance</th>
                <th style={{ textAlign: "right" }}>WQ</th>
                <th style={{ textAlign: "right" }}>Claim Issues</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredClients.map((client) => {
                const elig = eligibilityBadge(client.eligibility);
                const intake = intakeBadge(client.intakeStatus);
                const stat = statusBadge(client.status);
                return (
                  <tr key={client.id}>
                    <td>
                      <Link href={clientHref(client.id)} style={{ fontWeight: 600 }}>
                        {client.name}
                      </Link>
                      {client.preferredName ? (
                        <span style={{ display: "block", color: "var(--muted)", fontSize: 12 }}>
                          Preferred: {String(client.preferredName)}
                        </span>
                      ) : null}
                    </td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>
                      <span style={{ display: "block" }}>{String(client.email ?? "No email")}</span>
                      <span style={{ display: "block" }}>{String(client.phone ?? "No phone")}</span>
                    </td>
                    <td><span className={stat.className}>{stat.label}</span></td>
                    <td><span className={intake.className}>{intake.label}</span></td>
                    <td>
                      <span className={elig.className}>{elig.label}</span>
                      {client.eligibility.copayAmount !== null ? (
                        <span style={{ display: "block", color: "var(--muted)", fontSize: 11, marginTop: 2 }}>
                          Copay {formatMoney(client.eligibility.copayAmount)}
                        </span>
                      ) : null}
                    </td>
                    <td style={{ fontSize: 13 }}>{formatDateTime(client.nextAppointmentAt)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {client.openBalance > 0 ? (
                        <span style={{ color: "#b91c1c", fontWeight: 600 }}>{formatMoney(client.openBalance)}</span>
                      ) : (
                        formatMoney(client.openBalance)
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {client.openWorkqueueCount > 0 ? (
                        <Link href={clientHref(client.id, "/workqueue")} className="status status-yellow">
                          {client.openWorkqueueCount}
                        </Link>
                      ) : (
                        <span style={{ color: "var(--muted)" }}>0</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {client.claimIssueCount > 0 ? (
                        <Link href={clientHref(client.id, "/claims")} className="status status-red">
                          {client.claimIssueCount}
                        </Link>
                      ) : (
                        <span style={{ color: "var(--muted)" }}>0</span>
                      )}
                    </td>
                    <td className="col-actions">
                      <div className="hero-actions" style={{ gap: 4 }}>
                        <Link className="button button-secondary" href={clientHref(client.id)}>Chart</Link>
                        <Link className="button button-secondary" href={clientHref(client.id, "/eligibility")}>Eligibility</Link>
                        <Link className="button button-secondary" href={clientHref(client.id, "/balance")}>Balance</Link>
                        <Link className="button button-secondary" href={clientHref(client.id, "/claims")}>Claims</Link>
                        <Link className="button button-secondary" href={clientHref(client.id, "/workqueue")}>WQ</Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </section>
    </main>
  );
}
