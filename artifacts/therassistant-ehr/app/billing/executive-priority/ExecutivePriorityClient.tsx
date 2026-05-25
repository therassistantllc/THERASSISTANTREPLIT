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
import type { ExecutiveTab } from "@/app/api/billing/executive-priority/route";

// ─── Types ─────────────────────────────────────────────────────────────────

type Priority = "low" | "normal" | "high" | "urgent";
type FinancialRisk = "low" | "medium" | "high" | "critical";

interface Row {
  id: string;
  claimId: string;
  claimNumber: string;
  practiceName: string;
  clientId: string;
  clientName: string;
  payerName: string;
  serviceDateFrom: string | null;
  balance: number;
  ageDays: number | null;
  issueType: string;
  reasonForPriority: string;
  recommendedAction: string;
  priority: Priority;
  assignedToId: string | null;
  assignedToName: string | null;
  dueDate: string | null;
  appealDeadline: string | null;
  financialRisk: FinancialRisk;
  claimStatus: string;
  carcCode: string | null;
  rarcCode: string | null;
  denialReason: string;
  workqueueItemId: string | null;
  updatedAt: string | null;
  timeline: Array<{ id: string; at: string; label: string; detail: string }>;
  notes: Array<{
    id: string;
    body: string;
    author: string;
    createdAt: string;
    isExecutive: boolean;
  }>;
}

interface ApiResponse {
  success: boolean;
  error?: string;
  rows?: Row[];
  metrics?: {
    totalCount: number;
    totalDollars: number;
    oldestAgeDays: number;
    urgentCount: number;
  };
  filterOptions?: {
    payers: Array<{ value: string; label: string }>;
    clients: Array<{ value: string; label: string }>;
    assignees: Array<{ value: string; label: string }>;
  };
  practiceName?: string;
}

// ─── Tabs (exact spec labels) ──────────────────────────────────────────────

const TABS: Array<{ id: ExecutiveTab; label: string }> = [
  { id: "high_dollar", label: "High Dollar" },
  { id: "urgent_follow_up", label: "Urgent Follow-Up" },
  { id: "appeal_deadlines", label: "Appeal Deadlines" },
  { id: "oldest_claims", label: "Oldest Claims" },
  { id: "vip_practices", label: "VIP Practices" },
  { id: "unassigned_work", label: "Unassigned Work" },
  { id: "staff_workload", label: "Staff Workload" },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function getOrganizationId(): string {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n || 0);
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString();
}

function fmtDateTime(v: string): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
}

