"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type MailroomItem = {
  id: string;
  fileName: string | null;
  mimeType: string | null;
  documentType: string | null;
  status: string | null;
  notes: string | null;
  source: string | null;
  createdAt: string | null;
};

function formatDate(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

function statusClass(v: string | null | undefined) {
  const s = String(v ?? "").toLowerCase();
  if (s === "filed") return "status status-green";
  if (s === "needs_review") return "status status-yellow";
  return "status";
}

export default function ClientMailroomPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params?.clientId ?? "";
  const searchParams = useSearchParams();
  const orgId = searchParams.get("organizationId") ?? process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "";

  const [items, setItems] = useState<MailroomItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId || !orgId) return;
    let cancelled = false;
    async function load() {
      try {
        const qp = new URLSearchParams({ organizationId: orgId, clientId, limit: "50", status: "all" });
        const r = await fetch(`/api/mailroom/items?${qp.toString()}`, { cache: "no-store" });
        const json = await r.json() as { success: boolean; items?: MailroomItem[]; error?: string };
        if (cancelled) return;
        if (!json.success) throw new Error(json.error ?? "Failed");
        setItems(json.items ?? []);
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
          <h2>Mail Room</h2>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href={`/mailroom${orgQ}`}>
            All Mailroom Items
          </Link>
        </div>
      </section>

      {loading && <div className="empty-state">Loading mailroom items…</div>}
      {error && <div className="alert-panel">{error}</div>}

      {!loading && items.length === 0 && !error && (
        <div className="empty-state">No mailroom items linked to this client.</div>
      )}

      {items.length > 0 && (
        <section className="panel">
          <div className="stack-list">
            {items.map((item) => (
              <div className="stack-item stack-row" key={item.id}>
                <div>
                  <strong>{item.fileName ?? "Mailroom item"}</strong>
                  <span>{item.documentType ?? "document"} · {item.source ?? "unknown source"}</span>
                  {item.notes && <span className="muted">{item.notes.slice(0, 120)}{item.notes.length > 120 ? "…" : ""}</span>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
                  <span className={statusClass(item.status)}>{item.status ?? "—"}</span>
                  <span className="muted" style={{ fontSize: "11px" }}>{formatDate(item.createdAt)}</span>
                  <Link className="button button-secondary" href={`/mailroom/${item.id}${orgQ}`}>
                    File / Review
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
