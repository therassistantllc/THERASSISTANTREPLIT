"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { MEDICAL_REVIEW_TABS, type MedicalReviewTab } from "@/lib/medical-review/tabs";
import type { MedicalReviewRow } from "@/lib/medical-review/types";

interface ListPayload {
  success: boolean;
  error?: string;
  rows?: MedicalReviewRow[];
}

interface ContextPayload {
  success: boolean;
  error?: string;
  context?: {
    clinicalNote: {
      id: string; status: string;
      subjective: string | null; objective: string | null;
      assessment: string | null; plan: string | null;
      signedAt: string | null;
    } | null;
    treatmentPlan: {
      id: string; status: string;
      startDate: string | null; endDate: string | null;
      presentingProblem: string | null; longTermGoals: string | null;
      frequency: string | null; modality: string | null;
    } | null;
    documents: Array<{
      id: string; title: string; fileName: string;
      documentType: string | null; uploadedAt: string | null; notes: string | null;
    }>;
    history: Array<{
      id: string; action: string; summary: string | null;
      createdAt: string; userId: string | null;
    }>;
  };
}

const queueDef = getWorkqueue("medical_review");

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

export default function MedicalReviewClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<MedicalReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(0);

  const [activeTab, setActiveTab] = useState<MedicalReviewTab>("records_requested");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const [ctxByClaim, setCtxByClaim] = useState<Record<string, NonNullable<ContextPayload["context"]>>>({});
  const [ctxLoading, setCtxLoading] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingClaim, setUploadingClaim] = useState<string | null>(null);
  const [chartPickerOpen, setChartPickerOpen] = useState(false);
  const [chartDocs, setChartDocs] = useState<Array<{ id: string; title: string | null; fileName: string | null; type: string | null; claimId: string | null; createdAt: string | null }>>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartSelection, setChartSelection] = useState<Record<string, boolean>>({});
  const [attaching, setAttaching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      for (const [k, v] of Object.entries(filterValues)) if (v) params.set(k, v);
      const res = await fetch(`/api/billing/medical-review?${params.toString()}`, { cache: "no-store" });
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

  // ── Tab counts ─────────────────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const m: Record<MedicalReviewTab, number> = {
      records_requested: 0,
      treatment_plan_requested: 0,
      notes_requested: 0,
      medical_necessity_review: 0,
      deadline_approaching: 0,
    };
    for (const r of rows) for (const t of r.tabs) m[t]++;
    return m;
  }, [rows]);

  // ── Filter options derived from rows ───────────────────────────────────
  const payerOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.payerName) m.set(r.payerName, r.payerName);
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
      { id: "client", label: "Client", kind: "text", placeholder: "Patient name…" },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status", label: "Claim status", kind: "select",
        options: [
          { value: "denied", label: "Denied" },
          { value: "accepted_payer", label: "Accepted by payer" },
          { value: "rejected_payer", label: "Rejected by payer" },
          { value: "submitted", label: "Submitted" },
        ],
      },
      { id: "assignedBiller", label: "Assigned biller", kind: "text", placeholder: "user id…" },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket", label: "Request age", kind: "select",
        options: [
          { value: "0-30", label: "0-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "61-90", label: "61-90 days" },
          { value: "90+", label: "90+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. CO-50" },
      {
        id: "priority", label: "Priority", kind: "select",
        options: [{ value: "urgent", label: "Urgent / Overdue" }],
      },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [payerOptions, practiceOptions, clinicianOptions],
  );

  // ── Tab-filtered rows ──────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    return rows.filter((r) => r.tabs.includes(activeTab));
  }, [rows, activeTab]);

  const summary: SummaryMetric[] = useMemo(() => {
    const total = filteredRows.length;
    const dollars = filteredRows.reduce((s, r) => s + r.chargeAmount, 0);
    const oldest = filteredRows.reduce((maxAge, r) => {
      if (!r.requestDate) return maxAge;
      const age = Math.floor((nowMs - new Date(r.requestDate).getTime()) / 86_400_000);
      return age > maxAge ? age : maxAge;
    }, 0);
    const urgent = filteredRows.filter((r) => r.isUrgent || r.isOverdue).length;
    return [
      { id: "count", label: "Items", value: total.toLocaleString() },
      { id: "dollars", label: "Total $ at stake", value: formatCurrency(dollars), tone: dollars > 0 ? "amber" : "default" },
      { id: "oldest", label: "Oldest request (days)", value: oldest, tone: oldest > 30 ? "red" : oldest > 14 ? "amber" : "default" },
      { id: "urgent", label: "Urgent / Overdue", value: urgent, tone: urgent > 0 ? "red" : "default" },
    ];
  }, [filteredRows, nowMs]);

  // ── Columns (exact spec) ───────────────────────────────────────────────
  const columns: ColumnDef<MedicalReviewRow>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.clientName },
      {
        id: "claim", header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.claimNumber || r.claimId.slice(0, 8)}
          </span>
        ),
      },
      { id: "payer", header: "Payer", cell: (r) => r.payerName || "—" },
      { id: "dos", header: "DOS", cell: (r) => formatDate(r.dateOfService) },
      { id: "rtype", header: "Request type", cell: (r) => r.requestTypeLabel },
      {
        id: "rdocs", header: "Requested documents",
        cell: (r) => r.requestedDocuments.length
          ? <span style={{ fontSize: 12 }}>{r.requestedDocuments.join(", ")}</span>
          : <span style={{ color: "#9CA3AF" }}>—</span>,
      },
      { id: "rdate", header: "Request date", cell: (r) => formatDate(r.requestDate) },
      {
        id: "ddate", header: "Due date",
        cell: (r) => {
          if (!r.dueDate) return <span style={{ color: "#9CA3AF" }}>—</span>;
          const color = r.isOverdue ? "#B91C1C" : r.isUrgent ? "#B45309" : "#0F172A";
          const tag = r.isOverdue ? " (overdue)" : r.isUrgent ? ` (in ${r.daysUntilDue}d)` : "";
          return <span style={{ color, fontWeight: 600 }}>{formatDate(r.dueDate)}{tag}</span>;
        },
      },
      {
        id: "charge", header: "Charge amount", align: "right",
        cell: (r) => formatCurrency(r.chargeAmount),
      },
      {
        id: "assigned", header: "Assigned to",
        cell: (r) => r.assignedTo ?? <span style={{ color: "#9CA3AF" }}>—</span>,
      },
    ],
    [],
  );

  const selectedRow = useMemo(
    () => filteredRows.find((r) => r.id === selectedRowId) ?? null,
    [filteredRows, selectedRowId],
  );

  // Hydrate detail context when a row is selected.
  useEffect(() => {
    if (!selectedRow) return;
    const claimId = selectedRow.claimId;
    if (ctxByClaim[claimId] || ctxLoading === claimId) return;
    setCtxLoading(claimId);
    void (async () => {
      try {
        const params = new URLSearchParams({ organizationId, claimId });
        const res = await fetch(`/api/billing/medical-review/context?${params.toString()}`, { cache: "no-store" });
        const json = (await res.json()) as ContextPayload;
        if (json.success && json.context) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setCtxByClaim((prev) => ({ ...prev, [claimId]: json.context! }));
        }
      } finally {
        setCtxLoading(null);
      }
    })();
  }, [selectedRow, organizationId, ctxByClaim, ctxLoading]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const performAction = useCallback(
    async (row: MedicalReviewRow, action: string, extra?: Record<string, unknown>) => {
      setActingId(row.id);
      try {
        const res = await fetch("/api/billing/medical-review/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            action,
            claimId: row.claimId,
            clientId: row.clientId,
            appointmentId: row.appointmentId,
            providerId: row.providerId,
            ...extra,
          }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Action failed");

        const assignment = (json?.assignment ?? null) as
          | { kind: "clinician" | "admin"; display: string; userId: string | null }
          | null;

        const nowIso = new Date().toISOString();
        setRows((prev) => prev.map((r) => {
          if (r.claimId !== row.claimId) return r;
          switch (action) {
            case "route_to_clinician":
            case "route_to_admin":
              return {
                ...r,
                assignedTo: assignment?.display ?? (action === "route_to_clinician" ? "Clinician" : "Admin pool"),
                assignedToKind: assignment?.kind ?? (action === "route_to_clinician" ? "clinician" : "admin"),
                lastActionAt: nowIso,
              };
            case "mark_submitted":
              return { ...r, submittedAt: nowIso, lastActionAt: nowIso };
            default:
              return { ...r, lastActionAt: nowIso };
          }
        }));
        // Invalidate the cached context so the next open re-fetches history.
        setCtxByClaim((prev) => {
          const next = { ...prev };
          delete next[row.claimId];
          return next;
        });
        // Remove submitted rows so they disappear from the live queue.
        if (action === "mark_submitted") {
          setRows((prev) => prev.filter((r) => r.claimId !== row.claimId));
          if (selectedRowId === row.id) setSelectedRowId(null);
        }
        setToast(({
          attach_records: "Records attached",
          send_documentation: "Documentation sent",
          create_cover_letter: "Cover letter created",
          route_to_clinician: `Routed to ${assignment?.display ?? "clinician"}`,
          route_to_admin: "Routed to admin",
          mark_submitted: "Marked submitted",
        } as Record<string, string>)[action] ?? "Done");
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
      } finally {
        setActingId(null);
      }
    },
    [organizationId, selectedRowId],
  );

  const refreshContext = useCallback((claimId: string) => {
    setCtxByClaim((prev) => {
      const next = { ...prev };
      delete next[claimId];
      return next;
    });
  }, []);

  const uploadFiles = useCallback(
    async (row: MedicalReviewRow, files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setUploadingClaim(row.claimId);
      try {
        let uploaded = 0;
        for (const f of list) {
          const fd = new FormData();
          fd.append("file", f);
          fd.append("claimId", row.claimId);
          fd.append("organizationId", organizationId);
          fd.append("documentType", "medical_records");
          const res = await fetch("/api/billing/medical-review/upload", { method: "POST", body: fd });
          const json = await res.json();
          if (!res.ok || json?.success === false) {
            throw new Error(json?.error ?? `Upload failed for ${f.name}`);
          }
          uploaded += 1;
        }
        refreshContext(row.claimId);
        setRows((prev) => prev.map((r) => r.claimId === row.claimId ? { ...r, lastActionAt: new Date().toISOString() } : r));
        setToast(uploaded === 1 ? "Uploaded 1 document" : `Uploaded ${uploaded} documents`);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setUploadingClaim(null);
      }
    },
    [organizationId, refreshContext],
  );

  const loadChartDocs = useCallback(
    async (clientId: string) => {
      setChartLoading(true);
      setChartError(null);
      setChartDocs([]);
      setChartSelection({});
      try {
        const params = new URLSearchParams({ organizationId });
        const res = await fetch(`/api/patients/${clientId}/documents?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Failed to load chart");
        type ChartDoc = { id: string; title: string | null; fileName: string | null; type: string | null; claimId: string | null; createdAt: string | null };
        setChartDocs((json.documents as ChartDoc[]) ?? []);
      } catch (e) {
        setChartError(e instanceof Error ? e.message : "Failed to load chart");
      } finally {
        setChartLoading(false);
      }
    },
    [organizationId],
  );

  const attachFromChart = useCallback(
    async (row: MedicalReviewRow) => {
      const ids = Object.entries(chartSelection).filter(([, v]) => v).map(([k]) => k);
      if (ids.length === 0) return;
      setAttaching(true);
      try {
        const res = await fetch("/api/billing/medical-review/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, claimId: row.claimId, documentIds: ids }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) throw new Error(json?.error ?? "Attach failed");
        refreshContext(row.claimId);
        setRows((prev) => prev.map((r) => r.claimId === row.claimId ? { ...r, lastActionAt: new Date().toISOString() } : r));
        setChartPickerOpen(false);
        setChartSelection({});
        const n = Array.isArray(json.attached) ? json.attached.length : ids.length;
        setToast(n === 1 ? "Attached 1 document" : `Attached ${n} documents`);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Attach failed");
      } finally {
        setAttaching(false);
      }
    },
    [chartSelection, organizationId, refreshContext],
  );

  const rowActions: RowAction<MedicalReviewRow>[] = useMemo(
    () => [
      { id: "attach", label: "Attach records", onClick: (r) => void performAction(r, "attach_records"), disabled: (r) => actingId === r.id },
      { id: "send", label: "Send documentation", variant: "primary", onClick: (r) => void performAction(r, "send_documentation"), disabled: (r) => actingId === r.id },
      { id: "cover", label: "Create cover letter", onClick: (r) => void performAction(r, "create_cover_letter"), disabled: (r) => actingId === r.id },
      { id: "route", label: "Route to clinician", onClick: (r) => void performAction(r, "route_to_clinician"), disabled: (r) => actingId === r.id },
      { id: "submit", label: "Mark submitted", variant: "success", onClick: (r) => void performAction(r, "mark_submitted"), disabled: (r) => actingId === r.id },
    ],
    [actingId, performAction],
  );

  // ── Detail panel ────────────────────────────────────────────────────────
  const ctx = selectedRow ? ctxByClaim[selectedRow.claimId] : undefined;
  const ctxIsLoading = selectedRow && ctxLoading === selectedRow.claimId;

  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "payerRequest", label: "Payer request",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Request type" value={selectedRow.requestTypeLabel} />
            <DetailKV label="Source" value={selectedRow.requestSource ?? "—"} />
            <DetailKV label="Request date" value={formatDateTime(selectedRow.requestDate)} />
            <DetailKV label="Due date" value={selectedRow.dueDate ? `${formatDate(selectedRow.dueDate)}${selectedRow.isOverdue ? " (overdue)" : selectedRow.isUrgent ? ` (in ${selectedRow.daysUntilDue}d)` : ""}` : "—"} />
            <DetailKV label="Requested documents" value={selectedRow.requestedDocuments.length ? selectedRow.requestedDocuments.join(", ") : "—"} />
            <DetailKV label="Denial code" value={selectedRow.denialCode ?? "—"} />
            {selectedRow.requestNotes ? (
              <p style={{ marginTop: 12, fontSize: 13, color: "#475569", whiteSpace: "pre-wrap" }}>
                {selectedRow.requestNotes}
              </p>
            ) : null}
          </div>
        ) : null,
      },
      {
        id: "clinicalNote", label: "Clinical note",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          if (!ctx?.clinicalNote) return <p style={{ color: "#64748B", fontSize: 13 }}>No clinical note found for the encounter.</p>;
          const n = ctx.clinicalNote;
          return (
            <div>
              <DetailKV label="Note status" value={n.status} />
              <DetailKV label="Signed" value={n.signedAt ? formatDateTime(n.signedAt) : <span style={{ color: "#B45309" }}>Unsigned</span>} />
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Subjective</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{n.subjective || "—"}</p>
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Objective</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{n.objective || "—"}</p>
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Plan</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{n.plan || "—"}</p>
            </div>
          );
        },
      },
      {
        id: "treatmentPlan", label: "Treatment plan",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          if (!ctx?.treatmentPlan) return <p style={{ color: "#64748B", fontSize: 13 }}>No active treatment plan on file.</p>;
          const p = ctx.treatmentPlan;
          return (
            <div>
              <DetailKV label="Status" value={p.status} />
              <DetailKV label="Start" value={formatDate(p.startDate)} />
              <DetailKV label="End" value={formatDate(p.endDate)} />
              <DetailKV label="Frequency" value={p.frequency ?? "—"} />
              <DetailKV label="Modality" value={p.modality ?? "—"} />
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Presenting problem</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{p.presentingProblem || "—"}</p>
              <h4 style={{ fontSize: 13, margin: "12px 0 4px" }}>Long-term goals</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{p.longTermGoals || "—"}</p>
            </div>
          );
        },
      },
      {
        id: "assessment", label: "Assessment",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          const assessment = ctx?.clinicalNote?.assessment;
          if (!assessment) return <p style={{ color: "#64748B", fontSize: 13 }}>No assessment recorded on the latest clinical note.</p>;
          return (
            <div>
              <h4 style={{ fontSize: 13, margin: "0 0 4px" }}>SOAP — Assessment</h4>
              <p style={{ fontSize: 13, color: "#0F172A", whiteSpace: "pre-wrap" }}>{assessment}</p>
            </div>
          );
        },
      },
      {
        id: "documents", label: "Uploaded documents",
        render: () => {
          if (!selectedRow) return null;
          const row = selectedRow;
          const docs = ctx?.documents ?? [];
          const isUploading = uploadingClaim === row.claimId;
          const selectedChartCount = Object.values(chartSelection).filter(Boolean).length;
          return (
            <div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "8px 0 12px", borderBottom: "1px solid #F1F5F9", marginBottom: 12 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files && files.length > 0) void uploadFiles(row, files);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  style={{ padding: "6px 12px", border: "1px solid #2563EB", background: "#2563EB", color: "#fff", borderRadius: 4, fontSize: 13, cursor: isUploading ? "wait" : "pointer" }}
                >
                  {isUploading ? "Uploading…" : "Upload files"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const opening = !chartPickerOpen;
                    setChartPickerOpen(opening);
                    if (opening && row.clientId) void loadChartDocs(row.clientId);
                  }}
                  disabled={!row.clientId}
                  style={{ padding: "6px 12px", border: "1px solid #CBD5E1", background: "#fff", color: "#0F172A", borderRadius: 4, fontSize: 13, cursor: row.clientId ? "pointer" : "not-allowed" }}
                  title={row.clientId ? "Pick from patient chart" : "No patient on this claim"}
                >
                  {chartPickerOpen ? "Hide chart picker" : "Attach from chart"}
                </button>
                <span style={{ fontSize: 12, color: "#64748B" }}>Files go to the claim and appear below.</span>
              </div>

              {chartPickerOpen ? (
                <div style={{ border: "1px solid #E2E8F0", borderRadius: 6, padding: 10, marginBottom: 12, background: "#F8FAFC" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>Patient chart documents</strong>
                    <button
                      type="button"
                      onClick={() => void attachFromChart(row)}
                      disabled={attaching || selectedChartCount === 0}
                      style={{ padding: "4px 10px", border: "1px solid #16A34A", background: selectedChartCount === 0 ? "#94A3B8" : "#16A34A", color: "#fff", borderRadius: 4, fontSize: 12, cursor: selectedChartCount === 0 ? "not-allowed" : "pointer" }}
                    >
                      {attaching ? "Attaching…" : `Attach selected (${selectedChartCount})`}
                    </button>
                  </div>
                  {chartLoading ? (
                    <p style={{ fontSize: 12, color: "#64748B", margin: 0 }}>Loading chart…</p>
                  ) : chartError ? (
                    <p style={{ fontSize: 12, color: "#B91C1C", margin: 0 }}>{chartError}</p>
                  ) : chartDocs.length === 0 ? (
                    <p style={{ fontSize: 12, color: "#64748B", margin: 0 }}>No chart documents found for this patient.</p>
                  ) : (
                    <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 220, overflowY: "auto" }}>
                      {chartDocs.map((d) => {
                        const alreadyOnClaim = d.claimId === row.claimId;
                        return (
                          <li key={d.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0", borderBottom: "1px solid #E2E8F0" }}>
                            <input
                              type="checkbox"
                              checked={Boolean(chartSelection[d.id]) || alreadyOnClaim}
                              disabled={alreadyOnClaim}
                              onChange={(e) => setChartSelection((prev) => ({ ...prev, [d.id]: e.target.checked }))}
                              style={{ marginTop: 3 }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "#0F172A" }}>{d.title || d.fileName || "Document"}</div>
                              <div style={{ fontSize: 11, color: "#64748B" }}>
                                {d.fileName ?? "—"}{d.type ? ` · ${d.type}` : ""}{d.createdAt ? ` · ${formatDate(d.createdAt)}` : ""}
                                {alreadyOnClaim ? " · already attached" : ""}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : null}

              {ctxIsLoading && !ctx ? (
                <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>
              ) : docs.length === 0 ? (
                <p style={{ color: "#64748B", fontSize: 13 }}>No documents attached to this claim yet.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {docs.map((d) => (
                    <li key={d.id} style={{ padding: "8px 0", borderBottom: "1px solid #F1F5F9" }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{d.title}</div>
                      <div style={{ fontSize: 12, color: "#64748B" }}>
                        {d.fileName}{d.documentType ? ` · ${d.documentType}` : ""} · uploaded {formatDateTime(d.uploadedAt)}
                      </div>
                      {d.notes ? <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>{d.notes}</div> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        },
      },
      {
        id: "history", label: "Submission history",
        render: () => {
          if (!selectedRow) return null;
          if (ctxIsLoading && !ctx) return <p style={{ color: "#64748B", fontSize: 13 }}>Loading…</p>;
          const hist = ctx?.history ?? [];
          if (hist.length === 0) return <p style={{ color: "#64748B", fontSize: 13 }}>No medical-review actions logged yet.</p>;
          return (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {hist.map((h) => (
                <li key={h.id} style={{ padding: "6px 0", borderBottom: "1px solid #F1F5F9", fontSize: 13 }}>
                  <strong>{h.action.replace(/^medical_review_/, "").replace(/_/g, " ")}</strong>
                  <span style={{ color: "#64748B", marginLeft: 8 }}>{formatDateTime(h.createdAt)}</span>
                  {h.summary ? <div style={{ color: "#475569", fontSize: 12 }}>{h.summary}</div> : null}
                </li>
              ))}
            </ul>
          );
        },
      },
    ],
    [
      selectedRow, ctx, ctxIsLoading,
      uploadingClaim, uploadFiles,
      chartPickerOpen, chartDocs, chartLoading, chartError, chartSelection,
      loadChartDocs, attachFromChart, attaching,
    ],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const r = selectedRow;
    return [
      { id: "attach", label: "Attach records", onClick: () => void performAction(r, "attach_records"), disabled: actingId === r.id },
      { id: "send", label: "Send documentation", variant: "primary", onClick: () => void performAction(r, "send_documentation"), disabled: actingId === r.id },
      { id: "cover", label: "Create cover letter", onClick: () => void performAction(r, "create_cover_letter"), disabled: actingId === r.id },
      { id: "route", label: "Route to clinician", onClick: () => void performAction(r, "route_to_clinician"), disabled: actingId === r.id },
      { id: "submit", label: "Mark submitted", variant: "success", onClick: () => void performAction(r, "mark_submitted"), disabled: actingId === r.id },
    ];
  }, [selectedRow, actingId, performAction]);

  const primaryTabs = useMemo(
    () => MEDICAL_REVIEW_TABS.map((t) => ({ id: t.id, label: t.label, count: tabCounts[t.id] })),
    [tabCounts],
  );

  return (
    <WorkqueueShell<MedicalReviewRow>
      title={queueDef?.title ?? "Medical Review / Documentation Requested"}
      description={queueDef?.description}
      headerActions={[
        { id: "refresh", label: "Refresh", onClick: () => void load() },
      ]}
      summary={summary}
      primaryTabs={primaryTabs}
      activePrimaryTabId={activeTab}
      onPrimaryTabChange={(id) => { setActiveTab(id as MedicalReviewTab); setSelectedRowId(null); }}
      filters={filters}
      filterValues={filterValues}
      onFilterChange={setFilterValues}
      filterUrlNamespace="mr"
      rows={filteredRows}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage={error ?? "No claims in this tab."}
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
