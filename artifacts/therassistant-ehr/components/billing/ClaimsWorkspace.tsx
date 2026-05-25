"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { DEFAULT_ORG_ID } from "@/lib/config";
import styles from "./ClaimsWorkspace.module.css";

// ─── Lifecycle taxonomy ────────────────────────────────────────────────────

type LifecycleTab = "needs_attention" | "submitted" | "denials" | "follow_up" | "resolutions";

type ChipTone = "info" | "pending" | "urgent" | "resolved" | "neutral";

interface ChipDef {
  id: string;
  label: string;
  tone: ChipTone;
  /** Maps to the no-response API `tab` param when the chip is on the
   *  Needs Attention tab; null means "no automatic filter — just narrows
   *  the underlying queue". */
  noResponseTab?: "no_999" | "no_277ca" | "no_payer_status" | "no_era" | "past_follow_up";
  /** Optional deep-link target for chips whose detailed view lives in an
   *  existing per-queue page. Clicking the chip's "Open full queue" link
   *  routes there; selecting the chip just filters the table. */
  deepLink?: string;
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
      { id: "no_payer_status", label: "No payer response", tone: "pending", noResponseTab: "no_payer_status", deepLink: "/billing/no-response" },
      { id: "no_277ca", label: "Missing 277CA", tone: "pending", noResponseTab: "no_277ca", deepLink: "/billing/rejections-277ca" },
      { id: "no_999", label: "Missing 999", tone: "pending", noResponseTab: "no_999", deepLink: "/billing/rejections-999" },
      { id: "no_era", label: "Missing ERA", tone: "pending", noResponseTab: "no_era", deepLink: "/billing/era-import" },
      { id: "past_follow_up", label: "Past follow-up date", tone: "urgent", noResponseTab: "past_follow_up" },
      { id: "timely_filing", label: "Timely-filing risk", tone: "urgent", deepLink: "/billing/timely-filing" },
      { id: "auth_required", label: "Auth required", tone: "info", deepLink: "/billing/authorization-required" },
      { id: "credentialing", label: "Credentialing issue", tone: "info", deepLink: "/billing/provider-enrollment-issues" },
      { id: "duplicate", label: "Duplicate review", tone: "info", deepLink: "/billing/duplicate-claim-review" },
    ],
  },
  {
    id: "submitted",
    label: "Submitted",
    description: "Out the door, awaiting payer.",
    chips: [
      { id: "payer_received", label: "Payer received", tone: "info", deepLink: "/billing/payer-received" },
      { id: "in_batch", label: "In open batch", tone: "neutral", deepLink: "/billing/837p-batches" },
      { id: "transmission_failed", label: "Transmission failed", tone: "urgent", deepLink: "/billing/transmission-failures" },
    ],
  },
  {
    id: "denials",
    label: "Denials",
    description: "Payer said no. Appeal, correct, or write off.",
    chips: [
      { id: "by_carc", label: "By CARC", tone: "info", deepLink: "/billing/denials-by-carc" },
      { id: "by_rarc", label: "By RARC", tone: "info", deepLink: "/billing/denials-by-rarc" },
      { id: "partial", label: "Partial denials", tone: "pending", deepLink: "/billing/partial-denials" },
      { id: "medical_necessity", label: "Medical necessity", tone: "urgent", deepLink: "/billing/medical-necessity" },
      { id: "medical_review", label: "Records requested", tone: "pending", deepLink: "/billing/medical-review" },
    ],
  },
  {
    id: "follow_up",
    label: "Follow-Up",
    description: "In motion — appeals filed, corrections sent, awaiting outcome.",
    chips: [
      { id: "appeals", label: "Appeals filed", tone: "info", deepLink: "/billing/appeals" },
      { id: "corrected", label: "Corrected claims", tone: "info", deepLink: "/billing/corrected-claims" },
      { id: "resubmissions", label: "Resubmissions", tone: "info", deepLink: "/billing/resubmissions" },
      { id: "cob", label: "COB updates", tone: "pending", deepLink: "/billing/cob-issues" },
      { id: "secondary", label: "Secondary billing", tone: "neutral", deepLink: "/billing/secondary-billing" },
    ],
  },
  {
    id: "resolutions",
    label: "Resolutions",
    description: "Closed out — paid, written off, or moved to patient.",
    chips: [
      { id: "patient_resp", label: "Patient responsibility", tone: "resolved", deepLink: "/billing/patient-responsibility" },
      { id: "write_offs", label: "Write-offs", tone: "neutral", deepLink: "/billing/write-offs" },
      { id: "credit_balance", label: "Credit balance", tone: "pending", deepLink: "/billing/credit-balances" },
      { id: "recoupments", label: "Recoupments", tone: "urgent", deepLink: "/billing/recoupments" },
    ],
  },
];

