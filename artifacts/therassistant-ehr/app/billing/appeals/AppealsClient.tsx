"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

// ─── Types ──────────────────────────────────────────────────────────────────

type TabId =
  | "draft_needed"
  | "draft_ready"
  | "sent"
  | "pending"
  | "overdue"
  | "decided";

interface Row {
  id: string;
  claimId: string;
  claimNumber: string;
  clientId: string | null;
  clientName: string;
  memberId: string;
  payerName: string;
  payerProfileId: string | null;
  payerFaxNumber: string | null;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  deniedAmount: number;
  denialReason: string;
  appealId: string | null;
  appealLevel: number;
  appealDeadline: string | null;
  appealStatus: string;
  appealStatusLabel: string;
  appealSubmittedAt: string | null;
  appealDecision: string | null;
  appealDecisionAt: string | null;
  assignedToUserId: string | null;
  assignedToDisplayName: string | null;
  letterBody: string;
  templateId: string | null;
  attachmentsCount: number;
  submissionChannel: string | null;
  noteCount: number;
  claimStatus: string;
  claimUpdatedAt: string | null;
  claimCreatedAt: string | null;
  ageDays: number;
  tab: TabId;
  priority: string;
}

interface Assignee { id: string; displayName: string }
interface Template { id: string; name: string; body: string; isSystem: boolean }
interface Metrics {
  totalCount: number;
  totalDollars: number;
  oldestAgeDays: number;
  urgentCount: number;
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "draft_needed", label: "Appeal Draft Needed" },
  { id: "draft_ready", label: "Appeal Ready to Send" },
  { id: "sent", label: "Appeal Sent" },
  { id: "pending", label: "Appeal Pending" },
  { id: "overdue", label: "Appeal Overdue" },
  { id: "decided", label: "Appeal Won/Lost" },
];

const EMPTY_TAB_COUNTS: Record<TabId, number> = {
  draft_needed: 0,
  draft_ready: 0,
  sent: 0,
  pending: 0,
  overdue: 0,
  decided: 0,
};

// ─── Utils ──────────────────────────────────────────────────────────────────

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}
function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
}
function daysUntil(value: string | null) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / 86_400_000);
}

function applyPlaceholders(body: string, row: Row): string {
  return body
    .replace(/\[Client Name\]/g, row.clientName || "")
    .replace(/\[Member ID\]/g, row.memberId || "")
    .replace(/\[Payer Name\]/g, row.payerName || "")
    .replace(/\[Claim Number\]/g, row.claimNumber || "")
    .replace(/\[DOS\]/g, row.serviceDateFrom ? formatDate(row.serviceDateFrom) : "")
    .replace(/\[Denial Reason\]/g, row.denialReason || "")
    .replace(/\[Date\]/g, new Date().toLocaleDateString());
}

// ─── Detail panel building blocks ──────────────────────────────────────────

function DetailKV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid #F1F5F9" }}>
      <div style={{ minWidth: 140, color: "#64748B", fontSize: 13 }}>{label}</div>
      <div style={{ color: "#0F172A", fontSize: 13, fontWeight: 500 }}>{value ?? "—"}</div>
    </div>
  );
}

// ─── Toast / Modal ─────────────────────────────────────────────────────────

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, background: "#111827", color: "#fff",
      padding: "10px 16px", borderRadius: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.18)", zIndex: 1100,
    }}>
      {message}
    </div>
  );
}

