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
  | "ready_for_secondary"
  | "missing_primary_eob"
  | "cob_issue"
  | "secondary_claim_error"
  | "secondary_submitted";

type State =
  | "ready"
  | "missing_eob"
  | "cob_issue"
  | "hold"
  | "generated"
  | "submitted"
  | "error";

type Policy = {
  id: string;
  priority: string;
  payer_id: string | null;
  payer_name: string | null;
  payer_type: string | null;
  policy_number: string | null;
  active: boolean;
};

type EraSummary = {
  era_payment_id: string | null;
  era_batch_id: string | null;
  payer_paid: number;
  patient_responsibility: number;
  total_charge: number;
  posted_at: string | null;
  payer_claim_control_number: string | null;
  cas_adjustments: unknown[];
  service_lines: unknown[];
  carc_codes: string[];
  rarc_codes: string[];
};

type Row = {
  id: string;
  claim_number: string;
  client_id: string | null;
  client_name: string;
  practice_id: string | null;
  primary_payer_id: string | null;
  primary_payer_name: string | null;
  secondary_payer_id: string | null;
  secondary_payer_name: string | null;
  date_of_service: string | null;
  primary_paid: number;
  patient_responsibility: number;
  secondary_expected: number;
  total_charge: number;
  claim_status: string;
  has_primary_eob: boolean;
  primary_eob_source: "era" | "manual" | null;
  eob_attached_at: string | null;
  state: State;
  tabs: Tab[];
  last_action_at: string | null;
  last_error: string | null;
  days_since_dos: number | null;
  aging_bucket: string;
  priority: "low" | "medium" | "high" | "critical";
  clinician_id: string | null;
  clinician_name: string | null;
  assigned_biller_user_id: string | null;
  assigned_biller_name: string | null;
  follow_up_due: string | null;
  policies: Policy[];
  era: EraSummary | null;
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
  { id: "ready_for_secondary", label: "Ready for Secondary" },
  { id: "missing_primary_eob", label: "Missing Primary EOB" },
  { id: "cob_issue", label: "COB Issue" },
  { id: "secondary_claim_error", label: "Secondary Claim Error" },
  { id: "secondary_submitted", label: "Secondary Submitted" },
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
    case "submitted": return pill("Submitted", "#dcfce7", "#166534");
    case "generated": return pill("Generated", "#e0e7ff", "#3730a3");
    case "missing_eob": return pill("Missing EOB", "#fef9c3", "#854d0e");
    case "cob_issue": return pill("COB issue", "#ffedd5", "#9a3412");
    case "hold": return pill("Hold", "#f1f5f9", "#475569");
    case "error": return pill("Error", "#fee2e2", "#991b1b");
    default: return pill("Ready", "#e0f2fe", "#075985");
  }
}

