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
        header: "Patient contact needed",
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
        };
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Action failed");
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
        label: "Route to client/admin",
        onClick: (r) => void runAction(r.id, "route_to_client_admin"),
        disabled: (r) => busyRow === r.id,
      },
    ],
    [runAction, promptInsuranceOrder, busyRow],
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
        id: "client_history",
        label: "Client insurance history",
        render: () => (
          <ClientInsuranceHistory
            clientId={row.client_id}
            organizationId={organizationId}
          />
        ),
      },
    ];
  }, [selectedRow, organizationId, promptInsuranceOrder]);

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
        label: "Route to client/admin",
        onClick: () => void runAction(row.id, "route_to_client_admin"),
      },
    ];
  }, [selectedRow, runAction, promptInsuranceOrder]);

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
