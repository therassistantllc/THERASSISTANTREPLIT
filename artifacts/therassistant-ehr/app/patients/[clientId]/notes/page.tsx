"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type NoteItem = {
  id: string;
  encounterId: string;
  encounterDate: string | null;
  encounterStatus: string | null;
  noteStatus: string | null;
  noteType: string | null;
  signedAt: string | null;
  createdAt: string | null;
  hasSoapNote: boolean;
};

function formatDate(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(`${v}`.includes("T") ? v : `${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

function statusClass(v: string | null | undefined) {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("signed") || s.includes("complet")) return "status status-green";
  if (s.includes("draft") || s.includes("in_progress")) return "status status-yellow";
  if (s.includes("amend")) return "status status-yellow";
  return "status";
}

export default function NotesPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params?.clientId ?? "";
  const searchParams = useSearchParams();
  const orgId = searchParams.get("organizationId") ?? process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "";

  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId || !orgId) return;
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/patients/${clientId}/notes?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
        const json = await r.json() as { success: boolean; notes?: NoteItem[]; error?: string };
        if (cancelled) return;
        if (!json.success) throw new Error(json.error ?? "Failed");
        setNotes(json.notes ?? []);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [clientId, orgId]);

  const orgQ = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : "";

  return (
    <main className="app-shell">
      <section className="page-header">
        <div>
          <p className="eyebrow">Client Chart</p>
          <h2>Clinical Notes</h2>
        </div>
        <div className="hero-actions">
          <Link className="button" href={`/encounters/new${orgQ}`}>
            New Encounter
          </Link>
        </div>
      </section>

      {loading && <div className="empty-state">Loading notes…</div>}
      {error && <div className="alert-panel">{error}</div>}

      {!loading && notes.length === 0 && !error && (
        <div className="empty-state">No clinical notes found. Notes are created within encounters.</div>
      )}

      {notes.length > 0 && (
        <section className="panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>Encounter Date</th>
                <th>Note Type</th>
                <th>Status</th>
                <th>Signed</th>
                <th>SOAP</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((note) => (
                <tr key={note.id}>
                  <td>{formatDate(note.encounterDate)}</td>
                  <td>{note.noteType ?? "—"}</td>
                  <td><span className={statusClass(note.noteStatus)}>{note.noteStatus ?? "draft"}</span></td>
                  <td>{note.signedAt ? formatDate(note.signedAt) : <span className="muted">Unsigned</span>}</td>
                  <td>{note.hasSoapNote ? <span className="status status-green">Yes</span> : "—"}</td>
                  <td>
                    <Link className="button button-secondary" href={`/encounters/${note.encounterId}${orgQ}`}>
                      Open Encounter
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
