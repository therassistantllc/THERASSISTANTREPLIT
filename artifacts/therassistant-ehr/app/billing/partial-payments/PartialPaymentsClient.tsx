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
  | "partial_payment"
  | "multiple_line_issues"
  | "bundled_payment"
  | "split_responsibility"
  | "secondary_needed";

type State =
  | "open"
  | "payment_accepted"
  | "appealed"
  | "billed_secondary"
  | "transferred_to_patient"
  | "resolved";

type Adjustment = {
  group_code: string;
  reason_code: string;
  amount: number;
  description?: string;
};

type EraLine = {
  line_number: number;
  procedure_code: string;
  billed_amount: number;
  allowed_amount: number;
  paid_amount: number;
  adjustments: Adjustment[];
};

type ClaimLine = {
  line_number: number;
  procedure_code: string;
  charge_amount: number;
  units: number;
  service_date: string | null;
};

type Row = {
  id: string;
  era_claim_payment_id: string | null;
  claim_number: string;
  client_id: string | null;
  client_name: string;
  payer_profile_id: string | null;
  payer_name: string;
  billed_amount: number;
  allowed_amount: number;
  paid_amount: number;
  adjustment_amount: number;
  remaining_balance: number;
  patient_responsibility: number;
  responsibility_type: string;
  service_date: string | null;
  clinician_id: string | null;
  clinician_name: string | null;
  age_days: number | null;
  aging_bucket: string;
  priority: "low" | "normal" | "high" | "urgent";
  tabs: Tab[];
  state: State;
  status_label: string;
  era_service_lines: EraLine[];
  claim_service_lines: ClaimLine[];
  cas_adjustments: Adjustment[];
  has_secondary_policy: boolean;
  secondary_payer_name: string | null;
  assigned_to_user_id: string | null;
  last_action_at: string | null;
  last_action: string | null;
  workqueue_item_id: string | null;
  carc_codes: string[];
  rarc_codes: string[];
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
  { id: "partial_payment", label: "Partial Payment" },
  { id: "multiple_line_issues", label: "Multiple Line Issues" },
  { id: "bundled_payment", label: "Bundled Payment" },
  { id: "split_responsibility", label: "Split Responsibility" },
  { id: "secondary_needed", label: "Secondary Needed" },
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
    case "payment_accepted": return pill("Accepted", "#dcfce7", "#166534");
    case "appealed": return pill("Appealed", "#ede9fe", "#5b21b6");
    case "billed_secondary": return pill("To secondary", "#dbeafe", "#1e40af");
    case "transferred_to_patient": return pill("On client", "#ffedd5", "#9a3412");
    case "resolved": return pill("Resolved", "#f1f5f9", "#475569");
    default: return pill("Open", "#e0f2fe", "#075985");
  }
}

function priorityPill(p: Row["priority"]): ReactNode {
  switch (p) {
    case "urgent": return pill("Urgent", "#fee2e2", "#991b1b");
    case "high": return pill("High", "#fef3c7", "#92400e");
    case "normal": return pill("Normal", "#e0f2fe", "#075985");
    default: return pill("Low", "#f1f5f9", "#475569");
  }
}

