"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type WorkqueueClientInfo = {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
} | null;

type WorkqueueItem = {
  id: string;
  title: string;
  description: string;
  workType: string;
  status: string;
  priority: string;
  clientId: string;
  appointmentId: string;
  encounterId: string;
  claimId: string;
  professionalClaimId: string;
  assignedToUserId: string;
  deferredUntil: string;
  deferReason: string;
  createdAt: string;
  updatedAt: string;
  contextPayload: unknown;
  client: WorkqueueClientInfo;
};

type WorkqueueResponse = {
  success?: boolean;
  items?: WorkqueueItem[];
  counts?: {
    total: number;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    byWorkType: Record<string, number>;
  };
  error?: string;
};

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function formatDate(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function patientName(client: WorkqueueClientInfo) {
  if (!client) return "No patient linked";
  return [client.firstName, client.lastName].filter(Boolean).join(" ") || "Patient";
}

export default function WorkqueueClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [status, setStatus] = useState("active");
  const [workType, setWorkType] = useState("");
  const [items, setItems] = useState<WorkqueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [counts, setCounts] = useState<WorkqueueResponse["counts"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [deferDays, setDeferDays] = useState("3");
  const [acting, setActing] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [claimStatusResult, setClaimStatusResult] = useState<string | null>(null);
  const [claimStatusChecking, setClaimStatusChecking] = useState(false);

  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const byStatus = counts?.byStatus ?? {};
  const openCount = (byStatus.open ?? 0) + (byStatus.in_progress ?? 0) + (byStatus.blocked ?? 0);
  const deferredCount = byStatus.deferred ?? 0;
  const resolvedCount = byStatus.resolved ?? 0;

  async function loadItems() {
    if (!organizationId) {
      setError("Missing NEXT_PUBLIC_ORGANIZATION_ID.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ organizationId, status });
    if (workType) params.set("workType", workType);
    const response = await fetch(`/api/workqueue/items?${params.toString()}`);
    const json = (await response.json()) as WorkqueueResponse;
    if (!response.ok || !json.success) {
      setError(json.error || "Failed to load workqueue.");
      setItems([]);
      setCounts(null);
    } else {
      setItems(json.items || []);
      setCounts(json.counts || null);
      setSelectedId((current) => current && (json.items || []).some((item) => item.id === current) ? current : (json.items || [])[0]?.id ?? null);
    }
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, status, workType]);

  async function runAction(action: "comment" | "defer" | "resolve" | "close") {
    if (!selected) return;
    setActing(true);
    setError(null);
    setActionFeedback(null);

    const deferredUntil = new Date(Date.now() + Math.max(Number(deferDays) || 1, 1) * 24 * 60 * 60 * 1000).toISOString();
    const response = await fetch("/api/workqueue/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        organizationId,
        workqueueItemId: selected.id,
        comment,
        deferredUntil: action === "defer" ? deferredUntil : undefined,
        deferReason: action === "defer" ? comment || `Deferred for ${deferDays} days` : undefined,
      }),
    });

    const json = (await response.json()) as { ok?: boolean; success?: boolean; error?: string; errors?: Array<{ message: string }> };
    if (!response.ok || (!json.ok && !json.success)) {
      const msg = json.errors?.[0]?.message || json.error || "Workqueue action failed.";
      setActionFeedback({ type: "error", message: msg });
    } else {
      setComment("");
      setActionFeedback({ type: "success", message: `Action "${action}" completed successfully.` });
      await loadItems();
    }
    setActing(false);
  }

  async function checkClaimStatus(item: WorkqueueItem) {
    if (!item.claimId || !item.clientId) return;
    setClaimStatusChecking(true);
    setClaimStatusResult(null);
    try {
      const response = await fetch("/api/clearinghouse/office-ally/claim-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          clientId: item.clientId,
          claimId: item.claimId,
          request: null,
        }),
      });
      const json = (await response.json()) as { success: boolean; error?: string };
      setClaimStatusResult(json.success ? "Claim status submitted" : (json.error ?? "Claim status check failed"));
    } catch {
      setClaimStatusResult("Claim status check failed");
    } finally {
      setClaimStatusChecking(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Billing/Admin Workqueue</p>
          <h1>Resolve routed revenue-cycle work</h1>
          <p className="hero-copy">Manage eligibility issues, claim rejections, ERA exceptions, denials, recoupments, and clinician-routed questions.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/clinician/agenda">Clinician Agenda</Link>
          <Link className="button button-secondary" href="/calendar">Calendar</Link>
        </div>
      </section>

      <section className="toolbar-panel">
        <label className="field-label compact-field">
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="active">Active</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="deferred">Deferred</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="field-label compact-field">
          Queue
          <select value={workType} onChange={(event) => setWorkType(event.target.value)}>
            <option value="">All Queues</option>
            <optgroup label="AR Aging">
              <option value="no_response">No Response</option>
              <option value="aging_0_30">0–30 Days</option>
              <option value="aging_31_60">31–60 Days</option>
              <option value="aging_61_90">61–90 Days</option>
              <option value="aging_91_120">91–120 Days</option>
              <option value="aging_120_plus">120+ Days</option>
            </optgroup>
            <optgroup label="Payer Response">
              <option value="denied">Denied</option>
              <option value="clearinghouse_rejection">Clearinghouse Rejection</option>
              <option value="payer_rejection">Payer Rejection</option>
              <option value="appeal_needed">Appeal Needed</option>
              <option value="recoupment">Recoupment</option>
            </optgroup>
            <optgroup label="Eligibility">
              <option value="eligibility_issue">Eligibility Issue</option>
              <option value="eligibility_needed">Eligibility Needed</option>
            </optgroup>
            <optgroup label="ERA">
              <option value="era_mismatch">ERA Mismatch</option>
              <option value="era_unmatched_claim">ERA Unmatched Claim</option>
              <option value="era_recoupment_review">ERA Recoupment Review</option>
            </optgroup>
            <optgroup label="Billing">
              <option value="ready_to_bill">Ready to Bill</option>
              <option value="biller_review">Biller Review</option>
            </optgroup>
          </select>
        </label>
        <button className="button button-secondary" type="button" onClick={() => void loadItems()} disabled={loading}>Refresh</button>
        {counts ? <span className="muted-text">{counts.total} item(s)</span> : null}
      </section>

      {error ? <div className="alert-panel">{error}</div> : null}
      {loading ? <div className="empty-state">Loading workqueue…</div> : null}

      <section className="metric-grid">
        <article className="metric-card">
          <span>Open</span>
          <strong>{loading ? "-" : openCount}</strong>
        </article>
        <article className="metric-card">
          <span>Deferred</span>
          <strong>{loading ? "-" : deferredCount}</strong>
        </article>
        <article className="metric-card">
          <span>Resolved</span>
          <strong>{loading ? "-" : resolvedCount}</strong>
        </article>
        <article className="metric-card">
          <span>Total Returned</span>
          <strong>{loading ? "-" : counts?.total ?? 0}</strong>
        </article>
      </section>

      <section className="workqueue-layout">
        <div className="workqueue-list panel">
          {items.length === 0 && !loading ? <div className="empty-state">No workqueue items found.</div> : null}
          {items.map((item) => (
            <button key={item.id} className={`workqueue-list-item ${selected?.id === item.id ? "selected" : ""}`} type="button" onClick={() => setSelectedId(item.id)}>
              <span className={`status-pill ${item.priority || "normal"}`}>{item.priority || "normal"}</span>
              <strong>{item.title}</strong>
              <span>{patientName(item.client)}</span>
              <span>{item.workType || "workqueue"}</span>
              <span>{formatDate(item.createdAt)}</span>
            </button>
          ))}
        </div>

        <div className="workqueue-detail panel">
          {!selected ? <div className="empty-state">Select a workqueue item.</div> : null}
          {selected ? (
            <>
              <div className="detail-header">
                <div>
                  <p className="eyebrow">{selected.workType || "Workqueue"}</p>
                  <h2>{selected.title}</h2>
                  <p className="muted-text">{patientName(selected.client)} · {selected.status || "open"}</p>
                </div>
                <span className={`status-pill ${selected.priority || "normal"}`}>{selected.priority || "normal"}</span>
              </div>

              <div className="detail-list">
                <p><strong>Description:</strong> {selected.description || "—"}</p>
                <p><strong>Created:</strong> {formatDate(selected.createdAt)}</p>
                <p><strong>Updated:</strong> {formatDate(selected.updatedAt)}</p>
                <p><strong>Claim ID:</strong> {selected.claimId || "—"}</p>
                <p><strong>Professional Claim:</strong>{" "}
                  {selected.professionalClaimId
                    ? <Link className="inline-link" href={`/billing/charge-capture?organizationId=${organizationId}`}>{selected.professionalClaimId}</Link>
                    : "—"}
                </p>
                <p><strong>Encounter ID:</strong> {selected.encounterId || "—"}</p>
                <p><strong>Appointment ID:</strong> {selected.appointmentId || "—"}</p>
              </div>

              <div className="section-actions">
                {selected.clientId ? <Link className="button button-secondary" href={`/clients/${selected.clientId}`}>Open Chart</Link> : null}
                {selected.encounterId ? <Link className="button button-secondary" href={`/encounters/${selected.encounterId}`}>Open Encounter</Link> : null}
                {selected.claimId && selected.clientId ? (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={claimStatusChecking}
                    onClick={() => void checkClaimStatus(selected)}
                  >
                    {claimStatusChecking ? "Checking…" : "Check Claim Status"}
                  </button>
                ) : null}
              </div>
              {claimStatusResult ? <p className="muted-text">{claimStatusResult}</p> : null}
              {actionFeedback ? (
                <div className={actionFeedback.type === "error" ? "alert-panel" : "alert-panel alert-panel-success"}>
                  {actionFeedback.message}
                </div>
              ) : null}

              <label className="field-label">
                Comment / action note
                <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add action note..." />
              </label>

              <label className="field-label compact-field">
                Defer days
                <input value={deferDays} onChange={(event) => setDeferDays(event.target.value)} />
              </label>

              <div className="section-actions">
                <button className="button button-secondary" type="button" onClick={() => void runAction("comment")} disabled={acting || !comment.trim()}>Add Comment</button>
                <button className="button button-secondary" type="button" onClick={() => void runAction("defer")} disabled={acting}>Defer</button>
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
