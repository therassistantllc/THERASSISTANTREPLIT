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
import { getWorkqueue } from "@/lib/billing/workqueues";

// ─── Types ──────────────────────────────────────────────────────────────────

type Category = "file_rejected" | "claim_syntax" | "invalid_submitter" | "edi_format";
type Priority = "low" | "normal" | "high" | "urgent";

interface Row {
  id: string;
  claimId: string | null;
  claimNumber: string;
  clientId: string | null;
  clientName: string;
  payerName: string;
  payerProfileId: string | null;
  batchId: string | null;
  batchNumber: string;
  rejectionCode: string;
  rejectionMessage: string;
  errorLocation: string;
  submittedDate: string | null;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  totalChargeAmount: number;
  assignedToUserId: string | null;
  assignedToDisplayName: string | null;
  priority: Priority;
  status: string;
  deferredUntil: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  category: Category;
  contextPayload: Record<string, any>;
  claimStatus: string | null;
  description: string;
  title: string;
  ageDays: number;
  noteCount: number;
}

interface Assignee {
  id: string;
  displayName: string;
}

interface Metrics {
  totalCount: number;
  totalDollars: number;
  oldestAgeDays: number;
  urgentCount: number;
}

const TABS: Array<{ id: Category; label: string }> = [
  { id: "file_rejected", label: "File Rejected" },
  { id: "claim_syntax", label: "Claim Syntax Error" },
  { id: "invalid_submitter", label: "Invalid Submitter Data" },
  { id: "edi_format", label: "EDI Format Error" },
];

const CATEGORY_LABEL: Record<Category, string> = TABS.reduce(
  (acc, t) => ({ ...acc, [t.id]: t.label }),
  {} as Record<Category, string>,
);

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
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0);
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

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre
      style={{
        background: "#0F172A",
        color: "#E2E8F0",
        padding: 12,
        borderRadius: 6,
        fontSize: 12,
        fontFamily: "ui-monospace, Menlo, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        margin: 0,
      }}
    >
      {children}
    </pre>
  );
}

// ─── Toast / Modal ─────────────────────────────────────────────────────────

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
        background: "rgba(15,23,42,0.55)",
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

// ─── Action call helper ────────────────────────────────────────────────────

interface ActionResponse {
  success: boolean;
  error?: string;
  patch?: Partial<Row>;
  navigateTo?: string;
  removeFromQueue?: boolean;
}

