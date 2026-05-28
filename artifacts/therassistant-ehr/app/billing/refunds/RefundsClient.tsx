"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type DetailTab,
  type FilterDef,
  type PrimaryAction,
  type PrimaryTab,
  type RowAction,
  type SummaryMetric,
} from "@/components/billing/WorkqueueShell";
import { getWorkqueue } from "@/lib/billing/workqueues";

// ─── Types ────────────────────────────────────────────────────────────────

type Tab =
  | "payer_refunds"
  | "patient_refunds"
  | "credit_balance_review"
  | "offset_requested"
  | "refund_completed";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "payer_refunds", label: "Payer Refunds" },
  { id: "patient_refunds", label: "Client Refunds" },
  { id: "credit_balance_review", label: "Credit Balance Review" },
  { id: "offset_requested", label: "Offset Requested" },
  { id: "refund_completed", label: "Refund Completed" },
];

interface RefundRow {
  id: string;
  source: "payment_refund" | "payment_recoupment" | "era_overpayment";
  tab: Tab;
  refundId: string | null;
  recoupmentId: string | null;
  eraClaimPaymentId: string | null;
  clientId: string | null;
  clientName: string;
  payerProfileId: string | null;
  payerOrClient: string;
  payerType: "payer" | "client";
  professionalClaimId: string | null;
  claimNumber: string | null;
  creditAmount: number;
  reason: string | null;
  refundDueDate: string | null;
  status: string;
  assignedToUserId: string | null;
  assignedToName: string | null;
  requestedAt: string | null;
  issuedAt: string | null;
  ageDays: number;
  priority: "low" | "normal" | "high" | "urgent";
  serviceDate: string | null;
  carcCodes: string[];
  rarcCodes: string[];
}

interface Facets {
  payers: Array<{ id: string; name: string }>;
  practices: Array<{ id: string; name: string }>;
  clinicians: string[];
  staff: Array<{ id: string; name: string }>;
}

interface ListPayload {
  success: boolean;
  error?: string;
  rows?: RefundRow[];
  facets?: Facets;
}

interface LedgerEntry {
  id: string;
  kind:
    | "era_posting"
    | "client_payment"
    | "patient_invoice_payment"
    | "refund";
  postedAt: string | null;
  amount: number;
  description: string;
  status: string | null;
  reasonCode: string | null;
  source: string | null;
  href: string | null;
}

interface CreditSource {
  kind: "era" | "client_payment" | "none";
  era: {
    id: string;
    checkEftNumber: string | null;
    checkIssueDate: string | null;
    payerClaimControlNumber: string | null;
    payerTraceNumber: string | null;
    totalCharge: number;
    paymentAmount: number;
    patientResponsibility: number;
    allowedAmount: number | null;
    carcCodes: string[];
    rarcCodes: string[];
    casAdjustments: Array<{
      groupCode: string;
      reasonCode: string;
      amount: number;
      quantity: number | null;
    }>;
  } | null;
  clientPayment: {
    id: string;
    amount: number;
    postedAt: string | null;
    method: string | null;
    referenceNumber: string | null;
    sourceLabel: string | null;
  } | null;
  priorRefunds: Array<{
    id: string;
    amount: number;
    status: string;
    requestedAt: string | null;
    issuedAt: string | null;
    reason: string | null;
  }>;
}

interface DetailPayload {
  success: boolean;
  error?: string;
  paymentHistory?: LedgerEntry[];
  creditSource?: CreditSource;
}

type ActionId =
  | "approve_refund"
  | "issue_refund"
  | "apply_to_balance"
  | "dispute_refund"
  | "mark_complete";

