"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DEFAULT_ORG_ID } from "@/lib/config";

type InboxKind = "clinician" | "admin";

type InboxItem = {
  id: string;
  workType: string;
  kind: InboxKind;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  appointmentId: string | null;
  appointmentAt: string | null;
  appointmentType: string | null;
  clientId: string | null;
  clientName: string | null;
  claimId: string | null;
  routedByUserId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  eligibilityHref: string;
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relative(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function priorityTone(p: string): { bg: string; fg: string; label: string } {
  switch (p) {
    case "urgent":
      return { bg: "#FEE2E2", fg: "#B91C1C", label: "Urgent" };
    case "high":
      return { bg: "#FEF3C7", fg: "#92400E", label: "High" };
    case "low":
      return { bg: "#F1F5F9", fg: "#475569", label: "Low" };
    default:
      return { bg: "#E0E7FF", fg: "#3730A3", label: "Normal" };
  }
}

function kindTone(k: InboxKind): { bg: string; fg: string; label: string } {
  return k === "clinician"
    ? { bg: "#DCFCE7", fg: "#166534", label: "Clinician verify" }
    : { bg: "#E0F2FE", fg: "#075985", label: "Admin follow-up" };
}

export default function MyInboxClient() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | InboxKind>("all");

  const organizationId = useMemo(() => getOrganizationId(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/my-inbox?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error ?? "Failed to load inbox");
      }
      setItems((json.items ?? []) as InboxItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load inbox");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (item: InboxItem) => {
      setResolvingId(item.id);
      try {
        const res = await fetch("/api/billing/my-inbox", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: item.id,
            action: "resolve",
            organizationId,
          }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Failed to mark resolved");
        }
        setItems((prev) => prev.filter((r) => r.id !== item.id));
        setToast("Marked resolved");
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Failed to mark resolved");
      } finally {
        setResolvingId(null);
      }
    },
    [organizationId],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.kind === filter)),
    [items, filter],
  );

  const counts = useMemo(
    () => ({
      all: items.length,
      clinician: items.filter((i) => i.kind === "clinician").length,
      admin: items.filter((i) => i.kind === "admin").length,
    }),
    [items],
  );

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#0F172A" }}>
          My Inbox
        </h1>
        <p style={{ margin: "4px 0 0", color: "#64748B", fontSize: 13 }}>
          Eligibility issues routed to you. Resolve an item once you've
          completed the follow-up — it will disappear from your inbox.
        </p>
      </header>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
        {([
          { id: "all", label: "All" },
          { id: "clinician", label: "Clinician verify" },
          { id: "admin", label: "Admin follow-up" },
        ] as const).map((t) => {
          const active = filter === t.id;
          const n = counts[t.id];
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setFilter(t.id)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                border: `1px solid ${active ? "#1D4ED8" : "#CBD5E1"}`,
                background: active ? "#EFF6FF" : "#FFFFFF",
                color: active ? "#1D4ED8" : "#334155",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t.label}
              <span
                style={{
                  marginLeft: 6,
                  background: active ? "#1D4ED8" : "#E2E8F0",
                  color: active ? "#FFFFFF" : "#475569",
                  borderRadius: 999,
                  padding: "1px 7px",
                  fontSize: 11,
                }}
              >
                {n}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => void load()}
          style={{
            marginLeft: "auto",
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #CBD5E1",
            background: "#FFFFFF",
            color: "#334155",
            fontSize: 12.5,
            cursor: "pointer",
          }}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <div
          style={{
            padding: 12,
            border: "1px solid #FECACA",
            background: "#FEF2F2",
            color: "#991B1B",
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <div style={{ color: "#64748B", fontSize: 13 }}>Loading your inbox…</div>
      ) : visible.length === 0 ? (
        <div
          style={{
            padding: 32,
            border: "1px dashed #CBD5E1",
            borderRadius: 8,
            color: "#64748B",
            textAlign: "center",
            fontSize: 14,
          }}
        >
          {items.length === 0
            ? "Nothing routed to you. Eligibility issues that get routed to your name will show up here."
            : "No items match this filter."}
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {visible.map((item) => {
            const pt = priorityTone(item.priority);
            const kt = kindTone(item.kind);
            return (
              <li
                key={item.id}
                style={{
                  border: "1px solid #E2E8F0",
                  borderRadius: 8,
                  background: "#FFFFFF",
                  padding: 14,
                  display: "flex",
                  gap: 14,
                  alignItems: "flex-start",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: 0.04,
                        textTransform: "uppercase",
                        background: kt.bg,
                        color: kt.fg,
                        padding: "2px 8px",
                        borderRadius: 4,
                      }}
                    >
                      {kt.label}
                    </span>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: 0.04,
                        textTransform: "uppercase",
                        background: pt.bg,
                        color: pt.fg,
                        padding: "2px 8px",
                        borderRadius: 4,
                      }}
                    >
                      {pt.label}
                    </span>
                    <span style={{ fontSize: 12, color: "#94A3B8" }} title={item.updatedAt}>
                      routed {relative(item.updatedAt)}
                    </span>
                  </div>

                  <div style={{ marginTop: 6, fontSize: 14.5, fontWeight: 600, color: "#0F172A" }}>
                    {item.title}
                  </div>

                  <div style={{ marginTop: 4, fontSize: 13, color: "#334155" }}>
                    {item.clientName ? (
                      <>
                        <strong>{item.clientName}</strong>
                        {item.appointmentAt
                          ? ` · ${formatWhen(item.appointmentAt)}`
                          : null}
                        {item.appointmentType ? ` · ${item.appointmentType}` : null}
                      </>
                    ) : item.appointmentAt ? (
                      formatWhen(item.appointmentAt)
                    ) : (
                      <span style={{ color: "#94A3B8" }}>No appointment context</span>
                    )}
                  </div>

                  {item.note || item.description ? (
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 12.5,
                        color: "#475569",
                        background: "#F8FAFC",
                        border: "1px solid #E2E8F0",
                        borderRadius: 6,
                        padding: "6px 8px",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {item.note || item.description}
                    </div>
                  ) : null}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch", minWidth: 160 }}>
                  <Link
                    href={item.eligibilityHref}
                    style={{
                      display: "inline-block",
                      textAlign: "center",
                      padding: "6px 10px",
                      borderRadius: 6,
                      background: "#1D4ED8",
                      color: "#FFFFFF",
                      fontSize: 12.5,
                      fontWeight: 600,
                      textDecoration: "none",
                    }}
                  >
                    Open eligibility issue
                  </Link>
                  <button
                    type="button"
                    onClick={() => void resolve(item)}
                    disabled={resolvingId === item.id}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid #16A34A",
                      background: resolvingId === item.id ? "#F0FDF4" : "#FFFFFF",
                      color: "#166534",
                      fontSize: 12.5,
                      fontWeight: 600,
                      cursor: resolvingId === item.id ? "default" : "pointer",
                    }}
                  >
                    {resolvingId === item.id ? "Resolving…" : "Mark resolved"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {toast ? (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            background: "#0F172A",
            color: "#FFFFFF",
            padding: "10px 16px",
            borderRadius: 6,
            fontSize: 13,
            boxShadow: "0 10px 25px rgba(15,23,42,0.18)",
            zIndex: 1100,
          }}
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