async function callAction(body: Record<string, unknown>): Promise<ActionResponse> {
  const res = await fetch("/api/billing/rejections-999/action", {
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

function AssignModal({
  row,
  organizationId,
  assignees,
  onClose,
  onDone,
}: {
  row: Row;
  organizationId: string;
  assignees: Assignee[];
  onClose: () => void;
  onDone: (patch: Partial<Row>, message: string) => void;
}) {
  const [userId, setUserId] = useState<string>(row.assignedToUserId ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <ModalShell title={`Assign — ${row.claimNumber}`} onClose={onClose}>
      <label style={fieldLabel}>Assign to</label>
      <select
        style={fieldInput}
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
      >
        <option value="">Unassigned</option>
        {assignees.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
          </option>
        ))}
      </select>
      {err ? (
        <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>{err}</div>
      ) : null}
      <div style={buttonRow}>
        <button type="button" onClick={onClose} style={{ padding: "6px 12px" }}>
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          style={{ padding: "6px 12px", background: "#1D4ED8", color: "#fff", border: "none", borderRadius: 4 }}
          onClick={async () => {
            setSaving(true);
            setErr(null);
            const assignee = assignees.find((a) => a.id === userId);
            const r = await callAction({
              action: "assign",
              organizationId,
              workqueueItemId: row.id,
              assignedToUserId: userId || null,
              assigneeDisplayName: assignee?.displayName ?? null,
            });
            setSaving(false);
            if (!r.success) {
              setErr(r.error ?? "Failed");
              return;
            }
            onDone(
              {
                assignedToUserId: userId || null,
                assignedToDisplayName: assignee?.displayName ?? null,
                status: (r.patch?.status as string) ?? row.status,
              },
              userId ? `Assigned to ${assignee?.displayName ?? "user"}` : "Unassigned",
            );
            onClose();
          }}
        >
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
  row: Row;
  organizationId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <ModalShell title={`Add note — ${row.claimNumber}`} onClose={onClose}>
      <label style={fieldLabel}>Note</label>
      <textarea
        style={{ ...fieldInput, minHeight: 120 }}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What did you find / what's the next step?"
      />
      {err ? (
        <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>{err}</div>
      ) : null}
      <div style={buttonRow}>
        <button type="button" onClick={onClose} style={{ padding: "6px 12px" }}>
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !body.trim()}
          style={{ padding: "6px 12px", background: "#1D4ED8", color: "#fff", border: "none", borderRadius: 4 }}
          onClick={async () => {
            setSaving(true);
            setErr(null);
            const r = await callAction({
              action: "note",
              organizationId,
              workqueueItemId: row.id,
              body: body.trim(),
            });
            setSaving(false);
            if (!r.success) {
              setErr(r.error ?? "Failed");
              return;
            }
            onSaved();
            onClose();
          }}
        >
          {saving ? "Saving…" : "Save note"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Correction checklist (derived from category) ──────────────────────────

function correctionChecklist(category: Category): string[] {
  switch (category) {
    case "file_rejected":
      return [
        "Confirm the receiver/payer ID on the ISA/GS envelope matches the clearinghouse",
        "Re-validate the file contents end-to-end before transmission",
        "Rebuild the 837P from the underlying claim(s)",
        "Resubmit the file once validation passes",
      ];
    case "claim_syntax":
      return [
        "Open the affected claim segment flagged below",
        "Correct the missing/invalid element on the source claim",
        "Re-validate the claim and rebuild the 837P",
        "Resubmit the claim to the clearinghouse",
      ];
    case "invalid_submitter":
      return [
        "Verify Loop 1000A submitter name, ID, and contact info on the EDI profile",
        "Confirm the submitter ID is enrolled with the clearinghouse for this payer",
        "Update the submitter profile if needed and re-validate",
        "Rebuild the 837P and resubmit",
      ];
    case "edi_format":
      return [
        "Review the AK3/AK4 envelope error reported by the clearinghouse",
        "Inspect the upstream 837P builder for the segment/element flagged",
        "Patch the builder template and re-validate envelope integrity",
        "Regenerate the 837P file and resubmit",
      ];
  }
}

// ─── Page ──────────────────────────────────────────────────────────────────

const queueDef = getWorkqueue("rejections_999");

export default function Rejections999Client() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [payers, setPayers] = useState<Array<{ value: string; label: string }>>([]);
  const [tabCounts, setTabCounts] = useState<Record<Category, number>>({
    file_rejected: 0,
    claim_syntax: 0,
    invalid_submitter: 0,
    edi_format: 0,
  });
  const [metrics, setMetrics] = useState<Metrics>({
    totalCount: 0,
    totalDollars: 0,
    oldestAgeDays: 0,
    urgentCount: 0,
  });
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<Category>("file_rejected");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const [assignRow, setAssignRow] = useState<Row | null>(null);
  const [noteRow, setNoteRow] = useState<Row | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, category: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) params.set(k, v);
      }
      const res = await fetch(`/api/billing/rejections-999?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows((json.rows ?? []) as Row[]);
      setAssignees((json.assignees ?? []) as Assignee[]);
      setPayers((json.filterOptions?.payers ?? []) as Array<{ value: string; label: string }>);
      setTabCounts({
        file_rejected: 0,
        claim_syntax: 0,
        invalid_submitter: 0,
        edi_format: 0,
        ...(json.tabCounts ?? {}),
      });
      setMetrics(json.metrics ?? metrics);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, activeTab, filterValues]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchRow(id: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    if (selectedRowId === id) setSelectedRowId(null);
  }

  async function runResubmit(row: Row) {
    const r = await callAction({
      action: "resubmit",
      organizationId,
      workqueueItemId: row.id,
    });
    if (!r.success) {
      setToast(r.error ?? "Resubmit failed");
      return;
    }
    if (r.removeFromQueue) removeRow(row.id);
    else patchRow(row.id, (r.patch as Partial<Row>) ?? {});
    setToast("Claim queued for resubmission");
  }

  async function runRebuild837(row: Row) {
    const r = await callAction({
      action: "rebuild_837",
      organizationId,
      workqueueItemId: row.id,
    });
    if (!r.success) {
      setToast(r.error ?? "Rebuild failed");
      return;
    }
    patchRow(row.id, (r.patch as Partial<Row>) ?? {});
    setToast("Claim queued for 837P rebuild");
  }

  async function runCorrect(row: Row) {
    const r = await callAction({
      action: "correct",
      organizationId,
      workqueueItemId: row.id,
    });
    if (!r.success) {
      setToast(r.error ?? "Failed to open claim editor");
      return;
    }
    patchRow(row.id, (r.patch as Partial<Row>) ?? {});
    if (r.navigateTo && typeof window !== "undefined") {
      window.location.href = r.navigateTo;
    }
  }

  // ── Universal filter rail ─────────────────────────────────────────────────
  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "text", placeholder: "Search…" },
      { id: "clinician", label: "Clinician", kind: "text", placeholder: "Search…" },
      { id: "payer", label: "Payer", kind: "select", options: payers },
      { id: "client", label: "Client", kind: "text", placeholder: "Patient name…" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "open", label: "Open" },
          { value: "in_progress", label: "In progress" },
          { value: "blocked", label: "Blocked" },
          { value: "resolved", label: "Resolved" },
          { value: "closed", label: "Closed" },
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
      { id: "carcRarc", label: "Rejection code", kind: "text", placeholder: "e.g. IK304" },
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
    [payers, assignees],
  );

  // ── Header summary metrics ────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(
    () => [
      {
        id: "count",
        label: "Rejections in view",
        value: metrics.totalCount.toLocaleString(),
      },
      {
        id: "dollars",
        label: "Total $ rejected",
        value: formatCurrency(metrics.totalDollars),
        tone: metrics.totalDollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: metrics.oldestAgeDays,
        tone:
          metrics.oldestAgeDays > 30 ? "red" : metrics.oldestAgeDays > 7 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: metrics.urgentCount,
        tone: metrics.urgentCount > 0 ? "red" : "default",
      },
    ],
    [metrics],
  );

  // ── Columns (spec-exact) ──────────────────────────────────────────────────
  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      {
        id: "batch",
        header: "Batch ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.batchNumber}</span>
        ),
      },
      {
        id: "claim",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.claimNumber}</span>
        ),
      },
      { id: "client", header: "Client", cell: (r) => r.clientName },
      { id: "payer", header: "Payer", cell: (r) => r.payerName },
      {
        id: "code",
        header: "Rejection code",
        cell: (r) => (
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              color: "#B91C1C",
              fontWeight: 600,
            }}
          >
            {r.rejectionCode}
          </span>
        ),
      },
      {
        id: "msg",
        header: "Rejection message",
        cell: (r) => (
          <span title={r.rejectionMessage} style={{ color: "#0F172A" }}>
            {r.rejectionMessage.length > 80
              ? `${r.rejectionMessage.slice(0, 80)}…`
              : r.rejectionMessage}
          </span>
        ),
      },
      {
        id: "loc",
        header: "Error location",
        cell: (r) => <span style={{ color: "#475569", fontSize: 12 }}>{r.errorLocation}</span>,
      },
      {
        id: "submitted",
        header: "Submitted date",
        cell: (r) => formatDate(r.submittedDate),
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
    ],
    [],
  );

  // Row actions (spec-exact labels)
  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      { id: "correct", label: "Correct claim", variant: "primary", onClick: (r) => void runCorrect(r) },
      { id: "rebuild", label: "Rebuild 837", onClick: (r) => void runRebuild837(r) },
      { id: "resubmit", label: "Resubmit", variant: "success", onClick: (r) => void runResubmit(r) },
      { id: "assign", label: "Assign", onClick: (r) => setAssignRow(r) },
      { id: "note", label: "Add note", onClick: (r) => setNoteRow(r) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  // Detail-panel sections (spec-exact labels)
  const detailTabs: DetailTab[] = useMemo(() => {
    return [
      {
        id: "response",
        label: "999 response",
        render: () => {
          if (!selectedRow) return null;
          const parsed = (selectedRow.contextPayload?.parsed_content ?? {}) as Record<string, any>;
          return (
            <div>
              <DetailKV label="Batch" value={selectedRow.batchNumber} />
              <DetailKV label="Submitted" value={formatDate(selectedRow.submittedDate)} />
              <DetailKV label="AK9 code" value={String(parsed.ak9Code ?? "—")} />
              <DetailKV
                label="IK5 statuses"
                value={
                  Array.isArray(parsed.ik5Statuses) && parsed.ik5Statuses.length > 0
                    ? parsed.ik5Statuses.join(", ")
                    : "—"
                }
              />
              <DetailKV label="Segment count" value={String(parsed.segmentCount ?? "—")} />
              <DetailKV label="Outcome category" value={CATEGORY_LABEL[selectedRow.category]} />
            </div>
          );
        },
      },
      {
        id: "explanation",
        label: "EDI error explanation",
        render: () => {
          if (!selectedRow) return null;
          return (
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <DetailKV label="Code" value={selectedRow.rejectionCode} />
              <DetailKV label="Message" value={selectedRow.rejectionMessage} />
              <DetailKV label="Location" value={selectedRow.errorLocation} />
              <div style={{ marginTop: 12, color: "#475569" }}>
                The clearinghouse rejected this transmission at the {CATEGORY_LABEL[selectedRow.category].toLowerCase()} level.
                Resolve the underlying problem before the file can be re-accepted.
              </div>
            </div>
          );
        },
      },
      {
        id: "segment",
        label: "Affected claim segment",
        render: () => {
          if (!selectedRow) return null;
          const parsed = (selectedRow.contextPayload?.parsed_content ?? {}) as Record<string, any>;
          const segs: string[] = Array.isArray(parsed.errorSegments) ? parsed.errorSegments : [];
          if (segs.length === 0) {
            return (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>
                No discrete error segment captured — file rejected at the envelope level.
              </div>
            );
          }
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {segs.map((s, i) => (
                <CodeBlock key={i}>{s}</CodeBlock>
              ))}
            </div>
          );
        },
      },
      {
        id: "checklist",
        label: "Correction checklist",
        render: () => {
          if (!selectedRow) return null;
          const steps = correctionChecklist(selectedRow.category);
          return (
            <ol style={{ paddingLeft: 18, margin: 0, lineHeight: 1.6, fontSize: 13 }}>
              {steps.map((s, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  {s}
                </li>
              ))}
            </ol>
          );
        },
      },
    ];
  }, [selectedRow]);

  const detailActions: PrimaryAction[] = selectedRow
    ? [
        {
          id: "correct",
          label: "Correct claim",
          variant: "primary",
          onClick: () => void runCorrect(selectedRow),
        },
        { id: "rebuild", label: "Rebuild 837", onClick: () => void runRebuild837(selectedRow) },
        {
          id: "resubmit",
          label: "Resubmit",
          variant: "success",
          onClick: () => void runResubmit(selectedRow),
        },
        { id: "assign", label: "Assign", onClick: () => setAssignRow(selectedRow) },
        { id: "note", label: "Add note", onClick: () => setNoteRow(selectedRow) },
      ]
    : [];

  // ── Tab strip ─────────────────────────────────────────────────────────────
  const tabStrip = (
    <div
      role="tablist"
      aria-label="999 rejection categories"
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
            <span style={{ marginLeft: 6, color: "#6B7280", fontWeight: 500 }}>{count}</span>
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
      <WorkqueueShell<Row>
        title={queueDef?.title ?? "999 Rejections"}
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
        filterUrlNamespace={`rej999_${activeTab}`}
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage={`No "${CATEGORY_LABEL[activeTab]}" rejections in view.`}
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

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
            setToast("Note saved");
          }}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
