"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type WorkItem = {
  id: string;
  title: string | null;
  workType: string | null;
  status: string | null;
  priority: string | null;
  description: string | null;
  professionalClaimId: string | null;
  encounterId: string | null;
  appointmentId: string | null;
  deferredUntil: string | null;
  createdAt: string | null;
};

function formatDate(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

function priorityClass(v: string | null | undefined) {
  const s = String(v ?? "").toLowerCase();
  if (s === "high" || s === "urgent" || s === "critical") return "status status-red";
  if (s === "medium" || s === "normal") return "status status-yellow";
  return "status";
}

function statusClass(v: string | null | undefined) {
  const s = String(v ?? "").toLowerCase();
  if (s === "resolved" || s === "closed") return "status status-green";
  if (s === "blocked") return "status status-red";
  if (s === "in_progress") return "status status-yellow";
  return "status";
}

export default function ClientWorkqueuePage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params?.clientId ?? "";
  const searchParams = useSearchParams();
  const orgId = searchParams.get("organizationId") ?? process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "";

  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId || !orgId) return;
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/patients/${clientId}/workqueue?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
        const json = await r.json() as { success: boolean; items?: WorkItem[]; error?: string };
        if (cancelled) return;
        if (!json.success) throw new Error(json.error ?? "Failed");
        setItems(json.items ?? []);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [clientId, orgId]);

  const orgQ = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : "";

  return (
    <main className="app-shell">
      <section className="page-header">
        <div>
          <p className="eyebrow">Client Chart</p>
          <h2>Workqueue Items</h2>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href={`/workqueue${orgQ}`}>All Workqueue</Link>
        </div>
      </section>

      {loading && <div className="empty-state">Loading workqueue…</div>}
      {error && <div className="alert-panel">{error}</div>}

      {!loading && items.length === 0 && !error && (
        <div className="empty-state">No open workqueue items for this client.</div>
      )}

      {items.length > 0 && (
        <section className="panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Created</th>
                <th>Deferred Until</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div>
                      <strong>{item.title ?? "Untitled"}</strong>
                      {item.description && (
                        <div className="muted" style={{ fontSize: "12px" }}>
                          {item.description.slice(0, 100)}{item.description.length > 100 ? "…" : ""}
                        </div>
                      )}
                    </div>
                  </td>
                  <td>{item.workType ?? "—"}</td>
                  <td><span className={statusClass(item.status)}>{item.status ?? "—"}</span></td>
                  <td>{item.priority ? <span className={priorityClass(item.priority)}>{item.priority}</span> : "—"}</td>
                  <td>{formatDate(item.createdAt)}</td>
                  <td>{item.deferredUntil ? formatDate(item.deferredUntil) : "—"}</td>
                  <td>
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      <Link className="button button-secondary" href={`/workqueue?item=${item.id}${orgId ? `&organizationId=${orgId}` : ""}`}>
                        Open
                      </Link>
                      {item.encounterId && (
                        <Link className="inline-link" href={`/encounters/${item.encounterId}${orgQ}`}>
                          Encounter
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
