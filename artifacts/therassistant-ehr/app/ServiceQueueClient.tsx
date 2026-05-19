"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type QueueItem = {
  id: string;
  title: string;
  workType: string;
  priority: string;
  status: string;
  clientId: string;
  client: { firstName: string; lastName: string } | null;
  createdAt: string;
};

type WorkqueueResponse = {
  success?: boolean;
  items?: QueueItem[];
  counts?: { total: number; byWorkType: Record<string, number> };
};

type CommandCenterResponse = {
  success?: boolean;
  metrics?: { appointmentsToday?: number };
  devFallback?: boolean;
};

type MailroomResponse = {
  success?: boolean;
  items?: unknown[];
};

const ORG_ID = process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "11111111-1111-1111-1111-111111111111";

export default function ServiceQueueClient() {
  const orgId = useMemo(() => ORG_ID, []);

  const [query, setQuery] = useState("");
  const [workqueue, setWorkqueue] = useState<WorkqueueResponse | null>(null);
  const [agenda, setAgenda] = useState<CommandCenterResponse | null>(null);
  const [mailroomCount, setMailroomCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const org = encodeURIComponent(orgId);
    Promise.all([
      fetch(`/api/workqueue/items?organizationId=${org}&status=active&limit=100`).then((r) => r.json() as Promise<WorkqueueResponse>),
      fetch(`/api/clinician/command-center?organizationId=${org}`).then((r) => r.json() as Promise<CommandCenterResponse>),
      fetch(`/api/mailroom/items?organizationId=${org}&status=needs_review&limit=50`).then((r) => r.json() as Promise<MailroomResponse>),
    ])
      .then(([wq, cmd, mail]) => {
        setWorkqueue(wq);
        setAgenda(cmd);
        setMailroomCount((mail?.items ?? []).length);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orgId]);

  const wqCounts = workqueue?.counts?.byWorkType ?? {};
  const totalItems = workqueue?.counts?.total ?? 0;
  const appointmentsToday = agenda?.metrics?.appointmentsToday ?? 0;
  const items = workqueue?.items ?? [];

  const tiles = [
    {
      label: "Today's Appointments",
      count: appointmentsToday,
      href: "/clinician/agenda",
      accent: "var(--navy)",
    },
    {
      label: "Eligibility Needed",
      count: wqCounts["eligibility_check"] ?? 0,
      href: "/billing/workqueue?workType=eligibility_check",
      accent: "#5e8a6a",
    },
    {
      label: "Charge Capture",
      count: (wqCounts["claim_readiness"] ?? 0) + (wqCounts["claim_review"] ?? 0),
      href: "/billing/charge-capture",
      accent: "#2e6da4",
    },
    {
      label: "No Response",
      count: wqCounts["claim_no_response"] ?? 0,
      href: "/billing/workqueue?workType=claim_no_response",
      accent: "#a04020",
    },
    {
      label: "Denials / Rejections",
      count: (wqCounts["claim_denial"] ?? 0) + (wqCounts["denial_appeal"] ?? 0),
      href: "/billing/workqueue?workType=claim_denial",
      accent: "#c05030",
    },
    {
      label: "Mail Room",
      count: mailroomCount,
      href: "/mailroom",
      accent: "#4a7096",
    },
    {
      label: "Payments / ERA",
      count:
        (wqCounts["era_mismatch"] ?? 0) +
        (wqCounts["era_review"] ?? 0) +
        (wqCounts["payment_review"] ?? 0),
      href: "/billing/workqueue?workType=era_mismatch",
      accent: "#1e5e40",
    },
    {
      label: "Billing Alerts",
      count: totalItems,
      href: "/billing/workqueue",
      accent: "#6a3a8a",
    },
  ];

  const filteredItems = query
    ? items.filter((item) =>
        [item.title, item.workType, item.client?.firstName, item.client?.lastName, item.clientId]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
    : items.slice(0, 10);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">THERASSISTANT</p>
          <h1>Service Queue</h1>
          <p className="hero-copy">
            Daily billing and clinical operations. Route work, verify eligibility, manage claims,
            and review mail.
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button" href="/clinician/agenda">
            Open Calendar
          </Link>
          <Link className="button button-secondary" href="/billing/workqueue">
            Route to Biller
          </Link>
        </div>
      </section>

      <section className="toolbar-panel">
        <label className="field-label compact-field" style={{ flex: 1, maxWidth: "100%" }}>
          <span className="sr-only">Search</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by client, claim, payer, work type, or workqueue item…"
          />
        </label>
        {query && (
          <button className="button button-secondary" type="button" onClick={() => setQuery("")}>
            Clear
          </button>
        )}
      </section>

      <section
        className="metric-grid"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}
      >
        {tiles.map((tile) => (
          <Link key={tile.label} href={tile.href} style={{ textDecoration: "none" }}>
            <article
              className="metric-card"
              style={{ borderTopColor: tile.accent, cursor: "pointer" }}
            >
              <span>{tile.label}</span>
              <strong style={{ fontSize: "2rem" }}>{loading ? "—" : tile.count}</strong>
            </article>
          </Link>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>{query ? `Search results for "${query}"` : "Active Work Items"}</h2>
          <Link className="button button-secondary" href="/billing/workqueue">
            View All
          </Link>
        </div>

        {loading && <div className="empty-state">Loading queue…</div>}
        {!loading && filteredItems.length === 0 && (
          <div className="empty-state">
            {query ? `No items matching "${query}".` : "No active work items."}
          </div>
        )}

        {filteredItems.length > 0 && (
          <div className="stack-list">
            {filteredItems.map((item) => (
              <article className="stack-item" key={item.id}>
                <div className="stack-row">
                  <div>
                    <strong>{item.title}</strong>
                    <span>
                      {item.workType} · {item.priority} · {item.status}
                    </span>
                    {item.client && (
                      <span>
                        {item.client.firstName} {item.client.lastName}
                      </span>
                    )}
                  </div>
                  <Link
                    className="button button-secondary"
                    href={`/billing/workqueue?selected=${item.id}`}
                  >
                    Review
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
