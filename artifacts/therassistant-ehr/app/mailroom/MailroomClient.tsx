"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DEFAULT_ORG_ID } from "@/lib/config";
import styles from "./mailroom.module.css";

type DocStatus = "needs_review" | "filed" | "attached" | "new" | "pending";

interface MailroomDoc {
  id: string;
  fileName: string;
  mimeType: string;
  documentType: string;
  status: DocStatus;
  clientId?: string;
  clientName?: string;
  notes: string;
  createdAt: string;
  source: string;
  storagePath?: string;
}

interface Comment {
  id: string;
  author: string;
  text: string;
  date: string;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  payer_correspondence: "Payer Correspondence",
  eob: "EOB",
  prior_auth: "Prior Auth",
  clinical: "Clinical Document",
  intake: "Intake Form",
  consent: "Consent Form",
  insurance_card: "Insurance Card",
  id: "ID Document",
  other: "Other",
};

function getOrg() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function fileExt(name: string): string {
  return name.split(".").pop()?.toUpperCase() ?? "FILE";
}

function iconClass(mime: string): string {
  if (mime.includes("pdf")) return styles.iconPdf;
  if (mime.includes("word") || mime.includes("document")) return styles.iconDoc;
  if (mime.includes("image")) return styles.iconImg;
  return styles.iconFile;
}

function statusClass(s: DocStatus): string {
  return ({ needs_review: styles.statusNeedsReview, filed: styles.statusFiled, attached: styles.statusAttached, new: styles.statusNew, pending: styles.statusNew } as Record<string, string>)[s] ?? styles.statusNeedsReview;
}

function statusLabel(s: DocStatus): string {
  return ({ needs_review: "Needs Review", filed: "Filed", attached: "Attached to Chart", new: "New", pending: "Pending" } as Record<string, string>)[s] ?? s;
}

function fmtDate(v: string) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(v: string) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
}

type FilterType = "active" | "all" | DocStatus;

