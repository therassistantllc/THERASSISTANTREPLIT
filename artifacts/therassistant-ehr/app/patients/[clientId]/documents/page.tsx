"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type DocItem = {
  id: string;
  scope: string | null;
  type: string | null;
  title: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  notes: string | null;
  filedAt: string | null;
  createdAt: string | null;
  encounterId: string | null;
  claimId: string | null;
  mailroomItemId: string | null;
};

function formatDate(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

function formatSize(bytes: number | null | undefined) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params?.clientId ?? "";
  const searchParams = useSearchParams();
  const orgId = searchParams.get("organizationId") ?? process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "";

  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId || !orgId) return;
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/patients/${clientId}/documents?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
        const json = await r.json() as { success: boolean; documents?: DocItem[]; error?: string };
        if (cancelled) return;
        if (!json.success) throw new Error(json.error ?? "Failed");
        setDocuments(json.documents ?? []);
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
          <h2>Documents &amp; Attachments</h2>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href={`/mailroom${orgQ}`}>
            Mailroom
          </Link>
        </div>
      </section>

      {loading && <div className="empty-state">Loading documents…</div>}
      {error && <div className="alert-panel">{error}</div>}

      {!loading && documents.length === 0 && !error && (
        <div className="empty-state">
          No documents found. Documents are filed here from the Mailroom or attached to encounters.
        </div>
      )}

      {documents.length > 0 && (
        <section className="panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>File / Title</th>
                <th>Type</th>
                <th>Scope</th>
                <th>Size</th>
                <th>Filed</th>
                <th>Created</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td>
                    <div>
                      <strong>{doc.title ?? doc.fileName ?? "Untitled"}</strong>
                      {doc.fileName && doc.title && <div className="muted" style={{ fontSize: "12px" }}>{doc.fileName}</div>}
                    </div>
                  </td>
                  <td>{doc.type ?? "—"}</td>
                  <td>{doc.scope ?? "—"}</td>
                  <td>{formatSize(doc.fileSizeBytes)}</td>
                  <td>{doc.filedAt ? formatDate(doc.filedAt) : <span className="muted">Not filed</span>}</td>
                  <td>{formatDate(doc.createdAt)}</td>
                  <td>
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      {doc.encounterId && (
                        <Link className="inline-link" href={`/encounters/${doc.encounterId}${orgQ}`}>Encounter</Link>
                      )}
                      {doc.mailroomItemId && (
                        <Link className="inline-link" href={`/mailroom/${doc.mailroomItemId}${orgQ}`}>Mailroom</Link>
                      )}
                    </div>
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
