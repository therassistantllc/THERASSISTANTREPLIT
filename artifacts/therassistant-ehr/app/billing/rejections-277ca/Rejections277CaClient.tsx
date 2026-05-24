"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type DetailTab,
  type FilterDef,
  type PrimaryAction,
  type PrimaryTab,
  type RowAction,
  type SummaryMetric,
} from "@/components/billing/WorkqueueShell";
import {
  REJECTION_277CA_TABS,
  type Rejection277CaTabId,
} from "@/lib/billing/rejections277ca";
import { getWorkqueue } from "@/lib/billing/workqueues";
import { buildClaimDetailHref } from "@/lib/claims/claimDetailRouting";

type ActionId =
  | "correct_claim"
  | "resubmit_corrected_claim"
  | "route_to_eligibility"
  | "route_to_enrollment"
  | "mark_resolved";

interface RejectionRow {
  id: string;
  workqueueItemId: string;
  claimId: string;
  claimNumber: string | null;
  clientId: string | null;
  clientName: string;
  payerId: string | null;
  payerName: string | null;
  practiceName: string | null;
  clinicianName: string | null;
  dos: string | null;
  ca277Status: string;
  rejectionReason: string;
  category: string;
  categoryCode: string | null;
  statusCode: string | null;
  entityCode: string | null;
  tab: Rejection277CaTabId;
  totalCharge: number;
  dateRejected: string | null;
  assignedTo: string | null;
  status: string;
  priority: string | null;
  followUpDue: string | null;
  agingDays: number | null;
  correctionHistory: Array<{
    id: string;
    body: string;
    type: string;
    createdAt: string | null;
    createdBy: string | null;
  }>;
  contextPayload: Record<string, unknown>;
}

interface ApiPayload {
  success: boolean;
  error?: string;
  items?: RejectionRow[];
}

