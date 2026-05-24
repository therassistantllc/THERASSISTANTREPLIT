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
  PAYER_RECEIVED_TABS,
  type PayerReceivedRow,
  type PayerReceivedTab,
} from "@/lib/billing/payerReceivedService";

type ListPayload = {
  success: boolean;
  error?: string;
  rows?: PayerReceivedRow[];
};

const queueDef = getWorkqueue("payer_received");

function getOrganizationId(): string {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

function fmtDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

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

function DetailKV({ label, value }: { label: string; value: React.ReactNode }) {
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

export default function PayerReceivedClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<PayerReceivedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PayerReceivedTab>("received");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      for (const [k, v] of Object.entries(filterValues)) if (v) params.set(k, v);
      const res = await fetch(
        `/api/billing/payer-received?${params.toString()}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as ListPayload;
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows(json.rows ?? []);
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

  // ── Filter rail options ────────────────────────────────────────────────
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
      if (r.providerId) m.set(r.providerId, `Clinician ${r.providerId.slice(0, 8)}`);
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);
  const statusOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.payerStatus) m.set(r.payerStatus, r.payerStatus);
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "select", options: practiceOptions },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicianOptions },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Patient name…" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      { id: "status", label: "Payer status", kind: "select", options: statusOptions },
      { id: "assignedBiller", label: "Assigned biller", kind: "text", placeholder: "user id…" },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Days in process",
        kind: "select",
        options: [
          { value: "0-30", label: "0-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "61-90", label: "61-90 days" },
          { value: "90+", label: "90+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. CO-45" },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [{ value: "urgent", label: "Urgent (30+ days)" }],
      },
      {
        id: "overdue",
        label: "SLA",
        kind: "select",
        options: [{ value: "true", label: "Overdue only" }],
      },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [payerOptions, practiceOptions, clinicianOptions, statusOptions],
  );

  // ── Filter + tab rows in-memory (mirrors server) ───────────────────────
  const filteredRows = useMemo(() => {
    let out = rows.filter((r) => r.tab === activeTab);
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
    if (v.status) out = out.filter((r) => r.payerStatus === v.status);
    if (v.priority === "urgent") out = out.filter((r) => r.daysInProcess >= 30);
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
        const a = r.daysInProcess;
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
    if (v.overdue === "true") out = out.filter((r) => r.overdue);
    // Mirror server default sort: overdue first, then by days-in-process desc.
    out = [...out].sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.overdue && b.overdue && a.daysOverdue !== b.daysOverdue) {
        return b.daysOverdue - a.daysOverdue;
      }
      return b.daysInProcess - a.daysInProcess;
    });
    return out;
  }, [rows, activeTab, filterValues]);

  // ── Summary strip ──────────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const total = filteredRows.length;
    const dollars = filteredRows.reduce((s, r) => s + r.chargeAmount, 0);
    const oldest = filteredRows.reduce((m, r) => Math.max(m, r.daysInProcess), 0);
    const urgent = filteredRows.filter((r) => r.daysInProcess >= 30).length;
    const overdueCount = filteredRows.filter((r) => r.overdue).length;
    return [
      { id: "count", label: "Items", value: total.toLocaleString() },
      { id: "dollars", label: "Total $", value: fmtCurrency(dollars), tone: dollars > 0 ? "amber" : "default" },
      { id: "oldest", label: "Oldest claim age (days)", value: oldest, tone: oldest > 60 ? "red" : oldest > 30 ? "amber" : "default" },
      { id: "overdue", label: "Overdue (SLA breach)", value: overdueCount, tone: overdueCount > 0 ? "red" : "default" },
      { id: "urgent", label: "Urgent (30+ days)", value: urgent, tone: urgent > 0 ? "red" : "default" },
    ];
  }, [filteredRows]);

  // ── Columns (exact spec) ──────────────────────────────────────────────
  const columns: ColumnDef<PayerReceivedRow>[] = useMemo(
    () => [
      {
        id: "claim",
        header: "Claim ID",
        cell: (r) => <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.claimNumber}</span>,
      },
      { id: "client", header: "Client", cell: (r) => r.clientName },
      { id: "payer", header: "Payer", cell: (r) => r.payerName },
      { id: "dos", header: "DOS", cell: (r) => fmtDate(r.dateOfService) },
      { id: "received", header: "Payer received date", cell: (r) => fmtDate(r.payerReceivedAt) },
      {
        id: "status",
        header: "Payer status",
        cell: (r) => (
          <span style={{ textTransform: "capitalize" }}>
            {(r.payerStatus || "—").replace(/_/g, " ")}
          </span>
        ),
      },
      {
        id: "days",
        header: "Days in process",
        align: "right",
        cell: (r) => (
          <span style={{ color: r.daysInProcess > 60 ? "#B91C1C" : r.daysInProcess > 30 ? "#B45309" : "#0F172A", fontWeight: 600 }}>
            {r.daysInProcess}
          </span>
        ),
      },
      { id: "charge", header: "Charge amount", align: "right", cell: (r) => fmtCurrency(r.chargeAmount) },
      {
        id: "expected",
        header: "Expected adjudication date",
        cell: (r) => (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: r.overdue ? "#B91C1C" : "#0F172A" }}>
              {fmtDate(r.expectedAdjudicationAt)}
            </span>
            {r.overdue ? (
              <span
                aria-label={`Overdue by ${r.daysOverdue} day${r.daysOverdue === 1 ? "" : "s"}`}
                title={`SLA breach — ${r.daysOverdue} day${r.daysOverdue === 1 ? "" : "s"} past expected adjudication`}
                style={{
                  background: "#FEE2E2", color: "#991B1B",
                  padding: "1px 8px", borderRadius: 10,
                  fontSize: 11, fontWeight: 600, letterSpacing: 0.2,
                  textTransform: "uppercase",
                }}
              >
                Overdue · {r.daysOverdue}d
              </span>
            ) : null}
          </span>
        ),
      },
    ],
    [],
  );

  const selectedRow = useMemo(
    () => filteredRows.find((r) => r.id === selectedRowId) ?? null,
    [filteredRows, selectedRowId],
  );

  // ── Actions ────────────────────────────────────────────────────────────
  const performAction = useCallback(
    async (
      row: PayerReceivedRow,
      action: "check_status" | "add_note" | "set_follow_up" | "move_to_aging",
      extras?: { note?: string; followUpDueAt?: string },
    ) => {
      setActingId(row.id);
      try {
        const res = await fetch("/api/billing/payer-received/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            action,
            claimId: row.claimId,
            clientId: row.clientId,
            note: extras?.note,
            followUpDueAt: extras?.followUpDueAt,
          }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Action failed");
        }
        // Optimistic update
        setRows((prev) => prev.map((r) => {
          if (r.id !== row.id) return r;
          switch (action) {
            case "check_status":
              return {
                ...r,
                statusHistory: [
                  {
                    source: "276/277",
                    status: "queued",
                    message: "Status inquiry queued",
                    payerReferenceId: null,
                    at: new Date().toISOString(),
                  },
                  ...r.statusHistory,
                ],
                tab: r.tab === "received" ? "in_process" : r.tab,
              };
            case "add_note":
              return {
                ...r,
                followUpNotes: [
                  {
                    id: `local-${Date.now()}`,
                    at: new Date().toISOString(),
                    summary: extras?.note ?? "",
                    userId: null,
                  },
                  ...r.followUpNotes,
                ],
              };
            case "set_follow_up":
              return { ...r, followUpDueAt: extras?.followUpDueAt ?? r.followUpDueAt, tab: "approaching_follow_up" };
            case "move_to_aging":
              return r; // we filter it out below
            default:
              return r;
          }
        }));
        if (action === "move_to_aging") {
          setRows((prev) => prev.filter((r) => r.id !== row.id));
          if (selectedRowId === row.id) setSelectedRowId(null);
        }
        setToast(({
          check_status: "Status inquiry queued",
          add_note: "Note added",
          set_follow_up: "Follow-up set",
          move_to_aging: "Moved to aging queue",
        } as Record<string, string>)[action] ?? "Done");
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
      } finally {
        setActingId(null);
      }
    },
    [organizationId, selectedRowId],
  );

  const promptNote = useCallback(
    (row: PayerReceivedRow) => {
      if (typeof window === "undefined") return;
      const note = window.prompt("Add follow-up note for this claim:");
      if (note && note.trim()) void performAction(row, "add_note", { note: note.trim() });
    },
    [performAction],
  );

  const promptFollowUp = useCallback(
    (row: PayerReceivedRow) => {
      if (typeof window === "undefined") return;
      const def = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
      const due = window.prompt("Set follow-up due date (YYYY-MM-DD):", def);
      if (due && /^\d{4}-\d{2}-\d{2}$/.test(due.trim())) {
        void performAction(row, "set_follow_up", { followUpDueAt: due.trim() });
      }
    },
    [performAction],
  );

  const confirmMoveToAging = useCallback(
    (row: PayerReceivedRow) => {
      if (typeof window === "undefined") return;
      if (window.confirm(`Move claim ${row.claimNumber} to the aging / no-response queue?`)) {
        void performAction(row, "move_to_aging");
      }
    },
    [performAction],
  );

  const rowActions: RowAction<PayerReceivedRow>[] = useMemo(
    () => [
      { id: "check", label: "Check payer status", variant: "primary", onClick: (r) => void performAction(r, "check_status"), disabled: (r) => actingId === r.id },
      { id: "note", label: "Add note", onClick: (r) => promptNote(r), disabled: (r) => actingId === r.id },
      { id: "follow", label: "Set follow-up", onClick: (r) => promptFollowUp(r), disabled: (r) => actingId === r.id },
      { id: "aging", label: "Move to aging", variant: "danger", onClick: (r) => confirmMoveToAging(r), disabled: (r) => actingId === r.id },
    ],
    [actingId, performAction, promptNote, promptFollowUp, confirmMoveToAging],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const busy = actingId === selectedRow.id;
    return [
      { id: "check", label: busy ? "Working…" : "Check payer status", variant: "primary",
        onClick: () => void performAction(selectedRow, "check_status"), disabled: busy },
      { id: "note", label: "Add note", onClick: () => promptNote(selectedRow), disabled: busy },
      { id: "follow", label: "Set follow-up", onClick: () => promptFollowUp(selectedRow), disabled: busy },
      { id: "aging", label: "Move to aging", variant: "danger",
        onClick: () => confirmMoveToAging(selectedRow), disabled: busy },
    ];
  }, [selectedRow, actingId, performAction, promptNote, promptFollowUp, confirmMoveToAging]);

  // ── Detail panel sections ─────────────────────────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "history",
        label: "276/277 status history",
        render: () => selectedRow ? (
          <div>
            {selectedRow.statusHistory.length === 0 ? (
              <p style={{ color: "#94A3B8", fontSize: 13 }}>
                No payer status events on file yet. Click <strong>Check payer status</strong> to send a 276 inquiry.
              </p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {selectedRow.statusHistory.map((h, i) => (
                  <li key={`${h.at}-${i}`} style={{ padding: "8px 0", borderBottom: "1px solid #F1F5F9" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <strong style={{ textTransform: "capitalize" }}>{h.status.replace(/_/g, " ")}</strong>
                      <span style={{ color: "#64748B" }}>{fmtDateTime(h.at)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#475569" }}>{h.source}</div>
                    {h.message ? <div style={{ fontSize: 12, color: "#0F172A", marginTop: 2 }}>{h.message}</div> : null}
                    {h.payerReferenceId ? (
                      <div style={{ fontSize: 11, color: "#64748B", fontFamily: "ui-monospace, monospace" }}>
                        ref: {h.payerReferenceId}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null,
      },
      {
        id: "payerNum",
        label: "Payer claim number",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Payer claim #" value={selectedRow.payerClaimNumber ?? "—"} />
            <DetailKV label="Payer status code" value={selectedRow.payerStatusCode ?? "—"} />
            <DetailKV label="Payer status text" value={selectedRow.payerStatusText ?? "—"} />
            <DetailKV label="Payer" value={selectedRow.payerName} />
            <DetailKV label="Internal claim #" value={selectedRow.claimNumber} />
          </div>
        ) : null,
      },
      {
        id: "trace",
        label: "Submission trace",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Submitted at" value={fmtDateTime(selectedRow.submissionTrace.submittedAt)} />
            <DetailKV label="Acknowledged at" value={fmtDateTime(selectedRow.submissionTrace.acknowledgedAt)} />
            <DetailKV label="Submission sequence" value={String(selectedRow.submissionTrace.submissionSequence ?? "—")} />
            <DetailKV label="Submission status" value={selectedRow.submissionTrace.submissionStatus ?? "—"} />
            <DetailKV label="Clearinghouse ref" value={selectedRow.submissionTrace.clearinghouseReference ?? "—"} />
            <DetailKV label="Payer claim ref" value={selectedRow.submissionTrace.payerClaimReference ?? "—"} />
            <DetailKV label="Expected adjudication" value={fmtDate(selectedRow.expectedAdjudicationAt)} />
          </div>
        ) : null,
      },
      {
        id: "notes",
        label: "Follow-up notes",
        render: () => selectedRow ? (
          <div>
            {selectedRow.followUpDueAt ? (
              <p style={{ fontSize: 13, color: "#B45309", marginTop: 0 }}>
                Next follow-up due {fmtDate(selectedRow.followUpDueAt)}
              </p>
            ) : null}
            {selectedRow.followUpNotes.length === 0 ? (
              <p style={{ color: "#94A3B8", fontSize: 13 }}>
                No follow-up notes yet. Click <strong>Add note</strong> to record one.
              </p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {selectedRow.followUpNotes.map((n) => (
                  <li key={n.id} style={{ padding: "8px 0", borderBottom: "1px solid #F1F5F9" }}>
                    <div style={{ fontSize: 12, color: "#64748B" }}>{fmtDateTime(n.at)}</div>
                    <div style={{ fontSize: 13, color: "#0F172A" }}>{n.summary}</div>
                  </li>
                ))}
              </ul>
            )}
            {selectedRow.billingNotes ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: "#64748B", marginBottom: 4 }}>Billing notes</div>
                <pre style={{ fontSize: 12, whiteSpace: "pre-wrap", background: "#F8FAFC", padding: 8, borderRadius: 4, margin: 0 }}>
                  {selectedRow.billingNotes}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null,
      },
    ],
    [selectedRow],
  );

  // ── Tab counts ─────────────────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.tab] = (m[r.tab] ?? 0) + 1;
    return m;
  }, [rows]);

  const overdueTotal = useMemo(
    () => rows.filter((r) => r.overdue).length,
    [rows],
  );
  const overdueOnly = filterValues.overdue === "true";
  const toggleOverdueOnly = useCallback(() => {
    setFilterValues((prev) => {
      const next = { ...prev };
      if (next.overdue === "true") delete next.overdue;
      else next.overdue = "true";
      return next;
    });
  }, []);

  return (
    <>
      <div
        role="tablist"
        aria-label="Payer received tab"
        style={{
          display: "flex", gap: 4, padding: "12px 20px 0", background: "#fff",
          borderBottom: "1px solid #E5E7EB", flexWrap: "wrap",
        }}
      >
        {PAYER_RECEIVED_TABS.map((t) => {
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => { setActiveTab(t.id); setSelectedRowId(null); }}
              style={{
                background: "transparent", border: "none",
                borderBottom: isActive ? "2px solid #0F172A" : "2px solid transparent",
                color: isActive ? "#0F172A" : "#64748B",
                fontWeight: isActive ? 600 : 500,
                padding: "10px 14px", cursor: "pointer", fontSize: 14,
              }}
            >
              {t.label}
              {tabCounts[t.id] ? (
                <span style={{
                  marginLeft: 6, background: "#F1F5F9", color: "#475569",
                  padding: "1px 8px", borderRadius: 10, fontSize: 12,
                }}>{tabCounts[t.id]}</span>
              ) : null}
            </button>
          );
        })}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", paddingBottom: 6 }}>
          <button
            type="button"
            onClick={toggleOverdueOnly}
            aria-pressed={overdueOnly}
            title="Show only claims whose expected adjudication date has passed"
            style={{
              border: `1px solid ${overdueOnly ? "#B91C1C" : "#E5E7EB"}`,
              background: overdueOnly ? "#FEF2F2" : "#fff",
              color: overdueOnly ? "#991B1B" : "#0F172A",
              padding: "6px 12px", borderRadius: 6, fontSize: 13,
              fontWeight: 600, cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 8,
            }}
          >
            Overdue only
            <span style={{
              background: overdueOnly ? "#B91C1C" : "#F1F5F9",
              color: overdueOnly ? "#fff" : "#475569",
              padding: "1px 8px", borderRadius: 10, fontSize: 12, fontWeight: 600,
            }}>{overdueTotal}</span>
          </button>
        </div>
      </div>

      <WorkqueueShell<PayerReceivedRow>
        title={queueDef?.title ?? "Payer Received"}
        description={queueDef?.description}
        headerActions={[
          { id: "refresh", label: loading ? "Loading…" : "Refresh", onClick: () => void load(), disabled: loading },
        ]}
        summary={summary}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`payer_received_${activeTab}`}
        rows={filteredRows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No claims in this tab."
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