export default function PartialPaymentsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);

  const [items, setItems] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);
  const [activeTab, setActiveTab] = useState<Tab>("partial_payment");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ organizationId, tab: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) qs.set(k, v);
      }
      const res = await fetch(`/api/billing/partial-payments?${qs.toString()}`, {
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
    for (const i of items) if (i.payer_name) set.add(i.payer_name);
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
          { value: "payment_accepted", label: "Payment accepted" },
          { value: "appealed", label: "Appealed" },
          { value: "billed_secondary", label: "Billed secondary" },
          { value: "transferred_to_patient", label: "On client" },
        ],
      },
      { id: "minAmount", label: "Min $ remaining", kind: "number" },
      { id: "maxAmount", label: "Max $ remaining", kind: "number" },
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
          { value: "normal", label: "Normal" },
          { value: "high", label: "High" },
          { value: "urgent", label: "Urgent" },
        ],
      },
      { id: "carcRarc", label: "CARC / RARC", kind: "text", placeholder: "e.g. 45 or N130" },
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
      { id: "payer", header: "Payer", cell: (r) => r.payer_name },
      { id: "billed", header: "Billed", align: "right", cell: (r) => formatMoney(r.billed_amount) },
      { id: "allowed", header: "Allowed", align: "right", cell: (r) => formatMoney(r.allowed_amount) },
      { id: "paid", header: "Paid", align: "right", cell: (r) => formatMoney(r.paid_amount) },
      { id: "adj", header: "Adjustment", align: "right", cell: (r) => formatMoney(r.adjustment_amount) },
      {
        id: "remaining",
        header: "Remaining",
        align: "right",
        cell: (r) => (
          <span style={{ fontWeight: 600, color: r.remaining_balance > 0 ? "#9a3412" : "#475569" }}>
            {formatMoney(r.remaining_balance)}
          </span>
        ),
      },
      { id: "resp", header: "Responsibility", cell: (r) => r.responsibility_type },
      { id: "priority", header: "Priority", cell: (r) => priorityPill(r.priority) },
      { id: "status", header: "Status", cell: (r) => statePill(r.state) },
    ],
    [],
  );

  const runAction = useCallback(
    async (rowId: string, action: string, extras: Record<string, unknown> = {}) => {
      setBusyRow(rowId);
      try {
        const res = await fetch(
          `/api/billing/partial-payments/${encodeURIComponent(rowId)}/action`,
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
        // Optimistic local state update
        setItems((prev) =>
          prev.map((r) => {
            if (r.id !== rowId) return r;
            const next: Row = { ...r };
            switch (action) {
              case "accept_payment":
                next.state = "payment_accepted";
                next.status_label = "Payment accepted";
                break;
              case "appeal_balance":
                next.state = "appealed";
                next.status_label = "Appeal filed";
                break;
              case "bill_secondary":
                next.state = "billed_secondary";
                next.status_label = "Billed secondary";
                break;
              case "transfer_to_patient":
                next.state = "transferred_to_patient";
                next.status_label = "On client";
                break;
            }
            next.last_action_at = new Date().toISOString();
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

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      {
        id: "accept_payment",
        label: "Accept payment",
        variant: "primary",
        onClick: (r) => void runAction(r.id, "accept_payment"),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "appeal_balance",
        label: "Appeal",
        onClick: (r) => void runAction(r.id, "appeal_balance"),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "bill_secondary",
        label: "Bill secondary",
        onClick: (r) => void runAction(r.id, "bill_secondary"),
        disabled: (r) => busyRow === r.id || !r.has_secondary_policy,
      },
      {
        id: "transfer_to_patient",
        label: "Transfer to client",
        onClick: (r) => void runAction(r.id, "transfer_to_patient"),
        disabled: (r) => busyRow === r.id,
      },
    ],
    [runAction, busyRow],
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

    const eraLineRows = row.era_service_lines;
    const claimLineMap = new Map<number, ClaimLine>();
    for (const cl of row.claim_service_lines) claimLineMap.set(cl.line_number, cl);

    return [
      {
        id: "era_breakdown",
        label: "ERA line breakdown",
        render: () => (
          <div>
            {eraLineRows.length === 0 ? (
              <p style={{ fontSize: 13, color: "#64748b" }}>
                No service-line detail on the ERA — only claim-level totals were
                reported.
              </p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", background: "#f8fafc" }}>
                    <th style={{ padding: 6 }}>#</th>
                    <th style={{ padding: 6 }}>Code</th>
                    <th style={{ padding: 6, textAlign: "right" }}>Billed</th>
                    <th style={{ padding: 6, textAlign: "right" }}>Allowed</th>
                    <th style={{ padding: 6, textAlign: "right" }}>Paid</th>
                    <th style={{ padding: 6 }}>Adjustments</th>
                  </tr>
                </thead>
                <tbody>
                  {eraLineRows.map((l) => (
                    <tr key={l.line_number} style={{ borderTop: "1px solid #e2e8f0" }}>
                      <td style={{ padding: 6 }}>{l.line_number}</td>
                      <td style={{ padding: 6, fontFamily: "monospace" }}>{l.procedure_code}</td>
                      <td style={{ padding: 6, textAlign: "right" }}>{formatMoney(l.billed_amount)}</td>
                      <td style={{ padding: 6, textAlign: "right" }}>{formatMoney(l.allowed_amount)}</td>
                      <td style={{ padding: 6, textAlign: "right" }}>{formatMoney(l.paid_amount)}</td>
                      <td style={{ padding: 6 }}>
                        {l.adjustments.length === 0 ? (
                          <span style={{ color: "#94a3b8" }}>—</span>
                        ) : (
                          l.adjustments
                            .map((a) =>
                              `${a.group_code}/${a.reason_code} ${formatMoney(a.amount)}`,
                            )
                            .join(", ")
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ),
      },
      {
        id: "claim_comparison",
        label: "Claim line comparison",
        render: () => (
          <div>
            <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 8px" }}>
              Submitted 837P lines vs. what the ERA paid back.
            </p>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", background: "#f8fafc" }}>
                  <th style={{ padding: 6 }}>#</th>
                  <th style={{ padding: 6 }}>Code</th>
                  <th style={{ padding: 6 }}>Units</th>
                  <th style={{ padding: 6, textAlign: "right" }}>Charge</th>
                  <th style={{ padding: 6, textAlign: "right" }}>ERA paid</th>
                  <th style={{ padding: 6, textAlign: "right" }}>Δ</th>
                </tr>
              </thead>
              <tbody>
                {row.claim_service_lines.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 8, color: "#94a3b8" }}>
                      No service lines on file for this claim.
                    </td>
                  </tr>
                ) : (
                  row.claim_service_lines.map((cl) => {
                    const era = eraLineRows.find((l) => l.line_number === cl.line_number);
                    const eraPaid = era?.paid_amount ?? 0;
                    const delta = Math.round((cl.charge_amount - eraPaid) * 100) / 100;
                    return (
                      <tr key={cl.line_number} style={{ borderTop: "1px solid #e2e8f0" }}>
                        <td style={{ padding: 6 }}>{cl.line_number}</td>
                        <td style={{ padding: 6, fontFamily: "monospace" }}>{cl.procedure_code}</td>
                        <td style={{ padding: 6 }}>{cl.units}</td>
                        <td style={{ padding: 6, textAlign: "right" }}>{formatMoney(cl.charge_amount)}</td>
                        <td style={{ padding: 6, textAlign: "right" }}>{formatMoney(eraPaid)}</td>
                        <td style={{ padding: 6, textAlign: "right", color: delta > 0 ? "#9a3412" : "#166534" }}>
                          {formatMoney(delta)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        ),
      },
      {
        id: "adj_codes",
        label: "Adjustment codes",
        render: () => {
          const allAdj: Array<Adjustment & { line?: number }> = [
            ...row.cas_adjustments.map((a) => ({ ...a })),
            ...row.era_service_lines.flatMap((l) =>
              l.adjustments.map((a) => ({ ...a, line: l.line_number })),
            ),
          ];
          return (
            <div>
              {labeledItem(
                "CARC codes",
                row.carc_codes.length ? row.carc_codes.join(", ") : "—",
              )}
              {labeledItem(
                "RARC codes",
                row.rarc_codes.length ? row.rarc_codes.join(", ") : "—",
              )}
              <div style={{ marginTop: 12 }}>
                {allAdj.length === 0 ? (
                  <p style={{ fontSize: 13, color: "#64748b" }}>
                    No CAS adjustment rows on this ERA.
                  </p>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ textAlign: "left", background: "#f8fafc" }}>
                        <th style={{ padding: 6 }}>Group</th>
                        <th style={{ padding: 6 }}>Reason</th>
                        <th style={{ padding: 6, textAlign: "right" }}>Amount</th>
                        <th style={{ padding: 6 }}>Line</th>
                        <th style={{ padding: 6 }}>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allAdj.map((a, idx) => (
                        <tr key={idx} style={{ borderTop: "1px solid #e2e8f0" }}>
                          <td style={{ padding: 6 }}>{a.group_code || "—"}</td>
                          <td style={{ padding: 6, fontFamily: "monospace" }}>{a.reason_code || "—"}</td>
                          <td style={{ padding: 6, textAlign: "right" }}>{formatMoney(a.amount)}</td>
                          <td style={{ padding: 6 }}>{a.line ?? "Claim"}</td>
                          <td style={{ padding: 6, color: "#64748b" }}>{a.description ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          );
        },
      },
      {
        id: "pr_calc",
        label: "Client responsibility",
        render: () => {
          const billed = row.billed_amount;
          const paid = row.paid_amount;
          const adj = row.adjustment_amount;
          const pr = row.patient_responsibility;
          const remaining = row.remaining_balance;
          return (
            <div>
              {labeledItem("Billed", formatMoney(billed))}
              {labeledItem("Allowed", formatMoney(row.allowed_amount))}
              {labeledItem("Insurance paid", formatMoney(paid))}
              {labeledItem("Adjustments (CAS)", formatMoney(adj))}
              {labeledItem(
                "Remaining (billed − paid − adj)",
                <strong>{formatMoney(remaining)}</strong>,
              )}
              {labeledItem(
                "Client responsibility (CLP05)",
                <strong>{formatMoney(pr)}</strong>,
              )}
              {labeledItem("Responsibility type", row.responsibility_type)}
              {labeledItem(
                "Secondary on file",
                row.has_secondary_policy
                  ? pill(row.secondary_payer_name ?? "Yes", "#dcfce7", "#166534")
                  : pill("No", "#fee2e2", "#991b1b"),
              )}
              <p style={{ fontSize: 12, color: "#64748b", marginTop: 12 }}>
                Use <em>Transfer to client</em> to open a $
                {pr > 0 ? pr : remaining} client invoice, <em>Bill secondary</em>{" "}
                to send the remainder to the secondary payer, or <em>Appeal</em>{" "}
                to push back on an underpayment.
              </p>
            </div>
          );
        },
      },
      {
        id: "note",
        label: "Add note",
        render: () => (
          <div>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Note (will be saved on this claim and written to the audit log)…"
              rows={4}
              style={{
                width: "100%",
                fontSize: 13,
                padding: 8,
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  if (!noteDraft.trim()) return;
                  void runAction(row.id, "add_note", { note: noteDraft.trim() })
                    .then(() => setNoteDraft(""));
                }}
                disabled={!noteDraft.trim() || busyRow === row.id}
                style={{
                  fontSize: 12,
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #2563eb",
                  background: "#2563eb",
                  color: "white",
                  cursor: noteDraft.trim() ? "pointer" : "not-allowed",
                  opacity: noteDraft.trim() ? 1 : 0.6,
                }}
              >
                Save note
              </button>
              <button
                type="button"
                onClick={() => setNoteDraft("")}
                style={{
                  fontSize: 12,
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                Clear
              </button>
            </div>
            {row.last_action ? (
              <p style={{ fontSize: 12, color: "#64748b", marginTop: 12 }}>
                Last action: <strong>{row.last_action}</strong>
                {row.last_action_at ? ` · ${formatDate(row.last_action_at)}` : ""}
              </p>
            ) : null}
          </div>
        ),
      },
    ];
  }, [selectedRow, noteDraft, runAction, busyRow]);

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const row = selectedRow;
    return [
      {
        id: "accept_payment",
        label: "Accept payment",
        variant: "primary",
        onClick: () => void runAction(row.id, "accept_payment"),
      },
      {
        id: "appeal_balance",
        label: "Appeal balance",
        onClick: () => void runAction(row.id, "appeal_balance"),
      },
      {
        id: "bill_secondary",
        label: row.has_secondary_policy ? "Bill secondary" : "Bill secondary (no policy)",
        onClick: () => void runAction(row.id, "bill_secondary"),
        disabled: !row.has_secondary_policy,
      },
      {
        id: "transfer_to_patient",
        label: "Transfer to client",
        onClick: () => void runAction(row.id, "transfer_to_patient"),
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
        partial_payment: 0,
        multiple_line_issues: 0,
        bundled_payment: 0,
        split_responsibility: 0,
        secondary_needed: 0,
      } as Record<Tab, number>,
    };
    return [
      { id: "count", label: "Open claims", value: String(s.total_count) },
      { id: "dollars", label: "Total remaining", value: formatMoney(s.total_dollars) },
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
      title="Partial Payments"
      description="Claims paid in part — review ERA adjustments, pursue the remainder, transfer to client, or appeal."
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
      filterUrlNamespace="partial"
      rows={items}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage="No partial-payment claims in this tab."
      selectedRowId={selectedId}
      onSelectRow={setSelectedId}
      rowActions={rowActions}
      detailTabs={detailTabs}
      detailActions={detailActions}
      message={message}
    />
  );
}
