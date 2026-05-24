"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import WorkqueueShell, {
  type ColumnDef,
  type DetailTab,
  type FilterDef,
  type PrimaryAction,
  type RowAction,
  type SummaryMetric,
} from "@/components/billing/WorkqueueShell";
import { DEFAULT_ORG_ID } from "@/lib/config";
import {
  suggestOffsetPayment,
  type PaymentSuggestion,
} from "@/lib/billing/suggestOffsetPayment";

type Tab =
  | "new_recoupments"
  | "pending_review"
  | "disputed"
  | "accepted"
  | "offset"
  | "refund_due";

type State =
  | "new"
  | "pending_review"
  | "disputed"
  | "accepted"
  | "offset"
  | "refund_due";

type Row = {
  id: string;
  recoupment_id: string;
  client_id: string | null;
  client_name: string;
  claim_id: string | null;
  claim_number: string;
  payer_profile_id: string | null;
  payer_name: string;
  original_payment_date: string | null;
  original_paid_amount: number;
  recoupment_amount: number;
  reason_code: string | null;
  reason: string;
  notice_date: string | null;
  deadline_date: string | null;
  status: string;
  state: State;
  tabs: Tab[];
  source_era_claim_payment_id: string | null;
  source_client_payment_id: string | null;
  offset_era_claim_payment_id: string | null;
  era_import_batch_id: string | null;
  days_since_notice: number | null;
  days_to_deadline: number | null;
  aging_bucket: string;
  priority: "low" | "medium" | "high" | "critical";
  carc_codes: string[];
  rarc_codes: string[];
  refund_id: string | null;
  refund_status: string | null;
  clinician_id: string | null;
  practice_id: string | null;
  practice_name: string | null;
  service_date: string | null;
};

type Summary = {
  total_count: number;
  total_dollars: number;
  oldest_age_days: number | null;
  urgent_count: number;
  by_tab: Record<Tab, number>;
};

type Payload = {
  success: boolean;
  error?: string;
  items?: Row[];
  summary?: Summary;
};

const TAB_DEFS: Array<{ id: Tab; label: string }> = [
  { id: "new_recoupments", label: "New Recoupments" },
  { id: "pending_review", label: "Pending Review" },
  { id: "disputed", label: "Disputed" },
  { id: "accepted", label: "Accepted" },
  { id: "offset", label: "Offset Against Future Payments" },
  { id: "refund_due", label: "Refund Due" },
];

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

