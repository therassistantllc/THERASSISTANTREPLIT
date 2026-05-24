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
  | "unsigned_notes"
  | "draft_notes"
  | "missing_time"
  | "missing_diagnosis"
  | "missing_treatment_plan"
  | "late_documentation";

type Row = {
  id: string;
  encounter_id: string | null;
  client_id: string | null;
  client_name: string;
  clinician_id: string | null;
  clinician_name: string;
  date_of_service: string | null;
  appointment_type: string | null;
  scheduled_duration_minutes: number | null;
  note_status: string | null;
  days_since_appointment: number | null;
  missing_elements: string[];
  billing_risk: "low" | "medium" | "high" | "critical";
  reminder_sent_at: string | null;
  reminder_count: number;
  total_charge: number;
  tabs: Tab[];
  state: "open" | "hold" | "not_billable" | "supervisor_review";
  routed_to_clinician_id: string | null;
  payer_name: string | null;
  aging_bucket: string;
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
  { id: "unsigned_notes", label: "Unsigned Notes" },
  { id: "draft_notes", label: "Draft Notes" },
  { id: "missing_time", label: "Missing Time" },
  { id: "missing_diagnosis", label: "Missing Diagnosis" },
  { id: "missing_treatment_plan", label: "Missing Treatment Plan" },
  { id: "late_documentation", label: "Late Documentation" },
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

function riskBadge(risk: Row["billing_risk"]): ReactNode {
  const colors: Record<Row["billing_risk"], { bg: string; fg: string; label: string }> = {
    low: { bg: "#e0f2fe", fg: "#075985", label: "Low" },
    medium: { bg: "#fef9c3", fg: "#854d0e", label: "Medium" },
    high: { bg: "#ffedd5", fg: "#9a3412", label: "High" },
    critical: { bg: "#fee2e2", fg: "#991b1b", label: "Critical" },
  };
  const c = colors[risk];
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

type ProviderOption = {
  id: string;
  provider_name: string;
  credential_display: string | null;
};

export default function DocumentationPendingClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);

  const [items, setItems] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);
  const [activeTab, setActiveTab] = useState<Tab>("unsigned_notes");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [routePickerRow, setRoutePickerRow] = useState<Row | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadProviders() {
      setProvidersLoading(true);
      setProvidersError(null);
      try {
        const res = await fetch(
          `/api/providers?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          providers?: ProviderOption[];
          error?: string;
        };
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Failed to load clinicians");
        }
        if (!cancelled) setProviders(json.providers ?? []);
      } catch (e) {
        if (!cancelled) {
          setProvidersError(e instanceof Error ? e.message : "Failed to load clinicians");
        }
      } finally {
        if (!cancelled) setProvidersLoading(false);
      }
    }
    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const providerNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of providers) m.set(p.id, p.provider_name);
    return m;
  }, [providers]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ organizationId, tab: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) qs.set(k, v);
      }
      const res = await fetch(
        `/api/billing/documentation-pending?${qs.toString()}`,
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
      if (i.clinician_id) m.set(i.clinician_id, i.clinician_name);
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
      {
        id: "clinician",
        label: "Clinician",
        kind: "select",
        options: clinicianOptions,
      },
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
          { value: "hold", label: "On hold" },
          { value: "not_billable", label: "Not billable" },
          { value: "supervisor_review", label: "Supervisor review" },
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

  // Filtering happens server-side; the API returns rows for the active
  // tab + universal filter values, so we render `items` directly.
  const filtered = items;

  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.client_name },
      {
        id: "clinician",
        header: "Clinician",
        cell: (r) => {
          const routedName = r.routed_to_clinician_id
            ? providerNameById.get(r.routed_to_clinician_id) ?? null
            : null;
          const showRouted =
            routedName && r.routed_to_clinician_id !== r.clinician_id;
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span>{r.clinician_name}</span>
              {showRouted ? (
                <span style={{ fontSize: 11, color: "#0369a1" }}>
                  Routed to {routedName}
                </span>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "dos",
        header: "Date of service",
        cell: (r) => formatDate(r.date_of_service),
      },
      {
        id: "appt_type",
        header: "Appointment type",
        cell: (r) => r.appointment_type ?? "—",
      },
      {
        id: "duration",
        header: "Scheduled duration",
        cell: (r) =>
          r.scheduled_duration_minutes != null
            ? `${r.scheduled_duration_minutes} min`
            : "—",
      },
      {
        id: "note_status",
        header: "Note status",
        cell: (r) => r.note_status ?? "—",
      },
      {
        id: "days",
        header: "Days since appointment",
        align: "right",
        cell: (r) => (r.days_since_appointment != null ? `${r.days_since_appointment}d` : "—"),
      },
      {
        id: "missing",
        header: "Missing element",
        cell: (r) =>
          r.missing_elements.length > 0 ? (
            <span style={{ fontSize: 12 }}>{r.missing_elements.join(", ")}</span>
          ) : (
            "—"
          ),
      },
      { id: "risk", header: "Billing risk", cell: (r) => riskBadge(r.billing_risk) },
      {
        id: "reminder",
        header: "Reminder sent",
        cell: (r) =>
          r.reminder_sent_at ? (
            <span title={`${r.reminder_count} reminder(s) sent`}>
              {formatDate(r.reminder_sent_at)}
            </span>
          ) : (
            <span style={{ color: "#94a3b8" }}>—</span>
          ),
      },
    ],
    [providerNameById],
  );

  const runAction = useCallback(
    async (rowId: string, action: string, extras: Record<string, unknown> = {}) => {
      setBusyRow(rowId);
      try {
        const res = await fetch(
          `/api/billing/documentation-pending/${encodeURIComponent(rowId)}/action`,
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

        setMessage({ tone: "success", text: `Action "${action.replace(/_/g, " ")}" applied.` });
        // Refetch from the server so the row honours the active filter
        // slice — e.g. after hold / mark_not_billable / supervisor_review
        // the row should drop out of the default `status=open` view.
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
        id: "send_reminder",
        label: "Reminder",
        onClick: (r) => void runAction(r.id, "send_reminder"),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "route_to_clinician",
        label: "Route",
        onClick: (r) => setRoutePickerRow(r),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "hold",
        label: "Hold",
        onClick: (r) => void runAction(r.id, "hold"),
        disabled: (r) => busyRow === r.id,
        variant: "default",
      },
      {
        id: "supervisor_review",
        label: "Supervisor",
        onClick: (r) => void runAction(r.id, "supervisor_review"),
        disabled: (r) => busyRow === r.id,
      },
      {
        id: "mark_not_billable",
        label: "Not billable",
        onClick: (r) => {
          if (
            !window.confirm("Mark this appointment as not billable? It will leave the queue.")
          ) {
            return;
          }
          void runAction(r.id, "mark_not_billable");
        },
        disabled: (r) => busyRow === r.id,
        variant: "danger",
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
    const labeledItem = (label: string, value: ReactNode) => (
      <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
        <span style={{ color: "#64748b", minWidth: 140 }}>{label}</span>
        <span>{value}</span>
      </div>
    );
    return [
      {
        id: "appointment",
        label: "Appointment details",
        render: () => (
          <div>
            {labeledItem("Client", row.client_name)}
            {labeledItem("Clinician", row.clinician_name)}
            {labeledItem("Date of service", formatDate(row.date_of_service))}
            {labeledItem("Type", row.appointment_type ?? "—")}
            {labeledItem(
              "Scheduled duration",
              row.scheduled_duration_minutes != null
                ? `${row.scheduled_duration_minutes} min`
                : "—",
            )}
            {labeledItem("Payer", row.payer_name ?? "—")}
            {labeledItem("Total charge", formatMoney(row.total_charge))}
            {labeledItem(
              "Days since",
              row.days_since_appointment != null
                ? `${row.days_since_appointment}d`
                : "—",
            )}
            {labeledItem("Billing risk", riskBadge(row.billing_risk))}
            {labeledItem(
              "State",
              <span style={{ textTransform: "capitalize" }}>
                {row.state.replace(/_/g, " ")}
              </span>,
            )}
          </div>
        ),
      },
      {
        id: "checklist",
        label: "Documentation checklist",
        render: () => {
          const checks = [
            { label: "Encounter opened", done: !!row.encounter_id },
            {
              label: "Session time recorded",
              done: !row.tabs.includes("missing_time"),
            },
            { label: "Progress note created", done: !!row.note_status },
            { label: "Note signed", done: !row.tabs.includes("unsigned_notes") },
            {
              label: "Diagnosis coded",
              done: !row.tabs.includes("missing_diagnosis"),
            },
            {
              label: "Active treatment plan",
              done: !row.tabs.includes("missing_treatment_plan"),
            },
          ];
          return (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {checks.map((c) => (
                <li
                  key={c.label}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "6px 0",
                    fontSize: 13,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 999,
                      background: c.done ? "#16a34a" : "#e2e8f0",
                      color: "white",
                      textAlign: "center",
                      lineHeight: "16px",
                      fontSize: 11,
                    }}
                  >
                    {c.done ? "✓" : ""}
                  </span>
                  <span style={{ color: c.done ? "#0f172a" : "#475569" }}>
                    {c.label}
                  </span>
                </li>
              ))}
            </ul>
          );
        },
      },
      {
        id: "missing",
        label: "Missing fields",
        render: () =>
          row.missing_elements.length === 0 ? (
            <p style={{ fontSize: 13, color: "#64748b" }}>
              Nothing flagged as missing.
            </p>
          ) : (
            <ul style={{ paddingLeft: 18, fontSize: 13 }}>
              {row.missing_elements.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ),
      },
      {
        id: "prior",
        label: "Prior note history",
        render: () => (
          <PriorNoteHistory
            clientId={row.client_id}
            organizationId={organizationId}
            currentEncounterId={row.encounter_id}
          />
        ),
      },
      {
        id: "treatment_plan",
        label: "Treatment plan status",
        render: () => (
          <TreatmentPlanStatus
            clientId={row.client_id}
            organizationId={organizationId}
            hasActivePlan={!row.tabs.includes("missing_treatment_plan")}
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
        id: "send_reminder",
        label: "Send clinician reminder",
        onClick: () => void runAction(row.id, "send_reminder"),
        variant: "primary",
      },
      {
        id: "route_to_clinician",
        label: "Route to clinician",
        onClick: () => setRoutePickerRow(row),
      },
      {
        id: "hold",
        label: row.state === "hold" ? "Release hold" : "Hold from billing",
        onClick: () =>
          void runAction(row.id, row.state === "hold" ? "unhold" : "hold"),
      },
      {
        id: "mark_not_billable",
        label: "Mark not billable",
        variant: "danger",
        onClick: () => {
          if (!window.confirm("Mark this appointment as not billable?")) return;
          void runAction(row.id, "mark_not_billable");
        },
      },
      {
        id: "supervisor_review",
        label: "Supervisor review",
        onClick: () => void runAction(row.id, "supervisor_review"),
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
        unsigned_notes: 0,
        draft_notes: 0,
        missing_time: 0,
        missing_diagnosis: 0,
        missing_treatment_plan: 0,
        late_documentation: 0,
      } as Record<Tab, number>,
    };
    return [
      { id: "count", label: "Open items", value: String(s.total_count) },
      { id: "dollars", label: "Total $", value: formatMoney(s.total_dollars) },
      {
        id: "age",
        label: "Oldest age",
        value: s.oldest_age_days == null ? "—" : `${s.oldest_age_days}d`,
        tone: (s.oldest_age_days ?? 0) > 30 ? "red" : "default",
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
      title="Documentation Pending"
      description="Appointments that can't be billed yet because clinical documentation is missing or incomplete."
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
      filterUrlNamespace="docpend"
      rows={filtered}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage="Nothing pending in this tab."
      selectedRowId={selectedId}
      onSelectRow={setSelectedId}
      rowActions={rowActions}
      detailTabs={detailTabs}
      detailActions={detailActions}
      message={message}
      overlay={
        routePickerRow ? (
          <RouteToClinicianModal
            row={routePickerRow}
            providers={providers}
            loading={providersLoading}
            error={providersError}
            busy={busyRow === routePickerRow.id}
            onClose={() => setRoutePickerRow(null)}
            onSelect={async (providerId) => {
              const target = routePickerRow;
              setRoutePickerRow(null);
              await runAction(target.id, "route_to_clinician", {
                target_provider_id: providerId,
              });
            }}
          />
        ) : null
      }
    />
  );
}

function RouteToClinicianModal({
  row,
  providers,
  loading,
  error,
  busy,
  onClose,
  onSelect,
}: {
  row: Row;
  providers: ProviderOption[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onSelect: (providerId: string) => void | Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>(
    row.routed_to_clinician_id ?? row.clinician_id ?? "",
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) =>
      p.provider_name.toLowerCase().includes(q) ||
      (p.credential_display ?? "").toLowerCase().includes(q),
    );
  }, [providers, search]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Route to clinician"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 8,
          padding: 20,
          width: "min(480px, 92vw)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            Route to clinician
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "#64748b" }}>
            Appointment for {row.client_name} on {formatDate(row.date_of_service)}.
            Originally assigned to {row.clinician_name}.
          </p>
        </div>
        <input
          autoFocus
          type="text"
          placeholder="Search clinicians by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: "8px 10px",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            fontSize: 13,
          }}
        />
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 6,
            overflow: "auto",
            flex: 1,
            minHeight: 120,
            maxHeight: "45vh",
          }}
        >
          {loading ? (
            <p style={{ padding: 12, fontSize: 13, color: "#64748b" }}>
              Loading clinicians…
            </p>
          ) : error ? (
            <p style={{ padding: 12, fontSize: 13, color: "#991b1b" }}>{error}</p>
          ) : filtered.length === 0 ? (
            <p style={{ padding: 12, fontSize: 13, color: "#64748b" }}>
              No matching active clinicians.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {filtered.map((p) => {
                const isSelected = p.id === selected;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(p.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 12px",
                        border: "none",
                        background: isSelected ? "#e0f2fe" : "transparent",
                        cursor: "pointer",
                        fontSize: 13,
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                      }}
                    >
                      <span style={{ fontWeight: isSelected ? 600 : 500 }}>
                        {p.provider_name}
                        {p.id === row.clinician_id ? (
                          <span style={{ marginLeft: 6, fontSize: 11, color: "#64748b" }}>
                            (original)
                          </span>
                        ) : null}
                      </span>
                      {p.credential_display ? (
                        <span style={{ fontSize: 11, color: "#64748b" }}>
                          {p.credential_display}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              background: "white",
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected || busy}
            onClick={() => {
              if (selected) void onSelect(selected);
            }}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              border: "none",
              background: !selected || busy ? "#94a3b8" : "#0284c7",
              color: "white",
              cursor: !selected || busy ? "not-allowed" : "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {busy ? "Routing…" : "Route"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PriorNoteHistory({
  clientId,
  organizationId,
  currentEncounterId,
}: {
  clientId: string | null;
  organizationId: string;
  currentEncounterId: string | null;
}) {
  const [rows, setRows] = useState<
    Array<{ id: string; updated_at: string; note_status: string; signed_at: string | null }>
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
          limit: "8",
        });
        const res = await fetch(
          `/api/billing/documentation-pending/notes?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          notes?: typeof rows;
          error?: string;
        };
        if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
        if (!cancelled) setRows(json.notes ?? []);
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
  if (rows.length === 0) return <p style={{ fontSize: 13 }}>No prior notes.</p>;

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {rows.map((n) => (
        <li
          key={n.id}
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 13,
            padding: "4px 0",
            borderBottom: "1px solid #f1f5f9",
            background: n.id === currentEncounterId ? "#f8fafc" : "transparent",
          }}
        >
          <span>{formatDate(n.updated_at)}</span>
          <span style={{ color: "#475569" }}>
            {n.note_status} {n.signed_at ? `· signed ${formatDate(n.signed_at)}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TreatmentPlanStatus({
  clientId,
  organizationId,
  hasActivePlan,
}: {
  clientId: string | null;
  organizationId: string;
  hasActivePlan: boolean;
}) {
  const [plan, setPlan] = useState<{
    id: string;
    plan_status: string;
    start_date: string | null;
    end_date: string | null;
    next_review_date: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function go() {
      if (!clientId) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ organizationId, clientId });
        const res = await fetch(
          `/api/billing/documentation-pending/treatment-plan?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          plan?: typeof plan;
        };
        if (!cancelled && res.ok && json.success) setPlan(json.plan ?? null);
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
  if (!plan) {
    return (
      <p style={{ fontSize: 13, color: hasActivePlan ? "#0f172a" : "#991b1b" }}>
        No treatment plan on file.
      </p>
    );
  }
  return (
    <div style={{ fontSize: 13 }}>
      <p style={{ margin: "4px 0" }}>
        <strong>Status:</strong> {plan.plan_status}
      </p>
      <p style={{ margin: "4px 0" }}>
        <strong>Start:</strong> {formatDate(plan.start_date)} · <strong>End:</strong>{" "}
        {formatDate(plan.end_date)}
      </p>
      <p style={{ margin: "4px 0" }}>
        <strong>Next review:</strong> {formatDate(plan.next_review_date)}
      </p>
    </div>
  );
}
