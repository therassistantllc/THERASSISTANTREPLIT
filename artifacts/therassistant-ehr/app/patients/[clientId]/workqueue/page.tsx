"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

type WorkItem = {
  id: string;
  title: string | null;
  workType: string | null;
  status: string | null;
  priority: string | null;
  description: string | null;
  professionalClaimId: string | null;
  claimId: string | null;
  encounterId: string | null;
  appointmentId: string | null;
  deferredUntil: string | null;
  createdAt: string | null;
  synthetic?: boolean;
};

const QUEUE_LABELS: Record<string, string> = {
  clinician_routed_billing_review: "Billing review",
  era_exception: "ERA exceptions",
  claim_rejection: "Claim rejections",
  ar_aging: "AR aging",
  denials: "Denials",
  eligibility_issue: "Eligibility issues",
  provider_enrollment_issue: "Provider enrollment",
  compliance_audit: "Compliance audit",
};

const BILLING_WORK_TYPE = "clinician_routed_billing_review";

function queueLabel(workType: string | null) {
  if (!workType) return "Uncategorized";
  return QUEUE_LABELS[workType] ?? workType.replace(/_/g, " ");
}

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
  const params = useParams<{ clientId?: string; id?: string }>();
  const clientId = params?.clientId ?? params?.id ?? "";
  const searchParams = useSearchParams();
  const orgId = searchParams.get("organizationId") ?? process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "";

  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clientId || !orgId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/patients/${clientId}/workqueue?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      const json = (await r.json()) as { success: boolean; items?: WorkItem[]; error?: string };
      if (!json.success) throw new Error(json.error ?? "Failed");
      setItems(json.items ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [clientId, orgId]);

  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => {
    const open = items.filter((i) => String(i.status ?? "").toLowerCase() !== "closed");
    const byQueue = new Map<string, WorkItem[]>();
    for (const item of open) {
      const key = item.workType ?? "uncategorized";
      const arr = byQueue.get(key) ?? [];
      arr.push(item);
      byQueue.set(key, arr);
    }
    return Array.from(byQueue.entries()).sort((a, b) => queueLabel(a[0]).localeCompare(queueLabel(b[0])));
  }, [items]);

  async function routeToBill(item: WorkItem) {
    if (item.workType === BILLING_WORK_TYPE) return;
    setBusyId(item.id);
    setActionMessage(null);
    try {
      const r = await fetch(`/api/workqueue/items/${item.id}/route-to-bill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId }),
      });
      const json = (await r.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? "Route failed");
      setActionMessage("Item routed to the billing queue.");
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Route failed");
    } finally {
      setBusyId(null);
    }
  }

  const orgQ = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : "";
  const totalOpen = groups.reduce((sum, [, arr]) => sum + arr.length, 0);

  return (
    <main className="app-shell">
      <section className="page-header">
        <div>
          <p className="eyebrow">Client Chart</p>
          <h2>Workqueues for this client</h2>
          <p className="muted" style={{ marginTop: 4 }}>
            {totalOpen === 0 ? "No open workqueue items." : `${totalOpen} open item(s) across ${groups.length} queue(s).`}
          </p>
        </div>
      </section>

      {loading && <div className="empty-state">Loading workqueue…</div>}
      {error && <div className="alert-panel">{error}</div>}
      {actionMessage && <div className="empty-state success-panel">{actionMessage}</div>}

      {!loading && groups.length === 0 && !error && (
        <div className="empty-state">This client is not in any open workqueue.</div>
      )}

      {groups.map(([workType, rows]) => (
        <section className="panel" key={workType} style={{ marginBottom: 16 }}>
          <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>
              {queueLabel(workType)} <span className="muted" style={{ fontWeight: 400 }}>({rows.length})</span>
            </h3>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Created</th>
                <th>Linked</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const alreadyBilling = item.workType === BILLING_WORK_TYPE;
                return (
                  <tr key={item.id}>
                    <td>
                      <div>
                        <strong>{item.title ?? "Untitled"}</strong>
                        {item.description && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            {item.description.slice(0, 140)}{item.description.length > 140 ? "…" : ""}
                          </div>
                        )}
                      </div>
                    </td>
                    <td><span className={statusClass(item.status)}>{item.status ?? "—"}</span></td>
                    <td>{item.priority ? <span className={priorityClass(item.priority)}>{item.priority}</span> : "—"}</td>
                    <td>{formatDate(item.createdAt)}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {item.encounterId && (
                          <Link className="inline-link" href={`/encounters/${item.encounterId}${orgQ}`}>Encounter</Link>
                        )}
                        {item.professionalClaimId && (
                          <Link className="inline-link" href={`/billing/claims/${item.professionalClaimId}${orgQ}`}>Claim</Link>
                        )}
                      </div>
                    </td>
                    <td>
                      {item.synthetic ? (
                        <Link
                          className="inline-link"
                          href={`/billing/charge-capture${orgQ}`}
                          title="Resolve blockers in Charge Capture"
                        >
                          Open Charge Capture
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={alreadyBilling || busyId === item.id}
                          title={alreadyBilling ? "Already in billing queue" : "Route to billing review queue"}
                          onClick={() => void routeToBill(item)}
                        >
                          {busyId === item.id ? "Routing…" : alreadyBilling ? "In billing queue" : "Route to bill"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}
