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
import { ClaimDocumentsPanel } from "@/components/billing/ClaimDocumentsPanel";

type Tab =
  | "commercial"
  | "medicaid"
  | "contract_variance"
  | "missing_modifier"
  | "partial_payment";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "commercial", label: "Commercial Underpayments" },
  { id: "medicaid", label: "Medicaid Underpayments" },
  { id: "contract_variance", label: "Contract Variance" },
  { id: "missing_modifier", label: "Missing Modifier Payment" },
  { id: "partial_payment", label: "Partial Payment Review" },
];

interface UnderpaymentRow {
  id: string;
  tabs: Tab[];
  eraPaymentId: string;
  lineIndex: number;
  professionalClaimId: string | null;
  claimNumber: string | null;
  clientId: string | null;
  clientName: string;
  clinician: string;
  payerId: string | null;
  payerName: string;
  payerType: "medicaid" | "medicare" | "commercial" | "other" | null;
  procedureCode: string;
  modifiers: string[];
  allowedExpected: number;
  allowedPaid: number;
  paidAmount: number;
  patientResponsibility: number;
  variance: number;
  paidDate: string | null;
  dos: string | null;
  contractSource: string;
  contractId: string | null;
  feeScheduleId: string | null;
  carcCodes: string[];
  rarcCodes: string[];
  status: string;
  createdAt: string | null;
  priority: "high" | "medium" | "low";
  suggestion: {
    kind: "repeated_payment";
    adoptAmount: number;
    sampleCount: number;
    groupKey: string;
    similarRowIds: string[];
  } | null;
}

interface Facets {
  payers: Array<{ id: string; name: string }>;
  practices: Array<{ id: string; name: string }>;
  clinicians: string[];
}

interface ListPayload {
  success: boolean;
  error?: string;
  rows?: UnderpaymentRow[];
  facets?: Facets;
}

type ActionId =
  | "create_appeal"
  | "request_reprocessing"
  | "mark_accepted"
  | "update_contract_rate"
  | "add_payer_rule";

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

function ageDays(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 3600 * 1000)));
}

