"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type WorkqueueClientInfo = {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
} | null;

type InboxItem = {
  id: string;
  title: string;
  description: string;
  workType: string;
  status: string;
  priority: string;
  clientId: string;
  appointmentId: string;
  encounterId: string;
  assignedToUserId: string;
  createdAt: string;
  updatedAt: string;
  client: WorkqueueClientInfo;
};

type Response = {
  success?: boolean;
  items?: InboxItem[];
  counts?: { total: number; byStatus: Record<string, number>; byWorkType: Record<string, number> };
  error?: string;
};

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
  return new URLSearchParams(window.location.search).get("organizationId")
    || process.env.NEXT_PUBLIC_ORGANIZATION_ID
    || DEFAULT_ORG_ID;
}

function patientName(c: WorkqueueClientInfo) {
  if (!c) return "No patient linked";
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "Patient";
}

function formatDate(value: string) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

const WORK_TYPE_LABELS: Record<string, string> = {
  documentation_needed: "Documentation needed",
  signature_needed: "Signature needed",
  chart_question: "Chart question",
  clinician_review: "Clinician review",
  clinician_routed_question: "Question routed to clinician",
  note_cosign_needed: "Note co-sign needed",
};

export default function InboxClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [status, setStatus] = useState("active");
  const [workTypeFilter, setWorkTypeFilter] = useState("");
  const [items, setItems] = useState<InboxItem[]>([]);
  const [counts, setCounts] = useState<Response["counts"] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [acting, setActing] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const selected = items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  async function loadItems() {
    if (!organizationId) {
      setError("Missing organization id.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ organizationId, status, audience: "clinician" });
    if (workTypeFilter) params.set("workType", workTypeFilter);
    const response = await fetch(`/api/workqueue/items?${params.toString()}`, { cache: "no-store" });
    const json = (await response.json()) as Response;
    if (!response.ok || !json.success) {
      setError(json.error || "Failed to load inbox.");
      setItems([]);
      setCounts(null);
    } else {
      const next = json.items || [];
      setItems(next);
      setCounts(json.counts || null);
      setSelectedId((cur) => (cur && next.some((i) => i.id === cur)) ? cur : (next[0]?.id ?? null));
    }
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, status, workTypeFilter]);

  async function runAction(action: "comment" | "resolve" | "close") {
    if (!selected) return;
    setActing(true);
    setActionFeedback(null);

    const response = await fetch("/api/workqueue/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        organizationId,
        workqueueItemId: selected.id,
        comment,
      }),
    });

    const json = (await response.json()) as {
      ok?: boolean; success?: boolean; error?: string;
      errors?: Array<{ message: string }>;
      result?: { ok?: boolean; errors?: Array<{ message: string }> };
    };

    const succeeded = response.ok && (json.ok ?? json.success ?? json.result?.ok) === true;
    if (!succeeded) {
      const msg = json.result?.errors?.[0]?.message || json.errors?.[0]?.message || json.error || "Action failed.";
      setActionFeedback({ type: "error", message: msg });
    } else {
      setComment("");
      setActionFeedback({ type: "success", message: `Action "${action}" completed.` });
      const terminal = action === "resolve" || action === "close";
      if (terminal && (status === "active" || status === "open" || status === "in_progress")) {
        const removedId = selected.id;
        setItems((prev) => prev.filter((i) => i.id !== removedId));
        setSelectedId((cur) => (cur === removedId ? null : cur));
      }
      await loadItems();
    }
    setActing(false);
  }

  const byStatus = counts?.byStatus ?? {};
  const openCount = (byStatus.open ?? 0) + (byStatus.in_progress ?? 0) + (byStatus.blocked ?? 0);
  const deferredCount = byStatus.deferred ?? 0;
  const resolvedCount = byStatus.resolved ?? 0;
  const byType = counts?.byWorkType ?? {};

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Clinician Inbox</p>
          <h1>Your inbox</h1>
          <p className="hero-copy">
            Clinical-only items: documentation, signatures, co-signs, chart questions, and items routed to you for
            clinical review. Operations work (eligibility, denials, AR, ERA) lives in Billing &gt; Workqueues.
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/calendar">Schedule</Link>
          <Link className="button button-secondary" href="/workqueue">Operations Workqueues</Link>
        </div>
      </section>

      <section className="toolbar-panel">
        <label className="field-label compact-field">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="field-label compact-field">
          Type
          <select value={workTypeFilter} onChange={(e) => setWorkTypeFilter(e.target.value)}>
            <option value="">All clinician items</option>
            {Object.entries(WORK_TYPE_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
        <button className="button button-secondary" type="button" onClick={() => void loadItems()} disabled={loading}>Refresh</button>
        {counts ? <span className="muted-text">{counts.total} item(s)</span> : null}
      </section>

      {error ? <div className="alert-panel">{error}</div> : null}

      <section className="metric-grid">
        <article className="metric-card"><span>Open</span><strong>{loading ? "—" : openCount}</strong></article>
        <article className="metric-card"><span>Deferred</span><strong>{loading ? "—" : deferredCount}</strong></article>
        <article className="metric-card"><span>Resolved</span><strong>{loading ? "—" : resolvedCount}</strong></article>
        <article className="metric-card"><span>Total</span><strong>{loading ? "—" : counts?.total ?? 0}</strong></article>
      </section>

      {Object.keys(byType).length > 0 ? (
        <section className="panel" style={{ padding: "10px 12px", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className={workTypeFilter === "" ? "button" : "button button-secondary"}
            style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={() => setWorkTypeFilter("")}
          >
            All ({counts?.total ?? 0})
          </button>
          {Object.entries(byType).map(([key, count]) => (
            <button
              key={key}
              type="button"
              className={workTypeFilter === key ? "button" : "button button-secondary"}
              style={{ padding: "4px 10px", fontSize: 12 }}
              onClick={() => setWorkTypeFilter(key)}
            >
              {WORK_TYPE_LABELS[key] ?? key} ({count})
            </button>
          ))}
        </section>
      ) : null}

      <section className="workqueue-layout">
        <div className="workqueue-list panel">
          {loading ? <div className="empty-state">Loading…</div> : null}
          {!loading && items.length === 0 ? (
            <div className="empty-state">Inbox zero. Nothing needs your clinical attention.</div>
          ) : null}
          {items.map((item) => (
            <div
              key={item.id}
              className={`workqueue-list-item-row ${selected?.id === item.id ? "selected" : ""}`}
            >
              <button
                className="workqueue-list-item"
                type="button"
                onClick={() => setSelectedId(item.id)}
              >
                <span className={`status-pill ${item.priority || "normal"}`}>{item.priority || "normal"}</span>
                <strong>{item.title}</strong>
                <span>{patientName(item.client)}</span>
                <span>{WORK_TYPE_LABELS[item.workType] ?? item.workType}</span>
                <span>{formatDate(item.createdAt)}</span>
              </button>
            </div>
          ))}
        </div>

        <div className="workqueue-detail panel">
          {!selected ? <div className="empty-state">Select an inbox item.</div> : null}
          {selected ? (
            <>
              <div className="detail-header">
                <div>
                  <p className="eyebrow">{WORK_TYPE_LABELS[selected.workType] ?? selected.workType}</p>
                  <h2>{selected.title}</h2>
                  <p className="muted-text">{patientName(selected.client)} · {selected.status || "open"}</p>
                </div>
                <span className={`status-pill ${selected.priority || "normal"}`}>{selected.priority || "normal"}</span>
              </div>

              <div className="detail-list">
                <p><strong>Description:</strong> {selected.description || "—"}</p>
                <p><strong>Created:</strong> {formatDate(selected.createdAt)}</p>
                <p><strong>Updated:</strong> {formatDate(selected.updatedAt)}</p>
                <p><strong>Encounter:</strong> {selected.encounterId || "—"}</p>
                <p><strong>Appointment:</strong> {selected.appointmentId || "—"}</p>
              </div>

              <div className="section-actions">
                {selected.clientId ? <Link className="button button-secondary" href={`/clients/${selected.clientId}`}>Open Chart</Link> : null}
                {selected.encounterId ? <Link className="button button-secondary" href={`/encounters/${selected.encounterId}`}>Open Encounter</Link> : null}
                {selected.encounterId ? <Link className="button button-secondary" href={`/encounters/${selected.encounterId}/notes`}>Open Note</Link> : null}
              </div>

              {actionFeedback ? (
                <div className={actionFeedback.type === "error" ? "alert-panel" : "alert-panel alert-panel-success"}>
                  {actionFeedback.message}
                </div>
              ) : null}

              <label className="field-label">
                Comment
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a clinical note about this item…" />
              </label>

              <div className="section-actions">
                <button className="button button-secondary" type="button" onClick={() => void runAction("comment")} disabled={acting || !comment.trim()}>Add Comment</button>
                <button className="button" type="button" onClick={() => void runAction("resolve")} disabled={acting}>Resolve</button>
                <button className="button button-secondary" type="button" onClick={() => void runAction("close")} disabled={acting}>Close</button>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
