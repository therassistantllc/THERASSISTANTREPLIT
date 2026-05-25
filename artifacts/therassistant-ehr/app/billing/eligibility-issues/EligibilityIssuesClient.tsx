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
import { ClaimDocumentsPanel } from "@/components/billing/ClaimDocumentsPanel";
import { getWorkqueue } from "@/lib/billing/workqueues";
import {
  ELIGIBILITY_ISSUE_TABS,
  type EligibilityIssueRow,
  type EligibilityIssueType,
} from "@/lib/eligibility/eligibilityIssuesTypes";
import UpdateInsuranceDrawer, {
  type InsuranceUpdate,
} from "./UpdateInsuranceDrawer";

type ListPayload = {
  success: boolean;
  error?: string;
  rows?: EligibilityIssueRow[];
};

const queueDef = getWorkqueue("eligibility_issues");

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

function statusTone(s: string): "amber" | "red" | "green" | "default" {
  const v = s.toLowerCase();
  if (v === "inactive" || v === "terminated") return "red";
  if (v === "active") return "green";
  if (v === "not_checked" || v === "stale" || v === "unknown") return "amber";
  return "default";
}

const ISSUE_LABEL: Record<EligibilityIssueType, string> = Object.fromEntries(
  ELIGIBILITY_ISSUE_TABS.map((t) => [t.id, t.label]),
) as Record<EligibilityIssueType, string>;

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

