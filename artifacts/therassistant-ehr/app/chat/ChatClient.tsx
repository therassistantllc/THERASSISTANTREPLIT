"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import { supabase } from "@/lib/supabase/client";

type Profile = { id: string; fullName: string; email: string; role: string };

// ── Presence model (Task #124) ────────────────────────────────────────────
type PresenceState = "online" | "idle" | "offline" | "unknown";
// Store raw beat data only; derive state at render time so the 15s
// re-render clock can age users from online → idle → offline without
// needing a fresh presence event.
type PresenceMap = Record<string, { focused: boolean; lastSeenAt: number }>;
// Online if presence beat in the last 60s; idle if last 5min.
const ONLINE_WINDOW_MS = 60_000;
const IDLE_WINDOW_MS = 5 * 60_000;
// Local idle threshold: flip own tab to idle after this much no-activity.
const LOCAL_IDLE_AFTER_MS = 60_000;
// Reconcile messages every 30s as a Realtime safety net.
const MESSAGE_RECONCILE_MS = 30_000;

type Conversation = {
  id: string;
  conversationType: string;
  title: string;
  relatedClientId: string;
  relatedWorkqueueItemId: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  participants: Array<{ userId: string; fullName: string; role: string }>;
  lastMessage: { body: string; createdAt: string; senderUserId: string } | null;
  unreadCount: number;
};

type Message = {
  id: string;
  senderUserId: string;
  senderName: string;
  senderRole: string;
  body: string;
  attachmentPath: string;
  attachmentFileName: string;
  createdAt: string;
  editedAt: string;
};

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

function setUserIdInUrl(userId: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (userId) url.searchParams.set("userId", userId);
  else url.searchParams.delete("userId");
  window.history.replaceState({}, "", url.toString());
}

function formatTime(value: string) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function derivePresenceState(lastSeenAt: number, focused: boolean): PresenceState {
  const age = Date.now() - lastSeenAt;
  if (focused && age <= ONLINE_WINDOW_MS) return "online";
  if (age <= IDLE_WINDOW_MS) return "idle";
  return "offline";
}

function presenceDot(state: PresenceState) {
  const color =
    state === "online" ? "#10b981"
    : state === "idle" ? "#f59e0b"
    : state === "unknown" ? "#9ca3af"
    : "#d1d5db";
  const title =
    state === "online" ? "Online"
    : state === "idle" ? "Idle"
    : state === "unknown" ? "Status unknown (connection issue)"
    : "Offline";
  return (
    <span
      aria-label={title}
      title={title}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        marginRight: 6,
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    />
  );
}

function roleBadge(role: string) {
  const r = (role || "").toLowerCase();
  if (r === "biller") return "Biller";
  if (r === "clinician") return "Clinician";
  if (r === "supervisor") return "Supervisor";
  if (r === "admin") return "Admin";
  return role || "Staff";
}

function otherParticipants(c: Conversation, currentUserId: string) {
  return c.participants.filter((p) => p.userId !== currentUserId);
}

function conversationLabel(c: Conversation, currentUserId: string) {
  if (c.title) return c.title;
  const others = otherParticipants(c, currentUserId);
  if (others.length === 0) return "Just you";
  if (others.length === 1) return `${others[0].fullName} (${roleBadge(others[0].role)})`;
  return others.map((p) => p.fullName).join(", ");
}

