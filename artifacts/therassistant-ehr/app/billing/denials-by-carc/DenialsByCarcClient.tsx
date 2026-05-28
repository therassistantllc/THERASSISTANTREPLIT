"use client";

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
import { getWorkqueue } from "@/lib/billing/workqueues";
import PlaceClaimOnHoldModal from "@/components/billing/PlaceClaimOnHoldModal";

// ── Types ───────────────────────────────────────────────────────────────────

interface DrilldownClaim {
  workqueueItemId: string | null;
  claimId: string;
  claimNumber: string;
  clientId: string;
  clientName: string;
  serviceDate: string | null;
  payer: string;
  payerProfileId: string;
  deniedAmount: number;
  rarcCode: string | null;
  rarcCodes: string[];
  lastAction: string | null;
  nextStep: string | null;
  assignedToUserId: string | null;
  priority: string;
  ageDays: number | null;
  updatedAt: string | null;
}

interface CarcGroup {
  carcCode: string;
  carcDescription: string;
  claimCount: number;
  totalDeniedAmount: number;
  avgAgeDays: number | null;
  oldestAgeDays: number | null;
  payers: string[];
  assignedOwners: string[];
  topPriority: string;
  payerBreakdown: Array<{ payer: string; claimCount: number; totalAmount: number }>;
  suggestedCorrection: string;
  claims: DrilldownClaim[];
}

interface ApiPayload {
  success: boolean;
  error?: string;
  summary?: {
    totalClaims: number;
    totalDollars: number;
    oldestAgeDays: number;
    urgentCount: number;
  };
  groups?: CarcGroup[];
  topCounts?: Record<string, number>;
  templates?: Array<{ id: string; name: string; body: string; isSystem: boolean }>;
}

const TOP_CARC_CODES = ["16", "22", "29", "96", "197"] as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value || 0,
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