export default function EligibilityIssuesClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<EligibilityIssueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // "Now" timestamp captured at load-time so urgency/age math stays stable
  // and pure across renders (React-19 purity rule).
  const [nowMs, setNowMs] = useState<number>(0);

  const [activeTab, setActiveTab] = useState<EligibilityIssueType>("inactive_coverage");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  // Deep-link target: when opened from My Inbox we receive `?appointmentId=…`
  // and need to jump the user straight to that row (right tab, scrolled into
  // view, detail drawer open) once rows arrive.
  const [pendingAppointmentId, setPendingAppointmentId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("appointmentId");
  });
  // Row id to briefly pulse after a deep-link jump, then cleared so a
  // re-render or normal click doesn't re-trigger the animation.
  const [pulseRowId, setPulseRowId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [insuranceEditRow, setInsuranceEditRow] = useState<EligibilityIssueRow | null>(null);

  // Routing picker state.
  type RoutingPickerState = {
    row: EligibilityIssueRow;
    kind: "clinician" | "admin";
    loading: boolean;
    error: string | null;
    assignees: Array<{
      id: string;
      name: string;
      email: string | null;
      jobTitle: string | null;
      roles: string[];
      isAppointmentProvider: boolean;
    }>;
    selectedId: string;
    note: string;
    submitting: boolean;
  };
  const [routingPicker, setRoutingPicker] = useState<RoutingPickerState | null>(null);

  // Inbox-comments cache, keyed by workqueue item id (a.k.a. row.inboxItemId).
  // Loaded lazily when the user opens the "Inbox comments" detail tab so
  // the original biller can read what the assignee said back.
  type InboxComment = {
    id: string;
    body: string;
    type: string;
    createdAt: string;
    authorName: string;
  };
  type InboxCommentsState = {
    loading: boolean;
    error: string | null;
    comments: InboxComment[];
    canComment: boolean;
    commentRole: "assignee" | "router" | null;
    draft: string;
    posting: boolean;
    postError: string | null;
  };
  const [inboxCommentsById, setInboxCommentsById] = useState<
    Record<string, InboxCommentsState>
  >({});

  const loadInboxComments = useCallback(
    async (workqueueItemId: string) => {
      setInboxCommentsById((prev) => ({
        ...prev,
        [workqueueItemId]: {
          loading: true,
          error: null,
          comments: prev[workqueueItemId]?.comments ?? [],
          canComment: prev[workqueueItemId]?.canComment ?? false,
          commentRole: prev[workqueueItemId]?.commentRole ?? null,
          draft: prev[workqueueItemId]?.draft ?? "",
          posting: prev[workqueueItemId]?.posting ?? false,
          postError: prev[workqueueItemId]?.postError ?? null,
        },
      }));
      try {
        const res = await fetch(
          `/api/billing/workqueue-comments?workqueueItemId=${encodeURIComponent(
            workqueueItemId,
          )}&organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Failed to load comments");
        }
        setInboxCommentsById((prev) => ({
          ...prev,
          [workqueueItemId]: {
            loading: false,
            error: null,
            comments: (json.comments ?? []) as InboxComment[],
            canComment: Boolean(json.canComment),
            commentRole: (json.commentRole ?? null) as InboxCommentsState["commentRole"],
            draft: prev[workqueueItemId]?.draft ?? "",
            posting: false,
            postError: null,
          },
        }));
      } catch (e) {
        setInboxCommentsById((prev) => ({
          ...prev,
          [workqueueItemId]: {
            loading: false,
            error: e instanceof Error ? e.message : "Failed to load comments",
            comments: prev[workqueueItemId]?.comments ?? [],
            canComment: prev[workqueueItemId]?.canComment ?? false,
            commentRole: prev[workqueueItemId]?.commentRole ?? null,
            draft: prev[workqueueItemId]?.draft ?? "",
            posting: false,
            postError: prev[workqueueItemId]?.postError ?? null,
          },
        }));
      }
    },
    [organizationId],
  );

  const setCommentDraft = useCallback(
    (workqueueItemId: string, draft: string) => {
      setInboxCommentsById((prev) => {
        const existing = prev[workqueueItemId];
        if (!existing) return prev;
        return { ...prev, [workqueueItemId]: { ...existing, draft } };
      });
    },
    [],
  );

  const postInboxComment = useCallback(
    async (workqueueItemId: string) => {
      const current = inboxCommentsById[workqueueItemId];
      const text = (current?.draft ?? "").trim();
      if (!text) return;
      setInboxCommentsById((prev) => {
        const existing = prev[workqueueItemId];
        if (!existing) return prev;
        return {
          ...prev,
          [workqueueItemId]: { ...existing, posting: true, postError: null },
        };
      });
      try {
        const res = await fetch("/api/billing/workqueue-comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            workqueueItemId,
            comment: text,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Failed to post comment");
        }
        setInboxCommentsById((prev) => {
          const existing = prev[workqueueItemId];
          if (!existing) return prev;
          return {
            ...prev,
            [workqueueItemId]: { ...existing, draft: "", posting: false, postError: null },
          };
        });
        await loadInboxComments(workqueueItemId);
      } catch (e) {
        setInboxCommentsById((prev) => {
          const existing = prev[workqueueItemId];
          if (!existing) return prev;
          return {
            ...prev,
            [workqueueItemId]: {
              ...existing,
              posting: false,
              postError: e instanceof Error ? e.message : "Failed to post comment",
            },
          };
        });
      }
    },
    [inboxCommentsById, loadInboxComments, organizationId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      for (const [key, value] of Object.entries(filterValues)) {
        if (value) params.set(key, value);
      }
      const res = await fetch(
        `/api/billing/eligibility-issues?${params.toString()}`,
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
    // Initial fetch — `load` is a setState-producing callback, which the
    // react-hooks/set-state-in-effect rule flags; this is the standard
    // load-on-mount pattern used by sibling workqueues.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Deep-link handler: once rows arrive, jump to the row whose appointment
  // matches `?appointmentId=` from My Inbox. Switches to the row's issue-type
  // tab, clears any filter that would hide it, selects it (opens the detail
  // drawer), and scrolls it into view. Runs once per inbound deep link.
  useEffect(() => {
    if (!pendingAppointmentId) return;
    if (loading || rows.length === 0) return;
    const match = rows.find((r) => r.appointmentId === pendingAppointmentId);
    if (!match) {
      setPendingAppointmentId(null);
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTab(match.issueType);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFilterValues((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedRowId(match.id);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingAppointmentId(null);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPulseRowId(match.id);
    // Wait for the tab/filter state to flush, then scroll.
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        const el = document.getElementById(`wqrow-${match.id}`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return () => cancelAnimationFrame(raf2);
    });
    // Clear the pulse after the animation finishes (3 × 1s keyframe pass)
    // so normal clicks/re-renders don't trigger it again.
    const pulseTimer = setTimeout(() => setPulseRowId(null), 3200);
    return () => {
      cancelAnimationFrame(raf1);
      clearTimeout(pulseTimer);
    };
  }, [pendingAppointmentId, rows, loading]);

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
      if (r.providerId) m.set(r.providerId, `Clinician ${r.providerId.slice(0, 8)}`);
    }
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
        id: "status",
        label: "Eligibility status",
        kind: "select",
        options: [
          { value: "active", label: "Active" },
          { value: "inactive", label: "Inactive" },
          { value: "not_checked", label: "Not checked" },
          { value: "stale", label: "Stale" },
          { value: "unknown", label: "Unknown" },
        ],
      },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [
          { value: "urgent", label: "Urgent (DOS ≤ 3 days)" },
          { value: "normal", label: "Normal" },
        ],
      },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Last check age",
        kind: "select",
        options: [
          { value: "0-30", label: "0-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "61-90", label: "61-90 days" },
          { value: "90+", label: "90+ days" },
          { value: "never", label: "Never checked" },
        ],
      },
      { id: "assignedBiller", label: "Assigned biller", kind: "text", placeholder: "user id…" },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. CO-45" },
      { id: "followUpDue", label: "Follow-up due by", kind: "date" },
    ],
    [payerOptions, practiceOptions, clinicianOptions],
  );

  // Apply tab + filters. Filters mirror the server-side `applyFilters` so the
  // queue feels instant while the next reload also honors them server-side.
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
    if (v.status) out = out.filter((r) => r.eligibilityStatus.toLowerCase() === v.status);
    if (v.priority === "urgent") {
      out = out.filter((r) => {
        if (!r.dateOfService) return false;
        const delta = new Date(r.dateOfService).getTime() - nowMs;
        return delta >= 0 && delta <= 3 * 86400_000;
      });
    }
    if (v.minAmount) {
      const min = Number(v.minAmount);
      if (Number.isFinite(min)) out = out.filter((r) => r.totalCharge >= min);
    }
    if (v.maxAmount) {
      const max = Number(v.maxAmount);
      if (Number.isFinite(max)) out = out.filter((r) => r.totalCharge <= max);
    }
    if (v.agingBucket) {
      out = out.filter((r) => {
        const a = r.daysSinceCheck;
        if (v.agingBucket === "never") return a == null;
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
  }, [rows, activeTab, filterValues, nowMs]);

  // ── Summary strip — totals for the active tab ──────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const total = filteredRows.length;
    const dollars = filteredRows.reduce((s, r) => s + r.totalCharge, 0);
    const ages = filteredRows
      .map((r) => ageDays(r.dateOfService))
      .filter((n): n is number => n != null);
    const oldest = ages.length ? Math.max(...ages) : 0;
    const urgent = filteredRows.filter((r) => {
      if (!r.dateOfService) return false;
      const delta = new Date(r.dateOfService).getTime() - nowMs;
      return delta >= 0 && delta <= 3 * 86400_000;
    }).length;
    return [
      { id: "count", label: "Items", value: total.toLocaleString() },
      { id: "dollars", label: "Total $ at risk", value: formatCurrency(dollars), tone: dollars > 0 ? "amber" : "default" },
      { id: "oldest", label: "Oldest claim age (days)", value: oldest, tone: oldest > 30 ? "red" : oldest > 14 ? "amber" : "default" },
      { id: "urgent", label: "Urgent (DOS ≤ 3d)", value: urgent, tone: urgent > 0 ? "red" : "default" },
    ];
  }, [filteredRows, nowMs]);

  // ── Columns (exact spec) ───────────────────────────────────────────────
  const columns: ColumnDef<EligibilityIssueRow>[] = useMemo(
    () => [
      { id: "client", header: "Client", cell: (r) => r.clientName },
      { id: "payer", header: "Payer", cell: (r) => r.payerName || "—" },
      {
        id: "memberId", header: "Member ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", color: r.memberId ? "#0F172A" : "#9CA3AF" }}>
            {r.memberId || "missing"}
          </span>
        ),
      },
      { id: "dos", header: "Date of service", cell: (r) => formatDate(r.dateOfService) },
      {
        id: "lastCheck", header: "Last eligibility check",
        cell: (r) => r.lastEligibilityCheck ? `${formatDate(r.lastEligibilityCheck)}` : <span style={{ color: "#9CA3AF" }}>Never</span>,
      },
      {
        id: "status", header: "Eligibility status",
        cell: (r) => {
          const tone = statusTone(r.eligibilityStatus);
          const colors: Record<typeof tone, string> = {
            default: "#475569", green: "#15803D", amber: "#B45309", red: "#B91C1C",
          };
          return <span style={{ color: colors[tone], fontWeight: 600, textTransform: "capitalize" }}>
            {r.eligibilityStatus.replace(/_/g, " ")}
          </span>;
        },
      },
      { id: "issue", header: "Issue type", cell: (r) => ISSUE_LABEL[r.issueType] },
      {
        id: "copay", header: "Copay", align: "right",
        cell: (r) => r.copay == null ? "—" : formatCurrency(r.copay),
      },
      {
        id: "deductible", header: "Deductible", align: "right",
        cell: (r) => r.deductible == null ? "—" : formatCurrency(r.deductible),
      },
      { id: "effective", header: "Effective date", cell: (r) => formatDate(r.effectiveDate) },
      { id: "termination", header: "Termination date", cell: (r) => formatDate(r.terminationDate) },
      {
        id: "related", header: "Related claim/appointment",
        cell: (r) => (
          <span style={{ fontSize: 12 }}>
            {r.relatedClaimNumber ? <>Claim {r.relatedClaimNumber}</> : <>Appt {formatDate(r.relatedAppointmentStart)}</>}
            {r.holdNote ? <div style={{ color: "#B45309" }}>HOLD</div> : null}
            {r.denialCode ? <div style={{ color: "#B91C1C" }}>{r.denialCode}</div> : null}
          </span>
        ),
      },
      {
        id: "assignedTo", header: "Routed to",
        cell: (r) => r.assignedTo ? (
          <span style={{ fontSize: 12 }}>
            <div style={{ fontWeight: 600, color: "#0F172A", display: "flex", alignItems: "center", gap: 6 }}>
              <span>{r.assignedTo}</span>
              {r.inboxCommentCount > 0 ? (
                <span
                  title={`${r.inboxCommentCount} comment${r.inboxCommentCount === 1 ? "" : "s"} from the assignee`}
                  style={{
                    background: "#E0E7FF",
                    color: "#3730A3",
                    borderRadius: 999,
                    padding: "1px 7px",
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {r.inboxCommentCount === 1 ? "1 comment" : `${r.inboxCommentCount} comments`}
                </span>
              ) : null}
            </div>
            <div style={{ color: "#64748B", textTransform: "capitalize" }}>
              {r.assignedToKind ?? "—"}
              {r.inboxItemId ? " · inbox" : ""}
            </div>
          </span>
        ) : <span style={{ color: "#9CA3AF" }}>Unassigned</span>,
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
    async (
      row: EligibilityIssueRow,
      action: string,
      opts?: { note?: string; assignedToUserId?: string },
    ) => {
      setActingId(row.id);
      try {
        const res = await fetch("/api/billing/eligibility-issues/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            action,
            appointmentId: row.appointmentId,
            clientId: row.clientId,
            claimId: row.relatedClaimId,
            providerId: row.providerId,
            note: opts?.note,
            assignedToUserId: opts?.assignedToUserId,
          }),
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Action failed");
        }
        const assignment = (json?.assignment ?? null) as
          | {
              kind: "clinician" | "admin";
              display: string;
              userId: string | null;
              email: string | null;
            }
          | null;
        // Optimistic update — keep the row in place so the new state is visible
        // without a reload (assignment, hold, release).
        setRows((prev) => prev.map((r) => {
          if (r.id !== row.id) return r;
          switch (action) {
            case "mark_verified":
              return { ...r, manuallyVerifiedAt: new Date().toISOString() };
            case "hold_claim":
              return { ...r, holdNote: opts?.note || "Held pending eligibility verification", claimStatus: "draft" };
            case "release_claim":
              return { ...r, holdNote: null, claimStatus: "ready_for_validation" };
            case "route_to_clinician":
            case "route_to_admin":
              return {
                ...r,
                assignedTo: assignment?.display ?? (action === "route_to_clinician" ? "Clinician" : "Admin pool"),
                assignedToKind: assignment?.kind ?? (action === "route_to_clinician" ? "clinician" : "admin"),
                assignedToUserId: assignment?.userId ?? r.assignedToUserId,
                assignedToEmail: assignment?.email ?? r.assignedToEmail,
                inboxItemId: (json?.inboxItemId as string | null) ?? r.inboxItemId,
              };
            default:
              return r;
          }
        }));
        setToast(({
          mark_verified: "Marked verified",
          route_to_clinician: `Routed to ${assignment?.display ?? "clinician"}`,
          route_to_admin: `Routed to ${assignment?.display ?? "admin"}`,
          hold_claim: "Claim placed on hold",
          release_claim: "Claim released",
        } as Record<string, string>)[action] ?? "Done");
        // For verifications we may remove the row (if no hard structural issue).
        if (action === "mark_verified" &&
            row.issueType !== "terminated_plan" &&
            row.issueType !== "missing_subscriber_info") {
          setRows((prev) => prev.filter((r) => r.id !== row.id));
          if (selectedRowId === row.id) setSelectedRowId(null);
        }
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
      } finally {
        setActingId(null);
      }
    },
    [organizationId, selectedRowId],
  );

  const runEligibility = useCallback(
    async (row: EligibilityIssueRow) => {
      if (!row.appointmentId) return;
      setActingId(row.id);
      try {
        const res = await fetch("/api/eligibility/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appointmentId: row.appointmentId }),
        });
        const json = await res.json();
        if (!res.ok || json?.error) throw new Error(json?.error ?? "Failed to run eligibility");
        setToast("Eligibility check queued");
        await load();
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Failed to run eligibility");
      } finally {
        setActingId(null);
      }
    },
    [load],
  );

  const updateInsurance = useCallback((row: EligibilityIssueRow) => {
    setInsuranceEditRow(row);
  }, []);

  const handleInsuranceSaved = useCallback(
    (row: EligibilityIssueRow, update: InsuranceUpdate) => {
      // Refresh the row in-place so the biller sees the new payer / member ID
      // / coverage window without losing their tab + filter state.
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id
            ? {
                ...r,
                payerId: update.payerId,
                payerName: update.payerName,
                memberId: update.policyNumber,
                effectiveDate: update.effectiveDate,
                terminationDate: update.terminationDate,
              }
            : r,
        ),
      );
      setToast(
        update.eligibilityRefreshSuggested
          ? "Insurance updated — run eligibility to refresh"
          : "Insurance updated",
      );
    },
    [],
  );

  const openRoutingPicker = useCallback(
    async (row: EligibilityIssueRow, kind: "clinician" | "admin") => {
      setRoutingPicker({
        row,
        kind,
        loading: true,
        error: null,
        assignees: [],
        selectedId: "",
        note: "",
        submitting: false,
      });
      try {
        const params = new URLSearchParams({
          organizationId,
          kind,
        });
        if (row.appointmentId) params.set("appointmentId", row.appointmentId);
        const res = await fetch(
          `/api/billing/eligibility-issues/assignees?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error ?? "Failed to load users");
        }
        const assignees = (json?.assignees ?? []) as RoutingPickerState["assignees"];
        const defaultId =
          assignees.find((a) => a.isAppointmentProvider)?.id ??
          assignees[0]?.id ??
          "";
        setRoutingPicker((prev) =>
          prev && prev.row.id === row.id && prev.kind === kind
            ? { ...prev, loading: false, assignees, selectedId: defaultId }
            : prev,
        );
      } catch (e) {
        setRoutingPicker((prev) =>
          prev && prev.row.id === row.id && prev.kind === kind
            ? {
                ...prev,
                loading: false,
                error: e instanceof Error ? e.message : "Failed to load users",
              }
            : prev,
        );
      }
    },
    [organizationId],
  );

  const submitRouting = useCallback(async () => {
    setRoutingPicker((prev) => (prev ? { ...prev, submitting: true, error: null } : prev));
    // Snapshot the current picker state so we can use it without depending on
    // it inside this callback.
    const picker = routingPicker;
    if (!picker || !picker.selectedId) {
      setRoutingPicker((prev) =>
        prev ? { ...prev, submitting: false, error: "Pick a user to route to" } : prev,
      );
      return;
    }
    try {
      await performAction(
        picker.row,
        picker.kind === "clinician" ? "route_to_clinician" : "route_to_admin",
        { note: picker.note, assignedToUserId: picker.selectedId },
      );
      setRoutingPicker(null);
    } catch (e) {
      setRoutingPicker((prev) =>
        prev
          ? {
              ...prev,
              submitting: false,
              error: e instanceof Error ? e.message : "Routing failed",
            }
          : prev,
      );
    }
  }, [routingPicker, performAction]);

  const rowActions: RowAction<EligibilityIssueRow>[] = useMemo(
    () => [
      { id: "run", label: "Run eligibility", variant: "primary", onClick: (r) => void runEligibility(r), disabled: (r) => actingId === r.id },
      { id: "update_ins", label: "Update insurance", onClick: (r) => updateInsurance(r) },
      { id: "verify", label: "Mark verified manually", variant: "success", onClick: (r) => void performAction(r, "mark_verified"), disabled: (r) => actingId === r.id },
      { id: "route_clin", label: "Route to clinician…", onClick: (r) => void openRoutingPicker(r, "clinician"), disabled: (r) => actingId === r.id },
      { id: "route_admin", label: "Route to admin…", onClick: (r) => void openRoutingPicker(r, "admin"), disabled: (r) => actingId === r.id },
      { id: "hold", label: "Hold claim", onClick: (r) => void performAction(r, "hold_claim"), disabled: (r) => actingId === r.id || !r.relatedClaimId || Boolean(r.holdNote) },
      { id: "release", label: "Release after verification", onClick: (r) => void performAction(r, "release_claim"), disabled: (r) => actingId === r.id || !r.holdNote },
    ],
    [actingId, performAction, runEligibility, updateInsurance, openRoutingPicker],
  );

  // ── Detail panel ────────────────────────────────────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "report270",
        label: "270/271 report",
        render: () => selectedRow ? (
          <div>
            <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Latest eligibility transaction</h3>
            {selectedRow.eligibilityCheckId ? (
              <>
                <DetailKV label="Status" value={selectedRow.eligibilityStatus} />
                <DetailKV label="Checked at" value={formatDateTime(selectedRow.lastEligibilityCheck)} />
                <DetailKV label="Copay" value={selectedRow.copay == null ? "—" : formatCurrency(selectedRow.copay)} />
                <DetailKV label="Deductible remaining" value={selectedRow.deductible == null ? "—" : formatCurrency(selectedRow.deductible)} />
                <DetailKV label="Coverage start" value={formatDate(selectedRow.effectiveDate)} />
                <DetailKV label="Coverage end" value={formatDate(selectedRow.terminationDate)} />
                <DetailKV label="Issue detected" value={ISSUE_LABEL[selectedRow.issueType]} />
              </>
            ) : (
              <p style={{ color: "#64748B", fontSize: 13 }}>
                No 270/271 transaction on file. Click <strong>Run eligibility</strong> to submit a new check.
              </p>
            )}
          </div>
        ) : null,
      },
      {
        id: "insuranceCard",
        label: "Insurance card",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Payer" value={selectedRow.payerName} />
            <DetailKV label="Payer ID" value={selectedRow.payerId ?? "—"} />
            <DetailKV label="Member ID" value={selectedRow.memberId || "—"} />
            <DetailKV label="Effective date" value={formatDate(selectedRow.effectiveDate)} />
            <DetailKV label="Termination date" value={formatDate(selectedRow.terminationDate)} />
            <p style={{ color: "#94A3B8", fontSize: 12, marginTop: 12 }}>
              Card images live on the patient chart — use “Update insurance”.
            </p>
          </div>
        ) : null,
      },
      {
        id: "subscriber",
        label: "Subscriber details",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Client" value={selectedRow.clientName} />
            <DetailKV label="Member ID" value={selectedRow.memberId || "—"} />
            <DetailKV label="Payer" value={selectedRow.payerName} />
            {!selectedRow.memberId ? (
              <p style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>
                Member ID is missing on the subscriber record. Update the patient&apos;s insurance to continue.
              </p>
            ) : null}
          </div>
        ) : null,
      },
      {
        id: "policyHistory",
        label: "Policy history",
        render: () => selectedRow ? (
          <div>
            <DetailKV label="Active policies on file" value={String(selectedRow.policyCount)} />
            <DetailKV label="Current policy effective" value={formatDate(selectedRow.effectiveDate)} />
            <DetailKV label="Current policy termination" value={formatDate(selectedRow.terminationDate)} />
            {selectedRow.policyCount > 1 ? (
              <p style={{ color: "#B45309", fontSize: 12, marginTop: 8 }}>
                Patient has multiple active policies — review coordination of benefits before billing.
              </p>
            ) : null}
          </div>
        ) : null,
      },
      {
        id: "pastChecks",
        label: "Past eligibility checks",
        render: () => selectedRow ? (
          <div>
            {selectedRow.lastEligibilityCheck ? (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                <li style={{ fontSize: 13, padding: "6px 0", borderBottom: "1px solid #F1F5F9" }}>
                  <strong>{formatDateTime(selectedRow.lastEligibilityCheck)}</strong>
                  <span style={{ color: "#64748B", marginLeft: 8 }}>
                    {selectedRow.eligibilityStatus}
                  </span>
                </li>
              </ul>
            ) : (
              <p style={{ color: "#94A3B8", fontSize: 13 }}>No prior checks recorded for this appointment.</p>
            )}
          </div>
        ) : null,
      },
      {
        id: "inboxComments",
        label: "Inbox comments",
        render: () => {
          if (!selectedRow) return null;
          if (!selectedRow.inboxItemId) {
            return (
              <p style={{ color: "#94A3B8", fontSize: 13 }}>
                This issue hasn&apos;t been routed to anyone yet. Once you route
                it to a clinician or admin, their replies will show up here.
              </p>
            );
          }
          const state = inboxCommentsById[selectedRow.inboxItemId];
          if (!state) {
            return (
              <button
                type="button"
                onClick={() => void loadInboxComments(selectedRow.inboxItemId!)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  color: "#334155",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Load comments
              </button>
            );
          }
          if (state.loading && state.comments.length === 0) {
            return <p style={{ color: "#64748B", fontSize: 13 }}>Loading comments…</p>;
          }
          if (state.error) {
            return <p style={{ color: "#B91C1C", fontSize: 13 }}>{state.error}</p>;
          }
          const itemId = selectedRow.inboxItemId;
          const composer = state.canComment ? (
            <div style={{ marginTop: 12, borderTop: "1px solid #E2E8F0", paddingTop: 10 }}>
              <label style={{ display: "block", fontSize: 12, color: "#475569", marginBottom: 4 }}>
                {state.commentRole === "router"
                  ? "Reply to the assignee"
                  : "Reply to the biller who routed this"}
              </label>
              <textarea
                value={state.draft}
                onChange={(e) => setCommentDraft(itemId, e.target.value)}
                rows={3}
                placeholder="Add a comment…"
                disabled={state.posting}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 6,
                  border: "1px solid #CBD5E1", fontSize: 13, resize: "vertical",
                  fontFamily: "inherit", background: state.posting ? "#F1F5F9" : "#fff",
                }}
              />
              {state.postError ? (
                <p style={{ color: "#B91C1C", fontSize: 12, margin: "6px 0 0" }}>{state.postError}</p>
              ) : null}
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                <button
                  type="button"
                  onClick={() => void postInboxComment(itemId)}
                  disabled={state.posting || state.draft.trim().length === 0}
                  style={{
                    background: state.posting || state.draft.trim().length === 0 ? "#94A3B8" : "#0F172A",
                    color: "#fff", border: "none",
                    padding: "6px 14px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                    cursor: state.posting || state.draft.trim().length === 0 ? "not-allowed" : "pointer",
                  }}
                >
                  {state.posting ? "Posting…" : "Post comment"}
                </button>
              </div>
            </div>
          ) : null;

          if (state.comments.length === 0) {
            return (
              <div>
                <p style={{ color: "#94A3B8", fontSize: 13 }}>
                  No replies from {selectedRow.assignedTo ?? "the assignee"} yet.
                </p>
                {composer}
              </div>
            );
          }
          return (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: "#64748B" }}>
                  Routed to <strong style={{ color: "#0F172A" }}>{selectedRow.assignedTo ?? "—"}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => void loadInboxComments(itemId)}
                  disabled={state.loading}
                  style={{
                    fontSize: 11.5,
                    border: "none",
                    background: "transparent",
                    color: "#1D4ED8",
                    cursor: state.loading ? "default" : "pointer",
                    padding: 0,
                  }}
                >
                  {state.loading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {state.comments.map((c) => (
                  <li
                    key={c.id}
                    style={{
                      background: "#F8FAFC",
                      border: "1px solid #E2E8F0",
                      borderRadius: 6,
                      padding: "8px 10px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: "#0F172A" }}>
                        {c.authorName}
                        {c.type && c.type !== "note" ? (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10.5,
                              fontWeight: 600,
                              textTransform: "uppercase",
                              color: "#475569",
                              background: "#E2E8F0",
                              padding: "1px 6px",
                              borderRadius: 4,
                            }}
                          >
                            {c.type.replace(/_/g, " ")}
                          </span>
                        ) : null}
                      </span>
                      <span style={{ fontSize: 11.5, color: "#94A3B8" }} title={c.createdAt}>
                        {formatDateTime(c.createdAt)}
                      </span>
                    </div>
                    <div style={{ marginTop: 4, fontSize: 13, color: "#334155", whiteSpace: "pre-wrap" }}>
                      {c.body}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        },
      },
      {
        id: "affectedClaims",
        label: "Affected claims",
        render: () => selectedRow ? (
          <div>
            {selectedRow.relatedClaimId ? (
              <div>
                <DetailKV label="Claim #" value={selectedRow.relatedClaimNumber || selectedRow.relatedClaimId.slice(0, 8)} />
                <DetailKV label="Status" value={selectedRow.claimStatus ?? "—"} />
                <DetailKV label="Total charge" value={formatCurrency(selectedRow.totalCharge)} />
                {selectedRow.holdNote ? (
                  <p style={{ color: "#B45309", fontSize: 12, marginTop: 8 }}>
                    HOLD: {selectedRow.holdNote}
                  </p>
                ) : null}
              </div>
            ) : (
              <p style={{ color: "#94A3B8", fontSize: 13 }}>No claim is attached to this appointment yet.</p>
            )}
          </div>
        ) : null,
      },
      {
        id: "documents",
        label: "Related documents",
        render: () =>
          selectedRow?.relatedClaimId ? (
            <ClaimDocumentsPanel
              claimId={selectedRow.relatedClaimId}
              organizationId={organizationId}
            />
          ) : (
            <p style={{ color: "#94A3B8", fontSize: 13 }}>
              No claim is attached to this appointment yet, so there&apos;s
              nothing to upload.
            </p>
          ),
      },
    ],
    [selectedRow, organizationId, inboxCommentsById, loadInboxComments, setCommentDraft, postInboxComment],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const busy = actingId === selectedRow.id;
    return [
      { id: "run", label: busy ? "Running…" : "Run eligibility", variant: "primary",
        onClick: () => void runEligibility(selectedRow), disabled: busy },
      { id: "update", label: "Update insurance",
        onClick: () => updateInsurance(selectedRow) },
      { id: "verify", label: "Mark verified manually", variant: "success",
        onClick: () => void performAction(selectedRow, "mark_verified"), disabled: busy },
      { id: "route_clinician", label: "Route to clinician…",
        onClick: () => void openRoutingPicker(selectedRow, "clinician"), disabled: busy },
      { id: "route_admin", label: "Route to admin…",
        onClick: () => void openRoutingPicker(selectedRow, "admin"), disabled: busy },
      { id: "hold", label: "Hold claim",
        onClick: () => void performAction(selectedRow, "hold_claim"),
        disabled: busy || !selectedRow.relatedClaimId || Boolean(selectedRow.holdNote) },
      { id: "release", label: "Release after verification",
        onClick: () => void performAction(selectedRow, "release_claim"),
        disabled: busy || !selectedRow.holdNote },
    ];
  }, [selectedRow, actingId, runEligibility, performAction, updateInsurance, openRoutingPicker]);

  // ── Tabs (counts per issueType) ─────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.issueType] = (m[r.issueType] ?? 0) + 1;
    return m;
  }, [rows]);

  return (
    <>
      {/* Tabs strip sits above the shell */}
      <div
        role="tablist"
        aria-label="Eligibility issue type"
        style={{
          display: "flex", gap: 4, padding: "12px 20px 0", background: "#fff",
          borderBottom: "1px solid #E5E7EB", flexWrap: "wrap",
        }}
      >
        {ELIGIBILITY_ISSUE_TABS.map((t) => {
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

      <WorkqueueShell<EligibilityIssueRow>
        title={queueDef?.title ?? "Eligibility Issues"}
        description={queueDef?.description}
        headerActions={[
          { id: "refresh", label: loading ? "Loading…" : "Refresh", onClick: () => void load(), disabled: loading },
        ]}
        summary={summary}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`eligibility_${activeTab}`}
        rows={filteredRows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No items in this tab."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        pulseRowId={pulseRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={error ? { tone: "error", text: error } : null}
      />

      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}

      {insuranceEditRow ? (
        <UpdateInsuranceDrawer
          row={insuranceEditRow}
          organizationId={organizationId}
          onClose={() => setInsuranceEditRow(null)}
          onSaved={handleInsuranceSaved}
          onRunEligibility={runEligibility}
        />
      ) : null}

      {routingPicker ? (
        <RoutingPickerModal
          state={routingPicker}
          onChange={(patch) =>
            setRoutingPicker((prev) => (prev ? { ...prev, ...patch } : prev))
          }
          onSubmit={() => void submitRouting()}
          onClose={() => setRoutingPicker(null)}
        />
      ) : null}
    </>
  );
}

type RoutingAssignee = {
  id: string;
  name: string;
  email: string | null;
  jobTitle: string | null;
  roles: string[];
  isAppointmentProvider: boolean;
};

type RoutingPickerProps = {
  state: {
    row: EligibilityIssueRow;
    kind: "clinician" | "admin";
    loading: boolean;
    error: string | null;
    assignees: RoutingAssignee[];
    selectedId: string;
    note: string;
    submitting: boolean;
  };
  onChange: (
    patch: Partial<{ selectedId: string; note: string; error: string | null }>,
  ) => void;
  onSubmit: () => void;
  onClose: () => void;
};

function RoutingPickerModal({ state, onChange, onSubmit, onClose }: RoutingPickerProps) {
  const kindLabel = state.kind === "clinician" ? "clinician" : "admin";
  const title =
    state.kind === "clinician" ? "Route to a specific clinician" : "Route to a specific admin";
  const canSubmit = !state.submitting && !state.loading && Boolean(state.selectedId);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 8, width: 480, maxWidth: "92vw",
          padding: 20, boxShadow: "0 16px 48px rgba(0,0,0,0.2)",
        }}
      >
        <h2 style={{ margin: "0 0 4px", fontSize: 16, color: "#0F172A" }}>{title}</h2>
        <p style={{ margin: "0 0 14px", color: "#64748B", fontSize: 13 }}>
          {state.row.clientName} · {state.row.payerName || "—"}. The selected {kindLabel}
          {" "}will get an inbox item linking back to this eligibility issue.
        </p>

        {state.loading ? (
          <p style={{ color: "#64748B", fontSize: 13 }}>Loading users…</p>
        ) : state.assignees.length === 0 ? (
          <p style={{ color: "#B45309", fontSize: 13 }}>
            No active {kindLabel}s found in this organization. Add one before routing.
          </p>
        ) : (
          <label style={{ display: "block", fontSize: 13, marginBottom: 10 }}>
            <span style={{ display: "block", color: "#334155", marginBottom: 4 }}>
              Assign to
            </span>
            <select
              value={state.selectedId}
              onChange={(e) => onChange({ selectedId: e.target.value })}
              style={{
                width: "100%", padding: "8px 10px", borderRadius: 6,
                border: "1px solid #CBD5E1", fontSize: 14, background: "#fff",
              }}
            >
              <option value="" disabled>Pick a user…</option>
              {state.assignees.map((a) => {
                const suffix = [
                  a.jobTitle,
                  a.email,
                  a.isAppointmentProvider ? "appointment provider" : null,
                ].filter(Boolean).join(" · ");
                return (
                  <option key={a.id} value={a.id}>
                    {a.name}{suffix ? ` — ${suffix}` : ""}
                  </option>
                );
              })}
            </select>
          </label>
        )}

        <label style={{ display: "block", fontSize: 13, marginBottom: 10 }}>
          <span style={{ display: "block", color: "#334155", marginBottom: 4 }}>
            Note for the assignee (optional)
          </span>
          <textarea
            value={state.note}
            onChange={(e) => onChange({ note: e.target.value })}
            rows={3}
            placeholder="What needs verifying before billing?"
            style={{
              width: "100%", padding: "8px 10px", borderRadius: 6,
              border: "1px solid #CBD5E1", fontSize: 14, resize: "vertical",
              fontFamily: "inherit",
            }}
          />
        </label>

        {state.error ? (
          <p style={{ color: "#B91C1C", fontSize: 13, marginTop: 0 }}>{state.error}</p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={state.submitting}
            style={{
              background: "transparent", color: "#475569", border: "1px solid #CBD5E1",
              padding: "7px 14px", borderRadius: 6, fontSize: 14, cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            style={{
              background: canSubmit ? "#0F172A" : "#94A3B8", color: "#fff",
              border: "none", padding: "7px 14px", borderRadius: 6, fontSize: 14,
              cursor: canSubmit ? "pointer" : "not-allowed", fontWeight: 600,
            }}
          >
            {state.submitting ? "Routing…" : `Route to ${kindLabel}`}
          </button>
        </div>
      </div>
    </div>
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
