"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type DetailTab,
  type FilterDef,
  type RowAction,
  type SummaryMetric,
} from "@/components/billing/WorkqueueShell";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "0-30" | "31-60" | "61-90" | "91-120" | "120+";

type Row = {
  id: string;
  claim_number: string | null;
  claim_status: string | null;
  patient_id: string | null;
  patient_name: string;
  payer_profile_id: string | null;
  payer_name: string | null;
  payer_id_external: string | null;
  payer_notes: string | null;
  service_date_from: string | null;
  service_date_to: string | null;
  submitted_at: string | null;
  age_days: number | null;
  total_charge: number;
  balance: number;
  defer_until: string | null;
  follow_up_due_date: string | null;
  assigned_to_user_id: string | null;
  assigned_to_display_name: string | null;
  priority: string | null;
  clinician_id: string | null;
  practice_location_id: string | null;
  last_status: string;
  last_status_at: string | null;
  last_followup_at: string | null;
  last_followup_message: string | null;
  next_action: string;
  bucket: Tab;
  carc_codes: string[];
  rarc_codes: string[];
  era_count: number;
  eras: Array<{
    paid: number;
    clp02: string | null;
    check_eft_number: string | null;
    check_issue_date: string | null;
    created_at: string;
  }>;
  wq_status: string | null;
};

type Practice = { id: string; name: string };
type Clinician = { id: string; displayName: string };
type Assignee = { id: string; displayName: string };

type Note = {
  id: string;
  body: string;
  author_display_name: string | null;
  created_at: string;
};

type Inquiry = {
  id?: string;
  status: string;
  status_code?: string | null;
  received_at?: string | null;
  created_at: string;
};

type BulkAction = "run_status" | "escalate" | "mark_resolved";

const BULK_ACTION_LABELS: Record<BulkAction, string> = {
  run_status: "Run status",
  escalate: "Escalate to urgent",
  mark_resolved: "Mark resolved",
};

type StatusEvent = {
  id?: string;
  status: string;
  status_message?: string | null;
  source?: string | null;
  created_at: string;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "0-30", label: "0–30 Days" },
  { id: "31-60", label: "31–60 Days" },
  { id: "61-90", label: "61–90 Days" },
  { id: "91-120", label: "91–120 Days" },
  { id: "120+", label: "120+ Days" },
];

// ─── Utils ────────────────────────────────────────────────────────────────────

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

function dosLabel(r: Row) {
  if (!r.service_date_from && !r.service_date_to) return "—";
  if (
    r.service_date_from &&
    r.service_date_to &&
    r.service_date_from !== r.service_date_to
  ) {
    return `${formatDate(r.service_date_from)} – ${formatDate(r.service_date_to)}`;
  }
  return formatDate(r.service_date_from ?? r.service_date_to);
}

function isUrgent(r: Row): boolean {
  if (r.priority === "urgent") return true;
  if (
    r.follow_up_due_date &&
    r.follow_up_due_date < new Date().toISOString().slice(0, 10)
  )
    return true;
  return (r.age_days ?? 0) > 90;
}

// ─── Toast / Modal shells ─────────────────────────────────────────────────────

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
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

// ─── Bulk toolbar ─────────────────────────────────────────────────────────────

function BulkToolbar({
  count,
  disabled,
  onRun,
  onClear,
}: {
  count: number;
  disabled: boolean;
  onRun: (action: BulkAction) => void;
  onClear: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        margin: "8px 0",
        background: "#EFF6FF",
        border: "1px solid #BFDBFE",
        borderRadius: 6,
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: "#1E3A8A" }}>
        {count} selected
      </span>
      <div style={{ display: "flex", gap: 6, flex: 1 }}>
        <button
          type="button"
          className="button button-secondary"
          disabled={disabled}
          onClick={() => onRun("run_status")}
          style={{ height: 30, padding: "0 12px", fontSize: 12 }}
        >
          Run status
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={disabled}
          onClick={() => onRun("escalate")}
          style={{ height: 30, padding: "0 12px", fontSize: 12 }}
        >
          Escalate to urgent
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={disabled}
          onClick={() => onRun("mark_resolved")}
          style={{ height: 30, padding: "0 12px", fontSize: 12 }}
        >
          Mark resolved
        </button>
      </div>
      <button
        type="button"
        onClick={onClear}
        disabled={disabled}
        style={{
          background: "transparent",
          border: "none",
          color: "#1E3A8A",
          fontSize: 12,
          cursor: disabled ? "not-allowed" : "pointer",
          textDecoration: "underline",
        }}
      >
        Clear selection
      </button>
    </div>
  );
}

