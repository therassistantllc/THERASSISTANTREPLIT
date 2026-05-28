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

// ── Types ─────────────────────────────────────────────────────────────────

type TabId =
  | "today"
  | "awaiting_999"
  | "awaiting_277ca"
  | "awaiting_payer"
  | "no_response_risk";

type Row = {
  id: string;
  claimNumber: string;
  patientId: string;
  patientName: string;
  payerProfileId: string;
  payerName: string;
  payerId: string;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  submittedAt: string | null;
  batchId: string | null;
  batchNumber: string | null;
  batchStatus: string | null;
  clearinghouseStatus: string;
  claimStatus: string;
  daysSinceSubmission: number | null;
  chargeAmount: number;
  nextExpectedResponse: string | null;
  hasNoResponseFlag: boolean;
  tab: TabId;
  cptCodes: string[];
};

type FilterOption = { value: string; label: string };

type ListPayload = {
  success: boolean;
  error?: string;
  organizationId?: string;
  summary?: { total: number; totalDollars: number; oldestAge: number; urgentCount: number };
  tabCounts?: Record<TabId, number>;
  filterOptions?: {
    practices?: FilterOption[];
    clinicians?: FilterOption[];
    billers?: FilterOption[];
  };
  rows?: Row[];
  pagination?: { offset: number; limit: number; hasMore: boolean; totalLoaded: number };
};

type Acknowledgement = {
  id: string;
  acknowledgement_type: string;
  file_name: string | null;
  raw_content: string | null;
  parsed_content: unknown;
  created_at: string;
};

type SubmissionHistoryEntry = {
  id: string;
  status: string;
  status_message: string | null;
  source: string;
  created_at: string;
};

type StatusHistoryResponse = {
  success?: boolean;
  events?: SubmissionHistoryEntry[];
  error?: string;
};

const TABS: { id: TabId; label: string }[] = [
  { id: "today", label: "Submitted Today" },
  { id: "awaiting_999", label: "Awaiting 999" },
  { id: "awaiting_277ca", label: "Awaiting 277CA" },
  { id: "awaiting_payer", label: "Awaiting Payer Response" },
  { id: "no_response_risk", label: "No Response Risk" },
];

