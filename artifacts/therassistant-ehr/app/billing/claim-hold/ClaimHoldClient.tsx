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

// ─── Types ────────────────────────────────────────────────────────────────────

type HoldCategory =
  | "manual"
  | "documentation"
  | "eligibility"
  | "auth"
  | "compliance"
  | "payer_rule";

type Priority = "low" | "normal" | "high" | "urgent";

type HoldRow = {
  id: string;
  claimNumber: string;
  patientId: string;
  patientName: string;
  memberId: string | null;
  payerProfileId: string;
  payerName: string;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  totalChargeAmount: number;
  holdCategory: HoldCategory;
  holdReason: string;
  heldByDisplayName: string | null;
  heldByUserId: string | null;
  holdStartedAt: string | null;
  holdFollowUpDate: string | null;
  assignedToDisplayName: string | null;
  assignedToUserId: string | null;
  holdPriority: Priority;
  daysOnHold: number;
  noteCount: number;
  clinicianId: string | null;
  clinicianName: string | null;
  practiceLocationId: string | null;
  practiceLocationName: string | null;
  updatedAt: string | null;
};

type Assignee = { id: string; displayName: string };
type Practice = { id: string; name: string };

type Note = {
  id: string;
  body: string;
  author_display_name: string | null;
  created_at: string;
};

type ClaimDocument = {
  id: string;
  title: string;
  fileName: string | null;
  documentType: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  uploadedAt: string | null;
  source: "mailroom" | "fax" | "manual_upload" | "other";
  sourceLabel: string;
  hasFile: boolean;
};

const TABS: Array<{ id: HoldCategory; label: string }> = [
  { id: "manual", label: "Manual Holds" },
  { id: "documentation", label: "Documentation Holds" },
  { id: "eligibility", label: "Eligibility Holds" },
  { id: "auth", label: "Auth Holds" },
  { id: "compliance", label: "Compliance Holds" },
  { id: "payer_rule", label: "Payer Rule Holds" },
];

const HOLD_CATEGORY_LABEL: Record<HoldCategory, string> = TABS.reduce(
  (acc, t) => ({ ...acc, [t.id]: t.label }),
  {} as Record<HoldCategory, string>,
);

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

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0);
}