function priorityTone(p: string): "default" | "amber" | "red" {
  if (p === "urgent") return "red";
  if (p === "high") return "amber";
  return "default";
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function downloadCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const body = rows
    .map((r) => headers.map((h) => csvEscape(r[h])).join(","))
    .join("\n");
  const csv = `${headers.join(",")}\n${body}\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

// ── Toast ───────────────────────────────────────────────────────────────────
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

// ── Modal shell ─────────────────────────────────────────────────────────────
function ModalShell({
  title,
  onClose,
  children,
  width = 560,
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
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

const queueDef = getWorkqueue("denials_by_carc");

export default function DenialsByCarcClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);

  const [groups, setGroups] = useState<CarcGroup[]>([]);
  const [topCounts, setTopCounts] = useState<Record<string, number>>({});
  const [summaryData, setSummaryData] = useState<ApiPayload["summary"] | null>(null);
  const [templates, setTemplates] = useState<
    Array<{ id: string; name: string; body: string; isSystem: boolean }>
  >([]);

  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [activeTabId, setActiveTabId] = useState<string>("all");
  const [selectedCarc, setSelectedCarc] = useState<string | null>(null);

  const [assignModal, setAssignModal] = useState<CarcGroup | null>(null);
  const [appealModal, setAppealModal] = useState<CarcGroup | null>(null);
  const [correctModal, setCorrectModal] = useState<CarcGroup | null>(null);
  const [ruleModal, setRuleModal] = useState<CarcGroup | null>(null);
  const [holdClaim, setHoldClaim] = useState<DrilldownClaim | null>(null);

  // ── Load ─────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/denials-by-carc?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as ApiPayload;
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load denials");
      setGroups(json.groups ?? []);
      setTopCounts(json.topCounts ?? {});
      setSummaryData(json.summary ?? null);
      setTemplates(json.templates ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load denials");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Filter wiring ────────────────────────────────────────────────────────
  const allClaims = useMemo(() => groups.flatMap((g) => g.claims), [groups]);

  const payerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allClaims) if (c.payer) set.add(c.payer);
    return Array.from(set).map((v) => ({ value: v, label: v }));
  }, [allClaims]);

  const ownerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allClaims) if (c.assignedToUserId) set.add(c.assignedToUserId);
    return Array.from(set).map((v) => ({ value: v, label: v.slice(0, 8) }));
  }, [allClaims]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "client", label: "Client", kind: "text", placeholder: "Client name…" },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Aging",
        kind: "select",
        options: [
          { value: "0-30", label: "0-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "61-90", label: "61-90 days" },
          { value: "90+", label: "90+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 197" },
      { id: "assignedBiller", label: "Assigned", kind: "select", options: ownerOptions },
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
    ],
    [payerOptions, ownerOptions],
  );

  function claimPassesFilters(c: DrilldownClaim, v: Record<string, string>): boolean {
    if (v.client) {
      const q = v.client.toLowerCase();
      if (!c.clientName.toLowerCase().includes(q)) return false;
    }
    if (v.payer && c.payer !== v.payer) return false;
    if (v.dosFrom && (c.serviceDate ?? "") < v.dosFrom) return false;
    if (v.dosTo && (c.serviceDate ?? "") > v.dosTo) return false;
    if (v.minAmount) {
      const min = Number(v.minAmount);
      if (!Number.isNaN(min) && c.deniedAmount < min) return false;
    }
    if (v.agingBucket) {
      const a = c.ageDays;
      if (a == null) return false;
      switch (v.agingBucket) {
        case "0-30": if (a > 30) return false; break;
        case "31-60": if (a <= 30 || a > 60) return false; break;
        case "61-90": if (a <= 60 || a > 90) return false; break;
        case "90+": if (a <= 90) return false; break;
      }
    }
    if (v.assignedBiller && c.assignedToUserId !== v.assignedBiller) return false;
    if (v.priority && c.priority !== v.priority) return false;
    if (v.carcRarc) {
      const q = v.carcRarc.toLowerCase();
      const rarc = (c.rarcCode ?? "").toLowerCase();
      if (!rarc.includes(q)) return false;
    }
    return true;
  }

  // Apply universal filters at the claim level, then re-aggregate groups.
  const filteredGroups: CarcGroup[] = useMemo(() => {
    const v = filterValues;
    const hasAny = Object.values(v).some((x) => x && x.length > 0);
    const carcFilter = v.carcRarc ? v.carcRarc.trim() : "";
    return groups
      .map((g) => {
        // If the carcRarc filter looks like a numeric code, narrow groups by it.
        if (carcFilter && /^\d+$/.test(carcFilter) && g.carcCode !== carcFilter) {
          return { ...g, claims: [] };
        }
        const claims = hasAny ? g.claims.filter((c) => claimPassesFilters(c, v)) : g.claims;
        if (claims.length === 0) return { ...g, claims };
        const total = Math.round(claims.reduce((s, c) => s + c.deniedAmount, 0) * 100) / 100;
        const ages = claims.map((c) => c.ageDays).filter((a): a is number => a != null);
        const avg = ages.length ? Math.round(ages.reduce((s, a) => s + a, 0) / ages.length) : null;
        const oldest = ages.length ? Math.max(...ages) : null;
        const payerSet = new Map<string, { count: number; total: number }>();
        for (const c of claims) {
          const cur = payerSet.get(c.payer) ?? { count: 0, total: 0 };
          cur.count += 1;
          cur.total = Math.round((cur.total + c.deniedAmount) * 100) / 100;
          payerSet.set(c.payer, cur);
        }
        const payerBreakdown = Array.from(payerSet.entries())
          .map(([payer, x]) => ({ payer, claimCount: x.count, totalAmount: x.total }))
          .sort((a, b) => b.totalAmount - a.totalAmount);
        return {
          ...g,
          claimCount: claims.length,
          totalDeniedAmount: total,
          avgAgeDays: avg,
          oldestAgeDays: oldest,
          payers: payerBreakdown.map((p) => p.payer),
          payerBreakdown,
          claims,
        };
      })
      .filter((g) => g.claims.length > 0);
  }, [groups, filterValues]);

  // Tab-narrowed groups (after filtering).
  const tabGroups: CarcGroup[] = useMemo(() => {
    if (activeTabId === "all") return filteredGroups;
    return filteredGroups.filter((g) => g.carcCode === activeTabId);
  }, [filteredGroups, activeTabId]);

  // ── Summary strip (reflects current filters + tab) ───────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const claims = tabGroups.flatMap((g) => g.claims);
    const count = claims.length;
    const dollars = Math.round(
      claims.reduce((s, c) => s + c.deniedAmount, 0) * 100,
    ) / 100;
    const ages = claims.map((c) => c.ageDays).filter((a): a is number => a != null);
    const oldest = ages.length ? Math.max(...ages) : 0;
    const urgent = claims.filter((c) => (c.ageDays ?? 0) > 60).length;
    return [
      { id: "count", label: "Open denials", value: count.toLocaleString() },
      {
        id: "dollars",
        label: "Total denied",
        value: formatCurrency(dollars),
        tone: dollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: oldest,
        tone: oldest > 60 ? "red" : oldest > 30 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent (>60d)",
        value: urgent,
        tone: urgent > 0 ? "red" : "default",
      },
    ];
  }, [tabGroups]);

  // ── Tabs ─────────────────────────────────────────────────────────────────
  const primaryTabs: PrimaryTab[] = useMemo(() => {
    const tabs: PrimaryTab[] = [
      { id: "all", label: "All CARCs", count: filteredGroups.length },
    ];
    for (const code of TOP_CARC_CODES) {
      tabs.push({
        id: code,
        label: `CARC ${code}`,
        count: topCounts[code] ?? 0,
      });
    }
    return tabs;
  }, [filteredGroups.length, topCounts]);

  // ── Columns (group-level main table) ─────────────────────────────────────
  const columns: ColumnDef<CarcGroup>[] = useMemo(
    () => [
      {
        id: "carc",
        header: "CARC",
        cell: (g) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
            {g.carcCode}
          </span>
        ),
        width: 80,
      },
      {
        id: "desc",
        header: "Description",
        cell: (g) => (
          <span style={{ color: "#0F172A" }}>{g.carcDescription}</span>
        ),
      },
      {
        id: "count",
        header: "Claims",
        align: "right",
        cell: (g) => (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{g.claimCount}</span>
        ),
        width: 80,
      },
      {
        id: "amount",
        header: "Total denied",
        align: "right",
        cell: (g) => (
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {formatCurrency(g.totalDeniedAmount)}
          </span>
        ),
        width: 140,
      },
      {
        id: "age",
        header: "Avg age",
        align: "right",
        cell: (g) => (
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              color:
                (g.avgAgeDays ?? 0) > 60
                  ? "#B91C1C"
                  : (g.avgAgeDays ?? 0) > 30
                  ? "#B45309"
                  : "#0F172A",
            }}
          >
            {g.avgAgeDays != null ? `${g.avgAgeDays}d` : "—"}
          </span>
        ),
        width: 100,
      },
      {
        id: "payer",
        header: "Payer",
        cell: (g) =>
          g.payers.length === 0
            ? "—"
            : g.payers.length === 1
            ? g.payers[0]
            : `${g.payers[0]} +${g.payers.length - 1}`,
      },
      {
        id: "owner",
        header: "Assigned owner",
        cell: (g) =>
          g.assignedOwners.length === 0
            ? <span style={{ color: "#9CA3AF" }}>Unassigned</span>
            : g.assignedOwners.length === 1
            ? g.assignedOwners[0].slice(0, 8)
            : `${g.assignedOwners.length} billers`,
      },
      {
        id: "priority",
        header: "Priority",
        cell: (g) => {
          const tone = priorityTone(g.topPriority);
          const color =
            tone === "red" ? "#B91C1C" : tone === "amber" ? "#B45309" : "#374151";
          return (
            <span
              style={{
                color,
                fontWeight: 600,
                fontSize: 12,
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}
            >
              {g.topPriority}
            </span>
          );
        },
        width: 100,
      },
    ],
    [],
  );

  // ── Row actions ──────────────────────────────────────────────────────────
  const rowActions: RowAction<CarcGroup>[] = useMemo(
    () => [
      {
        id: "view",
        label: "Drilldown",
        onClick: (g) => setSelectedCarc(g.carcCode),
      },
      {
        id: "assign",
        label: "Bulk assign",
        onClick: (g) => setAssignModal(g),
      },
      {
        id: "appeal",
        label: "Bulk appeal",
        variant: "primary",
        onClick: (g) => setAppealModal(g),
      },
      {
        id: "correct",
        label: "Bulk correct",
        onClick: (g) => setCorrectModal(g),
      },
    ],
    [],
  );

  // ── Detail panel ─────────────────────────────────────────────────────────
  const selectedGroup = useMemo(
    () => filteredGroups.find((g) => g.carcCode === selectedCarc) ?? null,
    [filteredGroups, selectedCarc],
  );

  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "claims",
        label: "Claim list per CARC",
        render: () =>
          selectedGroup ? (
            <div>
              <p style={{ margin: "0 0 8px", color: "#64748B", fontSize: 12 }}>
                {selectedGroup.claimCount} claim
                {selectedGroup.claimCount === 1 ? "" : "s"} · {" "}
                {formatCurrency(selectedGroup.totalDeniedAmount)} denied
              </p>
              <div style={{ overflow: "auto", maxHeight: 480 }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr style={{ textAlign: "left", color: "#475569" }}>
                      <th style={{ padding: "6px 4px" }}>Client</th>
                      <th style={{ padding: "6px 4px" }}>Claim #</th>
                      <th style={{ padding: "6px 4px" }}>DOS</th>
                      <th style={{ padding: "6px 4px" }}>Payer</th>
                      <th style={{ padding: "6px 4px", textAlign: "right" }}>Denied $</th>
                      <th style={{ padding: "6px 4px" }}>RARC</th>
                      <th style={{ padding: "6px 4px" }}>Last action</th>
                      <th style={{ padding: "6px 4px" }}>Next step</th>
                      <th style={{ padding: "6px 4px", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedGroup.claims.map((c) => (
                      <tr key={c.claimId} style={{ borderTop: "1px solid #F1F5F9" }}>
                        <td style={{ padding: "6px 4px" }}>{c.clientName}</td>
                        <td
                          style={{
                            padding: "6px 4px",
                            fontFamily: "ui-monospace, monospace",
                          }}
                        >
                          {c.claimNumber}
                        </td>
                        <td style={{ padding: "6px 4px" }}>{formatDate(c.serviceDate)}</td>
                        <td style={{ padding: "6px 4px" }}>{c.payer}</td>
                        <td
                          style={{
                            padding: "6px 4px",
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {formatCurrency(c.deniedAmount)}
                        </td>
                        <td style={{ padding: "6px 4px" }}>{c.rarcCode ?? "—"}</td>
                        <td style={{ padding: "6px 4px", color: "#64748B" }}>
                          {c.lastAction ?? "—"}
                        </td>
                        <td style={{ padding: "6px 4px", color: "#64748B" }}>
                          {c.nextStep ?? "—"}
                        </td>
                        <td style={{ padding: "6px 4px", textAlign: "right" }}>
                          <button
                            type="button"
                            className="button button-secondary"
                            style={{ fontSize: 12, padding: "4px 8px" }}
                            onClick={() => setHoldClaim(c)}
                          >
                            Place on hold
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null,
      },
      {
        id: "payers",
        label: "Payer-grouped breakdown",
        render: () =>
          selectedGroup ? (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: "#475569" }}>
                  <th style={{ padding: "6px 4px" }}>Payer</th>
                  <th style={{ padding: "6px 4px", textAlign: "right" }}>Claims</th>
                  <th style={{ padding: "6px 4px", textAlign: "right" }}>Total denied</th>
                </tr>
              </thead>
              <tbody>
                {selectedGroup.payerBreakdown.map((p) => (
                  <tr key={p.payer} style={{ borderTop: "1px solid #F1F5F9" }}>
                    <td style={{ padding: "6px 4px" }}>{p.payer}</td>
                    <td
                      style={{
                        padding: "6px 4px",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {p.claimCount}
                    </td>
                    <td
                      style={{
                        padding: "6px 4px",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {formatCurrency(p.totalAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null,
      },
      {
        id: "template",
        label: "Suggested correction",
        render: () =>
          selectedGroup ? (
            <div>
              <h4 style={{ margin: "0 0 6px", fontSize: 13, color: "#0F172A" }}>
                CARC {selectedGroup.carcCode} — {selectedGroup.carcDescription}
              </h4>
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  lineHeight: 1.5,
                  background: "#F8FAFC",
                  border: "1px solid #E2E8F0",
                  padding: 12,
                  borderRadius: 6,
                  color: "#0F172A",
                  whiteSpace: "pre-wrap",
                }}
              >
                {selectedGroup.suggestedCorrection}
              </p>
            </div>
          ) : null,
      },
    ],
    [selectedGroup],
  );

  const detailActions: PrimaryAction[] = useMemo(
    () =>
      selectedGroup
        ? [
            {
              id: "assign",
              label: "Bulk assign",
              onClick: () => setAssignModal(selectedGroup),
            },
            {
              id: "appeal",
              label: "Bulk appeal",
              variant: "primary",
              onClick: () => setAppealModal(selectedGroup),
            },
            {
              id: "correct",
              label: "Bulk correct",
              onClick: () => setCorrectModal(selectedGroup),
            },
            {
              id: "rule",
              label: "Create payer rule",
              onClick: () => setRuleModal(selectedGroup),
            },
          ]
        : [],
    [selectedGroup],
  );

  // ── Header actions ───────────────────────────────────────────────────────
  function exportCsv() {
    const rows = tabGroups.flatMap((g) =>
      g.claims.map((c) => ({
        carc_code: g.carcCode,
        carc_description: g.carcDescription,
        client: c.clientName,
        claim_number: c.claimNumber,
        dos: c.serviceDate ?? "",
        payer: c.payer,
        denied_amount: c.deniedAmount,
        rarc: c.rarcCode ?? "",
        last_action: c.lastAction ?? "",
        next_step: c.nextStep ?? "",
        priority: c.priority,
        age_days: c.ageDays ?? "",
      })),
    );
    if (rows.length === 0) {
      setToast("Nothing to export.");
      return;
    }
    downloadCsv(`denials-by-carc-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    setToast(`Exported ${rows.length} denial${rows.length === 1 ? "" : "s"}.`);
  }

  const headerActions: PrimaryAction[] = [
    {
      id: "refresh",
      label: loading ? "Loading…" : "Refresh",
      onClick: () => void load(),
      disabled: loading,
    },
    {
      id: "export",
      label: "Export denial list",
      onClick: exportCsv,
    },
  ];

  // ── Bulk action handlers ─────────────────────────────────────────────────
  async function postAction(
    action: "assign" | "appeal" | "correct" | "create_rule",
    group: CarcGroup,
    extra: Record<string, unknown>,
  ) {
    const res = await fetch("/api/billing/denials-by-carc/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        action,
        claimIds: group.claims.map((c) => c.claimId),
        carcCode: group.carcCode,
        ...extra,
      }),
    });
    const json = await res.json();
    if (!res.ok || json?.success === false) {
      throw new Error(json?.error ?? "Action failed");
    }
    return json;
  }

  function applyAssignment(carcCode: string, assignedToUserId: string | null) {
    setGroups((prev) =>
      prev.map((g) =>
        g.carcCode === carcCode
          ? {
              ...g,
              assignedOwners: assignedToUserId ? [assignedToUserId] : [],
              claims: g.claims.map((c) => ({
                ...c,
                assignedToUserId,
              })),
            }
          : g,
      ),
    );
  }

  function applyCorrection(carcCode: string) {
    setGroups((prev) =>
      prev.map((g) =>
        g.carcCode === carcCode
          ? {
              ...g,
              claims: g.claims.map((c) => ({
                ...c,
                lastAction: "correction_queued",
              })),
            }
          : g,
      ),
    );
  }

  function removeClaimFromGroup(carcCode: string, claimId: string) {
    setGroups((prev) =>
      prev
        .map((g) => {
          if (g.carcCode !== carcCode) return g;
          const claims = g.claims.filter((c) => c.claimId !== claimId);
          if (claims.length === g.claims.length) return g;
          const total = Math.round(claims.reduce((s, c) => s + c.deniedAmount, 0) * 100) / 100;
          const ages = claims.map((c) => c.ageDays).filter((a): a is number => a != null);
          const avg = ages.length ? Math.round(ages.reduce((s, a) => s + a, 0) / ages.length) : null;
          const oldest = ages.length ? Math.max(...ages) : null;
          const payerSet = new Map<string, { count: number; total: number }>();
          for (const c of claims) {
            const cur = payerSet.get(c.payer) ?? { count: 0, total: 0 };
            cur.count += 1;
            cur.total = Math.round((cur.total + c.deniedAmount) * 100) / 100;
            payerSet.set(c.payer, cur);
          }
          const payerBreakdown = Array.from(payerSet.entries())
            .map(([payer, x]) => ({ payer, claimCount: x.count, totalAmount: x.total }))
            .sort((a, b) => b.totalAmount - a.totalAmount);
          return {
            ...g,
            claimCount: claims.length,
            totalDeniedAmount: total,
            avgAgeDays: avg,
            oldestAgeDays: oldest,
            payers: payerBreakdown.map((p) => p.payer),
            payerBreakdown,
            claims,
          };
        })
        .filter((g) => g.claims.length > 0),
    );
    setTopCounts((prev) => {
      if (!(carcCode in prev)) return prev;
      const next = { ...prev };
      next[carcCode] = Math.max(0, (next[carcCode] ?? 0) - 1);
      return next;
    });
  }

  function applyAppeal(carcCode: string) {
    setGroups((prev) =>
      prev.map((g) =>
        g.carcCode === carcCode
          ? {
              ...g,
              claims: g.claims.map((c) => ({
                ...c,
                lastAction: "appeal_drafted",
              })),
            }
          : g,
      ),
    );
  }

  // ── Message banner ───────────────────────────────────────────────────────
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
      <WorkqueueShell<CarcGroup>
        title={queueDef?.title ?? "Denied Claims by CARC"}
        description={queueDef?.description}
        headerActions={headerActions}
        summary={summary}
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTabId}
        onPrimaryTabChange={setActiveTabId}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace="denialsCarc"
        rows={tabGroups}
        columns={columns}
        rowId={(g) => g.carcCode}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No denied claims grouped under this CARC."
        selectedRowId={selectedCarc}
        onSelectRow={setSelectedCarc}
        detailTabs={detailTabs}
        detailActions={detailActions}
        detailPaneWidth="560px"
        message={message}
      />

      {assignModal ? (
        <AssignModal
          group={assignModal}
          summaryHint={summaryData}
          onClose={() => setAssignModal(null)}
          onSubmit={async (userId) => {
            try {
              const json = await postAction("assign", assignModal, {
                assignedToUserId: userId || null,
              });
              applyAssignment(assignModal.carcCode, userId || null);
              setToast(`Assigned ${json.updated ?? 0} claim(s).`);
              setAssignModal(null);
            } catch (e) {
              setToast(e instanceof Error ? e.message : "Assign failed");
            }
          }}
        />
      ) : null}

      {appealModal ? (
        <AppealModal
          group={appealModal}
          templates={templates}
          onClose={() => setAppealModal(null)}
          onSubmit={async (body) => {
            try {
              const json = await postAction("appeal", appealModal, {
                appealBody: body,
              });
              applyAppeal(appealModal.carcCode);
              setToast(`Drafted ${json.drafted ?? 0} appeal(s).`);
              setAppealModal(null);
            } catch (e) {
              setToast(e instanceof Error ? e.message : "Appeal failed");
            }
          }}
        />
      ) : null}

      {correctModal ? (
        <CorrectModal
          group={correctModal}
          onClose={() => setCorrectModal(null)}
          onSubmit={async (note) => {
            try {
              const json = await postAction("correct", correctModal, {
                correctionNote: note,
              });
              applyCorrection(correctModal.carcCode);
              setToast(`Queued ${json.updated ?? 0} correction(s).`);
              setCorrectModal(null);
            } catch (e) {
              setToast(e instanceof Error ? e.message : "Correct failed");
            }
          }}
        />
      ) : null}

      {ruleModal ? (
        <RuleModal
          group={ruleModal}
          onClose={() => setRuleModal(null)}
          onSubmit={async (payer, ruleSummary) => {
            try {
              await postAction("create_rule", ruleModal, { payer, ruleSummary });
              setToast(`Payer rule proposed for ${payer}.`);
              setRuleModal(null);
            } catch (e) {
              setToast(e instanceof Error ? e.message : "Rule failed");
            }
          }}
        />
      ) : null}

      {holdClaim ? (
        <PlaceClaimOnHoldModal
          claimId={holdClaim.claimId}
          organizationId={organizationId}
          subtitle={`Claim ${holdClaim.claimNumber} · ${holdClaim.payer}`}
          onClose={() => setHoldClaim(null)}
          onPlaced={() => {
            const label = holdClaim.claimNumber || holdClaim.claimId;
            const carcCode = selectedGroup?.carcCode ?? null;
            if (carcCode) removeClaimFromGroup(carcCode, holdClaim.claimId);
            setToast(`Claim ${label} placed on hold.`);
          }}
        />
      ) : null}

      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}