export default function MailroomClient() {
  const orgId = useMemo(() => getOrg(), []);
  const [docs, setDocs] = useState<MailroomDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>("active");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, Comment[]>>({});
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filing, setFiling] = useState(false);
  const [filingError, setFilingError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  type PreviewState =
    | { kind: "idle" }
    | { kind: "probing" }
    | { kind: "ready"; url: string; bucket?: string; path?: string }
    | { kind: "unavailable"; error: string; bucket?: string; path?: string };
  const [previewState, setPreviewState] = useState<PreviewState>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/mailroom/items?organizationId=${encodeURIComponent(orgId)}&status=all&limit=100`);
      const json = (await res.json()) as { success?: boolean; items?: Array<Record<string, unknown>> };
      if (json.success && Array.isArray(json.items)) {
        setDocs(json.items.map((item) => ({
          id: String(item.id ?? ""),
          fileName: String(item.fileName ?? item.file_name ?? "Untitled"),
          mimeType: String(item.mimeType ?? item.mime_type ?? "application/octet-stream"),
          documentType: String(item.documentType ?? item.document_type ?? "other"),
          status: (String(item.status ?? "needs_review")) as DocStatus,
          clientId: item.clientId ? String(item.clientId) : undefined,
          clientName: item.clientName ? String(item.clientName) : undefined,
          notes: String(item.notes ?? ""),
          createdAt: String(item.createdAt ?? item.created_at ?? ""),
          source: String(item.source ?? "uploaded"),
          storagePath: item.storagePath ? String(item.storagePath) : undefined,
        })));
      } else {
        setDocs([]);
      }
    } catch {
      setDocs([]);
    }
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

  const filtered = useMemo(() => {
    let list = docs;
    if (filter === "active") list = list.filter((d) => d.status !== "filed");
    else if (filter !== "all") list = list.filter((d) => d.status === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((d) =>
        d.fileName.toLowerCase().includes(q) ||
        (d.clientName ?? "").toLowerCase().includes(q) ||
        (DOC_TYPE_LABELS[d.documentType] ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [docs, filter, search]);

  const selected = useMemo(() => docs.find((d) => d.id === selectedId) ?? null, [docs, selectedId]);
  const selectedComments = useMemo(() => (selectedId ? (comments[selectedId] ?? []) : []), [comments, selectedId]);
  const previewUrl = useMemo(() => {
    if (!selected) return null;
    if (!selected.storagePath || selected.id.startsWith("doc-upload-")) return null;
    return `/api/mailroom/items/${encodeURIComponent(selected.id)}/file?organizationId=${encodeURIComponent(orgId)}`;
  }, [selected, orgId]);
  const isImagePreview = selected?.mimeType.startsWith("image/") ?? false;
  const isPdfPreview = selected?.mimeType.includes("pdf") ?? false;

  useEffect(() => {
    setPreviewOpen(false);
    setPreviewState({ kind: "idle" });
    setFilingError(null);
    if (!selectedId) return;
    let cancelled = false;
    async function loadNotes() {
      setCommentsLoading(true);
      try {
        const res = await fetch(`/api/mailroom/items/${encodeURIComponent(selectedId!)}/notes?organizationId=${encodeURIComponent(orgId)}`);
        const json = (await res.json()) as { success?: boolean; notes?: Array<{ id: string; authorName: string; body: string; createdAt: string }> };
        if (cancelled) return;
        if (json.success && Array.isArray(json.notes)) {
          setComments((prev) => ({
            ...prev,
            [selectedId!]: json.notes!.map((n) => ({ id: n.id, author: n.authorName || "Staff", text: n.body, date: fmtDateTime(n.createdAt) })),
          }));
        }
      } catch {
        // leave existing
      }
      if (!cancelled) setCommentsLoading(false);
    }
    void loadNotes();
    return () => { cancelled = true; };
  }, [selectedId, orgId]);

  async function addComment() {
    if (!selectedId || !newComment.trim() || postingComment) return;
    setPostingComment(true);
    const body = newComment.trim();
    try {
      const res = await fetch(`/api/mailroom/items/${encodeURIComponent(selectedId)}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, body, authorName: "You" }),
      });
      const json = (await res.json()) as { success?: boolean; note?: { id: string; authorName: string; body: string; createdAt: string } };
      if (json.success && json.note) {
        const note = json.note;
        setComments((prev) => ({
          ...prev,
          [selectedId]: [...(prev[selectedId] ?? []), { id: note.id, author: note.authorName || "You", text: note.body, date: fmtDateTime(note.createdAt) }],
        }));
        setNewComment("");
      }
    } catch {
      // ignore — input retained so user can retry
    }
    setPostingComment(false);
  }

  const probePreview = useCallback(async () => {
    if (!previewUrl || !selected) return;
    setPreviewState({ kind: "probing" });
    try {
      const res = await fetch(`${previewUrl}&probe=1`, { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        bucket?: string;
        attemptedPath?: string | null;
      };
      if (res.ok && json.success) {
        setPreviewState({
          kind: "ready",
          url: previewUrl,
          bucket: json.bucket,
          path: json.attemptedPath ?? undefined,
        });
        setPreviewOpen(true);
      } else {
        setPreviewState({
          kind: "unavailable",
          error: json.error || `Preview failed (HTTP ${res.status}).`,
          bucket: json.bucket,
          path: json.attemptedPath ?? undefined,
        });
        setPreviewOpen(false);
      }
    } catch (err) {
      setPreviewState({
        kind: "unavailable",
        error: err instanceof Error ? err.message : "Network error while loading preview.",
      });
      setPreviewOpen(false);
    }
  }, [previewUrl, selected]);

  async function fileToDestination(destination: "patient_chart" | "practice_documents") {
    if (!selected || filing) return;
    setFiling(true);
    setFilingError(null);
    try {
      const res = await fetch("/api/mailroom/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: orgId,
          mailroom_item_id: selected.id,
          filing_destination: destination,
          target_id: destination === "patient_chart" ? (selected.clientId ?? null) : null,
          admin_comments: selected.notes || "",
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        setFilingError(json.error || "Unable to file document.");
      } else {
        setDocs((prev) => prev.map((d) => (d.id === selected.id ? { ...d, status: "filed" } : d)));
      }
    } catch (err) {
      setFilingError(err instanceof Error ? err.message : "Unable to file document.");
    }
    setFiling(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void uploadFile(files[0]);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("organizationId", orgId);
      const res = await fetch("/api/mailroom/upload", { method: "POST", body: fd });
      const json = (await res.json()) as { success?: boolean; error?: string; item?: Record<string, unknown> };
      if (!res.ok || !json.success || !json.item) {
        window.alert(json.error || "Upload failed.");
      } else {
        const it = json.item;
        const newDoc: MailroomDoc = {
          id: String(it.id ?? ""),
          fileName: String(it.fileName ?? file.name),
          mimeType: String(it.mimeType ?? file.type ?? "application/octet-stream"),
          documentType: String(it.documentType ?? "other"),
          status: (String(it.status ?? "needs_review")) as DocStatus,
          clientId: it.clientId ? String(it.clientId) : undefined,
          notes: String(it.notes ?? ""),
          createdAt: String(it.createdAt ?? new Date().toISOString()),
          source: String(it.source ?? "uploaded"),
          storagePath: it.storagePath ? String(it.storagePath) : undefined,
        };
        setDocs((prev) => [newDoc, ...prev]);
        setSelectedId(newDoc.id);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Upload failed.");
    }
    setUploading(false);
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.header}>
        <div>
          <div className={styles.headerTitle}>Mailroom</div>
          <div className={styles.headerSub}>Document intake, review, and chart filing</div>
        </div>
        <div className={styles.headerSpacer} />
        <div className={styles.searchWrap}>
          <span className={styles.searchIcon}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          </span>
          <input className={styles.searchInput} placeholder="Search documents…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className={styles.filterRow}>
          {(["active", "all", "new", "needs_review", "attached", "filed"] as FilterType[]).map((f) => (
            <button key={f} type="button" className={filter === f ? `${styles.filterChip} ${styles.filterChipActive}` : styles.filterChip} onClick={() => setFilter(f)}>
              {f === "active" ? "Active" : f === "all" ? "All" : f === "needs_review" ? "Needs Review" : statusLabel(f as DocStatus)}
            </button>
          ))}
        </div>
        <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFileInput} accept="application/pdf,image/*,.doc,.docx" />
        <button type="button" className={styles.uploadBtn} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></svg>
          {uploading ? "Uploading…" : "Upload Document"}
        </button>
      </header>

      {/* Drop zone */}
      <div
        className={dragOver ? `${styles.dropZone} ${styles.dropZoneActive}` : styles.dropZone}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") fileInputRef.current?.click(); }}
        aria-label="Upload document"
      >
        <div className={styles.dropZoneIcon}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></svg>
        </div>
        <div className={styles.dropZoneText}>Drop documents here to upload</div>
        <div className={styles.dropZoneSub}>PDF, images, and Word documents supported</div>
      </div>

      {/* Body */}
      <div className={styles.body}>
        {/* Document list */}
        <div className={styles.docList}>
          <div className={styles.docListHeader}>
            <span className={styles.docListCount}>{filtered.length} document{filtered.length !== 1 ? "s" : ""}</span>
          </div>
          <div className={styles.docListScroll}>
            {loading ? (
              <div style={{ padding: "24px 16px", color: "#94A3B8", fontSize: 13 }}>Loading…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: "24px 16px", color: "#94A3B8", fontSize: 13 }}>No documents found.</div>
            ) : filtered.map((doc) => (
              <div
                key={doc.id}
                className={`${styles.docRow} ${selectedId === doc.id ? styles.docRowSelected : ""}`}
                onClick={() => setSelectedId(doc.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(doc.id); }}
              >
                <div className={`${styles.docIcon} ${iconClass(doc.mimeType)}`}>
                  {fileExt(doc.fileName)}
                </div>
                <div className={styles.docMeta}>
                  <div className={styles.docFileName} title={doc.fileName}>{doc.fileName}</div>
                  <div className={styles.docSubRow}>
                    <span className={styles.docType} title={DOC_TYPE_LABELS[doc.documentType] ?? doc.documentType}>
                      {DOC_TYPE_LABELS[doc.documentType] ?? doc.documentType}
                    </span>
                    {doc.clientName ? (
                      <>
                        <span className={styles.docDot}>·</span>
                        <span className={styles.docType} title={doc.clientName}>{doc.clientName}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className={styles.docRight}>
                  <span className={`${styles.docStatus} ${statusClass(doc.status)}`}>{statusLabel(doc.status)}</span>
                  <span className={styles.docDate}>{fmtDate(doc.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail panel */}
        <div className={styles.detailPanel}>
          {selected ? (
            <div className={styles.detailScroll}>
              {/* Doc info */}
              <div className={styles.docCard}>
                <div className={styles.docCardHeader}>
                  <div className={styles.docCardTitle}>{selected.fileName}</div>
                  <span className={`${styles.docStatus} ${statusClass(selected.status)}`}>{statusLabel(selected.status)}</span>
                </div>
                <div className={styles.docCardMeta}>
                  <div className={styles.docCardField}>
                    <span className={styles.fieldLabel}>Document Type</span>
                    <span className={styles.fieldValue}>{DOC_TYPE_LABELS[selected.documentType] ?? selected.documentType}</span>
                  </div>
                  <div className={styles.docCardField}>
                    <span className={styles.fieldLabel}>Received</span>
                    <span className={styles.fieldValue}>{fmtDate(selected.createdAt)}</span>
                  </div>
                  <div className={styles.docCardField}>
                    <span className={styles.fieldLabel}>Source</span>
                    <span className={styles.fieldValue}>{selected.source}</span>
                  </div>
                  <div className={styles.docCardField}>
                    <span className={styles.fieldLabel}>Linked Client</span>
                    <span className={styles.fieldValue}>
                      {selected.clientId ? (
                        <Link href={`/clients/${selected.clientId}`} style={{ color: "#3B82F6", textDecoration: "none" }}>
                          {selected.clientName ?? selected.clientId}
                        </Link>
                      ) : "Not linked"}
                    </span>
                  </div>
                </div>
                {selected.notes ? (
                  <div style={{ marginTop: 12, padding: "10px 12px", background: "#F8FAFC", borderRadius: 8, fontSize: 12.5, color: "#475569", lineHeight: 1.5 }}>
                    {selected.notes}
                  </div>
                ) : null}
              </div>

              {/* Preview */}
              <div className={styles.previewArea}>
                <div className={styles.previewHeader}>
                  <span className={styles.previewTitle}>Document Preview</span>
                  {previewState.kind === "ready" ? (
                    <a
                      href={previewState.url}
                      target="_blank"
                      rel="noreferrer"
                      className={styles.previewBtn}
                      style={{ marginLeft: "auto" }}
                    >
                      Open in new tab
                    </a>
                  ) : null}
                </div>

                {previewState.kind === "ready" && previewOpen ? (
                  isImagePreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previewState.url}
                      alt={selected.fileName}
                      style={{ width: "100%", maxHeight: 520, objectFit: "contain", background: "#0F172A", borderRadius: 8 }}
                    />
                  ) : isPdfPreview ? (
                    <iframe
                      src={previewState.url}
                      title={selected.fileName}
                      style={{ width: "100%", height: 520, border: "none", borderRadius: 8, background: "#0F172A" }}
                    />
                  ) : (
                    <div className={styles.previewPlaceholder}>
                      <div className={styles.previewPlaceholderText}>{selected.fileName}</div>
                      <a href={previewState.url} target="_blank" rel="noreferrer" className={styles.previewBtn}>
                        Download Document
                      </a>
                    </div>
                  )
                ) : previewState.kind === "unavailable" ? (
                  <div className={styles.previewPlaceholder}>
                    <div className={styles.previewIcon}>
                      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                    </div>
                    <div className={styles.previewPlaceholderText} style={{ fontWeight: 600, color: "#0F172A" }}>
                      Preview unavailable
                    </div>
                    <div className={styles.previewErrorMsg}>{previewState.error}</div>
                    {previewState.path ? (
                      <div className={styles.previewPathBox}>
                        <span className={styles.previewPathLabel}>Bucket</span>
                        <code className={styles.previewPathValue}>{previewState.bucket ?? "mailroom-documents"}</code>
                        <span className={styles.previewPathLabel}>Object</span>
                        <code className={styles.previewPathValue}>{previewState.path}</code>
                      </div>
                    ) : null}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className={styles.previewBtn} onClick={() => void probePreview()}>
                        Retry
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.previewPlaceholder}>
                    <div className={styles.previewIcon}>
                      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                    </div>
                    <div className={styles.previewPlaceholderText}>{selected.fileName}</div>
                    {previewUrl ? (
                      <button
                        type="button"
                        className={styles.previewBtn}
                        onClick={() => void probePreview()}
                        disabled={previewState.kind === "probing"}
                      >
                        {previewState.kind === "probing" ? "Loading…" : "Open Full Document"}
                      </button>
                    ) : (
                      <div style={{ fontSize: 12, color: "#94A3B8" }}>No file attached to this item.</div>
                    )}
                  </div>
                )}
              </div>

              {/* Comments */}
              <div className={styles.commentSection}>
                <div className={styles.commentHeader}>Comments &amp; Notes</div>
                {commentsLoading ? (
                  <div style={{ padding: "12px 16px", color: "#94A3B8", fontSize: 13 }}>Loading notes…</div>
                ) : selectedComments.length > 0 ? (
                  <div className={styles.commentList}>
                    {selectedComments.map((c) => (
                      <div key={c.id} className={styles.comment}>
                        <div className={styles.commentMeta}>{c.author} · {c.date}</div>
                        <div className={styles.commentText}>{c.text}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: "12px 16px", color: "#94A3B8", fontSize: 13 }}>No comments yet.</div>
                )}
                <div className={styles.commentForm}>
                  <input
                    className={styles.commentInput}
                    placeholder="Add a comment or note…"
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void addComment(); }}
                    disabled={postingComment}
                  />
                  <button type="button" className={styles.commentSubmit} onClick={() => void addComment()} disabled={postingComment || !newComment.trim()}>
                    {postingComment ? "Saving…" : "Add"}
                  </button>
                </div>
              </div>

              {/* Attach / File Actions */}
              <div className={styles.attachSection}>
                <div className={styles.attachHeader}>File or Attach</div>
                {filingError ? <div style={{ color: "#DC2626", fontSize: 12.5, marginBottom: 8 }}>{filingError}</div> : null}
                <div className={styles.attachActions}>
                  {selected.clientId ? (
                    <button
                      type="button"
                      className={`${styles.attachBtn} ${styles.attachBtnPrimary}`}
                      onClick={() => void fileToDestination("patient_chart")}
                      disabled={filing || selected.status === "filed"}
                    >
                      {filing ? "Filing…" : "File to Client Chart"}
                    </button>
                  ) : (
                    <Link className={`${styles.attachBtn} ${styles.attachBtnPrimary}`} href={`/mailroom/${selected.id}`}>
                      Link to Client Chart
                    </Link>
                  )}
                  <button
                    type="button"
                    className={styles.attachBtn}
                    onClick={() => void fileToDestination("practice_documents")}
                    disabled={filing || selected.status === "filed"}
                  >
                    File to Practice
                  </button>
                  <Link className={styles.attachBtn} href={`/mailroom/${selected.id}`}>
                    Advanced Filing…
                  </Link>
                  {selected.status === "filed" ? (
                    <span className={`${styles.attachBtn} ${styles.markFiledBtn}`} style={{ cursor: "default" }}>Filed</span>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className={styles.detailEmpty}>
              <div className={styles.detailEmptyIcon}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
              </div>
              <div className={styles.detailEmptyText}>Select a document to review, comment, and file</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
