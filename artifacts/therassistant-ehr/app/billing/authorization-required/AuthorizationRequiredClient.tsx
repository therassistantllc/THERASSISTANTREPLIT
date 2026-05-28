"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type RowAction,
  type SummaryMetric,
  type FilterDef,
  type DetailTab,
  type PrimaryAction,
} from "@/components/billing/WorkqueueShell";
import { ClaimDocumentsPanel } from "@/components/billing/ClaimDocumentsPanel";
import { getWorkqueue } from "@/lib/billing/workqueues";

type AuthTab =
  | "missing"
  | "expired"
  | "units_exhausted"
  | "wrong_provider"
  | "wrong_service_code"
  | "pending";

interface AuthRow {
  id: string;
  tab: AuthTab;
  authId: string | null;
  claimId: string | null;
  clientId: string | null;
  clientName: string;
  payerProfileId: string | null;
  payerName: string;
  authorizationNumber: string | null;
  serviceCode: string | null;
  validFrom: string | null;
  validTo: string | null;
  unitsAuthorized: number | null;
  unitsUsed: number | null;
  unitsRemaining: number | null;
  expirationDate: string | null;
  claimDosAffected: string | null;
  chargeAmount: number;
  agingDays: number | null;
  riskLevel: "low" | "normal" | "high" | "urgent";
  createdAt: string | null;
  authStatus: string | null;
  insurancePolicyId: string | null;
  clinicianName: string | null;
  clinicianNpi: string | null;
  practiceName: string | null;
  expectedProviderNpi: string | null;
  observedProviderNpi: string | null;
  denialReason: string | null;
  assignedBillerName: string | null;
  claimDosFrom: string | null;
  claimDosTo: string | null;
}

interface AppointmentSummary {
  id: string;
  clientId: string;
  scheduledStartAt: string | null;
  appointmentStatus: string | null;
  appointmentType: string | null;
  providerName: string | null;
}

interface DocumentSummary {
  id: string;
  clientId: string | null;
  title: string;
  documentType: string | null;
  fileName: string;
  uploadedAt: string | null;
}

interface Option {
  value: string;
  label: string;
}

interface Payload {
  success: boolean;
  error?: string;
  rows?: AuthRow[];
  tabCounts?: Record<AuthTab, number>;
  payerOptions?: Option[];
  clinicianOptions?: Option[];
  practiceOptions?: Option[];
  assignedBillerOptions?: Option[];
  statusOptions?: Option[];
  appointmentsByClient?: Record<string, AppointmentSummary[]>;
  documentsByClient?: Record<string, DocumentSummary[]>;
}

const TABS: Array<{ id: AuthTab; label: string }> = [
  { id: "missing", label: "Missing Authorization" },
  { id: "expired", label: "Expired Authorization" },
  { id: "units_exhausted", label: "Units Exhausted" },
  { id: "wrong_provider", label: "Wrong Provider" },
  { id: "wrong_service_code", label: "Wrong Service Code" },
  { id: "pending", label: "Pending Auth" },
];

const FILTER_PARAMS: Array<keyof Filters> = [
  "client",
  "payer",
  "clinician",
  "practice",
  "status",
  "assignedBiller",
  "dosFrom",
  "dosTo",
  "minAmount",
  "agingBucket",
  "priority",
  "carcRarc",
  "followUpDue",
];

type Filters = Record<
  | "client"
  | "payer"
  | "clinician"
  | "practice"
  | "status"
  | "assignedBiller"
  | "dosFrom"
  | "dosTo"
  | "minAmount"
  | "agingBucket"
  | "priority"
  | "carcRarc"
  | "followUpDue"
  | "tab",
  string
>;

function getOrganizationId(): string {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value || 0,
  );
}

