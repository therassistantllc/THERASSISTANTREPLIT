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
import { ClaimDocumentsPanel } from "@/components/billing/ClaimDocumentsPanel";
import { DEFAULT_ORG_ID } from "@/lib/config";

type Tab =
  | "other_insurance_found"
  | "primary_secondary_conflict"
  | "medicaid_cob"
  | "client_update_needed"
  | "eob_needed";

type CobState =
  | "open"
  | "awaiting_eob"
  | "client_update_needed"
  | "resolved";

type Policy = {
  id: string;
  priority: string;
  payer_id: string | null;
  payer_name: string | null;
  payer_type: string | null;
  policy_number: string | null;
  effective_date: string | null;
  termination_date: string | null;
  active: boolean;
};

type Row = {
  id: string;
  claim_number: string;
  client_id: string | null;
  client_name: string;
  payer_billed_id: string | null;
  payer_billed_name: string | null;
  other_payer_name: string | null;
  cob_issue: string;
  date_of_service: string | null;
  charge_amount: number;
  patient_contact_needed: boolean;
  status: string;
  state: CobState;
  tabs: Tab[];
  policies: Policy[];
  has_eob: boolean;
  eob_requested_at: string | null;
  eob_request_count: number;
  last_action_at: string | null;
  days_since_dos: number | null;
  aging_bucket: string;
  priority: "low" | "medium" | "high" | "critical";
  clinician_id: string | null;
  clinician_name: string | null;
  has_medicaid: boolean;
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
  { id: "other_insurance_found", label: "Other Insurance Found" },
  { id: "primary_secondary_conflict", label: "Primary/Secondary Conflict" },
  { id: "medicaid_cob", label: "Medicaid COB" },
  { id: "client_update_needed", label: "Client Update Needed" },
  { id: "eob_needed", label: "EOB Needed" },
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

function statePill(state: CobState): ReactNode {
  switch (state) {
    case "resolved": return pill("Resolved", "#dcfce7", "#166534");
    case "awaiting_eob": return pill("Awaiting EOB", "#fef9c3", "#854d0e");
    case "client_update_needed": return pill("Client update", "#ffedd5", "#9a3412");
    default: return pill("Open", "#e0f2fe", "#075985");
  }
}

export default function CobIssuesClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);

  const [items, setItems] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);
  const [activeTab, setActiveTab] = useState<Tab>("other_insurance_found");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ organizationId, tab: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) qs.set(k, v);
      }
      const res = await fetch(`/api/billing/cob-issues?${qs.toString()}`, {
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

  const clinicianOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) {
      if (i.clinician_id && i.clinician_name) m.set(i.clinician_id, i.clinician_name);
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const payerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.payer_billed_name) set.add(i.payer_billed_name);
    return Array.from(set).map((p) => ({ value: p, label: p }));
  }, [items]);

  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) {
      if (i.client_id) m.set(i.client_id, i.client_name);
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const filters: FilterDef[] = useMemo(
    () => [
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
          { value: "open", label: "Open" },
          { value: "awaiting_eob", label: "Awaiting EOB" },
          { value: "client_update_needed", label: "Client update needed" },
          { value: "resolved", label: "Resolved" },
        ],
      },
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
    ],
    [clinicianOptions, payerOptions, clientOptions],
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
      {
        id: "payer_billed",
        header: "Payer billed",
        cell: (r) => r.payer_billed_name ?? "—",
      },
      {
        id: "other_payer",
        header: "Other payer",
        cell: (r) => r.other_payer_name ?? "—",
      },
      {
        id: "cob_issue",
        header: "COB issue",
        cell: (r) => <span style={{ fontSize: 12 }}>{r.cob_issue}</span>,
      },
      {
        id: "dos",
        header: "DOS",
        cell: (r) => formatDate(r.date_of_service),
      },
      {
        id: "charge",
        header: "Charge amount",
        align: "right",
        cell: (r) => formatMoney(r.charge_amount),
      },
      {
        id: "patient_contact",
        header: "Client contact needed",
        cell: (r) =>
          r.patient_contact_needed
            ? pill("Yes", "#fee2e2", "#991b1b")
            : pill("No", "#f1f5f9", "#475569"),
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
          `/api/billing/cob-issues/${encodeURIComponent(rowId)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, organizationId, ...extras }),
          },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          clientUpdate?: {
            fullUrl?: string;
            url?: string;
            deliveryMethod?: "clipboard" | "email" | "sms";
            expiresAt?: string | null;
            email?: { sent?: boolean; to?: string | null; error?: string | null };
            sms?: { sent?: boolean; to?: string | null; error?: string | null };
          };
        };
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Action failed");
        }
        if (action === "route_to_client_admin" && json.clientUpdate) {
          const cu = json.clientUpdate;
          const link = cu.fullUrl || cu.url || "";
          if (cu.deliveryMethod === "email" && cu.email?.sent) {
            setMessage({
              tone: "success",
              text: `Insurance update link emailed to ${cu.email.to}.`,
            });
          } else if (cu.deliveryMethod === "sms" && cu.sms?.sent) {
            setMessage({
              tone: "success",
              text: `Insurance update link texted to ${cu.sms.to}.`,
            });
          } else if (link && typeof window !== "undefined" && navigator.clipboard) {
            await navigator.clipboard
              .writeText(link)
              .catch(() => undefined);
            window.alert(
              `Insurance update link generated and copied to your clipboard:\n\n${link}\n\nText or message it to the client.`,
            );
          } else if (link) {
            window.alert(`Insurance update link:\n\n${link}`);
          }
        }
        // Optimistic local update so the row reflects the new state
        // without waiting for the refetch round-trip.
        setItems((prev) =>
          prev.map((r) => {
            if (r.id !== rowId) return r;
            const next: Row = { ...r };
            switch (action) {
              case "bill_primary":
              case "bill_secondary":
                next.state = "resolved";
                next.status = "Resolved";
                break;
              case "request_eob":
                next.state = "awaiting_eob";
                next.status = "Awaiting EOB";
                next.eob_requested_at = new Date().toISOString();
                next.eob_request_count = (r.eob_request_count ?? 0) + 1;
                break;
              case "route_to_client_admin":
                next.state = "client_update_needed";
                next.status = "Client update needed";
                next.patient_contact_needed = true;
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

  const promptRouteToClient = useCallback(
    (row: Row) => {
      const choice = window.prompt(
        `Send ${row.client_name} a secure insurance-update link.\n\n` +
          `Type "text" to send it by SMS, "email" to email it now, ` +
          `or "copy" (default) to copy the link to your clipboard.`,
        "text",
      );
      if (choice === null) return;
      const normalized = choice.trim().toLowerCase();
      const delivery =
        normalized === "email"
          ? "email"
          : normalized === "text" || normalized === "sms"
            ? "sms"
            : "clipboard";
      void runAction(row.id, "route_to_client_admin", { delivery });
    },
    [runAction],
  );

  const promptInsuranceOrder = useCallback(
    (row: Row) => {
      if (row.policies.length === 0) {
        window.alert("No active insurance policies on file for this client.");
        return;
      }
      const lines = row.policies
        .map(
          (p, idx) =>
            `${idx + 1}) ${p.priority.toUpperCase()} — ${p.payer_name ?? "Unknown payer"}${
              p.policy_number ? ` (${p.policy_number})` : ""
            } [id: ${p.id.slice(0, 8)}]`,
        )
        .join("\n");
      const answer = window.prompt(
        `Reorder policies — enter the policy numbers in primary-first order, comma-separated (e.g. 2,1):\n\n${lines}`,
      );
      if (!answer) return;
      const indices = answer
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= row.policies.length);
      if (indices.length === 0) return;
      const orderedIds = indices.map((n) => row.policies[n - 1].id);
      void runAction(row.id, "update_insurance_order", {
        ordered_policy_ids: orderedIds,
      });
    },
    [runAction],
  );

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      {
        id: "update_insurance_order",
        label: "Update order",
        onClick: (r) => promptInsuranceOrder(r),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "bill_primary",
        label: "Bill primary",
        variant: "primary",
        onClick: (r) => void runAction(r.id, "bill_primary"),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "bill_secondary",
        label: "Bill secondary",
        onClick: (r) => void runAction(r.id, "bill_secondary"),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "request_eob",
        label: "Request EOB",
        onClick: (r) => void runAction(r.id, "request_eob"),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "route_to_client_admin",
        label: "Send client update link",
        onClick: (r) => promptRouteToClient(r),
        disabled: (r) => busyRow === r.id,
      },
    ],
    [runAction, promptInsuranceOrder, promptRouteToClient, busyRow],
  );

  const selectedRow = useMemo(
    () => items.find((r) => r.id === selectedId) ?? null,
    [items, selectedId],
  );

  const labeledItem = (label: string, value: ReactNode) => (
    <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
      <span style={{ color: "#64748b", minWidth: 160 }}>{label}</span>
      <span>{value}</span>
    </div>
  );

  const detailTabs: DetailTab[] = useMemo(() => {
    if (!selectedRow) return [];
    const row = selectedRow;
    const sortedPolicies = [...row.policies].sort((a, b) => {
      const order = (p: string) =>
        p === "primary" ? 0 : p === "secondary" ? 1 : p === "tertiary" ? 2 : 3;
      return order(a.priority) - order(b.priority);
    });

    return [
      {
        id: "insurance_order",
        label: "Insurance order",
        render: () => (
          <div>
            {sortedPolicies.length === 0 ? (
              <p style={{ fontSize: 13, color: "#64748b" }}>
                No active insurance policies on file.
              </p>
            ) : (
              <ol style={{ paddingLeft: 18, margin: 0 }}>
                {sortedPolicies.map((p) => (
                  <li key={p.id} style={{ marginBottom: 8, fontSize: 13 }}>
                    <div>
                      <strong style={{ textTransform: "capitalize" }}>
                        {p.priority}
                      </strong>{" "}
                      — {p.payer_name ?? "Unknown payer"}
                      {p.payer_type ? (
                        <span style={{ color: "#64748b" }}> · {p.payer_type}</span>
                      ) : null}
                    </div>
                    {p.policy_number ? (
                      <div style={{ color: "#64748b", fontSize: 12 }}>
                        Policy #{p.policy_number}
                      </div>
                    ) : null}
                    {p.effective_date ? (
                      <div style={{ color: "#64748b", fontSize: 12 }}>
                        Effective {formatDate(p.effective_date)}
                        {p.termination_date
                          ? ` – ${formatDate(p.termination_date)}`
                          : ""}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                onClick={() => promptInsuranceOrder(row)}
                style={{
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                Reorder policies
              </button>
            </div>
          </div>
        ),
      },
      {
        id: "cob_evidence",
        label: "Coordination of Benefits",
        render: () => (
          <CobEvidencePanel
            claimId={row.id}
            organizationId={organizationId}
          />
        ),
      },
      {
        id: "eligibility_cob",
        label: "Eligibility COB data",
        render: () => (
          <EligibilityCobData
            clientId={row.client_id}
            organizationId={organizationId}
          />
        ),
      },
      {
        id: "prior_eobs",
        label: "Prior payer EOBs",
        render: () => (
          <div>
            {labeledItem(
              "EOB on file",
              row.has_eob
                ? pill("Yes", "#dcfce7", "#166534")
                : pill("No", "#fee2e2", "#991b1b"),
            )}
            {labeledItem(
              "Last request",
              row.eob_requested_at ? formatDate(row.eob_requested_at) : "—",
            )}
            {labeledItem("Requests sent", String(row.eob_request_count))}
            <p style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
              Once the prior-payer EOB arrives, use{" "}
              <em>Record EOB received</em> below to clear the EOB-needed flag.
            </p>
          </div>
        ),
      },
      {
        id: "card_suggestion",
        label: "Card photo suggestion",
        render: () => (
          <CardSuggestionPanel
            claimId={row.id}
            organizationId={organizationId}
            onChanged={() => void load()}
          />
        ),
      },
      {
        id: "client_history",
        label: "Client insurance history",
        render: () => (
          <ClientInsuranceHistory
            clientId={row.client_id}
            organizationId={organizationId}
          />
        ),
      },
      {
        id: "documents",
        label: "Related documents",
        render: () => (
          <ClaimDocumentsPanel claimId={row.id} organizationId={organizationId} />
        ),
      },
    ];
  }, [selectedRow, organizationId, promptInsuranceOrder, load]);

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const row = selectedRow;
    return [
      {
        id: "update_insurance_order",
        label: "Update insurance order",
        onClick: () => promptInsuranceOrder(row),
      },
      {
        id: "bill_primary",
        label: "Bill primary",
        variant: "primary",
        onClick: () => void runAction(row.id, "bill_primary"),
      },
      {
        id: "bill_secondary",
        label: "Bill secondary",
        onClick: () => void runAction(row.id, "bill_secondary"),
      },
      {
        id: "request_eob",
        label: row.has_eob ? "Re-request EOB" : "Request EOB",
        onClick: () => void runAction(row.id, "request_eob"),
      },
      {
        id: "record_eob",
        label: "Record EOB received",
        onClick: () => void runAction(row.id, "record_eob"),
        disabled: row.has_eob,
      },
      {
        id: "route_to_client_admin",
        label: "Send client update link",
        onClick: () => promptRouteToClient(row),
      },
    ];
  }, [selectedRow, runAction, promptInsuranceOrder, promptRouteToClient]);

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
        other_insurance_found: 0,
        primary_secondary_conflict: 0,
        medicaid_cob: 0,
        client_update_needed: 0,
        eob_needed: 0,
      } as Record<Tab, number>,
    };
    return [
      { id: "count", label: "Open claims", value: String(s.total_count) },
      { id: "dollars", label: "Total $", value: formatMoney(s.total_dollars) },
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
        tone: s.urgent_count > 0 ? "amber" : "default",
      },
    ];
  }, [summary]);

  return (
    <WorkqueueShell<Row>
      title="COB Issues"
      description="Claims that need a coordination-of-benefits decision before they can be billed to the correct payer."
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
      filterUrlNamespace="cob"
      rows={items}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage="No COB issues in this tab."
      selectedRowId={selectedId}
      onSelectRow={setSelectedId}
      rowActions={rowActions}
      detailTabs={detailTabs}
      detailActions={detailActions}
      message={message}
    />
  );
}

function EligibilityCobData({
  clientId,
  organizationId,
}: {
  clientId: string | null;
  organizationId: string;
}) {
  const [rows, setRows] = useState<
    Array<{
      id: string;
      created_at: string;
      payer_name: string | null;
      coverage_active: boolean | null;
      other_payer_text: string | null;
    }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function go() {
      if (!clientId) return;
      setLoading(true);
      setErr(null);
      try {
        const params = new URLSearchParams({
          organizationId,
          clientId,
          limit: "5",
        });
        const res = await fetch(
          `/api/billing/cob-issues/eligibility?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          checks?: typeof rows;
          error?: string;
        };
        if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
        if (!cancelled) setRows(json.checks ?? []);
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
  }, [clientId, organizationId]);

  if (!clientId) return <p style={{ fontSize: 13 }}>No client linked.</p>;
  if (loading) return <p style={{ fontSize: 13 }}>Loading…</p>;
  if (err) return <p style={{ fontSize: 13, color: "#991b1b" }}>{err}</p>;
  if (rows.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "#64748b" }}>
        No recent 270/271 eligibility checks on file for this client.
      </p>
    );
  }

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {rows.map((r) => (
        <li
          key={r.id}
          style={{
            borderBottom: "1px solid #e2e8f0",
            padding: "6px 0",
            fontSize: 13,
          }}
        >
          <div>
            <strong>{r.payer_name ?? "Unknown payer"}</strong>{" "}
            <span style={{ color: "#64748b" }}>
              · {new Date(r.created_at).toLocaleDateString()}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "#475569" }}>
            Coverage:{" "}
            {r.coverage_active === true
              ? "Active"
              : r.coverage_active === false
              ? "Inactive"
              : "Unknown"}
            {r.other_payer_text ? ` · Other payer cited: ${r.other_payer_text}` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ClientInsuranceHistory({
  clientId,
  organizationId,
}: {
  clientId: string | null;
  organizationId: string;
}) {
  const [rows, setRows] = useState<
    Array<{
      id: string;
      priority: string;
      payer_name: string | null;
      policy_number: string | null;
      effective_date: string | null;
      termination_date: string | null;
      active: boolean;
    }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function go() {
      if (!clientId) return;
      setLoading(true);
      setErr(null);
      try {
        const params = new URLSearchParams({
          organizationId,
          clientId,
          history: "true",
        });
        const res = await fetch(
          `/api/billing/cob-issues/policies?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          policies?: typeof rows;
          error?: string;
        };
        if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
        if (!cancelled) setRows(json.policies ?? []);
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
  }, [clientId, organizationId]);

  if (!clientId) return <p style={{ fontSize: 13 }}>No client linked.</p>;
  if (loading) return <p style={{ fontSize: 13 }}>Loading…</p>;
  if (err) return <p style={{ fontSize: 13, color: "#991b1b" }}>{err}</p>;
  if (rows.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "#64748b" }}>
        No insurance policies on file for this client.
      </p>
    );
  }

  return (
    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left", color: "#475569" }}>
          <th style={{ padding: "4px 6px" }}>Priority</th>
          <th style={{ padding: "4px 6px" }}>Payer</th>
          <th style={{ padding: "4px 6px" }}>Effective</th>
          <th style={{ padding: "4px 6px" }}>Termed</th>
          <th style={{ padding: "4px 6px" }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id} style={{ borderTop: "1px solid #e2e8f0" }}>
            <td
              style={{
                padding: "4px 6px",
                textTransform: "capitalize",
                whiteSpace: "nowrap",
              }}
            >
              {p.priority}
            </td>
            <td style={{ padding: "4px 6px" }}>{p.payer_name ?? "—"}</td>
            <td style={{ padding: "4px 6px" }}>{formatDate(p.effective_date)}</td>
            <td style={{ padding: "4px 6px" }}>
              {p.termination_date ? formatDate(p.termination_date) : "—"}
            </td>
            <td style={{ padding: "4px 6px" }}>
              {p.active ? "Active" : "Inactive"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type CobSignalRow = {
  id: string;
  signal_type: string;
  other_payer_name: string | null;
  other_payer_id: string | null;
  other_payer_paid_amount: number | null;
  source_segment: string | null;
  era_claim_payment_id: string | null;
  created_at: string | null;
};

type CobEligibilityOtherPayer = {
  name: string | null;
  payer_id: string | null;
  effective_date: string | null;
  termination_date: string | null;
};

type CobEvidencePayload = {
  success?: boolean;
  error?: string;
  signals?: CobSignalRow[];
  eligibility?: {
    check_id: string | null;
    checked_at: string | null;
    payer_name: string | null;
    other_payers: CobEligibilityOtherPayer[];
  } | null;
};

function signalLabel(t: string): string {
  switch (t) {
    case "co_22":
      return "CO-22 (covered by another payer)";
    case "other_payer_paid":
      return "Other payer paid (MOA)";
    case "other_payer_eligibility":
      return "271 other-payer eligibility";
    default:
      return t || "Unknown";
  }
}

function CobEvidencePanel({
  claimId,
  organizationId,
}: {
  claimId: string;
  organizationId: string;
}) {
  const [data, setData] = useState<CobEvidencePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function go() {
      setLoading(true);
      setErr(null);
      try {
        const params = new URLSearchParams({ organizationId });
        const res = await fetch(
          `/api/billing/cob-issues/${encodeURIComponent(claimId)}/signals?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => ({}))) as CobEvidencePayload;
        if (!res.ok || !json.success)
          throw new Error(json.error ?? "Failed to load");
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void go();
    return () => {
      cancelled = true;
    };
  }, [claimId, organizationId]);

  if (loading) return <p style={{ fontSize: 13 }}>Loading…</p>;
  if (err) return <p style={{ fontSize: 13, color: "#991b1b" }}>{err}</p>;

  const signals = data?.signals ?? [];
  const eligibility = data?.eligibility ?? null;
  const elig = eligibility?.other_payers ?? [];

  if (signals.length === 0 && elig.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "#64748b" }}>
        No coordination-of-benefits evidence has been received on this claim
        yet — no CO-22 / MOA signals from 835s, and no other-payer entries on
        the client&apos;s most-recent 271 response.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>
          835 remittance signals
        </h4>
        {signals.length === 0 ? (
          <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>
            No 835 CO-22 or MOA other-payer-paid signals recorded for this
            claim.
          </p>
        ) : (
          <table
            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "#475569" }}>
                <th style={{ padding: "4px 6px" }}>Signal</th>
                <th style={{ padding: "4px 6px" }}>Other payer</th>
                <th style={{ padding: "4px 6px" }}>Paid</th>
                <th style={{ padding: "4px 6px" }}>Source segment</th>
                <th style={{ padding: "4px 6px" }}>Received</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                  <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>
                    {signalLabel(s.signal_type)}
                  </td>
                  <td style={{ padding: "4px 6px" }}>
                    {s.other_payer_name ?? "—"}
                    {s.other_payer_id ? (
                      <span style={{ color: "#64748b" }}>
                        {" "}
                        · ID {s.other_payer_id}
                      </span>
                    ) : null}
                  </td>
                  <td style={{ padding: "4px 6px" }}>
                    {s.other_payer_paid_amount == null
                      ? "—"
                      : formatMoney(s.other_payer_paid_amount)}
                  </td>
                  <td
                    style={{
                      padding: "4px 6px",
                      fontFamily: "monospace",
                      color: "#475569",
                    }}
                  >
                    {s.source_segment ?? "—"}
                  </td>
                  <td style={{ padding: "4px 6px" }}>
                    {s.created_at ? formatDate(s.created_at) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>
          271 other-payer evidence
        </h4>
        {!eligibility || elig.length === 0 ? (
          <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>
            No additional payers were reported on the most-recent 271 response
            for this client.
          </p>
        ) : (
          <div>
            <p
              style={{
                fontSize: 12,
                color: "#475569",
                margin: "0 0 6px",
              }}
            >
              From 271 sent to{" "}
              <strong>{eligibility.payer_name ?? "Unknown payer"}</strong>
              {eligibility.checked_at
                ? ` on ${formatDate(eligibility.checked_at)}`
                : ""}
              :
            </p>
            <table
              style={{
                width: "100%",
                fontSize: 12,
                borderCollapse: "collapse",
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: "#475569" }}>
                  <th style={{ padding: "4px 6px" }}>Other payer</th>
                  <th style={{ padding: "4px 6px" }}>Payer ID</th>
                  <th style={{ padding: "4px 6px" }}>Effective</th>
                  <th style={{ padding: "4px 6px" }}>Termed</th>
                </tr>
              </thead>
              <tbody>
                {elig.map((p, i) => (
                  <tr
                    key={`${p.payer_id ?? ""}-${p.name ?? ""}-${i}`}
                    style={{ borderTop: "1px solid #e2e8f0" }}
                  >
                    <td style={{ padding: "4px 6px" }}>{p.name ?? "—"}</td>
                    <td
                      style={{
                        padding: "4px 6px",
                        fontFamily: "monospace",
                      }}
                    >
                      {p.payer_id ?? "—"}
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      {p.effective_date ? formatDate(p.effective_date) : "—"}
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      {p.termination_date
                        ? formatDate(p.termination_date)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

type CardSuggestionPayload = {
  success: boolean;
  error?: string;
  found?: {
    audit_id: string;
    created_at: string | null;
    link_id: string | null;
    status: string | null;
    suggestion: {
      payer_name: string | null;
      member_id: string | null;
      group_number: string | null;
      plan_name: string | null;
      subscriber_name: string | null;
      rx_bin: string | null;
      rx_pcn: string | null;
      payer_phone: string | null;
      notes: string | null;
      confidence: {
        payer_name: number;
        member_id: number;
        group_number: number;
        plan_name: number;
        overall: number;
      };
      raw_text: string | null;
    } | null;
    card_photo_front: { bucket: string; path: string } | null;
    card_photo_back: { bucket: string; path: string } | null;
    card_photo_front_url: string | null;
    card_photo_back_url: string | null;
    other_coverage_note: string | null;
    decision: {
      type: "accepted" | "discarded";
      at: string | null;
      user_id: string | null;
      new_policy_id: string | null;
    } | null;
  } | null;
};

function confidenceBadge(score: number): ReactNode {
  if (score >= 0.8) return pill(`High ${Math.round(score * 100)}%`, "#dcfce7", "#166534");
  if (score >= 0.55) return pill(`Med ${Math.round(score * 100)}%`, "#fef9c3", "#854d0e");
  return pill(`Low ${Math.round(score * 100)}%`, "#fee2e2", "#991b1b");
}

function CardSuggestionPanel({
  claimId,
  organizationId,
  onChanged,
}: {
  claimId: string;
  organizationId: string;
  onChanged: () => void;
}) {
  const [data, setData] = useState<CardSuggestionPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [payerName, setPayerName] = useState("");
  const [memberId, setMemberId] = useState("");
  const [groupNumber, setGroupNumber] = useState("");
  const [planName, setPlanName] = useState("");
  const [priority, setPriority] = useState<"primary" | "secondary" | "tertiary">(
    "secondary",
  );
  const [zoomedUrl, setZoomedUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ organizationId });
      const res = await fetch(
        `/api/billing/cob-issues/${encodeURIComponent(claimId)}/card-suggestion?${params.toString()}`,
        { cache: "no-store" },
      );
      const json = (await res.json().catch(() => ({}))) as CardSuggestionPayload;
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setData(json);
      const sug = json.found?.suggestion;
      if (sug) {
        setPayerName(sug.payer_name ?? "");
        setMemberId(sug.member_id ?? "");
        setGroupNumber(sug.group_number ?? "");
        setPlanName(sug.plan_name ?? "");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [claimId, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (action: "accept" | "discard") => {
      setBusy(true);
      setErr(null);
      try {
        const body =
          action === "accept"
            ? {
                action,
                organizationId,
                link_id: data?.found?.link_id ?? null,
                fields: {
                  payer_name: payerName.trim() || null,
                  member_id: memberId.trim() || null,
                  group_number: groupNumber.trim() || null,
                  plan_name: planName.trim() || null,
                  priority,
                },
              }
            : { action, organizationId, link_id: data?.found?.link_id ?? null };
        const res = await fetch(
          `/api/billing/cob-issues/${encodeURIComponent(claimId)}/card-suggestion`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
        };
        if (!res.ok || !json.success) throw new Error(json.error ?? "Failed");
        await load();
        onChanged();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed");
      } finally {
        setBusy(false);
      }
    },
    [
      claimId,
      organizationId,
      payerName,
      memberId,
      groupNumber,
      planName,
      priority,
      data,
      load,
      onChanged,
    ],
  );

  if (loading) return <p style={{ fontSize: 13 }}>Loading…</p>;
  if (err) return <p style={{ fontSize: 13, color: "#991b1b" }}>{err}</p>;

  const found = data?.found ?? null;
  if (!found) {
    return (
      <p style={{ fontSize: 13, color: "#64748b" }}>
        No insurance-card update has been received from the client yet. After
        the client submits the secure update link with a card photo, an
        auto-parsed draft policy will appear here for review.
      </p>
    );
  }

  if (found.status === "no_card") {
    return (
      <p style={{ fontSize: 13, color: "#64748b" }}>
        The client submitted the update form without a new insurance card
        photo, so there is nothing to auto-fill.
      </p>
    );
  }

  if (found.decision) {
    return (
      <div style={{ fontSize: 13 }}>
        <p style={{ margin: "0 0 8px" }}>
          {found.decision.type === "accepted"
            ? "Suggestion accepted — a new insurance policy was created."
            : "Suggestion discarded."}
          {found.decision.at
            ? ` (${new Date(found.decision.at).toLocaleString()})`
            : ""}
        </p>
        {found.decision.new_policy_id ? (
          <p style={{ color: "#64748b", fontSize: 12 }}>
            New policy id: {found.decision.new_policy_id.slice(0, 8)}…
          </p>
        ) : null}
      </div>
    );
  }

  const sug = found.suggestion;
  if (!sug || found.status === "ai_unavailable") {
    return (
      <div style={{ fontSize: 13 }}>
        <p style={{ color: "#854d0e" }}>
          We received the card photo but couldn&apos;t auto-parse it. Open the
          photo from the client chart and key the new policy in manually.
        </p>
        {found.other_coverage_note ? (
          <p style={{ color: "#475569", marginTop: 8 }}>
            Client note: <em>{found.other_coverage_note}</em>
          </p>
        ) : null}
      </div>
    );
  }

  const isLowConfidence = found.status === "low_confidence";
  const inputStyle = {
    width: "100%",
    padding: "6px 8px",
    fontSize: 13,
    border: "1px solid #cbd5e1",
    borderRadius: 4,
  };
  const labelStyle = {
    display: "block",
    fontSize: 11,
    color: "#475569",
    marginBottom: 2,
    textTransform: "uppercase" as const,
    letterSpacing: 0.4,
  };

  return (
    <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong>Card photo parsed automatically</strong>
        {confidenceBadge(sug.confidence.overall)}
        {isLowConfidence
          ? pill("Review carefully", "#fef3c7", "#92400e")
          : null}
      </div>
      {isLowConfidence ? (
        <p style={{ color: "#854d0e", margin: 0, fontSize: 12 }}>
          The parser wasn&apos;t confident in some fields. Compare against the
          card photo before accepting.
        </p>
      ) : null}
      {found.other_coverage_note ? (
        <p style={{ color: "#475569", margin: 0, fontSize: 12 }}>
          Client note: <em>{found.other_coverage_note}</em>
        </p>
      ) : null}

      {found.card_photo_front_url || found.card_photo_back_url ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {([
            ["Front", found.card_photo_front_url],
            ["Back", found.card_photo_back_url],
          ] as const).map(([label, url]) =>
            url ? (
              <figure
                key={label}
                style={{ margin: 0, display: "flex", flexDirection: "column", gap: 4 }}
              >
                <button
                  type="button"
                  onClick={() => setZoomedUrl(url)}
                  title={`Open ${label.toLowerCase()} of card`}
                  style={{
                    padding: 0,
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    background: "#f8fafc",
                    cursor: "zoom-in",
                    overflow: "hidden",
                    lineHeight: 0,
                  }}
                >
                  <img
                    src={url}
                    alt={`Insurance card ${label.toLowerCase()}`}
                    style={{
                      display: "block",
                      width: 180,
                      height: 110,
                      objectFit: "cover",
                    }}
                  />
                </button>
                <figcaption
                  style={{
                    fontSize: 11,
                    color: "#64748b",
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                  }}
                >
                  {label}
                </figcaption>
              </figure>
            ) : null,
          )}
        </div>
      ) : null}

      {zoomedUrl ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setZoomedUrl(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 24,
            cursor: "zoom-out",
          }}
        >
          <img
            src={zoomedUrl}
            alt="Insurance card full size"
            style={{
              maxWidth: "95vw",
              maxHeight: "95vh",
              boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
              borderRadius: 6,
              background: "white",
            }}
          />
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <div>
          <label style={labelStyle}>
            Payer name {confidenceBadge(sug.confidence.payer_name)}
          </label>
          <input
            style={inputStyle}
            value={payerName}
            onChange={(e) => setPayerName(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <label style={labelStyle}>
            Member ID {confidenceBadge(sug.confidence.member_id)}
          </label>
          <input
            style={inputStyle}
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <label style={labelStyle}>
            Group # {confidenceBadge(sug.confidence.group_number)}
          </label>
          <input
            style={inputStyle}
            value={groupNumber}
            onChange={(e) => setGroupNumber(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <label style={labelStyle}>
            Plan name {confidenceBadge(sug.confidence.plan_name)}
          </label>
          <input
            style={inputStyle}
            value={planName}
            onChange={(e) => setPlanName(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <label style={labelStyle}>Priority slot</label>
          <select
            style={inputStyle}
            value={priority}
            onChange={(e) =>
              setPriority(e.target.value as "primary" | "secondary" | "tertiary")
            }
            disabled={busy}
          >
            <option value="primary">Primary</option>
            <option value="secondary">Secondary</option>
            <option value="tertiary">Tertiary</option>
          </select>
        </div>
        {sug.subscriber_name ? (
          <div>
            <label style={labelStyle}>Subscriber name (read-only)</label>
            <input style={inputStyle} value={sug.subscriber_name} readOnly />
          </div>
        ) : null}
      </div>

      {sug.raw_text ? (
        <details style={{ fontSize: 12, color: "#475569" }}>
          <summary>Other text on the card</summary>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              background: "#f8fafc",
              padding: 6,
              borderRadius: 4,
            }}
          >
            {sug.raw_text}
          </pre>
        </details>
      ) : null}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => void submit("accept")}
          disabled={busy || !memberId.trim()}
          style={{
            padding: "6px 14px",
            fontSize: 13,
            background: "#2563eb",
            color: "white",
            border: 0,
            borderRadius: 6,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Saving…" : "Accept & create policy"}
        </button>
        <button
          type="button"
          onClick={() => void submit("discard")}
          disabled={busy}
          style={{
            padding: "6px 14px",
            fontSize: 13,
            background: "white",
            color: "#475569",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Discard
        </button>
      </div>
    </div>
  );
}