export default function ChatClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loadingConvos, setLoadingConvos] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newPartner, setNewPartner] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // ── Presence + realtime (Task #124) ────────────────────────────────────
  const [presence, setPresence] = useState<PresenceMap>({});
  // Realtime connection state: connected (presence reliable),
  // disconnected (fall back to polling + render presence as 'unknown').
  const [realtimeOk, setRealtimeOk] = useState<boolean>(true);
  // Force-rerender clock so presence dots age out without external events.
  const [, setNow] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNow((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  // Load profiles + bootstrap current user.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/chat/profiles?organizationId=${organizationId}`, { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; profiles?: Profile[]; error?: string };
      if (cancelled) return;
      if (!res.ok || !json.success) {
        setError(json.error || "Failed to load staff list.");
        return;
      }
      const list = json.profiles ?? [];
      setProfiles(list);
      const urlUser = getUserIdFromUrl();
      const initial = urlUser && list.some((p) => p.id === urlUser) ? urlUser : list[0]?.id ?? "";
      setCurrentUserId(initial);
      if (initial) setUserIdInUrl(initial);
    })();
    return () => { cancelled = true; };
  }, [organizationId]);

  const loadConversations = useCallback(async () => {
    if (!currentUserId) return;
    setLoadingConvos(true);
    setError(null);
    const res = await fetch(
      `/api/chat/conversations?organizationId=${organizationId}&userId=${currentUserId}`,
      { cache: "no-store" },
    );
    const json = (await res.json()) as { success?: boolean; conversations?: Conversation[]; error?: string };
    if (!res.ok || !json.success) {
      setError(json.error || "Failed to load conversations.");
      setConversations([]);
    } else {
      setConversations(json.conversations ?? []);
    }
    setLoadingConvos(false);
  }, [organizationId, currentUserId]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Refresh conversation list every 15s (cheap, keeps unread counters fresh).
  useEffect(() => {
    if (!currentUserId) return;
    const id = window.setInterval(() => void loadConversations(), 15000);
    return () => window.clearInterval(id);
  }, [currentUserId, loadConversations]);

  // Presence channel: one channel per org, key = userId so multiple tabs
  // for the same user collapse to a single online entry.
  useEffect(() => {
    if (!currentUserId || !organizationId) return;
    const channelName = `chat-presence:${organizationId}`;
    const channel = supabase.channel(channelName, {
      config: { presence: { key: currentUserId } },
    });

    let focused =
      typeof document === "undefined" ? true : document.visibilityState === "visible";
    let lastActivity = Date.now();

    const broadcast = () => {
      void channel.track({
        userId: currentUserId,
        focused,
        lastSeenAt: Date.now(),
      });
    };

    const recomputeFromChannel = () => {
      const raw = channel.presenceState() as Record<
        string,
        Array<{ userId?: string; focused?: boolean; lastSeenAt?: number }>
      >;
      const next: PresenceMap = {};
      for (const key of Object.keys(raw)) {
        // Latest presence beat across this user's open tabs wins.
        let bestAt = 0;
        let bestFocused = false;
        for (const meta of raw[key] ?? []) {
          const at = Number(meta?.lastSeenAt ?? 0);
          if (at > bestAt) {
            bestAt = at;
            bestFocused = Boolean(meta?.focused);
          }
        }
        if (bestAt > 0) {
          next[key] = { focused: bestFocused, lastSeenAt: bestAt };
        }
      }
      setPresence(next);
    };

    channel
      .on("presence", { event: "sync" }, recomputeFromChannel)
      .on("presence", { event: "join" }, recomputeFromChannel)
      .on("presence", { event: "leave" }, recomputeFromChannel)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setRealtimeOk(true);
          broadcast();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setRealtimeOk(false);
        }
      });

    // Heartbeat: re-broadcast every 25s so other tabs see us as fresh.
    const heartbeat = window.setInterval(broadcast, 25_000);

    // Local idle: if no input/visibility for LOCAL_IDLE_AFTER_MS, flip
    // focused=false on our next beat so others see us as idle.
    const onActivity = () => {
      const wasIdle = !focused;
      lastActivity = Date.now();
      if (wasIdle) {
        focused = document.visibilityState === "visible";
        broadcast();
      }
    };
    const idleCheck = window.setInterval(() => {
      if (focused && Date.now() - lastActivity > LOCAL_IDLE_AFTER_MS) {
        focused = false;
        broadcast();
      }
    }, 15_000);

    const onVisibility = () => {
      focused = document.visibilityState === "visible";
      lastActivity = Date.now();
      broadcast();
    };
    const onBlur = () => {
      focused = false;
      broadcast();
    };
    const onFocus = () => {
      focused = true;
      lastActivity = Date.now();
      broadcast();
    };
    const onUnload = () => {
      void channel.untrack();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);

    return () => {
      window.clearInterval(heartbeat);
      window.clearInterval(idleCheck);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      void channel.untrack();
      void supabase.removeChannel(channel);
    };
  }, [currentUserId, organizationId]);

  const loadMessages = useCallback(async (conversationId: string, markRead = true) => {
    if (!currentUserId) return;
    setLoadingMessages(true);
    const res = await fetch(
      `/api/chat/conversations/${conversationId}/messages?organizationId=${organizationId}&userId=${currentUserId}${markRead ? "&markRead=1" : ""}`,
      { cache: "no-store" },
    );
    const json = (await res.json()) as { success?: boolean; messages?: Message[]; error?: string };
    if (!res.ok || !json.success) {
      setError(json.error || "Failed to load messages.");
      setMessages([]);
    } else {
      setMessages(json.messages ?? []);
    }
    setLoadingMessages(false);
  }, [organizationId, currentUserId]);

  // Live message arrival via Supabase Realtime, with a 30s reconciliation
  // poll as a safety net. If Realtime drops, the poll picks up the slack.
  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void loadMessages(selectedId, true);

    const channel = supabase
      .channel(`chat-messages:${selectedId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `conversation_id=eq.${selectedId}`,
        },
        () => {
          // Reload via the API to get the joined sender profile, role
          // badge, and read-mark side effect — cheaper to re-fetch than
          // to maintain a parallel join client-side.
          void loadMessages(selectedId, true);
          void loadConversations();
        },
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setRealtimeOk(false);
        } else if (status === "SUBSCRIBED") {
          setRealtimeOk(true);
        }
      });

    // Safety net poll. Faster when realtime is down (5s) so the user
    // experience degrades gracefully; slow (30s) when realtime is healthy.
    const pollMs = realtimeOk ? MESSAGE_RECONCILE_MS : 5000;
    const id = window.setInterval(() => void loadMessages(selectedId, false), pollMs);
    return () => {
      window.clearInterval(id);
      void supabase.removeChannel(channel);
    };
  }, [selectedId, loadMessages, loadConversations, realtimeOk]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, selectedId]);

  async function sendMessage() {
    if (!selected || !draft.trim() || !currentUserId) return;
    setSending(true);
    const res = await fetch(`/api/chat/conversations/${selected.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, senderUserId: currentUserId, body: draft }),
    });
    const json = (await res.json()) as { success?: boolean; error?: string };
    if (!res.ok || !json.success) {
      setError(json.error || "Failed to send message.");
    } else {
      setDraft("");
      await loadMessages(selected.id, true);
      await loadConversations();
    }
    setSending(false);
  }

  async function createConversation() {
    if (!currentUserId || !newPartner || newPartner === currentUserId) return;
    setError(null);
    const res = await fetch(`/api/chat/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        currentUserId,
        participantUserIds: [currentUserId, newPartner],
        conversationType: "direct",
      }),
    });
    const json = (await res.json()) as { success?: boolean; conversationId?: string; error?: string };
    if (!res.ok || !json.success || !json.conversationId) {
      setError(json.error || "Failed to start conversation.");
      return;
    }
    setShowNew(false);
    setNewPartner("");
    await loadConversations();
    setSelectedId(json.conversationId);
  }

  const currentProfile = profiles.find((p) => p.id === currentUserId) ?? null;
  // Aggregate presence for a conversation: best of the other participants.
  function conversationPresenceState(c: Conversation): PresenceState {
    if (!realtimeOk) return "unknown";
    const others = otherParticipants(c, currentUserId);
    let best: PresenceState = "offline";
    const rank: Record<PresenceState, number> = {
      online: 3, idle: 2, unknown: 1, offline: 0,
    };
    for (const p of others) {
      const beat = presence[p.userId];
      const ps: PresenceState = beat
        ? derivePresenceState(beat.lastSeenAt, beat.focused)
        : "offline";
      if (rank[ps] > rank[best]) best = ps;
    }
    return best;
  }
  function userPresenceState(userId: string): PresenceState {
    if (!realtimeOk) return "unknown";
    const beat = presence[userId];
    if (!beat) return "offline";
    return derivePresenceState(beat.lastSeenAt, beat.focused);
  }
  const billers = profiles.filter((p) => p.role === "biller" && p.id !== currentUserId);
  const otherProfiles = profiles.filter((p) => p.id !== currentUserId);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Chat</p>
          <h1>Message your team</h1>
          <p className="hero-copy">
            Real-time chat with your billers, clinicians, and admins. Use this to resolve coding questions,
            eligibility questions, or anything else that needs a quick back-and-forth instead of a workqueue item.
          </p>
        </div>
        <div className="hero-actions">
          <label className="field-label compact-field" style={{ minWidth: 220 }}>
            Acting as
            <select
              value={currentUserId}
              onChange={(e) => {
                const id = e.target.value;
                setCurrentUserId(id);
                setUserIdInUrl(id);
                setSelectedId(null);
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName} — {roleBadge(p.role)}
                </option>
              ))}
            </select>
          </label>
          <button className="button" type="button" onClick={() => setShowNew((v) => !v)} disabled={!currentUserId}>
            {showNew ? "Cancel" : "New chat"}
          </button>
        </div>
      </section>

      {error ? <div className="alert-panel">{error}</div> : null}

      {showNew ? (
        <section className="panel" style={{ padding: 16, display: "grid", gap: 10 }}>
          <strong>Start a new direct chat</strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
            <label className="field-label compact-field" style={{ minWidth: 260 }}>
              With
              <select value={newPartner} onChange={(e) => setNewPartner(e.target.value)}>
                <option value="">Choose a teammate…</option>
                {billers.length > 0 ? (
                  <optgroup label="Billers">
                    {billers.map((p) => (
                      <option key={p.id} value={p.id}>{p.fullName}</option>
                    ))}
                  </optgroup>
                ) : null}
                <optgroup label="Everyone else">
                  {otherProfiles
                    .filter((p) => p.role !== "biller")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.fullName} — {roleBadge(p.role)}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
            <button className="button" type="button" onClick={() => void createConversation()} disabled={!newPartner}>
              Start chat
            </button>
          </div>
          <p className="muted-text">Existing direct conversation with the same teammate will be reused.</p>
        </section>
      ) : null}

      <section className="workqueue-layout">
        <div className="workqueue-list panel">
          <div className="workqueue-list-header">
            <strong>Conversations</strong>
            <span className="muted-text">{conversations.length}</span>
          </div>
          {loadingConvos ? <div className="empty-state">Loading…</div> : null}
          {!loadingConvos && conversations.length === 0 ? (
            <div className="empty-state">No conversations yet. Start one with the New chat button.</div>
          ) : null}
          {conversations.map((c) => {
            const others = otherParticipants(c, currentUserId);
            const label = conversationLabel(c, currentUserId);
            const subRole = others[0]?.role ? roleBadge(others[0].role) : c.conversationType;
            return (
              <div
                key={c.id}
                className={`workqueue-list-item-row ${selectedId === c.id ? "selected" : ""}`}
              >
                <button
                  className="workqueue-list-item"
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  style={{ alignItems: "flex-start" }}
                >
                  <span className={`status-pill ${c.unreadCount > 0 ? "urgent" : "normal"}`}>
                    {c.unreadCount > 0 ? c.unreadCount : subRole}
                  </span>
                  <strong>
                    {presenceDot(conversationPresenceState(c))}
                    {label}
                  </strong>
                  <span style={{ color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.lastMessage?.body || "No messages yet"}
                  </span>
                  <span className="muted-text">{formatTime(c.lastMessage?.createdAt || c.updatedAt)}</span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="workqueue-detail panel">
          {!selected ? <div className="empty-state">Select a conversation.</div> : null}
          {selected ? (
            <>
              <div className="detail-header">
                <div>
                  <p className="eyebrow">{selected.conversationType.replace("_", " ")}</p>
                  <h2 style={{ display: "flex", alignItems: "center" }}>
                    {presenceDot(conversationPresenceState(selected))}
                    {conversationLabel(selected, currentUserId)}
                  </h2>
                  <p className="muted-text" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {otherParticipants(selected, currentUserId).length === 0
                      ? "Just you"
                      : otherParticipants(selected, currentUserId).map((p, i) => (
                          <span key={p.userId} style={{ display: "inline-flex", alignItems: "center" }}>
                            {i > 0 ? <span style={{ margin: "0 4px" }}>·</span> : null}
                            {presenceDot(userPresenceState(p.userId))}
                            {p.fullName} ({roleBadge(p.role)})
                          </span>
                        ))}
                  </p>
                </div>
              </div>

              <div
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 12,
                  height: 420,
                  overflowY: "auto",
                  background: "#fafafa",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {loadingMessages && messages.length === 0 ? <div className="muted-text">Loading…</div> : null}
                {!loadingMessages && messages.length === 0 ? (
                  <div className="muted-text">No messages yet. Say hello.</div>
                ) : null}
                {messages.map((m) => {
                  const mine = m.senderUserId === currentUserId;
                  return (
                    <div
                      key={m.id}
                      style={{
                        alignSelf: mine ? "flex-end" : "flex-start",
                        maxWidth: "78%",
                        background: mine ? "#2563eb" : "#ffffff",
                        color: mine ? "#ffffff" : "#111827",
                        border: mine ? "none" : "1px solid #e5e7eb",
                        padding: "8px 12px",
                        borderRadius: 12,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {!mine ? (
                        <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 2, color: "#374151" }}>
                          {m.senderName} · {roleBadge(m.senderRole)}
                        </div>
                      ) : null}
                      <div>{m.body}</div>
                      <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7, textAlign: "right" }}>
                        {formatTime(m.createdAt)}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendMessage();
                    }
                  }}
                  placeholder={`Message ${conversationLabel(selected, currentUserId)} (Enter to send)`}
                  style={{ flex: 1, minHeight: 60, padding: 8, borderRadius: 6, border: "1px solid #e5e7eb" }}
                />
                <button
                  className="button"
                  type="button"
                  onClick={() => void sendMessage()}
                  disabled={sending || !draft.trim()}
                  style={{ alignSelf: "stretch" }}
                >
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
              <p className="muted-text" style={{ marginTop: 8 }}>
                Acting as {currentProfile?.fullName || "—"} ·{" "}
                {realtimeOk
                  ? "live updates on (presence + new messages)"
                  : "live updates unavailable — falling back to polling every 5s"}
              </p>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
