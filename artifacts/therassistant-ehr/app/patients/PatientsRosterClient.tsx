"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { MoreVertical, Plus, Search, Upload } from "lucide-react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import styles from "./roster.module.css";
import ClientImportDialog from "./ClientImportDialog";
import AddClientDialog from "./AddClientDialog";

type EligibilityState = {
  status: "none" | "active" | "inactive" | "pending" | "error" | "stale";
  checkedAt: string | null;
  daysSinceChecked: number | null;
  copayAmount: number | null;
  isStale: boolean;
};

type ClientRecord = {
  id: string;
  name: string;
  preferredName?: unknown;
  email?: unknown;
  phone?: unknown;
  status?: unknown;
  intakeStatus?: unknown;
  openBalance: number;
  updatedAt?: unknown;
  eligibility: EligibilityState;
  nextAppointmentAt: string | null;
  openWorkqueueCount: number;
  claimIssueCount: number;
};

type Metrics = {
  total: number;
  active: number;
  intakeIncomplete: number;
  withBalance: number;
  needsEligibility: number;
  staleEligibility: number;
  claimIssues: number;
  openWorkqueue: number;
};

type Payload = {
  success: boolean;
  error?: string;
  metrics?: Metrics;
  clients?: ClientRecord[];
};

type NeedsFilter =
  | "all"
  | "needs-eligibility"
  | "stale-eligibility"
  | "intake-incomplete"
  | "balance-due"
  | "claim-issues"
  | "open-workqueue";

