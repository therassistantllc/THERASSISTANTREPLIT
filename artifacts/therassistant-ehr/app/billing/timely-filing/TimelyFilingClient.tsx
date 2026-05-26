"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type DetailTab,
  type FilterDef,
  type PrimaryTab,
  type RowAction,
  type SummaryMetric,
} from "@/components/billing/WorkqueueShell";
import { ClaimDocumentsPanel } from "@/components/billing/ClaimDocumentsPanel";
import { ResolvedDenialNoteCard } from "@/components/billing/ResolvedDenialNoteCard";
import {
  TIMELY_FILING_TABS,
  type TimelyFilingTab,
} from "@/lib/billing/timelyFiling";

// ─── Types ────────────────────────────────────────────────────────────────────

type Row = {
  id: string;
  claim_number: string | null;
  claim_status: string | null;
  patient_id: string | null;
  patient_name: string;
  payer_profile_id: string | null;
  payer_name: string | null;
  payer_id_external: string | null;
  payer_notes: string | null;
  payer_timely_filing_days: number | null;
  service_date_from: string | null;
  service_date_to: string | null;
  filing_deadline: string | null;
  days_remaining: number | null;
  expired: boolean;
  appeal_deadline_date: string | null;
  appeal_days_remaining: number | null;
  corrected_deadline: string | null;
  corrected_days_remaining: number | null;
  total_charge: number;
  reason_not_filed: string;
  denial_reason_code: string | null;
  denial_reason_description: string | null;
  first_billed_date: string | null;
  submitted_at: string | null;
  assigned_to_user_id: string | null;
  assigned_to_display_name: string | null;
  priority: string;
  clinician_id: string | null;
  practice_location_id: string | null;
  note_count: number;
  latest_note_excerpt: string | null;
  latest_note_at: string | null;
  tab: TimelyFilingTab;
  carc_code: string | null;
  rarc_code: string | null;
  days_outstanding: number | null;
  follow_up_due_date: string | null;
};

type Practice = { id: string; name: string };
type Clinician = { id: string; displayName: string };
type Assignee = { id: string; displayName: string };

type Note = {
  id: string;
  body: string;
  author_display_name: string | null;
  created_at: string;
  resolved_denial?: boolean | null;
};

type SubmissionEvent = {
  id: string;
  at: string;
  label: string;
  detail?: string;
};

// ─── Utils ────────────────────────────────────────────────────────────────────

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

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0);
}

function dosLabel(r: Row) {
  if (!r.service_date_from && !r.service_date_to) return "—";
  if (
    r.service_date_from &&
    r.service_date_to &&
    r.service_date_from !== r.service_date_to
  ) {
    return `${formatDate(r.service_date_from)} – ${formatDate(r.service_date_to)}`;
  }
  return formatDate(r.service_date_from ?? r.service_date_to);
}

function priorityLabel(p: string): string {
  return p ? p[0].toUpperCase() + p.slice(1) : "—";
}

function priorityTone(p: string): string {
  switch (p) {
    case "urgent": return "#B91C1C";
    case "high": return "#B45309";
    case "low": return "#64748B";
    default: return "#0F172A";
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        background: "#111827",
        color: "#fff",
        padding: "10px 16px",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        zIndex: 1100,
      }}
    >
      {message}
    </div>
  );
}

// ─── Modal shell ──────────────────────────────────────────────────────────────

const fieldLabel: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
};
const fieldInput: React.CSSProperties = {
  width: "100%",
  padding: 8,
  border: "1px solid #D1D5DB",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 13,
};
const buttonRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  marginTop: 16,
};

