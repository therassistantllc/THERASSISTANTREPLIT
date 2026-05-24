"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type TimelineEvent = {
  id: string;
  at: string;
  kind: "submission" | "status" | "response";
  severity: "info" | "success" | "warning" | "error";
  title: string;
  detail: string;
  claimId: string;
  claimNumber: string;
};

type Exception = {
  id: string;
  claimId: string;
  claimNumber: string;
  itemStatus: string;
  priority: string;
  carcCode: string;
  rarcCode: string;
  groupCode: string;
  denialReason: string;
  actionTaken: string;
  createdAt: string;
};

type Acknowledgement = {
  id: string;
  type: string;
  fileName: string;
  receivedAt: string;
  parsed: unknown;
};

type ClaimRow = {
  id: string;
  patientId: string;
  patientName: string;
  claimNumber: string;
  status: string;
  totalCharge: number;
  submittedAt: string;
  acceptedAt: string;
  deniedAt: string;
};

type BatchHeader = {
  id: string;
  batchNumber: string;
  status: string;
  claimCount: number;
  totalCharge: number;
  generatedFileName: string;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
};

type Payload = {
  success: boolean;
  error?: string;
  batch?: BatchHeader;
  claims?: ClaimRow[];
  timeline?: TimelineEvent[];
  exceptions?: Exception[];
  acknowledgements?: Acknowledgement[];
  counts?: { claims: number; events: number; exceptions: number; acks999: number; acks277ca: number };
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return new URLSearchParams(window.location.search).get("organizationId")
    || process.env.NEXT_PUBLIC_ORGANIZATION_ID
    || DEFAULT_ORG_ID;
}