export default function SecondaryBillingClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);

  const [items, setItems] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);
  const [activeTab, setActiveTab] = useState<Tab>("ready_for_secondary");
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
      const res = await fetch(`/api/billing/secondary-billing?${qs.toString()}`, {
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
    for (const i of items) {
      if (i.primary_payer_name) set.add(i.primary_payer_name);
      if (i.secondary_payer_name) set.add(i.secondary_payer_name);
    }
    return Array.from(set).map((p) => ({ value: p, label: p }));
  }, [items]);

  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) {
      if (i.client_id) m.set(i.client_id, i.client_name);
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const practiceOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) {
      if (i.practice_id) m.set(i.practice_id, i.practice_id);
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const assignedBillerOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) {
      if (i.assigned_biller_user_id) {
        m.set(
          i.assigned_biller_user_id,
          i.assigned_biller_name ?? i.assigned_biller_user_id.slice(0, 8),
        );
      }
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const carcRarcOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      for (const c of i.era?.carc_codes ?? []) if (c) set.add(c.toUpperCase());
      for (const c of i.era?.rarc_codes ?? []) if (c) set.add(c.toUpperCase());
    }
    return Array.from(set)
      .sort()
      .map((value) => ({ value, label: value }));
  }, [items]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "select", options: practiceOptions },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicianOptions },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "select",
        options: assignedBillerOptions,
      },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "select", options: clientOptions },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
      {
        id: "carcRarc",
        label: "CARC / RARC",
        kind: "select",
        options: carcRarcOptions,
      },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "ready", label: "Ready" },
          { value: "missing_eob", label: "Missing EOB" },
          { value: "cob_issue", label: "COB issue" },
          { value: "generated", label: "Generated" },
          { value: "submitted", label: "Submitted" },
          { value: "hold", label: "Hold" },
          { value: "error", label: "Error" },
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
    [
      clinicianOptions,
      payerOptions,
      clientOptions,
      practiceOptions,
      assignedBillerOptions,
      carcRarcOptions,
    ],
  );

  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.client_name },
      {
        id: "primary_payer",
        header: "Primary payer",
        cell: (r) => r.primary_payer_name ?? "—",
      },
      {
        id: "secondary_payer",
        header: "Secondary payer",
        cell: (r) =>
          r.secondary_payer_name ?? (
            <span style={{ color: "#b91c1c", fontSize: 12 }}>Missing</span>
          ),
      },
      { id: "dos", header: "DOS", cell: (r) => formatDate(r.date_of_service) },
      {
        id: "primary_paid",
        header: "Primary paid",
        align: "right",
        cell: (r) => formatMoney(r.primary_paid),
      },
      {
        id: "patient_resp",
        header: "Client responsibility",
        align: "right",
        cell: (r) => formatMoney(r.patient_responsibility),
      },
      {
        id: "secondary_expected",
        header: "Secondary expected",
        align: "right",
        cell: (r) => formatMoney(r.secondary_expected),
      },
      { id: "status", header: "Claim status", cell: (r) => statePill(r.state) },
    ],
    [],
  );

  const runAction = useCallback(
    async (rowId: string, action: string, extras: Record<string, unknown> = {}) => {
      setBusyRow(rowId);
      try {
        const res = await fetch(
          `/api/billing/secondary-billing/${encodeURIComponent(rowId)}/action`,
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
            const now = new Date().toISOString();
            next.last_action_at = now;
            switch (action) {
              case "generate":
                next.state = "generated";
                break;
              case "submit":
                next.state = "submitted";
                next.tabs = ["secondary_submitted"];
                break;
              case "attach_eob":
                next.has_primary_eob = true;
                next.primary_eob_source = "manual";
                next.eob_attached_at = now;
                if (next.state === "missing_eob") {
                  next.state = next.secondary_payer_name ? "ready" : "cob_issue";
                  next.tabs = next.secondary_payer_name
                    ? ["ready_for_secondary"]
                    : ["cob_issue"];
                }
                break;
              case "hold":
                next.state = "hold";
                break;
              case "reopen":
                next.state = next.has_primary_eob
                  ? next.secondary_payer_name
                    ? "ready"
                    : "cob_issue"
                  : "missing_eob";
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

  const promptUpdateInsurance = useCallback(
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
            }`,
        )
        .join("\n");
      const answer = window.prompt(
        `Reorder policies — primary-first, comma-separated (e.g. 2,1):\n\n${lines}`,
      );
      if (!answer) return;
      const indices = answer
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= row.policies.length);
      if (indices.length === 0) return;
      const orderedIds = indices.map((n) => row.policies[n - 1].id);
      void runAction(row.id, "update_insurance", { ordered_policy_ids: orderedIds });
    },
    [runAction],
  );

  const promptAttachEob = useCallback(
    (row: Row) => {
      const ref = window.prompt(
        `Attach primary EOB for ${row.client_name} (${row.claim_number}).\nOptionally enter a reference (check #, document id, etc.):`,
        "",
      );
      // Cancel returns null; empty string is a valid "attach without ref".
      if (ref === null) return;
      void runAction(row.id, "attach_eob", { eob_reference: ref });
    },
    [runAction],
  );

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      {
        id: "generate",
        label: "Generate",
        variant: "primary",
        onClick: (r) => void runAction(r.id, "generate"),
        disabled: (r) =>
          busyRow === r.id || !r.has_primary_eob || !r.secondary_payer_name,
      },
      {
        id: "attach_eob",
        label: "Attach EOB",
        onClick: (r) => promptAttachEob(r),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "hold",
        label: "Hold",
        onClick: (r) => void runAction(r.id, "hold"),
        disabled: (r) => busyRow === r.id || r.state === "hold",
      },
      {
        id: "update_insurance",
        label: "Update insurance",
        onClick: (r) => promptUpdateInsurance(r),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "submit",
        label: "Submit",
        variant: "success",
        onClick: (r) => void runAction(r.id, "submit"),
        disabled: (r) =>
          busyRow === r.id ||
          !r.has_primary_eob ||
          !r.secondary_payer_name ||
          r.state === "submitted",
      },
    ],
    [runAction, promptAttachEob, promptUpdateInsurance, busyRow],
  );

  const selectedRow = useMemo(
    () => items.find((r) => r.id === selectedId) ?? null,
    [items, selectedId],
  );

  const labeledItem = (label: string, value: ReactNode) => (
    <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
      <span style={{ color: "#64748b", minWidth: 170 }}>{label}</span>
      <span>{value}</span>
    </div>
  );

  const detailTabs: DetailTab[] = useMemo(() => {
    if (!selectedRow) return [];
    const row = selectedRow;
    const secondary = row.policies.find((p) => p.priority === "secondary") ?? null;
    const sortedPolicies = [...row.policies].sort((a, b) => {
      const order = (p: string) =>
        p === "primary" ? 0 : p === "secondary" ? 1 : p === "tertiary" ? 2 : 3;
      return order(a.priority) - order(b.priority);
    });

    return [
      {
        id: "primary_eob",
        label: "Primary ERA/EOB",
        render: () => (
          <div>
            {labeledItem(
              "EOB on file",
              row.has_primary_eob
                ? pill(
                    row.primary_eob_source === "era" ? "Yes (ERA)" : "Yes (manual)",
                    "#dcfce7",
                    "#166534",
                  )
                : pill("No", "#fee2e2", "#991b1b"),
            )}
            {labeledItem("Attached", formatDate(row.eob_attached_at))}
            {row.era ? (
              <>
                {labeledItem("ERA total charge", formatMoney(row.era.total_charge))}
                {labeledItem("Payer paid", formatMoney(row.era.payer_paid))}
                {labeledItem(
                  "Client responsibility",
                  formatMoney(row.era.patient_responsibility),
                )}
                {labeledItem(
                  "Payer claim control #",
                  row.era.payer_claim_control_number ?? "—",
                )}
                {Array.isArray(row.era.cas_adjustments) &&
                row.era.cas_adjustments.length > 0 ? (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>
                      Adjustments ({row.era.cas_adjustments.length})
                    </div>
                    <pre
                      style={{
                        fontSize: 11,
                        background: "#f8fafc",
                        padding: 8,
                        borderRadius: 6,
                        overflow: "auto",
                        maxHeight: 160,
                      }}
                    >
                      {JSON.stringify(row.era.cas_adjustments, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </>
            ) : (
              <p style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
                No matched 835 ERA on file.{" "}
                {row.has_primary_eob
                  ? "A manual EOB has been attached."
                  : "Attach the primary EOB to unblock secondary billing."}
              </p>
            )}
          </div>
        ),
      },
      {
        id: "secondary_insurance",
        label: "Secondary insurance",
        render: () => (
          <div>
            {secondary ? (
              <>
                {labeledItem("Payer", secondary.payer_name ?? "—")}
                {labeledItem("Payer type", secondary.payer_type ?? "—")}
                {labeledItem("Policy #", secondary.policy_number ?? "—")}
                {labeledItem(
                  "Active",
                  secondary.active
                    ? pill("Yes", "#dcfce7", "#166534")
                    : pill("No", "#fee2e2", "#991b1b"),
                )}
              </>
            ) : (
              <p style={{ fontSize: 13, color: "#b91c1c" }}>
                No active secondary policy on file. Update insurance order before
                generating a secondary claim.
              </p>
            )}
          </div>
        ),
      },
      {
        id: "cob_details",
        label: "COB details",
        render: () => (
          <div>
            <p style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>
              Insurance order
            </p>
            {sortedPolicies.length === 0 ? (
              <p style={{ fontSize: 13, color: "#64748b" }}>
                No active policies.
              </p>
            ) : (
              <ol style={{ paddingLeft: 18, margin: 0 }}>
                {sortedPolicies.map((p) => (
                  <li key={p.id} style={{ marginBottom: 6, fontSize: 13 }}>
                    <strong style={{ textTransform: "capitalize" }}>
                      {p.priority}
                    </strong>{" "}
                    — {p.payer_name ?? "Unknown payer"}
                    {p.payer_type ? (
                      <span style={{ color: "#64748b" }}> · {p.payer_type}</span>
                    ) : null}
                    {p.policy_number ? (
                      <div style={{ color: "#64748b", fontSize: 12 }}>
                        Policy #{p.policy_number}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={() => promptUpdateInsurance(row)}
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
        id: "secondary_preview",
        label: "Secondary claim preview",
        render: () => (
          <div>
            {labeledItem("Client", row.client_name)}
            {labeledItem("Claim #", row.claim_number)}
            {labeledItem("DOS", formatDate(row.date_of_service))}
            {labeledItem("Primary payer", row.primary_payer_name ?? "—")}
            {labeledItem("Secondary payer", row.secondary_payer_name ?? "—")}
            {labeledItem("Total charge", formatMoney(row.total_charge))}
            {labeledItem("Primary paid", formatMoney(row.primary_paid))}
            {labeledItem(
              "Client responsibility",
              formatMoney(row.patient_responsibility),
            )}
            {labeledItem(
              "Secondary expected",
              <strong>{formatMoney(row.secondary_expected)}</strong>,
            )}
            {labeledItem("Underlying claim status", row.claim_status)}
            {row.last_error ? (
              <div
                style={{
                  marginTop: 10,
                  padding: 8,
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#991b1b",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                Last error: {row.last_error}
              </div>
            ) : null}
            <p style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>
              Generating the secondary claim creates an 837P with COB loops
              populated from the primary ERA/EOB. Use Submit to transmit.
            </p>
          </div>
        ),
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
  }, [selectedRow, organizationId, promptUpdateInsurance]);

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const row = selectedRow;
    return [
      {
        id: "generate",
        label: "Generate secondary claim",
        variant: "primary",
        onClick: () => void runAction(row.id, "generate"),
        disabled: !row.has_primary_eob || !row.secondary_payer_name,
      },
      {
        id: "attach_eob",
        label: row.has_primary_eob ? "Re-attach primary EOB" : "Attach primary EOB",
        onClick: () => promptAttachEob(row),
      },
      {
        id: "hold",
        label: "Hold",
        onClick: () => void runAction(row.id, "hold"),
        disabled: row.state === "hold",
      },
      {
        id: "update_insurance",
        label: "Update insurance",
        onClick: () => promptUpdateInsurance(row),
      },
      {
        id: "submit",
        label: "Submit",
        variant: "success",
        onClick: () => void runAction(row.id, "submit"),
        disabled:
          !row.has_primary_eob ||
          !row.secondary_payer_name ||
          row.state === "submitted",
      },
    ];
  }, [selectedRow, runAction, promptAttachEob, promptUpdateInsurance]);

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
        ready_for_secondary: 0,
        missing_primary_eob: 0,
        cob_issue: 0,
        secondary_claim_error: 0,
        secondary_submitted: 0,
      } as Record<Tab, number>,
    };
    return [
      { id: "count", label: "Open claims", value: String(s.total_count) },
      { id: "dollars", label: "Total secondary $", value: formatMoney(s.total_dollars) },
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
      title="Secondary Billing Needed"
      description="Generate secondary claims after primary payer adjudication."
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
      filterUrlNamespace="secbill"
      rows={items}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage="No claims in this tab."
      selectedRowId={selectedId}
      onSelectRow={setSelectedId}
      rowActions={rowActions}
      detailTabs={detailTabs}
      detailActions={detailActions}
      message={message}
    />
  );
}
