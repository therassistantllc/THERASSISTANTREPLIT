"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type Connection = {
  id: string;
  integrationType: string;
  connectionStatus: string;
  displayName: string;
  externalAccountEmail: string;
  lastSyncAt: string;
  syncError: string;
};

type EmailListItem = {
  id: string;
  provider: string;
  fromEmail: string;
  fromName: string;
  toEmail: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  matchedProfileId: string;
  matchedClientId: string;
  mailroomItemId: string;
  workqueueItemId: string;
  processingStatus: string;
  aiSentiment: string;
  aiPriority: string;
  aiCategory: string;
  aiSummary: string;
  aiAnalysisStatus: string;
  client: { id: string; firstName: string; lastName: string } | null;
};

type EmailDetail = EmailListItem & {
  body: string;
  aiDraftReply: string;
};

type Counts = { total: number; patient: number; unmatched: number; routed: number; mine: number };

const FILTERS: Array<{ key: string; label: string; countKey: keyof Counts | "total" }> = [
  { key: "all", label: "All", countKey: "total" },
  { key: "mine", label: "Mine", countKey: "mine" },
  { key: "patient", label: "Patient", countKey: "patient" },
  { key: "unmatched", label: "Unmatched", countKey: "unmatched" },
  { key: "routed", label: "Routed", countKey: "routed" },
];

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
  return new URLSearchParams(window.location.search).get("organizationId")
    || process.env.NEXT_PUBLIC_ORGANIZATION_ID
    || DEFAULT_ORG_ID;
}

function getUserIdFromUrl() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("userId") || "";
}

function formatDateTime(value: string) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function patientName(c: EmailListItem["client"]) {
  if (!c) return "";
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "Patient";
}

function statusPillClass(priority: string) {
  const p = (priority || "").toLowerCase();
  if (p === "urgent" || p === "high") return "urgent";
  if (p === "low") return "normal";
  return "normal";
}