function formatDateTime(value: string) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function formatMoney(value: number) {
  return Number(value ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function severityColor(s: TimelineEvent["severity"]) {
  if (s === "error") return "#DC2626";
  if (s === "warning") return "#D97706";
  if (s === "success") return "#059669";
  return "#2563EB";
}

function batchStatusClass(status: string) {
  const s = (status || "").toLowerCase();
  if (s.includes("accepted") || s.includes("submitted") || s.includes("generated")) return "status status-green";
  if (s.includes("rejected") || s.includes("failed")) return "status status-red";
  return "status status-yellow";
}

export default function BatchDetailClient({ batchId }: { batchId: string }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeAckId, setActiveAckId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/batches/${encodeURIComponent(batchId)}?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
      const json = (await res.json()) as Payload;
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to load batch.");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load batch.");
    } finally {
      setLoading(false);
    }
  }, [batchId, organizationId]);

  useEffect(() => { void load(); }, [load]);

  const batch = data?.batch;
  const claims = data?.claims ?? [];
  const timeline = data?.timeline ?? [];
  const exceptions = data?.exceptions ?? [];
  const acks = data?.acknowledgements ?? [];
  const counts = data?.counts;

  if (loading && !data) {
    return <main className="app-shell"><div className="empty-state">Loading batch…</div></main>;
  }
  if (error || !batch) {
    return (
      <main className="app-shell">
        <div className="alert-panel">{error || "Batch not found."}</div>
        <Link className="inline-link" href="/billing/837p-batches">Back to batches</Link>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">
            Billing · <Link className="inline-link" href="/billing/837p-batches">837P batches</Link>
          </p>
          <h1>Batch {batch.batchNumber || batch.id.slice(0, 8)}</h1>
          <p className="hero-copy">
            <span className={batchStatusClass(batch.status)}>{batch.status || "no status"}</span>
            {" · "}{batch.claimCount} claim(s) · {formatMoney(batch.totalCharge)}
            {batch.submittedAt ? ` · submitted ${formatDateTime(batch.submittedAt)}` : " · not yet submitted"}
          </p>
          {batch.generatedFileName ? <p className="muted-text">File: {batch.generatedFileName}</p> : null}
        </div>
        <div className="hero-actions">
          <button className="button button-secondary" type="button" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
          <a
            className="button button-secondary"
            href={`/api/claims/837p/batch/${encodeURIComponent(batch.id)}/file?organizationId=${encodeURIComponent(organizationId)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Export 837P
          </a>
        </div>
      </section>

      <section className="metric-grid">
        <article className="metric-card"><span>Claims</span><strong>{counts?.claims ?? claims.length}</strong></article>
        <article className="metric-card"><span>Timeline events</span><strong>{counts?.events ?? timeline.length}</strong></article>
        <article className="metric-card"><span>Open exceptions</span><strong>{counts?.exceptions ?? exceptions.length}</strong></article>
        <article className="metric-card"><span>999 acks</span><strong>{counts?.acks999 ?? 0}</strong></article>
        <article className="metric-card"><span>277CA acks</span><strong>{counts?.acks277ca ?? 0}</strong></article>
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Acknowledgements</h2>
        {acks.length === 0 ? (
          <div className="empty-state">No 999 or 277CA received yet. They appear here once the clearinghouse posts them.</div>
        ) : (
          <div className="stack-list">
            {acks.map((a) => (
              <article key={a.id} className="stack-item">
                <div className="stack-row">
                  <div>
                    <strong>{a.type}</strong>
                    <span>{a.fileName || "(no file name)"} · received {formatDateTime(a.receivedAt)}</span>
                  </div>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setActiveAckId((cur) => cur === a.id ? null : a.id)}
                  >
                    {activeAckId === a.id ? "Hide parsed" : "Show parsed"}
                  </button>
                </div>
                {activeAckId === a.id && a.parsed ? (
                  <pre style={{ background: "#F8FAFC", padding: 10, borderRadius: 6, fontSize: 12, overflow: "auto", marginTop: 8 }}>
                    {JSON.stringify(a.parsed, null, 2)}
                  </pre>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Exceptions ({exceptions.length})</h2>
        {exceptions.length === 0 ? (
          <div className="empty-state">No open exceptions for claims in this batch.</div>
        ) : (
          <div className="stack-list">
            {exceptions.map((x) => (
              <article key={x.id} className="stack-item">
                <div className="stack-row">
                  <div>
                    <strong>Claim {x.claimNumber}</strong>
                    <span>
                      {x.itemStatus || "open"} · priority {x.priority || "normal"}
                      {x.groupCode || x.carcCode ? ` · ${[x.groupCode, x.carcCode, x.rarcCode].filter(Boolean).join("/")}` : ""}
                    </span>
                    {x.denialReason ? <span>{x.denialReason}</span> : null}
                    {x.actionTaken ? <span className="muted-text">Action: {x.actionTaken}</span> : null}
                  </div>
                  <div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Event timeline ({timeline.length})</h2>
        {timeline.length === 0 ? (
          <div className="empty-state">No events recorded yet.</div>
        ) : (
          <div className="stack-list">
            {timeline.map((e) => (
              <article key={e.id} className="stack-item">
                <div className="stack-row">
                  <div>
                    <strong style={{ color: severityColor(e.severity) }}>{e.title}</strong>
                    <span>
                      Claim {e.claimNumber} · {e.kind}
                      {e.detail ? ` · ${e.detail}` : ""}
                    </span>
                  </div>
                  <span className="muted-text">{formatDateTime(e.at)}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Claims in this batch ({claims.length})</h2>
        {claims.length === 0 ? (
          <div className="empty-state">No claims linked to this batch.</div>
        ) : (
          <div className="stack-list">
            {claims.map((c) => (
              <article key={c.id} className="stack-item">
                <div className="stack-row">
                  <div>
                    <strong>
                      <Link className="inline-link" href={`/clients/${encodeURIComponent(c.patientId)}`}>{c.patientName}</Link>
                    </strong>
                    <span>Claim {c.claimNumber || c.id.slice(0, 8)} · {c.status || "no status"} · {formatMoney(c.totalCharge)}</span>
                    {c.submittedAt ? <span className="muted-text">Submitted {formatDateTime(c.submittedAt)}</span> : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