function dosLabel(row: HoldRow): string {
  if (!row.serviceDateFrom) return "—";
  if (row.serviceDateTo && row.serviceDateTo !== row.serviceDateFrom) {
    return `${formatDate(row.serviceDateFrom)} – ${formatDate(row.serviceDateTo)}`;
  }
  return formatDate(row.serviceDateFrom);
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
  width = 500,
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

// ─── Action call helper ───────────────────────────────────────────────────────

async function callHold(
  claimId: string,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`/api/billing/claims/${claimId}/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  }
  return { success: true };
}

// ─── Action modals ────────────────────────────────────────────────────────────

function ExtendModal({
  row,
  organizationId,
  onClose,
  onDone,
}: {
  row: HoldRow;
  organizationId: string;
  onClose: () => void;
  onDone: (patch: Partial<HoldRow>, message: string) => void;
}) {
  const [followUp, setFollowUp] = useState(row.holdFollowUpDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!followUp) {
      setError("Pick a new follow-up date");
      return;
    }
    setSaving(true);
    setError(null);
    const r = await callHold(row.id, organizationId, {
      action: "extend",
      followUpDate: followUp,
    });
    setSaving(false);
    if (!r.success) {
      setError(r.error || "Failed");
      return;
    }
    onDone({ holdFollowUpDate: followUp }, "Follow-up date updated");
    onClose();
  }

  return (
    <ModalShell title={`Extend hold — ${row.patientName}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claimNumber} · {row.payerName}
      </p>
      <label style={fieldLabel}>New follow-up date</label>
      <input
        type="date"
        value={followUp}
        onChange={(e) => setFollowUp(e.target.value)}
        style={fieldInput}
      />
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

function ChangeReasonModal({
  row,
  organizationId,
  onClose,
  onDone,
}: {
  row: HoldRow;
  organizationId: string;
  onClose: () => void;
  onDone: (patch: Partial<HoldRow>, message: string) => void;
}) {
  const [category, setCategory] = useState<HoldCategory>(row.holdCategory);
  const [reason, setReason] = useState(row.holdReason);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!reason.trim() && category === row.holdCategory) {
      setError("Change the category or enter a new reason");
      return;
    }
    setSaving(true);
    setError(null);
    const r = await callHold(row.id, organizationId, {
      action: "change_reason",
      holdCategory: category,
      holdReason: reason,
    });
    setSaving(false);
    if (!r.success) {
      setError(r.error || "Failed");
      return;
    }
    onDone(
      { holdCategory: category, holdReason: reason },
      "Hold reason updated",
    );
    onClose();
  }

  return (
    <ModalShell title={`Change hold reason — ${row.patientName}`} onClose={onClose}>
      <label style={fieldLabel}>Category</label>
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as HoldCategory)}
        style={fieldInput}
      >
        {TABS.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <label style={{ ...fieldLabel, marginTop: 12 }}>Reason</label>
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
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function AssignModal({
  row,
  organizationId,
  assignees,
  onClose,
  onDone,
}: {
  row: HoldRow;
  organizationId: string;
  assignees: Assignee[];
  onClose: () => void;
  onDone: (patch: Partial<HoldRow>, message: string) => void;
}) {
  const [assigneeId, setAssigneeId] = useState(row.assignedToUserId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const picked = assignees.find((a) => a.id === assigneeId) ?? null;
    const r = await callHold(row.id, organizationId, {
      action: "assign",
      assigneeUserId: picked?.id ?? null,
      assigneeDisplayName: picked?.displayName ?? null,
    });
    setSaving(false);
    if (!r.success) {
      setError(r.error || "Failed");
      return;
    }
    onDone(
      {
        assignedToUserId: picked?.id ?? null,
        assignedToDisplayName: picked?.displayName ?? null,
      },
      picked ? `Assigned to ${picked.displayName}` : "Unassigned",
    );
    onClose();
  }

  return (
    <ModalShell title={`Assign hold — ${row.patientName}`} onClose={onClose}>
      <label style={fieldLabel}>Assignee</label>
      <select
        value={assigneeId}
        onChange={(e) => setAssigneeId(e.target.value)}
        style={fieldInput}
      >
        <option value="">— Unassigned —</option>
        {assignees.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
          </option>
        ))}
      </select>
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

function NoteModal({
  row,
  organizationId,
  onClose,
  onSaved,
}: {
  row: HoldRow;
  organizationId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [body, setBody] = useState("");
  const [resolvedDenial, setResolvedDenial] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!body.trim()) {
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
        body: body.trim(),
        resolved_denial: resolvedDenial,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Failed");
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <ModalShell title={`Add note — ${row.patientName}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claimNumber}
      </p>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        style={fieldInput}
      />
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
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save note"}
        </button>
      </div>
    </ModalShell>
  );
}

function CancelModal({
  row,
  organizationId,
  onClose,
  onDone,
}: {
  row: HoldRow;
  organizationId: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const r = await callHold(row.id, organizationId, {
      action: "cancel_claim",
      reason,
    });
    setSaving(false);
    if (!r.success) {
      setError(r.error || "Failed");
      return;
    }
    onDone(`Claim ${row.claimNumber} cancelled`);
    onClose();
  }

  return (
    <ModalShell title={`Cancel claim — ${row.patientName}`} onClose={onClose}>
      <p style={{ color: "#B91C1C", fontSize: 13, margin: "0 0 12px" }}>
        This marks the claim cancelled. It will not be re-submitted.
      </p>
      <label style={fieldLabel}>Reason (optional)</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        style={fieldInput}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Keep claim
        </button>
        <button type="button" className="button" onClick={save} disabled={saving} style={{ background: "#B91C1C", color: "#fff" }}>
          {saving ? "Cancelling…" : "Cancel claim"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Detail panel sections ────────────────────────────────────────────────────

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

function NotesHistory({
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
  if (notes == null) return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading notes…</div>;
  if (notes.length === 0)
    return <div style={{ color: "#94A3B8", fontSize: 13 }}>No notes yet.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
            {n.author_display_name ?? "Staff"} ·{" "}
            {new Date(n.created_at).toLocaleString()}
          </div>
          <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{n.body}</div>
        </div>
      ))}
    </div>
  );
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

type MailroomPick = {
  id: string;
  fileName: string;
  source: string;
  documentType: string;
  createdAt: string;
};

function AttachDocumentModal({
  claimId,
  organizationId,
  onClose,
  onAttached,
}: {
  claimId: string;
  organizationId: string;
  onClose: () => void;
  onAttached: (msg: string) => void;
}) {
  const [mode, setMode] = useState<"upload" | "mailroom">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [items, setItems] = useState<MailroomPick[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [pickedItemId, setPickedItemId] = useState<string>("");

  useEffect(() => {
    if (mode !== "mailroom" || items !== null) return;
    let cancelled = false;
    fetch(
      `/api/mailroom/items?organizationId=${encodeURIComponent(organizationId)}&status=active&limit=100`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setItemsError(j.error || "Failed to load mailroom items");
        } else {
          const list = (j?.items ?? []) as Array<Record<string, unknown>>;
          setItems(
            list.map((it) => ({
              id: String(it.id ?? ""),
              fileName: String(it.fileName ?? "document"),
              source: String(it.source ?? ""),
              documentType: String(it.documentType ?? ""),
              createdAt: String(it.createdAt ?? ""),
            })),
          );
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setItemsError(e instanceof Error ? e.message : "Failed to load mailroom items");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, items, organizationId]);

  async function submit() {
    setError(null);
    if (mode === "upload") {
      if (!file) {
        setError("Pick a file to upload");
        return;
      }
      setSaving(true);
      const form = new FormData();
      form.set("file", file);
      form.set("organizationId", organizationId);
      if (notes.trim()) form.set("notes", notes.trim());
      const res = await fetch(`/api/billing/claims/${claimId}/documents`, {
        method: "POST",
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      setSaving(false);
      if (!res.ok || json?.success === false) {
        setError(json?.error || `Upload failed (${res.status})`);
        return;
      }
      onAttached("Document attached to claim");
      onClose();
    } else {
      if (!pickedItemId) {
        setError("Pick a mailroom item to file");
        return;
      }
      setSaving(true);
      const res = await fetch(`/api/billing/claims/${claimId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          mailroomItemId: pickedItemId,
          notes: notes.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      setSaving(false);
      if (!res.ok || json?.success === false) {
        setError(json?.error || `Filing failed (${res.status})`);
        return;
      }
      onAttached("Mailroom item filed to claim");
      onClose();
    }
  }

  return (
    <ModalShell title="Attach document" onClose={onClose} width={560}>
      <div
        role="tablist"
        aria-label="Attach mode"
        style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid #E5E7EB" }}
      >
        {(
          [
            { id: "upload", label: "Upload new file" },
            { id: "mailroom", label: "Pick from mailroom" },
          ] as const
        ).map((t) => {
          const active = mode === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setMode(t.id);
                setError(null);
              }}
              style={{
                border: "none",
                background: "transparent",
                padding: "6px 10px",
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                color: active ? "#1D4ED8" : "#475569",
                borderBottom: active ? "2px solid #1D4ED8" : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {mode === "upload" ? (
        <div>
          <label style={fieldLabel}>File</label>
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={fieldInput}
          />
          <div style={{ fontSize: 12, color: "#6B7280", marginTop: 4 }}>
            Up to 25 MB. PDF, image, or office doc.
          </div>
        </div>
      ) : (
        <div>
          <label style={fieldLabel}>Mailroom item</label>
          {itemsError ? (
            <div style={{ color: "#B91C1C", fontSize: 13 }}>{itemsError}</div>
          ) : items == null ? (
            <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading mailroom items…</div>
          ) : items.length === 0 ? (
            <div style={{ color: "#94A3B8", fontSize: 13 }}>
              No unfiled mailroom items.
            </div>
          ) : (
            <select
              value={pickedItemId}
              onChange={(e) => setPickedItemId(e.target.value)}
              style={fieldInput}
            >
              <option value="">— Pick an item —</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.fileName}
                  {it.source ? ` · ${it.source}` : ""}
                  {it.documentType ? ` · ${it.documentType}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <label style={{ ...fieldLabel, marginTop: 12 }}>Notes (optional)</label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        style={fieldInput}
      />

      {error ? (
        <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div>
      ) : null}

      <div style={buttonRow}>
        <button
          type="button"
          className="button button-secondary"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
        <button type="button" className="button" onClick={submit} disabled={saving}>
          {saving ? "Attaching…" : "Attach"}
        </button>
      </div>
    </ModalShell>
  );
}

function ClaimDocuments({
  claimId,
  organizationId,
}: {
  claimId: string;
  organizationId: string;
}) {
  const [docs, setDocs] = useState<ClaimDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bumpKey, setBumpKey] = useState(0);
  const [attachOpen, setAttachOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDocs(null);
    setError(null);
    fetch(
      `/api/billing/claims/${claimId}/documents?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) setError(j.error || "Failed to load documents");
        else setDocs((j?.documents ?? []) as ClaimDocument[]);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load documents");
      });
    return () => {
      cancelled = true;
    };
  }, [claimId, organizationId, bumpKey]);

  const attachButton = (
    <button
      type="button"
      className="button"
      onClick={() => setAttachOpen(true)}
      style={{ fontSize: 12, padding: "4px 10px" }}
    >
      Attach document
    </button>
  );

  const header = (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 8,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "#0F172A" }}>
        Documents
      </div>
      {attachButton}
    </div>
  );

  const modal = attachOpen ? (
    <AttachDocumentModal
      claimId={claimId}
      organizationId={organizationId}
      onClose={() => setAttachOpen(false)}
      onAttached={(msg) => {
        setBumpKey((k) => k + 1);
        setToast(msg);
      }}
    />
  ) : null;

  const toastEl = toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null;

  if (error)
    return (
      <div>
        {header}
        <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>
        {modal}
        {toastEl}
      </div>
    );
  if (docs == null) {
    return (
      <div>
        {header}
        <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading documents…</div>
        {modal}
        {toastEl}
      </div>
    );
  }
  if (docs.length === 0) {
    return (
      <div>
        {header}
        <div style={{ color: "#94A3B8", fontSize: 13 }}>
          No documents linked to this claim yet. Use “Attach document” to upload
          a file or file an existing mailroom item against this claim.
        </div>
        {modal}
        {toastEl}
      </div>
    );
  }

  return (
    <div>
      {header}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {docs.map((d) => {
        const href = `/api/billing/claims/${claimId}/documents/${d.id}/file?organizationId=${encodeURIComponent(organizationId)}`;
        const size = formatBytes(d.fileSizeBytes);
        return (
          <div
            key={d.id}
            style={{
              border: "1px solid #E5E7EB",
              borderRadius: 6,
              padding: 10,
              background: "#F9FAFB",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#0F172A",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={d.fileName ?? d.title}
              >
                {d.fileName ?? d.title}
              </div>
              <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
                {d.sourceLabel}
                {" · "}
                {formatDate(d.uploadedAt)}
                {size ? ` · ${size}` : ""}
                {d.documentType ? ` · ${d.documentType}` : ""}
              </div>
            </div>
            {d.hasFile ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="button button-secondary"
                style={{ fontSize: 12, padding: "4px 10px", whiteSpace: "nowrap" }}
              >
                Open
              </a>
            ) : (
              <span style={{ fontSize: 12, color: "#94A3B8" }}>No file</span>
            )}
          </div>
        );
      })}
      </div>
      {modal}
      {toastEl}
    </div>
  );
}

function nextStepForCategory(cat: HoldCategory): string {
  switch (cat) {
    case "manual":
      return "Review hold reason with the biller who placed it, then release or extend.";
    case "documentation":
      return "Chase the signed clinical note or supporting document, then release.";
    case "eligibility":
      return "Re-run 270/271 eligibility for the date of service and update coverage.";
    case "auth":
      return "Obtain or update the prior authorization on file, then release.";
    case "compliance":
      return "Get supervisor / compliance sign-off before releasing.";
    case "payer_rule":
      return "Confirm the claim now satisfies the payer-specific rule, then release.";
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const queueDef = getWorkqueue("claim_hold");

export default function ClaimHoldClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<HoldRow[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [practices, setPractices] = useState<Practice[]>([]);
  const [clinicians, setClinicians] = useState<Assignee[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<HoldCategory>("manual");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const [extendRow, setExtendRow] = useState<HoldRow | null>(null);
  const [reasonRow, setReasonRow] = useState<HoldRow | null>(null);
  const [assignRow, setAssignRow] = useState<HoldRow | null>(null);
  const [noteRow, setNoteRow] = useState<HoldRow | null>(null);
  const [cancelRow, setCancelRow] = useState<HoldRow | null>(null);
  const [notesBumpKey, setNotesBumpKey] = useState(0);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, category: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) params.set(k, v);
      }
      const res = await fetch(`/api/billing/claim-hold?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows((json.rows ?? []) as HoldRow[]);
      setAssignees((json.assignees ?? []) as Assignee[]);
      setPractices((json.practices ?? []) as Practice[]);
      setClinicians((json.clinicians ?? []) as Assignee[]);
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

  function patchRow(claimId: string, patch: Partial<HoldRow>) {
    setRows((prev) =>
      prev.map((r) => (r.id === claimId ? { ...r, ...patch } : r)),
    );
  }

  function removeRow(claimId: string) {
    setRows((prev) => prev.filter((r) => r.id !== claimId));
    if (selectedRowId === claimId) setSelectedRowId(null);
  }

  async function releaseHold(row: HoldRow) {
    const r = await callHold(row.id, organizationId, { action: "release" });
    if (!r.success) {
      setToast(r.error || "Failed to release");
      return;
    }
    removeRow(row.id);
    setToast("Hold released");
  }

  // ── Universal filter rail (full spec: practice, clinician, payer,
  //    client, DOS, status, assigned biller, dollar amount, aging
  //    bucket, CARC/RARC, priority, follow-up due date) ───────────────────
  const payerOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const r of rows) if (r.payerName) set.set(r.payerName, r.payerName);
    return Array.from(set.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);

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
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Patient name…" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "urgent", label: "Urgent" },
          { value: "high", label: "High" },
          { value: "normal", label: "Normal" },
          { value: "low", label: "Low" },
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
          { value: "urgent", label: "Urgent" },
          { value: "high", label: "High" },
          { value: "normal", label: "Normal" },
          { value: "low", label: "Low" },
        ],
      },
      {
        id: "followUpDue",
        label: "Follow-up due date",
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

  // ── Header summary metrics ────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const total = rows.length;
    const dollars = rows.reduce((s, r) => s + (r.totalChargeAmount || 0), 0);
    const oldest = rows.reduce((m, r) => Math.max(m, r.daysOnHold), 0);
    const urgent = rows.filter(
      (r) => r.holdPriority === "urgent" || r.daysOnHold > 30,
    ).length;
    return [
      { id: "count", label: "Holds in view", value: total.toLocaleString() },
      {
        id: "dollars",
        label: "Total $ on hold",
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

  // ── Columns ───────────────────────────────────────────────────────────────
  const columns: ColumnDef<HoldRow>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.patientName },
      {
        id: "claim",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.claimNumber}</span>
        ),
      },
      { id: "payer", header: "Payer", cell: (r) => r.payerName },
      { id: "dos", header: "DOS", cell: (r) => dosLabel(r) },
      {
        id: "charge",
        header: "Charge amount",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatCurrency(r.totalChargeAmount)}
          </span>
        ),
      },
      {
        id: "reason",
        header: "Hold reason",
        cell: (r) => (
          <span style={{ color: r.holdReason ? "#0F172A" : "#9CA3AF" }}>
            {r.holdReason || "—"}
          </span>
        ),
      },
      { id: "heldBy", header: "Held by", cell: (r) => r.heldByDisplayName ?? "—" },
      { id: "holdDate", header: "Hold date", cell: (r) => formatDate(r.holdStartedAt) },
      {
        id: "followUp",
        header: "Follow-up date",
        cell: (r) => {
          if (!r.holdFollowUpDate) return "—";
          const today = new Date().toISOString().slice(0, 10);
          const overdue = r.holdFollowUpDate < today;
          return (
            <span style={{ color: overdue ? "#B91C1C" : "#0F172A", fontWeight: overdue ? 600 : 400 }}>
              {formatDate(r.holdFollowUpDate)}
            </span>
          );
        },
      },
      {
        id: "assigned",
        header: "Assigned to",
        cell: (r) => (
          <span style={{ color: r.assignedToDisplayName ? "#0F172A" : "#9CA3AF" }}>
            {r.assignedToDisplayName ?? "Unassigned"}
          </span>
        ),
      },
      {
        id: "daysOnHold",
        header: "Days on hold",
        align: "right",
        cell: (r) => (
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              color: r.daysOnHold > 30 ? "#B91C1C" : r.daysOnHold > 7 ? "#B45309" : "#0F172A",
              fontWeight: r.daysOnHold > 30 ? 600 : 400,
            }}
          >
            {r.daysOnHold}
          </span>
        ),
      },
    ],
    [],
  );

  // Row actions use the spec's exact button labels.
  const rowActions: RowAction<HoldRow>[] = useMemo(
    () => [
      { id: "release", label: "Release hold", variant: "success", onClick: (r) => void releaseHold(r) },
      { id: "extend", label: "Extend hold", onClick: (r) => setExtendRow(r) },
      { id: "reason", label: "Change hold reason", onClick: (r) => setReasonRow(r) },
      { id: "assign", label: "Assign", onClick: (r) => setAssignRow(r) },
      { id: "note", label: "Add note", onClick: (r) => setNoteRow(r) },
      { id: "cancel", label: "Cancel claim", variant: "danger", onClick: (r) => setCancelRow(r) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  // Detail-panel sections use the spec's exact labels.
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "reason",
        label: "Hold reason",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV
                label="Category"
                value={HOLD_CATEGORY_LABEL[selectedRow.holdCategory]}
              />
              <DetailKV label="Reason" value={selectedRow.holdReason || "—"} />
              <DetailKV label="Held by" value={selectedRow.heldByDisplayName ?? "—"} />
              <DetailKV label="Hold date" value={formatDate(selectedRow.holdStartedAt)} />
              <DetailKV
                label="Follow-up date"
                value={formatDate(selectedRow.holdFollowUpDate)}
              />
              <DetailKV label="Priority" value={selectedRow.holdPriority} />
              <DetailKV label="Days on hold" value={selectedRow.daysOnHold} />
            </div>
          ) : null,
      },
      {
        id: "snapshot",
        label: "Claim snapshot",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Patient" value={selectedRow.patientName} />
              <DetailKV label="Member ID" value={selectedRow.memberId ?? "—"} />
              <DetailKV label="Payer" value={selectedRow.payerName} />
              <DetailKV label="Claim #" value={selectedRow.claimNumber} />
              <DetailKV label="DOS" value={dosLabel(selectedRow)} />
              <DetailKV
                label="Total charge"
                value={formatCurrency(selectedRow.totalChargeAmount)}
              />
              <DetailKV label="Clinician" value={selectedRow.clinicianName ?? "—"} />
              <DetailKV label="Practice" value={selectedRow.practiceLocationName ?? "—"} />
              <DetailKV label="Assigned to" value={selectedRow.assignedToDisplayName ?? "Unassigned"} />
            </div>
          ) : null,
      },
      {
        id: "next",
        label: "Required next step",
        render: () =>
          selectedRow ? (
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                Required next step
              </div>
              <div style={{ color: "#0F172A" }}>
                {nextStepForCategory(selectedRow.holdCategory)}
              </div>
            </div>
          ) : null,
      },
      {
        id: "notes",
        label: "Notes history",
        render: () =>
          selectedRow ? (
            <NotesHistory
              claimId={selectedRow.id}
              organizationId={organizationId}
              bumpKey={notesBumpKey}
            />
          ) : null,
      },
      {
        id: "documents",
        label: "Related documents",
        render: () =>
          selectedRow ? (
            <ClaimDocuments
              claimId={selectedRow.id}
              organizationId={organizationId}
            />
          ) : null,
      },
    ],
    [selectedRow, organizationId, notesBumpKey],
  );

  // Detail-panel actions use the spec's exact button labels.
  const detailActions = selectedRow
    ? [
        {
          id: "release",
          label: "Release hold",
          variant: "success" as const,
          onClick: () => void releaseHold(selectedRow),
        },
        { id: "extend", label: "Extend hold", onClick: () => setExtendRow(selectedRow) },
        { id: "reason", label: "Change hold reason", onClick: () => setReasonRow(selectedRow) },
        { id: "assign", label: "Assign", onClick: () => setAssignRow(selectedRow) },
        { id: "note", label: "Add note", onClick: () => setNoteRow(selectedRow) },
        {
          id: "cancel",
          label: "Cancel claim",
          variant: "danger" as const,
          onClick: () => setCancelRow(selectedRow),
        },
      ]
    : [];

  // ── Tab strip (placed above the shell) ────────────────────────────────────
  const tabStrip = (
    <div
      role="tablist"
      aria-label="Hold categories"
      style={{
        display: "flex",
        gap: 4,
        padding: "12px 24px 0",
        borderBottom: "1px solid #E5E7EB",
        flexWrap: "wrap",
      }}
    >
      {TABS.map((t) => {
        const count = tabCounts[t.id] ?? 0;
        const active = t.id === activeTab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              setActiveTab(t.id);
              setSelectedRowId(null);
            }}
            style={{
              border: "none",
              background: "transparent",
              padding: "8px 12px",
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              color: active ? "#1D4ED8" : "#475569",
              borderBottom: active ? "2px solid #1D4ED8" : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {t.label}
            <span
              style={{
                marginLeft: 6,
                color: "#6B7280",
                fontWeight: 500,
              }}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );

  const message = !organizationId
    ? {
        tone: "error" as const,
        text: "Missing organizationId. Add ?organizationId=… to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.",
      }
    : error
      ? { tone: "error" as const, text: error }
      : null;

  return (
    <>
      {tabStrip}
      <WorkqueueShell<HoldRow>
        title={queueDef?.title ?? "Claim Hold"}
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
        filterUrlNamespace={`hold_${activeTab}`}
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage={`No ${HOLD_CATEGORY_LABEL[activeTab].toLowerCase()} in view.`}
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {extendRow ? (
        <ExtendModal
          row={extendRow}
          organizationId={organizationId}
          onClose={() => setExtendRow(null)}
          onDone={(patch, msg) => {
            patchRow(extendRow.id, patch);
            setToast(msg);
          }}
        />
      ) : null}
      {reasonRow ? (
        <ChangeReasonModal
          row={reasonRow}
          organizationId={organizationId}
          onClose={() => setReasonRow(null)}
          onDone={(patch, msg) => {
            // If the row's category changed and no longer matches the
            // active tab, drop it from the visible set.
            if (patch.holdCategory && patch.holdCategory !== activeTab) {
              removeRow(reasonRow.id);
            } else {
              patchRow(reasonRow.id, patch);
            }
            setToast(msg);
          }}
        />
      ) : null}
      {assignRow ? (
        <AssignModal
          row={assignRow}
          organizationId={organizationId}
          assignees={assignees}
          onClose={() => setAssignRow(null)}
          onDone={(patch, msg) => {
            patchRow(assignRow.id, patch);
            setToast(msg);
          }}
        />
      ) : null}
      {noteRow ? (
        <NoteModal
          row={noteRow}
          organizationId={organizationId}
          onClose={() => setNoteRow(null)}
          onSaved={() => {
            patchRow(noteRow.id, { noteCount: noteRow.noteCount + 1 });
            setNotesBumpKey((k) => k + 1);
            setToast("Note saved");
          }}
        />
      ) : null}
      {cancelRow ? (
        <CancelModal
          row={cancelRow}
          organizationId={organizationId}
          onClose={() => setCancelRow(null)}
          onDone={(msg) => {
            removeRow(cancelRow.id);
            setToast(msg);
          }}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
