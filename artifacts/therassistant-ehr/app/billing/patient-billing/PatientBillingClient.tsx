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
  | "invoice_ready"
  | "statements_sent"
  | "30_days"
  | "60_days"
  | "90_days"
  | "collections_review"
  | "payment_plans";

type Row = {
  id: string;
  client_id: string;
  client_name: string;
  practice_id: string | null;
  primary_clinician_id: string | null;
  primary_clinician_name: string | null;
  payer_name: string | null;
  balance: number;
  open_invoice_count: number;
  oldest_dos: string | null;
  oldest_dos_days: number | null;
  last_statement_at: string | null;
  payment_method: string | null;
  autopay_status: "on" | "off" | "unknown";
  last_payment_at: string | null;
  last_payment_amount: number | null;
  next_follow_up_at: string | null;
  status: "ready" | "sent" | "collections" | "payment_plan";
  priority: "low" | "medium" | "high" | "critical";
  aging_bucket: "0_30" | "31_60" | "61_90" | "90_plus";
  has_payment_plan: boolean;
  in_collections: boolean;
  assigned_biller_id: string | null;
  carc_codes: string[];
  rarc_codes: string[];
  tabs: Tab[];
  invoices: Array<{
    id: string;
    invoice_number: string;
    invoice_status: string;
    balance: number;
    paid: number;
    responsibility: number;
    created_at: string | null;
    dos: string | null;
    professional_claim_id: string | null;
    source: string | null;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    payment_method: string;
    payment_status: string;
    paid_at: string;
    memo: string | null;
  }>;
  communications: Array<{
    id: string;
    event_type: string;
    event_summary: string | null;
    created_at: string;
    metadata: Record<string, unknown>;
  }>;
  payment_plan: {
    created_at: string;
    monthly_amount: number | null;
    total_amount: number | null;
    months: number | null;
    note: string | null;
  } | null;
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
  { id: "invoice_ready", label: "Invoice Ready" },
  { id: "statements_sent", label: "Statements Sent" },
  { id: "30_days", label: "30 Days" },
  { id: "60_days", label: "60 Days" },
  { id: "90_days", label: "90 Days" },
  { id: "collections_review", label: "Collections Review" },
  { id: "payment_plans", label: "Payment Plans" },
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

function formatMoney(n: number | null | undefined) {
  return Number(n ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function priorityBadge(p: Row["priority"]): ReactNode {
  const map = {
    low: { bg: "#e0f2fe", fg: "#075985", label: "Low" },
    medium: { bg: "#fef9c3", fg: "#854d0e", label: "Medium" },
    high: { bg: "#ffedd5", fg: "#9a3412", label: "High" },
    critical: { bg: "#fee2e2", fg: "#991b1b", label: "Critical" },
  } as const;
  const c = map[p];
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {c.label}
    </span>
  );
}

function statusBadge(s: Row["status"]): ReactNode {
  const map = {
    ready: { bg: "#e2e8f0", fg: "#334155", label: "Invoice ready" },
    sent: { bg: "#dbeafe", fg: "#1e40af", label: "Statement sent" },
    collections: { bg: "#fee2e2", fg: "#991b1b", label: "Collections" },
    payment_plan: { bg: "#dcfce7", fg: "#166534", label: "Payment plan" },
  } as const;
  const c = map[s];
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {c.label}
    </span>
  );
}

function autopayBadge(a: Row["autopay_status"]): ReactNode {
  if (a === "on") {
    return <span style={{ color: "#166534", fontWeight: 600 }}>On</span>;
  }
  if (a === "off") {
    return <span style={{ color: "#9a3412" }}>Off</span>;
  }
  return <span style={{ color: "#94a3b8" }}>—</span>;
}

function labelMethod(m: string | null): string {
  if (!m) return "—";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

export default function PatientBillingClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);

  const [items, setItems] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);
  const [activeTab, setActiveTab] = useState<Tab>("invoice_ready");
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
      const res = await fetch(
        `/api/billing/patient-billing?${qs.toString()}`,
        { cache: "no-store" },
      );
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
      if (i.primary_clinician_id && i.primary_clinician_name) {
        m.set(i.primary_clinician_id, i.primary_clinician_name);
      }
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const payerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.payer_name) set.add(i.payer_name);
    return Array.from(set).map((p) => ({ value: p, label: p }));
  }, [items]);

  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) m.set(i.client_id, i.client_name);
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const practiceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.practice_id) set.add(i.practice_id);
    return Array.from(set).map((p) => ({ value: p, label: p }));
  }, [items]);

  const billerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.assigned_biller_id) set.add(i.assigned_biller_id);
    return Array.from(set).map((p) => ({ value: p, label: p }));
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
          { value: "ready", label: "Invoice ready" },
          { value: "sent", label: "Statement sent" },
          { value: "collections", label: "Collections" },
          { value: "payment_plan", label: "Payment plan" },
        ],
      },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "select",
        options: billerOptions,
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
      { id: "carcRarc", label: "CARC / RARC", kind: "text" },
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
    [clinicianOptions, payerOptions, clientOptions],
  );

  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.client_name },
      {
        id: "balance",
        header: "Balance",
        align: "right",
        cell: (r) => (
          <span style={{ fontWeight: 600 }}>{formatMoney(r.balance)}</span>
        ),
      },
      {
        id: "oldest_dos",
        header: "Oldest DOS",
        cell: (r) =>
          r.oldest_dos ? (
            <span>
              {formatDate(r.oldest_dos)}
              <span style={{ color: "#94a3b8", marginLeft: 6, fontSize: 11 }}>
                {r.oldest_dos_days != null ? `${r.oldest_dos_days}d` : ""}
              </span>
            </span>
          ) : (
            "—"
          ),
      },
      {
        id: "last_statement",
        header: "Last statement date",
        cell: (r) => formatDate(r.last_statement_at),
      },
      {
        id: "payment_method",
        header: "Payment method",
        cell: (r) => labelMethod(r.payment_method),
      },
      {
        id: "autopay",
        header: "Autopay status",
        cell: (r) => autopayBadge(r.autopay_status),
      },
      {
        id: "last_payment",
        header: "Last payment",
        cell: (r) =>
          r.last_payment_at ? (
            <span>
              {formatDate(r.last_payment_at)}
              <span style={{ color: "#64748b", marginLeft: 6, fontSize: 11 }}>
                {r.last_payment_amount != null
                  ? formatMoney(r.last_payment_amount)
                  : ""}
              </span>
            </span>
          ) : (
            "—"
          ),
      },
      {
        id: "next_follow_up",
        header: "Next follow-up",
        cell: (r) => formatDate(r.next_follow_up_at),
      },
      {
        id: "status",
        header: "Status",
        cell: (r) => (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {statusBadge(r.status)}
            {priorityBadge(r.priority)}
          </div>
        ),
      },
    ],
    [],
  );

  const applyOptimistic = useCallback(
    (rowId: string, action: string, extras: Record<string, unknown>) => {
      setItems((prev) =>
        prev.map((r) => {
          if (r.id !== rowId) return r;
          const next = { ...r };
          const now = new Date().toISOString();
          if (action === "send_invoice" || action === "send_reminder") {
            next.last_statement_at = now;
            next.status = next.status === "ready" ? "sent" : next.status;
          }
          if (action === "send_to_collections_review") {
            next.status = "collections";
            next.in_collections = true;
          }
          if (action === "create_payment_plan") {
            next.status = "payment_plan";
            next.has_payment_plan = true;
            next.payment_plan = {
              created_at: now,
              monthly_amount:
                extras.monthly_amount != null
                  ? Number(extras.monthly_amount)
                  : null,
              total_amount:
                extras.total_amount != null
                  ? Number(extras.total_amount)
                  : null,
              months: extras.months != null ? Number(extras.months) : null,
              note:
                typeof extras.note === "string"
                  ? (extras.note as string)
                  : null,
            };
          }
          if (action === "charge_card") {
            const amt = Number(extras.amount ?? 0);
            next.balance = Math.max(
              0,
              Math.round((next.balance - amt) * 100) / 100,
            );
            next.last_payment_at = now;
            next.last_payment_amount = amt;
            next.payment_method = "card";
          }
          if (action === "write_off") {
            const amt = Number(extras.amount ?? next.balance);
            next.balance = Math.max(
              0,
              Math.round((next.balance - amt) * 100) / 100,
            );
          }
          return next;
        }),
      );
    },
    [],
  );

  const runAction = useCallback(
    async (rowId: string, action: string, extras: Record<string, unknown> = {}) => {
      setBusyRow(rowId);
      applyOptimistic(rowId, action, extras);
      try {
        const res = await fetch(
          `/api/billing/patient-billing/${encodeURIComponent(rowId)}/action`,
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
        setMessage({
          tone: "success",
          text: `Action "${action.replace(/_/g, " ")}" applied.`,
        });
        // Reconcile against the server.
        void load();
      } catch (e) {
        setMessage({
          tone: "error",
          text: e instanceof Error ? e.message : "Action failed",
        });
        void load();
      } finally {
        setBusyRow(null);
      }
    },
    [organizationId, load, applyOptimistic],
  );

  const promptAmount = (label: string, suggested?: number): number | null => {
    const v = window.prompt(label, suggested != null ? String(suggested) : "");
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      window.alert("Enter a positive number.");
      return null;
    }
    return Math.round(n * 100) / 100;
  };

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      {
        id: "send_invoice",
        label: "Send invoice",
        variant: "primary",
        onClick: (r) => void runAction(r.id, "send_invoice"),
        disabled: (r) => busyRow === r.id || r.open_invoice_count === 0,
      },
      {
        id: "charge_card",
        label: "Charge card",
        onClick: (r) => {
          const amt = promptAmount(`Charge card — amount`, r.balance);
          if (amt == null) return;
          void runAction(r.id, "charge_card", { amount: amt });
        },
        disabled: (r) => busyRow === r.id || r.balance <= 0,
      },
      {
        id: "send_reminder",
        label: "Reminder",
        onClick: (r) => void runAction(r.id, "send_reminder"),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "create_payment_plan",
        label: "Plan",
        onClick: (r) => {
          const monthly = promptAmount(
            `Payment plan — monthly amount`,
            Math.max(25, Math.round(r.balance / 6)),
          );
          if (monthly == null) return;
          const months = Number(
            window.prompt("Number of months", "6") ?? "0",
          );
          if (!Number.isFinite(months) || months <= 0) return;
          void runAction(r.id, "create_payment_plan", {
            monthly_amount: monthly,
            months,
            total_amount: Math.round(monthly * months * 100) / 100,
          });
        },
        disabled: (r) => busyRow === r.id || r.balance <= 0,
      },
      {
        id: "send_to_collections_review",
        label: "Collections",
        onClick: (r) => {
          if (!window.confirm("Route this client's balance to collections review?")) return;
          void runAction(r.id, "send_to_collections_review");
        },
        disabled: (r) => busyRow === r.id || r.in_collections,
      },
      {
        id: "write_off",
        label: "Write off",
        variant: "danger",
        onClick: (r) => {
          const amt = promptAmount("Write off — amount", r.balance);
          if (amt == null) return;
          if (
            !window.confirm(
              `Write off ${formatMoney(amt)} from ${r.client_name}?`,
            )
          ) {
            return;
          }
          void runAction(r.id, "write_off", { amount: amt });
        },
        disabled: (r) => busyRow === r.id || r.balance <= 0,
      },
    ],
    [runAction, busyRow],
  );

  const selectedRow = useMemo(
    () => items.find((r) => r.id === selectedId) ?? null,
    [items, selectedId],
  );

  const detailTabs: DetailTab[] = useMemo(() => {
    if (!selectedRow) return [];
    const row = selectedRow;
    const labeled = (label: string, value: ReactNode) => (
      <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
        <span style={{ color: "#64748b", minWidth: 160 }}>{label}</span>
        <span>{value}</span>
      </div>
    );
    return [
      {
        id: "invoices",
        label: "Invoices",
        render: () =>
          row.invoices.length === 0 ? (
            <p style={{ fontSize: 13, color: "#64748b" }}>No open invoices.</p>
          ) : (
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "4px 6px" }}>#</th>
                  <th style={{ padding: "4px 6px" }}>DOS</th>
                  <th style={{ padding: "4px 6px" }}>Status</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>
                    Responsibility
                  </th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Paid</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>
                    Balance
                  </th>
                </tr>
              </thead>
              <tbody>
                {row.invoices.map((i) => (
                  <tr key={i.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "4px 6px" }}>{i.invoice_number}</td>
                    <td style={{ padding: "4px 6px" }}>{formatDate(i.dos)}</td>
                    <td style={{ padding: "4px 6px" }}>{i.invoice_status}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      {formatMoney(i.responsibility)}
                    </td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      {formatMoney(i.paid)}
                    </td>
                    <td
                      style={{
                        padding: "4px 6px",
                        textAlign: "right",
                        fontWeight: 600,
                      }}
                    >
                      {formatMoney(i.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ),
      },
      {
        id: "responsibility",
        label: "Claim responsibility details",
        render: () => (
          <div>
            {labeled("Client", row.client_name)}
            {labeled("Primary clinician", row.primary_clinician_name ?? "—")}
            {labeled("Payer", row.payer_name ?? "Self-pay")}
            {labeled("Open invoices", String(row.open_invoice_count))}
            {labeled("Total balance", formatMoney(row.balance))}
            {labeled(
              "Oldest DOS",
              row.oldest_dos
                ? `${formatDate(row.oldest_dos)} (${row.oldest_dos_days ?? 0}d)`
                : "—",
            )}
            {labeled("Aging bucket", row.aging_bucket.replace("_", "–"))}
            {labeled("Priority", priorityBadge(row.priority))}
            <div style={{ marginTop: 12 }}>
              <div style={{ color: "#64748b", fontSize: 12, marginBottom: 4 }}>
                Linked claims
              </div>
              {row.invoices.filter((i) => i.professional_claim_id).length === 0 ? (
                <p style={{ fontSize: 13, color: "#94a3b8" }}>
                  No linked professional claims.
                </p>
              ) : (
                <ul style={{ paddingLeft: 18, fontSize: 13, margin: 0 }}>
                  {row.invoices
                    .filter((i) => i.professional_claim_id)
                    .map((i) => (
                      <li key={i.id}>
                        Claim {i.professional_claim_id?.slice(0, 8)} —{" "}
                        responsibility {formatMoney(i.responsibility)} (
                        {i.source ?? "era_pr"})
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </div>
        ),
      },
      {
        id: "payments",
        label: "Payment history",
        render: () =>
          row.payments.length === 0 ? (
            <p style={{ fontSize: 13, color: "#64748b" }}>No payments yet.</p>
          ) : (
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "4px 6px" }}>Date</th>
                  <th style={{ padding: "4px 6px" }}>Method</th>
                  <th style={{ padding: "4px 6px" }}>Status</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>
                    Amount
                  </th>
                  <th style={{ padding: "4px 6px" }}>Memo</th>
                </tr>
              </thead>
              <tbody>
                {row.payments.map((p) => (
                  <tr key={p.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "4px 6px" }}>{formatDate(p.paid_at)}</td>
                    <td style={{ padding: "4px 6px" }}>
                      {labelMethod(p.payment_method)}
                    </td>
                    <td style={{ padding: "4px 6px" }}>{p.payment_status}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      {formatMoney(p.amount)}
                    </td>
                    <td style={{ padding: "4px 6px", color: "#64748b" }}>
                      {p.memo ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ),
      },
      {
        id: "communication",
        label: "Communication log",
        render: () =>
          row.communications.length === 0 ? (
            <p style={{ fontSize: 13, color: "#64748b" }}>
              No communications recorded.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {row.communications.map((c) => (
                <li
                  key={c.id}
                  style={{
                    padding: "6px 0",
                    borderTop: "1px solid #e2e8f0",
                    fontSize: 13,
                  }}
                >
                  <div style={{ color: "#64748b", fontSize: 11 }}>
                    {formatDate(c.created_at)} ·{" "}
                    {c.event_type.replace("patient_billing_", "")}
                  </div>
                  <div>{c.event_summary ?? c.event_type}</div>
                  {c.metadata && Object.keys(c.metadata).length > 0 ? (
                    <div style={{ color: "#94a3b8", fontSize: 11 }}>
                      {Object.entries(c.metadata)
                        .filter(
                          ([k]) =>
                            k !== "invoice_ids" && k !== "invoice_count",
                        )
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(" · ")}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ),
      },
      {
        id: "payment_plan",
        label: "Payment plan",
        render: () =>
          row.payment_plan ? (
            <div>
              {labeled("Created", formatDate(row.payment_plan.created_at))}
              {labeled(
                "Monthly amount",
                row.payment_plan.monthly_amount != null
                  ? formatMoney(row.payment_plan.monthly_amount)
                  : "—",
              )}
              {labeled("Months", String(row.payment_plan.months ?? "—"))}
              {labeled(
                "Total amount",
                row.payment_plan.total_amount != null
                  ? formatMoney(row.payment_plan.total_amount)
                  : "—",
              )}
              {row.payment_plan.note ? labeled("Note", row.payment_plan.note) : null}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: "#64748b" }}>
              No active payment plan for this client.
            </p>
          ),
      },
    ];
  }, [selectedRow]);

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const row = selectedRow;
    return [
      {
        id: "send_invoice",
        label: "Send invoice",
        variant: "primary",
        onClick: () => void runAction(row.id, "send_invoice"),
        disabled: row.open_invoice_count === 0,
      },
      {
        id: "charge_card",
        label: "Charge card",
        onClick: () => {
          const amt = promptAmount("Charge card — amount", row.balance);
          if (amt == null) return;
          void runAction(row.id, "charge_card", { amount: amt });
        },
        disabled: row.balance <= 0,
      },
      {
        id: "create_payment_plan",
        label: "Create payment plan",
        onClick: () => {
          const monthly = promptAmount(
            "Payment plan — monthly amount",
            Math.max(25, Math.round(row.balance / 6)),
          );
          if (monthly == null) return;
          const months = Number(window.prompt("Number of months", "6") ?? "0");
          if (!Number.isFinite(months) || months <= 0) return;
          void runAction(row.id, "create_payment_plan", {
            monthly_amount: monthly,
            months,
            total_amount: Math.round(monthly * months * 100) / 100,
          });
        },
        disabled: row.balance <= 0,
      },
      {
        id: "send_reminder",
        label: "Send reminder",
        onClick: () => void runAction(row.id, "send_reminder"),
      },
      {
        id: "send_to_collections_review",
        label: "Send to collections review",
        onClick: () => {
          if (!window.confirm("Route this client's balance to collections review?")) return;
          void runAction(row.id, "send_to_collections_review");
        },
        disabled: row.in_collections,
      },
      {
        id: "write_off",
        label: "Write off",
        variant: "danger",
        onClick: () => {
          const amt = promptAmount("Write off — amount", row.balance);
          if (amt == null) return;
          if (
            !window.confirm(
              `Write off ${formatMoney(amt)} from ${row.client_name}?`,
            )
          ) {
            return;
          }
          void runAction(row.id, "write_off", { amount: amt });
        },
        disabled: row.balance <= 0,
      },
    ];
  }, [selectedRow, runAction]);

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
        invoice_ready: 0,
        statements_sent: 0,
        "30_days": 0,
        "60_days": 0,
        "90_days": 0,
        collections_review: 0,
        payment_plans: 0,
      } as Record<Tab, number>,
    };
    return [
      { id: "count", label: "Open clients", value: String(s.total_count) },
      { id: "dollars", label: "Total balance", value: formatMoney(s.total_dollars) },
      {
        id: "age",
        label: "Oldest age",
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
      title="Patient Billing"
      description="Self-pay balances after insurance has processed — statements, payments, plans, and collections review."
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
      filterUrlNamespace="patbill"
      rows={items}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage="No clients in this tab."
      selectedRowId={selectedId}
      onSelectRow={setSelectedId}
      rowActions={rowActions}
      detailTabs={detailTabs}
      detailActions={detailActions}
      message={message}
    />
  );
}