export default function EmailClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const userId = useMemo(() => getUserIdFromUrl(), []);

  const [connections, setConnections] = useState<Connection[]>([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [messages, setMessages] = useState<EmailListItem[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const loadConnections = useCallback(async () => {
    const res = await fetch(`/api/email/connections?organizationId=${organizationId}`, { cache: "no-store" });
    const json = (await res.json()) as { success?: boolean; connections?: Connection[]; error?: string };
    if (res.ok && json.success) setConnections(json.connections ?? []);
  }, [organizationId]);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ organizationId, filter });
    if (userId) params.set("userId", userId);
    if (search) params.set("search", search);
    const res = await fetch(`/api/email/messages?${params.toString()}`, { cache: "no-store" });
    const json = (await res.json()) as {
      success?: boolean;
      messages?: EmailListItem[];
      counts?: Counts;
      error?: string;
    };
    if (!res.ok || !json.success) {
      setError(json.error || "Failed to load emails.");
      setMessages([]);
      setCounts(null);
    } else {
      setMessages(json.messages ?? []);
      setCounts(json.counts ?? null);
      setSelectedId((cur) => (cur && (json.messages ?? []).some((m) => m.id === cur)) ? cur : ((json.messages ?? [])[0]?.id ?? null));
    }
    setLoading(false);
  }, [organizationId, filter, userId, search]);

  useEffect(() => { void loadConnections(); }, [loadConnections]);
  useEffect(() => { void loadMessages(); }, [loadMessages]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    (async () => {
      setLoadingDetail(true);
      const res = await fetch(`/api/email/messages/${selectedId}?organizationId=${organizationId}`, { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; message?: EmailDetail; error?: string };
      if (cancelled) return;
      if (res.ok && json.success && json.message) setDetail(json.message);
      else setDetail(null);
      setLoadingDetail(false);
    })();
    return () => { cancelled = true; };
  }, [selectedId, organizationId]);

  async function runAction(action: "archive" | "mark_ignored" | "mark_routed") {
    if (!selectedId) return;
    setActing(true);
    const res = await fetch(`/api/email/messages/${selectedId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, organizationId }),
    });
    const json = (await res.json()) as { success?: boolean; error?: string };
    if (!res.ok || !json.success) {
      setError(json.error || "Action failed.");
    } else {
      if (action === "archive") {
        setMessages((prev) => prev.filter((m) => m.id !== selectedId));
        setSelectedId(null);
        setDetail(null);
      }
      await loadMessages();
    }
    setActing(false);
  }

  function connectGmail() {
    setConnecting(true);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    if (!supabaseUrl) {
      setError("Cannot start Gmail connect: NEXT_PUBLIC_SUPABASE_URL is not configured.");
      setConnecting(false);
      return;
    }
    const url = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/gmail-oauth-start?organization_id=${encodeURIComponent(organizationId)}`;
    window.location.href = url;
  }

  const gmailConn = connections.find((c) => c.integrationType === "gmail");

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Email</p>
          <h1>Inbound email</h1>
          <p className="hero-copy">
            Patient-facing email routed into the EHR. Auto-matched to patients when possible, AI-summarized,
            and one click to send to <Link className="inline-link" href="/mailroom">Mailroom</Link> or your
            <Link className="inline-link" href="/inbox"> Inbox</Link>.
          </p>
        </div>
        <div className="hero-actions">
          {gmailConn && gmailConn.connectionStatus === "connected" ? (
            <span className="muted-text">
              Gmail: {gmailConn.externalAccountEmail || gmailConn.displayName || "Connected"}
              {gmailConn.lastSyncAt ? ` · last sync ${formatDateTime(gmailConn.lastSyncAt)}` : ""}
            </span>
          ) : (
            <button className="button" type="button" onClick={connectGmail} disabled={connecting}>
              {connecting ? "Redirecting…" : "Connect Gmail"}
            </button>
          )}
          <button className="button button-secondary" type="button" disabled title="Outlook integration not configured yet">
            Connect Outlook (soon)
          </button>
        </div>
      </section>

      {error ? <div className="alert-panel">{error}</div> : null}
      {gmailConn?.syncError ? <div className="alert-panel">Gmail sync error: {gmailConn.syncError}</div> : null}

      <section className="toolbar-panel">
        <form
          onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); }}
          style={{ display: "flex", gap: 8 }}
        >
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search subject, from, or snippet (Enter to search)"
            style={{ minWidth: 320, padding: 6, border: "1px solid #e5e7eb", borderRadius: 6 }}
          />
          {search ? (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => { setSearch(""); setSearchInput(""); }}
            >
              Clear
            </button>
          ) : null}
        </form>
        <button className="button button-secondary" type="button" onClick={() => void loadMessages()} disabled={loading}>
          Refresh
        </button>
        {counts ? <span className="muted-text">{counts.total} message(s)</span> : null}
      </section>

      <section className="panel" style={{ padding: "10px 12px", display: "flex", gap: 8, flexWrap: "wrap" }}>
        {FILTERS.map((f) => {
          const count = counts ? counts[f.countKey] ?? 0 : 0;
          return (
            <button
              key={f.key}
              type="button"
              className={filter === f.key ? "button" : "button button-secondary"}
              style={{ padding: "4px 10px", fontSize: 12 }}
              onClick={() => setFilter(f.key)}
            >
              {f.label} ({count})
            </button>
          );
        })}
      </section>

      <section className="workqueue-layout">
        <div className="workqueue-list panel">
          {loading ? <div className="empty-state">Loading…</div> : null}
          {!loading && messages.length === 0 ? (
            <div className="empty-state">
              {gmailConn?.connectionStatus === "connected"
                ? "No emails match the current filter."
                : "No emails yet. Connect Gmail to start receiving patient mail."}
            </div>
          ) : null}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`workqueue-list-item-row ${selectedId === m.id ? "selected" : ""}`}
            >
              <button
                className="workqueue-list-item"
                type="button"
                onClick={() => setSelectedId(m.id)}
                style={{ alignItems: "flex-start" }}
              >
                <span className={`status-pill ${statusPillClass(m.aiPriority)}`}>{m.aiPriority || m.processingStatus || "received"}</span>
                <strong>{m.subject || "(no subject)"}</strong>
                <span>{m.fromName || m.fromEmail || "Unknown sender"}</span>
                <span style={{ color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.client ? `Patient: ${patientName(m.client)} · ` : ""}{m.snippet || ""}
                </span>
                <span className="muted-text">{formatDateTime(m.receivedAt)}</span>
              </button>
            </div>
          ))}
        </div>

        <div className="workqueue-detail panel">
          {!selectedId ? <div className="empty-state">Select an email.</div> : null}
          {selectedId && loadingDetail && !detail ? <div className="empty-state">Loading…</div> : null}
          {detail ? (
            <>
              <div className="detail-header">
                <div>
                  <p className="eyebrow">{detail.provider || "email"} · {detail.processingStatus || "received"}</p>
                  <h2>{detail.subject || "(no subject)"}</h2>
                  <p className="muted-text">
                    From {detail.fromName ? `${detail.fromName} <${detail.fromEmail}>` : detail.fromEmail}
                    {detail.toEmail ? ` · to ${detail.toEmail}` : ""}
                    {" · "}{formatDateTime(detail.receivedAt)}
                  </p>
                </div>
                {detail.aiPriority ? (
                  <span className={`status-pill ${statusPillClass(detail.aiPriority)}`}>{detail.aiPriority}</span>
                ) : null}
              </div>

              {detail.aiSummary || detail.aiCategory || detail.aiSentiment ? (
                <div className="alert-panel alert-panel-success" style={{ display: "grid", gap: 6 }}>
                  {detail.aiCategory ? <div><strong>Category:</strong> {detail.aiCategory}</div> : null}
                  {detail.aiSentiment ? <div><strong>Sentiment:</strong> {detail.aiSentiment}</div> : null}
                  {detail.aiSummary ? <div><strong>Summary:</strong> {detail.aiSummary}</div> : null}
                </div>
              ) : null}

              <div className="detail-list">
                {detail.client ? (
                  <p>
                    <strong>Matched patient:</strong>{" "}
                    <Link className="inline-link" href={`/clients/${detail.client.id}`}>
                      {patientName(detail.client)}
                    </Link>
                  </p>
                ) : (
                  <p className="muted-text">Not matched to a patient.</p>
                )}
                {detail.mailroomItemId ? (
                  <p>
                    <strong>Mailroom item:</strong>{" "}
                    <Link className="inline-link" href={`/mailroom/${detail.mailroomItemId}`}>open</Link>
                  </p>
                ) : null}
              </div>

              <div
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 12,
                  maxHeight: 360,
                  overflowY: "auto",
                  background: "#fafafa",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {detail.body || detail.snippet || "(no body)"}
              </div>

              {detail.aiDraftReply ? (
                <div className="panel" style={{ padding: 12, marginTop: 12 }}>
                  <strong>AI draft reply</strong>
                  <p style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{detail.aiDraftReply}</p>
                  <p className="muted-text">Send-from-EHR not wired up yet — copy into Gmail to send.</p>
                </div>
              ) : null}

              <div className="section-actions" style={{ marginTop: 12 }}>
                <button className="button button-secondary" type="button" onClick={() => void runAction("mark_routed")} disabled={acting}>
                  Mark routed
                </button>
                <button className="button button-secondary" type="button" onClick={() => void runAction("mark_ignored")} disabled={acting}>
                  Ignore
                </button>
                <button className="button" type="button" onClick={() => void runAction("archive")} disabled={acting}>
                  Archive
                </button>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