function shortId(id: string | null): string {
  if (!id) return "—";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

const queueDef = getWorkqueue("underpayments");

function buildQuery(orgId: string, filters: Record<string, string>): string {
  const p = new URLSearchParams({ organizationId: orgId });
  for (const k of SERVER_FILTER_KEYS) {
    const v = filters[k];
    if (v && String(v).trim()) p.set(k, String(v).trim());
  }
  return p.toString();
}

// ─── Action modal ──────────────────────────────────────────────────────────

interface ModalState {
  action: ActionId;
  row: UnderpaymentRow;
}

function ActionModal({
  state,
  busy,
  onClose,
  onSubmit,
}: {
  state: ModalState;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: {
    reason: string;
    allowedAmount?: number;
    ruleText?: string;
  }) => void;
}) {
  const { action, row } = state;
  const copy = MODAL_COPY[action];
  const needsReason =
    action === "create_appeal" || action === "request_reprocessing";
  const needsAllowed = action === "update_contract_rate";
  const needsRule = action === "add_payer_rule";

  const [reason, setReason] = useState("");
  const [allowed, setAllowed] = useState<string>(
    needsAllowed ? row.allowedExpected.toFixed(2) : "",
  );
  const [rule, setRule] = useState("");
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
          width: 540,
          maxWidth: "92vw",
          borderRadius: 8,
          padding: 24,
          boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
        }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 17 }}>{copy.title}</h2>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>{copy.prompt}</p>

        <div
          style={{
            background: "#F8FAFC",
            border: "1px solid #E2E8F0",
            padding: 10,
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 12.5,
            color: "#0F172A",
          }}
        >
          <div>
            <strong>{row.clientName}</strong> · {row.payerName} · CPT{" "}
            <span style={{ fontFamily: "ui-monospace, monospace" }}>
              {row.procedureCode}
              {row.modifiers.length ? `-${row.modifiers.join("-")}` : ""}
            </span>
          </div>
          <div style={{ marginTop: 4, color: "#475569" }}>
            Expected {money(row.allowedExpected)} · Paid allowed{" "}
            {money(row.allowedPaid)} · Variance{" "}
            <span style={{ color: "#B91C1C" }}>{money(row.variance)}</span>
          </div>
        </div>

        {needsAllowed ? (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
              New allowed amount (contract rate)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={allowed}
              onChange={(e) => setAllowed(e.target.value)}
              autoFocus
              style={{
                marginTop: 4,
                width: "100%",
                padding: 8,
                border: "1px solid #D1D5DB",
                borderRadius: 4,
                boxSizing: "border-box",
              }}
            />
          </div>
        ) : null}

        {needsRule ? (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
              Payer rule (free-form)
            </label>
            <textarea
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              rows={3}
              autoFocus
              placeholder="e.g. Requires 95 modifier with 25% uplift on telehealth"
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
          </div>
        ) : null}

        <label style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
          {needsReason ? "Reason / notes (required)" : "Notes (optional)"}
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          autoFocus={!needsAllowed && !needsRule}
          placeholder={
            needsReason
              ? "Required — explain the appeal / reprocessing basis"
              : "Optional context"
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
          <div style={{ color: "#B91C1C", fontSize: 13, marginTop: 6 }}>{err}</div>
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
              if (needsReason && !reason.trim()) {
                setErr("A reason is required");
                return;
              }
              if (needsRule && !rule.trim()) {
                setErr("Rule text is required");
                return;
              }
              if (needsAllowed) {
                const n = Number(allowed);
                if (!Number.isFinite(n) || n < 0) {
                  setErr("Allowed amount must be a non-negative number");
                  return;
                }
                onSubmit({ reason: reason.trim(), allowedAmount: n });
                return;
              }
              if (needsRule) {
                onSubmit({ reason: reason.trim(), ruleText: rule.trim() });
                return;
              }
              onSubmit({ reason: reason.trim() });
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

// ─── Component ─────────────────────────────────────────────────────────────

export default function UnderpaymentsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<UnderpaymentRow[]>([]);
  const [facets, setFacets] = useState<Facets>({
    payers: [],
    practices: [],
    clinicians: [],
  });
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("commercial");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);

  const queryString = useMemo(
    () => buildQuery(organizationId, filterValues),
    [organizationId, filterValues],
  );

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/underpayments?${queryString}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as ListPayload;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load underpayments");
      }
      setRows(json.rows ?? []);
      if (json.facets) setFacets(json.facets);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load underpayments");
    } finally {
      setLoading(false);
    }
  }, [organizationId, queryString]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Filters (universal) ────────────────────────────────────────────────
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
        label: "Claim status",
        kind: "select",
        options: [
          { value: "paid", label: "Paid" },
          { value: "partially_paid", label: "Partially paid" },
          { value: "denied", label: "Denied" },
          { value: "accepted", label: "Accepted" },
        ],
      },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "text",
        placeholder: "Name or email…",
      },
      { id: "minAmount", label: "Min variance $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max variance $", kind: "number", placeholder: "0" },
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
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 45" },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
      },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [facets],
  );

  // ── Tab partitioning ────────────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const counts: Record<Tab, number> = {
      commercial: 0,
      medicaid: 0,
      contract_variance: 0,
      missing_modifier: 0,
      partial_payment: 0,
    };
    for (const r of rows) {
      for (const t of r.tabs) counts[t] += 1;
    }
    return counts;
  }, [rows]);

  const tabRows = useMemo(
    () => rows.filter((r) => r.tabs.includes(activeTab)),
    [rows, activeTab],
  );

  // ── Auto-suggest banners (Contract Variance only) ──────────────────────
  // Cluster contract-variance rows by their suggestion.groupKey, then pick a
  // representative row per cluster (the one whose payer contract / fee
  // schedule the API can resolve, falling back to the first). Each cluster
  // renders one banner offering to adopt the repeated paid amount as the
  // new contracted rate.
  const suggestionClusters = useMemo(() => {
    if (activeTab !== "contract_variance") return [];
    const byKey = new Map<
      string,
      {
        groupKey: string;
        adoptAmount: number;
        sampleCount: number;
        rowIds: string[];
        representative: UnderpaymentRow;
        payerName: string;
        procedureCode: string;
        modifiers: string[];
      }
    >();
    for (const r of tabRows) {
      if (!r.suggestion) continue;
      const key = r.suggestion.groupKey;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          groupKey: key,
          adoptAmount: r.suggestion.adoptAmount,
          sampleCount: r.suggestion.sampleCount,
          rowIds: [...r.suggestion.similarRowIds],
          representative: r,
          payerName: r.payerName,
          procedureCode: r.procedureCode,
          modifiers: r.modifiers,
        });
      } else if (!existing.representative.feeScheduleId && r.feeScheduleId) {
        // Prefer a row that already has a fee schedule the API can update.
        existing.representative = r;
      }
    }
    return [...byKey.values()].sort((a, b) => b.sampleCount - a.sampleCount);
  }, [tabRows, activeTab]);

  // ── Summary metrics ─────────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const total = tabRows.length;
    const dollars = tabRows.reduce((s, r) => s + (r.variance || 0), 0);
    const ages = tabRows
      .map((r) => ageDays(r.paidDate ?? r.createdAt))
      .filter((n): n is number => n != null);
    const oldest = ages.length > 0 ? Math.max(...ages) : 0;
    const urgent = tabRows.filter((r) => r.priority === "high").length;
    return [
      { id: "count", label: "Total lines", value: total.toLocaleString() },
      {
        id: "dollars",
        label: "Variance ($)",
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

  // ── Columns (spec order, exact labels) ──────────────────────────────────
  const columns: ColumnDef<UnderpaymentRow>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.clientName },
      {
        id: "claim",
        header: "Claim ID",
        cell: (r) => (
          <span
            style={{ fontFamily: "ui-monospace, monospace" }}
            title={r.professionalClaimId ?? "—"}
          >
            {r.claimNumber ? r.claimNumber : shortId(r.professionalClaimId)}
          </span>
        ),
      },
      { id: "payer", header: "Payer", cell: (r) => r.payerName },
      {
        id: "code",
        header: "Code",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>
            {r.procedureCode}
            {r.modifiers.length ? (
              <span style={{ color: "#64748B" }}>
                {" "}
                · {r.modifiers.join(", ")}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "allowedExpected",
        header: "Allowed expected",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {money(r.allowedExpected)}
          </span>
        ),
      },
      {
        id: "allowedPaid",
        header: "Allowed paid",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {money(r.allowedPaid)}
          </span>
        ),
      },
      {
        id: "variance",
        header: "Variance",
        align: "right",
        cell: (r) => (
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              color: r.variance > 0 ? "#B91C1C" : "#0F172A",
              fontWeight: 600,
            }}
          >
            {money(r.variance)}
          </span>
        ),
      },
      {
        id: "paidDate",
        header: "Paid date",
        cell: (r) => formatDate(r.paidDate),
      },
      {
        id: "contractSource",
        header: "Contract source",
        cell: (r) => (
          <span style={{ fontSize: 12.5 }}>
            {r.contractSource}
            {r.suggestion ? (
              <span
                title={`${r.suggestion.sampleCount} ERAs reimbursed ${money(r.suggestion.adoptAmount)} for this payer + CPT — fee schedule is likely stale.`}
                style={{
                  marginLeft: 6,
                  padding: "1px 6px",
                  borderRadius: 10,
                  background: "#FEF3C7",
                  color: "#92400E",
                  fontSize: 11,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                Stale rate?
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "priority",
        header: "Priority",
        cell: (r) => (
          <span
            style={{
              textTransform: "capitalize",
              fontWeight: 600,
              color:
                r.priority === "high"
                  ? "#B91C1C"
                  : r.priority === "medium"
                  ? "#B45309"
                  : "#475569",
            }}
          >
            {r.priority}
          </span>
        ),
      },
    ],
    [],
  );

  // ── Actions ─────────────────────────────────────────────────────────────
  const runAction = useCallback(
    async (
      row: UnderpaymentRow,
      action: ActionId,
      input: {
        reason?: string;
        allowedAmount?: number;
        ruleText?: string;
        acceptRowIds?: string[];
      },
    ) => {
      setBusyAction(`${row.id}::${action}`);
      setError(null);
      setSuccess(null);
      try {
        const res = await fetch(
          `/api/billing/underpayments/${encodeURIComponent(row.id)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              organizationId,
              action,
              reason: input.reason ?? null,
              allowedAmount: input.allowedAmount,
              ruleText: input.ruleText,
              feeScheduleId: row.feeScheduleId,
              payerContractId: row.contractId,
              payerProfileId: row.payerId,
              procedureCode: row.procedureCode,
              modifiers: row.modifiers,
              acceptRowIds: input.acceptRowIds,
            }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Action failed");
        }

        const archivedRows = Number(json.archivedRows ?? 0);
        const archiveSet = new Set<string>(input.acceptRowIds ?? []);
        archiveSet.add(row.id);

        // Optimistic update.
        setRows((prev) => {
          if (action === "mark_accepted") {
            return prev.filter((r) => r.id !== row.id);
          }
          if (action === "update_contract_rate" && input.allowedAmount != null) {
            const newExpected = input.allowedAmount;
            return prev
              .filter((r) => !(archiveSet.has(r.id) && r.id !== row.id))
              .map((r) => {
                if (r.id !== row.id) return r;
                const newVariance =
                  Math.round((newExpected - r.allowedPaid) * 100) / 100;
                return newVariance <= 0.5
                  ? null
                  : {
                      ...r,
                      allowedExpected: newExpected,
                      variance: newVariance,
                      suggestion: null,
                    };
              })
              .filter((r): r is UnderpaymentRow => r !== null);
          }
          return prev;
        });
        const baseMsg = actionSuccessLabel(action);
        setSuccess(
          archivedRows > 0
            ? `${baseMsg} Archived ${archivedRows} related row${archivedRows === 1 ? "" : "s"}.`
            : baseMsg,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusyAction(null);
        setModal(null);
      }
    },
    [organizationId],
  );

  const openModal = useCallback((row: UnderpaymentRow, action: ActionId) => {
    setModal({ action, row });
  }, []);

  const adoptSuggestion = useCallback(
    (cluster: {
      representative: UnderpaymentRow;
      adoptAmount: number;
      sampleCount: number;
      rowIds: string[];
    }) => {
      void runAction(cluster.representative, "update_contract_rate", {
        allowedAmount: cluster.adoptAmount,
        acceptRowIds: cluster.rowIds,
        reason: `Auto-adopted from ${cluster.sampleCount} repeated ERA payments at ${money(cluster.adoptAmount)}.`,
      });
    },
    [runAction],
  );

  const rowActions: RowAction<UnderpaymentRow>[] = useMemo(
    () => [
      {
        id: "appeal",
        label: "Create underpayment appeal",
        variant: "primary",
        onClick: (r) => openModal(r, "create_appeal"),
      },
      {
        id: "reprocess",
        label: "Request reprocessing",
        onClick: (r) => openModal(r, "request_reprocessing"),
      },
      {
        id: "accept",
        label: "Mark accepted",
        variant: "success",
        onClick: (r) => openModal(r, "mark_accepted"),
      },
      {
        id: "contract",
        label: "Update contract rate",
        onClick: (r) => openModal(r, "update_contract_rate"),
      },
      {
        id: "rule",
        label: "Add payer rule",
        onClick: (r) => openModal(r, "add_payer_rule"),
        disabled: (r) => r.payerId == null,
      },
    ],
    [openModal],
  );

  // ── Detail panel ────────────────────────────────────────────────────────
  const selectedRow = useMemo(
    () => tabRows.find((r) => r.id === selectedRowId) ?? null,
    [tabRows, selectedRowId],
  );

  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "eraLine",
        label: "ERA line",
        render: () =>
          selectedRow ? (
            <DetailSection title="ERA line">
              <KV
                label="ERA payment ID"
                value={shortId(selectedRow.eraPaymentId)}
                mono
              />
              <KV label="Line #" value={String(selectedRow.lineIndex + 1)} />
              <KV
                label="Procedure"
                value={
                  selectedRow.procedureCode +
                  (selectedRow.modifiers.length
                    ? ` · ${selectedRow.modifiers.join(", ")}`
                    : "")
                }
                mono
              />
              <KV label="Allowed (payer)" value={money(selectedRow.allowedPaid)} />
              <KV label="Paid" value={money(selectedRow.paidAmount)} />
              <KV
                label="Client responsibility"
                value={money(selectedRow.patientResponsibility)}
              />
              <KV label="Paid date" value={formatDate(selectedRow.paidDate)} />
              <KV
                label="CARC"
                value={
                  selectedRow.carcCodes.length
                    ? selectedRow.carcCodes.join(", ")
                    : "—"
                }
              />
              <KV
                label="RARC"
                value={
                  selectedRow.rarcCodes.length
                    ? selectedRow.rarcCodes.join(", ")
                    : "—"
                }
              />
            </DetailSection>
          ) : null,
      },
      {
        id: "expectedFeeSchedule",
        label: "Expected fee schedule",
        render: () =>
          selectedRow ? (
            <DetailSection
              title="Expected fee schedule"
              note="Source of truth for what the payer should have allowed for this CPT/modifier combination."
            >
              <KV
                label="Expected allowed"
                value={money(selectedRow.allowedExpected)}
              />
              <KV label="Source" value={selectedRow.contractSource} />
              <KV
                label="Fee schedule ID"
                value={shortId(selectedRow.feeScheduleId)}
                mono
              />
              {selectedRow.feeScheduleId ? null : (
                <p style={{ color: "#64748B", fontSize: 12 }}>
                  No fee schedule on file for this CPT/modifier. Add one in
                  Settings → Payers → Contracts, or use "Update contract rate"
                  to insert one inline.
                </p>
              )}
            </DetailSection>
          ) : null,
      },
      {
        id: "contractRate",
        label: "Contract rate",
        render: () =>
          selectedRow ? (
            <DetailSection
              title="Contract rate"
              note="The active payer contract this fee schedule is attached to."
            >
              <KV label="Payer" value={selectedRow.payerName} />
              <KV
                label="Payer type"
                value={selectedRow.payerType ?? "—"}
              />
              <KV
                label="Contract ID"
                value={shortId(selectedRow.contractId)}
                mono
              />
              <KV
                label="Contracted allowed"
                value={money(selectedRow.allowedExpected)}
              />
            </DetailSection>
          ) : null,
      },
      {
        id: "paymentCalc",
        label: "Payment calculation",
        render: () =>
          selectedRow ? (
            <DetailSection
              title="Payment calculation"
              note="Side-by-side reconciliation: what was expected, what was allowed, and where the dollars landed."
            >
              <KV
                label="Allowed expected"
                value={money(selectedRow.allowedExpected)}
              />
              <KV
                label="Allowed paid"
                value={money(selectedRow.allowedPaid)}
              />
              <KV
                label="Variance"
                value={money(selectedRow.variance)}
                emphasis={selectedRow.variance > 0 ? "danger" : undefined}
              />
              <KV
                label="Insurance paid"
                value={money(selectedRow.paidAmount)}
              />
              <KV
                label="Client responsibility"
                value={money(selectedRow.patientResponsibility)}
              />
              <KV
                label="Insurance shortfall"
                value={money(
                  Math.max(
                    0,
                    Math.round(
                      (selectedRow.allowedPaid -
                        selectedRow.paidAmount -
                        selectedRow.patientResponsibility) *
                        100,
                    ) / 100,
                  ),
                )}
              />
            </DetailSection>
          ) : null,
      },
      {
        id: "priorPayments",
        label: "Prior payments",
        render: () =>
          selectedRow ? (
            <DetailSection
              title="Prior payments"
              note="History on this claim — original adjudication, any reprocessing, and client-side payments."
            >
              <KV
                label="Latest paid"
                value={`${money(selectedRow.paidAmount)} on ${formatDate(selectedRow.paidDate)}`}
              />
              <KV label="Claim status" value={selectedRow.status || "—"} />
              {selectedRow.professionalClaimId ? (
                <p style={{ color: "#64748B", fontSize: 12, marginTop: 6 }}>
                  Open the claim from Denials or Submitted Claims for full
                  prior-payment history.
                </p>
              ) : (
                <p style={{ color: "#64748B", fontSize: 12 }}>
                  Not yet matched to a claim — payment history is limited to the
                  ERA detail above.
                </p>
              )}
            </DetailSection>
          ) : null,
      },
      {
        id: "documents",
        label: "Related documents",
        render: () =>
          selectedRow?.professionalClaimId ? (
            <ClaimDocumentsPanel
              claimId={selectedRow.professionalClaimId}
              organizationId={organizationId}
            />
          ) : (
            <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>
              This ERA payment isn&apos;t matched to a claim yet, so there&apos;s
              nothing to attach.
            </p>
          ),
      },
    ],
    [selectedRow, organizationId],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const r = selectedRow;
    return [
      {
        id: "appeal",
        label: "Create underpayment appeal",
        variant: "primary",
        onClick: () => openModal(r, "create_appeal"),
      },
      {
        id: "reprocess",
        label: "Request reprocessing",
        onClick: () => openModal(r, "request_reprocessing"),
      },
      {
        id: "accept",
        label: "Mark accepted",
        variant: "success",
        onClick: () => openModal(r, "mark_accepted"),
      },
      {
        id: "contract",
        label: "Update contract rate",
        onClick: () => openModal(r, "update_contract_rate"),
      },
      {
        id: "rule",
        label: "Add payer rule",
        onClick: () => openModal(r, "add_payer_rule"),
        disabled: r.payerId == null,
      },
    ];
  }, [selectedRow, openModal]);

  const headerActions: PrimaryAction[] = useMemo(
    () => [
      {
        id: "refresh",
        label: loading ? "Loading…" : "Refresh",
        onClick: () => void load(),
        disabled: loading,
      },
    ],
    [loading, load],
  );

  const primaryTabs = useMemo(
    () =>
      TABS.map((t) => ({
        id: t.id,
        label: t.label,
        count: tabCounts[t.id],
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
    : success
    ? { tone: "success" as const, text: success }
    : null;

  return (
    <>
      {suggestionClusters.length > 0 ? (
        <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {suggestionClusters.map((c) => {
            const busyKey = `${c.representative.id}::update_contract_rate`;
            const busy = busyAction === busyKey;
            return (
              <div
                key={c.groupKey}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "10px 14px",
                  background: "#FFFBEB",
                  border: "1px solid #FCD34D",
                  borderRadius: 6,
                  fontSize: 13,
                  color: "#92400E",
                }}
              >
                <div>
                  <strong>{c.payerName}</strong> paid{" "}
                  <strong>{money(c.adoptAmount)}</strong> on{" "}
                  <strong>{c.sampleCount}</strong> ERAs for CPT{" "}
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>
                    {c.procedureCode}
                    {c.modifiers.length ? `-${c.modifiers.join("-")}` : ""}
                  </span>
                  . The contracted rate on file looks stale.
                </div>
                <button
                  type="button"
                  className="button"
                  onClick={() => adoptSuggestion(c)}
                  disabled={busy}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {busy
                    ? "Adopting…"
                    : `Adopt ${money(c.adoptAmount)} as new contracted rate`}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <WorkqueueShell<UnderpaymentRow>
        title={queueDef?.title ?? "Underpayments"}
        description={queueDef?.description}
        headerActions={headerActions}
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
        filterUrlNamespace="upay"
        rows={tabRows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="Nothing in this tab."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {modal ? (
        <ActionModal
          state={modal}
          busy={busyAction != null}
          onClose={() => setModal(null)}
          onSubmit={(input) => void runAction(modal.row, modal.action, input)}
        />
      ) : null}
    </>
  );
}

// ─── Modal copy + success labels ──────────────────────────────────────────

const MODAL_COPY: Record<ActionId, { title: string; prompt: string }> = {
  create_appeal: {
    title: "Create underpayment appeal",
    prompt:
      "Records an appeal note on the claim with the variance details so the biller can pursue the shortfall with the payer.",
  },
  request_reprocessing: {
    title: "Request reprocessing",
    prompt:
      "Logs a reprocessing request on the claim (e.g. for a 276 inquiry or payer-portal redetermination).",
  },
  mark_accepted: {
    title: "Mark accepted",
    prompt:
      "Closes this line out of the Underpayments queue. The variance is accepted as a write-off and won't reappear unless re-adjudicated.",
  },
  update_contract_rate: {
    title: "Update contract rate",
    prompt:
      "Updates the fee schedule allowed amount for this CPT/modifier so future ERAs reconcile correctly. If no schedule exists yet, one will be created.",
  },
  add_payer_rule: {
    title: "Add payer rule",
    prompt:
      "Appends a free-form payer rule to this payer's profile (visible in Settings → Payers). Useful for documenting payer-specific quirks (e.g. modifier behavior, telehealth uplifts).",
  },
};

function actionSuccessLabel(action: ActionId): string {
  switch (action) {
    case "create_appeal":
      return "Appeal note recorded.";
    case "request_reprocessing":
      return "Reprocessing request logged.";
    case "mark_accepted":
      return "Underpayment marked accepted.";
    case "update_contract_rate":
      return "Contract rate updated.";
    case "add_payer_rule":
      return "Payer rule added.";
  }
}

// ─── Detail subcomponents ──────────────────────────────────────────────────

function DetailSection({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <h4
        style={{
          fontSize: 13,
          color: "#0F172A",
          margin: "0 0 6px",
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {title}
      </h4>
      {note ? (
        <p style={{ color: "#64748B", fontSize: 12, marginTop: 0 }}>{note}</p>
      ) : null}
      {children}
    </div>
  );
}

function KV({
  label,
  value,
  mono,
  emphasis,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasis?: "danger";
}) {
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
          color: emphasis === "danger" ? "#B91C1C" : "#0F172A",
          textAlign: "right",
          maxWidth: "60%",
          fontFamily: mono ? "ui-monospace, monospace" : undefined,
          fontWeight: emphasis === "danger" ? 600 : undefined,
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </span>
    </div>
  );
}