function formatMoney(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function pill(text: string, bg: string, fg: string): ReactNode {
  return (
    <span
      style={{
        background: bg,
        color: fg,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function statePill(state: State): ReactNode {
  switch (state) {
    case "new": return pill("New", "#e0f2fe", "#075985");
    case "pending_review": return pill("Pending review", "#fef9c3", "#854d0e");
    case "disputed": return pill("Disputed", "#ffedd5", "#9a3412");
    case "accepted": return pill("Accepted", "#dcfce7", "#166534");
    case "offset": return pill("Offset applied", "#ede9fe", "#5b21b6");
    case "refund_due": return pill("Refund due", "#fee2e2", "#991b1b");
  }
}

function deadlinePill(days: number | null): ReactNode {
  if (days == null) return <span style={{ color: "#64748b" }}>—</span>;
  if (days < 0) return pill(`${Math.abs(days)}d overdue`, "#fee2e2", "#991b1b");
  if (days <= 7) return pill(`${days}d left`, "#fef3c7", "#92400e");
  return <span style={{ fontSize: 12 }}>{`${days}d`}</span>;
}

export default function RecoupmentsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);

  const [items, setItems] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);
  const [activeTab, setActiveTab] = useState<Tab>("new_recoupments");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [offsetPickerRow, setOffsetPickerRow] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ organizationId, tab: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) qs.set(k, v);
      }
      const res = await fetch(`/api/billing/recoupments?${qs.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as Payload;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load worklist");
      }
      setItems(json.items ?? []);
      setSummary(json.summary ?? null);
    } catch (e) {
      setMessage({
        tone: "error",
        text: e instanceof Error ? e.message : "Failed to load worklist",
      });
    } finally {
      setLoading(false);
    }
  }, [organizationId, activeTab, filterValues]);

  useEffect(() => {
    void load();
  }, [load]);

  const primaryTabs = useMemo(
    () =>
      TAB_DEFS.map((t) => ({
        id: t.id,
        label: t.label,
        count: summary?.by_tab?.[t.id] ?? 0,
      })),
    [summary],
  );

  const payerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.payer_name) set.add(i.payer_name);
    return Array.from(set).map((p) => ({ value: p, label: p }));
  }, [items]);

  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (i.client_id) m.set(i.client_id, i.client_name);
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const clinicianOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.clinician_id) set.add(i.clinician_id);
    return Array.from(set).map((c) => ({ value: c, label: c }));
  }, [items]);

  const practiceOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) {
      if (i.practice_id) m.set(i.practice_id, i.practice_name || i.practice_id);
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const carcOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) for (const c of i.carc_codes) set.add(c);
    return Array.from(set).map((c) => ({ value: c, label: c }));
  }, [items]);

  const rarcOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) for (const c of i.rarc_codes) set.add(c);
    return Array.from(set).map((c) => ({ value: c, label: c }));
  }, [items]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "select", options: practiceOptions },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicianOptions },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "select", options: clientOptions },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "new", label: "New" },
          { value: "pending_review", label: "Pending review" },
          { value: "disputed", label: "Disputed" },
          { value: "accepted", label: "Accepted" },
          { value: "offset", label: "Offset applied" },
          { value: "refund_due", label: "Refund due" },
        ],
      },
      { id: "assigned", label: "Assigned biller", kind: "text", placeholder: "Staff label" },
      { id: "minAmount", label: "Min $", kind: "number" },
      { id: "maxAmount", label: "Max $", kind: "number" },
      {
        id: "agingBucket",
        label: "Aging",
        kind: "select",
        options: [
          { value: "0_30", label: "0–30d" },
          { value: "31_60", label: "31–60d" },
          { value: "61_90", label: "61–90d" },
          { value: "90_plus", label: "90+d" },
        ],
      },
      { id: "carc", label: "CARC", kind: "select", options: carcOptions },
      { id: "rarc", label: "RARC", kind: "select", options: rarcOptions },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "critical", label: "Critical" },
        ],
      },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [payerOptions, clientOptions, clinicianOptions, practiceOptions, carcOptions, rarcOptions],
  );

  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.client_name },
      {
        id: "claim",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "monospace", fontSize: 12 }}>
            {r.claim_number}
          </span>
        ),
      },
      { id: "payer", header: "Payer", cell: (r) => r.payer_name },
      {
        id: "original_payment_date",
        header: "Original payment date",
        cell: (r) => formatDate(r.original_payment_date),
      },
      {
        id: "original_paid",
        header: "Original paid amount",
        align: "right",
        cell: (r) => formatMoney(r.original_paid_amount),
      },
      {
        id: "recoup_amount",
        header: "Recoupment amount",
        align: "right",
        cell: (r) => (
          <strong>{formatMoney(r.recoupment_amount)}</strong>
        ),
      },
      {
        id: "reason",
        header: "Reason",
        cell: (r) => (
          <span style={{ fontSize: 12 }}>
            {r.reason_code ? (
              <span
                style={{
                  fontFamily: "monospace",
                  background: "#f1f5f9",
                  padding: "1px 6px",
                  borderRadius: 4,
                  marginRight: 6,
                }}
              >
                {r.reason_code}
              </span>
            ) : null}
            {r.reason}
          </span>
        ),
      },
      {
        id: "notice_date",
        header: "Notice date",
        cell: (r) => formatDate(r.notice_date),
      },
      {
        id: "deadline",
        header: "Deadline",
        cell: (r) => (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#64748b" }}>
              {formatDate(r.deadline_date)}
            </span>
            {deadlinePill(r.days_to_deadline)}
          </span>
        ),
      },
      { id: "status", header: "Status", cell: (r) => statePill(r.state) },
    ],
    [],
  );

  const runAction = useCallback(
    async (rowId: string, action: string, extras: Record<string, unknown> = {}) => {
      setBusyRow(rowId);
      try {
        const res = await fetch(
          `/api/billing/recoupments/${encodeURIComponent(rowId)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, organizationId, ...extras }),
          },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          refundId?: string | null;
        };
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Action failed");
        }
        // Optimistic local update
        setItems((prev) =>
          prev.map((r) => {
            if (r.id !== rowId) return r;
            const next: Row = { ...r };
            switch (action) {
              case "dispute":
                next.state = "disputed";
                next.status = "Disputed";
                next.tabs = ["disputed"];
                if (typeof extras.deadline === "string") {
                  next.deadline_date = extras.deadline;
                }
                break;
              case "accept":
                next.state = "accepted";
                next.status = "Accepted";
                next.tabs = ["accepted"];
                break;
              case "pending_review":
                next.state = "pending_review";
                next.status = "Pending review";
                next.tabs = ["pending_review"];
                break;
              case "apply_offset":
                next.state = "offset";
                next.status = "Offset applied";
                next.tabs = ["offset"];
                if (typeof extras.offset_era_claim_payment_id === "string") {
                  next.offset_era_claim_payment_id =
                    extras.offset_era_claim_payment_id;
                }
                break;
              case "mark_refund_due":
              case "create_refund":
                next.state = "refund_due";
                next.status = "Refund due";
                next.tabs = ["refund_due"];
                if (action === "create_refund") {
                  next.refund_id = json.refundId ?? next.refund_id;
                  next.refund_status = "pending";
                }
                break;
              case "reopen":
                next.state = "new";
                next.status = "New";
                next.tabs = ["new_recoupments"];
                break;
            }
            return next;
          }),
        );
        setMessage({
          tone: "success",
          text: `Action "${action.replace(/_/g, " ")}" applied.`,
        });
        void load();
      } catch (e) {
        setMessage({
          tone: "error",
          text: e instanceof Error ? e.message : "Action failed",
        });
      } finally {
        setBusyRow(null);
      }
    },
    [organizationId, load],
  );

  const promptDispute = useCallback(
    (row: Row) => {
      const note = window.prompt(
        `Dispute recoupment of ${formatMoney(row.recoupment_amount)} from ${row.payer_name}.\n\nEnter dispute reason / notes:`,
      );
      if (note == null) return;
      const deadline = window.prompt(
        "Dispute response deadline (YYYY-MM-DD) — leave blank for default 30d window:",
        row.deadline_date ?? "",
      );
      void runAction(row.id, "dispute", {
        note,
        ...(deadline ? { deadline } : {}),
      });
    },
    [runAction],
  );

  const promptOffset = useCallback((row: Row) => {
    setOffsetPickerRow(row);
  }, []);

  const handleOffsetPicked = useCallback(
    (eraClaimPaymentId: string) => {
      const row = offsetPickerRow;
      setOffsetPickerRow(null);
      if (!row) return;
      void runAction(row.id, "apply_offset", {
        offset_era_claim_payment_id: eraClaimPaymentId,
      });
    },
    [offsetPickerRow, runAction],
  );

  const promptNote = useCallback(
    (row: Row) => {
      const note = window.prompt("Add a note to this recoupment:");
      if (!note) return;
      void runAction(row.id, "add_note", { note });
    },
    [runAction],
  );

  const promptCreateRefund = useCallback(
    (row: Row) => {
      const ok = window.confirm(
        `Create a pending refund of ${formatMoney(row.recoupment_amount)} to ${row.payer_name}?`,
      );
      if (!ok) return;
      const note = window.prompt("Refund note (optional):") ?? "";
      void runAction(row.id, "create_refund", { note });
    },
    [runAction],
  );

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      {
        id: "dispute",
        label: "Dispute",
        onClick: (r) => promptDispute(r),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "accept",
        label: "Accept",
        variant: "primary",
        onClick: (r) => void runAction(r.id, "accept"),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "create_refund",
        label: "Create refund",
        onClick: (r) => promptCreateRefund(r),
        disabled: (r) => busyRow === r.id || !!r.refund_id,
      },
      {
        id: "apply_offset",
        label: "Apply offset",
        onClick: (r) => promptOffset(r),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "add_note",
        label: "Add note",
        onClick: (r) => promptNote(r),
        disabled: (r) => busyRow === r.id,
      },
    ],
    [runAction, promptDispute, promptOffset, promptNote, promptCreateRefund, busyRow],
  );

  const selectedRow = useMemo(
    () => items.find((r) => r.id === selectedId) ?? null,
    [items, selectedId],
  );

  const labeledItem = (label: string, value: ReactNode) => (
    <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
      <span style={{ color: "#64748b", minWidth: 180 }}>{label}</span>
      <span>{value}</span>
    </div>
  );

  const detailTabs: DetailTab[] = useMemo(() => {
    if (!selectedRow) return [];
    const row = selectedRow;
    return [
      {
        id: "original_era",
        label: "Original ERA",
        render: () => (
          <OriginalEraPanel
            eraClaimPaymentId={row.source_era_claim_payment_id}
            clientPaymentId={row.source_client_payment_id}
            organizationId={organizationId}
          />
        ),
      },
      {
        id: "recoupment_notice",
        label: "Recoupment notice",
        render: () => (
          <div>
            {labeledItem("Notice date", formatDate(row.notice_date))}
            {labeledItem(
              "Deadline",
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                {formatDate(row.deadline_date)}
                {deadlinePill(row.days_to_deadline)}
              </span>,
            )}
            {labeledItem(
              "Amount",
              <strong>{formatMoney(row.recoupment_amount)}</strong>,
            )}
            {labeledItem("Reason code", row.reason_code || "—")}
            {labeledItem("Reason", row.reason)}
            {labeledItem(
              "CARC",
              row.carc_codes.length ? row.carc_codes.join(", ") : "—",
            )}
            {labeledItem(
              "RARC",
              row.rarc_codes.length ? row.rarc_codes.join(", ") : "—",
            )}
            {labeledItem("Priority", row.priority)}
            {labeledItem("Status", statePill(row.state))}
          </div>
        ),
      },
      {
        id: "contract_history",
        label: "Contract/payment history",
        render: () => (
          <PaymentHistoryPanel
            claimId={row.claim_id}
            organizationId={organizationId}
          />
        ),
      },
      {
        id: "affected_batch",
        label: "Affected payment batch",
        render: () => (
          <AffectedBatchPanel
            eraImportBatchId={row.era_import_batch_id}
            offsetEraClaimPaymentId={row.offset_era_claim_payment_id}
            organizationId={organizationId}
          />
        ),
      },
      {
        id: "dispute_notes",
        label: "Dispute notes",
        render: () => (
          <DisputeNotesPanel
            recoupmentId={row.recoupment_id}
            organizationId={organizationId}
          />
        ),
      },
    ];
  }, [selectedRow, organizationId]);

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const row = selectedRow;
    return [
      {
        id: "dispute",
        label: "Dispute recoupment",
        onClick: () => promptDispute(row),
      },
      {
        id: "accept",
        label: "Accept adjustment",
        variant: "primary",
        onClick: () => void runAction(row.id, "accept"),
      },
      {
        id: "create_refund",
        label: row.refund_id ? "Refund already created" : "Create refund",
        onClick: () => promptCreateRefund(row),
        disabled: !!row.refund_id,
      },
      {
        id: "apply_offset",
        label: "Apply offset",
        onClick: () => promptOffset(row),
      },
      {
        id: "add_note",
        label: "Add note",
        onClick: () => promptNote(row),
      },
    ];
  }, [selectedRow, runAction, promptDispute, promptOffset, promptNote, promptCreateRefund]);

  const headerActions: PrimaryAction[] = useMemo(
    () => [
      {
        id: "refresh",
        label: loading ? "Refreshing…" : "Refresh",
        onClick: () => void load(),
        disabled: loading,
      },
    ],
    [loading, load],
  );

  const summaryMetrics: SummaryMetric[] = useMemo(() => {
    const s = summary ?? {
      total_count: 0,
      total_dollars: 0,
      oldest_age_days: null,
      urgent_count: 0,
      by_tab: {
        new_recoupments: 0,
        pending_review: 0,
        disputed: 0,
        accepted: 0,
        offset: 0,
        refund_due: 0,
      } as Record<Tab, number>,
    };
    return [
      { id: "count", label: "Total recoupments", value: String(s.total_count) },
      {
        id: "dollars",
        label: "Total $",
        value: formatMoney(s.total_dollars),
        tone: s.total_dollars > 0 ? "amber" : "default",
      },
      {
        id: "age",
        label: "Oldest claim age",
        value: s.oldest_age_days == null ? "—" : `${s.oldest_age_days}d`,
        tone: (s.oldest_age_days ?? 0) > 60 ? "red" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: String(s.urgent_count),
        tone: s.urgent_count > 0 ? "red" : "default",
      },
    ];
  }, [summary]);

  return (
    <>
    <WorkqueueShell<Row>
      title="Recoupments / Takebacks"
      description="Payer overpayment-recovery activity. Dispute, accept, refund, or offset each take-back."
      headerActions={headerActions}
      summary={summaryMetrics}
      primaryTabs={primaryTabs}
      activePrimaryTabId={activeTab}
      onPrimaryTabChange={(id) => {
        setActiveTab(id as Tab);
        setSelectedId(null);
      }}
      filters={filters}
      filterValues={filterValues}
      onFilterChange={setFilterValues}
      filterUrlNamespace="recoup"
      rows={items}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage="No recoupments in this tab."
      selectedRowId={selectedId}
      onSelectRow={setSelectedId}
      rowActions={rowActions}
      detailTabs={detailTabs}
      detailActions={detailActions}
      message={message}
    />
    {offsetPickerRow ? (
      <OffsetPickerModal
        row={offsetPickerRow}
        organizationId={organizationId}
        onCancel={() => setOffsetPickerRow(null)}
        onPick={handleOffsetPicked}
      />
    ) : null}
    </>
  );
}