function resolveOrganizationId(initialOrganizationId?: string): string {
  if (initialOrganizationId) return initialOrganizationId;
  if (typeof window !== "undefined") {
    const fromUrl = new URLSearchParams(window.location.search).get("organizationId");
    if (fromUrl) return fromUrl;
  }
  return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function formatMoney(value: number) {
  return Number(value ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatNextVisit(iso: string | null): { label: string; muted: boolean } {
  if (!iso) return { label: "Not scheduled", muted: true };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { label: "Not scheduled", muted: true };
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return { label: `Today ${timeStr}`, muted: false };
  if (days === 1) return { label: `Tomorrow ${timeStr}`, muted: false };
  if (days > 1 && days < 7) {
    return {
      label: `${d.toLocaleDateString(undefined, { weekday: "short" })} ${timeStr}`,
      muted: false,
    };
  }
  return {
    label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    muted: false,
  };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

type RowPriority = "red" | "amber" | "teal" | "slate";

function rowPriority(c: ClientRecord): RowPriority {
  if (c.claimIssueCount > 0) return "red";
  if (c.eligibility.status === "none" || c.eligibility.status === "inactive" || c.eligibility.status === "error") {
    return "red";
  }
  if (
    c.eligibility.status === "stale" ||
    c.openWorkqueueCount > 0 ||
    Number(c.openBalance ?? 0) > 0 ||
    String(c.intakeStatus ?? "") !== "complete"
  ) {
    return "amber";
  }
  return "teal";
}

function eligibilityLabel(s: EligibilityState["status"], days: number | null) {
  switch (s) {
    case "active":   return "Eligibility active";
    case "stale":    return `Eligibility stale (${days ?? "?"}d)`;
    case "pending":  return "Eligibility pending";
    case "inactive": return "Eligibility inactive";
    case "error":    return "Eligibility error";
    default:         return "Eligibility not checked";
  }
}

function eligibilityTone(s: EligibilityState["status"]): "red" | "amber" | "teal" {
  if (s === "active") return "teal";
  if (s === "stale" || s === "pending") return "amber";
  return "red";
}

export default function PatientsRosterClient({
  initialOrganizationId,
}: {
  initialOrganizationId?: string;
} = {}) {
  const organizationId = useMemo(
    () => resolveOrganizationId(initialOrganizationId),
    [initialOrganizationId],
  );
  const [query, setQuery] = useState("");
  const [needsFilter, setNeedsFilter] = useState<NeedsFilter>("all");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  async function loadClients(search = query) {
    if (!organizationId) {
      setError("Could not determine your organization. Please sign in again.");
      setLoading(false);
      return;
    }
    // Cancel any in-flight request and tag this one with a monotonic id
    // so stale responses can't overwrite newer state.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const mySeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId });
      if (search.trim()) params.set("q", search.trim());
      const response = await fetch(`/api/clients?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const json = (await response.json()) as Payload;
      if (mySeq !== requestSeqRef.current) return;
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load clients");
      setPayload(json);
    } catch (loadError) {
      if ((loadError as { name?: string })?.name === "AbortError") return;
      if (mySeq !== requestSeqRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load clients");
    } finally {
      if (mySeq === requestSeqRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadClients("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setOpenMenuId(null);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const metrics: Metrics = payload?.metrics ?? {
    total: 0, active: 0, intakeIncomplete: 0, withBalance: 0,
    needsEligibility: 0, staleEligibility: 0, claimIssues: 0, openWorkqueue: 0,
  };
  const clients = payload?.clients ?? [];
  const filteredClients = clients.filter((c) => {
    switch (needsFilter) {
      case "needs-eligibility": return c.eligibility.status === "none";
      case "stale-eligibility": return c.eligibility.status === "stale";
      case "intake-incomplete": return String(c.intakeStatus ?? "") !== "complete";
      case "balance-due":       return Number(c.openBalance ?? 0) > 0;
      case "claim-issues":      return c.claimIssueCount > 0;
      case "open-workqueue":    return c.openWorkqueueCount > 0;
      default:                  return true;
    }
  });
  const organizationQuery = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";

  function clientHref(clientId: string, path = "") {
    const base = `/clients/${clientId}${path}`;
    return organizationId ? `${base}${organizationQuery}` : base;
  }

  const chips: { key: NeedsFilter; label: string; count: number }[] = [
    { key: "all",                label: "All",                count: metrics.total },
    { key: "needs-eligibility",  label: "Needs eligibility",  count: metrics.needsEligibility },
    { key: "stale-eligibility",  label: "Stale eligibility",  count: metrics.staleEligibility },
    { key: "intake-incomplete",  label: "Intake incomplete",  count: metrics.intakeIncomplete },
    { key: "balance-due",        label: "Balance due",        count: metrics.withBalance },
    { key: "claim-issues",       label: "Claim issues",       count: metrics.claimIssues },
    { key: "open-workqueue",     label: "Has open WQ",        count: metrics.openWorkqueue },
  ];

  return (
    <main className={styles.page}>
      {/* ── Header ── */}
      <header className={styles.header}>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.headerBtn}
            onClick={() => setImportOpen(true)}
          >
            <Upload size={14} /> Import CSV
          </button>
          <button
            type="button"
            className={styles.headerBtn}
            onClick={() => setAddOpen(true)}
          >
            <Plus size={14} /> Add New Client
          </button>
        </div>
      </header>

      <ClientImportDialog
        open={importOpen}
        organizationId={organizationId}
        onClose={() => setImportOpen(false)}
        onImported={() => loadClients(query)}
      />

      <AddClientDialog
        open={addOpen}
        organizationId={organizationId}
        onClose={() => setAddOpen(false)}
        onCreated={() => loadClients(query)}
      />


      {/* ── Smart search ── */}
      <div className={styles.searchBar} role="search">
        <Search size={16} color="#94A3B8" aria-hidden />
        <input
          className={styles.searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") loadClients(query); }}
          placeholder="Search name, email, phone, insurance, DOB…"
          aria-label="Search patients"
        />
        <span className={styles.searchHint} aria-hidden>Enter</span>
        <button
          type="button"
          className={`${styles.searchBtn} ${styles.searchBtnGhost}`}
          onClick={() => { setQuery(""); setNeedsFilter("all"); loadClients(""); }}
        >
          Clear
        </button>
        <button type="button" className={styles.searchBtn} onClick={() => loadClients(query)}>
          Search
        </button>
      </div>

      {error ? <div className={styles.errorBanner} role="alert">{error}</div> : null}

      {/* ── Filter chips ── */}
      <div className={styles.chipRow} role="tablist" aria-label="Roster filters">
        {chips.map((chip) => {
          const active = needsFilter === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setNeedsFilter(chip.key)}
              className={`${styles.chip} ${active ? styles.chipActive : ""}`.trim()}
            >
              {chip.label}
              <span className={styles.chipCount}>{loading ? "…" : chip.count}</span>
            </button>
          );
        })}
      </div>

      {/* ── 4. Patient roster ── */}
      <div className={styles.rosterHeader}>
        <h2 className={styles.rosterTitle}>Roster</h2>
        {!loading ? (
          <span className={styles.rosterCount}>
            Showing {filteredClients.length} of {clients.length}
          </span>
        ) : null}
      </div>

      {loading ? <div className={styles.loading}>Loading patients…</div> : null}
      {!loading && filteredClients.length === 0 ? (
        <div className={styles.empty}>No patients match this filter.</div>
      ) : null}

      {filteredClients.length > 0 ? (
        <div className={styles.rosterList} role="list">
          {filteredClients.map((client) => {
            const priority = rowPriority(client);
            const next = formatNextVisit(client.nextAppointmentAt);
            const accentClass =
              priority === "red"   ? styles.rowAccentRed   :
              priority === "amber" ? styles.rowAccentAmber :
              priority === "teal"  ? styles.rowAccentTeal  : styles.rowAccentSlate;
            const eligTone = eligibilityTone(client.eligibility.status);
            const indicators: { label: string; tone: "red" | "amber" | "teal" | "blue" }[] = [];
            indicators.push({
              label: eligibilityLabel(client.eligibility.status, client.eligibility.daysSinceChecked),
              tone: eligTone,
            });
            if (String(client.intakeStatus ?? "") !== "complete") {
              indicators.push({ label: "Intake incomplete", tone: "amber" });
            }
            if (client.claimIssueCount > 0) {
              indicators.push({
                label: `${client.claimIssueCount} claim ${client.claimIssueCount === 1 ? "issue" : "issues"}`,
                tone: "red",
              });
            }
            if (client.openWorkqueueCount > 0) {
              indicators.push({
                label: `${client.openWorkqueueCount} workqueue`,
                tone: "blue",
              });
            }

            return (
              <article key={client.id} className={styles.row} role="listitem">
                <div className={`${styles.rowAccent} ${accentClass}`} aria-hidden />
                <div className={styles.rowAvatar} aria-hidden>{initials(client.name)}</div>
                <div className={styles.rowMain}>
                  <Link className={styles.rowName} href={clientHref(client.id)}>
                    {client.name}
                  </Link>
                  <div className={styles.rowSub}>
                    <span>{String(client.email ?? "No email")}</span>
                    <span className={styles.rowSubDot}>•</span>
                    <span>{String(client.phone ?? "No phone")}</span>
                  </div>
                  <div className={styles.rowIndicators}>
                    {indicators.map((ind, idx) => {
                      const toneClass =
                        ind.tone === "red"   ? styles.indicatorRed   :
                        ind.tone === "amber" ? styles.indicatorAmber :
                        ind.tone === "teal"  ? styles.indicatorTeal  : styles.indicatorBlue;
                      return (
                        <span key={idx} className={`${styles.indicator} ${toneClass}`}>
                          {ind.label}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <div className={styles.rowFacet}>
                  <span className={styles.rowFacetLabel}>Next visit</span>
                  <span
                    className={`${styles.rowFacetValue} ${next.muted ? styles.rowFacetValueMuted : ""}`.trim()}
                  >
                    {next.label}
                  </span>
                </div>

                <div className={styles.rowFacet}>
                  <span className={styles.rowFacetLabel}>Balance</span>
                  <span className={`${styles.rowFacetValue} ${styles.balanceValue}`}>
                    {client.openBalance > 0 ? (
                      <span className={styles.balanceDue}>{formatMoney(client.openBalance)}</span>
                    ) : (
                      <span className={styles.rowFacetValueMuted}>{formatMoney(client.openBalance)}</span>
                    )}
                  </span>
                </div>

                <div className={styles.rowActions}>
                  {client.eligibility.status === "none" ||
                  client.eligibility.status === "stale" ||
                  client.eligibility.status === "inactive" ? (
                    <Link
                      className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
                      href={clientHref(client.id, "/eligibility")}
                    >
                      Verify
                    </Link>
                  ) : null}
                  <Link className={styles.actionBtn} href={clientHref(client.id)}>
                    Open chart
                  </Link>
                  <div
                    className={styles.rowMoreWrap}
                    ref={openMenuId === client.id ? menuRef : null}
                  >
                    <button
                      type="button"
                      className={styles.rowMoreBtn}
                      aria-label="More actions"
                      aria-haspopup="menu"
                      aria-expanded={openMenuId === client.id}
                      onClick={() => setOpenMenuId((id) => (id === client.id ? null : client.id))}
                    >
                      <MoreVertical size={16} />
                    </button>
                    {openMenuId === client.id ? (
                      <div className={styles.rowMoreMenu} role="menu">
                        <Link
                          className={styles.rowMoreItem}
                          href={clientHref(client.id, "/eligibility")}
                          role="menuitem"
                          onClick={() => setOpenMenuId(null)}
                        >
                          Eligibility
                        </Link>
                        <Link
                          className={styles.rowMoreItem}
                          href={clientHref(client.id, "/balance")}
                          role="menuitem"
                          onClick={() => setOpenMenuId(null)}
                        >
                          Balance
                        </Link>
                        <Link
                          className={styles.rowMoreItem}
                          href={clientHref(client.id, "/claims")}
                          role="menuitem"
                          onClick={() => setOpenMenuId(null)}
                        >
                          Claims
                        </Link>
                        <Link
                          className={styles.rowMoreItem}
                          href={clientHref(client.id, "/workqueue")}
                          role="menuitem"
                          onClick={() => setOpenMenuId(null)}
                        >
                          Workqueue
                        </Link>
                      </div>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </main>
  );
}