const LIFECYCLE_BY_ID: Record<LifecycleTab, LifecycleDef> = Object.fromEntries(
  LIFECYCLES.map((l) => [l.id, l]),
) as Record<LifecycleTab, LifecycleDef>;

// ─── Data types ────────────────────────────────────────────────────────────

interface NoResponseRow {
  id: string;
  claim_number: string | null;
  claim_status: string | null;
  patient_id: string | null;
  patient_name: string;
  payer_name: string | null;
  service_date_from: string | null;
  service_date_to: string | null;
  submitted_at: string | null;
  days_outstanding: number | null;
  total_charge: number;
  follow_up_due_date: string | null;
  assigned_to_user_id: string | null;
  assigned_to_display_name: string | null;
  latest_note_at: string | null;
  latest_note_excerpt: string | null;
  last_known_status: string;
  last_status_at: string | null;
  missing_artifact: "no_999" | "no_277ca" | "no_payer_status" | "no_era" | "past_follow_up";
  clearinghouse_trace_number: string | null;
}

interface ClaimRow {
  id: string;
  claimNumber: string;
  patientName: string;
  patientSub: string;
  dosFrom: string | null;
  dosTo: string | null;
  payer: string;
  balance: number;
  daysOut: number | null;
  issue: { label: string; tone: ChipTone };
  lastAction: string;
  lastActionAt: string | null;
  assignee: string | null;
  followUp: string | null;
  raw: NoResponseRow;
  matchingChips: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getOrganizationId() {
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

function humanIssueFor(r: NoResponseRow): { label: string; tone: ChipTone } {
  const days = r.days_outstanding ?? 0;
  switch (r.missing_artifact) {
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
  }
}

function chipIdsForRow(r: NoResponseRow): string[] {
  const ids: string[] = [r.missing_artifact];
  if ((r.days_outstanding ?? 0) > 90) ids.push("timely_filing");
  return ids;
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
  const [activeChips, setActiveChips] = useState<string[]>(
    initialFilter ? initialFilter.split(",").filter(Boolean) : [],
  );
  const [query, setQuery] = useState(initialQuery);
  const [rows, setRows] = useState<NoResponseRow[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTabId>("timeline");

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

  // Fetch underlying queue data. v1 sources the Needs Attention tab from
  // the no-response API which already powers most of today's day-to-day
  // billing work. Other lifecycle tabs render handoff cards to the
  // existing per-queue pages until those sources are unified here.
  useEffect(() => {
    if (activeTab !== "needs_attention") {
      setRows([]);
      setTabCounts({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("organizationId", getOrganizationId());
        // Pick the underlying API tab from the first selected chip that
        // maps to one. If nothing's selected we default to no_payer_status
        // (the most populated bucket).
        const chipWithTab = activeChips
          .map((id) => LIFECYCLE_BY_ID.needs_attention.chips.find((c) => c.id === id))
          .find((c) => c?.noResponseTab);
        params.set("tab", chipWithTab?.noResponseTab ?? "no_payer_status");
        const res = await fetch(`/api/billing/no-response?${params.toString()}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) {
          setError(json.error || "Could not load claims");
          setRows([]);
          return;
        }
        setRows((json.items as NoResponseRow[]) ?? []);
        setTabCounts((json.tabCounts as Record<string, number>) ?? {});
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load claims");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeTab, activeChips.join(",")]);

  const mapped: ClaimRow[] = useMemo(() => {
    return rows.map((r) => ({
      id: r.id,
      claimNumber: r.claim_number || `(no claim #) ${r.id.slice(0, 6)}`,
      patientName: r.patient_name || "Unknown patient",
      patientSub: r.payer_name ? "" : "",
      dosFrom: r.service_date_from,
      dosTo: r.service_date_to,
      payer: r.payer_name || "—",
      balance: r.total_charge,
      daysOut: r.days_outstanding,
      issue: humanIssueFor(r),
      lastAction: r.latest_note_excerpt || `Status: ${r.last_known_status || "unknown"}`,
      lastActionAt: r.latest_note_at || r.last_status_at,
      assignee: r.assigned_to_display_name,
      followUp: r.follow_up_due_date,
      raw: r,
      matchingChips: chipIdsForRow(r),
    }));
  }, [rows]);

  const filtered: ClaimRow[] = useMemo(() => {
    let result = mapped;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      result = result.filter(
        (r) =>
          r.patientName.toLowerCase().includes(q) ||
          r.claimNumber.toLowerCase().includes(q) ||
          r.payer.toLowerCase().includes(q),
      );
    }
    // Additional chip filtering beyond what's baked into the fetch.
    // (The fetch already narrows by the first chip with a noResponseTab.)
    return result;
  }, [mapped, query]);

  const kpis = useMemo(() => {
    const openCount = filtered.length;
    const totalValue = filtered.reduce((sum, r) => sum + (r.balance || 0), 0);
    const avgDays = filtered.length
      ? Math.round(
          filtered.reduce((sum, r) => sum + (r.daysOut ?? 0), 0) / filtered.length,
        )
      : 0;
    const urgent = filtered.filter((r) => r.issue.tone === "urgent").length;
    return { openCount, totalValue, avgDays, urgent };
  }, [filtered]);

  const selectedRow = useMemo(
    () => filtered.find((r) => r.id === selectedRowId) ?? null,
    [filtered, selectedRowId],
  );

  const closeDrawer = useCallback(() => setSelectedRowId(null), []);

  useEffect(() => {
    if (!selectedRowId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDrawer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRowId, closeDrawer]);

  const lifecycle = LIFECYCLE_BY_ID[activeTab];

  const toggleChip = (id: string) => {
    setActiveChips((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
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
            placeholder="Search patient, claim #, payer…"
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </header>

      {/* KPI tiles */}
      <div className={styles.kpiRow}>
        <div className={styles.kpiTile}>
          <span className={styles.kpiLabel}>Claims requiring action</span>
          <span className={`${styles.kpiValue} ${kpis.urgent > 0 ? styles.kpiValueUrgent : ""}`}>
            {kpis.openCount}
          </span>
          <span className={styles.kpiSub}>{kpis.urgent} urgent</span>
        </div>
        <div className={styles.kpiTile}>
          <span className={styles.kpiLabel}>At-risk value</span>
          <span className={`${styles.kpiValue} ${kpis.totalValue > 10000 ? styles.kpiValuePending : ""}`}>
            {fmtMoney(kpis.totalValue)}
          </span>
          <span className={styles.kpiSub}>Across {kpis.openCount} open claims</span>
        </div>
        <div className={styles.kpiTile}>
          <span className={styles.kpiLabel}>Avg days outstanding</span>
          <span className={`${styles.kpiValue} ${kpis.avgDays > 60 ? styles.kpiValueUrgent : kpis.avgDays > 30 ? styles.kpiValuePending : ""}`}>
            {kpis.avgDays}d
          </span>
          <span className={styles.kpiSub}>Current view</span>
        </div>
        <div className={styles.kpiTile}>
          <span className={styles.kpiLabel}>Recently posted today</span>
          <span className={`${styles.kpiValue} ${styles.kpiValueResolved}`}>{tabCounts.past_follow_up ?? 0}</span>
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
              onClick={() => {
                setActiveTab(l.id);
                setActiveChips([]);
                setSelectedRowId(null);
              }}
            >
              {l.label}
            </button>
          );
        })}
      </div>

      {/* Filter chip strip */}
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
              title={c.deepLink ? `${c.label} — also has a detailed queue at ${c.deepLink}` : c.label}
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

      {error ? <div className={styles.error}>{error}</div> : null}

      {/* Body — table or empty state */}
      <div className={styles.tableWrap}>
        {activeTab !== "needs_attention" ? (
          <LifecycleHandoff lifecycle={lifecycle} />
        ) : loading ? (
          <div className={styles.loading}>Loading claims…</div>
        ) : filtered.length === 0 ? (
          <div className={styles.empty}>
            Nothing matches the current view. Try clearing filters or switching tabs.
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Patient</th>
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
  const r = row.raw;
  switch (tab) {
    case "timeline":
      return (
        <>
          <div className={styles.section}>
            <h4>Claim summary</h4>
            <div className={styles.kvGrid}>
              <span className={styles.kvKey}>Claim #</span>
              <span className={styles.kvVal}>{row.claimNumber}</span>
              <span className={styles.kvKey}>Status</span>
              <span className={styles.kvVal}>{r.last_known_status || "—"}</span>
              <span className={styles.kvKey}>Date of service</span>
              <span className={styles.kvVal}>{dosLabel(row.dosFrom, row.dosTo)}</span>
              <span className={styles.kvKey}>Submitted</span>
              <span className={styles.kvVal}>{fmtDate(r.submitted_at)}</span>
              <span className={styles.kvKey}>Days outstanding</span>
              <span className={styles.kvVal}>{r.days_outstanding ?? "—"}</span>
              <span className={styles.kvKey}>Trace #</span>
              <span className={styles.kvVal}>{r.clearinghouse_trace_number || "—"}</span>
            </div>
          </div>
          <div className={styles.section}>
            <h4>Lifecycle</h4>
            <ul className={styles.timelineList}>
              <li className={styles.timelineItem}>
                <span className={`${styles.timelineDot} ${styles.timelineDotResolved}`} />
                <div className={styles.timelineMain}>
                  <div className={styles.timelineLabel}>Submitted to payer</div>
                  <div className={styles.timelineMeta}>{fmtDate(r.submitted_at)}</div>
                </div>
              </li>
              <li className={styles.timelineItem}>
                <span className={`${styles.timelineDot} ${styles.timelineDotPending}`} />
                <div className={styles.timelineMain}>
                  <div className={styles.timelineLabel}>{row.issue.label}</div>
                  <div className={styles.timelineMeta}>{fmtRelative(r.last_status_at)}</div>
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
      return r.latest_note_excerpt ? (
        <div className={styles.section}>
          <h4>Latest note</h4>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>{r.latest_note_excerpt}</div>
          <div className={styles.timelineMeta} style={{ marginTop: 6 }}>{fmtRelative(r.latest_note_at)}</div>
        </div>
      ) : (
        <div className={styles.emptyTabState}>No notes yet. Log the first one with “Log call outcome”.</div>
      );
    case "attachments":
      return <div className={styles.emptyTabState}>EOBs, payer letters, and supporting docs attached to this claim appear here.</div>;
    case "status_history":
      return (
        <div className={styles.section}>
          <h4>Last known status</h4>
          <div className={styles.kvGrid}>
            <span className={styles.kvKey}>Status</span>
            <span className={styles.kvVal}>{r.last_known_status || "—"}</span>
            <span className={styles.kvKey}>As of</span>
            <span className={styles.kvVal}>{fmtRelative(r.last_status_at)}</span>
            <span className={styles.kvKey}>Trace #</span>
            <span className={styles.kvVal}>{r.clearinghouse_trace_number || "—"}</span>
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

// ─── Lifecycle handoff (tabs we haven't unified yet) ──────────────────────

function LifecycleHandoff({ lifecycle }: { lifecycle: LifecycleDef }) {
  return (
    <div className={styles.empty} style={{ textAlign: "left", padding: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: "#0F172A", marginBottom: 6 }}>
        {lifecycle.label}
      </div>
      <div style={{ marginBottom: 16, color: "#475569" }}>{lifecycle.description}</div>
      <div style={{ fontSize: 12, color: "#64748B", marginBottom: 8 }}>
        Open the matching detailed queue while this view is finishing rollout:
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {lifecycle.chips.map((c) =>
          c.deepLink ? (
            <Link
              key={c.id}
              href={c.deepLink}
              className={styles.chip}
              style={{ textDecoration: "none" }}
            >
              {c.label} →
            </Link>
          ) : null,
        )}
      </div>
    </div>
  );
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
