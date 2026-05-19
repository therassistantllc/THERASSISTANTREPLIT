"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type MailroomItem = {
  id: string;
  organizationId: string;
  clientId: string;
  fileName: string;
  mimeType: string;
  storagePath: string;
  status: string;
  documentType: string;
  source: string;
  notes: string;
  adminComments: string;
  createdAt: string;
};

type DetailResponse = { success?: boolean; item?: MailroomItem; error?: string };

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function formatDate(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function MailroomItemClient({ itemId }: { itemId: string }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [item, setItem] = useState<MailroomItem | null>(null);
  const [filingDestination, setFilingDestination] = useState("patient_chart");
  const [targetId, setTargetId] = useState("");
  const [adminComments, setAdminComments] = useState("");
  const [loading, setLoading] = useState(true);
  const [filing, setFiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadItem() {
    setLoading(true);
    setError(null);
    const response = await fetch(`/api/mailroom/items/${itemId}?organizationId=${encodeURIComponent(organizationId)}`);
    const json = (await response.json()) as DetailResponse;
    if (!response.ok || !json.success || !json.item) {
      setError(json.error || "Unable to load mailroom item.");
    } else {
      setItem(json.item);
      setTargetId(json.item.clientId || "");
      setAdminComments(json.item.adminComments || "");
    }
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (organizationId && itemId) void loadItem();
    else {
      setError("Missing organizationId or mailroom item ID.");
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, itemId]);

  async function fileDocument() {
    setFiling(true);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/mailroom/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organization_id: organizationId,
        mailroom_item_id: itemId,
        filing_destination: filingDestination,
        target_id: targetId || null,
        admin_comments: adminComments,
      }),
    });

    const json = (await response.json()) as { success?: boolean; error?: string; document_id?: string; message?: string };
    if (!response.ok || !json.success) {
      setError(json.error || "Unable to file document.");
    } else {
      setMessage(json.message || "Document filed successfully.");
      await loadItem();
    }
    setFiling(false);
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Mailroom Filing</p>
          <h1>{item?.fileName || "Mailroom item"}</h1>
          <p className="hero-copy">Review payer mail or scanned documents and file them into the right system location.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/mailroom">Mailroom</Link>
          <Link className="button button-secondary" href="/billing/workqueue">Workqueue</Link>
        </div>
      </section>

      {loading ? <div className="empty-state">Loading mailroom item…</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}
      {message ? <div className="empty-state success-panel">{message}</div> : null}

      {item ? (
        <section className="two-column-panel">
          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Document details</h2>
                <p>{item.documentType || "document"} · {item.status || "needs_review"}</p>
              </div>
              <span className={`status ${item.status === "filed" ? "status-green" : "status-yellow"}`}>{item.status || "pending"}</span>
            </div>
            <div className="detail-list">
              <p><strong>File:</strong> {item.fileName || "—"}</p>
              <p><strong>Type:</strong> {item.mimeType || "—"}</p>
              <p><strong>Storage path:</strong> {item.storagePath || "—"}</p>
              <p><strong>Source:</strong> {item.source || "—"}</p>
              <p><strong>Created:</strong> {formatDate(item.createdAt)}</p>
              <p><strong>Notes:</strong> {item.notes || "—"}</p>
              <p><strong>Linked patient:</strong> {item.clientId || "Not linked"}</p>
            </div>
            <div className="section-actions">
              {item.clientId ? <Link className="button button-secondary" href={`/clients/${item.clientId}`}>Open Client Chart</Link> : null}
              {filingDestination === "encounter" && targetId ? <Link className="button button-secondary" href={`/encounters/${targetId}`}>Open Encounter</Link> : null}
            </div>
          </div>

          <div className="panel form-panel">
            <h2>File document</h2>
            <label className="field-label">
              Filing destination
              <select value={filingDestination} onChange={(event) => setFilingDestination(event.target.value)}>
                <option value="patient_chart">Patient chart</option>
                <option value="claim">Claim</option>
                <option value="encounter">Encounter</option>
                <option value="practice_documents">Practice-level documents</option>
              </select>
            </label>
            <label className="field-label">
              Target ID
              <input value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="Client, claim, or encounter UUID; leave blank for practice documents" />
            </label>
            <label className="field-label">
              Filing notes
              <textarea value={adminComments} onChange={(event) => setAdminComments(event.target.value)} placeholder="Add filing notes or payer correspondence summary..." />
            </label>
            <button className="button" type="button" onClick={fileDocument} disabled={filing || item.status === "filed"}>
              {filing ? "Filing…" : item.status === "filed" ? "Already Filed" : "File Document"}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
