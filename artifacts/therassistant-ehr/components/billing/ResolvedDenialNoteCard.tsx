"use client";

/**
 * Shared note card used by every per-claim Notes panel in the billing
 * workqueues (no-response, timely-filing, aging, compliance-audit,
 * claim-hold). Renders the note body + author/timestamp, plus a small
 * "Mark resolved" / "Clear resolved" affordance that PATCHes the
 * `resolved_denial` column on `claim_notes`.
 *
 * Toggling the flag flows directly into the Denials-by-RARC
 * "Resolved by only" filter (server-side eq("resolved_denial", true))
 * and the inline green pill on that page, so we keep the toggle local
 * to the panel and let the parent panel update its cached note row via
 * the onChange callback.
 */
import { useState } from "react";

export type ResolvedDenialNote = {
  id: string;
  body: string;
  author_display_name: string | null;
  created_at: string;
  resolved_denial?: boolean | null;
};

interface Props<N extends ResolvedDenialNote> {
  note: N;
  claimId: string;
  organizationId: string;
  onChange: (note: N) => void;
}

function fmt(at: string): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return at;
  }
}

export function ResolvedDenialNoteCard<N extends ResolvedDenialNote>({
  note,
  claimId,
  organizationId,
  onChange,
}: Props<N>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isResolved = Boolean(note.resolved_denial);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/claims/${claimId}/notes/${note.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            resolved_denial: !isResolved,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error || "Failed to update note");
      }
      const updated = (json?.note ?? {}) as Partial<N>;
      onChange({ ...note, ...updated, resolved_denial: !isResolved });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid #E5E7EB",
        borderRadius: 6,
        padding: 10,
        background: "#F9FAFB",
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: "#6B7280",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span>
          {note.author_display_name ?? "Staff"} · {fmt(note.created_at)}
        </span>
        {isResolved ? (
          <span
            style={{
              background: "#DCFCE7",
              color: "#15803D",
              padding: "1px 6px",
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.3,
            }}
          >
            Resolved
          </span>
        ) : null}
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          style={{
            marginLeft: "auto",
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 4,
            border: "1px solid #CBD5E1",
            background: busy ? "#F1F5F9" : "#FFFFFF",
            color: "#334155",
            cursor: busy ? "wait" : "pointer",
          }}
          title={
            isResolved
              ? "Remove the resolved-denial flag from this note"
              : "Flag this note as the one that resolved the denial"
          }
        >
          {busy
            ? "Saving…"
            : isResolved
              ? "Clear resolved"
              : "Mark resolved"}
        </button>
      </div>
      <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{note.body}</div>
      {error ? (
        <div style={{ color: "#B91C1C", fontSize: 11, marginTop: 4 }}>{error}</div>
      ) : null}
    </div>
  );
}
