"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type Profile = { id: string; fullName: string; email: string; role: string };

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

  // Poll for new messages every 5s on selected conversation; also refresh list every 15s.
  useEffect(() => {
    if (!currentUserId) return;
    const id = window.setInterval(() => void loadConversations(), 15000);
    return () => window.clearInterval(id);
  }, [currentUserId, loadConversations]);

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

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void loadMessages(selectedId, true);
    const id = window.setInterval(() => void loadMessages(selectedId, false), 5000);
    return () => window.clearInterval(id);
  }, [selectedId, loadMessages]);

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
                  <strong>{label}</strong>
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
                  <h2>{conversationLabel(selected, currentUserId)}</h2>
                  <p className="muted-text">
                    {otherParticipants(selected, currentUserId).map((p) => `${p.fullName} (${roleBadge(p.role)})`).join(" · ") || "Just you"}
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
                Acting as {currentProfile?.fullName || "—"} · messages refresh every 5 seconds.
              </p>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