function ModalShell({
  title, onClose, children, width = 480,
}: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "#fff", width, maxWidth: "92vw", maxHeight: "88vh", overflow: "auto",
        borderRadius: 8, padding: 24, boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" }}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const fieldLabel: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 };
const fieldInput: React.CSSProperties = {
  width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4,
  fontFamily: "inherit", fontSize: 13,
};
const btnRow: React.CSSProperties = { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16, flexWrap: "wrap" };
const primaryBtn: React.CSSProperties = { padding: "6px 12px", background: "#1D4ED8", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" };
const secondaryBtn: React.CSSProperties = { padding: "6px 12px", background: "#fff", color: "#0F172A", border: "1px solid #D1D5DB", borderRadius: 4, cursor: "pointer" };

// ─── Action helper ─────────────────────────────────────────────────────────

interface ActionResponse {
  success: boolean;
  error?: string;
  patch?: Partial<Row>;
  removeFromQueue?: boolean;
}
async function callAction(body: Record<string, unknown>): Promise<ActionResponse> {
  const res = await fetch("/api/billing/appeals/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  }
  return { success: true, ...json };
}

// ─── Modals ────────────────────────────────────────────────────────────────

function GenerateAppealModal({
  row, organizationId, templates, onClose, onDone,
}: {
  row: Row; organizationId: string; templates: Template[];
  onClose: () => void; onDone: (patch: Partial<Row>, msg: string) => void;
}) {
  const [templateId, setTemplateId] = useState<string>(row.templateId ?? "");
  const [letter, setLetter] = useState<string>(row.letterBody || "");
  const [deadline, setDeadline] = useState<string>(row.appealDeadline ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function pick(id: string) {
    setTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (tpl) setLetter(applyPlaceholders(tpl.body, row));
  }

  return (
    <ModalShell title={`Generate appeal — ${row.clientName}`} onClose={onClose} width={680}>
      <p style={{ color: "#64748B", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claimNumber} · {row.payerName} · denied {formatCurrency(row.deniedAmount)}
      </p>
      <label style={fieldLabel}>Template</label>
      <select style={fieldInput} value={templateId} onChange={(e) => pick(e.target.value)}>
        <option value="">— Choose a template —</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>{t.name}{t.isSystem ? " (system)" : ""}</option>
        ))}
      </select>
      <label style={{ ...fieldLabel, marginTop: 12 }}>Appeal deadline</label>
      <input type="date" style={fieldInput} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      <label style={{ ...fieldLabel, marginTop: 12 }}>Appeal letter</label>
      <textarea
        rows={14}
        style={{ ...fieldInput, fontFamily: "ui-monospace, Menlo, monospace" }}
        value={letter}
        onChange={(e) => setLetter(e.target.value)}
      />
      {err ? <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>{err}</div> : null}
      <div style={btnRow}>
        <button type="button" style={secondaryBtn} onClick={onClose} disabled={busy}>Cancel</button>
        <button
          type="button"
          style={primaryBtn}
          disabled={busy || !letter.trim()}
          onClick={async () => {
            setBusy(true); setErr(null);
            const r = await callAction({
              action: "generate",
              organizationId,
              claimId: row.claimId,
              letterBody: letter,
              templateId: templateId || null,
              deadline: deadline || null,
              denialReason: row.denialReason || null,
            });
            setBusy(false);
            if (!r.success) { setErr(r.error ?? "Failed"); return; }
            onDone(r.patch ?? {}, "Appeal draft saved");
            onClose();
          }}
        >
          {busy ? "Saving…" : "Save draft"}
        </button>
      </div>
    </ModalShell>
  );
}

function AssignModal({
  row, organizationId, assignees, onClose, onDone,
}: {
  row: Row; organizationId: string; assignees: Assignee[];
  onClose: () => void; onDone: (patch: Partial<Row>, msg: string) => void;
}) {
  const [userId, setUserId] = useState<string>(row.assignedToUserId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <ModalShell title={`Assign appeal — ${row.claimNumber}`} onClose={onClose}>
      <label style={fieldLabel}>Assign to</label>
      <select style={fieldInput} value={userId} onChange={(e) => setUserId(e.target.value)}>
        <option value="">Unassigned</option>
        {assignees.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
      </select>
      {err ? <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>{err}</div> : null}
      <div style={btnRow}>
        <button type="button" style={secondaryBtn} onClick={onClose}>Cancel</button>
        <button type="button" style={primaryBtn} disabled={busy}
          onClick={async () => {
            setBusy(true); setErr(null);
            const a = assignees.find((x) => x.id === userId);
            const r = await callAction({
              action: "assign",
              organizationId,
              claimId: row.claimId,
              assignedToUserId: userId || null,
              assigneeDisplayName: a?.displayName ?? null,
            });
            setBusy(false);
            if (!r.success) { setErr(r.error ?? "Failed"); return; }
            onDone(
              { ...(r.patch ?? {}), assignedToUserId: userId || null, assignedToDisplayName: a?.displayName ?? null },
              userId ? `Assigned to ${a?.displayName ?? "user"}` : "Unassigned",
            );
            onClose();
          }}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function ResolveModal({
  row, organizationId, onClose, onDone,
}: {
  row: Row; organizationId: string;
  onClose: () => void; onDone: (patch: Partial<Row>, msg: string) => void;
}) {
  const [outcome, setOutcome] = useState<"won" | "lost">("won");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <ModalShell title={`Mark resolved — ${row.claimNumber}`} onClose={onClose}>
      <label style={fieldLabel}>Outcome</label>
      <select style={fieldInput} value={outcome} onChange={(e) => setOutcome(e.target.value as "won" | "lost")}>
        <option value="won">Won</option>
        <option value="lost">Lost</option>
      </select>
      <label style={{ ...fieldLabel, marginTop: 12 }}>Decision note (optional)</label>
      <textarea style={{ ...fieldInput, minHeight: 80 }} value={note} onChange={(e) => setNote(e.target.value)} />
      {err ? <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>{err}</div> : null}
      <div style={btnRow}>
        <button type="button" style={secondaryBtn} onClick={onClose}>Cancel</button>
        <button type="button" style={primaryBtn} disabled={busy}
          onClick={async () => {
            setBusy(true); setErr(null);
            const r = await callAction({
              action: "mark_resolved",
              organizationId,
              claimId: row.claimId,
              outcome,
              note,
            });
            setBusy(false);
            if (!r.success) { setErr(r.error ?? "Failed"); return; }
            onDone(r.patch ?? {}, outcome === "won" ? "Appeal marked won" : "Appeal marked lost");
            onClose();
          }}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function SubmitAppealModal({
  row, organizationId, onClose, onDone,
}: {
  row: Row; organizationId: string;
  onClose: () => void; onDone: (patch: Partial<Row>, msg: string) => void;
}) {
  const hasFax = Boolean(row.payerFaxNumber);
  const [channel, setChannel] = useState<"fax" | "portal" | "mail">(
    hasFax ? "fax" : "portal",
  );
  const [faxNumber, setFaxNumber] = useState<string>(row.payerFaxNumber ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [portalAck, setPortalAck] = useState(false);
  const [mailAck, setMailAck] = useState(false);

  const canSubmit =
    !busy &&
    (channel === "fax"
      ? faxNumber.trim().length > 0
      : channel === "portal"
        ? portalAck
        : mailAck);

  return (
    <ModalShell title={`Submit appeal — ${row.claimNumber}`} onClose={onClose} width={520}>
      <p style={{ color: "#64748B", fontSize: 13, margin: "0 0 12px" }}>
        {row.payerName} · denied {formatCurrency(row.deniedAmount)} · L{row.appealLevel}
      </p>

      <label style={fieldLabel}>How are you sending this appeal?</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input
            type="radio"
            name="appeal-channel"
            checked={channel === "fax"}
            onChange={() => setChannel("fax")}
          />
          <span>
            Fax to payer
            {hasFax ? (
              <span style={{ color: "#64748B" }}> — on file: {row.payerFaxNumber}</span>
            ) : (
              <span style={{ color: "#B45309" }}> — no fax on payer profile</span>
            )}
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input
            type="radio"
            name="appeal-channel"
            checked={channel === "portal"}
            onChange={() => setChannel("portal")}
          />
          <span>Submitted via payer portal (already filed outside the system)</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input
            type="radio"
            name="appeal-channel"
            checked={channel === "mail"}
            onChange={() => setChannel("mail")}
          />
          <span>Mailed paper appeal</span>
        </label>
      </div>

      {channel === "fax" ? (
        <>
          <label style={fieldLabel}>Fax number</label>
          <input
            type="text"
            style={fieldInput}
            value={faxNumber}
            onChange={(e) => setFaxNumber(e.target.value)}
            placeholder="e.g. 1-800-555-1212"
          />
          <p style={{ color: "#64748B", fontSize: 12, marginTop: 6 }}>
            Queues the letter to the outbound fax pipeline and marks the appeal sent.
          </p>
        </>
      ) : null}

      {channel === "portal" ? (
        <label style={{ display: "flex", gap: 8, fontSize: 13, alignItems: "flex-start", marginTop: 4 }}>
          <input
            type="checkbox"
            checked={portalAck}
            onChange={(e) => setPortalAck(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            I confirm this appeal has been filed via the {row.payerName} payer portal.
            Logging it here marks status <strong>Sent</strong> and stamps the channel.
          </span>
        </label>
      ) : null}

      {channel === "mail" ? (
        <label style={{ display: "flex", gap: 8, fontSize: 13, alignItems: "flex-start", marginTop: 4 }}>
          <input
            type="checkbox"
            checked={mailAck}
            onChange={(e) => setMailAck(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            I confirm the printed appeal packet has been put in the mail to {row.payerName}.
          </span>
        </label>
      ) : null}

      {err ? <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>{err}</div> : null}
      <div style={btnRow}>
        <button type="button" style={secondaryBtn} onClick={onClose} disabled={busy}>Cancel</button>
        <button
          type="button"
          style={primaryBtn}
          disabled={!canSubmit}
          onClick={async () => {
            setBusy(true); setErr(null);
            const r = await callAction({
              action: "submit",
              organizationId,
              claimId: row.claimId,
              channel,
              faxNumber: channel === "fax" ? faxNumber.trim() : undefined,
            });
            setBusy(false);
            if (!r.success) { setErr(r.error ?? "Submit failed"); return; }
            const msg =
              channel === "fax"
                ? `Appeal queued to fax ${faxNumber.trim()}`
                : channel === "portal"
                  ? "Appeal marked submitted via portal"
                  : "Appeal marked submitted via mail";
            onDone(r.patch ?? {}, msg);
            onClose();
          }}
        >
          {busy
            ? "Submitting…"
            : channel === "fax"
              ? "Queue fax & mark sent"
              : channel === "portal"
                ? "Mark submitted via portal"
                : "Mark submitted via mail"}
        </button>
      </div>
    </ModalShell>
  );
}

interface AppealDocument {
  id: string;
  appealId: string;
  claimId: string;
  fileName: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  description: string | null;
  uploadedByDisplayName: string | null;
  uploadedAt: string | null;
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchAppealDocuments(
  appealId: string,
  organizationId: string,
): Promise<AppealDocument[]> {
  const params = new URLSearchParams({ organizationId });
  const res = await fetch(
    `/api/billing/appeals/${encodeURIComponent(appealId)}/documents?${params.toString()}`,
    { cache: "no-store" },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) return [];
  return (json.documents ?? []) as AppealDocument[];
}

interface ChartDocument {
  id: string;
  title: string | null;
  fileName: string | null;
  type: string | null;
  scope: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  filedAt: string | null;
  createdAt: string | null;
  hasFile: boolean;
}

async function fetchChartDocuments(
  clientId: string,
  organizationId: string,
): Promise<ChartDocument[]> {
  const params = new URLSearchParams({ organizationId });
  const res = await fetch(
    `/api/patients/${encodeURIComponent(clientId)}/documents?${params.toString()}`,
    { cache: "no-store" },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) return [];
  type RawDoc = {
    id?: unknown;
    title?: unknown;
    fileName?: unknown;
    type?: unknown;
    scope?: unknown;
    mimeType?: unknown;
    fileSizeBytes?: unknown;
    filedAt?: unknown;
    createdAt?: unknown;
    storagePath?: unknown;
  };
  return ((json.documents ?? []) as RawDoc[]).map((d) => ({
    id: String(d.id ?? ""),
    title: (d.title as string | null) ?? null,
    fileName: (d.fileName as string | null) ?? null,
    type: (d.type as string | null) ?? null,
    scope: (d.scope as string | null) ?? null,
    mimeType: (d.mimeType as string | null) ?? null,
    fileSizeBytes:
      typeof d.fileSizeBytes === "number" ? d.fileSizeBytes : null,
    filedAt: (d.filedAt as string | null) ?? null,
    createdAt: (d.createdAt as string | null) ?? null,
    hasFile: Boolean(d.storagePath),
  }));
}

function AttachModal({
  row, organizationId, onClose, onDone,
}: {
  row: Row; organizationId: string;
  onClose: () => void; onDone: (patch: Partial<Row>, msg: string) => void;
}) {
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [existing, setExisting] = useState<AppealDocument[] | null>(null);
  const [chartDocs, setChartDocs] = useState<ChartDocument[] | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [selectedChartIds, setSelectedChartIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    if (row.appealId) {
      void fetchAppealDocuments(row.appealId, organizationId).then((docs) => {
        if (alive) setExisting(docs);
      });
    } else {
      setExisting([]);
    }
    return () => { alive = false; };
  }, [row.appealId, organizationId]);

  useEffect(() => {
    if (!chartOpen || chartDocs !== null || !row.clientId) return;
    let alive = true;
    setChartLoading(true);
    void fetchChartDocuments(row.clientId, organizationId)
      .then((docs) => { if (alive) setChartDocs(docs); })
      .finally(() => { if (alive) setChartLoading(false); });
    return () => { alive = false; };
  }, [chartOpen, chartDocs, row.clientId, organizationId]);

  function toggleChartId(id: string) {
    setSelectedChartIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleAttachFromChart() {
    if (selectedChartIds.size === 0) {
      setErr("Pick at least one chart document to attach.");
      return;
    }
    setBusy(true); setErr(null);
    const appealId = await ensureAppealId();
    if (!appealId) { setBusy(false); return; }
    const ids = Array.from(selectedChartIds);
    const res = await fetch(
      `/api/billing/appeals/${encodeURIComponent(appealId)}/documents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          chartDocumentIds: ids,
          description: description || null,
        }),
      },
    );
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !json?.success) {
      setErr(json?.error || `Attach failed (${res.status})`);
      return;
    }
    const attached = typeof json.attached === "number" ? json.attached : ids.length;
    const count =
      typeof json.attachmentsCount === "number"
        ? json.attachmentsCount
        : row.attachmentsCount + attached;
    setSelectedChartIds(new Set());
    onDone(
      { appealId, attachmentsCount: count },
      `Attached ${attached} chart document${attached === 1 ? "" : "s"}`,
    );
    onClose();
  }

  async function ensureAppealId(): Promise<string | null> {
    if (row.appealId) return row.appealId;
    // No appeal row yet — seed one through the action endpoint (it
    // upserts a draft_ready row scoped to the claim) and reuse its id.
    const r = await callAction({
      action: "attach_documents",
      organizationId,
      claimId: row.claimId,
      delta: 0,
      note: "Seeded appeal record for document upload.",
    });
    if (!r.success) { setErr(r.error ?? "Could not create appeal record"); return null; }
    const seededId = (r.patch && (r.patch as Partial<Row>).appealId) || null;
    if (seededId) onDone({ appealId: seededId, ...(r.patch ?? {}) }, "Appeal record created");
    return seededId;
  }

  async function handleUpload() {
    if (files.length === 0) { setErr("Pick at least one file to upload."); return; }
    setBusy(true); setErr(null);
    const appealId = await ensureAppealId();
    if (!appealId) { setBusy(false); return; }

    let latestCount = row.attachmentsCount;
    let firstErr: string | null = null;
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("organizationId", organizationId);
      if (description) fd.append("description", description);
      const res = await fetch(
        `/api/billing/appeals/${encodeURIComponent(appealId)}/documents`,
        { method: "POST", body: fd },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        firstErr = firstErr ?? (json?.error || `Upload failed (${res.status})`);
        continue;
      }
      if (typeof json.attachmentsCount === "number") {
        latestCount = json.attachmentsCount;
      }
    }
    setBusy(false);
    if (firstErr && latestCount === row.attachmentsCount) {
      setErr(firstErr);
      return;
    }
    onDone(
      { appealId, attachmentsCount: latestCount },
      firstErr ? `Some uploads failed: ${firstErr}` : `Uploaded ${files.length} file(s)`,
    );
    onClose();
  }

  async function handleDelete(doc: AppealDocument) {
    if (!confirm(`Remove "${doc.fileName}" from this appeal?`)) return;
    const res = await fetch(
      `/api/billing/appeals/${encodeURIComponent(doc.appealId)}/documents/${encodeURIComponent(doc.id)}?organizationId=${encodeURIComponent(organizationId)}`,
      { method: "DELETE" },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.success) {
      setErr(json?.error || `Delete failed (${res.status})`);
      return;
    }
    setExisting((prev) => (prev ?? []).filter((d) => d.id !== doc.id));
    onDone({ attachmentsCount: json.attachmentsCount ?? Math.max(0, row.attachmentsCount - 1) }, "Document removed");
  }

  return (
    <ModalShell title={`Attach documents — ${row.claimNumber}`} onClose={onClose} width={640}>
      <p style={{ color: "#64748B", fontSize: 13, margin: "0 0 12px" }}>
        Upload supporting documents (treatment plans, progress notes, prior-auth letters, etc.)
        for this appeal packet. Files are stored against the appeal and downloadable from the
        Attachments tab.
      </p>

      <label style={fieldLabel}>Files</label>
      <input
        type="file"
        multiple
        onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        style={fieldInput}
        disabled={busy}
      />
      {files.length > 0 ? (
        <ul style={{ fontSize: 12, color: "#475569", margin: "6px 0 0 16px" }}>
          {files.map((f) => (
            <li key={f.name + f.size}>{f.name} <span style={{ color: "#94A3B8" }}>({formatBytes(f.size)})</span></li>
          ))}
        </ul>
      ) : null}

      <label style={{ ...fieldLabel, marginTop: 12 }}>Description (optional)</label>
      <textarea
        style={{ ...fieldInput, minHeight: 60 }}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="e.g. Treatment plan + progress notes for 03/01–03/15"
        disabled={busy}
      />

      <div style={{ marginTop: 16, borderTop: "1px solid #E2E8F0", paddingTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Attach from chart</div>
          {!chartOpen ? (
            <button
              type="button"
              style={secondaryBtn}
              disabled={busy || !row.clientId}
              title={!row.clientId ? "No client linked to this claim" : "Browse client documents"}
              onClick={() => setChartOpen(true)}
            >
              Attach from chart
            </button>
          ) : (
            <button
              type="button"
              style={{ ...secondaryBtn, padding: "2px 8px" }}
              onClick={() => { setChartOpen(false); setSelectedChartIds(new Set()); }}
              disabled={busy}
            >
              Hide
            </button>
          )}
        </div>
        {chartOpen ? (
          <div style={{ marginTop: 8 }}>
            {!row.clientId ? (
              <div style={{ color: "#94A3B8", fontSize: 12 }}>
                This claim has no linked client chart.
              </div>
            ) : chartLoading ? (
              <div style={{ color: "#94A3B8", fontSize: 12 }}>Loading chart documents…</div>
            ) : !chartDocs || chartDocs.length === 0 ? (
              <div style={{ color: "#94A3B8", fontSize: 12 }}>
                No documents in this client&apos;s chart.
              </div>
            ) : (
              <>
                <ul style={{
                  listStyle: "none", padding: 0, margin: 0,
                  border: "1px solid #E2E8F0", borderRadius: 4,
                  maxHeight: 220, overflow: "auto",
                }}>
                  {chartDocs.map((d) => {
                    const checked = selectedChartIds.has(d.id);
                    const label = d.title || d.fileName || "Document";
                    return (
                      <li key={d.id} style={{
                        padding: "6px 10px", borderBottom: "1px solid #F1F5F9",
                        display: "flex", alignItems: "center", gap: 8, fontSize: 12,
                        opacity: d.hasFile ? 1 : 0.55,
                      }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy || !d.hasFile}
                          onChange={() => toggleChartId(d.id)}
                          title={!d.hasFile ? "No file is attached to this chart document" : ""}
                        />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontWeight: 500, color: "#0F172A" }}>{label}</div>
                          <div style={{ color: "#64748B" }}>
                            {[d.type, d.scope, formatBytes(d.fileSizeBytes),
                              d.filedAt ? new Date(d.filedAt).toLocaleDateString() : null]
                              .filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                  <button
                    type="button"
                    style={primaryBtn}
                    disabled={busy || selectedChartIds.size === 0}
                    onClick={() => void handleAttachFromChart()}
                  >
                    {busy ? "Attaching…" : `Attach ${selectedChartIds.size || ""} from chart`.trim()}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>

      {existing && existing.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            Already attached ({existing.length})
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, border: "1px solid #E2E8F0", borderRadius: 4 }}>
            {existing.map((d) => (
              <li key={d.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 10px", borderBottom: "1px solid #F1F5F9", fontSize: 12,
              }}>
                <div style={{ minWidth: 0, flex: 1, marginRight: 8 }}>
                  <a
                    href={`/api/billing/appeals/${encodeURIComponent(d.appealId)}/documents/${encodeURIComponent(d.id)}/file?organizationId=${encodeURIComponent(organizationId)}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "#1D4ED8", fontWeight: 500 }}
                  >
                    {d.fileName}
                  </a>
                  <div style={{ color: "#64748B" }}>
                    {formatBytes(d.fileSizeBytes)}
                    {d.uploadedAt ? ` · ${new Date(d.uploadedAt).toLocaleString()}` : ""}
                    {d.description ? ` · ${d.description}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(d)}
                  style={{ ...secondaryBtn, color: "#B91C1C", borderColor: "#FCA5A5", padding: "2px 8px" }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : existing && existing.length === 0 ? (
        <div style={{ marginTop: 12, color: "#94A3B8", fontSize: 12 }}>
          No documents attached to this appeal yet.
        </div>
      ) : null}

      {err ? <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>{err}</div> : null}

      <div style={btnRow}>
        <button type="button" style={secondaryBtn} onClick={onClose} disabled={busy}>Close</button>
        <button
          type="button"
          style={primaryBtn}
          disabled={busy || files.length === 0}
          onClick={() => void handleUpload()}
        >
          {busy ? "Uploading…" : `Upload ${files.length || ""}`.trim()}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

const queueDef = getWorkqueue("appeals_needed");

export default function AppealsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [payers, setPayers] = useState<Array<{ value: string; label: string }>>([]);
  const [tabCounts, setTabCounts] = useState<Record<TabId, number>>(EMPTY_TAB_COUNTS);
  const [metrics, setMetrics] = useState<Metrics>({
    totalCount: 0, totalDollars: 0, oldestAgeDays: 0, urgentCount: 0,
  });
  const [claimHistory, setClaimHistory] = useState<
    Record<string, Array<{ kind: string; at: string | null; body: string }>>
  >({});
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<TabId>("draft_needed");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const [generateRow, setGenerateRow] = useState<Row | null>(null);
  const [assignRow, setAssignRow] = useState<Row | null>(null);
  const [resolveRow, setResolveRow] = useState<Row | null>(null);
  const [attachRow, setAttachRow] = useState<Row | null>(null);
  const [submitRow, setSubmitRow] = useState<Row | null>(null);
  const [docsByAppeal, setDocsByAppeal] = useState<Record<string, AppealDocument[]>>({});

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ organizationId, tab: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) params.set(k, v);
      }
      const res = await fetch(`/api/billing/appeals?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows((json.rows ?? []) as Row[]);
      setAssignees((json.assignees ?? []) as Assignee[]);
      setTemplates((json.templates ?? []) as Template[]);
      setPayers((json.filterOptions?.payers ?? []) as Array<{ value: string; label: string }>);
      setTabCounts({ ...EMPTY_TAB_COUNTS, ...(json.tabCounts ?? {}) });
      setMetrics(json.metrics ?? metrics);
      setClaimHistory(json.claimHistory ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, activeTab, filterValues]);

  useEffect(() => { void load(); }, [load]);

  const refreshAppealDocs = useCallback(async (appealId: string) => {
    const docs = await fetchAppealDocuments(appealId, organizationId);
    setDocsByAppeal((prev) => ({ ...prev, [appealId]: docs }));
  }, [organizationId]);

  useEffect(() => {
    const sel = rows.find((r) => r.id === selectedRowId);
    if (!sel || !sel.appealId) return;
    if (docsByAppeal[sel.appealId]) return;
    void refreshAppealDocs(sel.appealId);
  }, [selectedRowId, rows, docsByAppeal, refreshAppealDocs]);

  function patchRowById(rowId: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  }
  function patchByClaim(claimId: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.claimId === claimId ? { ...r, ...patch } : r)));
  }

  function runSubmit(row: Row) {
    setSubmitRow(row);
  }
  async function runTrack(row: Row) {
    const r = await callAction({ action: "track", organizationId, claimId: row.claimId });
    if (!r.success) { setToast(r.error ?? "Track failed"); return; }
    patchByClaim(row.claimId, r.patch ?? {});
    setToast("Appeal moved to pending");
  }
  async function runEscalate(row: Row) {
    const r = await callAction({
      action: "escalate_doi",
      organizationId,
      claimId: row.claimId,
      note: "Escalated to DOI / ombudsman.",
    });
    if (!r.success) { setToast(r.error ?? "Escalate failed"); return; }
    patchByClaim(row.claimId, r.patch ?? {});
    setToast("Escalated to DOI/ombudsman");
  }

  // ── Universal filter rail ─────────────────────────────────────────────────
  const filters: FilterDef[] = useMemo(() => [
    { id: "practice", label: "Practice", kind: "text", placeholder: "Search…" },
    { id: "clinician", label: "Clinician", kind: "text", placeholder: "Search…" },
    { id: "payer", label: "Payer", kind: "select", options: payers },
    { id: "client", label: "Client", kind: "text", placeholder: "Client name…" },
    { id: "dosFrom", label: "DOS from", kind: "date" },
    { id: "dosTo", label: "DOS to", kind: "date" },
    {
      id: "status", label: "Status", kind: "select",
      options: [
        { value: "open", label: "Open" },
        { value: "in_progress", label: "In progress" },
        { value: "blocked", label: "Blocked" },
        { value: "resolved", label: "Resolved" },
        { value: "closed", label: "Closed" },
      ],
    },
    {
      id: "assignedBiller", label: "Assigned biller", kind: "select",
      options: [
        { value: "__unassigned__", label: "Unassigned" },
        ...assignees.map((a) => ({ value: a.id, label: a.displayName })),
      ],
    },
    { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
    { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
    {
      id: "agingBucket", label: "Aging bucket", kind: "select",
      options: [
        { value: "0-7", label: "0–7 days" },
        { value: "8-30", label: "8–30 days" },
        { value: "31-60", label: "31–60 days" },
        { value: "60+", label: "60+ days" },
      ],
    },
    { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. CO-50" },
    {
      id: "priority", label: "Priority", kind: "select",
      options: [
        { value: "urgent", label: "Urgent" },
        { value: "high", label: "High" },
        { value: "normal", label: "Normal" },
        { value: "low", label: "Low" },
      ],
    },
    {
      id: "followUpDue", label: "Follow-up due date", kind: "select",
      options: [
        { value: "overdue", label: "Overdue" },
        { value: "today", label: "Today" },
        { value: "week", label: "Next 7 days" },
      ],
    },
  ], [payers, assignees]);

  // ── Header summary ────────────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => [
    { id: "count", label: "Appeals in view", value: metrics.totalCount.toLocaleString() },
    {
      id: "dollars", label: "Total $ at risk", value: formatCurrency(metrics.totalDollars),
      tone: metrics.totalDollars > 0 ? "amber" : "default",
    },
    {
      id: "oldest", label: "Oldest claim (days)", value: metrics.oldestAgeDays,
      tone: metrics.oldestAgeDays > 60 ? "red" : metrics.oldestAgeDays > 30 ? "amber" : "default",
    },
    {
      id: "urgent", label: "Urgent", value: metrics.urgentCount,
      tone: metrics.urgentCount > 0 ? "red" : "default",
    },
  ], [metrics]);

  // ── Columns (spec-exact) ──────────────────────────────────────────────────
  const columns: ColumnDef<Row>[] = useMemo(() => [
    { id: "client", header: "Client", cell: (r) => r.clientName },
    {
      id: "claim", header: "Claim ID",
      cell: (r) => <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.claimNumber}</span>,
    },
    { id: "payer", header: "Payer", cell: (r) => r.payerName },
    { id: "dos", header: "DOS", cell: (r) => formatDate(r.serviceDateFrom) },
    {
      id: "amt", header: "Denied amount", align: "right",
      cell: (r) => <span style={{ fontFamily: "ui-monospace, monospace" }}>{formatCurrency(r.deniedAmount)}</span>,
    },
    {
      id: "reason", header: "Denial reason",
      cell: (r) => (
        <span title={r.denialReason} style={{ color: "#0F172A" }}>
          {r.denialReason.length > 60 ? `${r.denialReason.slice(0, 60)}…` : r.denialReason || "—"}
        </span>
      ),
    },
    {
      id: "deadline", header: "Appeal deadline",
      cell: (r) => {
        if (!r.appealDeadline) return <span style={{ color: "#94A3B8" }}>—</span>;
        const d = daysUntil(r.appealDeadline);
        const tone = d === null ? "#0F172A" : d < 0 ? "#B91C1C" : d <= 7 ? "#B45309" : "#0F172A";
        return (
          <span style={{ color: tone, fontWeight: 600 }}>
            {formatDate(r.appealDeadline)}
            {d !== null ? (
              <span style={{ marginLeft: 6, fontWeight: 400, fontSize: 12 }}>
                ({d < 0 ? `${-d}d overdue` : `${d}d`})
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "level", header: "Appeal level", align: "center",
      cell: (r) => <span>{`L${r.appealLevel}`}</span>,
    },
    {
      id: "assigned", header: "Assigned to",
      cell: (r) => (
        <span style={{ color: r.assignedToDisplayName ? "#0F172A" : "#9CA3AF" }}>
          {r.assignedToDisplayName ?? "Unassigned"}
        </span>
      ),
    },
    {
      id: "status", header: "Status",
      cell: (r) => {
        const tone =
          r.appealStatus === "won" ? "#047857"
          : r.appealStatus === "lost" ? "#B91C1C"
          : r.appealStatus === "draft_needed" ? "#B45309"
          : r.appealStatus === "escalated_doi" ? "#7C3AED"
          : "#1D4ED8";
        return (
          <span style={{
            color: "#fff", background: tone, padding: "2px 8px",
            borderRadius: 999, fontSize: 12, fontWeight: 600,
          }}>
            {r.appealStatusLabel}
          </span>
        );
      },
    },
  ], []);

  // ── Row action buttons (spec-exact labels) ────────────────────────────────
  const rowActions: RowAction<Row>[] = useMemo(() => [
    {
      id: "generate", label: "Generate appeal", variant: "primary",
      onClick: (r) => setGenerateRow(r),
      disabled: (r) => r.appealStatus === "won" || r.appealStatus === "lost",
    },
    {
      id: "attach", label: "Attach documents",
      onClick: (r) => setAttachRow(r),
    },
    {
      id: "submit", label: "Submit appeal", variant: "success",
      onClick: (r) => void runSubmit(r),
      disabled: (r) => !r.letterBody || ["sent", "pending", "won", "lost"].includes(r.appealStatus),
    },
    {
      id: "track", label: "Track appeal",
      onClick: (r) => void runTrack(r),
      disabled: (r) => r.appealStatus !== "sent",
    },
    {
      id: "escalate", label: "Escalate to DOI/ombudsman", variant: "danger",
      onClick: (r) => void runEscalate(r),
      disabled: (r) => ["won", "lost", "escalated_doi"].includes(r.appealStatus),
    },
    {
      id: "resolve", label: "Mark resolved",
      onClick: (r) => setResolveRow(r),
      disabled: (r) => ["won", "lost"].includes(r.appealStatus),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  // ── Detail-panel sections (spec-exact labels) ────────────────────────────
  const detailTabs: DetailTab[] = useMemo(() => [
    {
      id: "denial",
      label: "Denial details",
      render: () => {
        if (!selectedRow) return null;
        return (
          <div>
            <DetailKV label="Client" value={selectedRow.clientName} />
            <DetailKV label="Member ID" value={selectedRow.memberId || "—"} />
            <DetailKV label="Claim #" value={selectedRow.claimNumber} />
            <DetailKV label="Payer" value={selectedRow.payerName} />
            <DetailKV label="DOS" value={formatDate(selectedRow.serviceDateFrom)} />
            <DetailKV label="Denied amount" value={formatCurrency(selectedRow.deniedAmount)} />
            <DetailKV label="Denial reason" value={selectedRow.denialReason || "—"} />
            <DetailKV label="Appeal level" value={`L${selectedRow.appealLevel}`} />
            <DetailKV label="Appeal status" value={selectedRow.appealStatusLabel} />
            <DetailKV label="Appeal deadline" value={formatDate(selectedRow.appealDeadline)} />
            <DetailKV label="Submitted" value={formatDate(selectedRow.appealSubmittedAt)} />
            <DetailKV
              label="Submitted via"
              value={
                selectedRow.submissionChannel === "fax" ? "Fax"
                : selectedRow.submissionChannel === "portal" ? "Payer portal"
                : selectedRow.submissionChannel === "mail" ? "Mail"
                : "—"
              }
            />
            <DetailKV label="Decision" value={selectedRow.appealDecision || "—"} />
          </div>
        );
      },
    },
    {
      id: "era",
      label: "ERA/EOB",
      render: () => {
        if (!selectedRow) return null;
        return (
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <DetailKV label="Latest status" value={selectedRow.claimStatus} />
            <DetailKV label="Denied amount" value={formatCurrency(selectedRow.deniedAmount)} />
            <DetailKV label="Denial reason (latest ERA)" value={selectedRow.denialReason || "—"} />
            <p style={{ color: "#64748B", marginTop: 12 }}>
              Full ERA/EOB detail lives on the claim&apos;s ERA tab.
              {selectedRow.claimId ? (
                <>
                  {" "}
                  <a href={`/billing/claim-edit-dashboard?claimId=${encodeURIComponent(selectedRow.claimId)}`}>
                    Open claim →
                  </a>
                </>
              ) : null}
            </p>
          </div>
        );
      },
    },
    {
      id: "history",
      label: "Claim history",
      render: () => {
        if (!selectedRow) return null;
        const entries = claimHistory[selectedRow.claimId] ?? [];
        if (entries.length === 0) {
          return <div style={{ color: "#94A3B8", fontSize: 13 }}>No history captured yet.</div>;
        }
        return (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {entries.map((e, i) => (
              <li key={i} style={{
                borderLeft: "3px solid #CBD5E1", paddingLeft: 10, marginBottom: 10,
              }}>
                <div style={{ fontSize: 12, color: "#64748B" }}>
                  {e.at ? new Date(e.at).toLocaleString() : ""} · {e.kind}
                </div>
                <div style={{ fontSize: 13, color: "#0F172A" }}>{e.body}</div>
              </li>
            ))}
          </ul>
        );
      },
    },
    {
      id: "clinical",
      label: "Clinical documentation",
      render: () => {
        if (!selectedRow) return null;
        return (
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <DetailKV label="Attached to appeal" value={`${selectedRow.attachmentsCount} document(s)`} />
            <p style={{ color: "#64748B", marginTop: 12 }}>
              Pull the underlying clinical record from the client&apos;s chart and attach
              progress notes, the treatment plan, and any prior-auth letters before
              submitting the appeal.
            </p>
            {selectedRow.clientId ? (
              <p>
                <a href={`/clients/${encodeURIComponent(selectedRow.clientId)}`}>Open client chart →</a>
              </p>
            ) : null}
            <button
              type="button"
              style={primaryBtn}
              onClick={() => setAttachRow(selectedRow)}
            >
              Upload documents
            </button>
          </div>
        );
      },
    },
    {
      id: "rule",
      label: "Contract/payer rule",
      render: () => {
        if (!selectedRow) return null;
        return (
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <DetailKV label="Payer" value={selectedRow.payerName} />
            <DetailKV label="Fax on file" value={selectedRow.payerFaxNumber || "—"} />
            <p style={{ color: "#64748B", marginTop: 12 }}>
              Check the payer&apos;s appeal policy for the timely-filing window
              (often 90–180 days from denial) and the preferred submission channel
              (mail, fax, or portal). Set the deadline below to track it on the queue.
            </p>
          </div>
        );
      },
    },
    {
      id: "editor",
      label: "Appeal letter editor",
      render: () => {
        if (!selectedRow) return null;
        return (
          <div>
            <p style={{ color: "#64748B", fontSize: 13, margin: "0 0 8px" }}>
              {selectedRow.letterBody
                ? "Current draft preview — open the editor to make changes."
                : "No draft yet. Click Generate appeal to start one from a template."}
            </p>
            <pre style={{
              background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 4,
              padding: 10, fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto",
              fontFamily: "ui-monospace, Menlo, monospace",
            }}>
              {selectedRow.letterBody || "(empty)"}
            </pre>
            <div style={{ marginTop: 12 }}>
              <button type="button" style={primaryBtn} onClick={() => setGenerateRow(selectedRow)}>
                {selectedRow.letterBody ? "Edit draft" : "Generate appeal"}
              </button>
            </div>
          </div>
        );
      },
    },
    {
      id: "attachments",
      label: "Attachments",
      render: () => {
        if (!selectedRow) return null;
        const docs = selectedRow.appealId ? (docsByAppeal[selectedRow.appealId] ?? null) : [];
        return (
          <div style={{ fontSize: 13 }}>
            <DetailKV label="Documents attached" value={`${selectedRow.attachmentsCount} file(s)`} />
            <div style={{ marginTop: 12 }}>
              {docs === null ? (
                <div style={{ color: "#94A3B8" }}>Loading documents…</div>
              ) : docs.length === 0 ? (
                <div style={{ color: "#94A3B8" }}>
                  No documents uploaded yet. Click below to add treatment plans, progress notes,
                  prior-auth letters, etc.
                </div>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, border: "1px solid #E2E8F0", borderRadius: 4 }}>
                  {docs.map((d) => (
                    <li key={d.id} style={{
                      padding: "8px 10px", borderBottom: "1px solid #F1F5F9",
                      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                    }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <a
                          href={`/api/billing/appeals/${encodeURIComponent(d.appealId)}/documents/${encodeURIComponent(d.id)}/file?organizationId=${encodeURIComponent(organizationId)}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "#1D4ED8", fontWeight: 500 }}
                        >
                          {d.fileName}
                        </a>
                        <div style={{ fontSize: 12, color: "#64748B" }}>
                          {formatBytes(d.fileSizeBytes)}
                          {d.uploadedAt ? ` · ${new Date(d.uploadedAt).toLocaleString()}` : ""}
                          {d.uploadedByDisplayName ? ` · ${d.uploadedByDisplayName}` : ""}
                          {d.description ? ` · ${d.description}` : ""}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              <button type="button" style={primaryBtn} onClick={() => setAttachRow(selectedRow)}>
                Upload documents
              </button>
            </div>
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
  ], [selectedRow, claimHistory, docsByAppeal, organizationId]);

  const detailActions: PrimaryAction[] = selectedRow ? [
    {
      id: "generate", label: "Generate appeal", variant: "primary",
      onClick: () => setGenerateRow(selectedRow),
      disabled: selectedRow.appealStatus === "won" || selectedRow.appealStatus === "lost",
    },
    { id: "attach", label: "Attach documents", onClick: () => setAttachRow(selectedRow) },
    {
      id: "submit", label: "Submit appeal", variant: "success",
      onClick: () => void runSubmit(selectedRow),
      disabled: !selectedRow.letterBody || ["sent", "pending", "won", "lost"].includes(selectedRow.appealStatus),
    },
    {
      id: "track", label: "Track appeal",
      onClick: () => void runTrack(selectedRow),
      disabled: selectedRow.appealStatus !== "sent",
    },
    {
      id: "escalate", label: "Escalate to DOI/ombudsman", variant: "danger",
      onClick: () => void runEscalate(selectedRow),
      disabled: ["won", "lost", "escalated_doi"].includes(selectedRow.appealStatus),
    },
    {
      id: "resolve", label: "Mark resolved",
      onClick: () => setResolveRow(selectedRow),
      disabled: ["won", "lost"].includes(selectedRow.appealStatus),
    },
    { id: "assign", label: "Assign", onClick: () => setAssignRow(selectedRow) },
  ] : [];

  const primaryTabs = TABS.map((t) => ({ id: t.id, label: t.label, count: tabCounts[t.id] ?? 0 }));

  const message = !organizationId
    ? { tone: "error" as const, text: "Missing organizationId. Add ?organizationId=… to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID." }
    : error ? { tone: "error" as const, text: error } : null;

  return (
    <>
      <WorkqueueShell<Row>
        title={queueDef?.title ?? "Appeals Needed"}
        description={queueDef?.description}
        headerActions={[
          {
            id: "refresh", label: loading ? "Loading…" : "Refresh",
            onClick: () => void load(), disabled: loading,
          },
        ]}
        summary={summary}
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTab}
        onPrimaryTabChange={(id) => {
          setActiveTab(id as TabId);
          setSelectedRowId(null);
        }}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`appeals_${activeTab}`}
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage={`No appeals in the "${TABS.find((t) => t.id === activeTab)?.label}" bucket.`}
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {generateRow ? (
        <GenerateAppealModal
          row={generateRow}
          organizationId={organizationId}
          templates={templates}
          onClose={() => setGenerateRow(null)}
          onDone={(patch, msg) => { patchByClaim(generateRow.claimId, patch); setToast(msg); }}
        />
      ) : null}
      {assignRow ? (
        <AssignModal
          row={assignRow}
          organizationId={organizationId}
          assignees={assignees}
          onClose={() => setAssignRow(null)}
          onDone={(patch, msg) => { patchByClaim(assignRow.claimId, patch); setToast(msg); }}
        />
      ) : null}
      {resolveRow ? (
        <ResolveModal
          row={resolveRow}
          organizationId={organizationId}
          onClose={() => setResolveRow(null)}
          onDone={(patch, msg) => { patchByClaim(resolveRow.claimId, patch); setToast(msg); }}
        />
      ) : null}
      {attachRow ? (
        <AttachModal
          row={attachRow}
          organizationId={organizationId}
          onClose={() => setAttachRow(null)}
          onDone={(patch, msg) => {
            patchByClaim(attachRow.claimId, patch);
            setToast(msg);
            const targetAppealId = (patch.appealId ?? attachRow.appealId) || null;
            if (targetAppealId) void refreshAppealDocs(targetAppealId);
          }}
        />
      ) : null}
      {submitRow ? (
        <SubmitAppealModal
          row={submitRow}
          organizationId={organizationId}
          onClose={() => setSubmitRow(null)}
          onDone={(patch, msg) => { patchByClaim(submitRow.claimId, patch); setToast(msg); }}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
