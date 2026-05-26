"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type RowAction,
  type SummaryMetric,
  type FilterDef,
  type DetailTab,
} from "@/components/billing/WorkqueueShell";
import { getWorkqueue } from "@/lib/billing/workqueues";
import { ClaimDocumentsPanel } from "@/components/billing/ClaimDocumentsPanel";
import {
  ClaimDocumentUploadsOverlay,
  useClaimDocumentUploads,
} from "@/components/billing/ClaimDocumentUploads";
import { ResolvedDenialNoteCard } from "@/components/billing/ResolvedDenialNoteCard";

// ─── Types ────────────────────────────────────────────────────────────────────

type HoldCategory =
  | "manual"
  | "documentation"
  | "eligibility"
  | "auth"
  | "compliance"
  | "payer_rule";

type Priority = "low" | "normal" | "high" | "urgent";

type HoldRow = {
  id: string;
  claimNumber: string;
  patientId: string;
  patientName: string;
  memberId: string | null;
  payerProfileId: string;
  payerName: string;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  totalChargeAmount: number;
  holdCategory: HoldCategory;
  holdReason: string;
  heldByDisplayName: string | null;
  heldByUserId: string | null;
  holdStartedAt: string | null;
  holdFollowUpDate: string | null;
  assignedToDisplayName: string | null;
  assignedToUserId: string | null;
  holdPriority: Priority;
  daysOnHold: number;
  noteCount: number;
  clinicianId: string | null;
  clinicianName: string | null;
  practiceLocationId: string | null;
  practiceLocationName: string | null;
  updatedAt: string | null;
};

type Assignee = { id: string; displayName: string };
type Practice = { id: string; name: string };

type Note = {
  id: string;
  body: string;
  author_display_name: string | null;
  created_at: string;
  resolved_denial?: boolean | null;
};

const TABS: Array<{ id: HoldCategory; label: string }> = [
  { id: "manual", label: "Manual Holds" },
  { id: "documentation", label: "Documentation Holds" },
  { id: "eligibility", label: "Eligibility Holds" },
  { id: "auth", label: "Auth Holds" },
  { id: "compliance", label: "Compliance Holds" },
  { id: "payer_rule", label: "Payer Rule Holds" },
];

const HOLD_CATEGORY_LABEL: Record<HoldCategory, string> = TABS.reduce(
  (acc, t) => ({ ...acc, [t.id]: t.label }),
  {} as Record<HoldCategory, string>,
);

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

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0);
}

function dosLabel(row: HoldRow): string {
  if (!row.serviceDateFrom) return "—";
  if (row.serviceDateTo && row.serviceDateTo !== row.serviceDateFrom) {
    return `${formatDate(row.serviceDateFrom)} – ${formatDate(row.serviceDateTo)}`;
  }
  return formatDate(row.serviceDateFrom);
}

// ─── Toast / Modal ────────────────────────────────────────────────────────────

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

