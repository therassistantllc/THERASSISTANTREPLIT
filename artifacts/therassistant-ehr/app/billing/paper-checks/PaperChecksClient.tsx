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

// ─── Types ───────────────────────────────────────────────────────────────────

type Tab = "new" | "deposited" | "posted" | "unmatched" | "returned";

type MatchedClaim = {
  claim_id: string;
  claim_number: string | null;
  patient_name: string | null;
  claim_status: string | null;
  total_charge: number;
  applied_amount: number;
};

type Row = {
  id: string;
  payer_profile_id: string | null;
  payer_name: string | null;
  payer_id_external: string | null;
  check_number: string | null;
  check_date: string | null;
  amount: number;
  received_date: string | null;
  deposit_date: string | null;
  posting_status: string;
  scanned_check_url: string | null;
  paper_eob_url: string | null;
  deposit_notes: string | null;
  assigned_to_user_id: string | null;
  assigned_to_display_name: string | null;
  priority: string | null;
  follow_up_due_date: string | null;
  age_days: number | null;
  aging_bucket: string;
  matched_claims: MatchedClaim[];
  matched_total: number;
  created_at: string | null;
  updated_at: string | null;
};

type PayerOpt = { id: string; name: string };
type AssigneeOpt = { id: string; displayName: string };

type EventRow = {
  id: string;
  event_type: string;
  message: string | null;
  payload: Record<string, unknown> | null;
  actor_display_name: string | null;
  created_at: string;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "new", label: "New Checks" },
  { id: "deposited", label: "Deposited" },
  { id: "posted", label: "Posted" },
  { id: "unmatched", label: "Unmatched" },
  { id: "returned", label: "Returned/Void" },
];

const queueDef = getWorkqueue("paper_checks");

// ─── Utils ───────────────────────────────────────────────────────────────────

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

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0);
}

// ─── Toast / modal shells ───────────────────────────────────────────────────

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        background: "#111827",
        color: "#fff",
        padding: "10px 16px",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        zIndex: 1100,
      }}
    >
      {message}
    </div>
  );
}

const fieldLabel: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
};
const fieldInput: React.CSSProperties = {
  width: "100%",
  padding: 8,
  border: "1px solid #D1D5DB",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 13,
};
const buttonRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  marginTop: 16,
};

