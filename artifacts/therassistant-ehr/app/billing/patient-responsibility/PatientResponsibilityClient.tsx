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
  PATIENT_RESPONSIBILITY_TABS,
  type PatientResponsibilityTab,
} from "@/lib/patient-responsibility/tabs";
import type {
  PatientResponsibilityContext,
  PatientResponsibilityRow,
} from "@/lib/patient-responsibility/types";

interface ListPayload {
  success: boolean;
  error?: string;
  rows?: PatientResponsibilityRow[];
}
interface ContextPayload {
  success: boolean;
  error?: string;
  context?: PatientResponsibilityContext;
}

const queueDef = getWorkqueue("patient_responsibility");

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
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid #F1F5F9", fontSize: 13 }}>
      <span style={{ color: "#64748B" }}>{label}</span>
      <span style={{ fontWeight: 500, color: "#0F172A", textAlign: "right" }}>{value ?? "—"}</span>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: "default" | "green" | "amber" | "red" | "blue" }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    default: { bg: "#F1F5F9", fg: "#475569" },
    green: { bg: "#DCFCE7", fg: "#166534" },
    amber: { bg: "#FEF3C7", fg: "#92400E" },
    red: { bg: "#FEE2E2", fg: "#991B1B" },
    blue: { bg: "#DBEAFE", fg: "#1E40AF" },
  };
  const p = palette[tone] ?? palette.default;
  return (
    <span style={{ background: p.bg, color: p.fg, padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
      {label}
    </span>
  );
}

function invoiceTone(label: string): "default" | "green" | "amber" | "red" | "blue" {
  const l = label.toLowerCase();
  if (l === "paid") return "green";
  if (l === "sent") return "blue";
  if (l === "open") return "amber";
  if (l === "partial") return "amber";
  if (l === "voided") return "red";
  if (l === "on hold") return "red";
  return "default";
}

export default function PatientResponsibilityClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<PatientResponsibilityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(0);

  const [activeTab, setActiveTab] = useState<PatientResponsibilityTab>("ready_for_invoice");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const [ctxByEra, setCtxByEra] = useState<Record<string, PatientResponsibilityContext>>({});
  const [ctxLoading, setCtxLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      for (const [k, v] of Object.entries(filterValues)) if (v) params.set(k, v);
      const res = await fetch(`/api/billing/patient-responsibility?${params.toString()}`, { cache: "no-store" });
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

  // Tab counts
  const tabCounts = useMemo(() => {
    const m: Record<PatientResponsibilityTab, number> = {
      ready_for_invoice: 0,
      needs_review: 0,
      deductible: 0,
      copay: 0,
      coinsurance: 0,
      noncovered: 0,
    };
    for (const r of rows) for (const t of r.tabs) m[t]++;
    return m;
  }, [rows]);

  // Filter option lists derived from rows
  const payerOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.payerName && r.payerName !== "—") m.set(r.payerName, r.payerName);
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);
  const practiceOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.practiceId) m.set(r.practiceId, `Practice ${r.practiceId.slice(0, 8)}`);
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);
  const clinicianOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.providerId) m.set(r.providerId, `Clinician ${r.providerId.slice(0, 8)}`);
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
        id: "status", label: "Invoice status", kind: "select",
        options: [
          { value: "not created", label: "Not created" },
          { value: "open", label: "Open" },
          { value: "sent", label: "Sent" },
          { value: "partial", label: "Partial" },
          { value: "paid", label: "Paid" },
          { value: "voided", label: "Voided" },
          { value: "on hold", label: "On hold" },
        ],
      },
      { id: "assignedBiller", label: "Assigned biller", kind: "text", placeholder: "user id…" },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket", label: "ERA age", kind: "select",
        options: [
          { value: "0-30", label: "0-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "61-90", label: "61-90 days" },
          { value: "90+", label: "90+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. PR-1" },
      {
        id: "priority", label: "Priority", kind: "select",
        options: [{ value: "urgent", label: "Urgent / Overdue" }],
      },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [payerOptions, practiceOptions, clinicianOptions],
  );

  const filteredRows = useMemo(
    () => rows.filter((r) => r.tabs.includes(activeTab)),
    [rows, activeTab],
  );

  const summary: SummaryMetric[] = useMemo(() => {
    const total = filteredRows.length;
    const dollars = filteredRows.reduce((s, r) => s + r.patientAmount, 0);
    const oldest = filteredRows.reduce((maxAge, r) => (r.ageDays > maxAge ? r.ageDays : maxAge), 0);
    const urgent = filteredRows.filter((r) => r.isUrgent).length;
    return [
      { id: "count", label: "Items", value: total.toLocaleString() },
      { id: "dollars", label: "Total client $", value: formatCurrency(dollars), tone: dollars > 0 ? "amber" : "default" },
      { id: "oldest", label: "Oldest ERA (days)", value: oldest, tone: oldest > 30 ? "red" : oldest > 14 ? "amber" : "default" },
      { id: "urgent", label: "Urgent / Overdue", value: urgent, tone: urgent > 0 ? "red" : "default" },
    ];
  }, [filteredRows]);

  // Columns — spec order: Client, Claim ID, DOS, Payer, Client amount,
  // Reason, Invoice status, Autopay status, Statement date.
  const columns: ColumnDef<PatientResponsibilityRow>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.clientName },
      {
        id: "claim", header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.claimNumber || (r.claimId ? r.claimId.slice(0, 8) : "—")}
          </span>
        ),
      },
      { id: "dos", header: "DOS", cell: (r) => formatDate(r.dateOfService) },
      { id: "payer", header: "Payer", cell: (r) => r.payerName || "—" },
      {
        id: "amount", header: "Client amount", align: "right",
        cell: (r) => <span style={{ fontWeight: 600 }}>{formatCurrency(r.patientAmount)}</span>,
      },
      {
        id: "reason", header: "Reason",
        cell: (r) => <span style={{ fontSize: 13 }}>{r.reasonLabel}</span>,
      },
      {
        id: "invoice", header: "Invoice status",
        cell: (r) => <StatusPill label={r.invoiceStatusLabel} tone={invoiceTone(r.invoiceStatusLabel)} />,
      },
      {
        id: "autopay", header: "Autopay status",
        cell: (r) => (
          <span style={{ fontSize: 12, color: r.autopayStatusLabel === "Not enrolled" ? "#94A3B8" : "#0F172A" }}>
            {r.autopayStatusLabel}
          </span>
        ),
      },
      { id: "statement", header: "Statement date", cell: (r) => formatDate(r.statementDate) },
    ],
    [],
  );

  const selectedRow = useMemo(
    () => filteredRows.find((r) => r.id === selectedRowId) ?? null,
    [filteredRows, selectedRowId],
  );

  // Load context when a row is selected
  useEffect(() => {
    if (!selectedRow) return;
    const eraId = selectedRow.eraClaimPaymentId;
    if (ctxByEra[eraId] || ctxLoading === eraId) return;
    setCtxLoading(eraId);
    void (async () => {
      try {
        const params = new URLSearchParams({ organizationId, eraClaimPaymentId: eraId });
        const res = await fetch(`/api/billing/patient-responsibility/context?${params.toString()}`, { cache: "no-store" });
        const json = (await res.json()) as ContextPayload;
        if (json.success && json.context) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setCtxByEra((prev) => ({ ...prev, [eraId]: json.context! }));
        }
      } finally {
        setCtxLoading(null);
      }
    })();
  }, [selectedRow, organizationId, ctxByEra, ctxLoading]);

  // Action handler with optimistic updates
  const performAction = useCallback(
    async (row: PatientResponsibilityRow, action: string, extra?: Record<string, unknown>) => {
      setActingId(row.id);
      try {
        const res = await fetch("/api/billing/patient-responsibility/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            action,
            eraClaimPaymentId: row.eraClaimPaymentId,
            claimId: row.claimId,
            clientId: row.clientId,
            ...extra,
          }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Action failed");

        const nowIso = new Date().toISOString();
        setRows((prev) => prev.map((r) => {
          if (r.id !== row.id) return r;
          switch (action) {
            case "create_invoice":
              return {
                ...r,
                invoice: {
                  id: String(json.invoiceId),
                  invoiceNumber: String(json.invoiceNumber ?? ""),
                  status: String(json.invoiceStatus ?? "open"),
                  amount: Number(json.balanceAmount ?? r.patientAmount),
                  balanceAmount: Number(json.balanceAmount ?? r.patientAmount),
                  paidAmount: 0,
                  createdAt: nowIso,
                },
                invoiceStatusLabel: "Open",
                tabs: r.tabs.filter((t) => t !== "ready_for_invoice" && t !== "needs_review"),
              };
            case "send_statement":
              return {
                ...r,
                statementDate: nowIso,
                invoiceStatusLabel: r.invoiceStatusLabel === "Not created" ? "Sent" : "Sent",
              };
            case "hold_billing":
              return { ...r, onHold: true, invoiceStatusLabel: r.invoice ? r.invoiceStatusLabel : "On hold" };
            case "release_hold":
              return { ...r, onHold: false, invoiceStatusLabel: r.invoice ? r.invoiceStatusLabel : "Not created" };
            case "apply_adjustment": {
              const adj = Number((extra as { adjustmentAmount?: number } | undefined)?.adjustmentAmount ?? 0);
              const next = Math.max(0, r.patientAmount - adj);
              return { ...r, patientAmount: Math.round(next * 100) / 100 };
            }
            default:
              return r;
          }
        }));
        // Invalidate cached context (so next open re-fetches).
        setCtxByEra((prev) => {
          const next = { ...prev };
          delete next[row.eraClaimPaymentId];
          return next;
        });
        setToast(({
          create_invoice: `Invoice created${json.invoiceNumber ? ` (${json.invoiceNumber})` : ""}`,
          send_statement: "Statement sent",
          charge_card: json.message ?? "Card charge requested",
          apply_adjustment: "Adjustment applied",
          hold_billing: "Client billing held",
          release_hold: "Hold released",
        } as Record<string, string>)[action] ?? "Done");
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
      } finally {
        setActingId(null);
      }
    },
    [organizationId],
  );

  const rowActions: RowAction<PatientResponsibilityRow>[] = useMemo(
    () => [
      {
        id: "create_invoice",
        label: "Create invoice",
        variant: "primary",
        onClick: (r) => void performAction(r, "create_invoice"),
        disabled: (r) => actingId === r.id || !!r.invoice || !r.clientId,
      },
      {
        id: "send_statement",
        label: "Send statement",
        onClick: (r) => void performAction(r, "send_statement"),
        disabled: (r) => actingId === r.id || !r.invoice,
      },
      {
        id: "charge_card",
        label: "Charge card",
        onClick: (r) => void performAction(r, "charge_card", { amount: r.patientAmount }),
        disabled: (r) => {
          if (actingId === r.id || !r.clientId) return true;
          const m = ctxByEra[r.eraClaimPaymentId]?.paymentMethod;
          // If we have context loaded and there's no saved card, disable;
          // otherwise allow optimistic click — the server returns a
          // helpful 422 if the client has no card on file.
          if (m && m.hasSavedCard === false) return true;
          return false;
        },
      },
      {
        id: "apply_adjustment",
        label: "Apply adjustment",
        onClick: (r) => {
          const v = typeof window !== "undefined"
            ? window.prompt(`Adjustment amount to write off (current PR $${r.patientAmount.toFixed(2)})`, r.patientAmount.toFixed(2))
            : null;
          if (!v) return;
          const adj = Number(v);
          if (!Number.isFinite(adj) || adj <= 0) {
            setToast("Adjustment must be a positive number");
            return;
          }
          const reason = typeof window !== "undefined"
            ? window.prompt("Reason for adjustment", "manual_writeoff") ?? "manual_writeoff"
            : "manual_writeoff";
          void performAction(r, "apply_adjustment", { adjustmentAmount: adj, adjustmentReason: reason });
        },
        disabled: (r) => actingId === r.id,
      },
      {
        id: "hold",
        label: (() => "Hold client billing")(),
        variant: "danger",
        onClick: (r) => void performAction(r, r.onHold ? "release_hold" : "hold_billing"),
        disabled: (r) => actingId === r.id,
      },
    ],
    [actingId, performAction, ctxByEra],
  );

  const ctx = selectedRow ? ctxByEra[selectedRow.eraClaimPaymentId] : undefined;
  const ctxIsLoading = selectedRow && ctxLoading === selectedRow.eraClaimPaymentId;

  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "eraBreakdown", label: "ERA breakdown",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          if (!ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>No ERA detail available.</p>;
          const e = ctx.eraBreakdown;
          return (
            <div>
              <DetailKV label="Total charge" value={formatCurrency(e.totalCharge)} />
              <DetailKV label="Allowed amount" value={e.allowedAmount == null ? "—" : formatCurrency(e.allowedAmount)} />
              <DetailKV label="Insurance paid" value={formatCurrency(e.insurancePaid)} />
              <DetailKV label="Contractual adj (CO)" value={formatCurrency(e.contractualAdjustment)} />
              <DetailKV label="Client responsibility" value={<strong>{formatCurrency(e.patientResponsibility)}</strong>} />
              <DetailKV label="Check / EFT #" value={e.checkEftNumber ?? "—"} />
              <DetailKV label="Check issue date" value={formatDate(e.checkIssueDate)} />
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Service lines</h4>
              {e.serviceLines.length === 0 ? (
                <p style={{ color: "#64748B", fontSize: 12 }}>No service-line detail.</p>
              ) : (
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "#64748B" }}>
                      <th style={{ padding: "4px 0" }}>CPT</th>
                      <th style={{ padding: "4px 0", textAlign: "right" }}>Charge</th>
                      <th style={{ padding: "4px 0", textAlign: "right" }}>Paid</th>
                      <th style={{ padding: "4px 0", textAlign: "right" }}>PR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.serviceLines.map((l, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #F1F5F9" }}>
                        <td style={{ padding: "4px 0", fontFamily: "ui-monospace,monospace" }}>{l.cpt ?? "—"}</td>
                        <td style={{ padding: "4px 0", textAlign: "right" }}>{formatCurrency(l.charge)}</td>
                        <td style={{ padding: "4px 0", textAlign: "right" }}>{formatCurrency(l.paid)}</td>
                        <td style={{ padding: "4px 0", textAlign: "right" }}>{formatCurrency(l.patientResp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {e.carcCodes.length + e.rarcCodes.length > 0 ? (
                <p style={{ marginTop: 8, fontSize: 12, color: "#475569" }}>
                  Codes: {[...e.carcCodes, ...e.rarcCodes].join(", ")}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "reason", label: "Client responsibility reason",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          if (!ctx) return null;
          return (
            <div>
              <DetailKV label="Primary reason" value={ctx.reason.label} />
              {ctx.reason.explanations.length === 0 ? (
                <p style={{ color: "#64748B", fontSize: 13, marginTop: 8 }}>
                  No CARC-level allocation provided by the payer. Treat as unspecified PR.
                </p>
              ) : (
                <ul style={{ margin: "8px 0 0 20px", padding: 0, fontSize: 13 }}>
                  {ctx.reason.explanations.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              )}
            </div>
          );
        },
      },
      {
        id: "balance", label: "Existing client balance",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          if (!ctx?.existingBalance) {
            return <p style={{ color: "#64748B", fontSize: 13 }}>No prior client balance on file.</p>;
          }
          const b = ctx.existingBalance;
          return (
            <div>
              <DetailKV label="Current balance" value={formatCurrency(b.currentBalance)} />
              <DetailKV
                label="In collections"
                value={b.inCollections ? <StatusPill label="Yes" tone="red" /> : <StatusPill label="No" tone="green" />}
              />
              <DetailKV label="Last payment" value={b.lastPaymentAmount == null ? "—" : `${formatCurrency(b.lastPaymentAmount)} on ${formatDate(b.lastPaymentDate)}`} />
              <DetailKV label="Last statement" value={formatDate(b.lastStatementDate)} />
            </div>
          );
        },
      },
      {
        id: "method", label: "Payment method",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          if (!ctx) return null;
          const m = ctx.paymentMethod;
          const expLabel = m.cardExpMonth && m.cardExpYear
            ? `${String(m.cardExpMonth).padStart(2, "0")}/${String(m.cardExpYear).slice(-2)}`
            : null;
          return (
            <div>
              <DetailKV
                label="Saved card"
                value={m.hasSavedCard
                  ? <strong>{(m.cardBrand || "Card")} •••• {m.cardLast4 || "----"}{expLabel ? `  (exp ${expLabel})` : ""}</strong>
                  : <StatusPill label="None on file" tone="amber" />}
              />
              <DetailKV
                label="Autopay"
                value={m.autopayEnabled
                  ? <StatusPill label="Enabled" tone="green" />
                  : <StatusPill label="Off" tone="default" />}
              />
              <DetailKV label="Client portal" value={m.portalStatus ?? "Not configured"} />
              <DetailKV label="Email on file" value={m.hasEmail ? <StatusPill label="Yes" tone="green" /> : <StatusPill label="No" tone="amber" />} />
              <DetailKV label="Phone on file" value={m.hasPhone ? <StatusPill label="Yes" tone="green" /> : <StatusPill label="No" tone="amber" />} />
              <DetailKV label="Mailing address" value={m.hasMailingAddress ? <StatusPill label="Yes" tone="green" /> : <StatusPill label="No" tone="amber" />} />
              {!m.hasSavedCard ? (
                <p style={{ marginTop: 8, fontSize: 12, color: "#64748B" }}>
                  No card on file — add one from the client&apos;s billing page before charging.
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "preview", label: "Invoice preview",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          if (!ctx) return null;
          if (ctx.existingInvoice) {
            const inv = ctx.existingInvoice;
            return (
              <div>
                <p style={{ fontSize: 13, color: "#475569", marginBottom: 8 }}>An invoice already exists for this ERA:</p>
                <DetailKV label="Invoice #" value={<span style={{ fontFamily: "ui-monospace,monospace" }}>{inv.invoiceNumber}</span>} />
                <DetailKV label="Status" value={<StatusPill label={inv.status} tone={invoiceTone(inv.status)} />} />
                <DetailKV label="Amount" value={formatCurrency(inv.amount)} />
                <DetailKV label="Paid" value={formatCurrency(inv.paidAmount)} />
                <DetailKV label="Balance" value={<strong>{formatCurrency(inv.balanceAmount)}</strong>} />
                <DetailKV label="Created" value={formatDateTime(inv.createdAt)} />
              </div>
            );
          }
          const p = ctx.invoicePreview;
          return (
            <div>
              <DetailKV label="Invoice # (preview)" value={<span style={{ fontFamily: "ui-monospace,monospace" }}>{p.invoiceNumberPreview}</span>} />
              <DetailKV label="Client" value={p.clientName} />
              <DetailKV label="Email" value={p.clientEmail ?? "—"} />
              <DetailKV label="Amount" value={<strong>{formatCurrency(p.amount)}</strong>} />
              <DetailKV label="Source" value={p.proposedSource} />
              <p style={{ marginTop: 8, fontSize: 13, color: "#475569" }}>{p.lineDescription}</p>
            </div>
          );
        },
      },
    ],
    [selectedRow, ctx, ctxIsLoading],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const r = selectedRow;
    return [
      {
        id: "create_invoice", label: "Create invoice", variant: "primary",
        onClick: () => void performAction(r, "create_invoice"),
        disabled: actingId === r.id || !!r.invoice || !r.clientId,
      },
      {
        id: "send_statement", label: "Send statement",
        onClick: () => void performAction(r, "send_statement"),
        disabled: actingId === r.id || !r.invoice,
      },
      {
        id: "charge_card", label: "Charge card",
        onClick: () => void performAction(r, "charge_card", { amount: r.patientAmount }),
        disabled: actingId === r.id || !r.clientId
          || (ctx?.paymentMethod ? ctx.paymentMethod.hasSavedCard === false : false),
      },
      {
        id: "apply_adjustment", label: "Apply adjustment",
        onClick: () => {
          const v = typeof window !== "undefined"
            ? window.prompt(`Adjustment amount to write off (current PR $${r.patientAmount.toFixed(2)})`, r.patientAmount.toFixed(2))
            : null;
          if (!v) return;
          const adj = Number(v);
          if (!Number.isFinite(adj) || adj <= 0) {
            setToast("Adjustment must be a positive number");
            return;
          }
          const reason = typeof window !== "undefined"
            ? window.prompt("Reason for adjustment", "manual_writeoff") ?? "manual_writeoff"
            : "manual_writeoff";
          void performAction(r, "apply_adjustment", { adjustmentAmount: adj, adjustmentReason: reason });
        },
        disabled: actingId === r.id,
      },
      {
        id: "hold", label: r.onHold ? "Release hold" : "Hold client billing", variant: "danger",
        onClick: () => void performAction(r, r.onHold ? "release_hold" : "hold_billing"),
        disabled: actingId === r.id,
      },
    ];
  }, [selectedRow, actingId, performAction]);

  const primaryTabs = useMemo(
    () => PATIENT_RESPONSIBILITY_TABS.map((t) => ({ id: t.id, label: t.label, count: tabCounts[t.id] })),
    [tabCounts],
  );

  // Suppress unused warning for nowMs (we use it via filteredRows.ageDays).
  void nowMs;

  return (
    <WorkqueueShell<PatientResponsibilityRow>
      title={queueDef?.title ?? "Client Responsibility Generated"}
      description={queueDef?.description}
      headerActions={[
        { id: "refresh", label: "Refresh", onClick: () => void load() },
      ]}
      summary={summary}
      primaryTabs={primaryTabs}
      activePrimaryTabId={activeTab}
      onPrimaryTabChange={(id) => { setActiveTab(id as PatientResponsibilityTab); setSelectedRowId(null); }}
      filters={filters}
      filterValues={filterValues}
      onFilterChange={setFilterValues}
      filterUrlNamespace="pr"
      rows={filteredRows}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage={error ?? "No items in this tab."}
      selectedRowId={selectedRowId}
      onSelectRow={setSelectedRowId}
      rowActions={rowActions}
      detailTabs={detailTabs}
      detailActions={detailActions}
      message={error ? { tone: "error", text: error } : null}
      overlay={toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    />
  );
}