function priorityBadge(p: Priority) {
  const palette: Record<Priority, { bg: string; fg: string }> = {
    low: { bg: "#F1F5F9", fg: "#475569" },
    normal: { bg: "#E0F2FE", fg: "#0369A1" },
    high: { bg: "#FEF3C7", fg: "#92400E" },
    urgent: { bg: "#FEE2E2", fg: "#991B1B" },
  };
  const c = palette[p];
  return (
    <span
      style={{
        display: "inline-block",
        background: c.bg,
        color: c.fg,
        borderRadius: 4,
        padding: "2px 8px",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {p}
    </span>
  );
}

function riskBadge(r: FinancialRisk) {
  const palette: Record<FinancialRisk, string> = {
    low: "#64748B",
    medium: "#0369A1",
    high: "#B45309",
    critical: "#B91C1C",
  };
  return (
    <span
      style={{
        color: palette[r],
        fontWeight: 600,
        fontSize: 12,
        textTransform: "capitalize",
      }}
    >
      {r}
    </span>
  );
}

async function auditExport(args: {
  organizationId: string;
  tab: ExecutiveTab;
  filters: Record<string, string>;
  rows: Row[];
}) {
  try {
    await fetch(`/api/billing/executive-priority/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId: args.organizationId,
        tab: args.tab,
        filters: args.filters,
        rowCount: args.rows.length,
        totalDollars: args.rows.reduce((s, r) => s + r.balance, 0),
        claimIds: args.rows.map((r) => r.claimId),
      }),
    });
  } catch {
    // The CSV is already on the user's machine; audit failure shouldn't
    // surface as a user-facing error.
  }
}

function downloadCsv(rows: Row[], tab: ExecutiveTab) {
  const headers = [
    "Priority",
    "Practice",
    "Client",
    "Payer",
    "Claim ID",
    "Balance",
    "Age (days)",
    "Issue type",
    "Assigned to",
    "Due date",
    "Financial risk",
  ];
  const escape = (v: unknown) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.priority,
        r.practiceName,
        r.clientName,
        r.payerName,
        r.claimNumber,
        r.balance.toFixed(2),
        r.ageDays ?? "",
        r.issueType,
        r.assignedToName ?? "Unassigned",
        r.dueDate ?? "",
        r.financialRisk,
      ]
        .map(escape)
        .join(","),
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `executive-priority-${tab}-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Modals ────────────────────────────────────────────────────────────────

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
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function ExecutivePriorityClient() {
  const def = getWorkqueue("executive_priority");
  const [organizationId] = useState(() => getOrganizationId());
  const [tab, setTab] = useState<ExecutiveTab>("high_dollar");
  const [rows, setRows] = useState<Row[]>([]);
  const [metrics, setMetrics] = useState<ApiResponse["metrics"] | null>(null);
  const [filterOptions, setFilterOptions] = useState<
    ApiResponse["filterOptions"]
  >({ payers: [], clients: [], assignees: [] });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});

  // Modal state
  const [assignFor, setAssignFor] = useState<Row | null>(null);
  const [assignPicked, setAssignPicked] = useState<string>("");
  const [escalateFor, setEscalateFor] = useState<Row | null>(null);
  const [escalateReason, setEscalateReason] = useState<string>("");
  const [noteFor, setNoteFor] = useState<Row | null>(null);
  const [noteBody, setNoteBody] = useState<string>("");
  const [noteResolvedDenial, setNoteResolvedDenial] = useState<boolean>(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (nextTab: ExecutiveTab, nextFilters: Record<string, string>) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("organizationId", organizationId);
        params.set("tab", nextTab);
        for (const [k, v] of Object.entries(nextFilters)) {
          const t = String(v ?? "").trim();
          if (t) params.set(k, t);
        }
        const res = await fetch(`/api/billing/executive-priority?${params.toString()}`);
        const json: ApiResponse = await res.json();
        if (!res.ok || json.success === false) {
          throw new Error(json.error || "Failed to load");
        }
        setRows(json.rows ?? []);
        setMetrics(json.metrics ?? null);
        setFilterOptions(
          json.filterOptions ?? { payers: [], clients: [], assignees: [] },
        );
      } catch (e) {
        setMessage({
          tone: "error",
          text: e instanceof Error ? e.message : "Failed to load",
        });
      } finally {
        setLoading(false);
      }
    },
    [organizationId],
  );

  // Re-fetch on tab OR filter change so the universal filter rail is
  // honored server-side (no client-side filtering of a truncated window).
  useEffect(() => {
    void load(tab, filterValues);
  }, [tab, filterValues, load]);

  // The server already filters + sorts + tab-cuts; show its rows directly.
  const filteredRows = rows;

  // Derive header metrics from the visible rows so the strip stays honest.
  const summary: SummaryMetric[] = useMemo(() => {
    const totalDollars = filteredRows.reduce((s, r) => s + r.balance, 0);
    const oldest = filteredRows.reduce<number>(
      (m, r) => Math.max(m, r.ageDays ?? 0),
      0,
    );
    const urgent = filteredRows.filter(
      (r) => r.priority === "urgent" || r.financialRisk === "critical",
    ).length;
    return [
      { id: "count", label: "Total claims", value: filteredRows.length },
      { id: "dollars", label: "Outstanding", value: fmtMoney(totalDollars) },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: oldest,
        tone: oldest > 120 ? "red" : oldest > 60 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: urgent,
        tone: urgent > 0 ? "red" : "default",
      },
    ];
  }, [filteredRows]);

  // ─── Filter rail (universal) ─────────────────────────────────────────────
  const filters: FilterDef[] = useMemo(() => {
    const assigneeOpts = [
      { value: "__unassigned__", label: "— Unassigned —" },
      ...(filterOptions?.assignees ?? []),
    ];
    return [
      { id: "practice", label: "Practice", kind: "text", width: 140 },
      { id: "clinician", label: "Clinician/Assignee", kind: "text", width: 160 },
      {
        id: "payer",
        label: "Payer",
        kind: "select",
        options: filterOptions?.payers ?? [],
        width: 160,
      },
      {
        id: "client",
        label: "Client",
        kind: "select",
        options: filterOptions?.clients ?? [],
        width: 160,
      },
      { id: "dosFrom", label: "DOS from", kind: "date", width: 130 },
      { id: "dosTo", label: "DOS to", kind: "date", width: 130 },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "submitted", label: "Submitted" },
          { value: "accepted_oa", label: "Accepted (clearinghouse)" },
          { value: "accepted_payer", label: "Accepted (payer)" },
          { value: "rejected_oa", label: "Rejected (clearinghouse)" },
          { value: "rejected_payer", label: "Rejected (payer)" },
          { value: "denied", label: "Denied" },
          { value: "validation_failed", label: "Validation failed" },
        ],
        width: 160,
      },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "select",
        options: assigneeOpts,
        width: 160,
      },
      { id: "minAmount", label: "Min $", kind: "number", width: 90 },
      { id: "maxAmount", label: "Max $", kind: "number", width: 90 },
      {
        id: "agingBucket",
        label: "Aging",
        kind: "select",
        options: [
          { value: "0_30", label: "0–30" },
          { value: "31_60", label: "31–60" },
          { value: "61_90", label: "61–90" },
          { value: "91_120", label: "91–120" },
          { value: "120_plus", label: "120+" },
        ],
        width: 110,
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", width: 110 },
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
        width: 110,
      },
      { id: "followUpDue", label: "Follow-up by", kind: "date", width: 130 },
    ];
  }, [filterOptions]);

  // ─── Columns (exact spec labels) ─────────────────────────────────────────
  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      { id: "priority", header: "Priority", cell: (r) => priorityBadge(r.priority), width: 90 },
      { id: "practice", header: "Practice", cell: (r) => r.practiceName, width: 140 },
      { id: "client", header: "Client", cell: (r) => r.clientName, width: 160 },
      { id: "payer", header: "Payer", cell: (r) => r.payerName, width: 160 },
      {
        id: "claimId",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.claimNumber}
          </span>
        ),
        width: 130,
      },
      {
        id: "balance",
        header: "Balance",
        cell: (r) => fmtMoney(r.balance),
        align: "right",
        width: 100,
      },
      {
        id: "age",
        header: "Age",
        cell: (r) => (r.ageDays != null ? `${r.ageDays}d` : "—"),
        align: "right",
        width: 70,
      },
      { id: "issueType", header: "Issue type", cell: (r) => r.issueType, width: 160 },
      {
        id: "assignedTo",
        header: "Assigned to",
        cell: (r) =>
          r.assignedToName ? (
            <span>{r.assignedToName}</span>
          ) : (
            <span style={{ color: "#94A3B8", fontStyle: "italic" }}>Unassigned</span>
          ),
        width: 140,
      },
      { id: "dueDate", header: "Due date", cell: (r) => fmtDate(r.dueDate), width: 110 },
      {
        id: "financialRisk",
        header: "Financial risk",
        cell: (r) => riskBadge(r.financialRisk),
        width: 110,
      },
    ],
    [],
  );

  // ─── Row & detail actions ────────────────────────────────────────────────
  const openClaim = useCallback((row: Row) => {
    const href = `/billing/claim-submission?claim=${encodeURIComponent(row.claimId)}`;
    window.open(href, "_blank", "noopener");
  }, []);

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      { id: "assign", label: "Assign", onClick: (r) => { setAssignFor(r); setAssignPicked(r.assignedToId ?? ""); } },
      { id: "escalate", label: "Escalate", variant: "danger", onClick: (r) => { setEscalateFor(r); setEscalateReason(""); }, disabled: (r) => r.priority === "urgent" },
      { id: "open", label: "Open claim", onClick: openClaim },
    ],
    [openClaim],
  );

  const selected = useMemo(
    () => filteredRows.find((r) => r.id === selectedRowId) ?? null,
    [filteredRows, selectedRowId],
  );

  const exportList = useCallback(() => {
    downloadCsv(filteredRows, tab);
    void auditExport({ organizationId, tab, filters: filterValues, rows: filteredRows });
  }, [filteredRows, tab, organizationId, filterValues]);

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selected) return [];
    return [
      { id: "assign", label: "Assign", onClick: () => { setAssignFor(selected); setAssignPicked(selected.assignedToId ?? ""); } },
      { id: "escalate", label: "Escalate", variant: "danger", onClick: () => { setEscalateFor(selected); setEscalateReason(""); }, disabled: selected.priority === "urgent" },
      { id: "open", label: "Open claim", onClick: () => openClaim(selected) },
      { id: "note", label: "Add executive note", variant: "primary", onClick: () => { setNoteFor(selected); setNoteBody(""); setNoteResolvedDenial(false); } },
      { id: "export", label: "Export list", onClick: exportList },
    ];
  }, [selected, openClaim, exportList]);

  // Header-level export so it's reachable even with no row selected.
  const headerActions: PrimaryAction[] = useMemo(
    () => [
      { id: "refresh", label: "Refresh", onClick: () => void load(tab, filterValues) },
      {
        id: "export",
        label: "Export list",
        onClick: exportList,
        disabled: filteredRows.length === 0,
      },
    ],
    [load, tab, filterValues, filteredRows, exportList],
  );

  // ─── Detail panel sections (exact spec labels) ───────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "summary",
        label: "Claim summary",
        render: () => (selected ? <ClaimSummary row={selected} /> : null),
      },
      {
        id: "reason",
        label: "Reason for priority",
        render: () => (selected ? <ReasonSection row={selected} /> : null),
      },
      {
        id: "timeline",
        label: "Timeline",
        render: () => (selected ? <TimelineSection row={selected} /> : null),
      },
      {
        id: "notes",
        label: "Assigned staff notes",
        render: () => (selected ? <NotesSection row={selected} /> : null),
      },
      {
        id: "next",
        label: "Recommended next action",
        render: () => (selected ? <RecommendedSection row={selected} /> : null),
      },
    ],
    [selected],
  );

  // ─── Mutations ───────────────────────────────────────────────────────────
  const optimisticPatch = useCallback((patch: Partial<Row> & { id: string }) => {
    setRows((prev) => prev.map((r) => (r.id === patch.id ? { ...r, ...patch } : r)));
  }, []);

  async function submitAssign() {
    if (!assignFor) return;
    setSaving(true);
    const claimId = assignFor.id;
    const previous = rows.find((r) => r.id === claimId);
    if (!previous) {
      setSaving(false);
      return;
    }
    const newAssigneeId = assignPicked || null;
    const newAssigneeName = newAssigneeId
      ? (filterOptions?.assignees ?? []).find((a) => a.value === newAssigneeId)
          ?.label ?? "Biller"
      : null;
    // Optimistic apply
    optimisticPatch({
      id: claimId,
      assignedToId: newAssigneeId,
      assignedToName: newAssigneeName,
    });
    setAssignFor(null);
    try {
      const res = await fetch(
        `/api/billing/executive-priority/${claimId}/assign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            assigneeId: newAssigneeId,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || json.success === false) {
        throw new Error(json.error || "Assign failed");
      }
      // Reconcile from server (in case names differ).
      optimisticPatch({
        id: claimId,
        assignedToId: json.assigneeId ?? null,
        assignedToName: json.assigneeName ?? null,
      });
      setMessage({
        tone: "success",
        text: newAssigneeId
          ? `Assigned to ${json.assigneeName ?? newAssigneeName ?? "biller"}.`
          : "Cleared assignment.",
      });
    } catch (e) {
      // Rollback
      optimisticPatch({
        id: claimId,
        assignedToId: previous.assignedToId,
        assignedToName: previous.assignedToName,
      });
      setMessage({
        tone: "error",
        text: e instanceof Error ? e.message : "Assign failed",
      });
    } finally {
      setSaving(false);
    }
  }

  async function submitEscalate() {
    if (!escalateFor) return;
    setSaving(true);
    const claimId = escalateFor.id;
    const previous = rows.find((r) => r.id === claimId);
    if (!previous) {
      setSaving(false);
      return;
    }
    // Optimistic apply
    optimisticPatch({ id: claimId, priority: "urgent" });
    const reasonSnapshot = escalateReason;
    setEscalateFor(null);
    try {
      const res = await fetch(
        `/api/billing/executive-priority/${claimId}/escalate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            priority: "urgent",
            reason: reasonSnapshot || undefined,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || json.success === false) {
        throw new Error(json.error || "Escalate failed");
      }
      setMessage({ tone: "success", text: "Claim escalated to urgent." });
    } catch (e) {
      // Rollback
      optimisticPatch({ id: claimId, priority: previous.priority });
      setMessage({
        tone: "error",
        text: e instanceof Error ? e.message : "Escalate failed",
      });
    } finally {
      setSaving(false);
    }
  }

  async function submitNote() {
    if (!noteFor) return;
    const body = noteBody.trim();
    if (!body) {
      setMessage({ tone: "error", text: "Note body is required." });
      return;
    }
    setSaving(true);
    const claimId = noteFor.id;
    const tempId = `local-${Date.now()}`;
    const optimisticNote = {
      id: tempId,
      body: `[Executive] ${body}`,
      author: "You (saving…)",
      createdAt: new Date().toISOString(),
      isExecutive: true,
    };
    // Optimistic prepend
    setRows((prev) =>
      prev.map((r) =>
        r.id === claimId ? { ...r, notes: [optimisticNote, ...r.notes] } : r,
      ),
    );
    const resolvedDenialSnapshot = noteResolvedDenial;
    setNoteFor(null);
    setNoteBody("");
    setNoteResolvedDenial(false);
    try {
      const res = await fetch(`/api/billing/claims/${claimId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          body: `[Executive] ${body}`,
          resolved_denial: resolvedDenialSnapshot,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        throw new Error(json.error || "Failed to save note");
      }
      const inserted = json.note ?? {};
      const confirmed = {
        id: String(inserted.id ?? tempId),
        body: String(inserted.body ?? `[Executive] ${body}`),
        author: String(inserted.author_display_name ?? "Executive"),
        createdAt: String(inserted.created_at ?? optimisticNote.createdAt),
        isExecutive: true,
      };
      // Replace the optimistic placeholder with the confirmed note.
      setRows((prev) =>
        prev.map((r) =>
          r.id === claimId
            ? {
                ...r,
                notes: r.notes.map((n) => (n.id === tempId ? confirmed : n)),
              }
            : r,
        ),
      );
      setMessage({ tone: "success", text: "Executive note added." });
    } catch (e) {
      // Rollback the optimistic note.
      setRows((prev) =>
        prev.map((r) =>
          r.id === claimId
            ? { ...r, notes: r.notes.filter((n) => n.id !== tempId) }
            : r,
        ),
      );
      setMessage({
        tone: "error",
        text: e instanceof Error ? e.message : "Failed to save note",
      });
    } finally {
      setSaving(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      {/* Tab strip */}
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "12px 24px 0",
          borderBottom: "1px solid #E2E8F0",
          background: "#F8FAFC",
          flexWrap: "wrap",
        }}
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              style={{
                background: active ? "#fff" : "transparent",
                border: "1px solid #E2E8F0",
                borderBottom: active ? "1px solid #fff" : "1px solid #E2E8F0",
                borderRadius: "6px 6px 0 0",
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                color: active ? "#0F172A" : "#475569",
                cursor: "pointer",
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <WorkqueueShell<Row>
        title={def?.title ?? "Executive / Priority"}
        description={def?.description}
        headerActions={headerActions}
        summary={summary}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`exec_${tab}`}
        rows={filteredRows}
        columns={columns}
        rowId={(r) => r.id}
        loading={loading}
        emptyMessage="No claims match this tab and filter set."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        rowActions={rowActions}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {/* Assign modal */}
      {assignFor ? (
        <ModalShell
          title={`Assign — ${assignFor.clientName} (${assignFor.claimNumber})`}
          onClose={() => setAssignFor(null)}
        >
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            Assignee
          </label>
          <select
            value={assignPicked}
            onChange={(e) => setAssignPicked(e.target.value)}
            style={{
              width: "100%",
              padding: 8,
              border: "1px solid #D1D5DB",
              borderRadius: 4,
              fontFamily: "inherit",
            }}
          >
            <option value="">— Unassigned —</option>
            {(filterOptions?.assignees ?? []).map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 16,
            }}
          >
            <button
              type="button"
              onClick={() => setAssignFor(null)}
              style={{
                padding: "6px 14px",
                border: "1px solid #D1D5DB",
                borderRadius: 4,
                background: "#fff",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitAssign}
              disabled={saving}
              style={{
                padding: "6px 14px",
                border: "none",
                borderRadius: 4,
                background: "#0F172A",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </ModalShell>
      ) : null}

      {/* Escalate modal */}
      {escalateFor ? (
        <ModalShell
          title={`Escalate — ${escalateFor.clientName} (${escalateFor.claimNumber})`}
          onClose={() => setEscalateFor(null)}
        >
          <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
            Mark this claim as <strong>urgent</strong> in the workqueue.
          </p>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            Reason (optional)
          </label>
          <textarea
            value={escalateReason}
            onChange={(e) => setEscalateReason(e.target.value)}
            rows={4}
            placeholder="Why this needs to jump the queue…"
            style={{
              width: "100%",
              padding: 8,
              border: "1px solid #D1D5DB",
              borderRadius: 4,
              fontFamily: "inherit",
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 16,
            }}
          >
            <button
              type="button"
              onClick={() => setEscalateFor(null)}
              style={{
                padding: "6px 14px",
                border: "1px solid #D1D5DB",
                borderRadius: 4,
                background: "#fff",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitEscalate}
              disabled={saving}
              style={{
                padding: "6px 14px",
                border: "none",
                borderRadius: 4,
                background: "#B91C1C",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              {saving ? "Saving…" : "Escalate"}
            </button>
          </div>
        </ModalShell>
      ) : null}

      {/* Executive note modal */}
      {noteFor ? (
        <ModalShell
          title={`Add executive note — ${noteFor.clientName} (${noteFor.claimNumber})`}
          onClose={() => setNoteFor(null)}
        >
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            Note
          </label>
          <textarea
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
            rows={6}
            placeholder="Visible on the claim timeline, prefixed [Executive]…"
            style={{
              width: "100%",
              padding: 8,
              border: "1px solid #D1D5DB",
              borderRadius: 4,
              fontFamily: "inherit",
            }}
          />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              marginTop: 12,
            }}
          >
            <input
              type="checkbox"
              checked={noteResolvedDenial}
              onChange={(e) => setNoteResolvedDenial(e.target.checked)}
            />
            This note resolved the denial
          </label>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 16,
            }}
          >
            <button
              type="button"
              onClick={() => setNoteFor(null)}
              style={{
                padding: "6px 14px",
                border: "1px solid #D1D5DB",
                borderRadius: 4,
                background: "#fff",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitNote}
              disabled={saving}
              style={{
                padding: "6px 14px",
                border: "none",
                borderRadius: 4,
                background: "#0F172A",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              {saving ? "Saving…" : "Save note"}
            </button>
          </div>
        </ModalShell>
      ) : null}
    </>
  );
}

// ─── Detail panel sections ─────────────────────────────────────────────────

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "6px 0",
        borderBottom: "1px dashed #E2E8F0",
        fontSize: 13,
      }}
    >
      <span style={{ color: "#64748B" }}>{label}</span>
      <span style={{ color: "#0F172A", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function ClaimSummary({ row }: { row: Row }) {
  return (
    <div>
      <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Claim summary</h3>
      <KV label="Claim #" value={row.claimNumber} />
      <KV label="Client" value={row.clientName} />
      <KV label="Practice" value={row.practiceName} />
      <KV label="Payer" value={row.payerName} />
      <KV label="DOS" value={fmtDate(row.serviceDateFrom)} />
      <KV label="Balance" value={fmtMoney(row.balance)} />
      <KV label="Age" value={row.ageDays != null ? `${row.ageDays} days` : "—"} />
      <KV label="Status" value={row.claimStatus.replace(/_/g, " ")} />
      <KV label="Priority" value={priorityBadge(row.priority)} />
      <KV label="Financial risk" value={riskBadge(row.financialRisk)} />
      <KV label="Assigned to" value={row.assignedToName ?? "Unassigned"} />
      <KV label="Due date" value={fmtDate(row.dueDate)} />
      {row.appealDeadline ? (
        <KV label="Appeal deadline" value={fmtDate(row.appealDeadline)} />
      ) : null}
      {row.carcCode || row.rarcCode ? (
        <KV
          label="CARC / RARC"
          value={`${row.carcCode ?? "—"} / ${row.rarcCode ?? "—"}`}
        />
      ) : null}
    </div>
  );
}

function ReasonSection({ row }: { row: Row }) {
  return (
    <div>
      <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Reason for priority</h3>
      <p style={{ fontSize: 13, color: "#0F172A", lineHeight: 1.5 }}>
        {row.reasonForPriority}
      </p>
      {row.denialReason ? (
        <>
          <h4 style={{ margin: "12px 0 4px", fontSize: 13, color: "#334155" }}>
            Denial reason
          </h4>
          <p style={{ fontSize: 13, color: "#0F172A" }}>{row.denialReason}</p>
        </>
      ) : null}
    </div>
  );
}

function TimelineSection({ row }: { row: Row }) {
  if (row.timeline.length === 0) {
    return <p style={{ fontSize: 13, color: "#64748B" }}>No events recorded.</p>;
  }
  return (
    <div>
      <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Timeline</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {row.timeline.map((e) => (
          <li
            key={e.id}
            style={{
              padding: "8px 0",
              borderBottom: "1px solid #F1F5F9",
              fontSize: 13,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontWeight: 600,
              }}
            >
              <span style={{ textTransform: "capitalize" }}>{e.label}</span>
              <span style={{ color: "#64748B", fontWeight: 400, fontSize: 12 }}>
                {fmtDateTime(e.at)}
              </span>
            </div>
            {e.detail ? (
              <div style={{ color: "#475569", marginTop: 2 }}>{e.detail}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotesSection({ row }: { row: Row }) {
  if (row.notes.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "#64748B" }}>
        No notes yet. Use “Add executive note” below to record context.
      </p>
    );
  }
  return (
    <div>
      <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Assigned staff notes</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {row.notes.map((n) => (
          <li
            key={n.id}
            style={{
              padding: 10,
              marginBottom: 8,
              background: n.isExecutive ? "#FEF3C7" : "#F8FAFC",
              border: "1px solid #E2E8F0",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 4,
                fontSize: 12,
                color: "#64748B",
              }}
            >
              <span style={{ fontWeight: 600, color: "#334155" }}>{n.author}</span>
              <span>{fmtDateTime(n.createdAt)}</span>
            </div>
            <div style={{ whiteSpace: "pre-wrap", color: "#0F172A" }}>{n.body}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecommendedSection({ row }: { row: Row }) {
  return (
    <div>
      <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Recommended next action</h3>
      <div
        style={{
          padding: 12,
          background: "#ECFDF5",
          border: "1px solid #A7F3D0",
          borderRadius: 6,
          fontSize: 13,
          color: "#064E3B",
          lineHeight: 1.5,
        }}
      >
        {row.recommendedAction}
      </div>
      <p style={{ marginTop: 12, fontSize: 12, color: "#64748B" }}>
        Use the action buttons below to assign a biller, escalate the claim,
        open it in the claim editor, or record an executive note.
      </p>
    </div>
  );
}
