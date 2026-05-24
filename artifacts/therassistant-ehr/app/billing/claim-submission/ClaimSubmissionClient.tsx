"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type RowAction,
  type SummaryMetric,
  type FilterDef,
  type DetailTab,
} from "@/components/billing/WorkqueueShell";
import { getWorkqueue } from "@/lib/billing/workqueues";

type DenialRow = {
  id: string;
  claimNumber: string;
  patientId: string;
  patientName: string;
  memberId: string;
  payerProfileId: string;
  payerId: string | null;
  payerName: string;
  payerFaxNumber: string | null;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  totalChargeAmount: number;
  outstandingBalance: number;
  denialReason: string;
  noteCount: number;
  deferUntil: string | null;
  deferredReason: string | null;
  updatedAt: string | null;
};

type AppealTemplate = { id: string; name: string; body: string; isSystem: boolean };

type DenialsPayload = {
  success: boolean;
  error?: string;
  rows?: DenialRow[];
  templates?: AppealTemplate[];
};

const WRITE_OFF_REASONS: { value: string; label: string }[] = [
  { value: "small_balance", label: "Small balance" },
  { value: "bad_debt", label: "Bad debt" },
  { value: "contractual", label: "Contractual" },
  { value: "timely_filing", label: "Timely filing" },
  { value: "no_authorization", label: "No authorization" },
  { value: "patient_deceased", label: "Patient deceased" },
  { value: "charity_care", label: "Charity care" },
  { value: "other", label: "Other" },
];

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
}

function dosLabel(row: DenialRow): string {
  if (!row.serviceDateFrom) return "—";
  if (row.serviceDateTo && row.serviceDateTo !== row.serviceDateFrom) {
    return `${formatDate(row.serviceDateFrom)} – ${formatDate(row.serviceDateTo)}`;
  }
  return formatDate(row.serviceDateFrom);
}

function ageDays(value: string | null): number | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000));
}

function applyPlaceholders(body: string, row: DenialRow) {
  return body
    .replaceAll("[Patient Name]", row.patientName || "")
    .replaceAll("[Claim Number]", row.claimNumber || "")
    .replaceAll("[DOS]", dosLabel(row))
    .replaceAll("[Member ID]", row.memberId || "")
    .replaceAll("[Payer Name]", row.payerName || "");
}

// ─── Toast ─────────────────────────────────────────────────────────────────────
function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed", bottom: 24, right: 24,
        background: "#111827", color: "#fff",
        padding: "10px 16px", borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        zIndex: 1100,
      }}
    >
      {message}
    </div>
  );
}