// ── Modals ──────────────────────────────────────────────────────────────────

function AssignModal({
  group,
  onClose,
  onSubmit,
}: {
  group: CarcGroup;
  summaryHint: ApiPayload["summary"] | null;
  onClose: () => void;
  onSubmit: (userId: string) => void;
}) {
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <ModalShell title={`Bulk assign — CARC ${group.carcCode}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Assigns every one of the {group.claimCount} claim
        {group.claimCount === 1 ? "" : "s"} in this CARC group to a single biller.
      </p>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        Assignee user ID
      </label>
      <input
        type="text"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        placeholder="UUID — leave blank to unassign"
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4 }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="button"
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(userId.trim());
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
        >
          {busy ? "Assigning…" : "Assign"}
        </button>
      </div>
    </ModalShell>
  );
}

function AppealModal({
  group,
  templates,
  onClose,
  onSubmit,
}: {
  group: CarcGroup;
  templates: Array<{ id: string; name: string; body: string; isSystem: boolean }>;
  onClose: () => void;
  onSubmit: (body: string) => void;
}) {
  const [templateId, setTemplateId] = useState("");
  const [body, setBody] = useState(group.suggestedCorrection);
  const [busy, setBusy] = useState(false);

  function pickTemplate(id: string) {
    setTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (tpl) setBody(tpl.body);
  }

  return (
    <ModalShell title={`Bulk appeal — CARC ${group.carcCode}`} onClose={onClose} width={680}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Drafts an appeal note on each of the {group.claimCount} claim
        {group.claimCount === 1 ? "" : "s"} in this CARC group.
      </p>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        Template
      </label>
      <select
        value={templateId}
        onChange={(e) => pickTemplate(e.target.value)}
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4 }}
      >
        <option value="">— Choose a template —</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.isSystem ? " (system)" : ""}
          </option>
        ))}
      </select>
      <label
        style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 4 }}
      >
        Appeal letter
      </label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={12}
        style={{
          width: "100%",
          padding: 8,
          border: "1px solid #D1D5DB",
          borderRadius: 4,
          fontFamily: "inherit",
        }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="button"
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(body);
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
        >
          {busy ? "Drafting…" : "Draft appeals"}
        </button>
      </div>
    </ModalShell>
  );
}

function CorrectModal({
  group,
  onClose,
  onSubmit,
}: {
  group: CarcGroup;
  onClose: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState(group.suggestedCorrection);
  const [busy, setBusy] = useState(false);
  return (
    <ModalShell title={`Bulk correct — CARC ${group.carcCode}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Marks {group.claimCount} workqueue item
        {group.claimCount === 1 ? "" : "s"} as in-progress with action
        "correction_queued" and logs the note below on each claim.
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={6}
        style={{
          width: "100%",
          padding: 8,
          border: "1px solid #D1D5DB",
          borderRadius: 4,
          fontFamily: "inherit",
        }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="button"
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(note);
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
        >
          {busy ? "Queueing…" : "Queue corrections"}
        </button>
      </div>
    </ModalShell>
  );
}

function RuleModal({
  group,
  onClose,
  onSubmit,
}: {
  group: CarcGroup;
  onClose: () => void;
  onSubmit: (payer: string, ruleSummary: string) => void;
}) {
  const [payer, setPayer] = useState(group.payers[0] ?? "");
  const [ruleSummary, setRuleSummary] = useState(
    `Auto-flag claims to ${group.payers[0] ?? "<payer>"} likely to deny with CARC ${group.carcCode}: ${group.suggestedCorrection}`,
  );
  const [busy, setBusy] = useState(false);
  return (
    <ModalShell title={`Create payer rule — CARC ${group.carcCode}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Records a payer-rule proposal as a billing alert and a claim note so a
        biller-lead can review and codify it.
      </p>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        Payer
      </label>
      <select
        value={payer}
        onChange={(e) => setPayer(e.target.value)}
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4 }}
      >
        {group.payers.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <label
        style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 4 }}
      >
        Rule summary
      </label>
      <textarea
        value={ruleSummary}
        onChange={(e) => setRuleSummary(e.target.value)}
        rows={5}
        style={{
          width: "100%",
          padding: 8,
          border: "1px solid #D1D5DB",
          borderRadius: 4,
          fontFamily: "inherit",
        }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="button"
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(payer.trim(), ruleSummary.trim());
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy || !payer.trim() || !ruleSummary.trim()}
        >
          {busy ? "Saving…" : "Propose rule"}
        </button>
      </div>
    </ModalShell>
  );
}
