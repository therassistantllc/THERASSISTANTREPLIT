"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { DEFAULT_ORG_ID } from "@/lib/config";
import styles from "./ClaimsWorkspace.module.css";

// ─── Lifecycle taxonomy ────────────────────────────────────────────────────

type LifecycleTab = "needs_attention" | "submitted" | "follow_up" | "resolutions";
type ChipTone = "info" | "pending" | "urgent" | "resolved" | "neutral";

interface ChipDef {
  id: string;
  label: string;
  tone: ChipTone;
  /** Optional server-side query value for the endpoint's `tab` param. */
  serverTab?: string;
  /** Optional client-side predicate. If both serverTab and predicate
   *  exist, serverTab is used to scope the fetch and predicate is also
   *  applied. Chips without backing logic are simply not rendered. */
  predicate?: (r: ClaimRow) => boolean;
}

interface LifecycleDef {
  id: LifecycleTab;
  label: string;
  description: string;
  chips: ChipDef[];
}

const LIFECYCLES: LifecycleDef[] = [
  {
    id: "needs_attention",
    label: "Needs Attention",
    description: "Claims stuck somewhere — pick a reason and clear them.",
    chips: [
      { id: "no_payer_response", label: "No payer response", tone: "pending",
        predicate: (r) => r.bucket === "no_payer_status" },
      { id: "no_277ca", label: "Missing 277CA", tone: "pending",
        predicate: (r) => r.bucket === "no_277ca" },
      { id: "no_999", label: "Missing 999", tone: "pending",
        predicate: (r) => r.bucket === "no_999" },
      { id: "no_era", label: "Missing ERA", tone: "pending",
        predicate: (r) => r.bucket === "no_era" },
      { id: "past_follow_up", label: "Past follow-up date", tone: "urgent",
        predicate: (r) => r.bucket === "past_follow_up" },
      { id: "timely_filing", label: "Timely-filing risk", tone: "urgent",
        predicate: (r) => (r.daysOut ?? 0) > 90 },
    ],
  },
  {
    id: "submitted",
    label: "Submitted",
    description: "Out the door, awaiting payer acknowledgement.",
    chips: [
      { id: "today", label: "Submitted today", tone: "info", serverTab: "today" },
      { id: "awaiting_999", label: "Awaiting 999 ack", tone: "pending", serverTab: "awaiting_999" },
      { id: "awaiting_277ca", label: "Awaiting 277CA", tone: "pending", serverTab: "awaiting_277ca" },
      { id: "awaiting_payer", label: "Awaiting payer response", tone: "pending", serverTab: "awaiting_payer" },
      { id: "no_response_risk", label: "No-response risk", tone: "urgent", serverTab: "no_response_risk" },
    ],
  },
  {
    id: "follow_up",
    label: "Follow-Up",
    description: "Appeals filed, corrections sent, awaiting outcome.",
    chips: [
      { id: "appeals", label: "Appeals", tone: "info", serverTab: "draft_needed" },
      { id: "corrected", label: "Corrected claims", tone: "info", serverTab: "draft_ready" },
      { id: "resubmissions", label: "Resubmissions", tone: "pending", serverTab: "sent" },
      { id: "cob", label: "COB issues", tone: "pending", serverTab: "pending" },
      { id: "secondary", label: "Secondary billing", tone: "info", serverTab: "pending" },
      { id: "overdue", label: "Overdue", tone: "urgent", serverTab: "overdue" },
    ],
  },
  {
    id: "resolutions",
    label: "Resolutions",
    description: "Closed out — written off, refunded, transferred to client.",
    chips: [
      { id: "write_offs", label: "Write-offs", tone: "resolved", serverTab: "recent" },
      { id: "patient_resp", label: "Client responsibility", tone: "neutral", serverTab: "recent" },
      { id: "bad_debt", label: "Bad debt", tone: "neutral", serverTab: "by_reason" },
      { id: "credit_balance", label: "Credit balances", tone: "neutral", serverTab: "reversals" },
      { id: "recoupments", label: "Recoupments", tone: "pending", serverTab: "reversals" },
    ],
  },
];

const LIFECYCLE_BY_ID: Record<LifecycleTab, LifecycleDef> = Object.fromEntries(
  LIFECYCLES.map((l) => [l.id, l]),
) as Record<LifecycleTab, LifecycleDef>;

// ─── Unified UI row ────────────────────────────────────────────────────────