// ─── Offset picker modal ────────────────────────────────────────────────────

type EraPaymentListItem = {
  id: string;
  paymentAmount: number;
  checkNumber: string | null;
  importedAt: string | null;
  createdAt: string;
  claimControlNumber: string | null;
  payerClaimControlNumber: string | null;
  payer: { id: string | null; name: string | null };
  client: { id: string; displayName: string } | null;
  professionalClaim: { claimNumber: string | null } | null;
};

function OffsetPickerModal({
  row,
  organizationId,
  onCancel,
  onPick,
}: {
  row: Row;
  organizationId: string;
  onCancel: () => void;
  onPick: (id: string) => void;
}) {
  const PAGE_SIZE = 50;
  const [items, setItems] = useState<EraPaymentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    row.offset_era_claim_payment_id ?? null,
  );
  const [autoPreselected, setAutoPreselected] = useState(false);
  const [showAllPayers, setShowAllPayers] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);

  // Debounce free-text search so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filterPayerId =
    !showAllPayers && row.payer_profile_id ? row.payer_profile_id : null;

  const buildQs = useCallback(
    (offset: number) => {
      const qs = new URLSearchParams({
        organizationId,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (filterPayerId) qs.set("payerProfileId", filterPayerId);
      if (search) qs.set("search", search);
      return qs;
    },
    [organizationId, filterPayerId, search],
  );

  const suggestion = useMemo(
    () =>
      suggestOffsetPayment(
        {
          recoupment_amount: row.recoupment_amount,
          reason: row.reason,
          reason_code: row.reason_code,
          payer_profile_id: row.payer_profile_id,
          payer_name: row.payer_name,
          notice_date: row.notice_date,
          offset_era_claim_payment_id: row.offset_era_claim_payment_id,
        },
        items,
      ),
    [items, row.recoupment_amount, row.reason, row.reason_code, row.payer_profile_id, row.payer_name, row.notice_date, row.offset_era_claim_payment_id],
  );

  // Pre-select the suggested row when no manual selection has been made yet.
  // We only auto-pick once per modal open so we never clobber the user's
  // choice if they click around.
  useEffect(() => {
    if (autoPreselected || loading) return;
    if (!suggestion.bestId) return;
    if (selectedId && selectedId !== row.offset_era_claim_payment_id) return;
    if (suggestion.shouldPreselect || !selectedId) {
      setSelectedId(suggestion.bestId);
      setAutoPreselected(true);
    }
  }, [autoPreselected, loading, suggestion, selectedId, row.offset_era_claim_payment_id]);

  useEffect(() => {
    let cancelled = false;
    async function go() {
      setLoading(true);
      setErr(null);
      try {
        const res = await fetch(
          `/api/billing/era-payments?${buildQs(0).toString()}`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          items?: EraPaymentListItem[];
          error?: string;
          hasMore?: boolean;
          nextOffset?: number | null;
        };
        if (cancelled) return;
        if (!res.ok || !json.success) {
          setErr(json.error ?? "Failed to load ERA payments");
          setItems([]);
          setHasMore(false);
          setNextOffset(null);
        } else {
          setItems(json.items ?? []);
          setHasMore(Boolean(json.hasMore));
          setNextOffset(json.nextOffset ?? null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void go();
    return () => {
      cancelled = true;
    };
  }, [buildQs]);

  const loadMore = useCallback(async () => {
    if (nextOffset == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/billing/era-payments?${buildQs(nextOffset).toString()}`,
        { cache: "no-store" },
      );
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        items?: EraPaymentListItem[];
        error?: string;
        hasMore?: boolean;
        nextOffset?: number | null;
      };
      if (!res.ok || !json.success) {
        setErr(json.error ?? "Failed to load more ERA payments");
      } else {
        setItems((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          const additions = (json.items ?? []).filter((p) => !seen.has(p.id));
          return prev.concat(additions);
        });
        setHasMore(Boolean(json.hasMore));
        setNextOffset(json.nextOffset ?? null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [buildQs, nextOffset, loadingMore]);

  const filtered = useMemo(() => {
    return [...items].sort((a, b) => {
      // Suggested rows float to the top, ordered by score; then date desc.
      const sa = suggestion.byId.get(a.id)?.score ?? 0;
      const sb = suggestion.byId.get(b.id)?.score ?? 0;
      if (sa !== sb) return sb - sa;
      const da = new Date(a.importedAt ?? a.createdAt).getTime();
      const db = new Date(b.importedAt ?? b.createdAt).getTime();
      return db - da;
    });
  }, [items, suggestion]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 8,
          maxWidth: 880,
          width: "100%",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #e2e8f0",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            Apply offset against an ERA payment
          </div>
          <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
            Recoupment of <strong>{formatMoney(row.recoupment_amount)}</strong>{" "}
            from <strong>{row.payer_name}</strong>
            {row.client_name ? ` for ${row.client_name}` : ""}. Pick the ERA
            payment where this take-back was netted out.
          </div>
          {suggestion.bestId ? (
            <div
              style={{
                marginTop: 8,
                padding: "8px 10px",
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: 6,
                fontSize: 12,
                color: "#166534",
              }}
            >
              <strong>Suggested match{suggestion.shouldPreselect ? " (pre-selected)" : ""}:</strong>{" "}
              {suggestion.byId.get(suggestion.bestId)?.reason}. You can pick a
              different ERA payment below.
            </div>
          ) : null}
        </div>
        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <input
            type="search"
            placeholder="Search check #, claim #…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{
              flex: 1,
              minWidth: 220,
              padding: "6px 10px",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontSize: 13,
            }}
          />
          {row.payer_profile_id ? (
            <label
              style={{
                fontSize: 12,
                color: "#475569",
                display: "inline-flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              <input
                type="checkbox"
                checked={showAllPayers}
                onChange={(e) => setShowAllPayers(e.target.checked)}
              />
              Show all payers
            </label>
          ) : null}
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          {loading ? (
            <p style={{ padding: 20, fontSize: 13 }}>Loading ERA payments…</p>
          ) : err ? (
            <p style={{ padding: 20, fontSize: 13, color: "#b91c1c" }}>{err}</p>
          ) : filtered.length === 0 ? (
            <p style={{ padding: 20, fontSize: 13, color: "#64748b" }}>
              No matching ERA payments found
              {!showAllPayers && row.payer_profile_id
                ? " for this payer. Try “Show all payers”."
                : "."}
            </p>
          ) : (
            <table
              style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}
            >
              <thead
                style={{
                  position: "sticky",
                  top: 0,
                  background: "#f8fafc",
                  textAlign: "left",
                  color: "#64748b",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                <tr>
                  <th style={{ padding: "8px 12px", width: 32 }}></th>
                  <th style={{ padding: "8px 12px" }}>Date</th>
                  <th style={{ padding: "8px 12px" }}>Check / EFT #</th>
                  <th style={{ padding: "8px 12px" }}>Payer</th>
                  <th style={{ padding: "8px 12px" }}>Client</th>
                  <th style={{ padding: "8px 12px" }}>Claim #</th>
                  <th style={{ padding: "8px 12px", textAlign: "right" }}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const isSel = selectedId === p.id;
                  const sugg: PaymentSuggestion | undefined =
                    suggestion.byId.get(p.id);
                  const isSuggested = suggestion.bestId === p.id;
                  return (
                    <tr
                      key={p.id}
                      onClick={() => setSelectedId(p.id)}
                      onDoubleClick={() => onPick(p.id)}
                      style={{
                        borderTop: "1px solid #e2e8f0",
                        cursor: "pointer",
                        background: isSel
                          ? "#eef2ff"
                          : isSuggested
                            ? "#f0fdf4"
                            : "transparent",
                      }}
                    >
                      <td style={{ padding: "8px 12px" }}>
                        <input
                          type="radio"
                          name="offset-pick"
                          checked={isSel}
                          onChange={() => setSelectedId(p.id)}
                        />
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        {formatDate(p.importedAt ?? p.createdAt)}
                        {isSuggested ? (
                          <div style={{ marginTop: 4 }}>
                            {pill("Suggested match", "#dcfce7", "#166534")}
                            <div
                              style={{
                                fontSize: 11,
                                color: "#166534",
                                marginTop: 2,
                              }}
                            >
                              {sugg?.reason}
                            </div>
                          </div>
                        ) : null}
                      </td>
                      <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>
                        {p.checkNumber ?? "—"}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        {p.payer.name ?? "—"}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        {p.client?.displayName ?? "—"}
                      </td>
                      <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: 12 }}>
                        {p.professionalClaim?.claimNumber ??
                          p.payerClaimControlNumber ??
                          p.claimControlNumber ??
                          "—"}
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>
                        <strong>{formatMoney(p.paymentAmount)}</strong>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!loading && !err && hasMore ? (
            <div style={{ padding: 12, textAlign: "center" }}>
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                style={{
                  padding: "6px 14px",
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: loadingMore ? "wait" : "pointer",
                }}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </div>
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid #e2e8f0",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "6px 14px",
              border: "1px solid #cbd5e1",
              background: "#fff",
              borderRadius: 6,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selectedId}
            onClick={() => selectedId && onPick(selectedId)}
            style={{
              padding: "6px 14px",
              border: "1px solid #4338ca",
              background: selectedId ? "#4338ca" : "#a5b4fc",
              color: "#fff",
              borderRadius: 6,
              fontSize: 13,
              cursor: selectedId ? "pointer" : "not-allowed",
            }}
          >
            Apply offset
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Detail panel sub-components ────────────────────────────────────────────

function OriginalEraPanel({
  eraClaimPaymentId,
  clientPaymentId,
  organizationId,
}: {
  eraClaimPaymentId: string | null;
  clientPaymentId: string | null;
  organizationId: string;
}) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function go() {
      if (!eraClaimPaymentId && !clientPaymentId) return;
      setLoading(true);
      setErr(null);
      try {
        if (eraClaimPaymentId) {
          const qs = new URLSearchParams({ organizationId });
          const res = await fetch(
            `/api/billing/era-payments/${encodeURIComponent(eraClaimPaymentId)}?${qs.toString()}`,
            { cache: "no-store" },
          );
          const json = (await res.json().catch(() => ({}))) as {
            success?: boolean;
            payment?: Record<string, unknown>;
            error?: string;
          };
          if (!cancelled) {
            if (!res.ok || !json.success) {
              setErr(json.error ?? "Failed to load ERA payment");
            } else {
              setData(json.payment ?? null);
            }
          }
        } else {
          setData({ kind: "client_payment", id: clientPaymentId });
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void go();
    return () => {
      cancelled = true;
    };
  }, [eraClaimPaymentId, clientPaymentId, organizationId]);

  if (!eraClaimPaymentId && !clientPaymentId) {
    return (
      <p style={{ fontSize: 13, color: "#64748b" }}>
        No source payment linked to this recoupment.
      </p>
    );
  }
  if (loading) return <p style={{ fontSize: 13 }}>Loading ERA…</p>;
  if (err) return <p style={{ fontSize: 13, color: "#b91c1c" }}>{err}</p>;
  if (!data) {
    return (
      <p style={{ fontSize: 13, color: "#64748b" }}>
        Source payment id:{" "}
        <code>{eraClaimPaymentId ?? clientPaymentId ?? "—"}</code>
      </p>
    );
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
        <span style={{ color: "#64748b", minWidth: 180 }}>Source kind</span>
        <span>{eraClaimPaymentId ? "ERA 835 payment" : "Client payment"}</span>
      </div>
      <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
        <span style={{ color: "#64748b", minWidth: 180 }}>Source id</span>
        <code style={{ fontSize: 12 }}>
          {eraClaimPaymentId ?? clientPaymentId}
        </code>
      </div>
      <pre
        style={{
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          padding: 8,
          borderRadius: 6,
          fontSize: 11,
          maxHeight: 280,
          overflow: "auto",
        }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

function PaymentHistoryPanel({
  claimId,
  organizationId,
}: {
  claimId: string | null;
  organizationId: string;
}) {
  const [rows, setRows] = useState<
    Array<{
      id: string;
      payment_amount: number;
      check_eft_number: string | null;
      check_issue_date: string | null;
      posting_status: string;
      created_at: string;
    }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function go() {
      if (!claimId) return;
      setLoading(true);
      setErr(null);
      try {
        const qs = new URLSearchParams({
          organizationId,
          claimId,
        });
        const res = await fetch(
          `/api/billing/recoupments/payment-history?${qs.toString()}`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          rows?: typeof rows;
          error?: string;
        };
        if (!cancelled) {
          if (res.status === 404) {
            // Fallback panel — endpoint not present; show a simple stub.
            setRows([]);
          } else if (!res.ok || !json.success) {
            setErr(json.error ?? "Failed to load payment history");
          } else {
            setRows(json.rows ?? []);
          }
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void go();
    return () => {
      cancelled = true;
    };
  }, [claimId, organizationId]);

  if (!claimId) {
    return (
      <p style={{ fontSize: 13, color: "#64748b" }}>
        Recoupment is not linked to a professional claim — payment history
        unavailable.
      </p>
    );
  }
  if (loading) return <p style={{ fontSize: 13 }}>Loading history…</p>;
  if (err) return <p style={{ fontSize: 13, color: "#b91c1c" }}>{err}</p>;
  if (rows.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "#64748b" }}>
        No prior posted payments found for this claim.
      </p>
    );
  }
  return (
    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left", color: "#64748b" }}>
          <th style={{ padding: 4 }}>Date</th>
          <th style={{ padding: 4 }}>Check / EFT</th>
          <th style={{ padding: 4, textAlign: "right" }}>Amount</th>
          <th style={{ padding: 4 }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id} style={{ borderTop: "1px solid #e2e8f0" }}>
            <td style={{ padding: 4 }}>{formatDate(p.check_issue_date ?? p.created_at)}</td>
            <td style={{ padding: 4, fontFamily: "monospace" }}>
              {p.check_eft_number ?? "—"}
            </td>
            <td style={{ padding: 4, textAlign: "right" }}>
              {formatMoney(p.payment_amount)}
            </td>
            <td style={{ padding: 4 }}>{p.posting_status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AffectedBatchPanel({
  eraImportBatchId,
  offsetEraClaimPaymentId,
  organizationId,
}: {
  eraImportBatchId: string | null;
  offsetEraClaimPaymentId: string | null;
  organizationId: string;
}) {
  void organizationId;
  return (
    <div>
      <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
        <span style={{ color: "#64748b", minWidth: 200 }}>Origin batch</span>
        <code style={{ fontSize: 12 }}>{eraImportBatchId ?? "—"}</code>
      </div>
      <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
        <span style={{ color: "#64748b", minWidth: 200 }}>Offset payment</span>
        <code style={{ fontSize: 12 }}>{offsetEraClaimPaymentId ?? "—"}</code>
      </div>
      {eraImportBatchId ? (
        <p style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
          Open the ERA Import queue to review the full check / payment batch.
        </p>
      ) : null}
    </div>
  );
}

function DisputeNotesPanel({
  recoupmentId,
  organizationId,
}: {
  recoupmentId: string;
  organizationId: string;
}) {
  const [rows, setRows] = useState<
    Array<{
      event_type: string;
      event_summary: string | null;
      event_metadata: Record<string, unknown> | null;
      created_at: string;
    }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function go() {
      setLoading(true);
      setErr(null);
      try {
        const qs = new URLSearchParams({ organizationId, recoupmentId });
        const res = await fetch(
          `/api/billing/recoupments/notes?${qs.toString()}`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          rows?: typeof rows;
          error?: string;
        };
        if (!cancelled) {
          if (!res.ok || !json.success) {
            setErr(json.error ?? "Failed to load notes");
          } else {
            setRows(json.rows ?? []);
          }
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void go();
    return () => {
      cancelled = true;
    };
  }, [recoupmentId, organizationId]);

  if (loading) return <p style={{ fontSize: 13 }}>Loading notes…</p>;
  if (err) return <p style={{ fontSize: 13, color: "#b91c1c" }}>{err}</p>;
  if (rows.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "#64748b" }}>
        No dispute notes yet. Add one with “Add note”, “Dispute recoupment”, or
        any of the workflow actions.
      </p>
    );
  }
  return (
    <ol style={{ paddingLeft: 18, margin: 0 }}>
      {rows.map((n, idx) => {
        const note =
          (n.event_metadata && typeof n.event_metadata.note === "string"
            ? n.event_metadata.note
            : null) ?? null;
        return (
          <li key={idx} style={{ marginBottom: 10, fontSize: 13 }}>
            <div style={{ color: "#64748b", fontSize: 11 }}>
              {formatDate(n.created_at)} ·{" "}
              <code>{n.event_type.replace(/^recoupment_/, "")}</code>
            </div>
            <div>{n.event_summary ?? "—"}</div>
            {note ? (
              <div style={{ marginTop: 4, color: "#334155" }}>{note}</div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