function getOrganizationId(): string {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function money(value: number): string {
  return Number(value ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function ciContains(haystack: string | null, needle: string): boolean {
  if (!needle) return true;
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

const queueDef = getWorkqueue("rejections_277ca");

export default function Rejections277CaClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [items, setItems] = useState<RejectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeTab, setActiveTab] = useState<Rejection277CaTabId>(
    REJECTION_277CA_TABS[0].id,
  );
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!organizationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const qs = new URLSearchParams({ organizationId });
    for (const [k, v] of Object.entries(filterValues)) {
      if (v) qs.set(k, v);
    }
    fetch(`/api/billing/rejections-277ca?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<ApiPayload>)
      .then((json) => {
        if (json.success && Array.isArray(json.items)) {
          setItems(json.items);
        } else {
          setItems([]);
          if (json.error) {
            setMessage({ tone: "error", text: json.error });
          }
        }
      })
      .catch((e) => {
        setMessage({
          tone: "error",
          text: e instanceof Error ? e.message : "Failed to load",
        });
      })
      .finally(() => setLoading(false));
  }, [organizationId, reloadKey, filterValues]);

  // ── Filter facets + universal rail ──────────────────────────────────────
  const payerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of items) {
      if (r.payerId && r.payerName) map.set(r.payerId, r.payerName);
    }
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of items) {
      if (r.clientId && r.clientName) map.set(r.clientId, r.clientName);
    }
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "text", placeholder: "Service location…" },
      { id: "clinician", label: "Clinician", kind: "text", placeholder: "Rendering provider…" },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "select", options: clientOptions },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "open", label: "Open" },
          { value: "in_progress", label: "In progress" },
          { value: "blocked", label: "Blocked" },
          { value: "resolved", label: "Resolved" },
        ],
      },
      { id: "assignedBiller", label: "Assigned biller", kind: "text", placeholder: "Name or 'unassigned'" },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number" },
      {
        id: "agingBucket",
        label: "Aging",
        kind: "select",
        options: [
          { value: "0-7", label: "0-7 days" },
          { value: "8-30", label: "8-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "60+", label: "60+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "STC code or text…" },
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
      { id: "followUpDue", label: "Follow-up due", kind: "date" },
    ],
    [payerOptions, clientOptions],
  );

  // ── Tab narrowing + client-side filter re-apply ────────────────────────
  const tabRows = useMemo(
    () => items.filter((r) => r.tab === activeTab),
    [items, activeTab],
  );

  const filtered = useMemo(() => {
    const v = filterValues;
    return tabRows.filter((r) => {
      if (v.priority) {
        const p = (r.priority ?? "").toLowerCase();
        if (v.priority === "urgent") {
          if (p !== "urgent" && (r.agingDays ?? 0) <= 14) return false;
        } else if (p !== v.priority) {
          return false;
        }
      }
      if (v.carcRarc) {
        if (
          !ciContains(r.rejectionReason, v.carcRarc) &&
          !ciContains(r.category, v.carcRarc) &&
          !ciContains(r.ca277Status, v.carcRarc) &&
          !ciContains(r.categoryCode, v.carcRarc) &&
          !ciContains(r.statusCode, v.carcRarc)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [tabRows, filterValues]);

  // ── Summary strip ──────────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const dollars = tabRows.reduce((s, r) => s + (r.totalCharge || 0), 0);
    const ages = tabRows
      .map((r) => r.agingDays)
      .filter((n): n is number => n != null);
    const oldest = ages.length ? Math.max(...ages) : 0;
    const urgent = tabRows.filter(
      (r) => (r.priority ?? "").toLowerCase() === "urgent" || (r.agingDays ?? 0) > 14,
    ).length;
    return [
      { id: "count", label: "Rejections", value: tabRows.length.toLocaleString() },
      { id: "dollars", label: "Total $", value: money(dollars) },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: oldest,
        tone: oldest > 30 ? "red" : oldest > 14 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: urgent,
        tone: urgent > 0 ? "amber" : "default",
      },
    ];
  }, [tabRows]);

  // ── Columns: spec order ─────────────────────────────────────────────────
  const columns: ColumnDef<RejectionRow>[] = useMemo(
    () => [
      {
        id: "claimId",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.claimNumber ?? r.claimId.slice(0, 8)}
          </span>
        ),
      },
      { id: "client", header: "Client", cell: (r) => r.clientName },
      { id: "payer", header: "Payer", cell: (r) => r.payerName ?? "—" },
      { id: "dos", header: "DOS", cell: (r) => formatDate(r.dos) },
      {
        id: "ca277Status",
        header: "277CA status",
        cell: (r) => (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 999,
              background: "#FEE2E2",
              color: "#991B1B",
            }}
          >
            {r.ca277Status}
          </span>
        ),
      },
      {
        id: "reason",
        header: "Rejection reason",
        cell: (r) => (
          <span title={r.rejectionReason} style={{ display: "inline-block", maxWidth: 320, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {r.rejectionReason || "—"}
          </span>
        ),
      },
      { id: "category", header: "Category", cell: (r) => r.category },
      {
        id: "charge",
        header: "Charge amount",
        align: "right",
        cell: (r) => money(r.totalCharge),
      },
      {
        id: "dateRejected",
        header: "Date rejected",
        cell: (r) => formatDate(r.dateRejected),
      },
      {
        id: "assignedTo",
        header: "Assigned to",
        cell: (r) => r.assignedTo ?? "—",
      },
    ],
    [],
  );

  // ── Keep selection valid when the visible set shrinks ──────────────────
  useEffect(() => {
    if (!selectedRowId) return;
    if (!filtered.some((r) => r.id === selectedRowId)) setSelectedRowId(null);
  }, [filtered, selectedRowId]);

  const selectedRow = useMemo(
    () => filtered.find((r) => r.id === selectedRowId) ?? null,
    [filtered, selectedRowId],
  );

  // ── Actions ─────────────────────────────────────────────────────────────
  const runAction = useCallback(
    async (row: RejectionRow, action: ActionId) => {
      setBusyId(row.id);
      setMessage(null);

      // Optimistic patch: actions that close/defer the item should drop the
      // row from the visible list immediately.
      const snapshot = items;
      if (
        action === "resubmit_corrected_claim" ||
        action === "mark_resolved" ||
        action === "route_to_eligibility" ||
        action === "route_to_enrollment"
      ) {
        setItems((prev) => prev.filter((r) => r.id !== row.id));
      }

      try {
        const res = await fetch(
          `/api/billing/rejections-277ca/${encodeURIComponent(row.workqueueItemId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId, action }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error || "Action failed");
        }
        const label =
          action === "correct_claim"
            ? "Opened correction note."
            : action === "resubmit_corrected_claim"
              ? "Resubmission queued."
              : action === "route_to_eligibility"
                ? "Routed to eligibility."
                : action === "route_to_enrollment"
                  ? "Routed to credentialing/enrollment."
                  : "Marked resolved.";
        setMessage({ tone: "success", text: label });
        // Pull fresh state so any server-side recomputation (e.g. comment
        // list, status flip) is reflected.
        setReloadKey((k) => k + 1);
      } catch (e) {
        // Roll back optimistic patch.
        setItems(snapshot);
        setMessage({
          tone: "error",
          text: e instanceof Error ? e.message : "Action failed",
        });
      } finally {
        setBusyId(null);
      }
    },
    [organizationId, items],
  );

  const correctHref = useCallback(
    (row: RejectionRow) =>
      `${buildClaimDetailHref({
        professionalClaimId: row.claimId,
        organizationId,
      })}`,
    [organizationId],
  );

  const rowActions: RowAction<RejectionRow>[] = useMemo(
    () => [
      {
        id: "correct",
        label: "Correct claim",
        variant: "primary",
        onClick: (row) => {
          void runAction(row, "correct_claim");
          if (typeof window !== "undefined") {
            window.open(correctHref(row), "_blank", "noopener");
          }
        },
        disabled: (r) => busyId === r.id,
      },
      {
        id: "resubmit",
        label: "Resubmit",
        onClick: (row) => void runAction(row, "resubmit_corrected_claim"),
        disabled: (r) => busyId === r.id,
      },
      {
        id: "resolve",
        label: "Resolve",
        variant: "success",
        onClick: (row) => void runAction(row, "mark_resolved"),
        disabled: (r) => busyId === r.id,
      },
    ],
    [busyId, runAction, correctHref],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    return [
      {
        id: "correct",
        label: "Correct claim",
        variant: "primary",
        onClick: () => {
          void runAction(selectedRow, "correct_claim");
          if (typeof window !== "undefined") {
            window.open(correctHref(selectedRow), "_blank", "noopener");
          }
        },
        disabled: busyId === selectedRow.id,
      },
      {
        id: "resubmit",
        label: "Resubmit corrected claim",
        onClick: () => void runAction(selectedRow, "resubmit_corrected_claim"),
        disabled: busyId === selectedRow.id,
      },
      {
        id: "eligibility",
        label: "Route to eligibility",
        onClick: () => void runAction(selectedRow, "route_to_eligibility"),
        disabled: busyId === selectedRow.id,
      },
      {
        id: "enrollment",
        label: "Route to credentialing/enrollment",
        onClick: () => void runAction(selectedRow, "route_to_enrollment"),
        disabled: busyId === selectedRow.id,
      },
      {
        id: "resolve",
        label: "Mark resolved",
        variant: "success",
        onClick: () => void runAction(selectedRow, "mark_resolved"),
        disabled: busyId === selectedRow.id,
      },
    ];
  }, [selectedRow, busyId, runAction, correctHref]);

  // ── Detail tabs (per spec) ──────────────────────────────────────────────
  const detailTabs: DetailTab[] = useMemo(() => {
    if (!selectedRow) return [];
    const r = selectedRow;
    return [
      {
        id: "message",
        label: "277CA message",
        render: () => (
          <div style={{ display: "grid", gap: 12 }}>
            <div>
              <strong style={{ fontSize: 12, color: "#475569" }}>STATUS</strong>
              <p style={{ margin: "4px 0 0", fontSize: 14, fontWeight: 600 }}>
                {r.ca277Status}
              </p>
            </div>
            <div>
              <strong style={{ fontSize: 12, color: "#475569" }}>REASON</strong>
              <p style={{ margin: "4px 0 0", fontSize: 13 }}>
                {r.rejectionReason || "—"}
              </p>
            </div>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "max-content 1fr",
                gap: "6px 12px",
                margin: 0,
                fontSize: 13,
              }}
            >
              <dt style={{ color: "#64748B" }}>Category code (STC01-1)</dt>
              <dd style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>
                {r.categoryCode ?? "—"}
              </dd>
              <dt style={{ color: "#64748B" }}>Status code (STC01-2)</dt>
              <dd style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>
                {r.statusCode ?? "—"}
              </dd>
              <dt style={{ color: "#64748B" }}>Entity code (STC01-3)</dt>
              <dd style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>
                {r.entityCode ?? "—"}
              </dd>
              <dt style={{ color: "#64748B" }}>Date rejected</dt>
              <dd style={{ margin: 0 }}>{formatDateTime(r.dateRejected)}</dd>
            </dl>
          </div>
        ),
      },
      {
        id: "validation",
        label: "Claim validation details",
        render: () => {
          const ctx = r.contextPayload ?? {};
          const parsed =
            (ctx.parsed_content as Record<string, unknown> | undefined) ?? {};
          const ackId = ctx.acknowledgement_id ? String(ctx.acknowledgement_id) : null;
          const batchId = ctx.edi_batch_id ? String(ctx.edi_batch_id) : null;
          const claimStatus = ctx.claim_status ? String(ctx.claim_status) : null;
          return (
            <div style={{ display: "grid", gap: 12 }}>
              <dl
                style={{
                  display: "grid",
                  gridTemplateColumns: "max-content 1fr",
                  gap: "6px 12px",
                  margin: 0,
                  fontSize: 13,
                }}
              >
                <dt style={{ color: "#64748B" }}>Claim status</dt>
                <dd style={{ margin: 0 }}>{claimStatus ?? "—"}</dd>
                <dt style={{ color: "#64748B" }}>Acknowledgement</dt>
                <dd style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>
                  {ackId ?? "—"}
                </dd>
                <dt style={{ color: "#64748B" }}>EDI batch</dt>
                <dd style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>
                  {batchId ?? "—"}
                </dd>
                <dt style={{ color: "#64748B" }}>Charge amount</dt>
                <dd style={{ margin: 0 }}>{money(r.totalCharge)}</dd>
                <dt style={{ color: "#64748B" }}>DOS</dt>
                <dd style={{ margin: 0 }}>{formatDate(r.dos)}</dd>
                <dt style={{ color: "#64748B" }}>Aging</dt>
                <dd style={{ margin: 0 }}>
                  {r.agingDays == null ? "—" : `${r.agingDays} day(s)`}
                </dd>
              </dl>
              {Object.keys(parsed).length > 0 ? (
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 12, color: "#475569" }}>
                    Raw parsed STC payload
                  </summary>
                  <pre
                    style={{
                      margin: "8px 0 0",
                      padding: 8,
                      background: "#F8FAFC",
                      border: "1px solid #E2E8F0",
                      borderRadius: 4,
                      fontSize: 11.5,
                      overflow: "auto",
                      maxHeight: 200,
                    }}
                  >
                    {JSON.stringify(parsed, null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "fields",
        label: "Payer / provider / client fields",
        render: () => (
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "grid",
              gap: 10,
              fontSize: 13,
            }}
          >
            <li>
              <strong>Client: </strong>
              {r.clientId ? (
                <Link
                  href={`/clients/${r.clientId}?organizationId=${encodeURIComponent(
                    organizationId,
                  )}`}
                >
                  {r.clientName}
                </Link>
              ) : (
                r.clientName
              )}
            </li>
            <li>
              <strong>Payer: </strong>
              {r.payerId ? (
                <Link
                  href={`/insurance-payers?payerId=${encodeURIComponent(
                    r.payerId,
                  )}&organizationId=${encodeURIComponent(organizationId)}`}
                >
                  {r.payerName ?? "Open payer profile"}
                </Link>
              ) : (
                r.payerName ?? "—"
              )}
            </li>
            <li>
              <strong>Rendering provider: </strong>
              {r.clinicianName ?? "—"}
            </li>
            <li>
              <strong>Service location: </strong>
              {r.practiceName ?? "—"}
            </li>
            <li>
              <strong>Claim: </strong>
              <Link href={correctHref(r)}>
                {r.claimNumber ?? r.claimId.slice(0, 8)}
              </Link>
            </li>
          </ul>
        ),
      },
      {
        id: "history",
        label: "Correction history",
        render: () =>
          r.correctionHistory.length === 0 ? (
            <p style={{ margin: 0, color: "#64748B", fontSize: 13 }}>
              No correction notes yet.
            </p>
          ) : (
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "grid",
                gap: 10,
              }}
            >
              {r.correctionHistory.map((c) => (
                <li
                  key={c.id}
                  style={{
                    borderLeft: "3px solid #CBD5E1",
                    paddingLeft: 10,
                  }}
                >
                  <div style={{ fontSize: 11, color: "#64748B" }}>
                    {c.type.replace(/_/g, " ")} · {formatDateTime(c.createdAt)}
                  </div>
                  <div style={{ fontSize: 13 }}>{c.body}</div>
                </li>
              ))}
            </ul>
          ),
      },
    ];
  }, [selectedRow, organizationId, correctHref]);

  const countsByTab = useMemo(() => {
    const m: Record<Rejection277CaTabId, number> = {
      rejected_by_clearinghouse: 0,
      rejected_by_payer: 0,
      invalid_member: 0,
      invalid_provider: 0,
      invalid_payer_id: 0,
      invalid_claim_data: 0,
    };
    for (const r of items) m[r.tab] += 1;
    return m;
  }, [items]);

  const headerActions: PrimaryAction[] = useMemo(
    () => [
      {
        id: "refresh",
        label: loading ? "Refreshing…" : "Refresh",
        onClick: () => setReloadKey((k) => k + 1),
        disabled: loading,
      },
    ],
    [loading],
  );

  const primaryTabs: PrimaryTab[] = useMemo(
    () =>
      REJECTION_277CA_TABS.map((t) => ({
        id: t.id,
        label: t.label,
        count: countsByTab[t.id],
      })),
    [countsByTab],
  );

  return (
    <main className="app-shell">
      <WorkqueueShell<RejectionRow>
        title={queueDef?.title ?? "277CA Rejections"}
        description={queueDef?.description}
        headerActions={headerActions}
        summary={summary}
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTab}
        onPrimaryTabChange={(tabId) => {
          setActiveTab(tabId as Rejection277CaTabId);
          setSelectedRowId(null);
        }}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace="r277"
        rows={filtered}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage={`No ${
          REJECTION_277CA_TABS.find((t) => t.id === activeTab)?.label.toLowerCase() ??
          "rejections"
        }.`}
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />
    </main>
  );
}
