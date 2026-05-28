"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type DetailTab,
  type FilterDef,
  type RowAction,
  type SummaryMetric,
} from "@/components/billing/WorkqueueShell";
import { ClaimDocumentsPanel } from "@/components/billing/ClaimDocumentsPanel";
import { ResolvedDenialNoteCard } from "@/components/billing/ResolvedDenialNoteCard";
import { getWorkqueue } from "@/lib/billing/workqueues";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab =
  | "missing_signature"
  | "modifier_audit"
  | "diagnosis_audit"
  | "late_documentation"
  | "overlapping_services"
  | "high_risk_patterns";

type Severity = "low" | "medium" | "high" | "urgent";

type Row = {
  id: string;
  tab: Tab;
  claimId: string;
  claimNumber: string;
  patientId: string | null;
  patientName: string;
  clinicianId: string | null;
  clinicianName: string | null;
  practiceLocationId: string | null;
  payerName: string | null;
  serviceDate: string | null;
  riskType: string;
  code: string;
  issue: string;
  severity: Severity;
  financialImpact: number;
  status: string;
  workqueueItemId: string | null;
  workqueueStatus: string | null;
  workqueuePriority: string | null;
  assignedToUserId: string | null;
  assignedToDisplayName: string | null;
  followUpDueDate: string | null;
  totalCharge: number;
  ruleId: string;
  ruleName: string;
  suggestedCorrection: string;
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

type StatusEvent = {
  id?: string;
  status: string;
  status_message?: string | null;
  source?: string | null;
  created_at: string;
};

type SummaryPayload = {
  totalCount: number;
  totalDollar: number;
  oldestAgeDays: number;
  urgentCount: number;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "missing_signature", label: "Missing Signature" },
  { id: "modifier_audit", label: "Modifier Audit" },
  { id: "diagnosis_audit", label: "Diagnosis Audit" },
  { id: "late_documentation", label: "Late Documentation" },
  { id: "overlapping_services", label: "Overlapping Services" },
  { id: "high_risk_patterns", label: "High-Risk Patterns" },
];

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

function severityChip(s: Severity) {
  const palette: Record<Severity, { bg: string; fg: string; label: string }> = {
    low: { bg: "#E0F2FE", fg: "#075985", label: "Low" },
    medium: { bg: "#FEF3C7", fg: "#92400E", label: "Medium" },
    high: { bg: "#FEE2E2", fg: "#991B1B", label: "High" },
    urgent: { bg: "#7F1D1D", fg: "#FFF", label: "Urgent" },
  };
  const p = palette[s];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: p.bg,
        color: p.fg,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {p.label}
    </span>
  );
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