// ─── Modal shell ───────────────────────────────────────────────────────────────
function ModalShell({
  title, onClose, children, width = 560,
}: {
  title: string; onClose: () => void; children: React.ReactNode; width?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", width, maxWidth: "92vw", maxHeight: "88vh",
          overflow: "auto", borderRadius: 8, padding: 24,
          boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button
            type="button" onClick={onClose}
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" }}
          >×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function NoteModal({
  row, organizationId, onClose, onSaved,
}: {
  row: DenialRow; organizationId: string; onClose: () => void; onSaved: (claimId: string) => void;
}) {
  const [body, setBody] = useState("");
  const [deferUntil, setDeferUntil] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!body.trim()) { setError("Note body is required"); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/billing/claims/${row.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, body: body.trim(), deferUntil: deferUntil || null }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Failed to save note");
      onSaved(row.id); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save note");
    } finally { setSaving(false); }
  }

  return (
    <ModalShell title={`Add note — ${row.patientName}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claimNumber || row.id.slice(0, 8)} · {row.payerName || "Unknown payer"}
      </p>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Note</label>
      <textarea
        value={body} onChange={(e) => setBody(e.target.value)} rows={6}
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4, fontFamily: "inherit" }}
      />
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 4 }}>
        Defer until (optional)
      </label>
      <input
        type="date" value={deferUntil} onChange={(e) => setDeferUntil(e.target.value)}
        style={{ padding: 8, border: "1px solid #D1D5DB", borderRadius: 4 }}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save note"}
        </button>
      </div>
    </ModalShell>
  );
}

function AppealModal({
  row, organizationId, templates, onClose, onSaved, onToast,
}: {
  row: DenialRow; organizationId: string; templates: AppealTemplate[];
  onClose: () => void; onSaved: (claimId: string) => void; onToast: (msg: string) => void;
}) {
  const [templateId, setTemplateId] = useState<string>("");
  const [letter, setLetter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickTemplate(id: string) {
    setTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (tpl) setLetter(applyPlaceholders(tpl.body, row));
  }

  async function saveAsNote() {
    if (!letter.trim()) { setError("Letter is empty"); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/billing/claims/${row.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, body: `APPEAL DRAFT:\n\n${letter}` }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Failed to save appeal note");
      onSaved(row.id); onToast("Appeal draft saved as note"); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save appeal note");
    } finally { setBusy(false); }
  }

  async function faxToPayer() {
    if (!row.payerFaxNumber) return;
    if (!letter.trim()) { setError("Letter is empty"); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/billing/fax-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId, claimId: row.id, payerId: row.payerId,
          toFaxNumber: row.payerFaxNumber,
          subject: `Appeal: Claim ${row.claimNumber || row.id}`, body: letter,
        }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Failed to queue fax");
      onToast(`Fax queued — ${json.pendingCount ?? 0} pending faxes`); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to queue fax");
    } finally { setBusy(false); }
  }

  return (
    <ModalShell title={`File an appeal — ${row.patientName}`} onClose={onClose} width={680}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claimNumber || row.id.slice(0, 8)} · {row.payerName || "Unknown payer"}
        {row.payerFaxNumber ? ` · Fax: ${row.payerFaxNumber}` : ""}
      </p>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Template</label>
      <select
        value={templateId} onChange={(e) => pickTemplate(e.target.value)}
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4 }}
      >
        <option value="">— Choose a template —</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>{t.name}{t.isSystem ? " (system)" : ""}</option>
        ))}
      </select>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 4 }}>Appeal letter</label>
      <textarea
        value={letter} onChange={(e) => setLetter(e.target.value)} rows={14}
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4, fontFamily: "inherit" }}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16, flexWrap: "wrap" }}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="button" onClick={saveAsNote} disabled={busy}>
          {busy ? "Saving…" : "Save as appeal note"}
        </button>
        {row.payerFaxNumber ? (
          <button type="button" className="button" onClick={faxToPayer} disabled={busy}>
            {busy ? "Sending…" : "Fax to payer"}
          </button>
        ) : null}
      </div>
    </ModalShell>
  );
}

function WriteOffModal({
  row, organizationId, onClose, onSaved,
}: {
  row: DenialRow; organizationId: string; onClose: () => void; onSaved: (claimId: string) => void;
}) {
  const [reason, setReason] = useState<string>("small_balance");
  const [amount, setAmount] = useState<string>(String(row.totalChargeAmount.toFixed(2)));
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/billing/claims/${row.id}/write-off`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId, reason, amount: Number(amount), comment: comment.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Failed to write off claim");
      onSaved(row.id); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to write off claim");
    } finally { setBusy(false); }
  }

  return (
    <ModalShell title={`Write-off — ${row.patientName}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claimNumber || row.id.slice(0, 8)} · Total charge {formatCurrency(row.totalChargeAmount)}
      </p>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Reason</label>
      <select
        value={reason} onChange={(e) => setReason(e.target.value)}
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4 }}
      >
        {WRITE_OFF_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 4 }}>Amount</label>
      <input
        type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
        style={{ width: 160, padding: 8, border: "1px solid #D1D5DB", borderRadius: 4 }}
      />
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 4 }}>Comment (optional)</label>
      <textarea
        value={comment} onChange={(e) => setComment(e.target.value)} rows={4}
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4, fontFamily: "inherit" }}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Write off"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

const queueDef = getWorkqueue("denials");

export default function ClaimSubmissionClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<DenialRow[]>([]);
  const [templates, setTemplates] = useState<AppealTemplate[]>([]);
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const [noteRow, setNoteRow] = useState<DenialRow | null>(null);
  const [appealRow, setAppealRow] = useState<DenialRow | null>(null);
  const [writeOffRow, setWriteOffRow] = useState<DenialRow | null>(null);
  const [billingRowId, setBillingRowId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/denials?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as DenialsPayload;
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load denials");
      setRows(json.rows ?? []);
      setTemplates(json.templates ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load denials");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  function removeRow(claimId: string) {
    setRows((prev) => prev.filter((r) => r.id !== claimId));
    if (selectedRowId === claimId) setSelectedRowId(null);
  }

  function bumpNoteCount(claimId: string) {
    setRows((prev) => prev.map((r) => (r.id === claimId ? { ...r, noteCount: r.noteCount + 1 } : r)));
  }

  async function billToPatient(row: DenialRow) {
    setBillingRowId(row.id);
    try {
      const res = await fetch("/api/patient-invoices/from-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, claimId: row.id }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Failed to create invoice");
      setToast(`Invoice sent to ${json.patientName ?? row.patientName}`);
      removeRow(row.id);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to create invoice");
    } finally {
      setBillingRowId(null);
    }
  }

  // ── Universal filter wiring ─────────────────────────────────────────────
  const payerOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const r of rows) if (r.payerName) set.set(r.payerName, r.payerName);
    return Array.from(set.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "client", label: "Client", kind: "text", placeholder: "Patient name…" },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Aging",
        kind: "select",
        options: [
          { value: "0-30", label: "0-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "61-90", label: "61-90 days" },
          { value: "90+", label: "90+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 197" },
    ],
    [payerOptions],
  );

  const filteredRows = useMemo(() => {
    let out = rows;
    const v = filterValues;
    if (v.client) {
      const q = v.client.toLowerCase();
      out = out.filter((r) => r.patientName.toLowerCase().includes(q));
    }
    if (v.payer) out = out.filter((r) => r.payerName === v.payer);
    if (v.dosFrom) out = out.filter((r) => (r.serviceDateFrom ?? "") >= v.dosFrom);
    if (v.dosTo) out = out.filter((r) => (r.serviceDateFrom ?? "") <= v.dosTo);
    if (v.minAmount) {
      const min = Number(v.minAmount);
      if (!Number.isNaN(min)) out = out.filter((r) => r.outstandingBalance >= min);
    }
    if (v.agingBucket) {
      out = out.filter((r) => {
        const a = ageDays(r.updatedAt);
        if (a == null) return false;
        switch (v.agingBucket) {
          case "0-30": return a <= 30;
          case "31-60": return a > 30 && a <= 60;
          case "61-90": return a > 60 && a <= 90;
          case "90+": return a > 90;
          default: return true;
        }
      });
    }
    if (v.carcRarc) {
      const q = v.carcRarc.toLowerCase();
      out = out.filter((r) => (r.denialReason ?? "").toLowerCase().includes(q));
    }
    return out;
  }, [rows, filterValues]);

  const summary: SummaryMetric[] = useMemo(() => {
    const total = filteredRows.length;
    const dollars = filteredRows.reduce((s, r) => s + (r.outstandingBalance || 0), 0);
    const ages = filteredRows
      .map((r) => ageDays(r.updatedAt))
      .filter((n): n is number => n != null);
    const oldest = ages.length > 0 ? Math.max(...ages) : 0;
    const urgent = filteredRows.filter((r) => {
      const a = ageDays(r.updatedAt);
      return a != null && a > 60;
    }).length;
    return [
      { id: "count", label: "Open denials", value: total.toLocaleString() },
      { id: "dollars", label: "Total outstanding", value: formatCurrency(dollars), tone: dollars > 0 ? "amber" : "default" },
      { id: "oldest", label: "Oldest (days)", value: oldest, tone: oldest > 60 ? "red" : oldest > 30 ? "amber" : "default" },
      { id: "urgent", label: "Urgent (>60d)", value: urgent, tone: urgent > 0 ? "red" : "default" },
    ];
  }, [filteredRows]);

  const columns: ColumnDef<DenialRow>[] = useMemo(
    () => [
      {
        id: "claim",
        header: "Claim #",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            {r.claimNumber || r.id.slice(0, 8)}
          </span>
        ),
      },
      { id: "patient", header: "Patient", cell: (r) => r.patientName },
      {
        id: "payer",
        header: "Payer",
        cell: (r) => (
          <>
            {r.payerName || "—"}
            {r.payerFaxNumber ? (
              <div style={{ fontSize: 11, color: "#6B7280" }}>Fax: {r.payerFaxNumber}</div>
            ) : null}
          </>
        ),
      },
      { id: "dos", header: "DOS", cell: (r) => dosLabel(r) },
      {
        id: "charge", header: "Charge", align: "right",
        cell: (r) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatCurrency(r.totalChargeAmount)}</span>,
      },
      {
        id: "outstanding", header: "Outstanding", align: "right",
        cell: (r) => <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{formatCurrency(r.outstandingBalance)}</span>,
      },
      {
        id: "reason", header: "Denial reason",
        cell: (r) => (
          <span style={{ color: r.denialReason ? "#111827" : "#9CA3AF" }}>{r.denialReason || "—"}</span>
        ),
      },
      { id: "notes", header: "Notes", align: "center", cell: (r) => r.noteCount },
    ],
    [],
  );

  const rowActions: RowAction<DenialRow>[] = useMemo(
    () => [
      { id: "note", label: "Note", onClick: (r) => setNoteRow(r) },
      { id: "appeal", label: "Appeal", variant: "primary", onClick: (r) => setAppealRow(r) },
      { id: "writeoff", label: "Write-off", onClick: (r) => setWriteOffRow(r) },
      {
        id: "bill",
        label: "Bill to Patient",
        onClick: (r) => void billToPatient(r),
        disabled: (r) => billingRowId === r.id,
      },
    ],
    [billingRowId],
  );

  const selectedRow = useMemo(
    () => filteredRows.find((r) => r.id === selectedRowId) ?? null,
    [filteredRows, selectedRowId],
  );

  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "client",
        label: "Client",
        render: () =>
          selectedRow ? (
            <div>
              <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>{selectedRow.patientName}</h3>
              <div style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
                Member ID: {selectedRow.memberId || "—"}
              </div>
              <DetailKV label="Payer" value={selectedRow.payerName || "—"} />
              <DetailKV label="Payer fax" value={selectedRow.payerFaxNumber || "—"} />
              <DetailKV label="Service date" value={dosLabel(selectedRow)} />
              <DetailKV label="Total charge" value={formatCurrency(selectedRow.totalChargeAmount)} />
              <DetailKV label="Outstanding" value={formatCurrency(selectedRow.outstandingBalance)} />
            </div>
          ) : null,
      },
      {
        id: "claim",
        label: "Claim",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Claim #" value={selectedRow.claimNumber || selectedRow.id.slice(0, 8)} />
              <DetailKV label="Denial reason" value={selectedRow.denialReason || "—"} />
              <DetailKV label="Notes" value={String(selectedRow.noteCount)} />
              <DetailKV label="Defer until" value={selectedRow.deferUntil || "—"} />
              <DetailKV label="Deferred reason" value={selectedRow.deferredReason || "—"} />
              <DetailKV label="Last updated" value={selectedRow.updatedAt ? formatDate(selectedRow.updatedAt) : "—"} />
            </div>
          ) : null,
      },
      {
        id: "timeline",
        label: "Timeline",
        render: () => (
          <div style={{ color: "#94A3B8", fontSize: 13 }}>
            Timeline view coming soon. Use the Note button to log activity.
          </div>
        ),
      },
    ],
    [selectedRow],
  );

  const detailActions = selectedRow
    ? [
        { id: "note", label: "Add note", onClick: () => setNoteRow(selectedRow) },
        { id: "appeal", label: "File appeal", variant: "primary" as const, onClick: () => setAppealRow(selectedRow) },
        { id: "writeoff", label: "Write-off", onClick: () => setWriteOffRow(selectedRow) },
        {
          id: "bill",
          label: billingRowId === selectedRow.id ? "Billing…" : "Bill to Patient",
          onClick: () => void billToPatient(selectedRow),
          disabled: billingRowId === selectedRow.id,
        },
      ]
    : [];

  const message = !organizationId
    ? { tone: "error" as const, text: "Missing organizationId. Add ?organizationId=… to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID." }
    : error
    ? { tone: "error" as const, text: error }
    : null;

  return (
    <>
      <WorkqueueShell<DenialRow>
        title={queueDef?.title ?? "Denials"}
        description={queueDef?.description}
        headerActions={[
          { id: "refresh", label: loading ? "Loading…" : "Refresh", onClick: () => void load(), disabled: loading },
        ]}
        summary={summary}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace="denials"
        rows={filteredRows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No denied claims."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {noteRow ? (
        <NoteModal row={noteRow} organizationId={organizationId} onClose={() => setNoteRow(null)} onSaved={(id) => bumpNoteCount(id)} />
      ) : null}
      {appealRow ? (
        <AppealModal row={appealRow} organizationId={organizationId} templates={templates}
          onClose={() => setAppealRow(null)} onSaved={(id) => bumpNoteCount(id)} onToast={(msg) => setToast(msg)} />
      ) : null}
      {writeOffRow ? (
        <WriteOffModal row={writeOffRow} organizationId={organizationId}
          onClose={() => setWriteOffRow(null)} onSaved={(id) => removeRow(id)} />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}

function DetailKV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", gap: 12,
      fontSize: 13, padding: "5px 0", borderBottom: "1px solid #F1F5F9",
    }}>
      <span style={{ color: "#64748B", fontWeight: 500 }}>{label}</span>
      <span style={{ color: "#0F172A", textAlign: "right", maxWidth: "60%" }}>{value}</span>
    </div>
  );
}