const SERVER_FILTER_KEYS = [
  "payer",
  "client",
  "status",
  "dosFrom",
  "dosTo",
  "minAmount",
  "maxAmount",
  "agingBucket",
  "priority",
  "followUpDue",
  "practice",
  "clinician",
  "assignedBiller",
  "carcRarc",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────

function getOrganizationId(): string {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

function dosLabel(row: Row): string {
  if (!row.serviceDateFrom) return "—";
  if (row.serviceDateTo && row.serviceDateTo !== row.serviceDateFrom) {
    return `${fmtDate(row.serviceDateFrom)} – ${fmtDate(row.serviceDateTo)}`;
  }
  return fmtDate(row.serviceDateFrom);
}

// ── Note modal ────────────────────────────────────────────────────────────

function NoteModal({
  row,
  onClose,
  onSaved,
  organizationId,
}: {
  row: Row;
  onClose: () => void;
  onSaved: (message: string) => void;
  organizationId: string;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!body.trim()) {
      setError("Note text is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/submitted-claims/${encodeURIComponent(row.id)}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, action: "add_note", note: body.trim() }),
        },
      );
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error ?? "Failed to save note");
      }
      onSaved(`Note saved on claim ${row.claimNumber}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save note");
    } finally {
      setSaving(false);
    }
  }

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
          width: 520,
          maxWidth: "92vw",
          borderRadius: 8,
          padding: 24,
          boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
        }}
      >
        <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>
          Add note — {row.patientName}
        </h2>
        <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
          Claim {row.claimNumber} · {row.payerName}
        </p>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Add details for the audit trail…"
          style={{
            width: "100%",
            padding: 8,
            border: "1px solid #D1D5DB",
            borderRadius: 4,
            fontFamily: "inherit",
          }}
        />
        {error ? (
          <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div>
        ) : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button type="button" className="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Detail kv row ─────────────────────────────────────────────────────────

function KV({ label, value }: { label: string; value: React.ReactNode }) {
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

// ── Toast ─────────────────────────────────────────────────────────────────

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

// ── Component ─────────────────────────────────────────────────────────────

const queueDef = getWorkqueue("submitted_claims");

export default function SubmittedClaimsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<TabId, number>>({
    today: 0,
    awaiting_999: 0,
    awaiting_277ca: 0,
    awaiting_payer: 0,
    no_response_risk: 0,
  });
  const [summary, setSummary] = useState<{
    total: number;
    totalDollars: number;
    oldestAge: number;
    urgentCount: number;
  }>({ total: 0, totalDollars: 0, oldestAge: 0, urgentCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("today");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [noteRow, setNoteRow] = useState<Row | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const PAGE_SIZE = 200;
  const [offset, setOffset] = useState(0);

  const [acks999, setAcks999] = useState<Acknowledgement[]>([]);
  const [acks277, setAcks277] = useState<Acknowledgement[]>([]);
  const [statusHistory, setStatusHistory] = useState<SubmissionHistoryEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // Discovered options from the loaded page (used to populate select filters).
  const [payerOptionsState, setPayerOptionsState] = useState<Map<string, string>>(
    new Map(),
  );
  const [statusOptionsState, setStatusOptionsState] = useState<Set<string>>(new Set());
  const [practiceOptions, setPracticeOptions] = useState<FilterOption[]>([]);
  const [clinicianOptions, setClinicianOptions] = useState<FilterOption[]>([]);
  const [billerOptions, setBillerOptions] = useState<FilterOption[]>([]);

  const buildQuery = useCallback(
    (tab: TabId, values: Record<string, string>, pageOffset: number) => {
      const params = new URLSearchParams();
      params.set("organizationId", organizationId);
      params.set("tab", tab);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(pageOffset));
      for (const key of SERVER_FILTER_KEYS) {
        const v = values[key];
        if (v && v.length > 0) params.set(key, v);
      }
      return params.toString();
    },
    [organizationId],
  );

  const load = useCallback(
    async (
      tab: TabId,
      values: Record<string, string>,
      pageOffset: number,
    ) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/billing/submitted-claims?${buildQuery(tab, values, pageOffset)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as ListPayload;
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Failed to load submitted claims");
        }
        setRows(json.rows ?? []);
        setSummary(
          json.summary ?? { total: 0, totalDollars: 0, oldestAge: 0, urgentCount: 0 },
        );
        setTabCounts(
          json.tabCounts ?? {
            today: 0,
            awaiting_999: 0,
            awaiting_277ca: 0,
            awaiting_payer: 0,
            no_response_risk: 0,
          },
        );
        setHasMore(Boolean(json.pagination?.hasMore));
        if (json.filterOptions) {
          if (Array.isArray(json.filterOptions.practices))
            setPracticeOptions(json.filterOptions.practices);
          if (Array.isArray(json.filterOptions.clinicians))
            setClinicianOptions(json.filterOptions.clinicians);
          if (Array.isArray(json.filterOptions.billers))
            setBillerOptions(json.filterOptions.billers);
        }
        // Expand option pools as we see new values.
        setPayerOptionsState((prev) => {
          const next = new Map(prev);
          for (const r of json.rows ?? []) if (r.payerName) next.set(r.payerName, r.payerName);
          return next;
        });
        setStatusOptionsState((prev) => {
          const next = new Set(prev);
          for (const r of json.rows ?? []) if (r.claimStatus) next.add(r.claimStatus);
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load submitted claims");
      } finally {
        setLoading(false);
      }
    },
    [buildQuery],
  );

  useEffect(() => {
    void load(activeTab, filterValues, offset);
  }, [load, activeTab, filterValues, offset]);

  // Reset paging when tab or filters change.
  useEffect(() => {
    setOffset(0);
  }, [activeTab, filterValues]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  useEffect(() => {
    if (!selectedRow) {
      setAcks999([]);
      setAcks277([]);
      setStatusHistory([]);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    const ackUrl = (type: "999" | "277CA") =>
      selectedRow.batchId
        ? `/api/claims/837p/batch/${encodeURIComponent(selectedRow.batchId)}/acknowledgements?organizationId=${encodeURIComponent(organizationId)}&type=${type}`
        : null;
    const histUrl = `/api/billing/submitted-claims/${encodeURIComponent(selectedRow.id)}/history?organizationId=${encodeURIComponent(organizationId)}`;
    Promise.all([
      ackUrl("999")
        ? fetch(ackUrl("999")!, { cache: "no-store" }).then((r) => r.json()).catch(() => null)
        : Promise.resolve(null),
      ackUrl("277CA")
        ? fetch(ackUrl("277CA")!, { cache: "no-store" }).then((r) => r.json()).catch(() => null)
        : Promise.resolve(null),
      fetch(histUrl, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]).then(([a999, a277, hist]) => {
      if (cancelled) return;
      const ack999List =
        a999 && Array.isArray(a999.acknowledgements) ? (a999.acknowledgements as Acknowledgement[]) : [];
      const ack277List =
        a277 && Array.isArray(a277.acknowledgements) ? (a277.acknowledgements as Acknowledgement[]) : [];
      const histPayload = (hist as StatusHistoryResponse) || {};
      setAcks999(ack999List);
      setAcks277(ack277List);
      setStatusHistory(
        Array.isArray(histPayload.events) ? histPayload.events : [],
      );
      setDetailLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRow, organizationId]);

  // ── Filters ────────────────────────────────────────────────────────────
  const payerOptions = useMemo(
    () =>
      Array.from(payerOptionsState.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, label]) => ({ value, label })),
    [payerOptionsState],
  );

  const statusOptions = useMemo(
    () =>
      Array.from(statusOptionsState)
        .sort()
        .map((s) => ({ value: s, label: s })),
    [statusOptionsState],
  );

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "select", options: practiceOptions },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicianOptions },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Client name…" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      { id: "status", label: "Claim status", kind: "select", options: statusOptions },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "select",
        options: billerOptions,
      },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Aging",
        kind: "select",
        options: [
          { value: "0-30", label: "0-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "61-90", label: "61-90 days" },
          { value: "90+", label: "90+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 197" },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [{ value: "urgent", label: "Urgent" }],
      },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [practiceOptions, clinicianOptions, payerOptions, statusOptions, billerOptions],
  );

  // ── Summary metrics (queue-wide, from server) ──────────────────────────
  const summaryMetrics: SummaryMetric[] = useMemo(
    () => [
      { id: "count", label: "Total claims", value: summary.total.toLocaleString() },
      {
        id: "dollars",
        label: "Total $ in flight",
        value: fmtMoney(summary.totalDollars),
        tone: summary.totalDollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: summary.oldestAge,
        tone: summary.oldestAge > 30 ? "red" : summary.oldestAge > 14 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent (≥14d / flagged)",
        value: summary.urgentCount,
        tone: summary.urgentCount > 0 ? "red" : "default",
      },
    ],
    [summary],
  );

  const primaryTabs = useMemo(
    () => TABS.map((t) => ({ id: t.id, label: t.label, count: tabCounts[t.id] ?? 0 })),
    [tabCounts],
  );

  // ── Columns ────────────────────────────────────────────────────────────
  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      {
        id: "claimId",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.claimNumber}</span>
        ),
      },
      { id: "client", header: "Client", cell: (r) => r.patientName },
      {
        id: "payer",
        header: "Payer",
        cell: (r) => (
          <>
            {r.payerName}
            {r.payerId ? (
              <div style={{ fontSize: 11, color: "#6B7280" }}>ID: {r.payerId}</div>
            ) : null}
          </>
        ),
      },
      { id: "dos", header: "DOS", cell: (r) => dosLabel(r) },
      { id: "submitted", header: "Submitted date", cell: (r) => fmtDate(r.submittedAt) },
      {
        id: "batch",
        header: "Batch ID",
        cell: (r) =>
          r.batchNumber ? (
            <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
              {r.batchNumber}
            </span>
          ) : (
            "—"
          ),
      },
      {
        id: "clearinghouse",
        header: "Clearinghouse status",
        cell: (r) => <span style={{ fontSize: 12, color: "#0F172A" }}>{r.clearinghouseStatus}</span>,
      },
      {
        id: "days",
        header: "Days since submission",
        align: "right",
        cell: (r) =>
          r.daysSinceSubmission == null ? "—" : (
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                color:
                  r.daysSinceSubmission >= 14
                    ? "#B91C1C"
                    : r.daysSinceSubmission >= 7
                    ? "#B45309"
                    : "#0F172A",
                fontWeight: r.daysSinceSubmission >= 14 ? 600 : 400,
              }}
            >
              {r.daysSinceSubmission}
            </span>
          ),
      },
      {
        id: "charge",
        header: "Charge amount",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMoney(r.chargeAmount)}</span>
        ),
      },
      {
        id: "next",
        header: "Next expected response",
        cell: (r) => fmtDate(r.nextExpectedResponse),
      },
    ],
    [],
  );

  // ── Actions ────────────────────────────────────────────────────────────
  const runAction = useCallback(
    async (
      row: Row,
      action: "check_status" | "request_update" | "move_to_no_response" | "resubmit",
      successMessage: string,
    ) => {
      setBusyAction(`${row.id}:${action}`);
      try {
        const res = await fetch(
          `/api/billing/submitted-claims/${encodeURIComponent(row.id)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organizationId, action }),
          },
        );
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Action failed");
        }
        setRows((prev) =>
          prev.map((r) => {
            if (r.id !== row.id) return r;
            if (action === "move_to_no_response") {
              return { ...r, hasNoResponseFlag: true, tab: "no_response_risk" };
            }
            if (action === "resubmit") {
              return {
                ...r,
                claimStatus: "ready_for_validation",
                clearinghouseStatus: "Resubmission pending",
              };
            }
            return r;
          }),
        );
        if (selectedRowId === row.id) {
          fetch(
            `/api/billing/submitted-claims/${encodeURIComponent(row.id)}/history?organizationId=${encodeURIComponent(organizationId)}`,
            { cache: "no-store" },
          )
            .then((r) => r.json())
            .then((j: StatusHistoryResponse) => {
              if (Array.isArray(j?.events)) setStatusHistory(j.events);
            })
            .catch(() => {});
        }
        setToast(successMessage);
        // Re-pull the queue so counts / bucketing reflect the action.
        void load(activeTab, filterValues, offset);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusyAction(null);
      }
    },
    [organizationId, selectedRowId, load, activeTab, filterValues, offset],
  );

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      {
        id: "check",
        label: "Check status",
        onClick: (r) => void runAction(r, "check_status", `Status check logged for ${r.claimNumber}`),
        disabled: (r) => busyAction === `${r.id}:check_status`,
      },
      {
        id: "request",
        label: "Request update",
        onClick: (r) => void runAction(r, "request_update", `Update requested for ${r.claimNumber}`),
        disabled: (r) => busyAction === `${r.id}:request_update`,
      },
      {
        id: "no-response",
        label: "Move to no response",
        onClick: (r) =>
          void runAction(r, "move_to_no_response", `${r.claimNumber} moved to No Response Risk`),
        disabled: (r) =>
          r.hasNoResponseFlag || busyAction === `${r.id}:move_to_no_response`,
      },
      { id: "note", label: "Add note", onClick: (r) => setNoteRow(r) },
      {
        id: "resubmit",
        label: "Resubmit if needed",
        variant: "primary",
        onClick: (r) => void runAction(r, "resubmit", `${r.claimNumber} marked for resubmission`),
        disabled: (r) => busyAction === `${r.id}:resubmit`,
      },
    ],
    [busyAction, runAction],
  );

  // ── Detail panel tabs ─────────────────────────────────────────────────
  const detailTabs: DetailTab[] = useMemo(() => {
    if (!selectedRow) return [];
    return [
      {
        id: "submission_history",
        label: "Submission history",
        render: () => (
          <div>
            {detailLoading ? (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>
            ) : statusHistory.length === 0 ? (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>
                No status events recorded yet.
              </div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {statusHistory.map((e) => (
                  <li
                    key={e.id}
                    style={{
                      padding: "8px 0",
                      borderBottom: "1px solid #F1F5F9",
                      fontSize: 13,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <strong>{e.status}</strong>
                      <span style={{ color: "#64748B" }}>{fmtDate(e.created_at)}</span>
                    </div>
                    <div style={{ color: "#64748B", fontSize: 12 }}>via {e.source}</div>
                    {e.status_message ? (
                      <div style={{ marginTop: 4, color: "#0F172A" }}>{e.status_message}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ),
      },
      {
        id: "batch_details",
        label: "Batch details",
        render: () => (
          <div>
            <KV label="Batch number" value={selectedRow.batchNumber ?? "—"} />
            <KV label="Batch status" value={selectedRow.batchStatus ?? "—"} />
            <KV label="Claim status" value={selectedRow.claimStatus} />
            <KV label="Submitted at" value={fmtDate(selectedRow.submittedAt)} />
            <KV
              label="Days since submission"
              value={selectedRow.daysSinceSubmission ?? "—"}
            />
            <KV
              label="Next expected response"
              value={fmtDate(selectedRow.nextExpectedResponse)}
            />
            <KV label="Charge amount" value={fmtMoney(selectedRow.chargeAmount)} />
            <KV label="CPT codes" value={selectedRow.cptCodes.join(", ") || "—"} />
            {selectedRow.batchId ? (
              <div style={{ marginTop: 12 }}>
                <a
                  className="button button-secondary"
                  href={`/billing/batches/${encodeURIComponent(selectedRow.batchId)}?organizationId=${encodeURIComponent(organizationId)}`}
                >
                  Open batch lifecycle
                </a>
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: "clearinghouse_acks",
        label: "Clearinghouse acknowledgments",
        render: () => (
          <div>
            <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>999 acknowledgements</h4>
            {detailLoading ? (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>
            ) : acks999.length === 0 ? (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>No 999 received yet.</div>
            ) : (
              acks999.map((a) => (
                <div
                  key={a.id}
                  style={{
                    background: "#F8FAFC",
                    padding: 8,
                    borderRadius: 4,
                    marginBottom: 8,
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {a.file_name || `999 ${a.id.slice(0, 8)}`}
                  </div>
                  <div style={{ color: "#64748B" }}>Received {fmtDate(a.created_at)}</div>
                </div>
              ))
            )}
            <h4 style={{ margin: "12px 0 6px", fontSize: 13 }}>277CA acknowledgements</h4>
            {detailLoading ? (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>
            ) : acks277.length === 0 ? (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>No 277CA received yet.</div>
            ) : (
              acks277.map((a) => (
                <div
                  key={a.id}
                  style={{
                    background: "#F8FAFC",
                    padding: 8,
                    borderRadius: 4,
                    marginBottom: 8,
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {a.file_name || `277CA ${a.id.slice(0, 8)}`}
                  </div>
                  <div style={{ color: "#64748B" }}>Received {fmtDate(a.created_at)}</div>
                </div>
              ))
            )}
          </div>
        ),
      },
      {
        id: "office_ally_messages",
        label: "Office Ally response messages",
        render: () => {
          const oaEvents = statusHistory.filter(
            (e) =>
              e.source?.toLowerCase().includes("office_ally") ||
              e.source?.toLowerCase().includes("availity") ||
              e.source?.toLowerCase().includes("clearinghouse"),
          );
          if (detailLoading)
            return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>;
          if (oaEvents.length === 0) {
            return (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>
                No clearinghouse messages yet.
              </div>
            );
          }
          return (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {oaEvents.map((e) => (
                <li
                  key={e.id}
                  style={{
                    padding: "8px 0",
                    borderBottom: "1px solid #F1F5F9",
                    fontSize: 13,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <strong>{e.status}</strong>
                    <span style={{ color: "#64748B" }}>{fmtDate(e.created_at)}</span>
                  </div>
                  {e.status_message ? (
                    <div style={{ marginTop: 4, color: "#0F172A" }}>{e.status_message}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          );
        },
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
    ];
  }, [selectedRow, detailLoading, statusHistory, acks999, acks277, organizationId]);

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const r = selectedRow;
    return [
      {
        id: "check",
        label: "Check status",
        onClick: () => void runAction(r, "check_status", `Status check logged for ${r.claimNumber}`),
        disabled: busyAction === `${r.id}:check_status`,
      },
      {
        id: "request",
        label: "Request update",
        onClick: () => void runAction(r, "request_update", `Update requested for ${r.claimNumber}`),
        disabled: busyAction === `${r.id}:request_update`,
      },
      {
        id: "no-response",
        label: "Move to no response",
        onClick: () =>
          void runAction(r, "move_to_no_response", `${r.claimNumber} moved to No Response Risk`),
        disabled: r.hasNoResponseFlag || busyAction === `${r.id}:move_to_no_response`,
      },
      { id: "note", label: "Add note", onClick: () => setNoteRow(r) },
      {
        id: "resubmit",
        label: "Resubmit if needed",
        variant: "primary",
        onClick: () => void runAction(r, "resubmit", `${r.claimNumber} marked for resubmission`),
        disabled: busyAction === `${r.id}:resubmit`,
      },
    ];
  }, [selectedRow, busyAction, runAction]);

  const message = error ? { tone: "error" as const, text: error } : null;

  const headerActions: PrimaryAction[] = useMemo(
    () => [
      ...(offset > 0
        ? [
            {
              id: "prev",
              label: "Previous page",
              onClick: () => setOffset((o) => Math.max(0, o - PAGE_SIZE)),
              disabled: loading,
            },
          ]
        : []),
      ...(hasMore
        ? [
            {
              id: "next",
              label: "Next page",
              onClick: () => setOffset((o) => o + PAGE_SIZE),
              disabled: loading,
            },
          ]
        : []),
      {
        id: "refresh",
        label: loading ? "Loading…" : "Refresh",
        onClick: () => void load(activeTab, filterValues, offset),
        disabled: loading,
      },
    ],
    [offset, hasMore, loading, load, activeTab, filterValues],
  );

  return (
    <>
      <WorkqueueShell<Row>
        title={queueDef?.title ?? "Submitted Claims"}
        description={queueDef?.description}
        headerActions={headerActions}
        summary={summaryMetrics}
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTab}
        onPrimaryTabChange={(id) => setActiveTab(id as TabId)}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace="submitted_claims"
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No submitted claims in this tab."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {noteRow ? (
        <NoteModal
          row={noteRow}
          organizationId={organizationId}
          onClose={() => setNoteRow(null)}
          onSaved={(msg) => setToast(msg)}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
