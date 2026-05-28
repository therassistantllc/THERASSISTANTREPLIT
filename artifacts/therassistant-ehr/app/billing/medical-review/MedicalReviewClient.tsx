"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type DetailTab,
  type FilterDef,
  type PrimaryAction,
  type RowAction,
  type SummaryMetric,
} from "@/components/billing/WorkqueueShell";
import { ClaimDocumentsPanel } from "@/components/billing/ClaimDocumentsPanel";
import { getWorkqueue } from "@/lib/billing/workqueues";
import { MEDICAL_REVIEW_TABS, type MedicalReviewTab } from "@/lib/medical-review/tabs";
import type { MedicalReviewRow } from "@/lib/medical-review/types";
import { describeDocumentationCode } from "@/lib/medical-review/documentationRequestDetection";

interface ListPayload {
  success: boolean;
  error?: string;
  rows?: MedicalReviewRow[];
}

interface ContextPayload {
  success: boolean;
  error?: string;
  context?: {
    clinicalNote: {
      id: string; status: string;
      subjective: string | null; objective: string | null;
      assessment: string | null; plan: string | null;
      signedAt: string | null;
    } | null;
    treatmentPlan: {
      id: string; status: string;
      startDate: string | null; endDate: string | null;
      presentingProblem: string | null; longTermGoals: string | null;
      frequency: string | null; modality: string | null;
    } | null;
    documents: Array<{
      id: string; title: string; fileName: string;
      documentType: string | null; mimeType: string | null;
      uploadedAt: string | null; notes: string | null;
    }>;
    history: Array<{
      id: string; action: string; summary: string | null;
      createdAt: string; userId: string | null;
    }>;
    transmissions: Array<{
      id: string;
      channel: "email" | "fax" | "logged";
      recipient: string | null;
      status: "queued" | "sending" | "sent" | "delivered" | "failed" | "logged";
      sentAt: string | null;
      createdAt: string;
      error: string | null;
      providerMessageId: string | null;
      files: Array<{ id: string; title: string; fileName: string }>;
    }>;
  };
}

const queueDef = getWorkqueue("medical_review");

function getOrganizationId(): string {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}
function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed", bottom: 24, right: 24,
        background: "#111827", color: "#fff",
        padding: "10px 16px", borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)", zIndex: 1100,
      }}
    >
      {message}
    </div>
  );
}

function docTypeIcon(mimeType: string | null | undefined): string {
  if (!mimeType) return "📎";
  const m = mimeType.toLowerCase();
  if (m.startsWith("image/")) return "🖼️";
  if (m === "application/pdf") return "📕";
  if (m.includes("word") || m.includes("officedocument.wordprocessing")) return "📝";
  if (m.includes("excel") || m.includes("spreadsheet") || m === "text/csv") return "📊";
  if (m.startsWith("text/")) return "📃";
  if (m) return "📄";
  return "📎";
}

function DetailKV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid #F1F5F9", fontSize: 13 }}>
      <span style={{ color: "#64748B" }}>{label}</span>
      <span style={{ fontWeight: 500, color: "#0F172A", textAlign: "right" }}>{value ?? "—"}</span>
    </div>
  );
}

