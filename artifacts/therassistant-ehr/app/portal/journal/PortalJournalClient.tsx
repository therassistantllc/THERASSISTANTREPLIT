"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ENTRY_TYPES,
  EntryType,
  JournalEntry,
  entryTypeLabel,
} from "@/lib/portal/journal";

function formatReviewedDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type DraftState = {
  open: boolean;
  type: EntryType;
  text: string;
  trigger: string;
  context: string;
  intensity: number;
  strategy: string;
  outcome: string;
  helped: "yes" | "somewhat" | "no" | "";
  caption: string;
  tags: string;
};

const EMPTY_DRAFT: DraftState = {
  open: false,
  type: "reflection",
  text: "",
  trigger: "",
  context: "",
  intensity: 5,
  strategy: "",
  outcome: "",
  helped: "",
  caption: "",
  tags: "",
};

export default function PortalJournalClient() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<"all" | EntryType>("all");
  const [editingId, setEditingId] = useState<string | null>(null);

  // Voice recording state
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [recordedSeconds, setRecordedSeconds] = useState<number>(0);
  const recordStartRef = useRef<number>(0);
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/journal", { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; error?: string; entries?: JournalEntry[] };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load journal");
      setEntries(json.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load journal");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function resetDraft() {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    setRecordedBlob(null);
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecordedUrl(null);
    setRecordedSeconds(0);
    setUploadFile(null);
  }

  function openNew(type: EntryType) {
    resetDraft();
    setDraft({ ...EMPTY_DRAFT, open: true, type });
  }

  function openEdit(entry: JournalEntry) {
    resetDraft();
    setEditingId(entry.id);
    setDraft({
      open: true,
      type: entry.entryType,
      text: String(entry.body.text ?? ""),
      trigger: String(entry.body.trigger ?? ""),
      context: String(entry.body.context ?? ""),
      intensity:
        typeof entry.body.intensity === "number" ? (entry.body.intensity as number) : 5,
      strategy: String(entry.body.strategy ?? ""),
      outcome: String(entry.body.outcome ?? ""),
      helped: (entry.body.helped as "yes" | "somewhat" | "no" | undefined) ?? "",
      caption: String(entry.body.caption ?? ""),
      tags: entry.tags.join(", "),
    });
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (recordedUrl) URL.revokeObjectURL(recordedUrl);
        setRecordedBlob(blob);
        setRecordedUrl(URL.createObjectURL(blob));
        setRecordedSeconds(Math.round((Date.now() - recordStartRef.current) / 1000));
        stream.getTracks().forEach((t) => t.stop());
      };
      recorderRef.current = recorder;
      recordStartRef.current = Date.now();
      recorder.start();
      setRecording(true);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not start recording: ${e.message}. You can upload an audio file instead.`
          : "Could not start recording. You can upload an audio file instead.",
      );
    }
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    setRecording(false);
  }

  function buildBody(): Record<string, unknown> {
    switch (draft.type) {
      case "reflection":
      case "pattern":
        return { text: draft.text };
      case "trigger":
        return { trigger: draft.trigger, context: draft.context, intensity: draft.intensity };
      case "coping":
        return { strategy: draft.strategy, outcome: draft.outcome, helped: draft.helped };
      case "voice_note":
        return { caption: draft.caption };
    }
  }

  async function uploadAudioFor(entryId: string): Promise<void> {
    const blob = recordedBlob ?? uploadFile;
    if (!blob) return;
    const form = new FormData();
    const filename = uploadFile?.name ?? `recording.${(blob.type || "audio/webm").split("/")[1] ?? "webm"}`;
    form.append("audio", blob, filename);
    if (recordedSeconds > 0) form.append("durationSeconds", String(recordedSeconds));
    const res = await fetch(`/api/portal/journal/${entryId}/audio`, {
      method: "POST",
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? "Failed to upload audio");
    }
  }

  async function saveEntry() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const tags = draft.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const body = buildBody();
      let entryId = editingId;
      if (editingId) {
        const res = await fetch(`/api/portal/journal/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body, tags }),
        });
        const json = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to save entry");
      } else {
        const res = await fetch("/api/portal/journal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entryType: draft.type, body, tags }),
        });
        const json = (await res.json()) as { success?: boolean; error?: string; entry?: JournalEntry };
        if (!res.ok || !json.success || !json.entry) {
          throw new Error(json.error ?? "Failed to save entry");
        }
        entryId = json.entry.id;
      }
      if (draft.type === "voice_note" && entryId && (recordedBlob || uploadFile)) {
        await uploadAudioFor(entryId);
      }
      setMessage(editingId ? "Entry updated." : "Entry saved.");
      resetDraft();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save entry");
    } finally {
      setSaving(false);
    }
  }

  async function deleteEntry(entryId: string) {
    if (typeof window !== "undefined" && !window.confirm("Delete this entry?")) return;
    setError(null);
    try {
      const res = await fetch(`/api/portal/journal/${entryId}`, { method: "DELETE" });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to delete entry");
      setMessage("Entry deleted.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete entry");
    }
  }

  const visible = filter === "all" ? entries : entries.filter((e) => e.entryType === filter);

  return (
    <main className="portal-shell">
      <header className="portal-header">
        <div>
          <div className="eyebrow">Client portal</div>
          <h1>Journal</h1>
        </div>
        <Link href="/portal/home" className="button button-secondary">Back to portal</Link>
      </header>

      <section className="panel portal-section">
        <p className="muted" style={{ marginTop: 0 }}>
          A private space to log reflections, voice notes, triggers, coping strategies, and
          patterns you&apos;re noticing between sessions. Your care team can review your entries
          and may pull individual ones into your visit notes.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {ENTRY_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className="button"
              onClick={() => openNew(t)}
              disabled={draft.open}
            >
              + {entryTypeLabel(t)}
            </button>
          ))}
        </div>
      </section>

      {message ? <div className="empty-state success-panel">{message}</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}

      {draft.open ? (
        <section className="panel portal-section">
          <h2 className="portal-section-title">
            {editingId ? "Edit" : "New"} {entryTypeLabel(draft.type).toLowerCase()}
          </h2>
          {(draft.type === "reflection" || draft.type === "pattern") && (
            <label style={{ display: "block", marginTop: 8 }}>
              <span style={{ display: "block", marginBottom: 4, fontWeight: 600 }}>
                {draft.type === "reflection" ? "What's on your mind?" : "What pattern are you noticing?"}
              </span>
              <textarea
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                rows={6}
                style={{ width: "100%", padding: 8 }}
              />
            </label>
          )}
          {draft.type === "trigger" && (
            <>
              <label style={{ display: "block", marginTop: 8 }}>
                <span style={{ display: "block", marginBottom: 4, fontWeight: 600 }}>What triggered you?</span>
                <input
                  type="text"
                  value={draft.trigger}
                  onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
                  style={{ width: "100%", padding: 8 }}
                />
              </label>
              <label style={{ display: "block", marginTop: 8 }}>
                <span style={{ display: "block", marginBottom: 4, fontWeight: 600 }}>
                  Intensity: {draft.intensity}/10
                </span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={draft.intensity}
                  onChange={(e) => setDraft({ ...draft, intensity: Number(e.target.value) })}
                  style={{ width: "100%" }}
                />
              </label>
              <label style={{ display: "block", marginTop: 8 }}>
                <span style={{ display: "block", marginBottom: 4, fontWeight: 600 }}>Context</span>
                <textarea
                  value={draft.context}
                  onChange={(e) => setDraft({ ...draft, context: e.target.value })}
                  rows={3}
                  style={{ width: "100%", padding: 8 }}
                />
              </label>
            </>
          )}
          {draft.type === "coping" && (
            <>
              <label style={{ display: "block", marginTop: 8 }}>
                <span style={{ display: "block", marginBottom: 4, fontWeight: 600 }}>Strategy you tried</span>
                <input
                  type="text"
                  value={draft.strategy}
                  onChange={(e) => setDraft({ ...draft, strategy: e.target.value })}
                  style={{ width: "100%", padding: 8 }}
                />
              </label>
              <label style={{ display: "block", marginTop: 8 }}>
                <span style={{ display: "block", marginBottom: 4, fontWeight: 600 }}>What happened</span>
                <textarea
                  value={draft.outcome}
                  onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}
                  rows={3}
                  style={{ width: "100%", padding: 8 }}
                />
              </label>
              <fieldset style={{ marginTop: 8, border: "none", padding: 0 }}>
                <legend style={{ fontWeight: 600, marginBottom: 4 }}>Did it help?</legend>
                {(["yes", "somewhat", "no"] as const).map((opt) => (
                  <label key={opt} style={{ marginRight: 12 }}>
                    <input
                      type="radio"
                      name="helped"
                      value={opt}
                      checked={draft.helped === opt}
                      onChange={() => setDraft({ ...draft, helped: opt })}
                    />{" "}
                    {opt}
                  </label>
                ))}
              </fieldset>
            </>
          )}
          {draft.type === "voice_note" && (
            <>
              <label style={{ display: "block", marginTop: 8 }}>
                <span style={{ display: "block", marginBottom: 4, fontWeight: 600 }}>Caption (optional)</span>
                <input
                  type="text"
                  value={draft.caption}
                  onChange={(e) => setDraft({ ...draft, caption: e.target.value })}
                  style={{ width: "100%", padding: 8 }}
                />
              </label>
              <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                {!recording ? (
                  <button type="button" className="button" onClick={startRecording}>
                    {recordedBlob ? "Re-record" : "Record audio"}
                  </button>
                ) : (
                  <button type="button" className="button" onClick={stopRecording}>
                    Stop recording
                  </button>
                )}
                <span className="muted" style={{ fontSize: 13 }}>or upload an audio file:</span>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                />
              </div>
              {recordedUrl && !recording ? (
                <div style={{ marginTop: 8 }}>
                  <audio controls src={recordedUrl} />
                  {recordedSeconds > 0 ? (
                    <div className="muted" style={{ fontSize: 12 }}>{recordedSeconds}s recorded</div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
          <label style={{ display: "block", marginTop: 12 }}>
            <span style={{ display: "block", marginBottom: 4, fontWeight: 600 }}>Tags (comma separated)</span>
            <input
              type="text"
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              style={{ width: "100%", padding: 8 }}
            />
          </label>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button
              type="button"
              className="button"
              onClick={saveEntry}
              disabled={saving}
            >
              {saving ? "Saving…" : editingId ? "Save changes" : "Save entry"}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={resetDraft}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel portal-section" aria-labelledby="entries-heading">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <h2 id="entries-heading" className="portal-section-title">Your entries</h2>
          <label style={{ fontSize: 13 }}>
            Filter:{" "}
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">All types</option>
              {ENTRY_TYPES.map((t) => (
                <option key={t} value={t}>{entryTypeLabel(t)}</option>
              ))}
            </select>
          </label>
        </div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No entries yet. Use a button above to add your first one.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {visible.map((entry) => (
              <li key={entry.id} className="portal-item-row" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{entryTypeLabel(entry.entryType)}</strong>
                    <span className="muted" style={{ fontSize: 12 }}>{formatDateTime(entry.createdAt)}</span>
                    {entry.importedIntoNoteId ? (
                      <span className="status status-green" title="A clinician has imported this entry into your visit note">
                        Imported into note
                      </span>
                    ) : null}
                    {entry.reviewedAt && !entry.importedIntoNoteId ? (
                      <span
                        className="status status-blue"
                        title="Your care team saw this entry"
                      >
                        Reviewed
                        {entry.reviewedByName ? ` by ${entry.reviewedByName}` : ""}
                        {" "}on {formatReviewedDate(entry.reviewedAt)}
                      </span>
                    ) : null}
                  </div>
                  <EntryPreview entry={entry} />
                  {entry.tags.length > 0 ? (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Tags: {entry.tags.join(", ")}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {!entry.importedIntoNoteId ? (
                    <>
                      <button type="button" className="button button-secondary" onClick={() => openEdit(entry)}>
                        Edit
                      </button>
                      <button type="button" className="button button-secondary" onClick={() => deleteEntry(entry.id)}>
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function EntryPreview({ entry }: { entry: JournalEntry }) {
  const b = entry.body;
  switch (entry.entryType) {
    case "reflection":
    case "pattern":
      return <p style={{ margin: "6px 0 0 0", whiteSpace: "pre-wrap" }}>{String(b.text ?? "")}</p>;
    case "trigger":
      return (
        <div style={{ marginTop: 6, fontSize: 14 }}>
          <div><strong>Trigger:</strong> {String(b.trigger ?? "")}</div>
          {typeof b.intensity === "number" ? <div><strong>Intensity:</strong> {b.intensity}/10</div> : null}
          {b.context ? <div><strong>Context:</strong> {String(b.context)}</div> : null}
        </div>
      );
    case "coping":
      return (
        <div style={{ marginTop: 6, fontSize: 14 }}>
          <div><strong>Strategy:</strong> {String(b.strategy ?? "")}</div>
          {b.outcome ? <div><strong>Result:</strong> {String(b.outcome)}</div> : null}
          {b.helped ? <div><strong>Helped:</strong> {String(b.helped)}</div> : null}
        </div>
      );
    case "voice_note":
      return (
        <div style={{ marginTop: 6 }}>
          {entry.hasAudio ? (
            // Playback uses the GET endpoint which 302-redirects to a short-lived signed URL.
            <audio controls preload="none" src={`/api/portal/journal/${entry.id}/audio`} />
          ) : (
            <span className="muted">No audio attached</span>
          )}
          {b.caption ? <div style={{ marginTop: 4 }}>{String(b.caption)}</div> : null}
          {entry.audioTranscript ? (
            <div
              style={{
                marginTop: 6,
                padding: 8,
                background: "var(--surface-2, #f8fafc)",
                borderLeft: "3px solid var(--accent, #6366f1)",
                fontSize: 14,
                whiteSpace: "pre-wrap",
              }}
            >
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                Auto-transcript
              </div>
              {entry.audioTranscript}
            </div>
          ) : entry.hasAudio ? (
            <div className="muted" style={{ marginTop: 6, fontSize: 12, fontStyle: "italic" }}>
              Transcript not available yet — it usually appears within a minute.
            </div>
          ) : null}
        </div>
      );
  }
}