interface ClaimRow {
  id: string;
  claimNumber: string;
  patientName: string;
  patientId: string | null;
  dosFrom: string | null;
  dosTo: string | null;
  payer: string;
  totalCharge: number;
  balance: number;
  daysOut: number | null;
  issue: { label: string; tone: ChipTone };
  lastAction: string;
  lastActionAt: string | null;
  assignee: string | null;
  followUp: string | null;
  /** Used by needs_attention chip predicates. */
  bucket?: string;
  /** Denial codes (when present from aging endpoint). */
  carcCodes?: string[];
  rarcCodes?: string[];
}

interface ClaimStatusBatchSummary {
  id: string;
  batch_number: string;
  batch_status: string;
  claim_count: number;
  payer_id: string;
  billing_provider_tax_id: string;
  generated_file_name: string | null;
  generated_at: string | null;
  downloaded_at: string | null;
  submitted_at: string | null;
  created_at: string;
}

// ─── Per-lifecycle endpoint adapters ───────────────────────────────────────

// Each tab fetches from a different backend bucket. Adapters normalize
// to the unified ClaimRow shape so the workspace UI stays consistent.

/** Map raw API claim/clearinghouse statuses to user-facing labels. */
function friendlyClaimStatus(raw: string | null | undefined): string {
  switch ((raw ?? "").toLowerCase()) {
    case "batched":       return "Submitted";
    case "submitted":     return "Submitted";
    case "accepted_oa":   return "Acknowledged";
    case "rejected_oa":   return "Rejected";
    case "accepted_payer": return "Processing";
    case "adjudicated":   return "Adjudicated";
    case "paid":          return "Adjudicated";
    case "denied":        return "Denied";
    case "partial":       return "Processing";
    default:              return raw ? raw.replace(/_/g, " ") : "Submitted";
  }
}

interface FetchContext {
  organizationId: string;
  chip?: ChipDef; // single active chip when applicable (for server-tab scoping)
}

async function fetchNeedsAttention(ctx: FetchContext): Promise<ClaimRow[]> {
  const p = new URLSearchParams({ organizationId: ctx.organizationId });
  const json = await fetchJson(`/api/billing/no-response?${p}`);
  const items = (json.items ?? []) as Array<any>;
  return items.map((r): ClaimRow => {
    const days = r.days_outstanding ?? 0;
    const issue = humanIssueForBucket(r.missing_artifact, days);
    return {
      id: String(r.id),
      claimNumber: r.claim_number || `(no claim #) ${String(r.id).slice(0, 6)}`,
      patientName: r.patient_name || "Unknown client",
      patientId: r.patient_id ?? null,
      dosFrom: r.service_date_from ?? null,
      dosTo: r.service_date_to ?? null,
      payer: r.payer_name || "—",
      totalCharge: Number(r.total_charge ?? 0),
      balance: Number(r.total_charge ?? 0),
      daysOut: r.days_outstanding ?? null,
      issue,
      lastAction: r.latest_note_excerpt || `Status: ${r.last_known_status || "unknown"}`,
      lastActionAt: r.latest_note_at ?? r.last_status_at ?? null,
      assignee: r.assigned_to_display_name ?? null,
      followUp: r.follow_up_due_date ?? null,
      bucket: r.missing_artifact,
    };
  });
}

async function fetchSubmitted(ctx: FetchContext): Promise<ClaimRow[]> {
  const p = new URLSearchParams({ organizationId: ctx.organizationId });
  if (ctx.chip?.serverTab) p.set("tab", ctx.chip.serverTab);
  const json = await fetchJson(`/api/billing/submitted-claims?${p}`);
  const rows = (json.rows ?? []) as Array<any>;
  return rows.map((r): ClaimRow => {
    const days = Number(r.daysSinceSubmission ?? 0);
    const issueTone: ChipTone = days > 30 ? "urgent" : days > 14 ? "pending" : "info";
    return {
      id: String(r.id),
      claimNumber: r.claimNumber ?? String(r.id).slice(0, 8),
      patientName: r.patientName ?? "Unknown client",
      patientId: r.patientId ?? null,
      dosFrom: r.serviceDateFrom ?? null,
      dosTo: r.serviceDateTo ?? null,
      payer: r.payerName ?? "—",
      totalCharge: Number(r.chargeAmount ?? 0),
      balance: Number(r.chargeAmount ?? 0),
      daysOut: days,
      issue: { label: friendlyClaimStatus(r.clearinghouseStatus || r.claimStatus), tone: issueTone },
      lastAction: r.batchNumber ? `Batch ${r.batchNumber}` : `Submitted ${fmtRelative(r.submittedAt)}`,
      lastActionAt: r.submittedAt ?? null,
      assignee: null,
      followUp: null,
    };
  });
}