function ModalShell({
  title,
  onClose,
  children,
  width = 480,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          width,
          maxWidth: "92vw",
          maxHeight: "88vh",
          overflow: "auto",
          borderRadius: 8,
          padding: 24,
          boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              fontSize: 20,
              cursor: "pointer",
              color: "#6B7280",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function AttachProofModal({
  row,
  organizationId,
  onClose,
  onSaved,
}: {
  row: Row;
  organizationId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState("clearinghouse_trace");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!reference.trim() && !description.trim() && files.length === 0) {
      setError("Provide a reference, description, or file");
      return;
    }
    setSaving(true);
    setError(null);
    const form = new FormData();
    form.set("organizationId", organizationId);
    form.set("kind", kind);
    form.set("reference", reference.trim());
    form.set("description", description.trim());
    for (const f of files) form.append("files", f, f.name);
    const res = await fetch(`/api/billing/claims/${row.id}/attach-proof`, {
      method: "POST",
      body: form,
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Failed to attach proof");
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <ModalShell title={`Attach proof of timely filing`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claim_number ?? row.id} · {row.payer_name ?? "—"}
      </p>
      <label style={fieldLabel}>Proof type</label>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        style={fieldInput}
      >
        <option value="clearinghouse_trace">Clearinghouse trace number</option>
        <option value="fax_confirmation">Fax confirmation</option>
        <option value="certified_mail">Certified mail receipt</option>
        <option value="payer_portal">Payer portal submission ID</option>
        <option value="email_receipt">Email receipt</option>
        <option value="other">Other</option>
      </select>
      <div style={{ marginTop: 12 }}>
        <label style={fieldLabel}>Reference / ID</label>
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          style={fieldInput}
          placeholder="e.g. 837-2026-04-18-001"
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <label style={fieldLabel}>Notes</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          style={fieldInput}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <label style={fieldLabel}>
          Supporting documents (PDF, image — up to 25 MB each)
        </label>
        <input
          type="file"
          multiple
          accept="application/pdf,image/*"
          onChange={(e) =>
            setFiles(e.target.files ? Array.from(e.target.files) : [])
          }
          style={{ ...fieldInput, padding: 6 }}
        />
        {files.length > 0 ? (
          <ul
            style={{
              margin: "6px 0 0",
              padding: 0,
              listStyle: "none",
              fontSize: 12,
              color: "#475569",
            }}
          >
            {files.map((f, i) => (
              <li key={i}>
                {f.name} ({Math.max(1, Math.round(f.size / 1024))} KB)
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {error ? (
        <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div>
      ) : null}
      <div style={buttonRow}>
        <button
          type="button"
          className="button button-secondary"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Attach proof"}
        </button>
      </div>
    </ModalShell>
  );
}

function UncollectibleModal({
  row,
  organizationId,
  onClose,
  onSaved,
}: {
  row: Row;
  organizationId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("timely_filing_expired");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(
      `/api/billing/claims/${row.id}/uncollectible`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, reason, comment: comment.trim() }),
      },
    );
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Failed to mark uncollectible");
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <ModalShell title="Mark uncollectible" onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claim_number ?? row.id} · {formatCurrency(row.total_charge)}
      </p>
      <label style={fieldLabel}>Reason</label>
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={fieldInput}
      >
        <option value="timely_filing_expired">Timely filing expired</option>
        <option value="no_authorization">No authorization on file</option>
        <option value="bad_debt">Bad debt</option>
        <option value="patient_deceased">Patient deceased</option>
        <option value="other">Other</option>
      </select>
      <div style={{ marginTop: 12 }}>
        <label style={fieldLabel}>Comment (optional)</label>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          style={fieldInput}
        />
      </div>
      {error ? (
        <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div>
      ) : null}
      <div style={buttonRow}>
        <button
          type="button"
          className="button button-secondary"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Mark uncollectible"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Detail panel helpers ─────────────────────────────────────────────────────

function DetailKV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        fontSize: 13,
        padding: "5px 0",
        borderBottom: "1px solid #F1F5F9",
      }}
    >
      <span style={{ color: "#64748B", fontWeight: 500 }}>{label}</span>
      <span
        style={{
          color: "#0F172A",
          textAlign: "right",
          maxWidth: "60%",
          wordBreak: "break-word",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function NotesPanel({
  claimId,
  organizationId,
  bumpKey,
  filter,
}: {
  claimId: string;
  organizationId: string;
  bumpKey: number;
  filter?: (n: Note) => boolean;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    setError(null);
    fetch(
      `/api/billing/claims/${claimId}/notes?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) setError(j.error || "Failed");
        else setNotes((j?.notes ?? []) as Note[]);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      });
    return () => {
      cancelled = true;
    };
  }, [claimId, organizationId, bumpKey]);

  if (error) return <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>;
  if (notes == null)
    return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>;
  const visible = filter ? notes.filter(filter) : notes;
  if (visible.length === 0)
    return <div style={{ color: "#94A3B8", fontSize: 13 }}>Nothing recorded yet.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {visible.map((n) => (
        <ResolvedDenialNoteCard
          key={n.id}
          note={n}
          claimId={claimId}
          organizationId={organizationId}
          onChange={(updated) =>
            setNotes((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)))
          }
        />
      ))}
    </div>
  );
}

type ProofFile = { name: string; mime: string; size: number; path: string };

function parseProofNote(body: string): {
  header: string;
  files: ProofFile[];
} {
  const match = body.match(/^Files:\s*(\[.*\])\s*$/m);
  if (!match) return { header: body, files: [] };
  let files: ProofFile[] = [];
  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed)) {
      files = parsed.filter(
        (f): f is ProofFile =>
          !!f &&
          typeof f.name === "string" &&
          typeof f.path === "string" &&
          typeof f.mime === "string" &&
          typeof f.size === "number",
      );
    }
  } catch {
    files = [];
  }
  const header = body.replace(match[0], "").trimEnd();
  return { header, files };
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ProofPanel({
  claimId,
  organizationId,
  bumpKey,
}: {
  claimId: string;
  organizationId: string;
  bumpKey: number;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    setError(null);
    fetch(
      `/api/billing/claims/${claimId}/notes?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) setError(j.error || "Failed");
        else setNotes((j?.notes ?? []) as Note[]);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      });
    return () => {
      cancelled = true;
    };
  }, [claimId, organizationId, bumpKey]);

  if (error) return <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>;
  if (notes == null)
    return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>;
  const proofNotes = notes.filter((n) =>
    n.body.startsWith("[Proof of timely filing]"),
  );
  if (proofNotes.length === 0)
    return (
      <div style={{ color: "#94A3B8", fontSize: 13 }}>Nothing recorded yet.</div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {proofNotes.map((n) => {
        const { header, files } = parseProofNote(n.body);
        return (
          <div
            key={n.id}
            style={{
              border: "1px solid #E5E7EB",
              borderRadius: 6,
              padding: 10,
              background: "#F9FAFB",
            }}
          >
            <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
              {n.author_display_name ?? "Staff"} ·{" "}
              {formatDateTime(n.created_at)}
            </div>
            <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{header}</div>
            {files.length > 0 ? (
              <ul
                style={{
                  margin: "8px 0 0",
                  padding: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {files.map((f, i) => {
                  const url = `/api/billing/claims/${claimId}/proof-files?organizationId=${encodeURIComponent(organizationId)}&path=${encodeURIComponent(f.path)}`;
                  return (
                    <li key={i} style={{ fontSize: 13 }}>
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        download={f.name}
                        style={{ color: "#1D4ED8", textDecoration: "underline" }}
                      >
                        {f.name}
                      </a>{" "}
                      <span style={{ color: "#64748B", fontSize: 12 }}>
                        ({f.mime || "file"} · {formatBytes(f.size)})
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SubmissionHistorySection({ row }: { row: Row }) {
  const events: SubmissionEvent[] = useMemo(() => {
    const e: SubmissionEvent[] = [];
    if (row.first_billed_date) {
      e.push({
        id: "first_billed",
        at: row.first_billed_date,
        label: "First billed",
      });
    }
    if (row.submitted_at) {
      e.push({
        id: "submitted",
        at: row.submitted_at,
        label: "Last transmission to clearinghouse",
      });
    }
    if (row.appeal_deadline_date) {
      e.push({
        id: "appeal_deadline",
        at: row.appeal_deadline_date,
        label: "Appeal deadline",
      });
    }
    e.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return e;
  }, [row]);

  if (events.length === 0)
    return (
      <div style={{ color: "#94A3B8", fontSize: 13 }}>
        This claim has never been transmitted.
      </div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {events.map((ev) => (
        <div
          key={ev.id}
          style={{
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            padding: 10,
            background: "#F9FAFB",
          }}
        >
          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
            {formatDate(ev.at)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{ev.label}</div>
          {ev.detail ? (
            <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
              {ev.detail}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TimelyFilingClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [practices, setPractices] = useState<Practice[]>([]);
  const [clinicians, setClinicians] = useState<Clinician[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<TimelyFilingTab, number>>({
    remaining_0_15: 0,
    remaining_16_30: 0,
    expired: 0,
    appeal_risk: 0,
    corrected_risk: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<TimelyFilingTab>("remaining_0_15");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const [proofRow, setProofRow] = useState<Row | null>(null);
  const [uncollectibleRow, setUncollectibleRow] = useState<Row | null>(null);
  const [bumpKey, setBumpKey] = useState(0);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, tab: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) params.set(k, v);
      }
      const res = await fetch(
        `/api/billing/timely-filing?${params.toString()}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success)
        throw new Error(json.error ?? "Failed to load");
      setRows((json.items ?? []) as Row[]);
      setTabCounts(json.tabCounts ?? tabCounts);
      setPractices((json.practices ?? []) as Practice[]);
      setClinicians((json.clinicians ?? []) as Clinician[]);
      setAssignees((json.assignees ?? []) as Assignee[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, activeTab, JSON.stringify(filterValues)]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchRow(claimId: string, patch: Partial<Row>) {
    setRows((prev) =>
      prev.map((r) => (r.id === claimId ? { ...r, ...patch } : r)),
    );
  }

  function removeRow(claimId: string) {
    setRows((prev) => prev.filter((r) => r.id !== claimId));
    if (selectedRowId === claimId) setSelectedRowId(null);
  }

  // ── Filter rail ────────────────────────────────────────────────────────────
  const payerOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const r of rows)
      if (r.payer_profile_id && r.payer_name)
        set.set(r.payer_profile_id, r.payer_name);
    return Array.from(set.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);

  const filters: FilterDef[] = useMemo(
    () => [
      {
        id: "practice",
        label: "Practice",
        kind: "select",
        options: practices.map((p) => ({ value: p.id, label: p.name })),
      },
      {
        id: "clinician",
        label: "Clinician",
        kind: "select",
        options: clinicians.map((c) => ({
          value: c.id,
          label: c.displayName,
        })),
      },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Patient name…" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "draft", label: "Draft" },
          { value: "validation_errors", label: "Validation errors" },
          { value: "ready_for_batch", label: "Ready for batch" },
          { value: "on_hold", label: "On hold" },
          { value: "documentation_pending", label: "Awaiting documentation" },
          { value: "needs_authorization", label: "Needs authorization" },
          { value: "rejected_oa", label: "Rejected (clearinghouse)" },
          { value: "rejected_payer", label: "Rejected (payer)" },
          { value: "denied", label: "Denied" },
        ],
      },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "select",
        options: [
          { value: "__unassigned__", label: "Unassigned" },
          ...assignees.map((a) => ({ value: a.id, label: a.displayName })),
        ],
      },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Aging bucket",
        kind: "select",
        options: [
          { value: "0-30", label: "0–30 days" },
          { value: "31-60", label: "31–60 days" },
          { value: "61-90", label: "61–90 days" },
          { value: "91-120", label: "91–120 days" },
          { value: "120+", label: "120+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 29" },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [
          { value: "urgent", label: "Urgent" },
          { value: "high", label: "High" },
          { value: "normal", label: "Normal" },
          { value: "low", label: "Low" },
        ],
      },
      {
        id: "followUpDue",
        label: "Follow-up due",
        kind: "select",
        options: [
          { value: "overdue", label: "Overdue" },
          { value: "today", label: "Today" },
          { value: "week", label: "Next 7 days" },
        ],
      },
    ],
    [practices, clinicians, payerOptions, assignees],
  );

  // ── Summary metrics ───────────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const total = rows.length;
    const dollars = rows.reduce((s, r) => s + (r.total_charge || 0), 0);
    const oldest = rows.reduce(
      (m, r) => Math.max(m, r.days_outstanding ?? 0),
      0,
    );
    const urgent = rows.filter(
      (r) => r.priority === "urgent" || r.expired || (r.days_remaining ?? 99) <= 7,
    ).length;
    return [
      { id: "count", label: "Claims at risk", value: total.toLocaleString() },
      {
        id: "dollars",
        label: "Total $ at risk",
        value: formatCurrency(dollars),
        tone: dollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: oldest,
        tone: oldest > 90 ? "red" : oldest > 30 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: urgent,
        tone: urgent > 0 ? "red" : "default",
      },
    ];
  }, [rows]);

  // ── Columns (spec-exact labels) ───────────────────────────────────────────
  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.patient_name },
      {
        id: "claim",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            {r.claim_number ?? r.id.slice(0, 8)}
          </span>
        ),
      },
      { id: "payer", header: "Payer", cell: (r) => r.payer_name ?? "—" },
      { id: "dos", header: "DOS", cell: (r) => dosLabel(r) },
      {
        id: "filing_deadline",
        header: "Filing deadline",
        cell: (r) =>
          r.tab === "appeal_risk"
            ? formatDate(r.appeal_deadline_date)
            : r.tab === "corrected_risk"
              ? formatDate(r.corrected_deadline)
              : formatDate(r.filing_deadline),
      },
      {
        id: "days_remaining",
        header: "Days remaining",
        align: "right",
        cell: (r) => {
          const d =
            r.tab === "appeal_risk"
              ? r.appeal_days_remaining
              : r.tab === "corrected_risk"
                ? r.corrected_days_remaining
                : r.days_remaining;
          if (d == null) return "—";
          const expired = d < 0;
          return (
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                color: expired
                  ? "#B91C1C"
                  : d <= 7
                    ? "#B91C1C"
                    : d <= 15
                      ? "#B45309"
                      : "#0F172A",
                fontWeight: d <= 15 || expired ? 600 : 400,
              }}
            >
              {expired ? `${d}d (expired)` : `${d}d`}
            </span>
          );
        },
      },
      {
        id: "charge",
        header: "Charge amount",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatCurrency(r.total_charge)}
          </span>
        ),
      },
      {
        id: "claim_status",
        header: "Claim status",
        cell: (r) => r.claim_status ?? "—",
      },
      {
        id: "reason",
        header: "Reason not filed",
        cell: (r) => (
          <span
            style={{
              display: "inline-block",
              padding: "2px 8px",
              borderRadius: 999,
              background: "#FEF3C7",
              color: "#92400E",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {r.reason_not_filed}
          </span>
        ),
      },
      {
        id: "priority",
        header: "Priority",
        cell: (r) => (
          <span
            style={{
              color: priorityTone(r.priority),
              fontWeight: r.priority === "urgent" ? 600 : 500,
            }}
          >
            {priorityLabel(r.priority)}
          </span>
        ),
      },
    ],
    [],
  );

  // ── Action handlers ───────────────────────────────────────────────────────
  const handleSubmitNow = useCallback(
    async (r: Row) => {
      const res = await fetch(
        `/api/billing/claims/${r.id}/submit-immediately`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            reason: `Forced from Timely Filing Risk — ${
              r.days_remaining != null ? `${r.days_remaining}d remaining` : "deadline approaching"
            }`,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        setToast(`Submit failed: ${json?.error || res.status}`);
        return;
      }
      patchRow(r.id, { claim_status: "ready_for_batch" });
      removeRow(r.id);
      setToast(`Claim ${r.claim_number ?? r.id} queued for immediate submission.`);
    },
    [organizationId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleCreateAppeal = useCallback(
    async (r: Row) => {
      const res = await fetch(
        `/api/billing/claims/${r.id}/create-appeal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            reason: `Opened from Timely Filing Risk — appeal deadline ${
              r.appeal_deadline_date ?? "approaching"
            }`,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        setToast(`Create appeal failed: ${json?.error || res.status}`);
        return;
      }
      patchRow(r.id, { priority: "high" });
      setBumpKey((k) => k + 1);
      setToast(`Appeal opened for ${r.claim_number ?? r.id}.`);
    },
    [organizationId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleEscalate = useCallback(
    async (r: Row) => {
      const res = await fetch(
        `/api/billing/executive-priority/${r.id}/escalate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            priority: "urgent",
            reason: `Escalated from Timely Filing Risk (${r.reason_not_filed})`,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        setToast(`Escalate failed: ${json?.error || res.status}`);
        return;
      }
      patchRow(r.id, { priority: "urgent" });
      setToast(`Escalated ${r.claim_number ?? r.id} to urgent.`);
    },
    [organizationId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      {
        id: "submit",
        label: "Submit immediately",
        variant: "primary",
        onClick: (r) => void handleSubmitNow(r),
        disabled: (r) => r.tab === "expired",
      },
      {
        id: "appeal",
        label: "Create appeal",
        onClick: (r) => void handleCreateAppeal(r),
      },
      {
        id: "proof",
        label: "Attach proof",
        onClick: (r) => setProofRow(r),
      },
      {
        id: "escalate",
        label: "Escalate",
        variant: "danger",
        onClick: (r) => void handleEscalate(r),
      },
      {
        id: "uncollectible",
        label: "Mark uncollectible",
        onClick: (r) => setUncollectibleRow(r),
      },
    ],
    [handleSubmitNow, handleCreateAppeal, handleEscalate],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  // ── Detail panel (spec-exact section labels) ─────────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "payer_rule",
        label: "Payer timely filing rule",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Payer" value={selectedRow.payer_name ?? "—"} />
              <DetailKV
                label="Payer ID"
                value={
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>
                    {selectedRow.payer_id_external ?? "—"}
                  </span>
                }
              />
              <DetailKV
                label="Timely filing window"
                value={
                  selectedRow.payer_timely_filing_days != null
                    ? `${selectedRow.payer_timely_filing_days} days from DOS`
                    : "Default (90 days)"
                }
              />
              <DetailKV
                label="Filing deadline"
                value={formatDate(selectedRow.filing_deadline)}
              />
              <DetailKV
                label="Days remaining"
                value={
                  selectedRow.days_remaining == null
                    ? "—"
                    : selectedRow.expired
                      ? `${selectedRow.days_remaining}d (EXPIRED)`
                      : `${selectedRow.days_remaining}d`
                }
              />
              {selectedRow.appeal_deadline_date ? (
                <DetailKV
                  label="Appeal deadline"
                  value={formatDate(selectedRow.appeal_deadline_date)}
                />
              ) : null}
              {selectedRow.corrected_deadline ? (
                <DetailKV
                  label="Corrected-claim deadline"
                  value={formatDate(selectedRow.corrected_deadline)}
                />
              ) : null}
              {selectedRow.payer_notes ? (
                <div
                  style={{
                    marginTop: 12,
                    fontSize: 12,
                    color: "#475569",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {selectedRow.payer_notes}
                </div>
              ) : null}
            </div>
          ) : null,
      },
      {
        id: "submission_history",
        label: "Submission history",
        render: () => (selectedRow ? <SubmissionHistorySection row={selectedRow} /> : null),
      },
      {
        id: "proof",
        label: "Proof of timely filing",
        render: () =>
          selectedRow ? (
            <div>
              <div style={{ marginBottom: 10, fontSize: 12, color: "#475569" }}>
                Anything attached via “Attach proof” appears here.
                Uploaded receipts and EOBs are downloadable.
              </div>
              <ProofPanel
                claimId={selectedRow.id}
                organizationId={organizationId}
                bumpKey={bumpKey}
              />
            </div>
          ) : null,
      },
      {
        id: "denial_history",
        label: "Denial history",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV
                label="Denial code"
                value={selectedRow.denial_reason_code ?? "—"}
              />
              <DetailKV
                label="Denial description"
                value={selectedRow.denial_reason_description ?? "—"}
              />
              {selectedRow.carc_code ? (
                <DetailKV label="CARC" value={selectedRow.carc_code} />
              ) : null}
              {selectedRow.rarc_code ? (
                <DetailKV label="RARC" value={selectedRow.rarc_code} />
              ) : null}
              <div style={{ marginTop: 12 }}>
                <NotesPanel
                  claimId={selectedRow.id}
                  organizationId={organizationId}
                  bumpKey={bumpKey}
                  filter={(n) =>
                    /denial|denied|appeal|carc|rarc/i.test(n.body)
                  }
                />
              </div>
            </div>
          ) : null,
      },
      {
        id: "documents",
        label: "Related documents",
        render: () =>
          selectedRow ? (
            <ClaimDocumentsPanel
              claimId={selectedRow.id}
              organizationId={organizationId}
            />
          ) : null,
      },
    ],
    [selectedRow, organizationId, bumpKey],
  );

  const detailActions = selectedRow
    ? [
        {
          id: "submit",
          label: "Submit immediately",
          variant: "primary" as const,
          onClick: () => void handleSubmitNow(selectedRow),
          disabled: selectedRow.tab === "expired",
        },
        {
          id: "appeal",
          label: "Create appeal",
          onClick: () => void handleCreateAppeal(selectedRow),
        },
        {
          id: "proof",
          label: "Attach proof",
          onClick: () => setProofRow(selectedRow),
        },
        {
          id: "escalate",
          label: "Escalate",
          variant: "danger" as const,
          onClick: () => void handleEscalate(selectedRow),
        },
        {
          id: "uncollectible",
          label: "Mark uncollectible",
          onClick: () => setUncollectibleRow(selectedRow),
        },
      ]
    : [];

  // ── Primary tabs ──────────────────────────────────────────────────────────
  const primaryTabs: PrimaryTab[] = useMemo(
    () =>
      TIMELY_FILING_TABS.map((t) => ({
        id: t.id,
        label: t.label,
        count: tabCounts[t.id] ?? 0,
      })),
    [tabCounts],
  );

  const message = !organizationId
    ? {
        tone: "error" as const,
        text:
          "Missing organizationId. Add ?organizationId=… to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.",
      }
    : error
      ? { tone: "error" as const, text: error }
      : null;

  return (
    <>
      <WorkqueueShell<Row>
        title="Timely Filing Risk"
        description="Claims approaching the payer's timely filing deadline — submit now, appeal, or write off before the window closes."
        headerActions={[
          {
            id: "refresh",
            label: loading ? "Loading…" : "Refresh",
            onClick: () => void load(),
            disabled: loading,
          },
        ]}
        summary={summary}
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTab}
        onPrimaryTabChange={(id) => {
          setActiveTab(id as TimelyFilingTab);
          setSelectedRowId(null);
        }}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`tf_${activeTab}`}
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No claims at risk in this view."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {proofRow ? (
        <AttachProofModal
          row={proofRow}
          organizationId={organizationId}
          onClose={() => setProofRow(null)}
          onSaved={() => {
            setBumpKey((k) => k + 1);
            setToast("Proof attached");
          }}
        />
      ) : null}
      {uncollectibleRow ? (
        <UncollectibleModal
          row={uncollectibleRow}
          organizationId={organizationId}
          onClose={() => setUncollectibleRow(null)}
          onSaved={() => {
            removeRow(uncollectibleRow.id);
            setToast("Claim marked uncollectible");
          }}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
