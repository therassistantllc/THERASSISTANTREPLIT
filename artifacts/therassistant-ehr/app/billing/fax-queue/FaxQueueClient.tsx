"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DEFAULT_ORG_ID } from "@/lib/config";

interface FaxQueueItem {
  id: string;
  status: string;
  toFaxNumber: string;
  subject: string | null;
  body: string;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  claimId: string | null;
  claimNumber: string | null;
  payerId: string | null;
  payerName: string | null;
  createdByUserId: string | null;
  createdByDisplayName: string | null;
}

interface ApiPayload {
  success: boolean;
  error?: string;
  items?: FaxQueueItem[];
  counts?: {
    pending: number;
    sent: number;
    failed: number;
    canceled: number;
  };
}

type StatusFilter = "all" | "pending" | "sent" | "failed" | "canceled";

const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "sent", label: "Sent" },
  { id: "failed", label: "Failed" },
  { id: "canceled", label: "Canceled" },
];

function getOrganizationId(): string {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function statusBadge(status: string): { bg: string; fg: string; label: string } {
  const s = status.toLowerCase();
  if (s === "sent") return { bg: "#dcfce7", fg: "#166534", label: "Sent" };
  if (s === "failed") return { bg: "#fee2e2", fg: "#991b1b", label: "Failed" };
  if (s === "canceled") return { bg: "#e2e8f0", fg: "#475569", label: "Canceled" };
  return { bg: "#fef3c7", fg: "#92400e", label: "Pending" };
}

export default function FaxQueueClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [items, setItems] = useState<FaxQueueItem[]>([]);
  const [counts, setCounts] = useState<NonNullable<ApiPayload["counts"]>>({
    pending: 0,
    sent: 0,
    failed: 0,
    canceled: 0,
  });
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeTab, setActiveTab] = useState<StatusFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const qs = new URLSearchParams({ organizationId, list: "1" });
    fetch(`/api/billing/fax-queue?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<ApiPayload>)
      .then((json) => {
        if (json.success && Array.isArray(json.items)) {
          setItems(json.items);
          if (json.counts) setCounts(json.counts);
        } else {
          setItems([]);
          if (json.error) setMessage({ tone: "error", text: json.error });
        }
      })
      .catch((e) => {
        setMessage({
          tone: "error",
          text: e instanceof Error ? e.message : "Failed to load",
        });
      })
      .finally(() => setLoading(false));
  }, [organizationId, reloadKey]);

  const filtered = useMemo(() => {
    if (activeTab === "all") return items;
    return items.filter((i) => i.status === activeTab);
  }, [items, activeTab]);

  const runAction = useCallback(
    async (faxId: string, action: "retry" | "cancel") => {
      if (action === "cancel" && typeof window !== "undefined") {
        if (!window.confirm("Cancel this pending fax? It will not be sent.")) return;
      }
      setBusyId(faxId);
      setMessage(null);
      try {
        const res = await fetch(
          `/api/billing/fax-queue/${encodeURIComponent(faxId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId, action }),
          },
        );
        const json = await res.json();
        if (!res.ok || json.success === false) {
          throw new Error(json.error || "Action failed");
        }
        setMessage({
          tone: "success",
          text: action === "retry" ? "Fax re-queued for sending." : "Fax canceled.",
        });
        setReloadKey((k) => k + 1);
      } catch (e) {
        setMessage({
          tone: "error",
          text: e instanceof Error ? e.message : "Action failed",
        });
      } finally {
        setBusyId(null);
      }
    },
    [organizationId],
  );

  return (
    <div style={{ padding: 20, minWidth: 0, flex: 1 }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#0f172a" }}>
          Outbound Faxes
        </h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "#64748b" }}>
          Faxes queued by the appeals workflow and denials workqueue. Confirm what
          was sent, retry failures, or cancel pending rows before they go out.
        </p>
      </header>

      {/* Summary strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(120px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        {[
          { id: "pending", label: "Pending", value: counts.pending, tone: "#fef3c7" },
          { id: "sent", label: "Sent", value: counts.sent, tone: "#dcfce7" },
          { id: "failed", label: "Failed", value: counts.failed, tone: "#fee2e2" },
          { id: "canceled", label: "Canceled", value: counts.canceled, tone: "#e2e8f0" },
        ].map((m) => (
          <div
            key={m.id}
            style={{
              background: "white",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              padding: "10px 12px",
            }}
          >
            <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {m.label}
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 22,
                fontWeight: 700,
                color: "#0f172a",
                display: "inline-block",
                background: m.tone,
                padding: "0 8px",
                borderRadius: 6,
              }}
            >
              {m.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid #e2e8f0",
          marginBottom: 12,
        }}
      >
        {STATUS_TABS.map((t) => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              style={{
                appearance: "none",
                border: "none",
                background: "transparent",
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: active ? 700 : 500,
                color: active ? "#0f172a" : "#64748b",
                borderBottom: active ? "2px solid #2563eb" : "2px solid transparent",
                marginBottom: -1,
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          style={{
            appearance: "none",
            border: "1px solid #cbd5e1",
            background: "white",
            color: "#0f172a",
            padding: "4px 10px",
            fontSize: 12,
            borderRadius: 6,
            cursor: "pointer",
            alignSelf: "center",
          }}
        >
          Refresh
        </button>
      </div>

      {message && (
        <div
          role="status"
          style={{
            padding: "8px 12px",
            marginBottom: 12,
            borderRadius: 6,
            fontSize: 13,
            background: message.tone === "success" ? "#dcfce7" : "#fee2e2",
            color: message.tone === "success" ? "#166534" : "#991b1b",
          }}
        >
          {message.text}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 24, color: "#64748b", fontSize: 13 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div
          style={{
            padding: 24,
            border: "1px dashed #cbd5e1",
            borderRadius: 8,
            color: "#64748b",
            fontSize: 13,
            background: "white",
          }}
        >
          No outbound faxes match this filter.
        </div>
      ) : (
        <div
          style={{
            background: "white",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f8fafc", color: "#475569" }}>
                <th style={th}>Status</th>
                <th style={th}>Created</th>
                <th style={th}>Sent</th>
                <th style={th}>To #</th>
                <th style={th}>Payer</th>
                <th style={th}>Claim</th>
                <th style={th}>Subject</th>
                <th style={th}>Created by</th>
                <th style={{ ...th, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const badge = statusBadge(r.status);
                const isOpen = expandedId === r.id;
                const isBusy = busyId === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr
                      style={{ borderTop: "1px solid #e2e8f0", verticalAlign: "top" }}
                    >
                      <td style={td}>
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: badge.bg,
                            color: badge.fg,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td style={td}>{formatDateTime(r.createdAt)}</td>
                      <td style={td}>{formatDateTime(r.sentAt)}</td>
                      <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                        {r.toFaxNumber || "—"}
                      </td>
                      <td style={td}>{r.payerName || (r.payerId ? r.payerId.slice(0, 8) : "—")}</td>
                      <td style={td}>
                        {r.claimId ? (
                          <Link
                            href={`/billing/claim-edit-dashboard?claimId=${encodeURIComponent(r.claimId)}`}
                            style={{ color: "#2563eb", textDecoration: "none" }}
                          >
                            {r.claimNumber || r.claimId.slice(0, 8)}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td
                        style={{
                          ...td,
                          maxWidth: 280,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={r.subject ?? undefined}
                      >
                        {r.subject || "—"}
                      </td>
                      <td style={td}>
                        {r.createdByDisplayName ||
                          (r.createdByUserId ? r.createdByUserId.slice(0, 8) : "—")}
                      </td>
                      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          onClick={() => setExpandedId(isOpen ? null : r.id)}
                          style={btn("ghost")}
                        >
                          {isOpen ? "Hide" : "Details"}
                        </button>
                        {r.status === "failed" && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => runAction(r.id, "retry")}
                            style={btn("primary")}
                          >
                            Retry
                          </button>
                        )}
                        {r.status === "pending" && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => runAction(r.id, "cancel")}
                            style={btn("danger")}
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr style={{ background: "#f8fafc" }}>
                        <td colSpan={9} style={{ padding: 16 }}>
                          {r.error && (
                            <div
                              style={{
                                padding: "8px 12px",
                                marginBottom: 12,
                                borderRadius: 6,
                                fontSize: 12,
                                background: "#fee2e2",
                                color: "#991b1b",
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              <strong>Error:</strong> {r.error}
                            </div>
                          )}
                          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>
                            FAX BODY
                          </div>
                          <pre
                            style={{
                              margin: 0,
                              padding: 12,
                              background: "white",
                              border: "1px solid #e2e8f0",
                              borderRadius: 6,
                              maxHeight: 400,
                              overflow: "auto",
                              fontFamily: "ui-monospace, monospace",
                              fontSize: 12,
                              whiteSpace: "pre-wrap",
                              color: "#0f172a",
                            }}
                          >
                            {r.body || "(empty)"}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  fontWeight: 600,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  padding: "8px 12px",
};

const td: React.CSSProperties = {
  padding: "10px 12px",
  color: "#0f172a",
};

function btn(kind: "primary" | "danger" | "ghost"): React.CSSProperties {
  const base: React.CSSProperties = {
    appearance: "none",
    border: "1px solid transparent",
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 6,
    cursor: "pointer",
    marginLeft: 6,
  };
  if (kind === "primary") {
    return { ...base, background: "#2563eb", color: "white", borderColor: "#2563eb" };
  }
  if (kind === "danger") {
    return { ...base, background: "white", color: "#991b1b", borderColor: "#fca5a5" };
  }
  return { ...base, background: "white", color: "#475569", borderColor: "#cbd5e1" };
}