function ModalShell({
  title,
  onClose,
  children,
  width = 500,
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

// ─── Action call helper ───────────────────────────────────────────────────────

async function callHold(
  claimId: string,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`/api/billing/claims/${claimId}/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  }
  return { success: true };
}

// ─── Action modals ────────────────────────────────────────────────────────────

function ExtendModal({
  row,
  organizationId,
  onClose,
  onDone,
}: {
  row: HoldRow;
  organizationId: string;
  onClose: () => void;
  onDone: (patch: Partial<HoldRow>, message: string) => void;
}) {
  const [followUp, setFollowUp] = useState(row.holdFollowUpDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!followUp) {
      setError("Pick a new follow-up date");
      return;
    }
    setSaving(true);
    setError(null);
    const r = await callHold(row.id, organizationId, {
      action: "extend",
      followUpDate: followUp,
    });
    setSaving(false);
    if (!r.success) {
      setError(r.error || "Failed");
      return;
    }
    onDone({ holdFollowUpDate: followUp }, "Follow-up date updated");
    onClose();
  }

  return (
    <ModalShell title={`Extend hold — ${row.patientName}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claimNumber} · {row.payerName}
      </p>
      <label style={fieldLabel}>New follow-up date</label>
      <input
        type="date"
        value={followUp}
        onChange={(e) => setFollowUp(e.target.value)}
        style={fieldInput}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function ChangeReasonModal({
  row,
  organizationId,
  onClose,
  onDone,
}: {
  row: HoldRow;
  organizationId: string;
  onClose: () => void;
  onDone: (patch: Partial<HoldRow>, message: string) => void;
}) {
  const [category, setCategory] = useState<HoldCategory>(row.holdCategory);
  const [reason, setReason] = useState(row.holdReason);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!reason.trim() && category === row.holdCategory) {
      setError("Change the category or enter a new reason");
      return;
    }
    setSaving(true);
    setError(null);
    const r = await callHold(row.id, organizationId, {
      action: "change_reason",
      holdCategory: category,
      holdReason: reason,
    });
    setSaving(false);
    if (!r.success) {
      setError(r.error || "Failed");
      return;
    }
    onDone(
      { holdCategory: category, holdReason: reason },
      "Hold reason updated",
    );
    onClose();
  }

  return (
    <ModalShell title={`Change hold reason — ${row.patientName}`} onClose={onClose}>
      <label style={fieldLabel}>Category</label>
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as HoldCategory)}
        style={fieldInput}
      >
        {TABS.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <label style={{ ...fieldLabel, marginTop: 12 }}>Reason</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        style={fieldInput}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function AssignModal({
  row,
  organizationId,
  assignees,
  onClose,
  onDone,
}: {
  row: HoldRow;
  organizationId: string;
  assignees: Assignee[];
  onClose: () => void;
  onDone: (patch: Partial<HoldRow>, message: string) => void;
}) {
  const [assigneeId, setAssigneeId] = useState(row.assignedToUserId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const picked = assignees.find((a) => a.id === assigneeId) ?? null;
    const r = await callHold(row.id, organizationId, {
      action: "assign",
      assigneeUserId: picked?.id ?? null,
      assigneeDisplayName: picked?.displayName ?? null,
    });
    setSaving(false);
    if (!r.success) {
      setError(r.error || "Failed");
      return;
    }
    onDone(
      {
        assignedToUserId: picked?.id ?? null,
        assignedToDisplayName: picked?.displayName ?? null,
      },
      picked ? `Assigned to ${picked.displayName}` : "Unassigned",
    );
    onClose();
  }

  return (
    <ModalShell title={`Assign hold — ${row.patientName}`} onClose={onClose}>
      <label style={fieldLabel}>Assignee</label>
      <select
        value={assigneeId}
        onChange={(e) => setAssigneeId(e.target.value)}
        style={fieldInput}
      >
        <option value="">— Unassigned —</option>
        {assignees.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
          </option>
        ))}
      </select>
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function NoteModal({
  row,
  organizationId,
  onClose,
  onSaved,
}: {
  row: HoldRow;
  organizationId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [body, setBody] = useState("");
  const [resolvedDenial, setResolvedDenial] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!body.trim()) {
      setError("Note body is required");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/billing/claims/${row.id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        body: body.trim(),
        resolved_denial: resolvedDenial,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Failed");
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <ModalShell title={`Add note — ${row.patientName}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claimNumber}
      </p>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        style={fieldInput}
      />
      <div style={{ marginTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={resolvedDenial}
            onChange={(e) => setResolvedDenial(e.target.checked)}
          />
          This note resolved the denial
        </label>
      </div>
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save note"}
        </button>
      </div>
    </ModalShell>
  );
}

function CancelModal({
  row,
  organizationId,
  onClose,
  onDone,
}: {
  row: HoldRow;
  organizationId: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const r = await callHold(row.id, organizationId, {
      action: "cancel_claim",
      reason,
    });
    setSaving(false);
    if (!r.success) {
      setError(r.error || "Failed");
      return;
    }
    onDone(`Claim ${row.claimNumber} cancelled`);
    onClose();
  }

  return (
    <ModalShell title={`Cancel claim — ${row.patientName}`} onClose={onClose}>
      <p style={{ color: "#B91C1C", fontSize: 13, margin: "0 0 12px" }}>
        This marks the claim cancelled. It will not be re-submitted.
      </p>
      <label style={fieldLabel}>Reason (optional)</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        style={fieldInput}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Keep claim
        </button>
        <button type="button" className="button" onClick={save} disabled={saving} style={{ background: "#B91C1C", color: "#fff" }}>
          {saving ? "Cancelling…" : "Cancel claim"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Detail panel sections ────────────────────────────────────────────────────

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
      <span style={{ color: "#0F172A", textAlign: "right", maxWidth: "60%" }}>{value}</span>
    </div>
  );
}

function NotesHistory({
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
  if (notes == null) return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading notes…</div>;
  if (notes.length === 0)
    return <div style={{ color: "#94A3B8", fontSize: 13 }}>No notes yet.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {notes.map((n) => (
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


function nextStepForCategory(cat: HoldCategory): string {
  switch (cat) {
    case "manual":
      return "Review hold reason with the biller who placed it, then release or extend.";
    case "documentation":
      return "Chase the signed clinical note or supporting document, then release.";
    case "eligibility":
      return "Re-run 270/271 eligibility for the date of service and update coverage.";
    case "auth":
      return "Obtain or update the prior authorization on file, then release.";
    case "compliance":
      return "Get supervisor / compliance sign-off before releasing.";
    case "payer_rule":
      return "Confirm the claim now satisfies the payer-specific rule, then release.";
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const queueDef = getWorkqueue("claim_hold");

export default function ClaimHoldClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<HoldRow[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [practices, setPractices] = useState<Practice[]>([]);
  const [clinicians, setClinicians] = useState<Assignee[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<HoldCategory>("manual");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const [extendRow, setExtendRow] = useState<HoldRow | null>(null);
  const [reasonRow, setReasonRow] = useState<HoldRow | null>(null);
  const [assignRow, setAssignRow] = useState<HoldRow | null>(null);
  const [noteRow, setNoteRow] = useState<HoldRow | null>(null);
  const [cancelRow, setCancelRow] = useState<HoldRow | null>(null);
  const [notesBumpKey, setNotesBumpKey] = useState(0);
  const docUploads = useClaimDocumentUploads(organizationId);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, category: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) params.set(k, v);
      }
      const res = await fetch(`/api/billing/claim-hold?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows((json.rows ?? []) as HoldRow[]);
      setAssignees((json.assignees ?? []) as Assignee[]);
      setPractices((json.practices ?? []) as Practice[]);
      setClinicians((json.clinicians ?? []) as Assignee[]);
      setTabCounts((json.tabCounts ?? {}) as Record<string, number>);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [organizationId, activeTab, filterValues]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchRow(claimId: string, patch: Partial<HoldRow>) {
    setRows((prev) =>
      prev.map((r) => (r.id === claimId ? { ...r, ...patch } : r)),
    );
  }

  function removeRow(claimId: string) {
    setRows((prev) => prev.filter((r) => r.id !== claimId));
    if (selectedRowId === claimId) setSelectedRowId(null);
  }

  async function releaseHold(row: HoldRow) {
    const r = await callHold(row.id, organizationId, { action: "release" });
    if (!r.success) {
      setToast(r.error || "Failed to release");
      return;
    }
    removeRow(row.id);
    setToast("Hold released");
  }

  // ── Universal filter rail (full spec: practice, clinician, payer,
  //    client, DOS, status, assigned biller, dollar amount, aging
  //    bucket, CARC/RARC, priority, follow-up due date) ───────────────────
  const payerOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const r of rows) if (r.payerName) set.set(r.payerName, r.payerName);
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
        options: clinicians.map((c) => ({ value: c.id, label: c.displayName })),
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
          { value: "urgent", label: "Urgent" },
          { value: "high", label: "High" },
          { value: "normal", label: "Normal" },
          { value: "low", label: "Low" },
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
          { value: "0-7", label: "0–7 days" },
          { value: "8-30", label: "8–30 days" },
          { value: "31-60", label: "31–60 days" },
          { value: "60+", label: "60+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 197" },
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
        label: "Follow-up due date",
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

  // ── Header summary metrics ────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const total = rows.length;
    const dollars = rows.reduce((s, r) => s + (r.totalChargeAmount || 0), 0);
    const oldest = rows.reduce((m, r) => Math.max(m, r.daysOnHold), 0);
    const urgent = rows.filter(
      (r) => r.holdPriority === "urgent" || r.daysOnHold > 30,
    ).length;
    return [
      { id: "count", label: "Holds in view", value: total.toLocaleString() },
      {
        id: "dollars",
        label: "Total $ on hold",
        value: formatCurrency(dollars),
        tone: dollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: oldest,
        tone: oldest > 30 ? "red" : oldest > 7 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: urgent,
        tone: urgent > 0 ? "red" : "default",
      },
    ];
  }, [rows]);

  // ── Columns ───────────────────────────────────────────────────────────────
  const columns: ColumnDef<HoldRow>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.patientName },
      {
        id: "claim",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.claimNumber}</span>
        ),
      },
      { id: "payer", header: "Payer", cell: (r) => r.payerName },
      { id: "dos", header: "DOS", cell: (r) => dosLabel(r) },
      {
        id: "charge",
        header: "Charge amount",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatCurrency(r.totalChargeAmount)}
          </span>
        ),
      },
      {
        id: "reason",
        header: "Hold reason",
        cell: (r) => (
          <span style={{ color: r.holdReason ? "#0F172A" : "#9CA3AF" }}>
            {r.holdReason || "—"}
          </span>
        ),
      },
      { id: "heldBy", header: "Held by", cell: (r) => r.heldByDisplayName ?? "—" },
      { id: "holdDate", header: "Hold date", cell: (r) => formatDate(r.holdStartedAt) },
      {
        id: "followUp",
        header: "Follow-up date",
        cell: (r) => {
          if (!r.holdFollowUpDate) return "—";
          const today = new Date().toISOString().slice(0, 10);
          const overdue = r.holdFollowUpDate < today;
          return (
            <span style={{ color: overdue ? "#B91C1C" : "#0F172A", fontWeight: overdue ? 600 : 400 }}>
              {formatDate(r.holdFollowUpDate)}
            </span>
          );
        },
      },
      {
        id: "assigned",
        header: "Assigned to",
        cell: (r) => (
          <span style={{ color: r.assignedToDisplayName ? "#0F172A" : "#9CA3AF" }}>
            {r.assignedToDisplayName ?? "Unassigned"}
          </span>
        ),
      },
      {
        id: "daysOnHold",
        header: "Days on hold",
        align: "right",
        cell: (r) => (
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              color: r.daysOnHold > 30 ? "#B91C1C" : r.daysOnHold > 7 ? "#B45309" : "#0F172A",
              fontWeight: r.daysOnHold > 30 ? 600 : 400,
            }}
          >
            {r.daysOnHold}
          </span>
        ),
      },
    ],
    [],
  );

  // Row actions use the spec's exact button labels.
  const rowActions: RowAction<HoldRow>[] = useMemo(
    () => [
      { id: "release", label: "Release hold", variant: "success", onClick: (r) => void releaseHold(r) },
      { id: "extend", label: "Extend hold", onClick: (r) => setExtendRow(r) },
      { id: "reason", label: "Change hold reason", onClick: (r) => setReasonRow(r) },
      { id: "assign", label: "Assign", onClick: (r) => setAssignRow(r) },
      { id: "note", label: "Add note", onClick: (r) => setNoteRow(r) },
      { id: "cancel", label: "Cancel claim", variant: "danger", onClick: (r) => setCancelRow(r) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  // Detail-panel sections use the spec's exact labels.
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "reason",
        label: "Hold reason",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV
                label="Category"
                value={HOLD_CATEGORY_LABEL[selectedRow.holdCategory]}
              />
              <DetailKV label="Reason" value={selectedRow.holdReason || "—"} />
              <DetailKV label="Held by" value={selectedRow.heldByDisplayName ?? "—"} />
              <DetailKV label="Hold date" value={formatDate(selectedRow.holdStartedAt)} />
              <DetailKV
                label="Follow-up date"
                value={formatDate(selectedRow.holdFollowUpDate)}
              />
              <DetailKV label="Priority" value={selectedRow.holdPriority} />
              <DetailKV label="Days on hold" value={selectedRow.daysOnHold} />
            </div>
          ) : null,
      },
      {
        id: "snapshot",
        label: "Claim snapshot",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Patient" value={selectedRow.patientName} />
              <DetailKV label="Member ID" value={selectedRow.memberId ?? "—"} />
              <DetailKV label="Payer" value={selectedRow.payerName} />
              <DetailKV label="Claim #" value={selectedRow.claimNumber} />
              <DetailKV label="DOS" value={dosLabel(selectedRow)} />
              <DetailKV
                label="Total charge"
                value={formatCurrency(selectedRow.totalChargeAmount)}
              />
              <DetailKV label="Clinician" value={selectedRow.clinicianName ?? "—"} />
              <DetailKV label="Practice" value={selectedRow.practiceLocationName ?? "—"} />
              <DetailKV label="Assigned to" value={selectedRow.assignedToDisplayName ?? "Unassigned"} />
            </div>
          ) : null,
      },
      {
        id: "next",
        label: "Required next step",
        render: () =>
          selectedRow ? (
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                Required next step
              </div>
              <div style={{ color: "#0F172A" }}>
                {nextStepForCategory(selectedRow.holdCategory)}
              </div>
            </div>
          ) : null,
      },
      {
        id: "notes",
        label: "Notes history",
        render: () =>
          selectedRow ? (
            <NotesHistory
              claimId={selectedRow.id}
              organizationId={organizationId}
              bumpKey={notesBumpKey}
            />
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
    [selectedRow, organizationId, notesBumpKey],
  );

  // Detail-panel actions use the spec's exact button labels.
  const detailActions = selectedRow
    ? [
        {
          id: "release",
          label: "Release hold",
          variant: "success" as const,
          onClick: () => void releaseHold(selectedRow),
        },
        { id: "extend", label: "Extend hold", onClick: () => setExtendRow(selectedRow) },
        { id: "reason", label: "Change hold reason", onClick: () => setReasonRow(selectedRow) },
        { id: "assign", label: "Assign", onClick: () => setAssignRow(selectedRow) },
        { id: "note", label: "Add note", onClick: () => setNoteRow(selectedRow) },
        {
          id: "cancel",
          label: "Cancel claim",
          variant: "danger" as const,
          onClick: () => setCancelRow(selectedRow),
        },
      ]
    : [];

  // ── Tab strip (placed above the shell) ────────────────────────────────────
  const tabStrip = (
    <div
      role="tablist"
      aria-label="Hold categories"
      style={{
        display: "flex",
        gap: 4,
        padding: "12px 24px 0",
        borderBottom: "1px solid #E5E7EB",
        flexWrap: "wrap",
      }}
    >
      {TABS.map((t) => {
        const count = tabCounts[t.id] ?? 0;
        const active = t.id === activeTab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              setActiveTab(t.id);
              setSelectedRowId(null);
            }}
            style={{
              border: "none",
              background: "transparent",
              padding: "8px 12px",
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              color: active ? "#1D4ED8" : "#475569",
              borderBottom: active ? "2px solid #1D4ED8" : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {t.label}
            <span
              style={{
                marginLeft: 6,
                color: "#6B7280",
                fontWeight: 500,
              }}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );

  const message = !organizationId
    ? {
        tone: "error" as const,
        text: "Missing organizationId. Add ?organizationId=… to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.",
      }
    : error
      ? { tone: "error" as const, text: error }
      : null;

  return (
    <>
      {tabStrip}
      <WorkqueueShell<HoldRow>
        title={queueDef?.title ?? "Claim Hold"}
        description={queueDef?.description}
        headerActions={[
          {
            id: "refresh",
            label: loading ? "Loading…" : "Refresh",
            onClick: () => void load(),
            disabled: loading,
          },
        ]}
        summary={summary}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`hold_${activeTab}`}
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage={`No ${HOLD_CATEGORY_LABEL[activeTab].toLowerCase()} in view.`}
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
        onRowDrop={(row, files) => {
          docUploads.uploadFiles(
            row.id,
            `Claim ${row.claimNumber} · ${row.patientName}`,
            files,
            () => setNotesBumpKey((k) => k + 1),
          );
        }}
      />
      <ClaimDocumentUploadsOverlay
        uploads={docUploads.uploads}
        onDismiss={docUploads.dismiss}
      />

      {extendRow ? (
        <ExtendModal
          row={extendRow}
          organizationId={organizationId}
          onClose={() => setExtendRow(null)}
          onDone={(patch, msg) => {
            patchRow(extendRow.id, patch);
            setToast(msg);
          }}
        />
      ) : null}
      {reasonRow ? (
        <ChangeReasonModal
          row={reasonRow}
          organizationId={organizationId}
          onClose={() => setReasonRow(null)}
          onDone={(patch, msg) => {
            // If the row's category changed and no longer matches the
            // active tab, drop it from the visible set.
            if (patch.holdCategory && patch.holdCategory !== activeTab) {
              removeRow(reasonRow.id);
            } else {
              patchRow(reasonRow.id, patch);
            }
            setToast(msg);
          }}
        />
      ) : null}
      {assignRow ? (
        <AssignModal
          row={assignRow}
          organizationId={organizationId}
          assignees={assignees}
          onClose={() => setAssignRow(null)}
          onDone={(patch, msg) => {
            patchRow(assignRow.id, patch);
            setToast(msg);
          }}
        />
      ) : null}
      {noteRow ? (
        <NoteModal
          row={noteRow}
          organizationId={organizationId}
          onClose={() => setNoteRow(null)}
          onSaved={() => {
            patchRow(noteRow.id, { noteCount: noteRow.noteCount + 1 });
            setNotesBumpKey((k) => k + 1);
            setToast("Note saved");
          }}
        />
      ) : null}
      {cancelRow ? (
        <CancelModal
          row={cancelRow}
          organizationId={organizationId}
          onClose={() => setCancelRow(null)}
          onDone={(msg) => {
            removeRow(cancelRow.id);
            setToast(msg);
          }}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
