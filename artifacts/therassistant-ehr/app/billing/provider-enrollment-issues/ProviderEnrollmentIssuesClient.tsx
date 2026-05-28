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
import {
  PROVIDER_ENROLLMENT_ISSUE_TABS,
  type ProviderEnrollmentIssueRow,
  type ProviderEnrollmentIssueType,
} from "@/lib/billing/providerEnrollmentIssuesTypes";

type ListPayload = {
  success: boolean;
  error?: string;
  rows?: ProviderEnrollmentIssueRow[];
};

const queueDef = getWorkqueue("provider_enrollment_issues");

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

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000));
}

function enrollmentTone(s: string): "amber" | "red" | "green" | "default" {
  const v = s.toLowerCase();
  if (v === "approved") return "green";
  if (v === "rejected" || v === "terminated" || v === "not_enrolled") return "red";
  if (v === "pending" || v === "submitted") return "amber";
  return "default";
}

const ISSUE_LABEL: Record<ProviderEnrollmentIssueType, string> = Object.fromEntries(
  PROVIDER_ENROLLMENT_ISSUE_TABS.map((t) => [t.id, t.label]),
) as Record<ProviderEnrollmentIssueType, string>;

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed", bottom: 24, right: 24,
        background: "#111827", color: "#fff",
        padding: "10px 16px", borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)", zIndex: 1100,
      }}
    >
      {message}
    </div>
  );
}

export default function ProviderEnrollmentIssuesClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<ProviderEnrollmentIssueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(0);

  const [activeTab, setActiveTab] = useState<ProviderEnrollmentIssueType>("provider_not_enrolled");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      for (const [key, value] of Object.entries(filterValues)) {
        if (value) params.set(key, value);
      }
      const res = await fetch(
        `/api/billing/provider-enrollment-issues?${params.toString()}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as ListPayload;
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows(json.rows ?? []);
      setNowMs(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [organizationId, filterValues]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // ── Filter rail ─────────────────────────────────────────────────────────
  const payerOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.payerName) m.set(r.payerName, r.payerName);
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);
  const practiceOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.practiceId) m.set(r.practiceId, `Practice ${r.practiceId.slice(0, 8)}`);
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);
  const clinicianOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.providerId) m.set(r.providerId, r.clinicianName || `Clinician ${r.providerId.slice(0, 8)}`);
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "select", options: practiceOptions },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicianOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Client name…" },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Enrollment status",
        kind: "select",
        options: [
          { value: "approved", label: "Approved" },
          { value: "pending", label: "Pending" },
          { value: "submitted", label: "Submitted" },
          { value: "rejected", label: "Rejected" },
          { value: "terminated", label: "Terminated" },
          { value: "not_enrolled", label: "Not enrolled" },
        ],
      },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [{ value: "urgent", label: "Urgent (DOS ≥ 60d)" }, { value: "normal", label: "Normal" }],
      },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Claim age",
        kind: "select",
        options: [
          { value: "0-30", label: "0-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "61-90", label: "61-90 days" },
          { value: "90+", label: "90+ days" },
          { value: "never", label: "No DOS" },
        ],
      },
      { id: "assignedBiller", label: "Assigned biller", kind: "text", placeholder: "user id…" },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. CO-208" },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [payerOptions, practiceOptions, clinicianOptions],
  );

  const filteredRows = useMemo(() => {
    let out = rows.filter((r) => r.issueType === activeTab);
    const v = filterValues;
    if (v.practice) out = out.filter((r) => r.practiceId === v.practice);
    if (v.clinician) out = out.filter((r) => r.providerId === v.clinician);
    if (v.client) {
      const q = v.client.toLowerCase();
      out = out.filter((r) => r.clientName.toLowerCase().includes(q));
    }
    if (v.payer) out = out.filter((r) => r.payerName === v.payer);
    if (v.dosFrom) out = out.filter((r) => (r.dateOfService ?? "") >= v.dosFrom);
    if (v.dosTo) out = out.filter((r) => (r.dateOfService ?? "") <= v.dosTo + "T23:59:59");
    if (v.status) out = out.filter((r) => (r.enrollmentStatus ?? "").toLowerCase() === v.status);
    if (v.priority === "urgent") {
      out = out.filter((r) => {
        const age = ageDays(r.dateOfService);
        return age !== null && age >= 60;
      });
    }
    if (v.minAmount) {
      const min = Number(v.minAmount);
      if (Number.isFinite(min)) out = out.filter((r) => r.chargeAmount >= min);
    }
    if (v.maxAmount) {
      const max = Number(v.maxAmount);
      if (Number.isFinite(max)) out = out.filter((r) => r.chargeAmount <= max);
    }
    if (v.agingBucket) {
      out = out.filter((r) => {
        const a = ageDays(r.dateOfService);
        if (a == null) return v.agingBucket === "never";
        switch (v.agingBucket) {
          case "0-30": return a <= 30;
          case "31-60": return a > 30 && a <= 60;
          case "61-90": return a > 60 && a <= 90;
          case "90+": return a > 90;
          default: return true;
        }
      });
    }
    if (v.assignedBiller) {
      const q = v.assignedBiller.toLowerCase();
      out = out.filter((r) => (r.assignedBillerId ?? "").toLowerCase().includes(q));
    }
    if (v.carcRarc) {
      const q = v.carcRarc.toUpperCase();
      out = out.filter((r) => (r.denialCode ?? "").toUpperCase().includes(q));
    }
    if (v.followUpDue) {
      const cutoff = v.followUpDue + "T23:59:59";
      out = out.filter((r) => r.followUpDueAt != null && r.followUpDueAt <= cutoff);
    }
    return out;
  }, [rows, activeTab, filterValues]);

  // ── Summary strip ───────────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const total = filteredRows.length;
    const dollars = filteredRows.reduce((s, r) => s + r.chargeAmount, 0);
    const ages = filteredRows
      .map((r) => ageDays(r.dateOfService))
      .filter((n): n is number => n != null);
    const oldest = ages.length ? Math.max(...ages) : 0;
    const urgent = filteredRows.filter((r) => {
      const age = ageDays(r.dateOfService);
      return age !== null && age >= 60;
    }).length;
    void nowMs;
    return [
      { id: "count", label: "Items", value: total.toLocaleString() },
      { id: "dollars", label: "Total $ at risk", value: formatCurrency(dollars), tone: dollars > 0 ? "amber" : "default" },
      { id: "oldest", label: "Oldest claim age (days)", value: oldest, tone: oldest > 60 ? "red" : oldest > 30 ? "amber" : "default" },
      { id: "urgent", label: "Urgent (DOS ≥ 60d)", value: urgent, tone: urgent > 0 ? "red" : "default" },
    ];
  }, [filteredRows, nowMs]);

  // ── Columns (exact spec) ────────────────────────────────────────────────
  const columns: ColumnDef<ProviderEnrollmentIssueRow>[] = useMemo(
    () => [
      {
        id: "claimId", header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.claimNumber || r.claimId.slice(0, 8)}
          </span>
        ),
      },
      { id: "clinician", header: "Clinician", cell: (r) => r.clinicianName },
      { id: "payer", header: "Payer", cell: (r) => r.payerName || "—" },
      { id: "client", header: "Client", cell: (r) => r.clientName },
      { id: "dos", header: "DOS", cell: (r) => formatDate(r.dateOfService) },
      { id: "issue", header: "Issue type", cell: (r) => ISSUE_LABEL[r.issueType] },
      {
        id: "providerNpi", header: "Provider NPI",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", color: r.providerNpi ? "#0F172A" : "#9CA3AF" }}>
            {r.providerNpi || "missing"}
          </span>
        ),
      },
      {
        id: "billingNpi", header: "Billing NPI",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", color: r.billingNpi ? "#0F172A" : "#9CA3AF" }}>
            {r.billingNpi || "missing"}
          </span>
        ),
      },
      {
        id: "charge", header: "Charge amount", align: "right",
        cell: (r) => formatCurrency(r.chargeAmount),
      },
      {
        id: "enrollment", header: "Enrollment status",
        cell: (r) => {
          const tone = enrollmentTone(r.enrollmentStatus);
          const colors: Record<typeof tone, string> = {
            default: "#475569", green: "#15803D", amber: "#B45309", red: "#B91C1C",
          };
          return <span style={{ color: colors[tone], fontWeight: 600, textTransform: "capitalize" }}>
            {r.enrollmentStatus.replace(/_/g, " ")}
          </span>;
        },
      },
    ],
    [],
  );

  const selectedRow = useMemo(
    () => filteredRows.find((r) => r.id === selectedRowId) ?? null,
    [filteredRows, selectedRowId],
  );

  // ── Actions ─────────────────────────────────────────────────────────────
  const performAction = useCallback(
    async (row: ProviderEnrollmentIssueRow, action: string, note?: string) => {
      setActingId(row.id);
      try {
        const res = await fetch("/api/billing/provider-enrollment-issues/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            action,
            claimId: row.claimId,
            clientId: row.clientId,
            appointmentId: row.appointmentId,
            note,
          }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Action failed");
        }
        const assignment = (json?.assignment ?? null) as
          | { kind: "credentialing" | "biller"; display: string; userId: string | null }
          | null;

        setRows((prev) => prev.map((r) => {
          if (r.id !== row.id) return r;
          switch (action) {
            case "hold_claim":
              return { ...r, holdNote: note || "Held pending provider enrollment fix", claimStatus: "draft" };
            case "release_claim":
              return { ...r, holdNote: null, claimStatus: "ready_for_validation" };
            case "route_to_credentialing":
              return {
                ...r,
                assignedTo: assignment?.display ?? "Credentialing",
                assignedToKind: assignment?.kind ?? "credentialing",
              };
            case "appeal_denial":
              return r;
            case "resubmit_after_correction":
              return { ...r, claimStatus: "ready_for_batch" };
            case "credentialing_note":
              return { ...r, credentialingNote: note ?? r.credentialingNote };
            default:
              return r;
          }
        }));
        setToast(({
          hold_claim: "Claim placed on hold",
          release_claim: "Claim released",
          route_to_credentialing: "Routed to credentialing",
          appeal_denial: "Appeal logged on claim",
          resubmit_after_correction: "Claim queued for resubmission",
          credentialing_note: "Credentialing note added",
        } as Record<string, string>)[action] ?? "Done");
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
      } finally {
        setActingId(null);
      }
    },
    [organizationId],
  );

  const updateProviderData = useCallback((row: ProviderEnrollmentIssueRow) => {
    if (typeof window === "undefined") return;
    const target = row.providerId
      ? `/settings/providers?providerId=${encodeURIComponent(row.providerId)}`
      : "/settings/providers";
    window.open(target, "_blank");
  }, []);

  const rowActions: RowAction<ProviderEnrollmentIssueRow>[] = useMemo(
    () => [
      { id: "hold", label: "Hold claim", onClick: (r) => void performAction(r, "hold_claim"),
        disabled: (r) => actingId === r.id || Boolean(r.holdNote) },
      { id: "update_provider", label: "Update provider data", variant: "primary",
        onClick: (r) => updateProviderData(r) },
      { id: "route_cred", label: "Route to credentialing",
        onClick: (r) => void performAction(r, "route_to_credentialing"),
        disabled: (r) => actingId === r.id },
      { id: "appeal", label: "Appeal denial",
        onClick: (r) => void performAction(r, "appeal_denial"),
        disabled: (r) => actingId === r.id },
      { id: "resubmit", label: "Resubmit after correction", variant: "success",
        onClick: (r) => void performAction(r, "resubmit_after_correction"),
        disabled: (r) => actingId === r.id },
    ],
    [actingId, performAction, updateProviderData],
  );

  // ── Detail panel ────────────────────────────────────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "providerProfile",
        label: "Provider profile",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Clinician" value={selectedRow.clinicianName} />
            <DetailKV label="Provider NPI" value={selectedRow.providerNpi || "—"} />
            <DetailKV label="Taxonomy / specialty" value={selectedRow.taxonomyCode || "—"} />
            <DetailKV label="Internal provider id" value={selectedRow.providerId ? selectedRow.providerId.slice(0, 8) : "—"} />
            <DetailKV label="Practice / location" value={selectedRow.practiceId ? selectedRow.practiceId.slice(0, 8) : "—"} />
            <p style={{ color: "#94A3B8", fontSize: 12, marginTop: 12 }}>
              Use “Update provider data” to open the provider settings record.
            </p>
          </div>
        ) : null,
      },
      {
        id: "enrollmentRecord",
        label: "Payer enrollment record",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Payer" value={selectedRow.payerName} />
            <DetailKV label="Payer (Availity) ID" value={selectedRow.payerId || "—"} />
            <DetailKV label="Transaction" value="837P" />
            <DetailKV label="Environment" value={selectedRow.enrollmentEnvironment || "—"} />
            <DetailKV label="Status" value={selectedRow.enrollmentStatus.replace(/_/g, " ")} />
            <DetailKV label="OA reference" value={selectedRow.enrollmentReference || "—"} />
            <DetailKV label="Approved at" value={formatDateTime(selectedRow.enrollmentApprovedAt)} />
            <DetailKV label="Expires at" value={formatDate(selectedRow.enrollmentExpiresAt)} />
            {selectedRow.enrollmentNotes ? (
              <p style={{ color: "#475569", fontSize: 12, marginTop: 8, whiteSpace: "pre-wrap" }}>
                {selectedRow.enrollmentNotes}
              </p>
            ) : null}
            <p style={{ color: "#94A3B8", fontSize: 12, marginTop: 12 }}>
              Manage enrollments in <strong>Settings → Payer Enrollments</strong>.
            </p>
          </div>
        ) : null,
      },
      {
        id: "claimProviderFields",
        label: "Claim provider fields",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Billing NPI" value={selectedRow.billingNpi || "—"} />
            <DetailKV label="Rendering NPI" value={selectedRow.renderingNpi || "—"} />
            <DetailKV
              label="Rendering = billing?"
              value={selectedRow.renderingNpi ? "No (separate rendering)" : "Yes"}
            />
            <DetailKV
              label="Service facility same as billing?"
              value={selectedRow.serviceFacilitySameAsBilling ? "Yes" : "No"}
            />
            {!selectedRow.serviceFacilitySameAsBilling ? (
              <>
                <DetailKV label="Service facility name" value={selectedRow.serviceFacilityName || "—"} />
                <DetailKV label="Service facility NPI" value={selectedRow.serviceFacilityNpi || "—"} />
              </>
            ) : null}
            <DetailKV label="Claim status" value={selectedRow.claimStatus ?? "—"} />
            <DetailKV label="Total charge" value={formatCurrency(selectedRow.chargeAmount)} />
            {selectedRow.denialCode ? (
              <p style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>
                Last denial: {selectedRow.denialCode}
              </p>
            ) : null}
          </div>
        ) : null,
      },
      {
        id: "credentialingNotes",
        label: "Credentialing notes",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Issue detected" value={ISSUE_LABEL[selectedRow.issueType]} />
            <DetailKV label="Detail" value={selectedRow.issueLabel} />
            <DetailKV label="Assigned to" value={selectedRow.assignedTo ?? "—"} />
            <DetailKV label="Assigned biller" value={selectedRow.assignedBillerId ?? "—"} />
            <DetailKV label="Follow-up due" value={formatDate(selectedRow.followUpDueAt)} />
            {selectedRow.holdNote ? (
              <p style={{ color: "#B45309", fontSize: 12, marginTop: 8 }}>HOLD: {selectedRow.holdNote}</p>
            ) : null}
            {selectedRow.credentialingNote ? (
              <p style={{ color: "#0F172A", fontSize: 13, marginTop: 8, whiteSpace: "pre-wrap" }}>
                Note: {selectedRow.credentialingNote}
              </p>
            ) : (
              <p style={{ color: "#94A3B8", fontSize: 12, marginTop: 8 }}>
                No credentialing note yet. Use the action below to log one.
              </p>
            )}
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => {
                  const note = typeof window !== "undefined" ? window.prompt("Credentialing note:") : null;
                  if (note && note.trim()) {
                    void performAction(selectedRow, "credentialing_note", note.trim());
                  }
                }}
                style={{
                  height: 28, padding: "0 10px", fontSize: 12,
                  border: "1px solid #CBD5E1", borderRadius: 4, background: "#fff", cursor: "pointer",
                }}
              >
                Add credentialing note
              </button>
            </div>
          </div>
        ) : null,
      },
    ],
    [selectedRow, performAction],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const busy = actingId === selectedRow.id;
    return [
      { id: "hold", label: "Hold claim",
        onClick: () => void performAction(selectedRow, "hold_claim"),
        disabled: busy || Boolean(selectedRow.holdNote) },
      { id: "update_provider", label: "Update provider data", variant: "primary",
        onClick: () => updateProviderData(selectedRow) },
      { id: "route_cred", label: "Route to credentialing",
        onClick: () => void performAction(selectedRow, "route_to_credentialing"), disabled: busy },
      { id: "appeal", label: "Appeal denial",
        onClick: () => void performAction(selectedRow, "appeal_denial"), disabled: busy },
      { id: "resubmit", label: "Resubmit after correction", variant: "success",
        onClick: () => void performAction(selectedRow, "resubmit_after_correction"), disabled: busy },
    ];
  }, [selectedRow, actingId, performAction, updateProviderData]);

  // ── Tabs (counts per issueType) ─────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.issueType] = (m[r.issueType] ?? 0) + 1;
    return m;
  }, [rows]);

  return (
    <>
      <div
        role="tablist"
        aria-label="Provider enrollment issue type"
        style={{
          display: "flex", gap: 4, padding: "12px 20px 0", background: "#fff",
          borderBottom: "1px solid #E5E7EB", flexWrap: "wrap",
        }}
      >
        {PROVIDER_ENROLLMENT_ISSUE_TABS.map((t) => {
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => { setActiveTab(t.id); setSelectedRowId(null); }}
              style={{
                background: "transparent",
                border: "none",
                borderBottom: isActive ? "2px solid #0F172A" : "2px solid transparent",
                color: isActive ? "#0F172A" : "#64748B",
                fontWeight: isActive ? 600 : 500,
                padding: "10px 14px",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              {t.label}
              {tabCounts[t.id] ? (
                <span style={{
                  marginLeft: 6, background: "#F1F5F9",
                  color: "#475569", padding: "1px 8px",
                  borderRadius: 10, fontSize: 12,
                }}>{tabCounts[t.id]}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <WorkqueueShell<ProviderEnrollmentIssueRow>
        title={queueDef?.title ?? "Provider Enrollment Issues"}
        description={queueDef?.description}
        headerActions={[
          { id: "refresh", label: loading ? "Loading…" : "Refresh", onClick: () => void load(), disabled: loading },
        ]}
        summary={summary}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`provenroll_${activeTab}`}
        rows={filteredRows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No items in this tab."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={error ? { tone: "error", text: error } : null}
      />

      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}

function DetailKV({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex", justifyContent: "space-between", gap: 12,
        fontSize: 13, padding: "5px 0", borderBottom: "1px solid #F1F5F9",
      }}
    >
      <span style={{ color: "#64748B", fontWeight: 500 }}>{label}</span>
      <span style={{ color: "#0F172A", textAlign: "right", maxWidth: "60%" }}>{value}</span>
    </div>
  );
}