async function fetchFollowUp(ctx: FetchContext): Promise<ClaimRow[]> {
  const p = new URLSearchParams({ organizationId: ctx.organizationId });
  if (ctx.chip?.serverTab) p.set("tab", ctx.chip.serverTab);
  const json = await fetchJson(`/api/billing/appeals?${p}`);
  const rows = (json.rows ?? []) as Array<any>;
  return rows.map((r): ClaimRow => {
    const days = Number(r.ageDays ?? 0);
    const tone: ChipTone = r.priority === "urgent" ? "urgent" : r.priority === "high" ? "pending" : "info";
    return {
      id: String(r.id),
      claimNumber: r.claimNumber ?? String(r.id).slice(0, 8),
      patientName: r.clientName ?? "Unknown client",
      patientId: r.clientId ?? null,
      dosFrom: r.serviceDateFrom ?? null,
      dosTo: r.serviceDateTo ?? null,
      payer: r.payerName ?? "—",
      totalCharge: Number(r.totalCharge ?? r.deniedAmount ?? 0),
      balance: Number(r.deniedAmount ?? r.totalCharge ?? 0),
      daysOut: days,
      issue: { label: `Appeal: ${r.status || "draft"}`, tone },
      lastAction: r.deadline ? `Deadline ${fmtDate(r.deadline)}` : `Age ${days}d`,
      lastActionAt: r.deadline ?? null,
      assignee: r.assigneeName ?? null,
      followUp: r.deadline ?? null,
    };
  });
}

async function fetchResolutions(ctx: FetchContext): Promise<ClaimRow[]> {
  const p = new URLSearchParams({ organizationId: ctx.organizationId });
  if (ctx.chip?.serverTab) p.set("tab", ctx.chip.serverTab);
  const json = await fetchJson(`/api/billing/write-offs?${p}`);
  const items = (json.items ?? []) as Array<any>;
  return items.map((r): ClaimRow => ({
    id: String(r.id ?? r.claim_id ?? Math.random()),
    claimNumber: r.claim_number ?? String(r.id ?? "").slice(0, 8),
    patientName: r.patient_name ?? r.client_name ?? "Unknown client",
    patientId: r.patient_id ?? null,
    dosFrom: r.service_date_from ?? null,
    dosTo: r.service_date_to ?? null,
    payer: r.payer_name ?? "—",
    totalCharge: Number(r.total_charge ?? r.amount ?? 0),
    balance: 0,
    daysOut: r.age_days ?? null,
    issue: { label: r.reason || "Written off", tone: "resolved" },
    lastAction: r.posted_at ? `Posted ${fmtRelative(r.posted_at)}` : "Resolved",
    lastActionAt: r.posted_at ?? r.created_at ?? null,
    assignee: r.posted_by_name ?? null,
    followUp: null,
  }));
}

const FETCHERS: Record<LifecycleTab, (ctx: FetchContext) => Promise<ClaimRow[]>> = {
  needs_attention: fetchNeedsAttention,
  submitted: fetchSubmitted,
  follow_up: fetchFollowUp,
  resolutions: fetchResolutions,
};

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// ─── Helpers ───────────────────────────────────────────────────────────────

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
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

function fmtRelative(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days < 0) return `in ${-days}d`;
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function dosLabel(from: string | null, to: string | null): string {
  if (!from && !to) return "—";
  if (from && to && from !== to) return `${fmtDate(from)} – ${fmtDate(to)}`;
  return fmtDate(from || to);
}