export default function MedicalReviewClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<MedicalReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(0);

  const [activeTab, setActiveTab] = useState<MedicalReviewTab>("records_requested");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const [ctxByClaim, setCtxByClaim] = useState<Record<string, NonNullable<ContextPayload["context"]>>>({});
  const [ctxLoading, setCtxLoading] = useState<string | null>(null);

  interface CoverLetterAttachmentDraft { key: string; title: string }
  interface CoverLetterModalState {
    row: MedicalReviewRow;
    attention: string;
    notes: string;
    attachments: CoverLetterAttachmentDraft[];
    attachmentsInitialized: boolean;
    submitting: boolean;
  }
  const [coverModal, setCoverModal] = useState<CoverLetterModalState | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingClaim, setUploadingClaim] = useState<string | null>(null);
  const [packetClaim, setPacketClaim] = useState<string | null>(null);
  const [chartPickerOpen, setChartPickerOpen] = useState(false);
  const [chartDocs, setChartDocs] = useState<Array<{ id: string; title: string | null; fileName: string | null; type: string | null; mimeType: string | null; claimId: string | null; createdAt: string | null }>>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartSelection, setChartSelection] = useState<Record<string, boolean>>({});
  const [attaching, setAttaching] = useState(false);
  const [removingDocId, setRemovingDocId] = useState<string | null>(null);
  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ title: string; documentType: string }>({ title: "", documentType: "" });
  const [savingDocId, setSavingDocId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      for (const [k, v] of Object.entries(filterValues)) if (v) params.set(k, v);
      const res = await fetch(`/api/billing/medical-review?${params.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as ListPayload;
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows(json.rows ?? []);
      setNowMs(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [organizationId, filterValues]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // ── Tab counts ─────────────────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const m: Record<MedicalReviewTab, number> = {
      records_requested: 0,
      treatment_plan_requested: 0,
      notes_requested: 0,
      medical_necessity_review: 0,
      deadline_approaching: 0,
    };
    for (const r of rows) for (const t of r.tabs) m[t]++;
    return m;
  }, [rows]);

  // ── Filter options derived from rows ───────────────────────────────────
  const payerOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.payerName) m.set(r.payerName, r.payerName);
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);
  const practiceOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.practiceId) m.set(r.practiceId, `Practice ${r.practiceId.slice(0, 8)}`);
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);
  const clinicianOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.providerId) m.set(r.providerId, `Clinician ${r.providerId.slice(0, 8)}`);
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);
  const triggerCodeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) for (const c of r.triggerCodes) {
      const up = c.toUpperCase();
      if (up) s.add(up);
    }
    return Array.from(s).sort().map((v) => ({ value: v, label: v }));
  }, [rows]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "select", options: practiceOptions },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicianOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Client name…" },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status", label: "Claim status", kind: "select",
        options: [
          { value: "denied", label: "Denied" },
          { value: "accepted_payer", label: "Accepted by payer" },
          { value: "rejected_payer", label: "Rejected by payer" },
          { value: "submitted", label: "Submitted" },
        ],
      },
      { id: "assignedBiller", label: "Assigned biller", kind: "text", placeholder: "user id…" },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket", label: "Request age", kind: "select",
        options: [
          { value: "0-30", label: "0-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "61-90", label: "61-90 days" },
          { value: "90+", label: "90+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. CO-50" },
      {
        id: "triggerOrigin", label: "Origin", kind: "select",
        options: [
          { value: "277CA", label: "277CA" },
          { value: "ERA", label: "ERA" },
          { value: "manual", label: "Manual" },
        ],
      },
      { id: "triggerCode", label: "Trigger code", kind: "select", options: triggerCodeOptions },
      {
        id: "priority", label: "Priority", kind: "select",
        options: [{ value: "urgent", label: "Urgent / Overdue" }],
      },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [payerOptions, practiceOptions, clinicianOptions, triggerCodeOptions],
  );

  // ── Tab-filtered rows ──────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    return rows.filter((r) => r.tabs.includes(activeTab));
  }, [rows, activeTab]);

  const summary: SummaryMetric[] = useMemo(() => {
    const total = filteredRows.length;
    const dollars = filteredRows.reduce((s, r) => s + r.chargeAmount, 0);
    const oldest = filteredRows.reduce((maxAge, r) => {
      if (!r.requestDate) return maxAge;
      const age = Math.floor((nowMs - new Date(r.requestDate).getTime()) / 86_400_000);
      return age > maxAge ? age : maxAge;
    }, 0);
    const urgent = filteredRows.filter((r) => r.isUrgent || r.isOverdue).length;
    return [
      { id: "count", label: "Items", value: total.toLocaleString() },
      { id: "dollars", label: "Total $ at stake", value: formatCurrency(dollars), tone: dollars > 0 ? "amber" : "default" },
      { id: "oldest", label: "Oldest request (days)", value: oldest, tone: oldest > 30 ? "red" : oldest > 14 ? "amber" : "default" },
      { id: "urgent", label: "Urgent / Overdue", value: urgent, tone: urgent > 0 ? "red" : "default" },
    ];
  }, [filteredRows, nowMs]);

  // ── Columns (exact spec) ───────────────────────────────────────────────
  const columns: ColumnDef<MedicalReviewRow>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.clientName },
      {
        id: "claim", header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.claimNumber || r.claimId.slice(0, 8)}
          </span>
        ),
      },
      { id: "payer", header: "Payer", cell: (r) => r.payerName || "—" },
      { id: "dos", header: "DOS", cell: (r) => formatDate(r.dateOfService) },
      { id: "rtype", header: "Request type", cell: (r) => r.requestTypeLabel },
      {
        id: "tcodes", header: "Trigger codes", width: 180,
        cell: (r) => {
          if (!r.triggerCodes.length) return <span style={{ color: "#9CA3AF" }}>—</span>;
          const originLabel = r.triggerOrigin
            ? `${r.triggerOrigin}${r.triggerTrn ? ` · TRN ${r.triggerTrn}` : ""}`
            : null;
          return (
            <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
              <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
                {r.triggerCodes.map((c) => {
                  const desc = describeDocumentationCode(c);
                  const title = desc
                    ? `${c} — ${desc}${r.triggerOrigin ? ` (${r.triggerOrigin})` : ""}`
                    : r.triggerOrigin ? `${c} (${r.triggerOrigin})` : c;
                  return (
                    <span
                      key={c}
                      title={title}
                      style={{
                        background: "#EFF6FF", color: "#1D4ED8",
                        padding: "1px 6px", borderRadius: 4,
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 11, fontWeight: 600,
                        cursor: "help",
                      }}
                    >{c}</span>
                  );
                })}
              </span>
              {originLabel ? (
                <span
                  title={r.triggerTrn ? `Payer cited claim control number ${r.triggerTrn}` : undefined}
                  style={{ fontSize: 10, color: "#64748B", fontFamily: "ui-monospace, monospace" }}
                >
                  {originLabel}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "rdocs", header: "Requested documents",
        cell: (r) => r.requestedDocuments.length
          ? <span style={{ fontSize: 12 }}>{r.requestedDocuments.join(", ")}</span>
          : <span style={{ color: "#9CA3AF" }}>—</span>,
      },
      { id: "rdate", header: "Request date", cell: (r) => formatDate(r.requestDate) },
      {
        id: "ddate", header: "Due date",
        cell: (r) => {
          if (!r.dueDate) return <span style={{ color: "#9CA3AF" }}>—</span>;
          const color = r.isOverdue ? "#B91C1C" : r.isUrgent ? "#B45309" : "#0F172A";
          const tag = r.isOverdue ? " (overdue)" : r.isUrgent ? ` (in ${r.daysUntilDue}d)` : "";
          return <span style={{ color, fontWeight: 600 }}>{formatDate(r.dueDate)}{tag}</span>;
        },
      },
      {
        id: "charge", header: "Charge amount", align: "right",
        cell: (r) => formatCurrency(r.chargeAmount),
      },
      {
        id: "assigned", header: "Assigned to",
        cell: (r) => r.assignedTo ?? <span style={{ color: "#9CA3AF" }}>—</span>,
      },
    ],
    [],
  );

  const selectedRow = useMemo(
    () => filteredRows.find((r) => r.id === selectedRowId) ?? null,
    [filteredRows, selectedRowId],
  );

  // Hydrate detail context when a row is selected.
  useEffect(() => {
    if (!selectedRow) return;
    const claimId = selectedRow.claimId;
    if (ctxByClaim[claimId] || ctxLoading === claimId) return;
    setCtxLoading(claimId);
    void (async () => {
      try {
        const params = new URLSearchParams({ organizationId, claimId });
        const res = await fetch(`/api/billing/medical-review/context?${params.toString()}`, { cache: "no-store" });
        const json = (await res.json()) as ContextPayload;
        if (json.success && json.context) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setCtxByClaim((prev) => ({ ...prev, [claimId]: json.context! }));
        }
      } finally {
        setCtxLoading(null);
      }
    })();
  }, [selectedRow, organizationId, ctxByClaim, ctxLoading]);

  // ── Cover-letter compose modal ──
  const openCoverLetterModal = useCallback((row: MedicalReviewRow) => {
    // Selecting the row triggers the existing context fetch that hydrates
    // ctxByClaim[row.claimId] with the documents we'll pre-populate from.
    setSelectedRowId(row.id);
    const cached = ctxByClaim[row.claimId];
    const attachments: CoverLetterAttachmentDraft[] = cached
      ? cached.documents.map((d, i) => ({ key: `doc-${d.id}-${i}`, title: d.title || "Document" }))
      : [];
    setCoverModal({
      row,
      attention: "Attn: Claims / Medical Review",
      notes: "",
      attachments,
      attachmentsInitialized: Boolean(cached),
      submitting: false,
    });
  }, [ctxByClaim]);

  // Once the row's context arrives, seed the attachment list (only the first
  // time, so we don't clobber the biller's edits on a refresh).
  useEffect(() => {
    if (!coverModal || coverModal.attachmentsInitialized) return;
    const cached = ctxByClaim[coverModal.row.claimId];
    if (!cached) return;
    setCoverModal((prev) => prev && !prev.attachmentsInitialized ? {
      ...prev,
      attachments: cached.documents.map((d, i) => ({ key: `doc-${d.id}-${i}`, title: d.title || "Document" })),
      attachmentsInitialized: true,
    } : prev);
  }, [coverModal, ctxByClaim]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const performAction = useCallback(
    async (row: MedicalReviewRow, action: string, extra?: Record<string, unknown>) => {
      setActingId(row.id);
      try {
        const res = await fetch("/api/billing/medical-review/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            action,
            claimId: row.claimId,
            clientId: row.clientId,
            appointmentId: row.appointmentId,
            providerId: row.providerId,
            ...extra,
          }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Action failed");

        const assignment = (json?.assignment ?? null) as
          | { kind: "clinician" | "admin"; display: string; userId: string | null }
          | null;

        const nowIso = new Date().toISOString();
        setRows((prev) => prev.map((r) => {
          if (r.claimId !== row.claimId) return r;
          switch (action) {
            case "route_to_clinician":
            case "route_to_admin":
              return {
                ...r,
                assignedTo: assignment?.display ?? (action === "route_to_clinician" ? "Clinician" : "Admin pool"),
                assignedToKind: assignment?.kind ?? (action === "route_to_clinician" ? "clinician" : "admin"),
                lastActionAt: nowIso,
              };
            case "mark_submitted":
              return { ...r, submittedAt: nowIso, lastActionAt: nowIso };
            default:
              return { ...r, lastActionAt: nowIso };
          }
        }));
        // Invalidate the cached context so the next open re-fetches history.
        setCtxByClaim((prev) => {
          const next = { ...prev };
          delete next[row.claimId];
          return next;
        });
        // Remove submitted rows so they disappear from the live queue.
        if (action === "mark_submitted") {
          setRows((prev) => prev.filter((r) => r.claimId !== row.claimId));
          if (selectedRowId === row.id) setSelectedRowId(null);
        }
        const sendMsg = (() => {
          if (action !== "send_documentation") return null;
          const recipient = typeof json?.recipient === "string" ? json.recipient : null;
          const channel = typeof json?.channel === "string" ? json.channel : null;
          const status = typeof json?.status === "string" ? json.status : null;
          const count = Array.isArray(json?.fileList) ? json.fileList.length : 0;
          if (!recipient) return "Documentation sent";
          const verb = status === "queued" ? `Queued for ${channel ?? "fax"}` : "Sent";
          return `${verb} ${count} file(s) to ${recipient}`;
        })();
        setToast(sendMsg ?? (({
          attach_records: "Records attached",
          send_documentation: "Documentation sent",
          create_cover_letter: "Cover letter created",
          route_to_clinician: `Routed to ${assignment?.display ?? "clinician"}`,
          route_to_admin: "Routed to admin",
          mark_submitted: "Marked submitted",
        } as Record<string, string>)[action] ?? "Done"));
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
      } finally {
        setActingId(null);
      }
    },
    [organizationId, selectedRowId],
  );

  const refreshContext = useCallback((claimId: string) => {
    setCtxByClaim((prev) => {
      const next = { ...prev };
      delete next[claimId];
      return next;
    });
  }, []);

  const uploadFiles = useCallback(
    async (row: MedicalReviewRow, files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setUploadingClaim(row.claimId);
      try {
        let uploaded = 0;
        for (const f of list) {
          const fd = new FormData();
          fd.append("file", f);
          fd.append("claimId", row.claimId);
          fd.append("organizationId", organizationId);
          fd.append("documentType", "medical_records");
          const res = await fetch("/api/billing/medical-review/upload", { method: "POST", body: fd });
          const json = await res.json();
          if (!res.ok || json?.success === false) {
            throw new Error(json?.error ?? `Upload failed for ${f.name}`);
          }
          uploaded += 1;
        }
        refreshContext(row.claimId);
        setRows((prev) => prev.map((r) => r.claimId === row.claimId ? { ...r, lastActionAt: new Date().toISOString() } : r));
        setToast(uploaded === 1 ? "Uploaded 1 document" : `Uploaded ${uploaded} documents`);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setUploadingClaim(null);
      }
    },
    [organizationId, refreshContext],
  );

  const removeDocument = useCallback(
    async (row: MedicalReviewRow, documentId: string, label: string) => {
      if (typeof window !== "undefined" && !window.confirm(`Remove "${label}" from this claim?`)) return;
      setRemovingDocId(documentId);
      try {
        const params = new URLSearchParams({ organizationId });
        const res = await fetch(
          `/api/billing/claims/${row.claimId}/documents/${documentId}?${params.toString()}`,
          { method: "DELETE" },
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Remove failed");
        refreshContext(row.claimId);
        setRows((prev) => prev.map((r) => r.claimId === row.claimId ? { ...r, lastActionAt: new Date().toISOString() } : r));
        setToast("Document removed");
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Remove failed");
      } finally {
        setRemovingDocId(null);
      }
    },
    [organizationId, refreshContext],
  );

  const downloadSubmissionPacket = useCallback(
    async (row: MedicalReviewRow) => {
      setPacketClaim(row.claimId);
      try {
        const res = await fetch("/api/billing/medical-review/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            action: "download_submission_packet",
            claimId: row.claimId,
            clientId: row.clientId,
            appointmentId: row.appointmentId,
            providerId: row.providerId,
          }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Packet build failed");
        }
        const included = Array.isArray(json.included) ? json.included.length : 0;
        const skipped: Array<{ title: string; reason: string }> = Array.isArray(json.skipped)
          ? json.skipped
          : [];
        const doc = json.document as
          | { downloadUrl: string; fileName: string }
          | undefined;
        if (doc?.downloadUrl) {
          // Stream the merged PDF into a blob so the browser triggers
          // a real download (the file route returns inline content).
          try {
            const fileRes = await fetch(doc.downloadUrl, { cache: "no-store" });
            if (!fileRes.ok) throw new Error("Could not fetch packet");
            const blob = await fileRes.blob();
            const url = URL.createObjectURL(blob);
            const a = window.document.createElement("a");
            a.href = url;
            a.download = doc.fileName || "submission-packet.pdf";
            window.document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          } catch {
            window.open(doc.downloadUrl, "_blank", "noopener,noreferrer");
          }
        }
        refreshContext(row.claimId);
        setRows((prev) =>
          prev.map((r) =>
            r.claimId === row.claimId ? { ...r, lastActionAt: new Date().toISOString() } : r,
          ),
        );
        const base = `Packet ready (${included} attachment${included === 1 ? "" : "s"})`;
        setToast(
          skipped.length === 0
            ? base
            : `${base}. Skipped ${skipped.length}: ${skipped
                .slice(0, 2)
                .map((s) => s.title)
                .join(", ")}${skipped.length > 2 ? "…" : ""}`,
        );
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Packet build failed");
      } finally {
        setPacketClaim(null);
      }
    },
    [organizationId, refreshContext],
  );

  const startEditDocument = useCallback(
    (doc: { id: string; title: string; documentType: string | null }) => {
      setEditingDocId(doc.id);
      setEditDraft({ title: doc.title ?? "", documentType: doc.documentType ?? "" });
    },
    [],
  );

  const cancelEditDocument = useCallback(() => {
    setEditingDocId(null);
    setEditDraft({ title: "", documentType: "" });
  }, []);

  const saveDocumentEdit = useCallback(
    async (
      row: MedicalReviewRow,
      documentId: string,
      previous: { title: string; documentType: string | null },
    ) => {
      const nextTitle = editDraft.title.trim();
      const nextDocType = editDraft.documentType.trim();
      if (!nextTitle) {
        setToast("Title cannot be blank");
        return;
      }
      const payload: { title?: string; documentType?: string | null } = {};
      if (nextTitle !== (previous.title ?? "")) payload.title = nextTitle;
      const prevType = previous.documentType ?? "";
      if (nextDocType !== prevType) payload.documentType = nextDocType ? nextDocType : null;
      if (Object.keys(payload).length === 0) {
        cancelEditDocument();
        return;
      }
      setSavingDocId(documentId);
      try {
        const params = new URLSearchParams({ organizationId });
        const res = await fetch(
          `/api/billing/claims/${row.claimId}/documents/${documentId}?${params.toString()}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Save failed");
        refreshContext(row.claimId);
        setRows((prev) => prev.map((r) => r.claimId === row.claimId ? { ...r, lastActionAt: new Date().toISOString() } : r));
        setToast("Document updated");
        cancelEditDocument();
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Save failed");
      } finally {
        setSavingDocId(null);
      }
    },
    [editDraft, organizationId, refreshContext, cancelEditDocument],
  );

  const loadChartDocs = useCallback(
    async (clientId: string) => {
      setChartLoading(true);
      setChartError(null);
      setChartDocs([]);
      setChartSelection({});
      try {
        const params = new URLSearchParams({ organizationId });
        const res = await fetch(`/api/patients/${clientId}/documents?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Failed to load chart");
        type ChartDoc = { id: string; title: string | null; fileName: string | null; type: string | null; mimeType: string | null; claimId: string | null; createdAt: string | null };
        setChartDocs((json.documents as ChartDoc[]) ?? []);
      } catch (e) {
        setChartError(e instanceof Error ? e.message : "Failed to load chart");
      } finally {
        setChartLoading(false);
      }
    },
    [organizationId],
  );

  const attachFromChart = useCallback(
    async (row: MedicalReviewRow) => {
      const ids = Object.entries(chartSelection).filter(([, v]) => v).map(([k]) => k);
      if (ids.length === 0) return;
      setAttaching(true);
      try {
        const res = await fetch("/api/billing/medical-review/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, claimId: row.claimId, documentIds: ids }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Attach failed");
        refreshContext(row.claimId);
        setRows((prev) => prev.map((r) => r.claimId === row.claimId ? { ...r, lastActionAt: new Date().toISOString() } : r));
        setChartPickerOpen(false);
        setChartSelection({});
        const n = Array.isArray(json.attached) ? json.attached.length : ids.length;
        setToast(n === 1 ? "Attached 1 document" : `Attached ${n} documents`);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Attach failed");
      } finally {
        setAttaching(false);
      }
    },
    [chartSelection, organizationId, refreshContext],
  );

  const rowActions: RowAction<MedicalReviewRow>[] = useMemo(
    () => [
      { id: "attach", label: "Attach records", onClick: (r) => void performAction(r, "attach_records"), disabled: (r) => actingId === r.id },
      { id: "send", label: "Send documentation", variant: "primary", onClick: (r) => void performAction(r, "send_documentation"), disabled: (r) => actingId === r.id },
      { id: "cover", label: "Create cover letter", onClick: (r) => openCoverLetterModal(r), disabled: (r) => actingId === r.id },
      { id: "route", label: "Route to clinician", onClick: (r) => void performAction(r, "route_to_clinician"), disabled: (r) => actingId === r.id },
      { id: "submit", label: "Mark submitted", variant: "success", onClick: (r) => void performAction(r, "mark_submitted"), disabled: (r) => actingId === r.id },
    ],
    [actingId, performAction, openCoverLetterModal],
  );

  // ── Detail panel ────────────────────────────────────────────────────────
  const ctx = selectedRow ? ctxByClaim[selectedRow.claimId] : undefined;
  const ctxIsLoading = selectedRow && ctxLoading === selectedRow.claimId;

  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "payerRequest", label: "Payer request",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Request type" value={selectedRow.requestTypeLabel} />
            <DetailKV label="Source" value={selectedRow.requestSource ?? "—"} />
            <DetailKV
              label="Origin"
              value={selectedRow.triggerOrigin
                ? (selectedRow.triggerOrigin === "277CA"
                    ? "Payer 277CA acknowledgement"
                    : "Payer ERA (835) remittance")
                : "Manual / denial fallback"}
            />
            {selectedRow.triggerTrn ? (
              <DetailKV
                label="Matched claim TRN"
                value={
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>{selectedRow.triggerTrn}</span>
                }
              />
            ) : null}
            <DetailKV
              label="Trigger codes"
              value={selectedRow.triggerCodes.length
                ? selectedRow.triggerCodes.join(", ")
                : "—"}
            />
            {selectedRow.triggerCodes.length ? (
              <div style={{ padding: "8px 0 4px" }}>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {selectedRow.triggerCodes.map((c) => {
                    const desc = describeDocumentationCode(c);
                    return (
                      <li key={c} style={{ fontSize: 12, color: "#475569", display: "flex", gap: 8 }}>
                        <span
                          style={{
                            background: "#EFF6FF", color: "#1D4ED8",
                            padding: "1px 6px", borderRadius: 4,
                            fontFamily: "ui-monospace, monospace",
                            fontSize: 11, fontWeight: 600, alignSelf: "flex-start",
                          }}
                        >{c}</span>
                        <span style={{ flex: 1 }}>{desc ?? "No description on file for this code."}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            <DetailKV label="Request date" value={formatDateTime(selectedRow.requestDate)} />
            <DetailKV label="Due date" value={selectedRow.dueDate ? `${formatDate(selectedRow.dueDate)}${selectedRow.isOverdue ? " (overdue)" : selectedRow.isUrgent ? ` (in ${selectedRow.daysUntilDue}d)` : ""}` : "—"} />
            <DetailKV label="Requested documents" value={selectedRow.requestedDocuments.length ? selectedRow.requestedDocuments.join(", ") : "—"} />
            <DetailKV label="Denial code" value={selectedRow.denialCode ?? "—"} />
            {selectedRow.requestNotes ? (
              <p style={{ marginTop: 12, fontSize: 13, color: "#475569", whiteSpace: "pre-wrap" }}>
                {selectedRow.requestNotes}
              </p>
            ) : null}
          </div>
        ) : null,
      },
      {
        id: "clinicalNote", label: "Clinical note",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          if (!ctx?.clinicalNote) return <p style={{ color: "#64748B", fontSize: 13 }}>No clinical note found for the encounter.</p>;
          const n = ctx.clinicalNote;
          return (
            <div>
              <DetailKV label="Note status" value={n.status} />
              <DetailKV label="Signed" value={n.signedAt ? formatDateTime(n.signedAt) : <span style={{ color: "#B45309" }}>Unsigned</span>} />
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Subjective</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{n.subjective || "—"}</p>
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Objective</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{n.objective || "—"}</p>
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Plan</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{n.plan || "—"}</p>
            </div>
          );
        },
      },
      {
        id: "treatmentPlan", label: "Treatment plan",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          if (!ctx?.treatmentPlan) return <p style={{ color: "#64748B", fontSize: 13 }}>No active treatment plan on file.</p>;
          const p = ctx.treatmentPlan;
          return (
            <div>
              <DetailKV label="Status" value={p.status} />
              <DetailKV label="Start" value={formatDate(p.startDate)} />
              <DetailKV label="End" value={formatDate(p.endDate)} />
              <DetailKV label="Frequency" value={p.frequency ?? "—"} />
              <DetailKV label="Modality" value={p.modality ?? "—"} />
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Presenting problem</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{p.presentingProblem || "—"}</p>
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Long-term goals</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{p.longTermGoals || "—"}</p>
            </div>
          );
        },
      },
      {
        id: "assessment", label: "Assessment",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          const assessment = ctx?.clinicalNote?.assessment;
          if (!assessment) return <p style={{ color: "#64748B", fontSize: 13 }}>No assessment recorded on the latest clinical note.</p>;
          return (
            <div>
              <h4 style={{ fontSize: 13, margin: "0 0 4px" }}>SOAP — Assessment</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{assessment}</p>
            </div>
          );
        },
      },
      {
        id: "documents", label: "Uploaded documents",
        render: () => {
          if (!selectedRow) return null;
          const row = selectedRow;
          const docs = ctx?.documents ?? [];
          const isUploading = uploadingClaim === row.claimId;
          const isBuildingPacket = packetClaim === row.claimId;
          const selectedChartCount = Object.values(chartSelection).filter(Boolean).length;
          return (
            <div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "8px 0 12px", borderBottom: "1px solid #F1F5F9", marginBottom: 12 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files && files.length > 0) void uploadFiles(row, files);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  style={{ padding: "6px 12px", border: "1px solid #2563EB", background: "#2563EB", color: "#fff", borderRadius: 4, fontSize: 13, cursor: isUploading ? "wait" : "pointer" }}
                >
                  {isUploading ? "Uploading…" : "Upload files"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const opening = !chartPickerOpen;
                    setChartPickerOpen(opening);
                    if (opening && row.clientId) void loadChartDocs(row.clientId);
                  }}
                  disabled={!row.clientId}
                  style={{ padding: "6px 12px", border: "1px solid #CBD5E1", background: "#fff", color: "#0F172A", borderRadius: 4, fontSize: 13, cursor: row.clientId ? "pointer" : "not-allowed" }}
                  title={row.clientId ? "Pick from client chart" : "No client on this claim"}
                >
                  {chartPickerOpen ? "Hide chart picker" : "Attach from chart"}
                </button>
                <button
                  type="button"
                  onClick={() => void downloadSubmissionPacket(row)}
                  disabled={isBuildingPacket}
                  style={{ padding: "6px 12px", border: "1px solid #16A34A", background: isBuildingPacket ? "#94A3B8" : "#16A34A", color: "#fff", borderRadius: 4, fontSize: 13, cursor: isBuildingPacket ? "wait" : "pointer" }}
                  title="Merge the cover letter and attached documents into one PDF"
                >
                  {isBuildingPacket ? "Bundling…" : "Download submission packet"}
                </button>
                <span style={{ fontSize: 12, color: "#64748B" }}>Files go to the claim and appear below.</span>
              </div>

              {chartPickerOpen ? (
                <div style={{ border: "1px solid #E2E8F0", borderRadius: 6, padding: 10, marginBottom: 12, background: "#F8FAFC" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>Client chart documents</strong>
                    <button
                      type="button"
                      onClick={() => void attachFromChart(row)}
                      disabled={attaching || selectedChartCount === 0}
                      style={{ padding: "4px 10px", border: "1px solid #16A34A", background: selectedChartCount === 0 ? "#94A3B8" : "#16A34A", color: "#fff", borderRadius: 4, fontSize: 12, cursor: selectedChartCount === 0 ? "not-allowed" : "pointer" }}
                    >
                      {attaching ? "Attaching…" : `Attach selected (${selectedChartCount})`}
                    </button>
                  </div>
                  {chartLoading ? (
                    <p style={{ fontSize: 12, color: "#64748B", margin: 0 }}>Loading chart…</p>
                  ) : chartError ? (
                    <p style={{ fontSize: 12, color: "#B91C1C", margin: 0 }}>{chartError}</p>
                  ) : chartDocs.length === 0 ? (
                    <p style={{ fontSize: 12, color: "#64748B", margin: 0 }}>No chart documents found for this client.</p>
                  ) : (
                    <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 220, overflowY: "auto" }}>
                      {chartDocs.map((d) => {
                        const alreadyOnClaim = d.claimId === row.claimId;
                        return (
                          <li key={d.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0", borderBottom: "1px solid #E2E8F0" }}>
                            <input
                              type="checkbox"
                              checked={Boolean(chartSelection[d.id]) || alreadyOnClaim}
                              disabled={alreadyOnClaim}
                              onChange={(e) => setChartSelection((prev) => ({ ...prev, [d.id]: e.target.checked }))}
                              style={{ marginTop: 3 }}
                            />
                            <span aria-hidden="true" title={d.mimeType ?? d.type ?? "document"} style={{ fontSize: 16, lineHeight: "16px", marginTop: 2 }}>
                              {docTypeIcon(d.mimeType)}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "#0F172A" }}>{d.title || d.fileName || "Document"}</div>
                              <div style={{ fontSize: 11, color: "#64748B" }}>
                                {d.fileName ?? "—"}{d.type ? ` · ${d.type}` : ""}{d.mimeType ? ` · ${d.mimeType}` : ""}{d.createdAt ? ` · ${formatDate(d.createdAt)}` : ""}
                                {alreadyOnClaim ? " · already attached" : ""}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : null}

              {ctxIsLoading && !ctx ? (
                <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>
              ) : docs.length === 0 ? (
                <p style={{ color: "#64748B", fontSize: 13 }}>No documents attached to this claim yet.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {docs.map((d) => {
                    const fileHref = `/api/billing/claims/${row.claimId}/documents/${d.id}/file?organizationId=${encodeURIComponent(organizationId)}`;
                    const label = d.title || d.fileName || "Document";
                    const isRemoving = removingDocId === d.id;
                    const isEditing = editingDocId === d.id;
                    const isSaving = savingDocId === d.id;
                    return (
                      <li key={d.id} style={{ padding: "8px 0", borderBottom: "1px solid #F1F5F9", display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <span aria-hidden="true" title={d.mimeType ?? "document"} style={{ fontSize: 18, lineHeight: "18px", marginTop: 1 }}>
                          {docTypeIcon(d.mimeType)}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {isEditing ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <label style={{ fontSize: 11, color: "#475569", display: "flex", flexDirection: "column", gap: 2 }}>
                                Title
                                <input
                                  type="text"
                                  value={editDraft.title}
                                  onChange={(e) => setEditDraft((prev) => ({ ...prev, title: e.target.value }))}
                                  maxLength={200}
                                  disabled={isSaving}
                                  style={{ padding: "4px 8px", border: "1px solid #CBD5E1", borderRadius: 4, fontSize: 13 }}
                                />
                              </label>
                              <label style={{ fontSize: 11, color: "#475569", display: "flex", flexDirection: "column", gap: 2 }}>
                                Document type
                                <select
                                  value={editDraft.documentType}
                                  onChange={(e) => setEditDraft((prev) => ({ ...prev, documentType: e.target.value }))}
                                  disabled={isSaving}
                                  style={{ padding: "4px 8px", border: "1px solid #CBD5E1", borderRadius: 4, fontSize: 13, background: "#fff" }}
                                >
                                  <option value="">— None —</option>
                                  <option value="medical_records">Medical records</option>
                                  <option value="treatment_plan">Treatment plan</option>
                                  <option value="clinical_note">Clinical note</option>
                                  <option value="progress_note">Progress note</option>
                                  <option value="assessment">Assessment</option>
                                  <option value="prior_auth">Prior authorization</option>
                                  <option value="payer_correspondence">Payer correspondence</option>
                                  <option value="eob">EOB</option>
                                  <option value="insurance_card">Insurance card</option>
                                  <option value="consent">Consent form</option>
                                  <option value="intake">Intake form</option>
                                  <option value="id">ID document</option>
                                  <option value="other">Other</option>
                                  {editDraft.documentType &&
                                    ![
                                      "medical_records",
                                      "treatment_plan",
                                      "clinical_note",
                                      "progress_note",
                                      "assessment",
                                      "prior_auth",
                                      "payer_correspondence",
                                      "eob",
                                      "insurance_card",
                                      "consent",
                                      "intake",
                                      "id",
                                      "other",
                                    ].includes(editDraft.documentType) ? (
                                      <option value={editDraft.documentType}>{editDraft.documentType}</option>
                                    ) : null}
                                </select>
                              </label>
                              <div style={{ fontSize: 11, color: "#64748B" }}>{d.fileName}</div>
                            </div>
                          ) : (
                            <>
                              <div style={{ fontSize: 13, fontWeight: 600 }}>{d.title}</div>
                              <div style={{ fontSize: 12, color: "#64748B" }}>
                                {d.fileName}{d.documentType ? ` · ${d.documentType}` : ""}{d.mimeType ? ` · ${d.mimeType}` : ""} · uploaded {formatDateTime(d.uploadedAt)}
                              </div>
                              {d.notes ? <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>{d.notes}</div> : null}
                            </>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void saveDocumentEdit(row, d.id, { title: d.title, documentType: d.documentType })}
                                disabled={isSaving}
                                style={{ fontSize: 12, padding: "4px 10px", border: "1px solid #16A34A", color: "#fff", background: isSaving ? "#94A3B8" : "#16A34A", borderRadius: 4, cursor: isSaving ? "wait" : "pointer" }}
                              >
                                {isSaving ? "Saving…" : "Save"}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEditDocument}
                                disabled={isSaving}
                                style={{ fontSize: 12, padding: "4px 10px", border: "1px solid #CBD5E1", color: "#0F172A", background: "#fff", borderRadius: 4, cursor: isSaving ? "not-allowed" : "pointer" }}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <a
                                href={fileHref}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ fontSize: 12, padding: "4px 10px", border: "1px solid #2563EB", color: "#2563EB", borderRadius: 4, textDecoration: "none", background: "#fff" }}
                              >
                                Open
                              </a>
                              <button
                                type="button"
                                onClick={() => startEditDocument({ id: d.id, title: d.title, documentType: d.documentType })}
                                disabled={isRemoving || Boolean(editingDocId)}
                                style={{ fontSize: 12, padding: "4px 10px", border: "1px solid #2563EB", color: editingDocId ? "#94A3B8" : "#2563EB", background: "#fff", borderRadius: 4, cursor: editingDocId ? "not-allowed" : "pointer" }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => void removeDocument(row, d.id, label)}
                                disabled={isRemoving || Boolean(editingDocId)}
                                style={{ fontSize: 12, padding: "4px 10px", border: "1px solid #DC2626", color: isRemoving || editingDocId ? "#94A3B8" : "#DC2626", background: "#fff", borderRadius: 4, cursor: isRemoving ? "wait" : editingDocId ? "not-allowed" : "pointer" }}
                              >
                                {isRemoving ? "Removing…" : "Remove"}
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        },
      },
      {
        id: "history", label: "Submission history",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          const hist = ctx?.history ?? [];
          const txs = ctx?.transmissions ?? [];
          if (hist.length === 0 && txs.length === 0) {
            return <p style={{ color: "#64748B", fontSize: 13 }}>No medical-review actions logged yet.</p>;
          }
          // 'delivered' is the new terminal success (Telnyx confirmed
          // the recipient machine answered). 'sent' is the legacy
          // synonym for back-compat with rows written before the
          // reconciler existed. 'sending' is the new mid-flight state
          // (provider accepted the job, awaiting delivery).
          const statusColor = (s: string) =>
            s === "delivered" || s === "sent" ? "#15803D" :
            s === "failed" ? "#B91C1C" :
            s === "queued" || s === "sending" ? "#B45309" :
            "#475569";
          return (
            <div>
              {txs.length > 0 ? (
                <section style={{ marginBottom: 16 }}>
                  <h4 style={{ fontSize: 13, margin: "0 0 6px", color: "#0F172A" }}>Documentation sent</h4>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {txs.map((t) => (
                      <li key={t.id} style={{ padding: "8px 0", borderBottom: "1px solid #F1F5F9", fontSize: 13 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                          <div>
                            <strong style={{ textTransform: "uppercase", fontSize: 11, letterSpacing: 0.5, color: "#475569" }}>
                              {t.channel}
                            </strong>
                            <span style={{ marginLeft: 8 }}>
                              {t.recipient || <span style={{ color: "#9CA3AF" }}>—</span>}
                            </span>
                          </div>
                          <span
                            style={{
                              fontSize: 11, fontWeight: 700, color: statusColor(t.status),
                              border: `1px solid ${statusColor(t.status)}`, padding: "1px 6px", borderRadius: 4,
                              textTransform: "uppercase", letterSpacing: 0.5,
                            }}
                          >
                            {t.status}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>
                          {t.sentAt ? `Sent ${formatDateTime(t.sentAt)}` : `Queued ${formatDateTime(t.createdAt)}`}
                          {t.providerMessageId ? ` · ref ${t.providerMessageId.slice(0, 8)}` : ""}
                        </div>
                        {t.files.length > 0 ? (
                          <ul style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 12, color: "#374151" }}>
                            {t.files.map((f) => (
                              <li key={f.id || f.fileName}>{f.title}{f.fileName && f.fileName !== f.title ? ` (${f.fileName})` : ""}</li>
                            ))}
                          </ul>
                        ) : null}
                        {t.error ? (
                          <div style={{ fontSize: 12, color: "#B91C1C", marginTop: 4 }}>Error: {t.error}</div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {hist.length > 0 ? (
                <section>
                  <h4 style={{ fontSize: 13, margin: "0 0 6px", color: "#0F172A" }}>Action log</h4>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {hist.map((h) => (
                      <li key={h.id} style={{ padding: "6px 0", borderBottom: "1px solid #F1F5F9", fontSize: 13 }}>
                        <strong>{h.action.replace(/^medical_review_/, "").replace(/_/g, " ")}</strong>
                        <span style={{ color: "#64748B", marginLeft: 8 }}>{formatDateTime(h.createdAt)}</span>
                        {h.summary ? <div style={{ color: "#475569", fontSize: 12 }}>{h.summary}</div> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "documents",
        label: "Related documents",
        render: () =>
          selectedRow?.claimId ? (
            <ClaimDocumentsPanel
              claimId={selectedRow.claimId}
              organizationId={organizationId}
            />
          ) : null,
      },
    ],
    [
      selectedRow, ctx, ctxIsLoading,
      uploadingClaim, uploadFiles,
      packetClaim, downloadSubmissionPacket,
      chartPickerOpen, chartDocs, chartLoading, chartError, chartSelection,
      loadChartDocs, attachFromChart, attaching,
      organizationId, removingDocId, removeDocument,
    ],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const r = selectedRow;
    const buildingPacket = packetClaim === r.claimId;
    return [
      { id: "attach", label: "Attach records", onClick: () => void performAction(r, "attach_records"), disabled: actingId === r.id },
      { id: "send", label: "Send documentation", variant: "primary", onClick: () => void performAction(r, "send_documentation"), disabled: actingId === r.id },
      { id: "cover", label: "Create cover letter", onClick: () => openCoverLetterModal(r), disabled: actingId === r.id },
      { id: "packet", label: buildingPacket ? "Bundling…" : "Download submission packet", onClick: () => void downloadSubmissionPacket(r), disabled: buildingPacket },
      { id: "route", label: "Route to clinician", onClick: () => void performAction(r, "route_to_clinician"), disabled: actingId === r.id },
      { id: "submit", label: "Mark submitted", variant: "success", onClick: () => void performAction(r, "mark_submitted"), disabled: actingId === r.id },
    ];
  }, [selectedRow, actingId, performAction, openCoverLetterModal, packetClaim, downloadSubmissionPacket]);

  const primaryTabs = useMemo(
    () => MEDICAL_REVIEW_TABS.map((t) => ({ id: t.id, label: t.label, count: tabCounts[t.id] })),
    [tabCounts],
  );

  return (
    <WorkqueueShell<MedicalReviewRow>
      title={queueDef?.title ?? "Medical Review / Documentation Requested"}
      description={queueDef?.description}
      headerActions={[
        { id: "refresh", label: "Refresh", onClick: () => void load() },
      ]}
      summary={summary}
      primaryTabs={primaryTabs}
      activePrimaryTabId={activeTab}
      onPrimaryTabChange={(id) => { setActiveTab(id as MedicalReviewTab); setSelectedRowId(null); }}
      filters={filters}
      filterValues={filterValues}
      onFilterChange={setFilterValues}
      filterUrlNamespace="mr"
      rows={filteredRows}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage={error ?? "No claims in this tab."}
      selectedRowId={selectedRowId}
      onSelectRow={setSelectedRowId}
      rowActions={rowActions}
      detailTabs={detailTabs}
      detailActions={detailActions}
      message={error ? { tone: "error", text: error } : null}
      overlay={
        <>
          {coverModal ? (
            <CoverLetterComposeModal
              state={coverModal}
              ctxLoading={ctxLoading === coverModal.row.claimId && !ctxByClaim[coverModal.row.claimId]}
              onChange={(updater) => setCoverModal((prev) => (prev ? updater(prev) : prev))}
              onClose={() => setCoverModal(null)}
              onGenerate={async () => {
                const m = coverModal;
                setCoverModal((prev) => prev ? { ...prev, submitting: true } : prev);
                try {
                  const res = await fetch("/api/billing/medical-review/actions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      organizationId,
                      action: "create_cover_letter",
                      claimId: m.row.claimId,
                      clientId: m.row.clientId,
                      appointmentId: m.row.appointmentId,
                      providerId: m.row.providerId,
                      payerAttention: m.attention.trim() || null,
                      note: m.notes.trim(),
                      // Always send as an explicit array (even when empty) so
                      // the server treats the biller's edits as authoritative
                      // and never silently falls back to DB-attached docs.
                      documentTitles: m.attachments.map((a) => a.title.trim()).filter(Boolean),
                    }),
                  });
                  const json = await res.json();
                  if (!res.ok || json?.success === false) {
                    throw new Error(json?.error ?? "Failed to generate cover letter");
                  }
                  refreshContext(m.row.claimId);
                  setRows((prev) => prev.map((r) => r.claimId === m.row.claimId ? { ...r, lastActionAt: new Date().toISOString() } : r));
                  setToast("Cover letter created");
                  setCoverModal(null);
                } catch (e) {
                  // Keep the modal open so the biller can correct and retry
                  // without losing their edits.
                  setToast(e instanceof Error ? e.message : "Failed to generate cover letter");
                  setCoverModal((prev) => prev ? { ...prev, submitting: false } : prev);
                }
              }}
            />
          ) : null}
          {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
        </>
      }
    />
  );
}

interface CoverLetterModalProps {
  state: {
    row: MedicalReviewRow;
    attention: string;
    notes: string;
    attachments: Array<{ key: string; title: string }>;
    attachmentsInitialized: boolean;
    submitting: boolean;
  };
  ctxLoading: boolean;
  onChange: (updater: (prev: CoverLetterModalProps["state"]) => CoverLetterModalProps["state"]) => void;
  onClose: () => void;
  onGenerate: () => void;
}

function CoverLetterComposeModal({ state, ctxLoading, onChange, onClose, onGenerate }: CoverLetterModalProps) {
  const r = state.row;
  const moveAttachment = (idx: number, dir: -1 | 1) => {
    onChange((prev) => {
      const next = [...prev.attachments];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return { ...prev, attachments: next };
    });
  };
  const removeAttachment = (idx: number) => {
    onChange((prev) => ({ ...prev, attachments: prev.attachments.filter((_, i) => i !== idx) }));
  };
  const addAttachment = () => {
    onChange((prev) => ({
      ...prev,
      attachments: [...prev.attachments, { key: `new-${Date.now()}-${prev.attachments.length}`, title: "" }],
      attachmentsInitialized: true,
    }));
  };
  const editAttachment = (idx: number, title: string) => {
    onChange((prev) => {
      const next = [...prev.attachments];
      next[idx] = { ...next[idx], title };
      return { ...prev, attachments: next };
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Compose cover letter"
      style={{
        position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.45)",
        zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !state.submitting) onClose(); }}
    >
      <div style={{
        background: "#fff", borderRadius: 8, width: "100%", maxWidth: 640,
        maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 60px rgba(0,0,0,0.25)",
      }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #E2E8F0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, color: "#0F172A" }}>Compose cover letter</h2>
            <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>
              Review the details before generating the PDF.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={state.submitting}
            style={{ border: "none", background: "transparent", fontSize: 20, color: "#64748B", cursor: state.submitting ? "wait" : "pointer", lineHeight: 1 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: 12, fontSize: 12, color: "#475569" }}>
            <div><strong style={{ color: "#0F172A" }}>Payer:</strong> {r.payerName || "—"}</div>
            <div><strong style={{ color: "#0F172A" }}>Client:</strong> {r.clientName}</div>
            <div><strong style={{ color: "#0F172A" }}>Claim:</strong> {r.claimNumber || r.claimId.slice(0, 8)}</div>
            <div><strong style={{ color: "#0F172A" }}>Date of service:</strong> {formatDate(r.dateOfService)}</div>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#0F172A" }}>
            <span style={{ fontWeight: 600 }}>Attention line</span>
            <input
              type="text"
              value={state.attention}
              onChange={(e) => onChange((prev) => ({ ...prev, attention: e.target.value }))}
              disabled={state.submitting}
              placeholder="Attn: Claims / Medical Review"
              style={{ padding: "8px 10px", border: "1px solid #CBD5E1", borderRadius: 4, fontSize: 13 }}
            />
            <span style={{ fontSize: 11, color: "#64748B" }}>
              e.g. &ldquo;Attn: Utilization Review&rdquo; or &ldquo;Attn: Claims Department&rdquo;.
            </span>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#0F172A" }}>
            <span style={{ fontWeight: 600 }}>Notes / body</span>
            <textarea
              value={state.notes}
              onChange={(e) => onChange((prev) => ({ ...prev, notes: e.target.value }))}
              disabled={state.submitting}
              placeholder="Optional context, payer reference number, instructions…"
              rows={4}
              style={{ padding: "8px 10px", border: "1px solid #CBD5E1", borderRadius: 4, fontSize: 13, resize: "vertical", fontFamily: "inherit" }}
            />
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "#0F172A", fontWeight: 600 }}>Enclosures</span>
              <button
                type="button"
                onClick={addAttachment}
                disabled={state.submitting}
                style={{ padding: "4px 10px", border: "1px solid #CBD5E1", background: "#fff", color: "#0F172A", borderRadius: 4, fontSize: 12, cursor: "pointer" }}
              >
                + Add enclosure
              </button>
            </div>
            {ctxLoading && state.attachments.length === 0 ? (
              <p style={{ fontSize: 12, color: "#64748B", margin: "4px 0" }}>Loading attached documents…</p>
            ) : state.attachments.length === 0 ? (
              <p style={{ fontSize: 12, color: "#64748B", margin: "4px 0" }}>
                No enclosures. The cover letter will note that no supporting documents are attached.
              </p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, border: "1px solid #E2E8F0", borderRadius: 6 }}>
                {state.attachments.map((att, i) => (
                  <li
                    key={att.key}
                    style={{
                      display: "flex", gap: 6, alignItems: "center",
                      padding: "6px 8px",
                      borderBottom: i === state.attachments.length - 1 ? "none" : "1px solid #F1F5F9",
                    }}
                  >
                    <span style={{ fontSize: 12, color: "#64748B", width: 22, textAlign: "right" }}>{i + 1}.</span>
                    <input
                      type="text"
                      value={att.title}
                      onChange={(e) => editAttachment(i, e.target.value)}
                      disabled={state.submitting}
                      placeholder="Document title"
                      style={{ flex: 1, padding: "5px 8px", border: "1px solid #CBD5E1", borderRadius: 4, fontSize: 12 }}
                    />
                    <button type="button" onClick={() => moveAttachment(i, -1)} disabled={state.submitting || i === 0}
                      title="Move up"
                      style={{ border: "1px solid #CBD5E1", background: "#fff", borderRadius: 4, padding: "2px 6px", fontSize: 12, cursor: i === 0 ? "not-allowed" : "pointer", opacity: i === 0 ? 0.4 : 1 }}>↑</button>
                    <button type="button" onClick={() => moveAttachment(i, 1)} disabled={state.submitting || i === state.attachments.length - 1}
                      title="Move down"
                      style={{ border: "1px solid #CBD5E1", background: "#fff", borderRadius: 4, padding: "2px 6px", fontSize: 12, cursor: i === state.attachments.length - 1 ? "not-allowed" : "pointer", opacity: i === state.attachments.length - 1 ? 0.4 : 1 }}>↓</button>
                    <button type="button" onClick={() => removeAttachment(i)} disabled={state.submitting}
                      title="Remove"
                      style={{ border: "1px solid #FCA5A5", background: "#fff", color: "#B91C1C", borderRadius: 4, padding: "2px 8px", fontSize: 12, cursor: "pointer" }}>×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid #E2E8F0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={state.submitting}
            style={{ padding: "8px 14px", border: "1px solid #CBD5E1", background: "#fff", color: "#0F172A", borderRadius: 4, fontSize: 13, cursor: state.submitting ? "wait" : "pointer" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onGenerate}
            disabled={state.submitting}
            style={{ padding: "8px 14px", border: "1px solid #2563EB", background: "#2563EB", color: "#fff", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: state.submitting ? "wait" : "pointer" }}
          >
            {state.submitting ? "Generating…" : "Generate PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