function BulkProgressModal({
  action,
  done,
  total,
}: {
  action: BulkAction;
  done: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <ModalShell title={`${BULK_ACTION_LABELS[action]} — ${done} of ${total}`} onClose={() => {}}>
      <div style={{ fontSize: 13, color: "#475569", marginBottom: 12 }}>
        Submitting requests in parallel. Please wait…
      </div>
      <div
        style={{
          height: 8,
          background: "#E5E7EB",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "#2563EB",
            transition: "width 120ms linear",
          }}
        />
      </div>
    </ModalShell>
  );
}

function BulkSummaryModal({
  action,
  succeeded,
  failed,
  onClose,
}: {
  action: BulkAction;
  succeeded: Array<{ id: string; label: string }>;
  failed: Array<{ id: string; label: string; error: string }>;
  onClose: () => void;
}) {
  return (
    <ModalShell title={`${BULK_ACTION_LABELS[action]} — results`} onClose={onClose} width={520}>
      <div style={{ fontSize: 13, marginBottom: 12 }}>
        <strong style={{ color: "#047857" }}>{succeeded.length} succeeded</strong>
        {" · "}
        <strong style={{ color: failed.length > 0 ? "#B91C1C" : "#6B7280" }}>
          {failed.length} failed
        </strong>
      </div>
      {failed.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#B91C1C", marginBottom: 6 }}>
            Failed (still selected for retry)
          </div>
          <div
            style={{
              maxHeight: 200,
              overflow: "auto",
              border: "1px solid #FECACA",
              borderRadius: 4,
              background: "#FEF2F2",
            }}
          >
            {failed.map((f) => (
              <div
                key={f.id}
                style={{
                  padding: "6px 10px",
                  borderBottom: "1px solid #FECACA",
                  fontSize: 12,
                }}
              >
                <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                  {f.label}
                </span>
                <span style={{ color: "#7F1D1D", marginLeft: 8 }}>{f.error}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {succeeded.length > 0 ? (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#047857", marginBottom: 6 }}>
            Succeeded
          </div>
          <div
            style={{
              maxHeight: 160,
              overflow: "auto",
              border: "1px solid #BBF7D0",
              borderRadius: 4,
              background: "#F0FDF4",
              fontSize: 12,
              padding: "6px 10px",
            }}
          >
            {succeeded.map((s) => s.label).join(", ")}
          </div>
        </div>
      ) : null}
      <div style={buttonRow}>
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Action modals ────────────────────────────────────────────────────────────

function FollowUpNoteModal({
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
  const [body, setBody] = useState("");
  const [deferEnabled, setDeferEnabled] = useState(false);
  const [deferDate, setDeferDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });
  const [resolvedDenial, setResolvedDenial] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = body.trim();
    if (!trimmed) {
      setError("Note body is required");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/billing/claims/${row.id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        body: trimmed,
        defer_until: deferEnabled ? deferDate : null,
        resolved_denial: resolvedDenial,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Failed to save note");
      return;
    }
    onSaved({
      defer_until: deferEnabled ? deferDate : row.defer_until,
      follow_up_due_date: deferEnabled ? deferDate : row.follow_up_due_date,
      last_followup_at: new Date().toISOString(),
      last_followup_message: trimmed.slice(0, 117),
    });
    onClose();
  }

  return (
    <ModalShell title={`Add follow-up — ${row.patient_name}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claim_number ?? row.id} · {row.payer_name ?? "—"}
      </p>
      <label style={fieldLabel}>Note</label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        style={fieldInput}
      />
      <div style={{ marginTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={deferEnabled}
            onChange={(e) => setDeferEnabled(e.target.checked)}
          />
          Defer follow-up until
        </label>
        {deferEnabled ? (
          <input
            type="date"
            value={deferDate}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDeferDate(e.target.value)}
            style={{ ...fieldInput, marginTop: 6, maxWidth: 220 }}
          />
        ) : null}
      </div>
      <div style={{ marginTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={resolvedDenial}
            onChange={(e) => setResolvedDenial(e.target.checked)}
          />
          This note resolved the denial
        </label>
      </div>
      {error ? (
        <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div>
      ) : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save follow-up"}
        </button>
      </div>
    </ModalShell>
  );
}

function CallPayerModal({ row, onClose }: { row: Row; onClose: () => void }) {
  return (
    <ModalShell title={`Call payer — ${row.payer_name ?? "—"}`} onClose={onClose}>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ marginBottom: 12, color: "#6B7280" }}>
          Use the contact info below to call the payer about claim{" "}
          {row.claim_number ?? row.id}.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px" }}>
          <strong>Payer</strong>
          <span>{row.payer_name ?? "—"}</span>
          <strong>Payer ID</strong>
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            {row.payer_id_external ?? "—"}
          </span>
          <strong>Claim #</strong>
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            {row.claim_number ?? "—"}
          </span>
          <strong>Notes</strong>
          <span style={{ whiteSpace: "pre-wrap" }}>
            {row.payer_notes ?? "No payer contact info on file."}
          </span>
        </div>
        <p style={{ color: "#94A3B8", fontSize: 12, marginTop: 16 }}>
          Tip: maintain payer phone/fax in Settings → Payers so reps can dial
          directly from this panel.
        </p>
      </div>
      <div style={buttonRow}>
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalShell>
  );
}

function ReasonModal({
  title,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ModalShell title={title} onClose={onClose}>
      <label style={fieldLabel}>Reason (optional)</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        style={fieldInput}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await onConfirm(reason.trim());
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Failed");
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Detail panel helpers ─────────────────────────────────────────────────────

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

function ClaimTimeline({ row }: { row: Row }) {
  type Event = { when: string | null; title: string; meta?: string };
  const events: Event[] = [];
  if (row.submitted_at) {
    events.push({ when: row.submitted_at, title: "Claim submitted", meta: row.claim_number ?? "" });
  }
  if (row.last_status_at) {
    events.push({
      when: row.last_status_at,
      title: `Payer status: ${row.last_status}`,
    });
  }
  if (row.last_followup_at) {
    events.push({
      when: row.last_followup_at,
      title: "Biller follow-up",
      meta: row.last_followup_message ?? undefined,
    });
  }
  if (row.follow_up_due_date) {
    events.push({
      when: row.follow_up_due_date,
      title: "Follow-up due",
    });
  }
  events.sort((a, b) => {
    if (!a.when) return 1;
    if (!b.when) return -1;
    return b.when.localeCompare(a.when);
  });
  if (events.length === 0) {
    return (
      <div style={{ color: "#94A3B8", fontSize: 13 }}>
        No timeline events recorded yet.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {events.map((e, i) => (
        <div
          key={i}
          style={{
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            padding: 10,
            background: "#F9FAFB",
          }}
        >
          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
            {formatDateTime(e.when)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{e.title}</div>
          {e.meta ? (
            <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>{e.meta}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function StatusChecksPanel({
  claimId,
  organizationId,
  bumpKey,
}: {
  claimId: string;
  organizationId: string;
  bumpKey: number;
}) {
  const [items, setItems] = useState<Inquiry[] | null>(null);
  const [events, setEvents] = useState<StatusEvent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setEvents(null);
    fetch(
      `/api/claims/${claimId}/status-history?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : { success: false }))
      .then((j) => {
        if (cancelled) return;
        setItems((j?.inquiries ?? []) as Inquiry[]);
        setEvents((j?.events ?? []) as StatusEvent[]);
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setEvents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [claimId, organizationId, bumpKey]);
  if (items == null || events == null)
    return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>;
  if (items.length === 0 && events.length === 0)
    return (
      <div style={{ color: "#94A3B8", fontSize: 13 }}>
        No claim status checks have been run yet. Use “Run status” to query the
        payer.
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((i, idx) => (
        <div
          key={`i-${i.id ?? idx}`}
          style={{
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            padding: 10,
            background: "#F9FAFB",
          }}
        >
          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
            276/277 · {formatDateTime(i.received_at ?? i.created_at)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {i.status} {i.status_code ? `· ${i.status_code}` : ""}
          </div>
        </div>
      ))}
      {events.map((e, idx) => (
        <div
          key={`e-${e.id ?? idx}`}
          style={{
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            padding: 10,
            background: "#fff",
          }}
        >
          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
            {e.source ?? "system"} · {formatDateTime(e.created_at)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{e.status}</div>
          {e.status_message ? (
            <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>
              {e.status_message}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PayerContactHistory({ row }: { row: Row }) {
  return (
    <div>
      <DetailKV label="Payer" value={row.payer_name ?? "—"} />
      <DetailKV
        label="Payer ID"
        value={
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            {row.payer_id_external ?? "—"}
          </span>
        }
      />
      <DetailKV label="Last status" value={row.last_status} />
      <DetailKV label="Last status at" value={formatDateTime(row.last_status_at)} />
      <DetailKV label="Last biller follow-up" value={formatDateTime(row.last_followup_at)} />
      <div style={{ marginTop: 12, fontSize: 13, whiteSpace: "pre-wrap" }}>
        {row.payer_notes ??
          "No payer contact info on file. Add phone / fax in Settings → Payers."}
      </div>
    </div>
  );
}

function EraHistory({ row }: { row: Row }) {
  if (row.eras.length === 0) {
    return (
      <div style={{ color: "#94A3B8", fontSize: 13 }}>
        No ERA / 835 payments have been received for this claim.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {(row.carc_codes.length > 0 || row.rarc_codes.length > 0) && (
        <div style={{ fontSize: 12, color: "#475569", marginBottom: 4 }}>
          {row.carc_codes.length > 0 && (
            <div>CARC: {row.carc_codes.join(", ")}</div>
          )}
          {row.rarc_codes.length > 0 && (
            <div>RARC: {row.rarc_codes.join(", ")}</div>
          )}
        </div>
      )}
      {row.eras.map((e, idx) => (
        <div
          key={idx}
          style={{
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            padding: 10,
            background: "#F9FAFB",
          }}
        >
          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
            {formatDate(e.check_issue_date ?? e.created_at)}
            {e.check_eft_number ? ` · Check #${e.check_eft_number}` : ""}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {formatCurrency(e.paid)}
            {e.clp02 ? ` · CLP ${e.clp02}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function NotesPanel({
  claimId,
  organizationId,
  bumpKey,
}: {
  claimId: string;
  organizationId: string;
  bumpKey: number;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    setError(null);
    fetch(
      `/api/billing/claims/${claimId}/notes?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) setError(j.error || "Failed");
        else setNotes((j?.notes ?? []) as Note[]);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      });
    return () => {
      cancelled = true;
    };
  }, [claimId, organizationId, bumpKey]);
  if (error) return <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>;
  if (notes == null) return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>;
  if (notes.length === 0)
    return <div style={{ color: "#94A3B8", fontSize: 13 }}>No notes yet.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {notes.map((n) => (
        <div
          key={n.id}
          style={{
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            padding: 10,
            background: "#F9FAFB",
          }}
        >
          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
            {n.author_display_name ?? "Staff"} · {formatDateTime(n.created_at)}
          </div>
          <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{n.body}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Action helpers ───────────────────────────────────────────────────────────

async function runClaimStatus(row: Row, organizationId: string) {
  if (!row.patient_id) return { success: false, error: "Missing patient on claim" };
  const res = await fetch("/api/clearinghouse/availity/claim-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      organizationId,
      clientId: row.patient_id,
      claimId: row.id,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false)
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  return { success: true };
}

async function escalate(row: Row, organizationId: string, reason: string) {
  const res = await fetch(`/api/billing/executive-priority/${row.id}/escalate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      organizationId,
      priority: "urgent",
      reason: reason || `Escalated from Aging (${row.bucket})`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false)
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  return { success: true };
}

async function postAgingAction(
  row: Row,
  organizationId: string,
  action: "move_to_appeal" | "mark_resolved",
  reason: string,
) {
  const res = await fetch(`/api/billing/aging/${row.id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId, action, reason }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false)
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  return { success: true };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AgingClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [practices, setPractices] = useState<Practice[]>([]);
  const [clinicians, setClinicians] = useState<Clinician[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<Tab, number>>({
    "0-30": 0,
    "31-60": 0,
    "61-90": 0,
    "91-120": 0,
    "120+": 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<Tab>("0-30");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const [noteRow, setNoteRow] = useState<Row | null>(null);
  const [callRow, setCallRow] = useState<Row | null>(null);
  const [escalateRow, setEscalateRow] = useState<Row | null>(null);
  const [appealRow, setAppealRow] = useState<Row | null>(null);
  const [resolveRow, setResolveRow] = useState<Row | null>(null);
  const [bumpKey, setBumpKey] = useState(0);

  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [bulkProgress, setBulkProgress] = useState<{
    action: BulkAction;
    total: number;
    done: number;
  } | null>(null);
  const [bulkSummary, setBulkSummary] = useState<{
    action: BulkAction;
    succeeded: Array<{ id: string; label: string }>;
    failed: Array<{ id: string; label: string; error: string }>;
  } | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, tab: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) params.set(k, v);
      }
      const res = await fetch(`/api/billing/aging?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows((json.items ?? []) as Row[]);
      setTabCounts(json.tabCounts ?? tabCounts);
      setPractices((json.practices ?? []) as Practice[]);
      setClinicians((json.clinicians ?? []) as Clinician[]);
      setAssignees((json.assignees ?? []) as Assignee[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, activeTab, JSON.stringify(filterValues)]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchRow(claimId: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === claimId ? { ...r, ...patch } : r)));
  }
  function removeRow(claimId: string) {
    setRows((prev) => prev.filter((r) => r.id !== claimId));
    if (selectedRowId === claimId) setSelectedRowId(null);
  }

  // ── Filters ────────────────────────────────────────────────────────────────
  const payerOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const r of rows)
      if (r.payer_profile_id && r.payer_name) set.set(r.payer_profile_id, r.payer_name);
    return Array.from(set.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "select", options: practices.map((p) => ({ value: p.id, label: p.name })) },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicians.map((c) => ({ value: c.id, label: c.displayName })) },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Patient name…" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "submitted", label: "Submitted" },
          { value: "accepted_oa", label: "Accepted (clearinghouse)" },
          { value: "accepted_payer", label: "Accepted (payer)" },
          { value: "denied", label: "Denied" },
          { value: "rejected_payer", label: "Rejected (payer)" },
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
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Aging bucket",
        kind: "select",
        options: [
          { value: "0-30", label: "0–30 days" },
          { value: "31-60", label: "31–60 days" },
          { value: "61-90", label: "61–90 days" },
          { value: "91-120", label: "91–120 days" },
          { value: "120+", label: "120+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 197" },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [
          { value: "urgent", label: "Urgent" },
          { value: "high", label: "High" },
          { value: "normal", label: "Normal" },
          { value: "low", label: "Low" },
        ],
      },
      {
        id: "followUpDue",
        label: "Follow-up due",
        kind: "select",
        options: [
          { value: "overdue", label: "Overdue" },
          { value: "today", label: "Today" },
          { value: "week", label: "Next 7 days" },
        ],
      },
    ],
    [practices, clinicians, payerOptions, assignees],
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const total = rows.length;
    const dollars = rows.reduce((s, r) => s + (r.balance || r.total_charge || 0), 0);
    const oldest = rows.reduce((m, r) => Math.max(m, r.age_days ?? 0), 0);
    const urgent = rows.filter(isUrgent).length;
    return [
      { id: "count", label: "Total in view", value: total.toLocaleString() },
      {
        id: "dollars",
        label: "Total $ outstanding",
        value: formatCurrency(dollars),
        tone: dollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest",
        label: "Oldest claim (days)",
        value: oldest,
        tone: oldest > 120 ? "red" : oldest > 90 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: urgent,
        tone: urgent > 0 ? "red" : "default",
      },
    ];
  }, [rows]);

  // ── Columns (spec-exact labels) ────────────────────────────────────────────
  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.patient_name },
      {
        id: "claim",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            {r.claim_number ?? r.id.slice(0, 8)}
          </span>
        ),
      },
      { id: "payer", header: "Payer", cell: (r) => r.payer_name ?? "—" },
      { id: "dos", header: "DOS", cell: (r) => dosLabel(r) },
      { id: "submitted", header: "Submitted date", cell: (r) => formatDate(r.submitted_at) },
      {
        id: "age",
        header: "Age",
        align: "right",
        cell: (r) => {
          const d = r.age_days ?? 0;
          return (
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                color: d > 120 ? "#B91C1C" : d > 90 ? "#B45309" : d > 30 ? "#0F172A" : "#475569",
                fontWeight: d > 90 ? 600 : 400,
              }}
            >
              {r.age_days != null ? `${d}d` : "—"}
            </span>
          );
        },
      },
      {
        id: "charge",
        header: "Charge amount",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatCurrency(r.total_charge)}
          </span>
        ),
      },
      {
        id: "balance",
        header: "Balance",
        align: "right",
        cell: (r) => (
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              fontWeight: r.balance > 0 ? 600 : 400,
            }}
          >
            {formatCurrency(r.balance)}
          </span>
        ),
      },
      {
        id: "lastStatus",
        header: "Last status",
        cell: (r) => (
          <div style={{ maxWidth: 220 }}>
            <div>{r.last_status}</div>
            {r.last_status_at ? (
              <div style={{ fontSize: 11, color: "#6B7280" }}>
                {formatDate(r.last_status_at)}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: "lastFollowup",
        header: "Last follow-up",
        cell: (r) => {
          if (!r.last_followup_at) return <span style={{ color: "#94A3B8" }}>—</span>;
          return (
            <div style={{ maxWidth: 220 }}>
              <div>{formatDate(r.last_followup_at)}</div>
              {r.last_followup_message ? (
                <div
                  style={{
                    fontSize: 11,
                    color: "#6B7280",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.last_followup_message}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "nextAction",
        header: "Next action",
        cell: (r) => (
          <span
            style={{
              display: "inline-block",
              padding: "2px 8px",
              borderRadius: 999,
              background:
                r.next_action === "Follow-up overdue"
                  ? "#FEE2E2"
                  : r.next_action === "Move to appeal"
                    ? "#FEF3C7"
                    : "#E0F2FE",
              color:
                r.next_action === "Follow-up overdue"
                  ? "#991B1B"
                  : r.next_action === "Move to appeal"
                    ? "#92400E"
                    : "#075985",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {r.next_action}
          </span>
        ),
      },
      {
        id: "assigned",
        header: "Assigned to",
        cell: (r) =>
          r.assigned_to_display_name ?? (
            <span style={{ color: "#94A3B8" }}>Unassigned</span>
          ),
      },
    ],
    [],
  );

  // ── Action handlers ────────────────────────────────────────────────────────
  const handleRunStatus = useCallback(
    async (r: Row) => {
      const result = await runClaimStatus(r, organizationId);
      setToast(
        result.success
          ? `Claim status request sent for ${r.claim_number ?? r.id}.`
          : `Run status failed: ${result.error}`,
      );
      if (result.success) {
        setBumpKey((k) => k + 1);
        void load();
      }
    },
    [organizationId, load],
  );

  const handleEscalate = useCallback(
    async (r: Row, reason: string) => {
      const result = await escalate(r, organizationId, reason);
      if (result.success) {
        patchRow(r.id, { priority: "urgent" });
        setToast(`Escalated ${r.claim_number ?? r.id} to urgent.`);
      } else {
        setToast(`Escalate failed: ${result.error}`);
      }
    },
    [organizationId],
  );

  const handleAppeal = useCallback(
    async (r: Row, reason: string) => {
      const result = await postAgingAction(r, organizationId, "move_to_appeal", reason);
      if (result.success) {
        patchRow(r.id, { wq_status: "appeal_needed", priority: "high", next_action: "Move to appeal" });
        setToast(`Moved ${r.claim_number ?? r.id} to appeals.`);
        setBumpKey((k) => k + 1);
      } else {
        setToast(`Move to appeal failed: ${result.error}`);
      }
    },
    [organizationId],
  );

  const handleResolve = useCallback(
    async (r: Row, reason: string) => {
      const result = await postAgingAction(r, organizationId, "mark_resolved", reason);
      if (result.success) {
        removeRow(r.id);
        setToast(`Marked ${r.claim_number ?? r.id} resolved.`);
      } else {
        setToast(`Mark resolved failed: ${result.error}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [organizationId],
  );

  const runBulk = useCallback(
    async (action: BulkAction) => {
      const ids = selectedRowIds;
      const targets = rows.filter((r) => ids.includes(r.id));
      if (targets.length === 0) return;
      setBulkProgress({ action, total: targets.length, done: 0 });
      const succeeded: Array<{ id: string; label: string }> = [];
      const failed: Array<{ id: string; label: string; error: string }> = [];
      await Promise.all(
        targets.map(async (r) => {
          const label = r.claim_number ?? r.id.slice(0, 8);
          let result: { success: boolean; error?: string };
          try {
            if (action === "run_status") {
              result = await runClaimStatus(r, organizationId);
            } else if (action === "escalate") {
              result = await escalate(
                r,
                organizationId,
                `Bulk escalation from Aging (${r.bucket})`,
              );
            } else {
              result = await postAgingAction(
                r,
                organizationId,
                "mark_resolved",
                "Bulk resolve from Aging",
              );
            }
          } catch (e) {
            result = { success: false, error: e instanceof Error ? e.message : "Failed" };
          }
          if (result.success) {
            succeeded.push({ id: r.id, label });
            if (action === "escalate") {
              patchRow(r.id, { priority: "urgent" });
            } else if (action === "mark_resolved") {
              removeRow(r.id);
            }
          } else {
            failed.push({ id: r.id, label, error: result.error ?? "Failed" });
          }
          setBulkProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        }),
      );
      setBulkProgress(null);
      setBulkSummary({ action, succeeded, failed });
      // Keep only failed rows selected for retry
      setSelectedRowIds(failed.map((f) => f.id));
      if (action === "run_status" && succeeded.length > 0) {
        setBumpKey((k) => k + 1);
        void load();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedRowIds, rows, organizationId, load],
  );

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      { id: "status", label: "Run status", onClick: (r) => void handleRunStatus(r) },
      { id: "note", label: "Add follow-up", onClick: (r) => setNoteRow(r) },
      { id: "call", label: "Call payer", onClick: (r) => setCallRow(r) },
      { id: "escalate", label: "Escalate", variant: "danger", onClick: (r) => setEscalateRow(r) },
      { id: "appeal", label: "Move to appeal", onClick: (r) => setAppealRow(r) },
      { id: "resolve", label: "Mark resolved", variant: "success", onClick: (r) => setResolveRow(r) },
    ],
    [handleRunStatus],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  // ── Detail panel (spec-exact section labels) ───────────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "timeline",
        label: "Claim timeline",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Claim #" value={selectedRow.claim_number ?? "—"} />
              <DetailKV label="Status" value={selectedRow.claim_status ?? "—"} />
              <DetailKV label="Submitted" value={formatDateTime(selectedRow.submitted_at)} />
              <DetailKV
                label="Age"
                value={selectedRow.age_days != null ? `${selectedRow.age_days}d` : "—"}
              />
              <DetailKV label="Charge" value={formatCurrency(selectedRow.total_charge)} />
              <DetailKV label="Balance" value={formatCurrency(selectedRow.balance)} />
              <div style={{ marginTop: 12 }}>
                <ClaimTimeline row={selectedRow} />
              </div>
            </div>
          ) : null,
      },
      {
        id: "status_checks",
        label: "Status checks",
        render: () =>
          selectedRow ? (
            <StatusChecksPanel
              claimId={selectedRow.id}
              organizationId={organizationId}
              bumpKey={bumpKey}
            />
          ) : null,
      },
      {
        id: "payer_contact",
        label: "Payer contact history",
        render: () => (selectedRow ? <PayerContactHistory row={selectedRow} /> : null),
      },
      {
        id: "era_history",
        label: "ERA history",
        render: () => (selectedRow ? <EraHistory row={selectedRow} /> : null),
      },
      {
        id: "notes",
        label: "Notes",
        render: () =>
          selectedRow ? (
            <NotesPanel
              claimId={selectedRow.id}
              organizationId={organizationId}
              bumpKey={bumpKey}
            />
          ) : null,
      },
    ],
    [selectedRow, organizationId, bumpKey],
  );

  const detailActions = selectedRow
    ? [
        { id: "status", label: "Run status", onClick: () => void handleRunStatus(selectedRow) },
        { id: "note", label: "Add follow-up", onClick: () => setNoteRow(selectedRow) },
        { id: "call", label: "Call payer", onClick: () => setCallRow(selectedRow) },
        {
          id: "escalate",
          label: "Escalate",
          variant: "danger" as const,
          onClick: () => setEscalateRow(selectedRow),
        },
        {
          id: "appeal",
          label: "Move to appeal",
          onClick: () => setAppealRow(selectedRow),
        },
        {
          id: "resolve",
          label: "Mark resolved",
          variant: "success" as const,
          onClick: () => setResolveRow(selectedRow),
        },
      ]
    : [];

  // ── Primary tabs (use shell's built-in primaryTabs) ────────────────────────
  const primaryTabs = TABS.map((t) => ({
    id: t.id,
    label: t.label,
    count: tabCounts[t.id] ?? 0,
  }));

  const message = !organizationId
    ? {
        tone: "error" as const,
        text:
          "Missing organizationId. Add ?organizationId=… to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.",
      }
    : error
      ? { tone: "error" as const, text: error }
      : null;

  return (
    <>
      <WorkqueueShell<Row>
        title="Aging"
        description="Time-based follow-up on every open claim, bucketed by age in days."
        headerActions={[
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
          setSelectedRowIds([]);
        }}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`ag_${activeTab}`}
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No claims in this aging bucket."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        selectedRowIds={selectedRowIds}
        onSelectionChange={setSelectedRowIds}
        toolbar={
          selectedRowIds.length > 0 ? (
            <BulkToolbar
              count={selectedRowIds.length}
              disabled={bulkProgress != null}
              onRun={(a) => void runBulk(a)}
              onClear={() => setSelectedRowIds([])}
            />
          ) : null
        }
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {noteRow ? (
        <FollowUpNoteModal
          row={noteRow}
          organizationId={organizationId}
          onClose={() => setNoteRow(null)}
          onSaved={(patch) => {
            patchRow(noteRow.id, patch);
            setBumpKey((k) => k + 1);
            setToast("Follow-up saved");
          }}
        />
      ) : null}
      {callRow ? <CallPayerModal row={callRow} onClose={() => setCallRow(null)} /> : null}
      {escalateRow ? (
        <ReasonModal
          title={`Escalate ${escalateRow.claim_number ?? escalateRow.id}`}
          confirmLabel="Escalate to urgent"
          onClose={() => setEscalateRow(null)}
          onConfirm={(reason) => handleEscalate(escalateRow, reason)}
        />
      ) : null}
      {appealRow ? (
        <ReasonModal
          title={`Move ${appealRow.claim_number ?? appealRow.id} to appeal`}
          confirmLabel="Move to appeal"
          onClose={() => setAppealRow(null)}
          onConfirm={(reason) => handleAppeal(appealRow, reason)}
        />
      ) : null}
      {resolveRow ? (
        <ReasonModal
          title={`Mark ${resolveRow.claim_number ?? resolveRow.id} resolved`}
          confirmLabel="Mark resolved"
          onClose={() => setResolveRow(null)}
          onConfirm={(reason) => handleResolve(resolveRow, reason)}
        />
      ) : null}
      {bulkProgress ? (
        <BulkProgressModal
          action={bulkProgress.action}
          done={bulkProgress.done}
          total={bulkProgress.total}
        />
      ) : null}
      {bulkSummary ? (
        <BulkSummaryModal
          action={bulkSummary.action}
          succeeded={bulkSummary.succeeded}
          failed={bulkSummary.failed}
          onClose={() => setBulkSummary(null)}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
