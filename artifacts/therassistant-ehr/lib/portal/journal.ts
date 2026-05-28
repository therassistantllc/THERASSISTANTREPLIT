export const ENTRY_TYPES = [
  "reflection",
  "voice_note",
  "trigger",
  "coping",
  "pattern",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const SOAP_FIELDS = ["subjective", "objective", "assessment", "plan"] as const;
export type SoapField = (typeof SOAP_FIELDS)[number];

export const JOURNAL_AUDIO_BUCKET = "client-journal-audio";

export type JournalBody = Record<string, unknown>;

export type JournalEntry = {
  id: string;
  entryType: EntryType;
  body: JournalBody;
  tags: string[];
  hasAudio: boolean;
  audioMimeType: string | null;
  audioDurationSeconds: number | null;
  audioTranscript: string | null;
  importedIntoNoteId: string | null;
  importedIntoField: SoapField | null;
  importedAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  reviewedByName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export function mapJournalRow(row: Record<string, unknown>): JournalEntry {
  const tagsRaw = row.tags;
  return {
    id: String(row.id ?? ""),
    entryType: String(row.entry_type ?? "reflection") as EntryType,
    body: (row.body ?? {}) as JournalBody,
    tags: Array.isArray(tagsRaw) ? (tagsRaw as string[]) : [],
    hasAudio: Boolean(row.audio_storage_path),
    audioMimeType: (row.audio_mime_type as string | null) ?? null,
    audioDurationSeconds:
      typeof row.audio_duration_seconds === "number" ? row.audio_duration_seconds : null,
    audioTranscript:
      typeof row.audio_transcript === "string" && row.audio_transcript.trim().length > 0
        ? (row.audio_transcript as string)
        : null,
    importedIntoNoteId: (row.imported_into_note_id as string | null) ?? null,
    importedIntoField: (row.imported_into_field as SoapField | null) ?? null,
    importedAt: (row.imported_at as string | null) ?? null,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    reviewedByUserId: (row.reviewed_by_user_id as string | null) ?? null,
    reviewedByName: (row.reviewed_by_name as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}

/**
 * Best-effort body sanitizer. Each entry type has type-specific shape; we keep
 * only known keys so a malicious portal client cannot stuff arbitrary JSON.
 */
export function sanitizeBody(entryType: EntryType, raw: unknown): JournalBody {
  const src = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  const str = (k: string) =>
    typeof src[k] === "string" ? (src[k] as string).slice(0, 8000) : "";
  switch (entryType) {
    case "reflection":
      return { text: str("text") };
    case "pattern":
      return { text: str("text") };
    case "trigger": {
      const intensity = Number(src.intensity);
      return {
        trigger: str("trigger"),
        context: str("context"),
        intensity:
          Number.isFinite(intensity) && intensity >= 1 && intensity <= 10
            ? Math.round(intensity)
            : null,
      };
    }
    case "coping": {
      const helpedRaw = String(src.helped ?? "").trim().toLowerCase();
      const helped = ["yes", "somewhat", "no"].includes(helpedRaw) ? helpedRaw : null;
      return {
        strategy: str("strategy"),
        outcome: str("outcome"),
        helped,
      };
    }
    case "voice_note":
      return { caption: str("caption") };
    default:
      return {};
  }
}

/** Plain-text rendering used both for the chart panel preview and for SOAP import. */
export function renderEntryAsText(entry: JournalEntry, audioLinkHref?: string | null): string {
  switch (entry.entryType) {
    case "reflection":
      return String(entry.body.text ?? "").trim();
    case "pattern":
      return `Pattern noticed: ${String(entry.body.text ?? "").trim()}`;
    case "trigger": {
      const trig = String(entry.body.trigger ?? "").trim();
      const ctx = String(entry.body.context ?? "").trim();
      const intensity = entry.body.intensity;
      const parts = [
        trig ? `Trigger: ${trig}` : "",
        typeof intensity === "number" ? `Intensity: ${intensity}/10` : "",
        ctx ? `Context: ${ctx}` : "",
      ].filter(Boolean);
      return parts.join(". ");
    }
    case "coping": {
      const strat = String(entry.body.strategy ?? "").trim();
      const out = String(entry.body.outcome ?? "").trim();
      const helped = entry.body.helped;
      const parts = [
        strat ? `Coping strategy used: ${strat}` : "",
        out ? `What happened: ${out}` : "",
        helped ? `Helped: ${helped}` : "",
      ].filter(Boolean);
      return parts.join(". ");
    }
    case "voice_note": {
      const caption = String(entry.body.caption ?? "").trim();
      const transcript = (entry.audioTranscript ?? "").trim();
      const footnote = audioLinkHref
        ? `[Voice note audio: ${audioLinkHref}]`
        : "[Voice note — audio available in chart]";
      if (transcript) {
        const captionPart = caption ? `Caption: ${caption}\n` : "";
        return `${captionPart}Voice note transcript:\n${transcript}\n\n${footnote}`;
      }
      // No transcript yet (still processing, or transcription unavailable).
      const linkPart = audioLinkHref
        ? `[Voice note — listen: ${audioLinkHref}]`
        : "[Voice note — listen in chart]";
      return caption ? `${linkPart} ${caption}` : linkPart;
    }
    default:
      return "";
  }
}

export function entryTypeLabel(type: EntryType): string {
  switch (type) {
    case "reflection":
      return "Reflection";
    case "voice_note":
      return "Voice note";
    case "trigger":
      return "Trigger log";
    case "coping":
      return "Coping strategy";
    case "pattern":
      return "Pattern noticed";
  }
}