function ReasonModal({
  title,
  confirmLabel,
  reasonRequired = false,
  helper,
  onClose,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  reasonRequired?: boolean;
  helper?: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ModalShell title={title} onClose={onClose}>
      {helper ? (
        <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>{helper}</p>
      ) : null}
      <label style={fieldLabel}>
        Reason {reasonRequired ? <span style={{ color: "#B91C1C" }}>*</span> : "(optional)"}
      </label>
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
        <button
          type="button"
          className="button"
          disabled={saving}
          onClick={async () => {
            const trimmed = reason.trim();
            if (reasonRequired && !trimmed) {
              setError("A reason is required for this action");
              return;
            }
            setSaving(true);
            setError(null);
            try {
              await onConfirm(trimmed);
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Failed");
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Detail-panel helpers ─────────────────────────────────────────────────────

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
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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

function AuditTrailPanel({
  claimId,
  organizationId,
  bumpKey,
}: {
  claimId: string;
  organizationId: string;
  bumpKey: number;
}) {
  const [events, setEvents] = useState<StatusEvent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    fetch(
      `/api/billing/submitted-claims/${claimId}/history?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : { success: false }))
      .then((j) => {
        if (cancelled) return;
        const arr =
          (j?.events as StatusEvent[] | undefined) ??
          (j?.history as StatusEvent[] | undefined) ??
          (Array.isArray(j?.data) ? (j.data as StatusEvent[]) : undefined) ??
          [];
        setEvents(arr);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [claimId, organizationId, bumpKey]);
  if (events == null)
    return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading audit trail…</div>;
  if (events.length === 0)
    return (
      <div style={{ color: "#94A3B8", fontSize: 13 }}>
        No audit-trail events recorded yet.
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {events.map((e, idx) => (
        <div
          key={`${e.id ?? idx}`}
          style={{
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            padding: 10,
            background: "#F9FAFB",
          }}
        >
          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
            {e.source ?? "system"} · {formatDateTime(e.created_at)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{e.status}</div>
          {e.status_message ? (
            <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>
              {e.status_message}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ─── Action call helper ───────────────────────────────────────────────────────

async function callAction(
  claimId: string,
  organizationId: string,
  action: string,
  ruleId: string,
  reason?: string,
): Promise<{ success: boolean; error?: string; data?: any }> {
  const res = await fetch(
    `/api/billing/compliance-audit/${claimId}/action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, action, ruleId, reason }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  }
  return { success: true, data: json };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const queueDef = getWorkqueue("compliance_audit");

export default function ComplianceAuditClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [activeTab, setActiveTab] = useState<Tab>("missing_signature");
  const [rows, setRows] = useState<Row[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<Tab, number>>({
    missing_signature: 0,
    modifier_audit: 0,
    diagnosis_audit: 0,
    late_documentation: 0,
    overlapping_services: 0,
    high_risk_patterns: 0,
  });
  const [summaryData, setSummaryData] = useState<SummaryPayload>({
    totalCount: 0,
    totalDollar: 0,
    oldestAgeDays: 0,
    urgentCount: 0,
  });
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [practices, setPractices] = useState<Practice[]>([]);
  const [clinicians, setClinicians] = useState<Assignee[]>([]);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [bumpKey, setBumpKey] = useState(0);

  type ActionId =
    | "route_to_clinician"
    | "hold_claim"
    | "correct_claim"
    | "document_override"
    | "supervisor_review";
  const [modalAction, setModalAction] = useState<{
    action: ActionId;
    row: Row;
  } | null>(null);

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
        `/api/billing/compliance-audit?${params.toString()}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows((json.rows ?? []) as Row[]);
      setTabCounts(json.tabCounts as Record<Tab, number>);
      setSummaryData(json.summary as SummaryPayload);
      setAssignees((json.assignees ?? []) as Assignee[]);
      setPractices((json.practices ?? []) as Practice[]);
      setClinicians((json.clinicians ?? []) as Assignee[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [organizationId, activeTab, filterValues]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchRow(rowId: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  }

  // ── Filter rail ────────────────────────────────────────────────────────────
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
      { id: "payer", label: "Payer", kind: "text", placeholder: "Payer name" },
      { id: "client", label: "Client", kind: "text", placeholder: "Client name" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "open", label: "Open" },
          { value: "deferred", label: "Deferred" },
          { value: "rejected", label: "Needs correction" },
          { value: "resolved", label: "Resolved" },
        ],
      },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "select",
        options: [
          { value: "__unassigned__", label: "— Unassigned —" },
          ...assignees.map((a) => ({ value: a.id, label: a.displayName })),
        ],
      },
      { id: "minAmount", label: "$ min", kind: "number", width: 90 },
      { id: "maxAmount", label: "$ max", kind: "number", width: 90 },
      {
        id: "agingBucket",
        label: "Age",
        kind: "select",
        options: [
          { value: "0-7", label: "0–7d" },
          { value: "8-30", label: "8–30d" },
          { value: "31-60", label: "31–60d" },
          { value: "60+", label: "60+d" },
        ],
      },
      { id: "carcRarc", label: "Rule / code", kind: "text", placeholder: "e.g. modifier.59" },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [
          { value: "low", label: "Low" },
          { value: "normal", label: "Normal" },
          { value: "high", label: "High" },
          { value: "urgent", label: "Urgent" },
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
    [practices, clinicians, assignees],
  );

  // ── Columns (spec-exact headers) ───────────────────────────────────────────
  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      {
        id: "client",
        header: "Client",
        cell: (r) => (
          <div style={{ maxWidth: 180 }}>
            <div style={{ fontWeight: 500 }}>{r.patientName}</div>
            {r.payerName ? (
              <div style={{ fontSize: 11, color: "#6B7280" }}>{r.payerName}</div>
            ) : null}
          </div>
        ),
      },
      {
        id: "clinician",
        header: "Clinician",
        cell: (r) =>
          r.clinicianName ?? <span style={{ color: "#94A3B8" }}>—</span>,
      },
      {
        id: "dos",
        header: "DOS",
        cell: (r) => formatDate(r.serviceDate),
      },
      {
        id: "claimId",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.claimNumber}
          </span>
        ),
      },
      { id: "riskType", header: "Risk type", cell: (r) => r.riskType },
      {
        id: "code",
        header: "Code",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.code}
          </span>
        ),
      },
      {
        id: "issue",
        header: "Issue",
        cell: (r) => (
          <div style={{ maxWidth: 320, fontSize: 12, color: "#334155" }}>
            {r.issue}
          </div>
        ),
      },
      { id: "severity", header: "Severity", cell: (r) => severityChip(r.severity) },
      {
        id: "financial",
        header: "Financial impact",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {formatCurrency(r.financialImpact)}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: (r) => {
          const s = r.workqueueStatus ?? r.status ?? "open";
          const tone =
            s === "resolved"
              ? "#15803D"
              : s === "rejected"
                ? "#B91C1C"
                : s === "deferred"
                  ? "#92400E"
                  : "#475569";
          return (
            <span style={{ color: tone, fontWeight: 500, fontSize: 12 }}>{s}</span>
          );
        },
      },
    ],
    [],
  );

  // ── Action handlers ────────────────────────────────────────────────────────
  const runAction = useCallback(
    async (
      row: Row,
      action: ActionId,
      reason: string | undefined,
      successMessage: string,
      optimistic: Partial<Row>,
    ) => {
      const result = await callAction(
        row.claimId,
        organizationId,
        action,
        row.ruleId,
        reason,
      );
      if (!result.success) {
        setToast(`${action} failed: ${result.error}`);
        throw new Error(result.error || "Failed");
      }
      patchRow(row.id, {
        ...optimistic,
        workqueueStatus: result.data?.item_status ?? optimistic.workqueueStatus,
        workqueuePriority: result.data?.priority ?? optimistic.workqueuePriority,
        assignedToUserId:
          result.data?.assigned_to_user_id ?? optimistic.assignedToUserId,
        assignedToDisplayName:
          result.data?.assigned_to_display_name ?? optimistic.assignedToDisplayName,
      });
      setBumpKey((k) => k + 1);
      setToast(successMessage);
    },
    [organizationId],
  );

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      {
        id: "route_to_clinician",
        label: "Route to clinician",
        onClick: (r) => setModalAction({ action: "route_to_clinician", row: r }),
      },
      {
        id: "hold_claim",
        label: "Hold claim",
        variant: "danger",
        onClick: (r) => setModalAction({ action: "hold_claim", row: r }),
      },
      {
        id: "correct_claim",
        label: "Correct claim",
        onClick: (r) => setModalAction({ action: "correct_claim", row: r }),
      },
      {
        id: "document_override",
        label: "Document override",
        onClick: (r) => setModalAction({ action: "document_override", row: r }),
      },
      {
        id: "supervisor_review",
        label: "Supervisor review",
        variant: "primary",
        onClick: (r) => setModalAction({ action: "supervisor_review", row: r }),
      },
    ],
    [],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  // ── Detail panel (spec-exact section labels) ───────────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "claim",
        label: "Claim",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Claim #" value={selectedRow.claimNumber} />
              <DetailKV label="Client" value={selectedRow.patientName} />
              <DetailKV
                label="Clinician"
                value={selectedRow.clinicianName ?? "—"}
              />
              <DetailKV label="Payer" value={selectedRow.payerName ?? "—"} />
              <DetailKV label="DOS" value={formatDate(selectedRow.serviceDate)} />
              <DetailKV
                label="Total charge"
                value={formatCurrency(selectedRow.totalCharge)}
              />
              <DetailKV
                label="Financial impact"
                value={formatCurrency(selectedRow.financialImpact)}
              />
              <DetailKV label="Severity" value={severityChip(selectedRow.severity)} />
              <DetailKV
                label="Workqueue status"
                value={selectedRow.workqueueStatus ?? "open"}
              />
              <DetailKV
                label="Assigned to"
                value={selectedRow.assignedToDisplayName ?? "Unassigned"}
              />
            </div>
          ) : null,
      },
      {
        id: "note",
        label: "Note",
        render: () =>
          selectedRow ? (
            <NotesPanel
              claimId={selectedRow.claimId}
              organizationId={organizationId}
              bumpKey={bumpKey}
            />
          ) : null,
      },
      {
        id: "audit_rule",
        label: "Audit rule triggered",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Rule ID" value={selectedRow.ruleId} />
              <DetailKV label="Rule" value={selectedRow.ruleName} />
              <DetailKV label="Code" value={selectedRow.code} />
              <DetailKV label="Risk type" value={selectedRow.riskType} />
              <div
                style={{
                  marginTop: 12,
                  padding: 10,
                  border: "1px solid #FDE68A",
                  background: "#FEF3C7",
                  borderRadius: 6,
                  fontSize: 13,
                  color: "#7C2D12",
                }}
              >
                <strong>Issue:</strong> {selectedRow.issue}
              </div>
            </div>
          ) : null,
      },
      {
        id: "suggested",
        label: "Suggested correction",
        render: () =>
          selectedRow ? (
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.6,
                background: "#ECFEFF",
                border: "1px solid #A5F3FC",
                borderRadius: 6,
                padding: 12,
                color: "#155E75",
              }}
            >
              {selectedRow.suggestedCorrection}
            </div>
          ) : null,
      },
      {
        id: "audit_trail",
        label: "Audit trail",
        render: () =>
          selectedRow ? (
            <AuditTrailPanel
              claimId={selectedRow.claimId}
              organizationId={organizationId}
              bumpKey={bumpKey}
            />
          ) : null,
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
    [selectedRow, organizationId, bumpKey],
  );

  const detailActions = selectedRow
    ? [
        {
          id: "route_to_clinician",
          label: "Route to clinician",
          onClick: () => setModalAction({ action: "route_to_clinician", row: selectedRow }),
        },
        {
          id: "hold_claim",
          label: "Hold claim",
          variant: "danger" as const,
          onClick: () => setModalAction({ action: "hold_claim", row: selectedRow }),
        },
        {
          id: "correct_claim",
          label: "Correct claim",
          onClick: () => setModalAction({ action: "correct_claim", row: selectedRow }),
        },
        {
          id: "document_override",
          label: "Document override",
          onClick: () => setModalAction({ action: "document_override", row: selectedRow }),
        },
        {
          id: "supervisor_review",
          label: "Supervisor review",
          variant: "primary" as const,
          onClick: () => setModalAction({ action: "supervisor_review", row: selectedRow }),
        },
      ]
    : [];

  // ── Header summary strip ───────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(
    () => [
      {
        id: "count",
        label: "Findings",
        value: summaryData.totalCount.toLocaleString(),
      },
      {
        id: "dollars",
        label: "Financial impact",
        value: formatCurrency(summaryData.totalDollar),
        tone: "amber",
      },
      {
        id: "oldest",
        label: "Oldest claim age",
        value: summaryData.oldestAgeDays
          ? `${summaryData.oldestAgeDays}d`
          : "—",
        tone: summaryData.oldestAgeDays > 90 ? "red" : "default",
      },
      {
        id: "urgent",
        label: "Urgent items",
        value: summaryData.urgentCount.toLocaleString(),
        tone: summaryData.urgentCount > 0 ? "red" : "default",
      },
    ],
    [summaryData],
  );

  const primaryTabs = TABS.map((t) => ({
    id: t.id,
    label: t.label,
    count: tabCounts[t.id] ?? 0,
  }));

  const message = !organizationId
    ? {
        tone: "error" as const,
        text:
          "Missing organizationId. Add ?organizationId=… to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.",
      }
    : error
      ? { tone: "error" as const, text: error }
      : null;

  // ── Action modal config ────────────────────────────────────────────────────
  const modalConfig: Record<
    ActionId,
    {
      title: (r: Row) => string;
      confirmLabel: string;
      reasonRequired?: boolean;
      helper?: (r: Row) => string;
      successMessage: (r: Row) => string;
      optimistic: Partial<Row>;
    }
  > = {
    route_to_clinician: {
      title: (r) => `Route to clinician — ${r.patientName}`,
      confirmLabel: "Route to clinician",
      helper: (r) =>
        r.clinicianName
          ? `This will assign the claim to ${r.clinicianName} and notify them via the workqueue.`
          : "No rendering clinician is on the encounter. The claim will be flagged for staff to route manually.",
      successMessage: (r) => `Routed ${r.claimNumber} to clinician`,
      optimistic: { workqueueStatus: "deferred", workqueuePriority: "high" },
    },
    hold_claim: {
      title: (r) => `Hold claim — ${r.patientName}`,
      confirmLabel: "Place on compliance hold",
      helper: () =>
        "This places the claim on a compliance hold and stops it from being submitted until released.",
      successMessage: (r) => `${r.claimNumber} placed on compliance hold`,
      optimistic: { status: "on_hold", workqueueStatus: "deferred", workqueuePriority: "high" },
    },
    correct_claim: {
      title: (r) => `Queue for correction — ${r.patientName}`,
      confirmLabel: "Queue for correction",
      helper: () => "Marks the claim as needing a corrected build before submission.",
      successMessage: (r) => `${r.claimNumber} queued for correction`,
      optimistic: { workqueueStatus: "rejected", workqueuePriority: "high" },
    },
    document_override: {
      title: (r) => `Document override — ${r.patientName}`,
      confirmLabel: "Save override",
      reasonRequired: true,
      helper: () =>
        "Document the business / clinical justification for proceeding with this claim despite the audit finding. Required for audit trail.",
      successMessage: (r) => `Override documented for ${r.claimNumber}`,
      optimistic: { workqueueStatus: "resolved", workqueuePriority: "normal" },
    },
    supervisor_review: {
      title: (r) => `Send to supervisor — ${r.patientName}`,
      confirmLabel: "Escalate to supervisor",
      helper: () => "Flags this finding as urgent and queues it for supervisor sign-off.",
      successMessage: (r) => `${r.claimNumber} escalated to supervisor review`,
      optimistic: { workqueueStatus: "deferred", workqueuePriority: "urgent" },
    },
  };

  return (
    <>
      <WorkqueueShell<Row>
        title={queueDef?.title ?? "Compliance & Audit"}
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
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTab}
        onPrimaryTabChange={(id) => {
          setActiveTab(id as Tab);
          setSelectedRowId(null);
        }}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`ca_${activeTab}`}
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No findings in this tab. 🎉"
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {modalAction ? (
        (() => {
          const cfg = modalConfig[modalAction.action];
          const r = modalAction.row;
          return (
            <ReasonModal
              title={cfg.title(r)}
              confirmLabel={cfg.confirmLabel}
              reasonRequired={cfg.reasonRequired}
              helper={cfg.helper?.(r)}
              onClose={() => setModalAction(null)}
              onConfirm={async (reason) => {
                await runAction(
                  r,
                  modalAction.action,
                  reason || undefined,
                  cfg.successMessage(r),
                  cfg.optimistic,
                );
              }}
            />
          );
        })()
      ) : null}

      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