function riskBadge(level: AuthRow["riskLevel"]): ReactNode {
  const color =
    level === "urgent" ? "#B91C1C"
    : level === "high" ? "#B45309"
    : level === "normal" ? "#475569"
    : "#64748B";
  const bg =
    level === "urgent" ? "#FEE2E2"
    : level === "high" ? "#FEF3C7"
    : "#F1F5F9";
  return (
    <span
      style={{
        background: bg,
        color,
        padding: "2px 8px",
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      {level}
    </span>
  );
}

const queueDef = getWorkqueue("authorization_required");

export default function AuthorizationRequiredClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<AuthRow[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<AuthTab, number>>({
    missing: 0,
    expired: 0,
    units_exhausted: 0,
    wrong_provider: 0,
    wrong_service_code: 0,
    pending: 0,
  });
  const [payerOptions, setPayerOptions] = useState<Option[]>([]);
  const [clinicianOptions, setClinicianOptions] = useState<Option[]>([]);
  const [practiceOptions, setPracticeOptions] = useState<Option[]>([]);
  const [statusOptions, setStatusOptions] = useState<Option[]>([]);
  const [assignedBillerOptions, setAssignedBillerOptions] = useState<Option[]>([]);
  const [appointmentsByClient, setAppointmentsByClient] = useState<
    Record<string, AppointmentSummary[]>
  >({});
  const [documentsByClient, setDocumentsByClient] = useState<
    Record<string, DocumentSummary[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const [activeTab, setActiveTab] = useState<AuthTab>("missing");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const load = useCallback(
    async (overrides?: Partial<Filters>) => {
      if (!organizationId) return;
      const reqId = ++reqIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        qs.set("organizationId", organizationId);
        const effective: Record<string, string> = {
          ...filterValues,
          ...(overrides ?? {}),
          tab: overrides?.tab ?? filterValues.tab ?? activeTab,
        };
        for (const key of FILTER_PARAMS) {
          const v = effective[key];
          if (v && String(v).length > 0) qs.set(key, String(v));
        }
        if (effective.tab) qs.set("tab", effective.tab);
        const res = await fetch(`/api/billing/authorization-required?${qs.toString()}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as Payload;
        if (reqId !== reqIdRef.current) return; // stale
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Failed to load");
        }
        setRows(json.rows ?? []);
        setTabCounts(
          json.tabCounts ?? {
            missing: 0,
            expired: 0,
            units_exhausted: 0,
            wrong_provider: 0,
            wrong_service_code: 0,
            pending: 0,
          },
        );
        setPayerOptions(json.payerOptions ?? []);
        setClinicianOptions(json.clinicianOptions ?? []);
        setPracticeOptions(json.practiceOptions ?? []);
        setStatusOptions(json.statusOptions ?? []);
        setAssignedBillerOptions(json.assignedBillerOptions ?? []);
        setAppointmentsByClient(json.appointmentsByClient ?? {});
        setDocumentsByClient(json.documentsByClient ?? {});
      } catch (e) {
        if (reqId !== reqIdRef.current) return;
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (reqId === reqIdRef.current) setLoading(false);
      }
    },
    [organizationId, filterValues, activeTab],
  );

  // Initial load
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  // Re-fetch on filter changes (server-side filtering)
  useEffect(() => {
    if (!organizationId) return;
    const t = setTimeout(() => {
      void load();
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterValues.client,
    filterValues.payer,
    filterValues.clinician,
    filterValues.practice,
    filterValues.status,
    filterValues.assignedBiller,
    filterValues.dosFrom,
    filterValues.dosTo,
    filterValues.minAmount,
    filterValues.agingBucket,
    filterValues.priority,
    filterValues.carcRarc,
    filterValues.followUpDue,
    activeTab,
  ]);

  // Filter rail definition
  const filters: FilterDef[] = useMemo(
    () => [
      { id: "client", label: "Client", kind: "text", placeholder: "Client name…" },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicianOptions },
      { id: "practice", label: "Practice", kind: "select", options: practiceOptions },
      { id: "status", label: "Status", kind: "select", options: statusOptions },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "select",
        options: assignedBillerOptions,
      },
      { id: "dosFrom", label: "Valid from", kind: "date" },
      { id: "dosTo", label: "Valid to", kind: "date" },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Aging",
        kind: "select",
        options: [
          { value: "0-30", label: "0–30 days" },
          { value: "31-60", label: "31–60 days" },
          { value: "61-90", label: "61–90 days" },
          { value: "90+", label: "90+ days" },
        ],
      },
      {
        id: "priority",
        label: "Risk",
        kind: "select",
        options: [
          { value: "urgent", label: "Urgent" },
          { value: "high", label: "High" },
          { value: "normal", label: "Normal" },
          { value: "low", label: "Low" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 197 or text" },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [payerOptions, clinicianOptions, practiceOptions, statusOptions, assignedBillerOptions],
  );

  // Summary metrics — server returns rows already filtered to active tab + filters
  const summary: SummaryMetric[] = useMemo(() => {
    const total = rows.length;
    const dollars = rows.reduce((s, r) => s + (r.chargeAmount || 0), 0);
    const ages = rows.map((r) => r.agingDays).filter((n): n is number => n != null);
    const oldest = ages.length > 0 ? Math.max(...ages) : 0;
    const urgent = rows.filter((r) => r.riskLevel === "urgent").length;
    return [
      { id: "count", label: "Items", value: total.toLocaleString() },
      {
        id: "dollars",
        label: "Total at risk",
        value: formatCurrency(dollars),
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
  }, [rows]);

  const columns: ColumnDef<AuthRow>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.clientName },
      { id: "payer", header: "Payer", cell: (r) => r.payerName },
      {
        id: "auth_number",
        header: "Authorization number",
        cell: (r) =>
          r.authorizationNumber ? (
            <span style={{ fontFamily: "ui-monospace, monospace" }}>
              {r.authorizationNumber}
            </span>
          ) : (
            <span style={{ color: "#9CA3AF" }}>—</span>
          ),
      },
      {
        id: "service_code",
        header: "Service code",
        cell: (r) => r.serviceCode || <span style={{ color: "#9CA3AF" }}>—</span>,
      },
      {
        id: "date_range",
        header: "Date range",
        cell: (r) =>
          r.validFrom || r.validTo
            ? `${formatDate(r.validFrom)} – ${formatDate(r.validTo)}`
            : "—",
      },
      {
        id: "units_approved",
        header: "Units approved",
        align: "right",
        cell: (r) => (r.unitsAuthorized == null ? "—" : String(r.unitsAuthorized)),
      },
      {
        id: "units_used",
        header: "Units used",
        align: "right",
        cell: (r) => (r.unitsUsed == null ? "—" : String(r.unitsUsed)),
      },
      {
        id: "units_remaining",
        header: "Units remaining",
        align: "right",
        cell: (r) => {
          if (r.unitsRemaining == null) return "—";
          return (
            <span
              style={{
                fontWeight: r.unitsRemaining === 0 ? 700 : 500,
                color: r.unitsRemaining === 0 ? "#B91C1C" : "#0F172A",
              }}
            >
              {r.unitsRemaining}
            </span>
          );
        },
      },
      {
        id: "expiration",
        header: "Expiration date",
        cell: (r) => formatDate(r.expirationDate),
      },
      {
        id: "claim_dos",
        header: "Claim/DOS affected",
        cell: (r) => r.claimDosAffected || <span style={{ color: "#9CA3AF" }}>—</span>,
      },
      {
        id: "risk",
        header: "Risk level",
        align: "center",
        cell: (r) => riskBadge(r.riskLevel),
      },
    ],
    [],
  );

  // ── Actions ─────────────────────────────────────────────────────────────
  const runAction = useCallback(
    async (
      key: string,
      body: Record<string, unknown>,
      okMessage: string,
      optimistic?: {
        patch?: (row: AuthRow) => AuthRow | null;
        targetRowId?: string;
      },
    ): Promise<boolean> => {
      setPendingAction(key);
      // Optimistic UI: snapshot + apply patch before the request fires.
      const prevRows = rows;
      if (optimistic?.patch && optimistic.targetRowId) {
        const next: AuthRow[] = [];
        for (const r of rows) {
          if (r.id === optimistic.targetRowId) {
            const patched = optimistic.patch(r);
            if (patched) next.push(patched);
            // null → drop the row from view (item resolved)
          } else {
            next.push(r);
          }
        }
        setRows(next);
      }
      try {
        const res = await fetch("/api/billing/authorization-required/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, ...body }),
        });
        const json = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Action failed");
        }
        setToast({ tone: "success", text: okMessage });
        // Background reconcile — keeps the optimistic view in place while
        // the server's authoritative state is fetched.
        void load();
        return true;
      } catch (e) {
        // Rollback optimistic patch on failure.
        setRows(prevRows);
        setToast({
          tone: "error",
          text: e instanceof Error ? e.message : "Action failed",
        });
        return false;
      } finally {
        setPendingAction(null);
      }
    },
    [organizationId, load, rows],
  );

  const promptAttachAuth = useCallback(
    async (row: AuthRow) => {
      if (!row.claimId) {
        setToast({ tone: "error", text: "No claim associated with this row." });
        return;
      }
      const num = window.prompt("Authorization number to attach to this claim:");
      if (!num || !num.trim()) return;
      await runAction(
        "attach_auth",
        { action: "attach_auth", claimId: row.claimId, authorizationNumber: num.trim() },
        `Attached auth ${num.trim()}`,
        { targetRowId: row.id, patch: () => null },
      );
    },
    [runAction],
  );

  const promptUpdateUnits = useCallback(
    async (row: AuthRow) => {
      if (!row.authId) {
        setToast({ tone: "error", text: "No authorization record." });
        return;
      }
      const authStr = window.prompt(
        "Units authorized (blank to skip):",
        row.unitsAuthorized == null ? "" : String(row.unitsAuthorized),
      );
      if (authStr === null) return;
      const usedStr = window.prompt(
        "Units used (blank to skip):",
        row.unitsUsed == null ? "" : String(row.unitsUsed),
      );
      if (usedStr === null) return;
      const body: Record<string, unknown> = { action: "update_units", authId: row.authId };
      if (authStr.trim() !== "") body.unitsAuthorized = Number(authStr);
      if (usedStr.trim() !== "") body.unitsUsed = Number(usedStr);
      if (Object.keys(body).length === 2) return;
      const newAuth = "unitsAuthorized" in body ? Number(body.unitsAuthorized) : null;
      const newUsed = "unitsUsed" in body ? Number(body.unitsUsed) : null;
      await runAction("update_units", body, "Units updated", {
        targetRowId: row.id,
        patch: (r) => {
          const ua = newAuth != null ? newAuth : r.unitsAuthorized;
          const uu = newUsed != null ? newUsed : r.unitsUsed;
          const remaining = ua != null && uu != null ? Math.max(0, ua - uu) : null;
          return { ...r, unitsAuthorized: ua, unitsUsed: uu, unitsRemaining: remaining };
        },
      });
    },
    [runAction],
  );

  const requestAuth = useCallback(
    async (row: AuthRow) => {
      if (!row.clientId) {
        setToast({ tone: "error", text: "No client associated with this row." });
        return;
      }
      if (!row.insurancePolicyId) {
        setToast({
          tone: "error",
          text: "Cannot open auth request: no insurance policy linked to this row.",
        });
        return;
      }
      if (!window.confirm(`Open a pending authorization request for ${row.clientName}?`)) return;
      await runAction(
        "request_auth",
        {
          action: "request_auth",
          clientId: row.clientId,
          insurancePolicyId: row.insurancePolicyId,
          serviceCode: row.serviceCode,
        },
        "Authorization request opened",
        {
          targetRowId: row.id,
          patch: (r) => ({ ...r, authStatus: "pending", riskLevel: "high" }),
        },
      );
    },
    [runAction],
  );

  const holdClaim = useCallback(
    async (row: AuthRow) => {
      if (!row.claimId) {
        setToast({ tone: "error", text: "No claim to hold." });
        return;
      }
      const reason = window.prompt("Hold reason:", "Authorization follow-up");
      if (reason === null) return;
      await runAction(
        "hold_claim",
        { action: "hold_claim", claimId: row.claimId, holdDays: 7, reason },
        "Claim held for 7 days",
        { targetRowId: row.id, patch: () => null },
      );
    },
    [runAction],
  );

  const releaseClaim = useCallback(
    async (row: AuthRow) => {
      if (!row.claimId) {
        setToast({ tone: "error", text: "No claim to release." });
        return;
      }
      await runAction(
        "release_claim",
        { action: "release_claim", claimId: row.claimId },
        "Claim released",
        { targetRowId: row.id, patch: (r) => r },
      );
    },
    [runAction],
  );

  const routeToAdmin = useCallback(
    async (row: AuthRow) => {
      const note = window.prompt("Note for admin:", "");
      if (note === null) return;
      await runAction(
        "route_to_admin",
        { action: "route_to_admin", authId: row.authId, claimId: row.claimId, note },
        "Routed to admin",
        { targetRowId: row.id, patch: () => null },
      );
    },
    [runAction],
  );

  const rowActions: RowAction<AuthRow>[] = useMemo(
    () => [
      {
        id: "attach",
        label: "Attach auth",
        onClick: (r) => void promptAttachAuth(r),
        disabled: (r) => Boolean(pendingAction) || !r.claimId,
      },
      {
        id: "request",
        label: "Request auth",
        onClick: (r) => void requestAuth(r),
        disabled: (r) => Boolean(pendingAction) || !r.insurancePolicyId,
      },
      {
        id: "update_units",
        label: "Update units",
        onClick: (r) => void promptUpdateUnits(r),
        disabled: (r) => Boolean(pendingAction) || !r.authId,
      },
      {
        id: "hold",
        label: "Hold",
        onClick: (r) => void holdClaim(r),
        disabled: (r) => Boolean(pendingAction) || !r.claimId,
      },
      {
        id: "release",
        label: "Release",
        onClick: (r) => void releaseClaim(r),
        disabled: (r) => Boolean(pendingAction) || !r.claimId,
      },
      {
        id: "route",
        label: "Route to admin",
        onClick: (r) => void routeToAdmin(r),
        disabled: () => Boolean(pendingAction),
      },
    ],
    [pendingAction, promptAttachAuth, requestAuth, promptUpdateUnits, holdClaim, releaseClaim, routeToAdmin],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  const selectedAppointments = useMemo(() => {
    if (!selectedRow?.clientId) return [];
    return appointmentsByClient[selectedRow.clientId] ?? [];
  }, [selectedRow, appointmentsByClient]);

  const selectedDocuments = useMemo(() => {
    if (!selectedRow?.clientId) return [];
    return documentsByClient[selectedRow.clientId] ?? [];
  }, [selectedRow, documentsByClient]);

  // ── Detail panel ────────────────────────────────────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "auth_record",
        label: "Authorization record",
        render: () =>
          selectedRow ? (
            <div>
              <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>{selectedRow.clientName}</h3>
              <div style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
                {selectedRow.payerName}
              </div>
              <KV
                label="Issue"
                value={TABS.find((t) => t.id === selectedRow.tab)?.label ?? selectedRow.tab}
              />
              <KV label="Status" value={selectedRow.authStatus ?? "—"} />
              <KV label="Auth #" value={selectedRow.authorizationNumber || "—"} />
              <KV label="Service code" value={selectedRow.serviceCode || "—"} />
              <KV
                label="Valid range"
                value={
                  selectedRow.validFrom || selectedRow.validTo
                    ? `${formatDate(selectedRow.validFrom)} – ${formatDate(selectedRow.validTo)}`
                    : "—"
                }
              />
              <KV
                label="Units"
                value={
                  selectedRow.unitsAuthorized != null
                    ? `${selectedRow.unitsUsed ?? 0} / ${selectedRow.unitsAuthorized}`
                    : "—"
                }
              />
              <KV
                label="Clinician on auth"
                value={
                  selectedRow.clinicianName
                    ? `${selectedRow.clinicianName}${selectedRow.expectedProviderNpi ? ` (NPI ${selectedRow.expectedProviderNpi})` : ""}`
                    : "—"
                }
              />
              {selectedRow.observedProviderNpi &&
              selectedRow.expectedProviderNpi &&
              selectedRow.observedProviderNpi !== selectedRow.expectedProviderNpi ? (
                <KV
                  label="Billed under NPI"
                  value={`${selectedRow.observedProviderNpi} (mismatch)`}
                />
              ) : null}
              <KV label="Practice" value={selectedRow.practiceName ?? "—"} />
              <KV label="Risk" value={selectedRow.riskLevel.toUpperCase()} />
              <KV label="Aging" value={selectedRow.agingDays != null ? `${selectedRow.agingDays}d` : "—"} />
              {selectedRow.denialReason ? (
                <KV label="Denial / CARC" value={selectedRow.denialReason} />
              ) : null}
            </div>
          ) : null,
      },
      {
        id: "appointments",
        label: `Appointment history (${selectedAppointments.length})`,
        render: () => {
          if (!selectedRow) return null;
          if (selectedAppointments.length === 0) {
            return (
              <p style={{ color: "#94A3B8", fontSize: 13 }}>
                No recent appointments on file for this client.
              </p>
            );
          }
          return (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748B" }}>
                  <th style={{ padding: "6px 4px" }}>When</th>
                  <th style={{ padding: "6px 4px" }}>Type</th>
                  <th style={{ padding: "6px 4px" }}>Provider</th>
                  <th style={{ padding: "6px 4px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {selectedAppointments.map((a) => (
                  <tr key={a.id} style={{ borderTop: "1px solid #F1F5F9" }}>
                    <td style={{ padding: "6px 4px" }}>{formatDateTime(a.scheduledStartAt)}</td>
                    <td style={{ padding: "6px 4px" }}>{a.appointmentType ?? "—"}</td>
                    <td style={{ padding: "6px 4px" }}>{a.providerName ?? "—"}</td>
                    <td style={{ padding: "6px 4px" }}>{a.appointmentStatus ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        },
      },
      {
        id: "claim_lines",
        label: "Claim lines tied to auth",
        render: () =>
          selectedRow ? (
            <div>
              {selectedRow.claimDosAffected ? (
                <KV label="Claim / DOS" value={selectedRow.claimDosAffected} />
              ) : (
                <p style={{ color: "#94A3B8", fontSize: 13 }}>
                  No claim lines are currently linked to this authorization.
                </p>
              )}
              <KV label="Charge" value={formatCurrency(selectedRow.chargeAmount)} />
              {selectedRow.tab === "wrong_provider" && selectedRow.observedProviderNpi ? (
                <p style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>
                  Service line was billed under NPI {selectedRow.observedProviderNpi}; the
                  authorization is recorded against{" "}
                  {selectedRow.expectedProviderNpi
                    ? `NPI ${selectedRow.expectedProviderNpi}`
                    : "a different provider"}
                  .
                </p>
              ) : null}
            </div>
          ) : null,
      },
      {
        id: "unit_calc",
        label: "Remaining unit calculation",
        render: () =>
          selectedRow ? (
            <div>
              <KV
                label="Authorized"
                value={
                  selectedRow.unitsAuthorized == null
                    ? "—"
                    : String(selectedRow.unitsAuthorized)
                }
              />
              <KV
                label="Used"
                value={selectedRow.unitsUsed == null ? "—" : String(selectedRow.unitsUsed)}
              />
              <KV
                label="Remaining"
                value={
                  selectedRow.unitsRemaining == null
                    ? "—"
                    : String(selectedRow.unitsRemaining)
                }
              />
              {selectedRow.unitsAuthorized != null && selectedRow.unitsUsed != null ? (
                <p style={{ color: "#64748B", fontSize: 12, marginTop: 8 }}>
                  Remaining = {selectedRow.unitsAuthorized} authorized −{" "}
                  {selectedRow.unitsUsed} used
                </p>
              ) : null}
            </div>
          ) : null,
      },
      {
        id: "documents",
        label: `Uploaded auth documents (${selectedDocuments.length})`,
        render: () => {
          if (!selectedRow) return null;
          if (selectedDocuments.length === 0) {
            return (
              <p style={{ color: "#94A3B8", fontSize: 13 }}>
                No authorization documents on file for this client. File a payer letter into
                the client mailroom and it will appear here.
              </p>
            );
          }
          return (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {selectedDocuments.map((d) => (
                <li
                  key={d.id}
                  style={{
                    padding: "6px 0",
                    borderBottom: "1px solid #F1F5F9",
                    fontSize: 13,
                  }}
                >
                  <div style={{ fontWeight: 500, color: "#0F172A" }}>{d.title}</div>
                  <div style={{ fontSize: 11, color: "#64748B" }}>
                    {d.documentType ?? "document"} · {formatDate(d.uploadedAt)}
                  </div>
                </li>
              ))}
            </ul>
          );
        },
      },
      {
        id: "claim_documents",
        label: "Related documents",
        render: () =>
          selectedRow?.claimId ? (
            <ClaimDocumentsPanel
              claimId={selectedRow.claimId}
              organizationId={organizationId}
            />
          ) : (
            <p style={{ fontSize: 13, color: "#94A3B8", margin: 0 }}>
              No claim is attached yet, so there&apos;s nothing to upload.
            </p>
          ),
      },
    ],
    [selectedRow, selectedAppointments, selectedDocuments, organizationId],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    return [
      {
        id: "attach",
        label: "Attach auth",
        onClick: () => void promptAttachAuth(selectedRow),
        disabled: !selectedRow.claimId,
      },
      {
        id: "request",
        label: "Request auth",
        onClick: () => void requestAuth(selectedRow),
        disabled: !selectedRow.insurancePolicyId,
      },
      {
        id: "update_units",
        label: "Update units",
        onClick: () => void promptUpdateUnits(selectedRow),
        disabled: !selectedRow.authId,
      },
      {
        id: "hold",
        label: "Hold claim",
        onClick: () => void holdClaim(selectedRow),
        disabled: !selectedRow.claimId,
      },
      {
        id: "release",
        label: "Release claim",
        onClick: () => void releaseClaim(selectedRow),
        disabled: !selectedRow.claimId,
      },
      {
        id: "route",
        label: "Route to admin",
        variant: "primary",
        onClick: () => void routeToAdmin(selectedRow),
      },
    ];
  }, [
    selectedRow,
    promptAttachAuth,
    requestAuth,
    promptUpdateUnits,
    holdClaim,
    releaseClaim,
    routeToAdmin,
  ]);

  const message = error
    ? { tone: "error" as const, text: error }
    : toast
      ? toast
      : null;

  const tabStrip = (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: "8px 12px",
        borderBottom: "1px solid #E2E8F0",
        background: "#F8FAFC",
        overflowX: "auto",
      }}
      role="tablist"
      aria-label="Authorization issue type"
    >
      {TABS.map((t) => {
        const isActive = activeTab === t.id;
        const count = tabCounts[t.id] ?? 0;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => {
              setActiveTab(t.id);
              setSelectedRowId(null);
            }}
            style={{
              padding: "6px 12px",
              border: "1px solid",
              borderColor: isActive ? "#1E40AF" : "#CBD5E1",
              background: isActive ? "#1E40AF" : "#FFFFFF",
              color: isActive ? "#FFFFFF" : "#0F172A",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {t.label}
            <span
              style={{
                marginLeft: 6,
                fontSize: 11,
                fontWeight: 700,
                color: isActive ? "#BFDBFE" : "#64748B",
              }}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {tabStrip}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <WorkqueueShell<AuthRow>
          title={queueDef?.title ?? "Authorization Required"}
          description={queueDef?.description}
          headerActions={[
            {
              id: "refresh",
              label: loading ? "Loading…" : "Refresh",
              onClick: () => void load(),
              disabled: loading,
            },
          ]}
          summary={summary}
          filters={filters}
          filterValues={filterValues}
          onFilterChange={setFilterValues}
          filterUrlNamespace="authreq"
          rows={rows}
          columns={columns}
          rowId={(r) => r.id}
          rowActions={rowActions}
          loading={loading}
          emptyMessage="No items in this tab."
          selectedRowId={selectedRowId}
          onSelectRow={setSelectedRowId}
          detailTabs={detailTabs}
          detailActions={detailActions}
          message={message}
        />
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
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
