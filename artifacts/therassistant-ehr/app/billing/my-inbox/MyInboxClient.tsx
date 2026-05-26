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
  commentCount: number;
  reminderCount: number;
  lastRemindedAt: string | null;
  billingComment: string | null;
  patientResponsibility: number | null;
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

type NotificationPrefs = {
  emailOnEligibilityRouting: boolean;
  inAppOnEligibilityRouting: boolean;
};

type CommentRow = {
  id: string;
  body: string;
  type: string;
  createdAt: string;
  authorUserId: string | null;
  authorName: string;
};

type CommentsState = {
  loading: boolean;
  error: string | null;
  comments: CommentRow[];
  canComment: boolean;
};

type ReminderRow = {
  id: string;
  sentAt: string;
  reminderNumber: number | null;
  emailSent: boolean;
  channelAttempts: unknown[];
  assignedToStaffId: string | null;
};

type RemindersState = {
  loading: boolean;
  error: string | null;
  reminders: ReminderRow[];
};

export default function MyInboxClient() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | InboxKind>("all");
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [savingPref, setSavingPref] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [commentsById, setCommentsById] = useState<Record<string, CommentsState>>({});
  const [draftById, setDraftById] = useState<Record<string, string>>({});
  const [postingId, setPostingId] = useState<string | null>(null);
  const [remindersOpenId, setRemindersOpenId] = useState<string | null>(null);
  const [remindersById, setRemindersById] = useState<Record<string, RemindersState>>({});
  // Provider approval discount modal state
  const [discountModal, setDiscountModal] = useState<{ item: InboxItem; amount: string } | null>(null);
  const [providerActionId, setProviderActionId] = useState<string | null>(null);

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

  const loadPrefs = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/billing/notification-preferences?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (res.ok && json?.success && json.preferences) {
        setPrefs(json.preferences as NotificationPrefs);
      }
    } catch {
      // Non-fatal — the toggle just won't render until the next load.
    }
  }, [organizationId]);

  useEffect(() => {
    void loadPrefs();
  }, [loadPrefs]);

  const togglePref = useCallback(
    async (key: keyof NotificationPrefs) => {
      if (!prefs) return;
      const next = { ...prefs, [key]: !prefs[key] };
      setPrefs(next);
      setSavingPref(true);
      try {
        const res = await fetch("/api/billing/notification-preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            emailOnEligibilityRouting: next.emailOnEligibilityRouting,
            inAppOnEligibilityRouting: next.inAppOnEligibilityRouting,
          }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Failed to save preference");
        }
        if (json.preferences) setPrefs(json.preferences as NotificationPrefs);
        setToast(
          next.emailOnEligibilityRouting
            ? "Routing emails on"
            : "Routing emails off",
        );
      } catch (e) {
        setPrefs(prefs);
        setToast(e instanceof Error ? e.message : "Failed to save preference");
      } finally {
        setSavingPref(false);
      }
    },
    [organizationId, prefs],
  );

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

  const providerAction = useCallback(
    async (item: InboxItem, action: "approve" | "charity_care" | "discount", discountedAmount?: number) => {
      setProviderActionId(item.id);
      try {
        const body: Record<string, unknown> = { id: item.id, action, organizationId };
        if (action === "discount" && discountedAmount !== undefined) {
          body.discountedAmount = discountedAmount;
        }
        const res = await fetch("/api/billing/my-inbox", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Action failed");
        }
        setItems((prev) => prev.filter((r) => r.id !== item.id));
        const labels: Record<string, string> = {
          approve: "Approved — returned to Patient Balances",
          charity_care: "Written off as charity care",
          discount: `Discounted to $${discountedAmount?.toFixed(2) ?? "0.00"} — returned to Patient Balances`,
        };
        setToast(labels[action] ?? "Action completed");
        setDiscountModal(null);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
      } finally {
        setProviderActionId(null);
      }
    },
    [organizationId],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const loadComments = useCallback(
    async (workqueueItemId: string) => {
      setCommentsById((prev) => ({
        ...prev,
        [workqueueItemId]: {
          loading: true,
          error: null,
          comments: prev[workqueueItemId]?.comments ?? [],
          canComment: prev[workqueueItemId]?.canComment ?? false,
        },
      }));
      try {
        const res = await fetch(
          `/api/billing/workqueue-comments?workqueueItemId=${encodeURIComponent(
            workqueueItemId,
          )}&organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Failed to load comments");
        }
        setCommentsById((prev) => ({
          ...prev,
          [workqueueItemId]: {
            loading: false,
            error: null,
            comments: (json.comments ?? []) as CommentRow[],
            canComment: Boolean(json.canComment),
          },
        }));
      } catch (e) {
        setCommentsById((prev) => ({
          ...prev,
          [workqueueItemId]: {
            loading: false,
            error: e instanceof Error ? e.message : "Failed to load comments",
            comments: prev[workqueueItemId]?.comments ?? [],
            canComment: prev[workqueueItemId]?.canComment ?? false,
          },
        }));
      }
    },
    [organizationId],
  );

  const toggleExpanded = useCallback(
    (item: InboxItem) => {
      const next = expandedId === item.id ? null : item.id;
      setExpandedId(next);
      if (next && !commentsById[item.id]) {
        void loadComments(item.id);
      }
    },
    [expandedId, commentsById, loadComments],
  );

  const loadReminders = useCallback(
    async (workqueueItemId: string) => {
      setRemindersById((prev) => ({
        ...prev,
        [workqueueItemId]: {
          loading: true,
          error: null,
          reminders: prev[workqueueItemId]?.reminders ?? [],
        },
      }));
      try {
        const res = await fetch(
          `/api/billing/my-inbox/reminders?workqueueItemId=${encodeURIComponent(
            workqueueItemId,
          )}&organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Failed to load reminder history");
        }
        setRemindersById((prev) => ({
          ...prev,
          [workqueueItemId]: {
            loading: false,
            error: null,
            reminders: (json.reminders ?? []) as ReminderRow[],
          },
        }));
      } catch (e) {
        setRemindersById((prev) => ({
          ...prev,
          [workqueueItemId]: {
            loading: false,
            error: e instanceof Error ? e.message : "Failed to load reminder history",
            reminders: prev[workqueueItemId]?.reminders ?? [],
          },
        }));
      }
    },
    [organizationId],
  );

  const toggleReminders = useCallback(
    (item: InboxItem) => {
      const next = remindersOpenId === item.id ? null : item.id;
      setRemindersOpenId(next);
      if (next && !remindersById[item.id]) {
        void loadReminders(item.id);
      }
    },
    [remindersOpenId, remindersById, loadReminders],
  );

  const postComment = useCallback(
    async (workqueueItemId: string) => {
      const text = (draftById[workqueueItemId] ?? "").trim();
      if (!text) return;
      setPostingId(workqueueItemId);
      try {
        const res = await fetch("/api/billing/workqueue-comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workqueueItemId,
            organizationId,
            comment: text,
          }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Failed to add comment");
        }
        setDraftById((prev) => ({ ...prev, [workqueueItemId]: "" }));
        await loadComments(workqueueItemId);
        setToast("Comment added");
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Failed to add comment");
      } finally {
        setPostingId(null);
      }
    },
    [draftById, organizationId, loadComments],
  );

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
      <header style={{ marginBottom: 20, display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#0F172A" }}>
            My Inbox
          </h1>
          <p style={{ margin: "4px 0 0", color: "#64748B", fontSize: 13 }}>
            Eligibility issues routed to you. Resolve an item once you've
            completed the follow-up — it will disappear from your inbox.
          </p>
        </div>
        {prefs ? (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12.5,
              color: "#334155",
              border: "1px solid #E2E8F0",
              borderRadius: 6,
              padding: "8px 10px",
              background: "#FFFFFF",
              cursor: savingPref ? "default" : "pointer",
              whiteSpace: "nowrap",
            }}
            title="Send me an email when an eligibility issue is routed to me"
          >
            <input
              type="checkbox"
              checked={prefs.emailOnEligibilityRouting}
              onChange={() => void togglePref("emailOnEligibilityRouting")}
              disabled={savingPref}
            />
            <span>Email me when issues are routed to me</span>
          </label>
        ) : null}
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
            const isExpanded = expandedId === item.id;
            const commentsState = commentsById[item.id];
            const draft = draftById[item.id] ?? "";
            return (
              <li
                key={item.id}
                style={{
                  border: "1px solid #E2E8F0",
                  borderRadius: 8,
                  background: "#FFFFFF",
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
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
                    {item.reminderCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => toggleReminders(item)}
                        aria-expanded={remindersOpenId === item.id}
                        title={
                          item.lastRemindedAt
                            ? `Last reminder ${formatWhen(item.lastRemindedAt)} — click for history`
                            : "Click to see reminder history"
                        }
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          letterSpacing: 0.04,
                          textTransform: "uppercase",
                          background:
                            remindersOpenId === item.id ? "#FDE68A" : "#FEF3C7",
                          color: "#92400E",
                          padding: "2px 8px",
                          borderRadius: 4,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          border: "1px solid #FCD34D",
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        <span aria-hidden>🔔</span>
                        Reminded {item.reminderCount}{" "}
                        {item.reminderCount === 1 ? "time" : "times"}
                        {item.lastRemindedAt
                          ? ` · last ${relative(item.lastRemindedAt)}`
                          : null}
                      </button>
                    ) : null}
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
                  {item.workType === "provider_approval_needed" ? (
                    // Provider approval action buttons
                    <>
                      {item.billingComment && (
                        <div style={{ fontSize: 11, color: "#475569", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 6, padding: "5px 8px", marginBottom: 2 }}>
                          <span style={{ fontWeight: 600 }}>Note: </span>{item.billingComment}
                        </div>
                      )}
                      {item.patientResponsibility != null && (
                        <div style={{ fontSize: 11, color: "#334155", marginBottom: 2 }}>
                          Patient responsibility:{" "}
                          <strong>${Number(item.patientResponsibility).toFixed(2)}</strong>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => void providerAction(item, "approve")}
                        disabled={providerActionId === item.id}
                        style={{
                          padding: "7px 10px",
                          borderRadius: 6,
                          border: "none",
                          background: "#166534",
                          color: "#fff",
                          fontSize: 12.5,
                          fontWeight: 700,
                          cursor: providerActionId === item.id ? "default" : "pointer",
                        }}
                      >
                        ✓ Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => void providerAction(item, "charity_care")}
                        disabled={providerActionId === item.id}
                        style={{
                          padding: "7px 10px",
                          borderRadius: 6,
                          border: "1px solid #cbd5e1",
                          background: "#fff",
                          color: "#475569",
                          fontSize: 12.5,
                          fontWeight: 600,
                          cursor: providerActionId === item.id ? "default" : "pointer",
                        }}
                      >
                        ♥ Charity Care
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setDiscountModal({
                            item,
                            amount: String(item.patientResponsibility ?? ""),
                          })
                        }
                        disabled={providerActionId === item.id}
                        style={{
                          padding: "7px 10px",
                          borderRadius: 6,
                          border: "1px solid #cbd5e1",
                          background: "#fff",
                          color: "#7a5000",
                          fontSize: 12.5,
                          fontWeight: 600,
                          cursor: providerActionId === item.id ? "default" : "pointer",
                        }}
                      >
                        % Discount
                      </button>
                    </>
                  ) : (
                    // Standard eligibility routing actions
                    <>
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
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleExpanded(item)}
                    aria-expanded={isExpanded}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid #CBD5E1",
                      background: isExpanded ? "#F1F5F9" : "#FFFFFF",
                      color: "#334155",
                      fontSize: 12.5,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {isExpanded ? "Hide comments" : "Comments"}
                    {item.commentCount > 0 ? (
                      <span
                        title={`${item.commentCount} comment${item.commentCount === 1 ? "" : "s"}`}
                        style={{
                          marginLeft: 6,
                          background: isExpanded ? "#1D4ED8" : "#E0E7FF",
                          color: isExpanded ? "#FFFFFF" : "#3730A3",
                          borderRadius: 999,
                          padding: "1px 7px",
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {item.commentCount}
                      </span>
                    ) : null}
                  </button>
                </div>
                </div>
                {remindersOpenId === item.id ? (
                  <RemindersPanel state={remindersById[item.id]} />
                ) : null}
                {isExpanded ? (
                  <div
                    style={{
                      borderTop: "1px solid #E2E8F0",
                      paddingTop: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
                      Conversation
                    </div>
                    {commentsState?.loading && !commentsState.comments.length ? (
                      <div style={{ color: "#64748B", fontSize: 12.5 }}>Loading comments…</div>
                    ) : commentsState?.error ? (
                      <div style={{ color: "#B91C1C", fontSize: 12.5 }}>{commentsState.error}</div>
                    ) : commentsState?.comments.length ? (
                      <ul
                        style={{
                          listStyle: "none",
                          padding: 0,
                          margin: 0,
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                        }}
                      >
                        {commentsState.comments.map((c) => (
                          <li
                            key={c.id}
                            style={{
                              background: "#F8FAFC",
                              border: "1px solid #E2E8F0",
                              borderRadius: 6,
                              padding: "8px 10px",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                gap: 8,
                                alignItems: "baseline",
                                justifyContent: "space-between",
                              }}
                            >
                              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#0F172A" }}>
                                {c.authorName}
                                {c.type && c.type !== "note" ? (
                                  <span
                                    style={{
                                      marginLeft: 6,
                                      fontSize: 10.5,
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      color: "#475569",
                                      background: "#E2E8F0",
                                      padding: "1px 6px",
                                      borderRadius: 4,
                                    }}
                                  >
                                    {c.type.replace(/_/g, " ")}
                                  </span>
                                ) : null}
                              </span>
                              <span
                                style={{ fontSize: 11.5, color: "#94A3B8" }}
                                title={c.createdAt}
                              >
                                {relative(c.createdAt)}
                              </span>
                            </div>
                            <div
                              style={{
                                marginTop: 4,
                                fontSize: 13,
                                color: "#334155",
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              {c.body}
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div style={{ color: "#94A3B8", fontSize: 12.5 }}>
                        No comments yet. Add one to keep the biller in the loop.
                      </div>
                    )}

                    {commentsState && !commentsState.canComment && !commentsState.loading ? (
                      <div style={{ color: "#94A3B8", fontSize: 12 }}>
                        Only the current assignee can post here.
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <textarea
                          value={draft}
                          onChange={(e) =>
                            setDraftById((prev) => ({ ...prev, [item.id]: e.target.value }))
                          }
                          placeholder="e.g. Left voicemail with patient — will follow up tomorrow"
                          rows={2}
                          style={{
                            width: "100%",
                            resize: "vertical",
                            padding: 8,
                            border: "1px solid #CBD5E1",
                            borderRadius: 6,
                            fontSize: 13,
                            fontFamily: "inherit",
                          }}
                        />
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            onClick={() => void postComment(item.id)}
                            disabled={postingId === item.id || !draft.trim()}
                            style={{
                              padding: "6px 12px",
                              borderRadius: 6,
                              border: "1px solid #1D4ED8",
                              background:
                                postingId === item.id || !draft.trim() ? "#EFF6FF" : "#1D4ED8",
                              color:
                                postingId === item.id || !draft.trim() ? "#1D4ED8" : "#FFFFFF",
                              fontSize: 12.5,
                              fontWeight: 600,
                              cursor:
                                postingId === item.id || !draft.trim() ? "default" : "pointer",
                            }}
                          >
                            {postingId === item.id ? "Posting…" : "Add comment"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/* spacer */}
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

      {/* ── Discount Modal ─────────────────────────────────────────────── */}
      {discountModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            zIndex: 1200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={(e) => e.target === e.currentTarget && setDiscountModal(null)}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 10,
              width: "100%",
              maxWidth: 380,
              padding: "24px 22px 18px",
              boxShadow: "0 8px 32px rgba(16,36,63,.18)",
            }}
          >
            <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 700, color: "#0F172A" }}>
              Set Discounted Amount
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: 12, color: "#64748b" }}>
              Enter the new amount the patient should be charged for{" "}
              <strong>{discountModal.item.clientName ?? "this patient"}</strong>.
              {discountModal.item.patientResponsibility != null && (
                <> Original: <strong>${Number(discountModal.item.patientResponsibility).toFixed(2)}</strong>.</>
              )}
            </p>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 4, textTransform: "uppercase" }}>
              New Patient Amount ($)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={discountModal.amount}
              onChange={(e) => setDiscountModal((prev) => prev ? { ...prev, amount: e.target.value } : null)}
              style={{
                width: "100%",
                padding: "8px 10px",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                fontSize: 14,
                marginBottom: 18,
                boxSizing: "border-box",
              }}
              autoFocus
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setDiscountModal(null)}
                style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#fff", fontSize: 13, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                disabled={providerActionId === discountModal.item.id}
                onClick={() => {
                  const amt = parseFloat(discountModal.amount);
                  if (!Number.isFinite(amt) || amt < 0) return;
                  void providerAction(discountModal.item, "discount", amt);
                }}
                style={{
                  padding: "8px 18px",
                  borderRadius: 6,
                  border: "none",
                  background: "#7a5000",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: providerActionId === discountModal.item.id ? "not-allowed" : "pointer",
                }}
              >
                {providerActionId === discountModal.item.id ? "Saving…" : "Apply Discount"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RemindersPanel({ state }: { state: RemindersState | undefined }) {
  return (
    <div
      style={{
        borderTop: "1px solid #FCD34D",
        background: "#FFFBEB",
        padding: "10px 12px",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: "#92400E" }}>
        Reminder history
      </div>
      {!state || state.loading ? (
        <div style={{ fontSize: 12.5, color: "#92400E" }}>
          Loading reminder history…
        </div>
      ) : state.error ? (
        <div style={{ fontSize: 12.5, color: "#B91C1C" }}>{state.error}</div>
      ) : state.reminders.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "#92400E" }}>
          No reminders have been sent yet.
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {state.reminders.map((r) => (
            <li
              key={r.id}
              style={{
                background: "#FFFFFF",
                border: "1px solid #FDE68A",
                borderRadius: 6,
                padding: "6px 10px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 12.5,
                color: "#334155",
              }}
            >
              <span
                style={{
                  fontWeight: 700,
                  color: "#92400E",
                  minWidth: 38,
                }}
              >
                #{r.reminderNumber ?? "?"}
              </span>
              <span title={r.sentAt}>{formatWhen(r.sentAt)}</span>
              <span style={{ color: "#94A3B8" }}>·</span>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: 0.04,
                  textTransform: "uppercase",
                  background: r.emailSent ? "#DCFCE7" : "#FEE2E2",
                  color: r.emailSent ? "#166534" : "#B91C1C",
                  padding: "2px 6px",
                  borderRadius: 4,
                }}
              >
                {r.emailSent ? "Email delivered" : "Email not sent"}
              </span>
              <span style={{ color: "#94A3B8", marginLeft: "auto" }}>
                {relative(r.sentAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
