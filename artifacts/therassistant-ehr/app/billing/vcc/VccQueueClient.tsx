"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type RowAction,
  type SummaryMetric,
  type FilterDef,
  type DetailTab,
  type PrimaryTab,
  type PrimaryAction,
} from "@/components/billing/WorkqueueShell";
import { getWorkqueue } from "@/lib/billing/workqueues";

// ─── Types ────────────────────────────────────────────────────────────────────

type TabId = "new" | "processed" | "fee_review" | "matched_era" | "unmatched";

type VccStatus = "pending" | "processed" | "failed" | "expired" | "voided";

type VccRow = {
  id: string;
  payerName: string;
  payerId: string | null;
  paymentAmount: number;
  feeAmount: number | null;
  cardLast4: string | null;
  cardBrand: string | null;
  cardMask: string;
  expirationLabel: string | null;
  expired: boolean;
  claimCount: number;
  claimId: string | null;
  claimNumber: string | null;
  claimStatus: string | null;
  claimTotal: number | null;
  paymentPostingId: string | null;
  postingReference: string | null;
  postingStatus: string | null;
  postingAmount: number | null;
  postedAt: string | null;
  mailroomItemId: string | null;
  mailroomFileName: string | null;
  clientId: string | null;
  clientName: string | null;
  serviceDateStart: string | null;
  serviceDateEnd: string | null;
  referenceNumber: string | null;
  authorizationCode: string | null;
  status: VccStatus;
  processedAt: string | null;
  processedByName: string | null;
  notes: string | null;
  createdAt: string | null;
  ageDays: number;
};

type Assignee = { id: string; displayName: string };
type Practice = { id: string; name: string };

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "new", label: "New VCC" },
  { id: "processed", label: "Processed" },
  { id: "fee_review", label: "Fee Review" },
  { id: "matched_era", label: "Matched to ERA" },
  { id: "unmatched", label: "Unmatched VCC" },
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

function formatCurrency(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value ?? 0);
}

function dosLabel(row: VccRow): string {
  if (!row.serviceDateStart) return "—";
  if (row.serviceDateEnd && row.serviceDateEnd !== row.serviceDateStart) {
    return `${formatDate(row.serviceDateStart)} – ${formatDate(row.serviceDateEnd)}`;
  }
  return formatDate(row.serviceDateStart);
}

// ─── Toast / Modal ────────────────────────────────────────────────────────────

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

// ─── Action helper ────────────────────────────────────────────────────────────

