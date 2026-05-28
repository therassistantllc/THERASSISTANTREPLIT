"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ENTRY_TYPES,
  EntryType,
  JournalEntry,
  SOAP_FIELDS,
  SoapField,
  entryTypeLabel,
  renderEntryAsText,
} from "@/lib/portal/journal";

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

export type ImportResult = {
  entry: JournalEntry;
  field: SoapField;
  text: string;
};

type Props = {
  clientId: string;
  organizationId: string;
  /**
   * "standalone" = chart-tab panel (no import controls).
   * "import" = invoked from inside the SOAP editor (selecting an entry calls
   * onImport and the parent inserts the text into the chosen field).
   */
  mode: "standalone" | "import";
  /** ISO timestamp; only entries created at/after this are listed. */
  since?: string | null;
  /**
   * When true, the server computes `since` as the signed_at of the most
   * recent signed clinical note for this client (the natural between-session
   * window). Combine with `excludeEncounterId` to skip the encounter
   * currently being edited.
   */
  windowSinceLastSigned?: boolean;
  excludeEncounterId?: string | null;
  /** Required when mode === "import"; receives the selected entry. */
  onImport?: (result: ImportResult) => Promise<void> | void;
};

export default function ClinicianJournalPanel({
  clientId,
  organizationId,
  mode,
  since,
  windowSinceLastSigned,
  excludeEncounterId,
  onImport,
}: Props) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<"all" | EntryType>("all");
  const [pickerField, setPickerField] = useState<Record<string, SoapField>>({});
  const [importingId, setImportingId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      if (since) params.set("since", since);
      if (windowSinceLastSigned) {
        params.set("windowSinceLastSigned", "1");
        if (excludeEncounterId) params.set("excludeEncounterId", excludeEncounterId);
      }
      if (mode === "import") params.set("onlyUnimported", "1");
      const res = await fetch(
        `/api/clients/${encodeURIComponent(clientId)}/journal?${params.toString()}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as { success?: boolean; error?: string; entries?: JournalEntry[] };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load journal");
      setEntries(json.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load journal");
    } finally {
      setLoading(false);
    }
  }, [clientId, organizationId, since, windowSinceLastSigned, excludeEncounterId, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (filterType === "all" ? entries : entries.filter((e) => e.entryType === filterType)),
    [entries, filterType],
  );

  // Group by calendar day for a scannable "between-session" feed.
  const grouped = useMemo(() => {
    const buckets = new Map<string, JournalEntry[]>();
    for (const e of visible) {
      const d = e.createdAt ? new Date(e.createdAt) : new Date();
      const key = Number.isNaN(d.getTime())
        ? "Unknown"
        : d.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          });
      const arr = buckets.get(key) ?? [];
      arr.push(e);
      buckets.set(key, arr);
    }
    return Array.from(buckets.entries());
  }, [visible]);

  async function handleReview(entry: JournalEntry) {
    if (entry.reviewedAt) return;
    setReviewingId(entry.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/clients/${encodeURIComponent(clientId)}/journal/${entry.id}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to mark as reviewed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mark as reviewed");
    } finally {
      setReviewingId(null);
    }
  }

  async function handleImport(entry: JournalEntry) {
    if (!onImport) return;
    const field = pickerField[entry.id] ?? "subjective";
    setImportingId(entry.id);
    setError(null);
    try {
      const audioHref =
        entry.entryType === "voice_note" && entry.hasAudio
          ? `/api/clients/${encodeURIComponent(clientId)}/journal/${entry.id}/audio?organizationId=${encodeURIComponent(organizationId)}`
          : null;
      const text = renderEntryAsText(entry, audioHref);
      await onImport({ entry, field, text });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import entry");
    } finally {
      setImportingId(null);
    }
  }

  if (loading) return <p className="muted">Loading journal…</p>;

  return (
    <div>
      {error ? <div className="alert-panel">{error}</div> : null}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <label style={{ fontSize: 13 }}>
          Type:{" "}
          <select value={filterType} onChange={(e) => setFilterType(e.target.value as typeof filterType)}>
            <option value="all">All</option>
            {ENTRY_TYPES.map((t) => (
              <option key={t} value={t}>{entryTypeLabel(t)}</option>
            ))}
          </select>
        </label>
        <span className="muted" style={{ fontSize: 12 }}>
          {visible.length} entr{visible.length === 1 ? "y" : "ies"}
          {since || windowSinceLastSigned ? " since last signed encounter" : ""}
        </span>
      </div>
      {visible.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {mode === "import"
            ? "No journal entries are available to import."
            : "The client has not logged any journal entries in this window."}
        </p>
      ) : (
        <div>
          {grouped.map(([dayLabel, group]) => (
            <section key={dayLabel} style={{ marginTop: 12 }}>
              <h3 style={{ margin: "8px 0", fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-muted, #64748b)" }}>
                {dayLabel}
              </h3>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {group.map((entry) => (
            <li
              key={entry.id}
              style={{
                borderTop: "1px solid var(--line)",
                padding: "10px 0",
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{entryTypeLabel(entry.entryType)}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>{formatDateTime(entry.createdAt)}</span>
                  {entry.importedIntoNoteId ? (
                    <span className="status status-green">
                      Imported{entry.importedIntoField ? ` → ${entry.importedIntoField}` : ""}
                    </span>
                  ) : null}
                  {entry.reviewedAt ? (
                    <span
                      className="status status-blue"
                      title={`Reviewed${entry.reviewedByName ? ` by ${entry.reviewedByName}` : ""} on ${formatDateTime(entry.reviewedAt)}`}
                    >
                      Reviewed{entry.reviewedByName ? ` · ${entry.reviewedByName}` : ""}
                    </span>
                  ) : null}
                </div>
                <EntrySummary
                  entry={entry}
                  audioHref={
                    entry.entryType === "voice_note" && entry.hasAudio
                      ? `/api/clients/${encodeURIComponent(clientId)}/journal/${entry.id}/audio?organizationId=${encodeURIComponent(organizationId)}`
                      : null
                  }
                />
                {entry.tags.length > 0 ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Tags: {entry.tags.join(", ")}
                  </div>
                ) : null}
              </div>
              {mode === "import" ? (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <label style={{ fontSize: 12 }}>
                    Insert into:{" "}
                    <select
                      value={pickerField[entry.id] ?? "subjective"}
                      onChange={(e) =>
                        setPickerField({ ...pickerField, [entry.id]: e.target.value as SoapField })
                      }
                    >
                      {SOAP_FIELDS.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button"
                    onClick={() => handleImport(entry)}
                    disabled={importingId === entry.id}
                  >
                    {importingId === entry.id ? "Importing…" : "Import"}
                  </button>
                </div>
              ) : null}
              {!entry.importedIntoNoteId && !entry.reviewedAt ? (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => handleReview(entry)}
                    disabled={reviewingId === entry.id}
                    title="Acknowledge this entry without pulling it into the note"
                  >
                    {reviewingId === entry.id ? "Marking…" : "Mark as reviewed"}
                  </button>
                </div>
              ) : null}
            </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function EntrySummary({
  entry,
  audioHref,
}: {
  entry: JournalEntry;
  audioHref: string | null;
}) {
  const b = entry.body;
  if (entry.entryType === "voice_note") {
    return (
      <div style={{ marginTop: 6 }}>
        {audioHref ? <audio controls preload="none" src={audioHref} /> : <span className="muted">No audio attached</span>}
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
            Transcript not available yet — refresh in a moment.
          </div>
        ) : null}
      </div>
    );
  }
  if (entry.entryType === "trigger") {
    return (
      <div style={{ marginTop: 6, fontSize: 14 }}>
        <div><strong>Trigger:</strong> {String(b.trigger ?? "")}</div>
        {typeof b.intensity === "number" ? <div><strong>Intensity:</strong> {b.intensity}/10</div> : null}
        {b.context ? <div><strong>Context:</strong> {String(b.context)}</div> : null}
      </div>
    );
  }
  if (entry.entryType === "coping") {
    return (
      <div style={{ marginTop: 6, fontSize: 14 }}>
        <div><strong>Strategy:</strong> {String(b.strategy ?? "")}</div>
        {b.outcome ? <div><strong>Result:</strong> {String(b.outcome)}</div> : null}
        {b.helped ? <div><strong>Helped:</strong> {String(b.helped)}</div> : null}
      </div>
    );
  }
  return <p style={{ margin: "6px 0 0 0", whiteSpace: "pre-wrap" }}>{String(b.text ?? "")}</p>;
}