function ModalShell({
  title,
  onClose,
  children,
  width = 480,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          width,
          maxWidth: "92vw",
          maxHeight: "88vh",
          overflow: "auto",
          borderRadius: 8,
          padding: 24,
          boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              fontSize: 20,
              cursor: "pointer",
              color: "#6B7280",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DetailKV({ label, value }: { label: string; value: React.ReactNode }) {
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
      <span
        style={{
          color: "#0F172A",
          textAlign: "right",
          maxWidth: "60%",
          wordBreak: "break-word",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    new: { bg: "#E0F2FE", fg: "#075985", label: "New" },
    deposited: { bg: "#FEF3C7", fg: "#92400E", label: "Deposited" },
    posted: { bg: "#D1FAE5", fg: "#065F46", label: "Posted" },
    unmatched: { bg: "#FEE2E2", fg: "#991B1B", label: "Unmatched" },
    returned: { bg: "#F3E8FF", fg: "#6B21A8", label: "Returned" },
    void: { bg: "#E5E7EB", fg: "#374151", label: "Void" },
  };
  const m = map[status] ?? { bg: "#F1F5F9", fg: "#475569", label: status };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: m.bg,
        color: m.fg,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {m.label}
    </span>
  );
}

// ─── Modals ─────────────────────────────────────────────────────────────────

function AddCheckModal({
  organizationId,
  payers,
  onClose,
  onSaved,
}: {
  organizationId: string;
  payers: PayerOpt[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [payerId, setPayerId] = useState("");
  const [payerName, setPayerName] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [checkDate, setCheckDate] = useState("");
  const [amount, setAmount] = useState("");
  const [receivedDate, setReceivedDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!checkNumber.trim()) {
      setError("Check number is required");
      return;
    }
    if (!amount || Number(amount) <= 0) {
      setError("Amount must be greater than zero");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/billing/paper-checks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        payer_profile_id: payerId || null,
        payer_name: payerName || null,
        check_number: checkNumber.trim(),
        check_date: checkDate || null,
        amount: Number(amount),
        received_date: receivedDate,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Failed to create check");
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <ModalShell title="Add paper check" onClose={onClose}>
      <label style={fieldLabel}>Payer</label>
      <select
        value={payerId}
        onChange={(e) => setPayerId(e.target.value)}
        style={fieldInput}
      >
        <option value="">— Select payer —</option>
        {payers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {!payerId ? (
        <div style={{ marginTop: 8 }}>
          <label style={fieldLabel}>Or payer name (free text)</label>
          <input
            type="text"
            value={payerName}
            onChange={(e) => setPayerName(e.target.value)}
            style={fieldInput}
          />
        </div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
        <div>
          <label style={fieldLabel}>Check number *</label>
          <input
            type="text"
            value={checkNumber}
            onChange={(e) => setCheckNumber(e.target.value)}
            style={fieldInput}
          />
        </div>
        <div>
          <label style={fieldLabel}>Amount *</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={fieldInput}
          />
        </div>
        <div>
          <label style={fieldLabel}>Check date</label>
          <input
            type="date"
            value={checkDate}
            onChange={(e) => setCheckDate(e.target.value)}
            style={fieldInput}
          />
        </div>
        <div>
          <label style={fieldLabel}>Received date *</label>
          <input
            type="date"
            value={receivedDate}
            onChange={(e) => setReceivedDate(e.target.value)}
            style={fieldInput}
          />
        </div>
      </div>
      {error ? (
        <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div>
      ) : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Create"}
        </button>
      </div>
    </ModalShell>
  );
}

function UploadEobModal({
  row,
  organizationId,
  onClose,
  onSaved,
}: {
  row: Row;
  organizationId: string;
  onClose: () => void;
  onSaved: (patch: Partial<Row>) => void;
}) {
  const [eobUrl, setEobUrl] = useState(row.paper_eob_url ?? "");
  const [scanUrl, setScanUrl] = useState(row.scanned_check_url ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (!eobUrl.trim() && !scanUrl.trim()) {
      setError("Provide a paper EOB or scanned check URL");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/billing/paper-checks/${row.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        action: "upload_eob",
        paper_eob_url: eobUrl.trim() || undefined,
        scanned_check_url: scanUrl.trim() || undefined,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Upload failed");
      return;
    }
    onSaved({
      paper_eob_url: eobUrl.trim() || row.paper_eob_url,
      scanned_check_url: scanUrl.trim() || row.scanned_check_url,
    });
    onClose();
  }
  return (
    <ModalShell title={`Upload EOB — Check #${row.check_number ?? row.id.slice(0, 8)}`} onClose={onClose}>
      <p style={{ color: "#64748B", fontSize: 13, margin: "0 0 12px" }}>
        Paste a URL to the scanned EOB or check image (object-storage upload coming soon).
      </p>
      <label style={fieldLabel}>Paper EOB URL</label>
      <input type="url" value={eobUrl} onChange={(e) => setEobUrl(e.target.value)} style={fieldInput} />
      <div style={{ marginTop: 8 }}>
        <label style={fieldLabel}>Scanned check URL</label>
        <input type="url" value={scanUrl} onChange={(e) => setScanUrl(e.target.value)} style={fieldInput} />
      </div>
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function MarkDepositedModal({
  row,
  organizationId,
  onClose,
  onSaved,
}: {
  row: Row;
  organizationId: string;
  onClose: () => void;
  onSaved: (patch: Partial<Row>) => void;
}) {
  const [depositDate, setDepositDate] = useState(
    () => row.deposit_date ?? new Date().toISOString().slice(0, 10),
  );
  const [notes, setNotes] = useState(row.deposit_notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/billing/paper-checks/${row.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        action: "mark_deposited",
        deposit_date: depositDate,
        deposit_notes: notes.trim() || undefined,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Action failed");
      return;
    }
    onSaved({
      deposit_date: depositDate,
      deposit_notes: notes.trim() || row.deposit_notes,
      posting_status: row.posting_status === "posted" ? "posted" : "deposited",
    });
    onClose();
  }
  return (
    <ModalShell title={`Mark deposited — Check #${row.check_number ?? row.id.slice(0, 8)}`} onClose={onClose}>
      <label style={fieldLabel}>Deposit date</label>
      <input
        type="date"
        value={depositDate}
        onChange={(e) => setDepositDate(e.target.value)}
        style={{ ...fieldInput, maxWidth: 220 }}
      />
      <div style={{ marginTop: 10 }}>
        <label style={fieldLabel}>Deposit notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} style={fieldInput} />
      </div>
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Mark deposited"}
        </button>
      </div>
    </ModalShell>
  );
}

function MatchClaimsModal({
  row,
  organizationId,
  onClose,
  onSaved,
}: {
  row: Row;
  organizationId: string;
  onClose: () => void;
  onSaved: (patch: Partial<Row>, matches: MatchedClaim[]) => void;
}) {
  const [entries, setEntries] = useState<Array<{ claim_id: string; amount: string }>>([
    { claim_id: "", amount: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(idx: number, patch: Partial<{ claim_id: string; amount: string }>) {
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  }
  function addRow() {
    setEntries((prev) => [...prev, { claim_id: "", amount: "" }]);
  }
  function removeRow(idx: number) {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
  }

  async function save() {
    const clean = entries
      .map((e) => ({ claim_id: e.claim_id.trim(), amount: Number(e.amount || "0") }))
      .filter((e) => e.claim_id);
    if (clean.length === 0) {
      setError("Add at least one claim id");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/billing/paper-checks/${row.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        action: "match_claims",
        claim_ids: clean.map((c) => c.claim_id),
        applied_amounts: clean.map((c) => c.amount),
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Match failed");
      return;
    }
    const newMatches: MatchedClaim[] = (json?.matches ?? []).map((m: any) => {
      const existing = row.matched_claims.find((x) => x.claim_id === m.claim_id);
      return {
        claim_id: m.claim_id,
        claim_number: existing?.claim_number ?? null,
        patient_name: existing?.patient_name ?? null,
        claim_status: existing?.claim_status ?? null,
        total_charge: existing?.total_charge ?? 0,
        applied_amount: Number(m.applied_amount) || 0,
      };
    });
    onSaved(
      {
        posting_status: json?.check?.posting_status ?? row.posting_status,
      },
      newMatches,
    );
    onClose();
  }

  return (
    <ModalShell title={`Match claims — Check #${row.check_number ?? row.id.slice(0, 8)}`} onClose={onClose} width={560}>
      <p style={{ color: "#64748B", fontSize: 13, margin: "0 0 12px" }}>
        Paste the claim id (UUID) and the dollar amount being applied from this check.
        Check total: {formatCurrency(row.amount)}.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {entries.map((e, idx) => (
          <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 140px auto", gap: 8 }}>
            <input
              type="text"
              value={e.claim_id}
              placeholder="claim uuid"
              onChange={(ev) => update(idx, { claim_id: ev.target.value })}
              style={{ ...fieldInput, fontFamily: "ui-monospace, monospace", fontSize: 12 }}
            />
            <input
              type="number"
              step="0.01"
              min="0"
              value={e.amount}
              placeholder="amount"
              onChange={(ev) => update(idx, { amount: ev.target.value })}
              style={fieldInput}
            />
            <button
              type="button"
              onClick={() => removeRow(idx)}
              disabled={entries.length === 1}
              style={{
                background: "transparent",
                border: "1px solid #D1D5DB",
                borderRadius: 4,
                padding: "0 10px",
                cursor: entries.length === 1 ? "not-allowed" : "pointer",
                color: "#6B7280",
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addRow}
        style={{
          marginTop: 8,
          background: "transparent",
          border: "1px dashed #94A3B8",
          padding: "6px 10px",
          borderRadius: 4,
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        + Add claim
      </button>
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Match"}
        </button>
      </div>
    </ModalShell>
  );
}

function ResolveMismatchModal({
  row,
  organizationId,
  onClose,
  onSaved,
}: {
  row: Row;
  organizationId: string;
  onClose: () => void;
  onSaved: (patch: Partial<Row>) => void;
}) {
  const [resolution, setResolution] = useState<"unmatched" | "returned" | "void">("returned");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/billing/paper-checks/${row.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        action: "resolve_mismatch",
        resolution,
        note: note.trim() || undefined,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Action failed");
      return;
    }
    onSaved({ posting_status: resolution });
    onClose();
  }
  return (
    <ModalShell title={`Resolve mismatch — Check #${row.check_number ?? row.id.slice(0, 8)}`} onClose={onClose}>
      <label style={fieldLabel}>Resolution</label>
      <select
        value={resolution}
        onChange={(e) => setResolution(e.target.value as "unmatched" | "returned" | "void")}
        style={fieldInput}
      >
        <option value="unmatched">Mark unmatched (keep open)</option>
        <option value="returned">Returned to payer</option>
        <option value="void">Void</option>
      </select>
      <div style={{ marginTop: 10 }}>
        <label style={fieldLabel}>Note</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} style={fieldInput} />
      </div>
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Detail panel: events ──────────────────────────────────────────────────

function DepositEventsPanel({
  checkId,
  organizationId,
  bumpKey,
}: {
  checkId: string;
  organizationId: string;
  bumpKey: number;
}) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    fetch(
      `/api/billing/paper-checks/${checkId}/events?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) setError(j.error || "Failed");
        else setEvents((j?.events ?? []) as EventRow[]);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      });
    return () => {
      cancelled = true;
    };
  }, [checkId, organizationId, bumpKey]);
  if (error) return <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>;
  if (events == null) return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>;
  if (events.length === 0)
    return <div style={{ color: "#94A3B8", fontSize: 13 }}>No deposit events yet.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {events.map((e) => (
        <div
          key={e.id}
          style={{
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            padding: 10,
            background: "#F9FAFB",
          }}
        >
          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
            {formatDateTime(e.created_at)}
            {e.actor_display_name ? ` · ${e.actor_display_name}` : ""}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {e.event_type.replace(/_/g, " ")}
          </div>
          {e.message ? (
            <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>{e.message}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function PaperChecksClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<Tab, number>>({
    new: 0,
    deposited: 0,
    posted: 0,
    unmatched: 0,
    returned: 0,
  });
  const [serverSummary, setServerSummary] = useState<{
    total_count: number;
    total_dollars: number;
    oldest_age_days: number;
    urgent_count: number;
  }>({ total_count: 0, total_dollars: 0, oldest_age_days: 0, urgent_count: 0 });
  const [payers, setPayers] = useState<PayerOpt[]>([]);
  const [assignees, setAssignees] = useState<AssigneeOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [bumpKey, setBumpKey] = useState(0);

  const [activeTab, setActiveTab] = useState<Tab>("new");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  // Modal state
  const [showAdd, setShowAdd] = useState(false);
  const [uploadRow, setUploadRow] = useState<Row | null>(null);
  const [depositRow, setDepositRow] = useState<Row | null>(null);
  const [matchRow, setMatchRow] = useState<Row | null>(null);
  const [resolveRow, setResolveRow] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, tab: activeTab });
      for (const [k, v] of Object.entries(filterValues)) if (v) params.set(k, v);
      const res = await fetch(`/api/billing/paper-checks?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error || "Failed to load");
      setRows((json.items ?? []) as Row[]);
      setTabCounts(json.tabCounts ?? {});
      setServerSummary(json.summary ?? serverSummary);
      setPayers((json.payers ?? []) as PayerOpt[]);
      setAssignees((json.assignees ?? []) as AssigneeOpt[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, activeTab, filterValues]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchRow = useCallback(
    (id: string, patch: Partial<Row>, matches?: MatchedClaim[]) => {
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          const next: Row = { ...r, ...patch };
          if (matches) {
            // Merge new matches over existing (dedupe by claim_id).
            const map = new Map<string, MatchedClaim>();
            for (const m of r.matched_claims) map.set(m.claim_id, m);
            for (const m of matches) map.set(m.claim_id, m);
            next.matched_claims = [...map.values()];
            next.matched_total = next.matched_claims.reduce(
              (s, m) => s + m.applied_amount,
              0,
            );
          }
          return next;
        }),
      );
    },
    [],
  );

  // ── Filters ───────────────────────────────────────────────────────────────
  // Full universal rail. practice / clinician / carcRarc are wired
  // server-side against the check's matched-claim metadata (service facility
  // name, rendering provider NPI/name, denial reason code).
  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "text", placeholder: "Facility name…" },
      {
        id: "clinician",
        label: "Clinician",
        kind: "text",
        placeholder: "Provider NPI or name…",
      },
      {
        id: "payer",
        label: "Payer",
        kind: "select",
        options: payers.map((p) => ({ value: p.id, label: p.name })),
      },
      { id: "client", label: "Client", kind: "text", placeholder: "Patient name…" },
      { id: "dosFrom", label: "Check date from", kind: "date" },
      { id: "dosTo", label: "Check date to", kind: "date" },
      {
        id: "status",
        label: "Posting status",
        kind: "select",
        options: [
          { value: "new", label: "New" },
          { value: "deposited", label: "Deposited" },
          { value: "posted", label: "Posted" },
          { value: "unmatched", label: "Unmatched" },
          { value: "returned", label: "Returned" },
          { value: "void", label: "Void" },
        ],
      },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "select",
        options: [
          { value: "__unassigned__", label: "Unassigned" },
          ...assignees.map((a) => ({ value: a.id, label: a.displayName })),
        ],
      },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0", width: 90 },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0", width: 90 },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. CO-50" },
      {
        id: "agingBucket",
        label: "Age bucket",
        kind: "select",
        options: [
          { value: "0-30", label: "0–30 days" },
          { value: "31-60", label: "31–60 days" },
          { value: "61-90", label: "61–90 days" },
          { value: "91-120", label: "91–120 days" },
          { value: "120+", label: "120+ days" },
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
      {
        id: "followUpDue",
        label: "Follow-up due",
        kind: "select",
        options: [
          { value: "overdue", label: "Overdue" },
          { value: "today", label: "Today" },
          { value: "week", label: "This week" },
        ],
      },
    ],
    [payers, assignees],
  );

  // ── Columns (spec-exact) ─────────────────────────────────────────────────
  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      {
        id: "payer",
        header: "Payer",
        cell: (r) => r.payer_name ?? <span style={{ color: "#94A3B8" }}>—</span>,
      },
      {
        id: "check_number",
        header: "Check number",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.check_number ?? "—"}
          </span>
        ),
      },
      { id: "check_date", header: "Check date", cell: (r) => formatDate(r.check_date) },
      {
        id: "amount",
        header: "Amount",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {formatCurrency(r.amount)}
          </span>
        ),
      },
      { id: "received_date", header: "Received date", cell: (r) => formatDate(r.received_date) },
      { id: "deposit_date", header: "Deposit date", cell: (r) => formatDate(r.deposit_date) },
      {
        id: "eob_attached",
        header: "ERA/EOB attached",
        cell: (r) =>
          r.paper_eob_url || r.scanned_check_url ? (
            <span style={{ color: "#065F46", fontWeight: 600 }}>Yes</span>
          ) : (
            <span style={{ color: "#94A3B8" }}>No</span>
          ),
      },
      {
        id: "posting_status",
        header: "Posting status",
        cell: (r) => <StatusBadge status={r.posting_status} />,
      },
    ],
    [],
  );

  // ── Summary metrics (use server-computed values) ────────────────────────
  const summary: SummaryMetric[] = useMemo(
    () => [
      { id: "count", label: "Total count", value: serverSummary.total_count.toLocaleString() },
      {
        id: "dollars",
        label: "Total $",
        value: formatCurrency(serverSummary.total_dollars),
        tone: serverSummary.total_dollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest",
        label: "Oldest claim age (days)",
        value: serverSummary.oldest_age_days,
        tone:
          serverSummary.oldest_age_days > 30
            ? "red"
            : serverSummary.oldest_age_days > 14
              ? "amber"
              : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: serverSummary.urgent_count,
        tone: serverSummary.urgent_count > 0 ? "red" : "default",
      },
    ],
    [serverSummary],
  );

  // ── Actions ──────────────────────────────────────────────────────────────
  const postPayment = useCallback(
    async (r: Row) => {
      const res = await fetch(`/api/billing/paper-checks/${r.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, action: "post_payment" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        setToast(json?.error || "Post payment failed");
        return;
      }
      patchRow(r.id, { posting_status: "posted" });
      setBumpKey((k) => k + 1);
      setToast(`Posted check #${r.check_number ?? r.id.slice(0, 8)}`);
      // Refetch so the row moves between tabs and counts/summary reconcile.
      void load();
    },
    [organizationId, patchRow, load],
  );

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      { id: "upload_eob", label: "Upload EOB", onClick: (r) => setUploadRow(r) },
      { id: "match", label: "Match claims", onClick: (r) => setMatchRow(r) },
      { id: "deposit", label: "Mark deposited", onClick: (r) => setDepositRow(r) },
      {
        id: "post",
        label: "Post payment",
        variant: "success",
        onClick: (r) => void postPayment(r),
        disabled: (r) => r.posting_status === "posted" || r.matched_claims.length === 0,
      },
      { id: "resolve", label: "Resolve mismatch", variant: "danger", onClick: (r) => setResolveRow(r) },
    ],
    [postPayment],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  // ── Detail panel (spec-exact section labels) ─────────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "scanned_check",
        label: "Scanned check",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Check #" value={selectedRow.check_number ?? "—"} />
              <DetailKV label="Check date" value={formatDate(selectedRow.check_date)} />
              <DetailKV label="Amount" value={formatCurrency(selectedRow.amount)} />
              <DetailKV label="Payer" value={selectedRow.payer_name ?? "—"} />
              <DetailKV label="Received" value={formatDate(selectedRow.received_date)} />
              <div style={{ marginTop: 12 }}>
                {selectedRow.scanned_check_url ? (
                  <a
                    href={selectedRow.scanned_check_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 13, color: "#2563EB", textDecoration: "underline" }}
                  >
                    Open scanned check ↗
                  </a>
                ) : (
                  <div style={{ color: "#94A3B8", fontSize: 13 }}>
                    No scanned check uploaded yet. Use “Upload EOB”.
                  </div>
                )}
              </div>
            </div>
          ) : null,
      },
      {
        id: "paper_eob",
        label: "Paper EOB",
        render: () =>
          selectedRow ? (
            <div>
              {selectedRow.paper_eob_url ? (
                <a
                  href={selectedRow.paper_eob_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 13, color: "#2563EB", textDecoration: "underline" }}
                >
                  Open paper EOB ↗
                </a>
              ) : (
                <div style={{ color: "#94A3B8", fontSize: 13 }}>
                  No paper EOB uploaded yet. Use “Upload EOB”.
                </div>
              )}
            </div>
          ) : null,
      },
      {
        id: "matched_claims",
        label: "Matched claims",
        render: () =>
          selectedRow ? (
            selectedRow.matched_claims.length === 0 ? (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>
                No claims matched yet. Use “Match claims”.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 12, color: "#475569" }}>
                  Applied total {formatCurrency(selectedRow.matched_total)} of{" "}
                  {formatCurrency(selectedRow.amount)}
                </div>
                {selectedRow.matched_claims.map((m) => (
                  <div
                    key={m.claim_id}
                    style={{
                      border: "1px solid #E5E7EB",
                      borderRadius: 6,
                      padding: 10,
                      background: "#F9FAFB",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {m.patient_name ?? "Unknown patient"}
                    </div>
                    <div style={{ fontSize: 12, color: "#6B7280" }}>
                      Claim {m.claim_number ?? m.claim_id.slice(0, 8)} · {m.claim_status ?? "—"}
                    </div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>
                      Applied {formatCurrency(m.applied_amount)} / charge{" "}
                      {formatCurrency(m.total_charge)}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : null,
      },
      {
        id: "deposit_notes",
        label: "Deposit notes",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Deposit date" value={formatDate(selectedRow.deposit_date)} />
              <DetailKV label="Status" value={<StatusBadge status={selectedRow.posting_status} />} />
              {selectedRow.deposit_notes ? (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 13,
                    whiteSpace: "pre-wrap",
                    background: "#F9FAFB",
                    padding: 10,
                    borderRadius: 6,
                    border: "1px solid #E5E7EB",
                  }}
                >
                  {selectedRow.deposit_notes}
                </div>
              ) : (
                <div style={{ marginTop: 10, color: "#94A3B8", fontSize: 13 }}>
                  No deposit notes yet.
                </div>
              )}
              <h4 style={{ fontSize: 13, margin: "16px 0 6px" }}>Timeline</h4>
              <DepositEventsPanel
                checkId={selectedRow.id}
                organizationId={organizationId}
                bumpKey={bumpKey}
              />
            </div>
          ) : null,
      },
    ],
    [selectedRow, organizationId, bumpKey],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const r = selectedRow;
    return [
      { id: "upload", label: "Upload EOB", onClick: () => setUploadRow(r) },
      { id: "match", label: "Match claims", onClick: () => setMatchRow(r) },
      { id: "deposit", label: "Mark deposited", onClick: () => setDepositRow(r) },
      {
        id: "post",
        label: "Post payment",
        variant: "success",
        onClick: () => void postPayment(r),
        disabled: r.posting_status === "posted" || r.matched_claims.length === 0,
      },
      {
        id: "resolve",
        label: "Resolve mismatch",
        variant: "danger",
        onClick: () => setResolveRow(r),
      },
    ];
  }, [selectedRow, postPayment]);

  const primaryTabs = TABS.map((t) => ({
    id: t.id,
    label: t.label,
    count: tabCounts[t.id] ?? 0,
  }));

  const message = error ? { tone: "error" as const, text: error } : null;

  return (
    <>
      <WorkqueueShell<Row>
        title={queueDef?.title ?? "Paper Checks"}
        description={queueDef?.description}
        headerActions={[
          {
            id: "add",
            label: "Add check",
            variant: "primary",
            onClick: () => setShowAdd(true),
          },
          {
            id: "refresh",
            label: loading ? "Loading…" : "Refresh",
            onClick: () => void load(),
            disabled: loading,
          },
        ]}
        summary={summary}
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTab}
        onPrimaryTabChange={(id) => {
          setActiveTab(id as Tab);
          setSelectedRowId(null);
        }}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`pc_${activeTab}`}
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No paper checks in this bucket."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {showAdd ? (
        <AddCheckModal
          organizationId={organizationId}
          payers={payers}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setToast("Check recorded");
            void load();
          }}
        />
      ) : null}
      {uploadRow ? (
        <UploadEobModal
          row={uploadRow}
          organizationId={organizationId}
          onClose={() => setUploadRow(null)}
          onSaved={(patch) => {
            patchRow(uploadRow.id, patch);
            setBumpKey((k) => k + 1);
            setToast("EOB uploaded");
            // Refetch so the "ERA/EOB attached" column / summary reconcile.
            void load();
          }}
        />
      ) : null}
      {depositRow ? (
        <MarkDepositedModal
          row={depositRow}
          organizationId={organizationId}
          onClose={() => setDepositRow(null)}
          onSaved={(patch) => {
            patchRow(depositRow.id, patch);
            setBumpKey((k) => k + 1);
            setToast("Marked deposited");
            // Refetch — row may move from New → Deposited tab.
            void load();
          }}
        />
      ) : null}
      {matchRow ? (
        <MatchClaimsModal
          row={matchRow}
          organizationId={organizationId}
          onClose={() => setMatchRow(null)}
          onSaved={(patch, matches) => {
            patchRow(matchRow.id, patch, matches);
            setBumpKey((k) => k + 1);
            setToast("Claims matched");
            // Refetch — row may leave Unmatched tab and gain claim metadata.
            void load();
          }}
        />
      ) : null}
      {resolveRow ? (
        <ResolveMismatchModal
          row={resolveRow}
          organizationId={organizationId}
          onClose={() => setResolveRow(null)}
          onSaved={(patch) => {
            patchRow(resolveRow.id, patch);
            setBumpKey((k) => k + 1);
            setToast("Mismatch resolved");
            // Refetch — row moves to Unmatched / Returned-Void tab.
            void load();
          }}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