const SERVER_FILTER_KEYS = [
  "client",
  "clinician",
  "payer",
  "practice",
  "dosFrom",
  "dosTo",
  "status",
  "assignedBiller",
  "minAmount",
  "maxAmount",
  "agingBucket",
  "carcRarc",
  "priority",
  "followUpDue",
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────

function getOrganizationId(): string {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

function shortId(id: string | null): string {
  if (!id) return "—";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildQuery(orgId: string, filters: Record<string, string>): string {
  const p = new URLSearchParams({ organizationId: orgId });
  for (const k of SERVER_FILTER_KEYS) {
    const v = filters[k];
    if (v && String(v).trim()) p.set(k, String(v).trim());
  }
  return p.toString();
}

const queueDef = getWorkqueue("refund_requests");

// ─── Action modal ─────────────────────────────────────────────────────────

interface ModalState {
  row: RefundRow;
  action: ActionId;
}

const MODAL_COPY: Record<ActionId, { title: string; prompt: string; reasonRequired: boolean }> = {
  approve_refund: {
    title: "Approve refund",
    prompt: "Confirm this refund is approved and ready to be issued.",
    reasonRequired: false,
  },
  issue_refund: {
    title: "Issue refund",
    prompt: "Record that the refund has been issued (Stripe, check, etc.).",
    reasonRequired: false,
  },
  apply_to_balance: {
    title: "Apply credit to balance",
    prompt:
      "Apply this credit to the client's outstanding balance instead of refunding. This cancels the refund record.",
    reasonRequired: false,
  },
  dispute_refund: {
    title: "Dispute refund",
    prompt: "Cancel this refund and record the dispute reason.",
    reasonRequired: true,
  },
  mark_complete: {
    title: "Mark complete",
    prompt:
      "Mark this refund as complete (use when the refund was processed outside the system).",
    reasonRequired: false,
  },
};

function ActionModal({
  state,
  busy,
  onClose,
  onSubmit,
}: {
  state: ModalState;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const copy = MODAL_COPY[state.action];
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
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
        <h2 style={{ margin: "0 0 8px", fontSize: 17 }}>{copy.title}</h2>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          {copy.prompt}
        </p>
        <div
          style={{
            background: "#F8FAFC",
            border: "1px solid #E2E8F0",
            padding: 10,
            borderRadius: 6,
            margin: "12px 0",
            fontSize: 12.5,
            color: "#0F172A",
          }}
        >
          <div>
            <strong>{state.row.clientName}</strong> · {state.row.payerOrClient}
          </div>
          <div style={{ marginTop: 4, color: "#475569" }}>
            Credit{" "}
            <span style={{ fontWeight: 600, color: "#B45309" }}>
              {money(state.row.creditAmount)}
            </span>{" "}
            · Status {statusLabel(state.row.status)}
          </div>
        </div>
        <label style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
          {copy.reasonRequired ? "Reason (required)" : "Notes (optional)"}
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          autoFocus
          placeholder={
            copy.reasonRequired ? "Required" : "Optional context"
          }
          style={{
            marginTop: 4,
            width: "100%",
            padding: 8,
            border: "1px solid #D1D5DB",
            borderRadius: 4,
            fontFamily: "inherit",
            boxSizing: "border-box",
          }}
        />
        {err ? (
          <div style={{ color: "#B91C1C", fontSize: 13, marginTop: 6 }}>
            {err}
          </div>
        ) : null}
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
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              if (copy.reasonRequired && !reason.trim()) {
                setErr("A reason is required");
                return;
              }
              onSubmit(reason.trim());
            }}
            disabled={busy}
          >
            {busy ? "Working…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function RefundsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<RefundRow[]>([]);
  const [facets, setFacets] = useState<Facets>({
    payers: [],
    practices: [],
    clinicians: [],
    staff: [],
  });
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("payer_refunds");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [detailData, setDetailData] = useState<DetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const queryString = useMemo(
    () => buildQuery(organizationId, filterValues),
    [organizationId, filterValues],
  );

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/refunds?${queryString}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as ListPayload;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load refunds");
      }
      setRows(json.rows ?? []);
      if (json.facets) setFacets(json.facets);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load refunds");
    } finally {
      setLoading(false);
    }
  }, [organizationId, queryString]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Detail fetch (ledger + credit source) ──────────────────────────────
  useEffect(() => {
    if (!selectedRowId || !organizationId) {
      setDetailData(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    setDetailData(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/billing/refunds/${encodeURIComponent(
            selectedRowId,
          )}?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const json = (await res.json()) as DetailPayload;
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Failed to load detail");
        }
        setDetailData(json);
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return;
        setDetailError(
          e instanceof Error ? e.message : "Failed to load detail",
        );
      } finally {
        setDetailLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selectedRowId, organizationId]);

  // ── Tabs ───────────────────────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const counts: Record<Tab, number> = {
      payer_refunds: 0,
      patient_refunds: 0,
      credit_balance_review: 0,
      offset_requested: 0,
      refund_completed: 0,
    };
    for (const r of rows) counts[r.tab] += 1;
    return counts;
  }, [rows]);

  const tabRows = useMemo(
    () => rows.filter((r) => r.tab === activeTab),
    [rows, activeTab],
  );

  const primaryTabs: PrimaryTab[] = useMemo(
    () => TABS.map((t) => ({ id: t.id, label: t.label, count: tabCounts[t.id] })),
    [tabCounts],
  );

  // ── Summary metrics ────────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const count = tabRows.length;
    const dollars =
      Math.round(tabRows.reduce((s, r) => s + (r.creditAmount || 0), 0) * 100) /
      100;
    const oldest =
      tabRows.length === 0 ? 0 : Math.max(...tabRows.map((r) => r.ageDays));
    const urgent = tabRows.filter(
      (r) => r.priority === "urgent" || r.priority === "high",
    ).length;
    return [
      { id: "count", label: "Total items", value: count.toLocaleString() },
      {
        id: "dollars",
        label: "Total amount",
        value: money(dollars),
        tone: dollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: oldest,
        tone: oldest > 60 ? "red" : oldest > 30 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: urgent,
        tone: urgent > 0 ? "red" : "default",
      },
    ];
  }, [tabRows]);

  // ── Filter rail (universal) ────────────────────────────────────────────
  const filters: FilterDef[] = useMemo(
    () => [
      { id: "client", label: "Client", kind: "text", placeholder: "Name…" },
      {
        id: "practice",
        label: "Practice",
        kind: "select",
        options: facets.practices.map((p) => ({ value: p.id, label: p.name })),
      },
      {
        id: "clinician",
        label: "Clinician",
        kind: "select",
        options: facets.clinicians.map((c) => ({ value: c, label: c })),
      },
      {
        id: "payer",
        label: "Payer",
        kind: "select",
        options: facets.payers.map((p) => ({ value: p.id, label: p.name })),
      },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "pending", label: "Pending" },
          { value: "issued", label: "Issued" },
          { value: "failed", label: "Failed" },
          { value: "cancelled", label: "Cancelled" },
          { value: "needs_review", label: "Needs review" },
          { value: "offset_pending", label: "Offset pending" },
          { value: "offset_applied", label: "Offset applied" },
        ],
      },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "text",
        placeholder: "Name…",
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
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 22" },
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
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [facets],
  );

  // ── Columns (spec order, exact labels) ─────────────────────────────────
  const columns: ColumnDef<RefundRow>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.clientName },
      {
        id: "payerOrClient",
        header: "Payer/patient",
        cell: (r) => (
          <span>
            {r.payerOrClient}{" "}
            <span
              style={{
                fontSize: 11,
                color: r.payerType === "client" ? "#0369A1" : "#475569",
                marginLeft: 4,
              }}
            >
              ({r.payerType})
            </span>
          </span>
        ),
      },
      {
        id: "claim",
        header: "Claim ID",
        cell: (r) => (
          <span
            style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}
            title={r.professionalClaimId ?? ""}
          >
            {r.claimNumber ?? shortId(r.professionalClaimId)}
          </span>
        ),
      },
      {
        id: "creditAmount",
        header: "Credit amount",
        align: "right",
        cell: (r) => (
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              fontWeight: 600,
              color: "#B45309",
            }}
          >
            {money(r.creditAmount)}
          </span>
        ),
      },
      {
        id: "reason",
        header: "Reason",
        cell: (r) => (
          <span
            style={{ color: "#475569", fontSize: 12.5 }}
            title={r.reason ?? ""}
          >
            {r.reason
              ? r.reason.length > 60
                ? `${r.reason.slice(0, 57)}…`
                : r.reason
              : "—"}
          </span>
        ),
      },
      {
        id: "refundDueDate",
        header: "Refund due date",
        cell: (r) => {
          const overdue =
            r.refundDueDate && r.refundDueDate < new Date().toISOString().slice(0, 10);
          return (
            <span style={{ color: overdue ? "#B91C1C" : "#0F172A" }}>
              {formatDate(r.refundDueDate)}
            </span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        cell: (r) => (
          <span
            style={{
              textTransform: "uppercase",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.4,
              color:
                r.status === "issued"
                  ? "#15803D"
                  : r.status === "failed"
                    ? "#B91C1C"
                    : r.status === "cancelled"
                      ? "#6B7280"
                      : "#B45309",
            }}
          >
            {statusLabel(r.status)}
          </span>
        ),
      },
      {
        id: "assignedTo",
        header: "Assigned to",
        cell: (r) =>
          r.assignedToName ?? (
            <span style={{ color: "#9CA3AF" }}>Unassigned</span>
          ),
      },
    ],
    [],
  );

  // ── Run action ─────────────────────────────────────────────────────────
  const runAction = useCallback(
    async (row: RefundRow, action: ActionId, reason: string) => {
      setBusyAction(`${row.id}::${action}`);
      setError(null);
      setSuccess(null);
      try {
        const res = await fetch(
          `/api/billing/refunds/${encodeURIComponent(row.id)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId, action, reason }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Action failed");
        }

        setSuccess(MODAL_COPY[action].title + " — done");
        // Always pull fresh canonical state from the server — ERA rows
        // morph into refund rows after the first action, and recoupment
        // rows get archived. An optimistic patch would lie about those
        // transitions.
        setSelectedRowId(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusyAction(null);
        setModal(null);
      }
    },
    [organizationId, load],
  );

  const openModal = useCallback((row: RefundRow, action: ActionId) => {
    setModal({ row, action });
  }, []);

  // ── Row actions (spec) ─────────────────────────────────────────────────
  const rowActions: RowAction<RefundRow>[] = useMemo(
    () => [
      {
        id: "approve_refund",
        label: "Approve refund",
        variant: "primary",
        onClick: (r) => openModal(r, "approve_refund"),
        disabled: (r) =>
          r.status === "issued" ||
          r.status === "cancelled" ||
          r.tab === "offset_requested",
      },
      {
        id: "issue_refund",
        label: "Issue refund",
        variant: "success",
        onClick: (r) => openModal(r, "issue_refund"),
        disabled: (r) =>
          r.status === "issued" ||
          r.status === "cancelled" ||
          r.tab === "offset_requested" ||
          r.tab === "credit_balance_review",
      },
      {
        id: "apply_to_balance",
        label: "Apply to balance",
        onClick: (r) => openModal(r, "apply_to_balance"),
        disabled: (r) =>
          r.payerType !== "client" && r.tab !== "credit_balance_review",
      },
      {
        id: "dispute_refund",
        label: "Dispute refund",
        variant: "danger",
        onClick: (r) => openModal(r, "dispute_refund"),
        disabled: (r) => r.status === "cancelled" || r.status === "issued",
      },
      {
        id: "mark_complete",
        label: "Mark complete",
        onClick: (r) => openModal(r, "mark_complete"),
        disabled: (r) => r.status === "issued" || r.status === "cancelled",
      },
    ],
    [openModal],
  );

  // ── Detail panel (spec sections) ──────────────────────────────────────
  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "payment_history",
        label: "Payment history",
        render: () => {
          if (!selectedRow) return null;
          return (
            <div style={{ fontSize: 13, color: "#0F172A" }}>
              <SectionTitle>Payment history</SectionTitle>
              <KV
                label="Claim"
                value={
                  selectedRow.claimNumber ??
                  shortId(selectedRow.professionalClaimId)
                }
              />
              <KV
                label="Service date"
                value={formatDate(selectedRow.serviceDate)}
              />
              <KV
                label="Client"
                value={selectedRow.clientName}
              />
              <PaymentLedger
                loading={detailLoading}
                error={detailError}
                entries={detailData?.paymentHistory ?? []}
                currentRowId={selectedRowId}
                onSelectRefundRow={(id) => {
                  const target = rows.find((r) => r.id === id);
                  if (target && target.tab !== activeTab) {
                    setActiveTab(target.tab);
                  }
                  setSelectedRowId(id);
                  if (typeof window !== "undefined") {
                    window.requestAnimationFrame(() => {
                      const el = document.getElementById(`wqrow-${id}`);
                      if (el)
                        el.scrollIntoView({
                          behavior: "smooth",
                          block: "center",
                        });
                    });
                  }
                }}
              />
            </div>
          );
        },
      },
      {
        id: "credit_source",
        label: "Credit source",
        render: () => {
          if (!selectedRow) return null;
          const sourceLabel =
            selectedRow.source === "payment_refund"
              ? "Refund record (payment_refunds)"
              : selectedRow.source === "payment_recoupment"
                ? "Payer recoupment (payment_recoupments)"
                : "ERA overpayment (era_claim_payments)";
          return (
            <div style={{ fontSize: 13 }}>
              <SectionTitle>Credit source</SectionTitle>
              <KV label="Source" value={sourceLabel} />
              <KV
                label="Type"
                value={
                  selectedRow.payerType === "client"
                    ? "Client refund"
                    : "Payer refund"
                }
              />
              <CreditSourceDetail
                loading={detailLoading}
                error={detailError}
                source={detailData?.creditSource ?? null}
              />
            </div>
          );
        },
      },
      {
        id: "refund_request",
        label: "Refund request",
        render: () => {
          if (!selectedRow) return null;
          return (
            <div style={{ fontSize: 13 }}>
              <SectionTitle>Refund request</SectionTitle>
              <KV label="Amount" value={money(selectedRow.creditAmount)} />
              <KV label="Reason" value={selectedRow.reason ?? "—"} />
              <KV label="Status" value={statusLabel(selectedRow.status)} />
              <KV label="Priority" value={selectedRow.priority} />
              <KV
                label="Refund due date"
                value={formatDate(selectedRow.refundDueDate)}
              />
              <KV
                label="Assigned to"
                value={selectedRow.assignedToName ?? "Unassigned"}
              />
            </div>
          );
        },
      },
      {
        id: "overpayment_calc",
        label: "Overpayment calculation",
        render: () => {
          if (!selectedRow) return null;
          return (
            <div style={{ fontSize: 13 }}>
              <SectionTitle>Overpayment calculation</SectionTitle>
              <p style={{ color: "#475569", marginTop: 0 }}>
                Credit balance for this row.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <tbody>
                  <tr style={{ borderTop: "1px solid #E2E8F0" }}>
                    <td style={{ padding: "6px 4px", color: "#475569" }}>Credit / overpayment</td>
                    <td style={{ padding: "6px 4px", textAlign: "right", fontWeight: 600 }}>
                      {money(selectedRow.creditAmount)}
                    </td>
                  </tr>
                  <tr style={{ borderTop: "1px solid #E2E8F0" }}>
                    <td style={{ padding: "6px 4px", color: "#475569" }}>Refund proposed</td>
                    <td style={{ padding: "6px 4px", textAlign: "right" }}>
                      {selectedRow.refundId ? money(selectedRow.creditAmount) : "—"}
                    </td>
                  </tr>
                  <tr style={{ borderTop: "1px solid #E2E8F0" }}>
                    <td style={{ padding: "6px 4px", color: "#475569" }}>Net owed back</td>
                    <td style={{ padding: "6px 4px", textAlign: "right", fontWeight: 600 }}>
                      {money(selectedRow.creditAmount)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          );
        },
      },
    ],
    [selectedRow, detailData, detailLoading, detailError],
  );

  // ── Detail panel actions ───────────────────────────────────────────────
  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    return [
      {
        id: "approve",
        label: "Approve refund",
        variant: "primary",
        onClick: () => openModal(selectedRow, "approve_refund"),
        disabled:
          selectedRow.status === "issued" ||
          selectedRow.status === "cancelled" ||
          selectedRow.tab === "offset_requested",
      },
      {
        id: "issue",
        label: "Issue refund",
        variant: "success",
        onClick: () => openModal(selectedRow, "issue_refund"),
        disabled:
          selectedRow.status === "issued" ||
          selectedRow.status === "cancelled" ||
          selectedRow.tab === "offset_requested" ||
          selectedRow.tab === "credit_balance_review",
      },
      {
        id: "apply",
        label: "Apply to balance",
        onClick: () => openModal(selectedRow, "apply_to_balance"),
        disabled:
          selectedRow.payerType !== "client" &&
          selectedRow.tab !== "credit_balance_review",
      },
      {
        id: "dispute",
        label: "Dispute refund",
        variant: "danger",
        onClick: () => openModal(selectedRow, "dispute_refund"),
        disabled:
          selectedRow.status === "cancelled" || selectedRow.status === "issued",
      },
      {
        id: "complete",
        label: "Mark complete",
        onClick: () => openModal(selectedRow, "mark_complete"),
        disabled:
          selectedRow.status === "issued" || selectedRow.status === "cancelled",
      },
    ];
  }, [selectedRow, openModal]);

  const headerActions: PrimaryAction[] = useMemo(
    () => [{ id: "refresh", label: "Refresh", onClick: () => void load() }],
    [load],
  );

  return (
    <>
      <WorkqueueShell<RefundRow>
        title={queueDef?.title ?? "Refund / Overpayment"}
        description={queueDef?.description}
        headerActions={headerActions}
        summary={summary}
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTab}
        onPrimaryTabChange={(id) => setActiveTab(id as Tab)}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace="refunds"
        rows={tabRows}
        columns={columns}
        rowId={(r) => r.id}
        loading={loading}
        emptyMessage="No items in this tab."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        rowActions={rowActions}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={
          error
            ? { tone: "error", text: error }
            : success
              ? { tone: "success", text: success }
              : null
        }
      />
      {modal ? (
        <ActionModal
          state={modal}
          busy={busyAction !== null}
          onClose={() => setModal(null)}
          onSubmit={(reason) => runAction(modal.row, modal.action, reason)}
        />
      ) : null}
    </>
  );
}

// ─── Helper components ───────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        margin: "4px 0 10px",
        fontSize: 13,
        fontWeight: 600,
        color: "#0F172A",
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      {children}
    </h3>
  );
}

function ledgerKindLabel(kind: LedgerEntry["kind"]): string {
  switch (kind) {
    case "era_posting":
      return "ERA";
    case "client_payment":
      return "Payment";
    case "patient_invoice_payment":
      return "Client invoice";
    case "refund":
      return "Refund";
  }
}

function ledgerKindColor(kind: LedgerEntry["kind"]): string {
  switch (kind) {
    case "era_posting":
      return "#0369A1";
    case "client_payment":
      return "#15803D";
    case "patient_invoice_payment":
      return "#7C3AED";
    case "refund":
      return "#B45309";
  }
}

function PaymentLedger({
  loading,
  error,
  entries,
  currentRowId,
  onSelectRefundRow,
}: {
  loading: boolean;
  error: string | null;
  entries: LedgerEntry[];
  currentRowId: string | null;
  onSelectRefundRow: (id: string) => void;
}) {
  if (loading) {
    return (
      <p style={{ marginTop: 12, color: "#64748B", fontSize: 12.5 }}>
        Loading payment ledger…
      </p>
    );
  }
  if (error) {
    return (
      <p style={{ marginTop: 12, color: "#B91C1C", fontSize: 12.5 }}>
        Could not load ledger: {error}
      </p>
    );
  }
  if (entries.length === 0) {
    return (
      <p style={{ marginTop: 12, color: "#64748B", fontSize: 12.5 }}>
        No posted payments, adjustments, or refunds were found for this claim.
      </p>
    );
  }
  const total =
    Math.round(entries.reduce((s, e) => s + (e.amount || 0), 0) * 100) / 100;
  return (
    <div style={{ marginTop: 12 }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12.5,
        }}
      >
        <thead>
          <tr style={{ textAlign: "left", color: "#64748B" }}>
            <th style={{ padding: "4px 4px", fontWeight: 600 }}>Date</th>
            <th style={{ padding: "4px 4px", fontWeight: 600 }}>Type</th>
            <th style={{ padding: "4px 4px", fontWeight: 600 }}>Detail</th>
            <th style={{ padding: "4px 4px", fontWeight: 600 }}>Status</th>
            <th
              style={{
                padding: "4px 4px",
                fontWeight: 600,
                textAlign: "right",
              }}
            >
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const isRefundJump = e.kind === "refund" && e.id !== currentRowId;
            const clickable = Boolean(e.href) || isRefundJump;
            const handleClick = clickable
              ? () => {
                  if (e.href) {
                    if (typeof window !== "undefined") {
                      window.open(e.href, "_blank", "noopener,noreferrer");
                    }
                  } else if (isRefundJump) {
                    onSelectRefundRow(e.id);
                  }
                }
              : undefined;
            const titleText = e.href
              ? "Open source payment in a new tab"
              : isRefundJump
                ? "Jump to this refund row"
                : undefined;
            return (
              <tr
                key={e.id}
                onClick={handleClick}
                title={titleText}
                style={{
                  borderTop: "1px solid #E2E8F0",
                  cursor: clickable ? "pointer" : "default",
                }}
              >
                <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                  {formatDate(e.postedAt)}
                </td>
                <td style={{ padding: "6px 4px" }}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "1px 6px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 600,
                      color: "#fff",
                      background: ledgerKindColor(e.kind),
                    }}
                  >
                    {ledgerKindLabel(e.kind)}
                  </span>
                </td>
                <td style={{ padding: "6px 4px", color: "#334155" }}>
                  {e.href ? (
                    <a
                      href={e.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(ev) => ev.stopPropagation()}
                      style={{
                        color: "#1D4ED8",
                        textDecoration: "underline",
                      }}
                    >
                      {e.description || "—"}
                    </a>
                  ) : isRefundJump ? (
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onSelectRefundRow(e.id);
                      }}
                      style={{
                        background: "none",
                        border: 0,
                        padding: 0,
                        color: "#1D4ED8",
                        textDecoration: "underline",
                        cursor: "pointer",
                        font: "inherit",
                        textAlign: "left",
                      }}
                    >
                      {e.description || "—"}
                    </button>
                  ) : (
                    e.description || "—"
                  )}
                </td>
                <td style={{ padding: "6px 4px", color: "#475569" }}>
                  {e.status ? statusLabel(e.status) : "—"}
                </td>
                <td
                  style={{
                    padding: "6px 4px",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    fontWeight: 600,
                    color: e.amount < 0 ? "#B45309" : "#0F172A",
                  }}
                >
                  {money(e.amount)}
                </td>
              </tr>
            );
          })}
          <tr style={{ borderTop: "2px solid #CBD5E1", background: "#F8FAFC" }}>
            <td colSpan={4} style={{ padding: "6px 4px", fontWeight: 600 }}>
              Net posted
            </td>
            <td
              style={{
                padding: "6px 4px",
                textAlign: "right",
                fontVariantNumeric: "tabular-nums",
                fontWeight: 700,
              }}
            >
              {money(total)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function CreditSourceDetail({
  loading,
  error,
  source,
}: {
  loading: boolean;
  error: string | null;
  source: CreditSource | null;
}) {
  if (loading) {
    return (
      <p style={{ marginTop: 12, color: "#64748B", fontSize: 12.5 }}>
        Loading credit source…
      </p>
    );
  }
  if (error) {
    return (
      <p style={{ marginTop: 12, color: "#B91C1C", fontSize: 12.5 }}>
        Could not load credit source: {error}
      </p>
    );
  }
  if (!source || source.kind === "none") {
    return (
      <p style={{ marginTop: 12, color: "#64748B", fontSize: 12.5 }}>
        No originating ERA or client payment is linked to this credit.
      </p>
    );
  }
  return (
    <div style={{ marginTop: 12 }}>
      {source.era ? (
        <>
          <SectionTitle>ERA payment ({shortId(source.era.id)})</SectionTitle>
          <KV
            label="Check / EFT"
            value={source.era.checkEftNumber ?? "—"}
          />
          <KV
            label="Check date"
            value={formatDate(source.era.checkIssueDate)}
          />
          <KV
            label="Payer claim #"
            value={source.era.payerClaimControlNumber ?? "—"}
          />
          <KV
            label="Total charge"
            value={money(source.era.totalCharge)}
          />
          <KV
            label="Payer paid"
            value={money(source.era.paymentAmount)}
          />
          <KV
            label="Client responsibility"
            value={money(source.era.patientResponsibility)}
          />
          {source.era.allowedAmount != null ? (
            <KV label="Allowed" value={money(source.era.allowedAmount)} />
          ) : null}
          {source.era.carcCodes.length > 0 ? (
            <KV
              label="CARC codes"
              value={source.era.carcCodes.join(", ")}
            />
          ) : null}
          {source.era.rarcCodes.length > 0 ? (
            <KV
              label="RARC codes"
              value={source.era.rarcCodes.join(", ")}
            />
          ) : null}
          {source.era.casAdjustments.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <SectionTitle>CARC/RARC breakdown</SectionTitle>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12.5,
                }}
              >
                <thead>
                  <tr style={{ textAlign: "left", color: "#64748B" }}>
                    <th style={{ padding: "4px 4px", fontWeight: 600 }}>
                      Group
                    </th>
                    <th style={{ padding: "4px 4px", fontWeight: 600 }}>
                      Reason
                    </th>
                    <th
                      style={{
                        padding: "4px 4px",
                        fontWeight: 600,
                        textAlign: "right",
                      }}
                    >
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {source.era.casAdjustments.map((c, idx) => (
                    <tr
                      key={`${c.groupCode}-${c.reasonCode}-${idx}`}
                      style={{ borderTop: "1px solid #E2E8F0" }}
                    >
                      <td style={{ padding: "6px 4px" }}>
                        {c.groupCode || "—"}
                      </td>
                      <td style={{ padding: "6px 4px" }}>
                        {c.reasonCode || "—"}
                      </td>
                      <td
                        style={{
                          padding: "6px 4px",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 600,
                        }}
                      >
                        {money(c.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : source.clientPayment ? (
        <>
          <SectionTitle>
            Client payment ({shortId(source.clientPayment.id)})
          </SectionTitle>
          <KV label="Amount" value={money(source.clientPayment.amount)} />
          <KV
            label="Posted at"
            value={formatDate(source.clientPayment.postedAt)}
          />
          <KV
            label="Method"
            value={source.clientPayment.method ?? "—"}
          />
          <KV
            label="Reference"
            value={source.clientPayment.referenceNumber ?? "—"}
          />
          {source.clientPayment.sourceLabel ? (
            <KV label="Source" value={source.clientPayment.sourceLabel} />
          ) : null}
        </>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <SectionTitle>Prior refunds tied to this source</SectionTitle>
        {source.priorRefunds.length === 0 ? (
          <p style={{ color: "#64748B", fontSize: 12.5, margin: 0 }}>
            No other refunds reference this payment.
          </p>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 12.5,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "#64748B" }}>
                <th style={{ padding: "4px 4px", fontWeight: 600 }}>
                  Requested
                </th>
                <th style={{ padding: "4px 4px", fontWeight: 600 }}>Issued</th>
                <th style={{ padding: "4px 4px", fontWeight: 600 }}>Status</th>
                <th style={{ padding: "4px 4px", fontWeight: 600 }}>Reason</th>
                <th
                  style={{
                    padding: "4px 4px",
                    fontWeight: 600,
                    textAlign: "right",
                  }}
                >
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {source.priorRefunds.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #E2E8F0" }}>
                  <td style={{ padding: "6px 4px" }}>
                    {formatDate(r.requestedAt)}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {formatDate(r.issuedAt)}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {statusLabel(r.status)}
                  </td>
                  <td style={{ padding: "6px 4px", color: "#475569" }}>
                    {r.reason ?? "—"}
                  </td>
                  <td
                    style={{
                      padding: "6px 4px",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                    }}
                  >
                    {money(r.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "6px 0",
        borderTop: "1px solid #F1F5F9",
        fontSize: 13,
      }}
    >
      <span style={{ color: "#64748B" }}>{label}</span>
      <span style={{ color: "#0F172A", textAlign: "right" }}>{value}</span>
    </div>
  );
}