async function callAction(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<{ success: boolean; error?: string; handoffUrl?: string; patch?: Record<string, unknown> }> {
  const res = await fetch(`/api/billing/vcc/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  }
  return { success: true, handoffUrl: json?.handoffUrl, patch: json?.patch };
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function RecordFeeModal({
  row,
  organizationId,
  onClose,
  onDone,
}: {
  row: VccRow;
  organizationId: string;
  onClose: () => void;
  onDone: (patch: Partial<VccRow>, message: string) => void;
}) {
  const [fee, setFee] = useState(row.feeAmount != null ? String(row.feeAmount) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const num = Number(fee);
    if (!Number.isFinite(num) || num < 0) {
      setError("Enter a valid non-negative amount");
      return;
    }
    setSaving(true);
    setError(null);
    const r = await callAction(organizationId, {
      vccId: row.id,
      action: "record_fee",
      feeAmount: num,
    });
    setSaving(false);
    if (!r.success) {
      setError(r.error || "Failed");
      return;
    }
    onDone({ feeAmount: Math.round(num * 100) / 100 }, "Fee recorded");
    onClose();
  }

  return (
    <ModalShell title={`Record processing fee — ${row.payerName}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        VCC amount: {formatCurrency(row.paymentAmount)} · {row.cardMask}
      </p>
      <label style={fieldLabel}>Processing fee ($)</label>
      <input
        type="number"
        step="0.01"
        min="0"
        value={fee}
        onChange={(e) => setFee(e.target.value)}
        style={fieldInput}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save fee"}
        </button>
      </div>
    </ModalShell>
  );
}

function MatchEraModal({
  row,
  organizationId,
  onClose,
  onDone,
}: {
  row: VccRow;
  organizationId: string;
  onClose: () => void;
  onDone: (patch: Partial<VccRow>, message: string) => void;
}) {
  const [postings, setPostings] = useState<
    Array<{ id: string; posting_reference: string; total_posted_amount: number; posted_at: string | null }>
  >([]);
  const [postingId, setPostingId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/billing/payments/posted?organizationId=${encodeURIComponent(organizationId)}&limit=50`,
          { cache: "no-store" },
        );
        const j = await r.json();
        if (cancelled) return;
        const list = (j?.postings ?? j?.rows ?? []) as any[];
        setPostings(
          list.map((p) => ({
            id: String(p.id ?? p.posting_id ?? ""),
            posting_reference: String(p.posting_reference ?? p.reference ?? ""),
            total_posted_amount: Number(p.total_posted_amount ?? p.totalPosted ?? 0),
            posted_at: p.posted_at ?? p.postedAt ?? null,
          })).filter((p) => p.id),
        );
      } catch {
        // Fallback to free-form entry if the picker endpoint isn't there.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  async function save() {
    if (!postingId.trim()) {
      setError("Pick or paste a payment posting id");
      return;
    }
    setSaving(true);
    setError(null);
    const r = await callAction(organizationId, {
      vccId: row.id,
      action: "match_era",
      paymentPostingId: postingId.trim(),
    });
    setSaving(false);
    if (!r.success) {
      setError(r.error || "Failed");
      return;
    }
    onDone({ paymentPostingId: postingId.trim() }, "Matched to ERA");
    onClose();
  }

  return (
    <ModalShell title={`Match VCC to ERA — ${row.payerName}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        VCC amount: {formatCurrency(row.paymentAmount)} · ref {row.referenceNumber ?? "—"}
      </p>
      <label style={fieldLabel}>Payment posting</label>
      {loading ? (
        <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading recent postings…</div>
      ) : postings.length > 0 ? (
        <select value={postingId} onChange={(e) => setPostingId(e.target.value)} style={fieldInput}>
          <option value="">— Select posting —</option>
          {postings.map((p) => (
            <option key={p.id} value={p.id}>
              {p.posting_reference || p.id.slice(0, 8)} · {formatCurrency(p.total_posted_amount)}
              {p.posted_at ? ` · ${formatDate(p.posted_at)}` : ""}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          placeholder="Payment posting UUID"
          value={postingId}
          onChange={(e) => setPostingId(e.target.value)}
          style={fieldInput}
        />
      )}
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

function UploadDocumentModal({
  row,
  organizationId,
  onClose,
  onDone,
}: {
  row: VccRow;
  organizationId: string;
  onClose: () => void;
  onDone: (patch: Partial<VccRow>, message: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!file) {
      setError("Pick a file to upload");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("organizationId", organizationId);
      if (row.clientId) fd.append("clientId", row.clientId);
      fd.append("documentType", "vcc_notice");
      fd.append("source", "vcc_workqueue");
      const upRes = await fetch("/api/mailroom/items", { method: "POST", body: fd });
      const upJson = await upRes.json().catch(() => ({}));
      if (!upRes.ok || upJson?.ok === false) {
        throw new Error(upJson?.error || "Upload failed");
      }
      const mailroomItemId = String(upJson?.item?.id ?? upJson?.id ?? "");
      if (!mailroomItemId) throw new Error("Upload returned no item id");
      const r = await callAction(organizationId, {
        vccId: row.id,
        action: "upload_document",
        mailroomItemId,
      });
      if (!r.success) throw new Error(r.error || "Link failed");
      onDone(
        { mailroomItemId, mailroomFileName: file.name },
        "Document uploaded & attached",
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <ModalShell title={`Upload document — ${row.payerName}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Attach the VCC notice (PDF / image / EOB scan) to this payment.
      </p>
      <input
        type="file"
        accept=".pdf,image/*,.txt,.eml"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        style={{ display: "block", fontSize: 13 }}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={uploading}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={uploading}>
          {uploading ? "Uploading…" : "Upload & attach"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Detail panel pieces ─────────────────────────────────────────────────────

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
      <span style={{ color: "#0F172A", textAlign: "right", maxWidth: "60%" }}>{value}</span>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

const queueDef = getWorkqueue("vcc");

export default function VccQueueClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<VccRow[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [practices, setPractices] = useState<Practice[]>([]);
  const [clinicians, setClinicians] = useState<Assignee[]>([]);
  const [payers, setPayers] = useState<string[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<TabId>("new");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const [feeRow, setFeeRow] = useState<VccRow | null>(null);
  const [matchRow, setMatchRow] = useState<VccRow | null>(null);
  const [uploadRow, setUploadRow] = useState<VccRow | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, tab: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) params.set(k, v);
      }
      const res = await fetch(`/api/billing/vcc?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows((json.rows ?? []) as VccRow[]);
      setAssignees((json.assignees ?? []) as Assignee[]);
      setPractices((json.practices ?? []) as Practice[]);
      setClinicians((json.clinicians ?? []) as Assignee[]);
      setPayers((json.payers ?? []) as string[]);
      setTabCounts((json.tabCounts ?? {}) as Record<string, number>);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [organizationId, activeTab, filterValues]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchRow(id: string, patch: Partial<VccRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    if (selectedRowId === id) setSelectedRowId(null);
  }

  // Tab membership predicates — mirror the server's tab pushdown so the
  // client can reconcile membership after a mutation without refetching.
  const tabPredicates: Record<string, (r: VccRow) => boolean> = useMemo(
    () => ({
      new: (r) => r.status === "pending",
      processed: (r) => r.status === "processed",
      fee_review: (r) => r.feeAmount == null,
      matched_era: (r) => !!r.paymentPostingId,
      unmatched: (r) => !r.paymentPostingId && r.status !== "voided",
    }),
    [],
  );

  /**
   * Apply a mutation to a row in local state:
   *   - patch the row in `rows`, and drop it if it no longer matches the
   *     currently active tab (so the user does not see a stale row)
   *   - recompute each tab's count by re-evaluating membership on the
   *     before/after row, so the tab strip stays accurate without a
   *     full refetch.
   */
  function applyMutation(id: string, patch: Partial<VccRow>) {
    setRows((prev) => {
      const before = prev.find((r) => r.id === id);
      if (!before) return prev;
      const after = { ...before, ...patch };
      setTabCounts((counts) => {
        const next = { ...counts };
        for (const [tabId, pred] of Object.entries(tabPredicates)) {
          const was = pred(before);
          const now = pred(after);
          if (was && !now) next[tabId] = Math.max(0, (next[tabId] ?? 0) - 1);
          else if (!was && now) next[tabId] = (next[tabId] ?? 0) + 1;
        }
        return next;
      });
      const predicate = tabPredicates[activeTab];
      if (predicate && !predicate(after)) {
        if (selectedRowId === id) setSelectedRowId(null);
        return prev.filter((r) => r.id !== id);
      }
      return prev.map((r) => (r.id === id ? after : r));
    });
  }

  async function markProcessed(row: VccRow) {
    const r = await callAction(organizationId, { vccId: row.id, action: "mark_processed" });
    if (!r.success) {
      setToast(r.error || "Failed to mark processed");
      return;
    }
    const nextStatus: VccStatus = "processed";
    const processedAt = new Date().toISOString();
    applyMutation(row.id, { status: nextStatus, processedAt });
    setToast("VCC marked processed");
  }

  async function postPayment(row: VccRow) {
    const r = await callAction(organizationId, { vccId: row.id, action: "post_payment" });
    if (!r.success) {
      setToast(r.error || "Failed");
      return;
    }
    // Apply optimistic mutation (VCC moves to "processed") and reconcile
    // tab membership in place — no full-page reload. Open the manual-
    // posting workspace in a new tab so the user can finish posting
    // alongside the queue.
    if (r.patch) applyMutation(row.id, r.patch as Partial<VccRow>);
    if (r.handoffUrl && typeof window !== "undefined") {
      window.open(r.handoffUrl, "_blank", "noopener,noreferrer");
    }
    setToast("Payment posted — opening posting workspace");
  }

  // ── Universal filter rail ──────────────────────────────────────────────────
  const filters: FilterDef[] = useMemo(
    () => [
      {
        id: "practice",
        label: "Practice",
        kind: "select",
        options: practices.map((p) => ({ value: p.id, label: p.name })),
      },
      {
        id: "clinician",
        label: "Clinician",
        kind: "select",
        options: clinicians.map((c) => ({ value: c.id, label: c.displayName })),
      },
      {
        id: "payer",
        label: "Payer",
        kind: "select",
        options: payers.map((p) => ({ value: p, label: p })),
      },
      { id: "client", label: "Client", kind: "text", placeholder: "Client name…" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "pending", label: "Pending" },
          { value: "processed", label: "Processed" },
          { value: "failed", label: "Failed" },
          { value: "expired", label: "Expired" },
          { value: "voided", label: "Voided" },
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
          { value: "0-7", label: "0–7 days" },
          { value: "8-30", label: "8–30 days" },
          { value: "31-60", label: "31–60 days" },
          { value: "60+", label: "60+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 197" },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [
          { value: "urgent", label: "Urgent (expired / >14d)" },
          { value: "normal", label: "Normal" },
        ],
      },
      {
        id: "followUpDue",
        label: "Follow-up due date",
        kind: "select",
        options: [
          { value: "overdue", label: "Overdue (expired card)" },
          { value: "today", label: "Today" },
          { value: "week", label: "Next 7 days" },
        ],
      },
    ],
    [practices, clinicians, payers, assignees],
  );

  // ── Header summary metrics ────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const total = rows.length;
    const dollars = rows.reduce((s, r) => s + (r.paymentAmount || 0), 0);
    const oldest = rows.reduce((m, r) => Math.max(m, r.ageDays), 0);
    const urgent = rows.filter((r) => r.expired || r.ageDays > 14).length;
    return [
      { id: "count", label: "VCCs in view", value: total.toLocaleString() },
      {
        id: "dollars",
        label: "Total $",
        value: formatCurrency(dollars),
        tone: dollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: oldest,
        tone: oldest > 30 ? "red" : oldest > 7 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: urgent,
        tone: urgent > 0 ? "red" : "default",
      },
    ];
  }, [rows]);

  // ── Tabs (spec order, with live counts) ───────────────────────────────────
  const primaryTabs: PrimaryTab[] = useMemo(
    () => TABS.map((t) => ({ id: t.id, label: t.label, count: tabCounts[t.id] ?? 0 })),
    [tabCounts],
  );

  // ── Columns (spec exact order) ────────────────────────────────────────────
  const columns: ColumnDef<VccRow>[] = useMemo(
    () => [
      { id: "payer", header: "Payer", cell: (r) => r.payerName },
      {
        id: "amount",
        header: "VCC amount",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatCurrency(r.paymentAmount)}
          </span>
        ),
      },
      {
        id: "card",
        header: "Card number masked",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.cardMask}</span>
        ),
      },
      {
        id: "exp",
        header: "Expiration",
        cell: (r) =>
          r.expirationLabel ? (
            <span
              style={{
                color: r.expired ? "#B91C1C" : "#0F172A",
                fontWeight: r.expired ? 600 : 400,
                fontFamily: "ui-monospace, monospace",
              }}
            >
              {r.expirationLabel}
              {r.expired ? " (exp)" : ""}
            </span>
          ) : (
            "—"
          ),
      },
      {
        id: "claim_count",
        header: "Claim count",
        align: "right",
        cell: (r) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.claimCount}</span>,
      },
      {
        id: "era",
        header: "ERA match",
        cell: (r) =>
          r.paymentPostingId ? (
            <span style={{ color: "#047857" }}>
              {r.postingReference || r.paymentPostingId.slice(0, 8)}
            </span>
          ) : (
            <span style={{ color: "#9CA3AF" }}>—</span>
          ),
      },
      {
        id: "fee",
        header: "Processing fee",
        align: "right",
        cell: (r) =>
          r.feeAmount == null ? (
            <span style={{ color: "#B45309" }}>—</span>
          ) : (
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {formatCurrency(r.feeAmount)}
            </span>
          ),
      },
      {
        id: "status",
        header: "Status",
        cell: (r) => {
          const tone =
            r.status === "processed"
              ? "#047857"
              : r.status === "failed" || r.status === "voided"
                ? "#B91C1C"
                : r.status === "expired"
                  ? "#B45309"
                  : "#0F172A";
          return (
            <span style={{ color: tone, textTransform: "capitalize" }}>{r.status}</span>
          );
        },
      },
    ],
    [],
  );

  // ── Row actions (spec exact labels) ────────────────────────────────────────
  const rowActions: RowAction<VccRow>[] = useMemo(
    () => [
      {
        id: "mark_processed",
        label: "Mark processed",
        variant: "success",
        onClick: (r) => void markProcessed(r),
        disabled: (r) => r.status === "processed",
      },
      { id: "record_fee", label: "Record fee", onClick: (r) => setFeeRow(r) },
      { id: "match_era", label: "Match ERA", onClick: (r) => setMatchRow(r) },
      {
        id: "post_payment",
        label: "Post payment",
        variant: "primary",
        onClick: (r) => void postPayment(r),
      },
      { id: "upload_document", label: "Upload document", onClick: (r) => setUploadRow(r) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [organizationId, activeTab],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  // ── Detail panel sections (spec exact labels) ─────────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "notice",
        label: "Payment notice",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Payer" value={selectedRow.payerName} />
              <DetailKV
                label="Amount"
                value={formatCurrency(selectedRow.paymentAmount)}
              />
              <DetailKV label="Card" value={selectedRow.cardMask} />
              <DetailKV
                label="Expiration"
                value={selectedRow.expirationLabel ?? "—"}
              />
              <DetailKV
                label="Reference #"
                value={selectedRow.referenceNumber ?? "—"}
              />
              <DetailKV
                label="Auth code"
                value={selectedRow.authorizationCode ?? "—"}
              />
              <DetailKV label="Service dates" value={dosLabel(selectedRow)} />
              <DetailKV
                label="Received"
                value={formatDate(selectedRow.createdAt)}
              />
              <DetailKV
                label="Status"
                value={
                  <span style={{ textTransform: "capitalize" }}>{selectedRow.status}</span>
                }
              />
              <DetailKV label="Notes" value={selectedRow.notes ?? "—"} />
            </div>
          ) : null,
      },
      {
        id: "era",
        label: "ERA match",
        render: () =>
          selectedRow ? (
            selectedRow.paymentPostingId ? (
              <div>
                <DetailKV
                  label="Posting ref"
                  value={selectedRow.postingReference ?? selectedRow.paymentPostingId}
                />
                <DetailKV
                  label="Posting status"
                  value={selectedRow.postingStatus ?? "—"}
                />
                <DetailKV
                  label="Posted total"
                  value={formatCurrency(selectedRow.postingAmount ?? 0)}
                />
                <DetailKV label="Posted at" value={formatDate(selectedRow.postedAt)} />
                <DetailKV
                  label="Variance"
                  value={
                    selectedRow.postingAmount != null
                      ? formatCurrency(selectedRow.paymentAmount - selectedRow.postingAmount)
                      : "—"
                  }
                />
              </div>
            ) : (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>
                Not matched to an ERA yet. Use “Match ERA” to link a payment posting.
              </div>
            )
          ) : null,
      },
      {
        id: "claims",
        label: "Claims paid",
        render: () =>
          selectedRow ? (
            selectedRow.claimId ? (
              <div>
                <DetailKV label="Client" value={selectedRow.clientName ?? "—"} />
                <DetailKV label="Claim #" value={selectedRow.claimNumber ?? selectedRow.claimId} />
                <DetailKV
                  label="Claim status"
                  value={selectedRow.claimStatus ?? "—"}
                />
                <DetailKV
                  label="Claim charge"
                  value={
                    selectedRow.claimTotal != null
                      ? formatCurrency(selectedRow.claimTotal)
                      : "—"
                  }
                />
                <DetailKV
                  label="VCC payment"
                  value={formatCurrency(selectedRow.paymentAmount)}
                />
                <div style={{ marginTop: 10 }}>
                  <a
                    href={`/billing/claims?claimId=${encodeURIComponent(selectedRow.claimId)}`}
                    style={{ fontSize: 13, color: "#1D4ED8" }}
                  >
                    Open claim →
                  </a>
                </div>
              </div>
            ) : (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>
                No claim linked. Use “Post payment” to allocate this VCC to a claim.
              </div>
            )
          ) : null,
      },
      {
        id: "deposit",
        label: "Deposit record",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV
                label="Processed at"
                value={formatDate(selectedRow.processedAt)}
              />
              <DetailKV
                label="Processed by"
                value={selectedRow.processedByName ?? "—"}
              />
              <DetailKV
                label="Processing fee"
                value={
                  selectedRow.feeAmount == null
                    ? "Not recorded"
                    : formatCurrency(selectedRow.feeAmount)
                }
              />
              <DetailKV
                label="Net deposit"
                value={
                  selectedRow.feeAmount == null
                    ? "—"
                    : formatCurrency(selectedRow.paymentAmount - selectedRow.feeAmount)
                }
              />
              <DetailKV
                label="Attached document"
                value={selectedRow.mailroomFileName ?? "—"}
              />
            </div>
          ) : null,
      },
    ],
    [selectedRow],
  );

  // ── Detail action buttons (mirror row actions for the selected row) ───────
  const detailActions = useMemo<PrimaryAction[] | undefined>(() => {
    if (!selectedRow) return undefined;
    return [
      {
        id: "mark_processed",
        label: "Mark processed",
        variant: "success" as const,
        onClick: () => void markProcessed(selectedRow),
        disabled: selectedRow.status === "processed",
      },
      { id: "record_fee", label: "Record fee", onClick: () => setFeeRow(selectedRow) },
      { id: "match_era", label: "Match ERA", onClick: () => setMatchRow(selectedRow) },
      {
        id: "post_payment",
        label: "Post payment",
        variant: "primary" as const,
        onClick: () => void postPayment(selectedRow),
      },
      {
        id: "upload_document",
        label: "Upload document",
        onClick: () => setUploadRow(selectedRow),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow]);

  return (
    <>
      <WorkqueueShell<VccRow>
        title={queueDef?.title ?? "VCC"}
        description={queueDef?.description}
        message={error ? { tone: "error", text: error } : null}
        headerActions={[
          { id: "refresh", label: "Refresh", onClick: () => void load() },
        ]}
        summary={summary}
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTab}
        onPrimaryTabChange={(id) => setActiveTab(id as TabId)}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace="vcc"
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        loading={loading}
        emptyMessage="No VCC payments in this view."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        rowActions={rowActions}
        detailTabs={detailTabs}
        detailActions={detailActions}
      />

      {feeRow ? (
        <RecordFeeModal
          row={feeRow}
          organizationId={organizationId}
          onClose={() => setFeeRow(null)}
          onDone={(patch, msg) => {
            applyMutation(feeRow.id, patch);
            setToast(msg);
          }}
        />
      ) : null}
      {matchRow ? (
        <MatchEraModal
          row={matchRow}
          organizationId={organizationId}
          onClose={() => setMatchRow(null)}
          onDone={(patch, msg) => {
            applyMutation(matchRow.id, patch);
            setToast(msg);
          }}
        />
      ) : null}
      {uploadRow ? (
        <UploadDocumentModal
          row={uploadRow}
          organizationId={organizationId}
          onClose={() => setUploadRow(null)}
          onDone={(patch, msg) => {
            applyMutation(uploadRow.id, patch);
            setToast(msg);
          }}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