function initials(name: string | null): string {
  if (!name) return "??";
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function humanIssueForBucket(bucket: string, days: number): { label: string; tone: ChipTone } {
  switch (bucket) {
    case "no_999":
      return { label: `No 999 ack ${days}d`, tone: days > 7 ? "urgent" : "pending" };
    case "no_277ca":
      return { label: `No 277CA ${days}d`, tone: days > 14 ? "urgent" : "pending" };
    case "no_payer_status":
      return { label: `No payer response ${days}d`, tone: days > 60 ? "urgent" : "pending" };
    case "no_era":
      return { label: `Awaiting ERA ${days}d`, tone: days > 45 ? "urgent" : "pending" };
    case "past_follow_up":
      return { label: "Past follow-up date", tone: "urgent" };
    default:
      return { label: `${bucket} · ${days}d`, tone: "pending" };
  }
}

function findChip(tab: LifecycleTab, chipId: string): ChipDef | undefined {
  return LIFECYCLE_BY_ID[tab].chips.find((c) => c.id === chipId);
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function ClaimsWorkspace() {
  const router = useRouter();
  const pathname = usePathname() ?? "/billing/claims";
  const searchParams = useSearchParams();

  const initialTab = (searchParams?.get("tab") as LifecycleTab) || "needs_attention";
  const initialFilter = searchParams?.get("filter") || "";
  const initialQuery = searchParams?.get("q") || "";

  const [activeTab, setActiveTab] = useState<LifecycleTab>(
    LIFECYCLE_BY_ID[initialTab] ? initialTab : "needs_attention",
  );
  const [activeChips, setActiveChips] = useState<string[]>(() => {
    if (!initialFilter) return [];
    const startTab = LIFECYCLE_BY_ID[initialTab] ? initialTab : "needs_attention";
    return initialFilter
      .split(",")
      .filter(Boolean)
      .filter((id) => findChip(startTab, id));
  });
  const [query, setQuery] = useState(initialQuery);
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [selectedClaimIds, setSelectedClaimIds] = useState<string[]>([]);
  const [drawerTab, setDrawerTab] = useState<DrawerTabId>("timeline");
  const [recentlyPostedCount, setRecentlyPostedCount] = useState(0);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [statusBatches, setStatusBatches] = useState<ClaimStatusBatchSummary[]>([]);

  // URL sync
  useEffect(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (activeTab !== "needs_attention") params.set("tab", activeTab);
    else params.delete("tab");
    if (activeChips.length > 0) params.set("filter", activeChips.join(","));
    else params.delete("filter");
    if (query) params.set("q", query);
    else params.delete("q");
    const next = params.toString();
    const target = `${pathname}${next ? `?${next}` : ""}`;
    const current = `${pathname}${searchParams?.toString() ? `?${searchParams.toString()}` : ""}`;
    if (target !== current) router.replace(target, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, activeChips.join(","), query]);

  // Per-tab data fetch. Refetches when tab or first server-scoping chip changes.
  const firstServerChipId = activeChips.find((id) => findChip(activeTab, id)?.serverTab) ?? null;
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const chip = firstServerChipId ? findChip(activeTab, firstServerChipId) : undefined;
        const data = await FETCHERS[activeTab]({
          organizationId: getOrganizationId(),
          chip,
        });
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) {
          setRows([]);
          setError(e instanceof Error ? e.message : "Could not load claims");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeTab, firstServerChipId]);

  useEffect(() => {
    if (activeTab !== "submitted") {
      setSelectedClaimIds([]);
      return;
    }
    setSelectedClaimIds((prev) => prev.filter((id) => rows.some((r) => r.id === id)));
  }, [activeTab, rows]);

  const loadStatusBatches = useCallback(async () => {
    try {
      const p = new URLSearchParams({ organizationId: getOrganizationId() });
      const json = await fetchJson(`/api/billing/claims/status-batches?${p}`);
      setStatusBatches((json.batches ?? []) as ClaimStatusBatchSummary[]);
    } catch {
      setStatusBatches([]);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "submitted") {
      void loadStatusBatches();
    }
  }, [activeTab, loadStatusBatches]);

  // Fetch the "Recently Posted Today" KPI from write-offs (recent ledger postings).
  useEffect(() => {
    let cancelled = false;
    async function loadPosted() {
      try {
        const p = new URLSearchParams({ organizationId: getOrganizationId(), tab: "recent" });
        const json = await fetchJson(`/api/billing/write-offs?${p}`);
        if (cancelled) return;
        const items = (json.items ?? []) as Array<any>;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayCount = items.filter((it) => {
          const t = it.posted_at || it.created_at;
          if (!t) return false;
          return new Date(t).getTime() >= today.getTime();
        }).length;
        setRecentlyPostedCount(todayCount);
      } catch {
        if (!cancelled) setRecentlyPostedCount(0);
      }
    }
    void loadPosted();
    return () => {
      cancelled = true;
    };
  }, []);

  const lifecycle = LIFECYCLE_BY_ID[activeTab];

  const filtered: ClaimRow[] = useMemo(() => {
    // Apply client-side chip predicates (OR semantics across selected chips).
    // Chips that only have serverTab (no predicate) are already reflected
    // in the fetched data set; skip them here.
    const clientChipPreds = activeChips
      .map((id) => findChip(activeTab, id)?.predicate)
      .filter((p): p is (r: ClaimRow) => boolean => !!p);

    let out = rows;
    if (clientChipPreds.length > 0) {
      out = out.filter((r) => clientChipPreds.some((p) => p(r)));
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter(
        (r) =>
          r.patientName.toLowerCase().includes(q) ||
          r.claimNumber.toLowerCase().includes(q) ||
          r.payer.toLowerCase().includes(q),
      );
    }
    return out;
  }, [rows, activeTab, activeChips, query]);

  const kpis = useMemo(() => {
    const requiringAction = filtered.length;
    const atRiskValue = filtered
      .filter((r) => r.issue.tone === "urgent" || (r.daysOut ?? 0) > 60)
      .reduce((sum, r) => sum + (r.balance || r.totalCharge || 0), 0);
    const avgDays = filtered.length
      ? Math.round(filtered.reduce((sum, r) => sum + (r.daysOut ?? 0), 0) / filtered.length)
      : 0;
    const urgent = filtered.filter((r) => r.issue.tone === "urgent").length;
    return { requiringAction, atRiskValue, avgDays, urgent };
  }, [filtered]);

  const selectedRow = useMemo(
    () => filtered.find((r) => r.id === selectedRowId) ?? null,
    [filtered, selectedRowId],
  );

  const closeDrawer = useCallback(() => setSelectedRowId(null), []);

  const selectedCount = selectedClaimIds.length;
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((r) => selectedClaimIds.includes(r.id));

  const toggleSelectedClaim = (claimId: string) => {
    setSelectedClaimIds((prev) =>
      prev.includes(claimId) ? prev.filter((id) => id !== claimId) : [...prev, claimId],
    );
  };

  const toggleSelectAllVisible = () => {
    if (filtered.length === 0) return;
    if (allVisibleSelected) {
      setSelectedClaimIds([]);
      return;
    }
    setSelectedClaimIds(filtered.map((r) => r.id));
  };

  const generateStatusBatch = async () => {
    if (selectedClaimIds.length === 0) return;
    setBatchBusy(true);
    setBatchMessage(null);
    setBatchError(null);
    try {
      const res = await fetch("/api/billing/claims/status-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: getOrganizationId(), claimIds: selectedClaimIds }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to create 276 batch");
      }
      const excluded = Array.isArray(json.excludedClaims) ? json.excludedClaims.length : 0;
      setBatchMessage(
        `Created ${json.batchesCreated ?? 0} batch(es).${excluded > 0 ? ` Excluded ${excluded} claim(s).` : ""}`,
      );
      setSelectedClaimIds([]);
      await loadStatusBatches();
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : "Failed to create 276 batch");
    } finally {
      setBatchBusy(false);
    }
  };

  const downloadStatusBatch = async (batchId: string) => {
    setBatchError(null);
    try {
      const p = new URLSearchParams({ organizationId: getOrganizationId() });
      const res = await fetch(`/api/billing/claims/status-batches/${encodeURIComponent(batchId)}/download?${p}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? "Failed to download 276 batch");
      }
      const fileName =
        res.headers.get("Content-Disposition")?.match(/filename=\"?([^\";]+)\"?/)?.[1] ||
        `${batchId}.edi`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      await loadStatusBatches();
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : "Failed to download 276 batch");
    }
  };

  const markStatusBatchSubmitted = async (batchId: string) => {
    setBatchError(null);
    try {
      const res = await fetch(`/api/billing/claims/status-batches/${encodeURIComponent(batchId)}/mark-submitted`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: getOrganizationId() }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to mark 276 submitted");
      await loadStatusBatches();
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : "Failed to mark 276 submitted");
    }
  };

  useEffect(() => {
    if (!selectedRowId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDrawer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRowId, closeDrawer]);

  const toggleChip = (id: string) => {
    setActiveChips((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  };

  const switchTab = (tab: LifecycleTab) => {
    setActiveTab(tab);
    setActiveChips([]);
    setSelectedRowId(null);
  };

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Claims</h1>
          <p className={styles.subtitle}>{lifecycle.description}</p>
        </div>
        <div className={styles.headerSearch}>
          <input
            type="search"
            placeholder="Search client, claim #, payer…"
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </header>

      {/* KPI tiles */}
      <div className={styles.kpiRow}>
        <div className={styles.kpiTile}>
          <span className={styles.kpiLabel}>Claims Requiring Action</span>
          <span className={`${styles.kpiValue} ${kpis.urgent > 0 ? styles.kpiValueUrgent : ""}`}>
            {kpis.requiringAction}
          </span>
          <span className={styles.kpiSub}>{kpis.urgent} urgent</span>
        </div>
        <div className={styles.kpiTile}>
          <span className={styles.kpiLabel}>At-Risk Value</span>
          <span className={`${styles.kpiValue} ${kpis.atRiskValue > 10000 ? styles.kpiValueUrgent : kpis.atRiskValue > 0 ? styles.kpiValuePending : ""}`}>
            {fmtMoney(kpis.atRiskValue)}
          </span>
          <span className={styles.kpiSub}>Aged or urgent</span>
        </div>
        <div className={styles.kpiTile}>
          <span className={styles.kpiLabel}>Avg Days Outstanding</span>
          <span className={`${styles.kpiValue} ${kpis.avgDays > 60 ? styles.kpiValueUrgent : kpis.avgDays > 30 ? styles.kpiValuePending : ""}`}>
            {kpis.avgDays}d
          </span>
          <span className={styles.kpiSub}>Current view</span>
        </div>
        <div className={styles.kpiTile}>
          <span className={styles.kpiLabel}>Recently Posted Today</span>
          <span className={`${styles.kpiValue} ${styles.kpiValueResolved}`}>
            {recentlyPostedCount}
          </span>
          <span className={styles.kpiSub}>From ERA + manual</span>
        </div>
      </div>

      {/* Lifecycle tabs */}
      <div className={styles.tabBar} role="tablist" aria-label="Claim lifecycle">
        {LIFECYCLES.map((l) => {
          const isActive = l.id === activeTab;
          return (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`${styles.tab} ${isActive ? styles.tabActive : ""}`}
              onClick={() => switchTab(l.id)}
            >
              {l.label}
            </button>
          );
        })}
      </div>

      {/* Filter chip strip */}
      {lifecycle.chips.length > 0 ? (
        <div className={styles.chipStrip}>
          <span className={styles.chipLabel}>Filter</span>
          {lifecycle.chips.map((c) => {
            const isActive = activeChips.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                className={`${styles.chip} ${isActive ? styles.chipActive : ""}`}
                onClick={() => toggleChip(c.id)}
                aria-pressed={isActive}
              >
                {c.label}
              </button>
            );
          })}
          {activeChips.length > 0 ? (
            <button type="button" className={styles.clearLink} onClick={() => setActiveChips([])}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}

      {activeTab === "submitted" ? (
        <section className={styles.batchToolbar}>
          <div className={styles.batchToolbarRow}>
            <button type="button" className={styles.batchButton} onClick={toggleSelectAllVisible}>
              {allVisibleSelected ? "Clear Selection" : "Select All Visible"}
            </button>
            <span className={styles.batchMeta}>{selectedCount} selected</span>
            <button
              type="button"
              className={`${styles.batchButton} ${styles.batchButtonPrimary}`}
              onClick={() => void generateStatusBatch()}
              disabled={selectedCount === 0 || batchBusy}
            >
              {batchBusy ? "Generating..." : "Generate 276 Batch"}
            </button>
          </div>
          {batchMessage ? <div className={styles.batchSuccess}>{batchMessage}</div> : null}
          {batchError ? <div className={styles.batchError}>{batchError}</div> : null}
        </section>
      ) : null}

      {/* Body — table */}
      <div className={styles.tableWrap}>
        {loading ? (
          <div className={styles.loading}>Loading claims…</div>
        ) : filtered.length === 0 ? (
          <div className={styles.empty}>
            Nothing matches the current view. Try clearing filters or switching tabs.
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                {activeTab === "submitted" ? <th style={{ width: 44 }}>Select</th> : null}
                <th>Client</th>
                <th>DOS</th>
                <th>Payer</th>
                <th>Issue</th>
                <th style={{ textAlign: "right" }}>Balance</th>
                <th>Last Action</th>
                <th>Assigned</th>
                <th>Next Follow-Up</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isSelected = r.id === selectedRowId;
                const isUrgent = r.issue.tone === "urgent";
                return (
                  <tr
                    key={r.id}
                    className={`${isUrgent ? styles.rowUrgent : ""} ${isSelected ? styles.rowSelected : ""}`}
                    onClick={() => {
                      setSelectedRowId(r.id);
                      setDrawerTab("timeline");
                    }}
                  >
                    {activeTab === "submitted" ? (
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedClaimIds.includes(r.id)}
                          onChange={() => toggleSelectedClaim(r.id)}
                          aria-label={`Select claim ${r.claimNumber}`}
                        />
                      </td>
                    ) : null}
                    <td>
                      <div className={styles.patientCell}>{r.patientName}</div>
                      <div className={styles.patientSub}>Claim {r.claimNumber}</div>
                    </td>
                    <td className={styles.dateCell}>{dosLabel(r.dosFrom, r.dosTo)}</td>
                    <td>{r.payer}</td>
                    <td>
                      <span className={`${styles.issueBadge} ${toneClass(r.issue.tone)}`}>
                        {r.issue.label}
                      </span>
                    </td>
                    <td className={styles.moneyCell}>{fmtMoney(r.balance)}</td>
                    <td>
                      <div style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.lastAction}
                      </div>
                      <div className={styles.patientSub}>{fmtRelative(r.lastActionAt)}</div>
                    </td>
                    <td>
                      {r.assignee ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span className={styles.avatar}>{initials(r.assignee)}</span>
                          <span style={{ fontSize: 12 }}>{r.assignee}</span>
                        </span>
                      ) : (
                        <span className={`${styles.avatar} ${styles.avatarUnassigned}`} title="Unassigned">
                          —
                        </span>
                      )}
                    </td>
                    <td className={styles.dateCell}>
                      {r.followUp ? fmtDate(r.followUp) : <span style={{ color: "#94A3B8" }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {activeTab === "submitted" && statusBatches.length > 0 ? (
        <section className={styles.statusBatchesPanel}>
          <h3 className={styles.statusBatchesTitle}>276 Batch History</h3>
          <div className={styles.statusBatchesList}>
            {statusBatches.map((batch) => (
              <div key={batch.id} className={styles.statusBatchCard}>
                <div>
                  <strong>{batch.batch_number}</strong>
                  <div className={styles.patientSub}>
                    {batch.claim_count} claims · Payer {batch.payer_id} · TIN {batch.billing_provider_tax_id}
                  </div>
                  <div className={styles.patientSub}>Status: {batch.batch_status}</div>
                </div>
                <div className={styles.statusBatchActions}>
                  <button
                    type="button"
                    className={styles.batchButton}
                    onClick={() => void downloadStatusBatch(batch.id)}
                  >
                    Download
                  </button>
                  <button
                    type="button"
                    className={styles.batchButton}
                    onClick={() => void markStatusBatchSubmitted(batch.id)}
                    disabled={batch.batch_status === "submitted"}
                  >
                    Mark Submitted
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Drawer */}
      {selectedRow ? (
        <>
          <div className={styles.drawerBackdrop} onClick={closeDrawer} />
          <aside
            className={styles.drawer}
            role="dialog"
            aria-label={`Claim ${selectedRow.claimNumber}`}
          >
            <header className={styles.drawerHeader}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h2 className={styles.drawerTitle}>{selectedRow.patientName}</h2>
                <p className={styles.drawerSubtitle}>
                  Claim {selectedRow.claimNumber} · {selectedRow.payer} · {fmtMoney(selectedRow.balance)}
                </p>
              </div>
              <button type="button" className={styles.closeBtn} onClick={closeDrawer} aria-label="Close">
                ×
              </button>
            </header>
            <nav className={styles.drawerTabs} aria-label="Claim activity">
              {DRAWER_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`${styles.drawerTab} ${drawerTab === t.id ? styles.drawerTabActive : ""}`}
                  onClick={() => setDrawerTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <div className={styles.drawerBody}>
              <DrawerContent tab={drawerTab} row={selectedRow} />
            </div>
            <div className={styles.drawerActions}>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`}>
                Log call outcome
              </button>
              <button type="button" className={styles.btn}>
                Resubmit
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnDanger}`}>
                Write off
              </button>
              <Link
                href={`/billing/claims/${selectedRow.id}`}
                className={styles.btn}
                style={{ marginLeft: "auto", textDecoration: "none", display: "inline-flex", alignItems: "center" }}
              >
                Open full record →
              </Link>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}

// ─── Drawer ───────────────────────────────────────────────────────────────

type DrawerTabId =
  | "timeline"
  | "notes"
  | "attachments"
  | "status_history"
  | "era_history"
  | "appeal_history"
  | "audit_trail";

const DRAWER_TABS: Array<{ id: DrawerTabId; label: string }> = [
  { id: "timeline", label: "Timeline" },
  { id: "notes", label: "Notes" },
  { id: "attachments", label: "Attachments" },
  { id: "status_history", label: "Status History" },
  { id: "era_history", label: "ERA History" },
  { id: "appeal_history", label: "Appeal History" },
  { id: "audit_trail", label: "Audit Trail" },
];

function DrawerContent({ tab, row }: { tab: DrawerTabId; row: ClaimRow }) {
  switch (tab) {
    case "timeline":
      return (
        <>
          <div className={styles.section}>
            <h4>Claim summary</h4>
            <div className={styles.kvGrid}>
              <span className={styles.kvKey}>Claim #</span>
              <span className={styles.kvVal}>{row.claimNumber}</span>
              <span className={styles.kvKey}>Payer</span>
              <span className={styles.kvVal}>{row.payer}</span>
              <span className={styles.kvKey}>Date of service</span>
              <span className={styles.kvVal}>{dosLabel(row.dosFrom, row.dosTo)}</span>
              <span className={styles.kvKey}>Days outstanding</span>
              <span className={styles.kvVal}>{row.daysOut ?? "—"}</span>
              <span className={styles.kvKey}>Total charge</span>
              <span className={styles.kvVal}>{fmtMoney(row.totalCharge)}</span>
              <span className={styles.kvKey}>Balance</span>
              <span className={styles.kvVal}>{fmtMoney(row.balance)}</span>
            </div>
          </div>
          <div className={styles.section}>
            <h4>Lifecycle</h4>
            <ul className={styles.timelineList}>
              <li className={styles.timelineItem}>
                <span className={`${styles.timelineDot} ${styles.timelineDotPending}`} />
                <div className={styles.timelineMain}>
                  <div className={styles.timelineLabel}>{row.issue.label}</div>
                  <div className={styles.timelineMeta}>{fmtRelative(row.lastActionAt)}</div>
                </div>
              </li>
              {row.followUp ? (
                <li className={styles.timelineItem}>
                  <span className={styles.timelineDot} />
                  <div className={styles.timelineMain}>
                    <div className={styles.timelineLabel}>Next follow-up scheduled</div>
                    <div className={styles.timelineMeta}>{fmtDate(row.followUp)}</div>
                  </div>
                </li>
              ) : null}
            </ul>
          </div>
        </>
      );
    case "notes":
      return <div className={styles.emptyTabState}>Notes and call outcomes appear here. Use “Log call outcome” to add the first one.</div>;
    case "attachments":
      return <div className={styles.emptyTabState}>EOBs, payer letters, and supporting docs attached to this claim appear here.</div>;
    case "status_history":
      return (
        <div className={styles.section}>
          <h4>Current status</h4>
          <div className={styles.kvGrid}>
            <span className={styles.kvKey}>State</span>
            <span className={styles.kvVal}>{row.issue.label}</span>
            <span className={styles.kvKey}>As of</span>
            <span className={styles.kvVal}>{fmtRelative(row.lastActionAt)}</span>
          </div>
        </div>
      );
    case "era_history":
      return <div className={styles.emptyTabState}>835 / ERA payments that touched this claim show up here once received.</div>;
    case "appeal_history":
      return <div className={styles.emptyTabState}>Appeals drafted, sent, and decided for this claim live here.</div>;
    case "audit_trail":
      return <div className={styles.emptyTabState}>Every user action against this claim, in order, with who/when.</div>;
  }
}

function toneClass(t: ChipTone): string {
  switch (t) {
    case "info": return styles.tInfo;
    case "pending": return styles.tPending;
    case "urgent": return styles.tUrgent;
    case "resolved": return styles.tResolved;
    case "neutral": return styles.tNeutral;
  }
}
