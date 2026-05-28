"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useRouter } from "next/navigation";
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

/* ─── Types (mirror /api/billing/era-batches) ───────────────────────────── */

interface BatchListItem {
  id: string;
  source: string;
  fileName: string | null;
  importStatus: string;
  payer: { identifier: string | null; name: string };
  eftOrCheckNumber: string | null;
  paymentMethodCode: string | null;
  paymentDate: string | null;
  receivedAt: string | null;
  totalPaymentAmount: number;
  totalPatientResponsibility: number;
  totalAllocated: number;
  unallocated: number;
  counts: {
    total: number;
    matched: number;
    unmatched: number;
    blocked: number;
    posted: number;
    denied: number;
    recoupment: number;
  };
  archivedAt: string | null;
  deferred: boolean;
  markedDuplicateOf: string | null;
  assignedBiller: string | null;
  clients: string[];
  clinicians: string[];
  practices: string[];
  dosFrom: string | null;
  dosTo: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BatchDetailPayload {
  batch: {
    id: string;
    fileName: string | null;
    importStatus: string;
    payer: { identifier: string | null; name: string };
    eftOrCheckNumber: string | null;
    paymentMethodCode: string | null;
    paymentDate: string | null;
    receivedAt: string | null;
    rawContent: string;
    parsedSummary: Record<string, unknown> | null;
    archivedAt: string | null;
    summary: {
      totalPaymentAmount: number;
      totalAllocated: number;
      totalAdjustments: number;
      unallocated: number;
      totalClaims: number;
      matched: number;
      unmatched: number;
      posted: number;
      blocked: number;
    };
  };
  claimPayments: Array<{
    id: string;
    clp01ClaimControlNumber: string;
    payerClaimControlNumber: string | null;
    totalCharge: number;
    paymentAmount: number;
    patientResponsibility: number;
    claimMatchStatus: string;
    postingStatus: string;
    casAdjustments: Array<{ groupCode: string | null; reasonCode: string | null; amount: number }>;
    professionalClaim: { claimNumber: string | null; dateOfServiceFrom: string | null } | null;
    client: { displayName: string } | null;
    validation: {
      blocking: Array<{ code: string; field: string; message: string }>;
      warning: Array<{ code: string; field: string; message: string }>;
    };
  }>;
  adjustments: Array<{
    id: string;
    scope: string;
    adjustmentType: string;
    groupCode: string | null;
    reasonCode: string | null;
    amount: number;
    description: string | null;
    eraClaimPaymentId: string | null;
  }>;
}

type TabId = "new" | "processing" | "posted" | "failed" | "duplicate";

const TAB_DEFS: Array<{ id: TabId; label: string }> = [
  { id: "new", label: "New ERA Files" },
  { id: "processing", label: "Processing" },
  { id: "posted", label: "Posted" },
  { id: "failed", label: "Failed Import" },
  { id: "duplicate", label: "Duplicate ERA" },
];

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function money(value: number): string {
  return Number(value ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function ciContains(haystack: string | null | undefined, needle: string): boolean {
  if (!needle) return true;
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Render a list of names into a compact, in-row summary. We try to surface the
 * one that matches the active filter rail (so billers can see "why" the row is
 * present) and roll up the rest behind "+N more".
 */
function renderNameList(
  names: string[],
  highlightNeedle: string,
): { text: string; matchedIndex: number; highlighted: boolean } {
  if (!names || names.length === 0) {
    return { text: "—", matchedIndex: -1, highlighted: false };
  }
  const needle = highlightNeedle.trim().toLowerCase();
  let primaryIdx = 0;
  let highlighted = false;
  if (needle) {
    const m = names.findIndex((n) => n.toLowerCase().includes(needle));
    if (m >= 0) {
      primaryIdx = m;
      highlighted = true;
    }
  }
  const primary = names[primaryIdx];
  const extra = names.length - 1;
  const text = extra > 0 ? `${primary} +${extra} more` : primary;
  return { text, matchedIndex: primaryIdx, highlighted };
}

function formatDosRange(
  from: string | null,
  to: string | null,
): string {
  if (!from && !to) return "—";
  const a = formatDate(from);
  const b = formatDate(to);
  if (a === b) return a;
  return `${a} – ${b}`;
}

function dosRangeOverlapsFilter(
  from: string | null,
  to: string | null,
  filterFrom: string,
  filterTo: string,
): boolean {
  if (!filterFrom && !filterTo) return false;
  if (!from && !to) return false;
  if (filterFrom && to && to < filterFrom) return false;
  if (filterTo && from && from > filterTo) return false;
  return true;
}

function tabFor(b: BatchListItem): TabId {
  if (b.markedDuplicateOf || (b.archivedAt && !!b.markedDuplicateOf)) return "duplicate";
  if (b.importStatus === "failed") return "failed";
  if (b.counts.total > 0 && b.counts.posted === b.counts.total) return "posted";
  if (b.counts.posted > 0 || b.counts.matched > 0) return "processing";
  return "new";
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

function downloadCsv(filename: string, rows: BatchListItem[]) {
  const header = [
    "ERA file",
    "Payer",
    "Payer ID",
    "Received",
    "Payment date",
    "EFT/Check",
    "Payment amount",
    "Claims",
    "Matched",
    "Unmatched",
    "Posted",
    "Blocked",
    "Import status",
    "Clients",
    "Clinicians",
    "DOS from",
    "DOS to",
  ];
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for (const b of rows) {
    lines.push(
      [
        b.fileName,
        b.payer.name,
        b.payer.identifier,
        b.receivedAt,
        b.paymentDate,
        b.eftOrCheckNumber,
        b.totalPaymentAmount,
        b.counts.total,
        b.counts.matched,
        b.counts.unmatched,
        b.counts.posted,
        b.counts.blocked,
        b.importStatus,
        b.clients.join("; "),
        b.clinicians.join("; "),
        b.dosFrom,
        b.dosTo,
      ]
        .map(escape)
        .join(","),
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const queueDef = getWorkqueue("era_import");

/* ─── Component ─────────────────────────────────────────────────────────── */

export default function EraImportClient() {
  const router = useRouter();
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [items, setItems] = useState<BatchListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeTab, setActiveTab] = useState<TabId>("new");
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);
  const [detail, setDetail] = useState<BatchDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // The client/clinician/practice/DOS filters require joining through
  // era_claim_payments to professional_claims/clients, so we let the API do
  // the join and refetch whenever any of them change. The remaining filters
  // (payer, status, $ range, aging, …) stay client-side because they're
  // already on the batch row.
  const patientFilter = filterValues.client ?? "";
  const clinicianFilter = filterValues.clinician ?? "";
  const practiceFilter = filterValues.practice ?? "";
  const dosFromFilter = filterValues.dosFrom ?? "";
  const dosToFilter = filterValues.dosTo ?? "";

  // Typeahead options fetched once per org. Clients carry an id so we can
  // send a canonical client UUID when the biller picks a suggestion; the
  // clinician/practice typeaheads are name- and code-based respectively.
  const [patientOptions, setPatientOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [clinicianOptions, setClinicianOptions] = useState<string[]>([]);
  const [practiceOptions, setPracticeOptions] = useState<string[]>([]);

  useEffect(() => {
    const qs = new URLSearchParams({ organizationId });
    fetch(`/api/billing/era-batches/filter-options?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (!json?.success) return;
        setPatientOptions(Array.isArray(json.clients) ? json.clients : []);
        setClinicianOptions(
          Array.isArray(json.clinicians)
            ? json.clinicians.map((c: { name: string }) => c.name).filter(Boolean)
            : [],
        );
        setPracticeOptions(
          Array.isArray(json.practices)
            ? json.practices.map((p: { code: string }) => p.code).filter(Boolean)
            : [],
        );
      })
      .catch(() => {
        /* typeahead options are best-effort; fall back to free-text */
      });
  }, [organizationId]);

  // The client filter binds to two pieces of state: the visible text
  // (mirrored into `filterValues.client` so URL persistence keeps working)
  // and an explicit `selectedClientId` set only when the biller clicks a
  // suggestion in the picker. Typing into the input clears the id, so a
  // selection always carries an unambiguous identifier — two clients with
  // the same display name can't collide because the picker captures the
  // actual UUID at click time. Free-typed text falls back to the legacy
  // `client` ilike search.
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [patientPickerOpen, setPatientPickerOpen] = useState(false);

  // Keep the explicit UUID in lockstep with the visible filter value: if the
  // text is empty (because the user cleared it or clicked "Clear filters" on
  // the rail) we must drop the id too, otherwise the API keeps filtering by
  // clientId while the rail shows no client selected. Same goes for any
  // external mutation (URL nav, etc.) that changes the value out from under
  // the picker.
  useEffect(() => {
    if (!patientFilter) {
      if (selectedClientId) setSelectedClientId(null);
      return;
    }
    if (selectedClientId) {
      const match = patientOptions.find((p) => p.id === selectedClientId);
      if (!match || match.name.toLowerCase() !== patientFilter.toLowerCase()) {
        setSelectedClientId(null);
      }
    }
  }, [patientFilter, selectedClientId, patientOptions]);

  // ── Load list (always include archived so the Duplicate tab is populated)
  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams({ organizationId, includeArchived: "1" });
    if (selectedClientId) {
      qs.set("clientId", selectedClientId);
    } else if (patientFilter.trim()) {
      qs.set("client", patientFilter.trim());
    }
    if (clinicianFilter.trim()) qs.set("clinician", clinicianFilter.trim());
    if (practiceFilter.trim()) qs.set("practice", practiceFilter.trim());
    if (dosFromFilter) qs.set("dosFrom", dosFromFilter);
    if (dosToFilter) qs.set("dosTo", dosToFilter);
    fetch(`/api/billing/era-batches?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (json.success && Array.isArray(json.items)) {
          setItems(json.items as BatchListItem[]);
        } else {
          setItems([]);
          if (json.error) setMessage({ tone: "error", text: String(json.error) });
        }
      })
      .catch((e) =>
        setMessage({ tone: "error", text: e instanceof Error ? e.message : "Failed to load" }),
      )
      .finally(() => setLoading(false));
  }, [
    organizationId,
    reloadKey,
    patientFilter,
    selectedClientId,
    clinicianFilter,
    practiceFilter,
    dosFromFilter,
    dosToFilter,
  ]);

  // ── Load detail on selection
  useEffect(() => {
    if (!selectedRowId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    const qs = new URLSearchParams({ organizationId });
    fetch(`/api/billing/era-batches/${selectedRowId}?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setDetail(json as BatchDetailPayload);
        else setDetail(null);
      })
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, [selectedRowId, organizationId, reloadKey]);

  // ── Counts per tab
  const tabCounts = useMemo(() => {
    const c: Record<TabId, number> = { new: 0, processing: 0, posted: 0, failed: 0, duplicate: 0 };
    for (const b of items) c[tabFor(b)] += 1;
    return c;
  }, [items]);

  // ── Filter options derived from rows
  const payerOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of items) if (b.payer.name) m.set(b.payer.name, b.payer.name);
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  // ── Filter rail (universal)
  const filters: FilterDef[] = useMemo(
    () => [
      {
        id: "practice",
        label: "Practice",
        kind: "combobox",
        placeholder: "POS code…",
        options: practiceOptions.map((code) => ({ value: code, label: code })),
      },
      {
        id: "clinician",
        label: "Clinician",
        kind: "combobox",
        placeholder: "Rendering provider…",
        options: clinicianOptions.map((name) => ({ value: name, label: name })),
      },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      {
        id: "client",
        label: "Client",
        kind: "text",
        placeholder: "Client name…",
        // Custom picker: explicit selection captures the client's UUID so
        // duplicate display names can't collide. Free-typing clears the id
        // and falls back to the legacy ilike `client` search.
        render: (value, setValue) => {
          const needle = value.trim().toLowerCase();
          const suggestions = needle
            ? patientOptions
                .filter((p) => p.name.toLowerCase().includes(needle))
                .slice(0, 12)
            : patientOptions.slice(0, 12);
          return (
            <div style={{ position: "relative" }}>
              <input
                aria-label="Client"
                type="text"
                className="wq-filter-input"
                placeholder="Client name…"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setSelectedClientId(null);
                }}
                onFocus={() => setPatientPickerOpen(true)}
                onBlur={() => {
                  // Defer so a mousedown on a suggestion can fire first.
                  setTimeout(() => setPatientPickerOpen(false), 150);
                }}
                autoComplete="off"
                style={{
                  height: 28,
                  padding: "0 8px",
                  fontSize: 13,
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  minWidth: 160,
                }}
              />
              {selectedClientId ? (
                <span
                  title={`Filtering by client id ${selectedClientId}`}
                  style={{
                    position: "absolute",
                    right: 6,
                    top: 6,
                    fontSize: 10,
                    color: "#0F766E",
                    fontWeight: 700,
                  }}
                >
                  ID
                </span>
              ) : null}
              {patientPickerOpen && suggestions.length > 0 ? (
                <ul
                  role="listbox"
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    right: 0,
                    margin: 0,
                    padding: 4,
                    listStyle: "none",
                    background: "white",
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    boxShadow: "0 4px 12px rgba(15,23,42,0.08)",
                    zIndex: 20,
                    maxHeight: 240,
                    overflowY: "auto",
                    minWidth: 200,
                  }}
                >
                  {suggestions.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        role="option"
                        onMouseDown={(e) => {
                          // Prevent the input's onBlur from firing before
                          // the click handler resolves.
                          e.preventDefault();
                        }}
                        onClick={() => {
                          setValue(p.name);
                          setSelectedClientId(p.id);
                          setPatientPickerOpen(false);
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "4px 8px",
                          fontSize: 13,
                          background: "transparent",
                          border: "none",
                          borderRadius: 4,
                          cursor: "pointer",
                        }}
                      >
                        {p.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        },
      },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "uploaded", label: "Uploaded" },
          { value: "parsed", label: "Parsed" },
          { value: "matched", label: "Matched" },
          { value: "posted", label: "Posted" },
          { value: "blocked", label: "Blocked" },
          { value: "failed", label: "Failed" },
        ],
      },
      { id: "assignedBiller", label: "Assigned biller", kind: "text", placeholder: "Name or 'unassigned'" },
      { id: "minAmount", label: "Min $", kind: "number" },
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
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "EFT, file, ICN…" },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [
          { value: "urgent", label: "Urgent" },
          { value: "normal", label: "Normal" },
        ],
      },
      { id: "followUpDue", label: "Follow-up due", kind: "date" },
    ],
    [payerOptions, patientOptions, clinicianOptions, practiceOptions, selectedClientId, patientPickerOpen],
  );

  // ── Narrow to tab, then apply universal filter pass
  const tabRows = useMemo(() => items.filter((b) => tabFor(b) === activeTab), [items, activeTab]);

  const filtered = useMemo(() => {
    const v = filterValues;
    return tabRows.filter((b) => {
      if (v.payer && b.payer.name !== v.payer) return false;
      if (v.status && b.importStatus.toLowerCase() !== v.status.toLowerCase()) return false;
      if (v.assignedBiller) {
        const needle = v.assignedBiller.trim().toLowerCase();
        const unassigned = ["unassigned", "—", "-", "none"].includes(needle);
        if (unassigned) {
          if (b.assignedBiller && b.assignedBiller.trim()) return false;
        } else if (!ciContains(b.assignedBiller, v.assignedBiller)) {
          return false;
        }
      }
      if (v.minAmount) {
        const n = Number(v.minAmount);
        if (Number.isFinite(n) && b.totalPaymentAmount < n) return false;
      }
      if (v.maxAmount) {
        const n = Number(v.maxAmount);
        if (Number.isFinite(n) && b.totalPaymentAmount > n) return false;
      }
      if (v.agingBucket) {
        const a = ageDays(b.receivedAt) ?? 0;
        const ok =
          v.agingBucket === "0-7" ? a <= 7
          : v.agingBucket === "8-30" ? a >= 8 && a <= 30
          : v.agingBucket === "31-60" ? a >= 31 && a <= 60
          : v.agingBucket === "60+" ? a > 60
          : true;
        if (!ok) return false;
      }
      if (v.priority === "urgent") {
        const urgent = b.counts.unmatched > 0 || b.counts.blocked > 0 || (ageDays(b.receivedAt) ?? 0) > 7;
        if (!urgent) return false;
      }
      if (v.carcRarc) {
        const blob = [b.eftOrCheckNumber, b.fileName, b.payer.identifier, b.id].join(" ");
        if (!ciContains(blob, v.carcRarc)) return false;
      }
      if (v.followUpDue) {
        const r = b.receivedAt ? b.receivedAt.slice(0, 10) : null;
        if (r !== v.followUpDue) return false;
      }
      if (v.client && !selectedClientId) {
        // When a typeahead suggestion is selected we trust the server's
        // clientId-based filter and skip the local name-match. Otherwise
        // the displayed label (which may carry extra disambiguators) can
        // diverge from the bare "first last" string stored on each row
        // and silently filter all matching batches out.
        const needle = v.client.trim().toLowerCase();
        if (!b.clients.some((p) => p.toLowerCase().includes(needle))) return false;
      }
      if (v.clinician) {
        const needle = v.clinician.trim().toLowerCase();
        if (!b.clinicians.some((c) => c.toLowerCase().includes(needle))) return false;
      }
      if (v.practice) {
        const needle = v.practice.trim().toLowerCase();
        if (!b.practices.some((p) => p.toLowerCase().includes(needle))) return false;
      }
      // DOS filters: keep the batch if its DOS range overlaps the selected
      // window. A batch with no DOS info on file is excluded once either
      // bound is set so the filter behaves predictably.
      if (v.dosFrom) {
        if (!b.dosTo || b.dosTo < v.dosFrom) return false;
      }
      if (v.dosTo) {
        if (!b.dosFrom || b.dosFrom > v.dosTo) return false;
      }
      return true;
    });
  }, [tabRows, filterValues, selectedClientId]);

  // ── Summary strip
  const summary: SummaryMetric[] = useMemo(() => {
    const dollars = tabRows.reduce((s, b) => s + (b.totalPaymentAmount || 0), 0);
    const ages = tabRows.map((b) => ageDays(b.receivedAt)).filter((n): n is number => n != null);
    const oldest = ages.length ? Math.max(...ages) : 0;
    const urgent = tabRows.filter(
      (b) => b.counts.unmatched > 0 || b.counts.blocked > 0 || (ageDays(b.receivedAt) ?? 0) > 7,
    ).length;
    return [
      { id: "count", label: "ERA files", value: tabRows.length.toLocaleString() },
      { id: "dollars", label: "Total $", value: money(dollars) },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: oldest,
        tone: oldest > 14 ? "red" : oldest > 7 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: urgent,
        tone: urgent > 0 ? "amber" : "default",
      },
    ];
  }, [tabRows]);

  // ── Columns: match spec exactly
  const columns: ColumnDef<BatchListItem>[] = useMemo(
    () => [
      {
        id: "fileName",
        header: "ERA file name",
        cell: (b) => (
          <span
            title={b.fileName ?? undefined}
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              display: "inline-block",
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              verticalAlign: "middle",
            }}
          >
            {b.fileName ?? b.id.slice(0, 8)}
          </span>
        ),
      },
      {
        id: "payer",
        header: "Payer",
        cell: (b) => (
          <span>
            <strong style={{ fontWeight: 600 }}>{b.payer.name}</strong>
            {b.payer.identifier ? (
              <span style={{ marginLeft: 6, color: "#64748B", fontSize: 11 }}>
                {b.payer.identifier}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "clients",
        header: "Clients",
        cell: (b) => {
          const { text, highlighted } = renderNameList(b.clients, filterValues.client ?? "");
          const title = b.clients.length ? b.clients.join(", ") : undefined;
          return (
            <span
              title={title}
              style={{
                display: "inline-block",
                maxWidth: 200,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                verticalAlign: "middle",
                background: highlighted ? "#FEF3C7" : undefined,
                color: highlighted ? "#92400E" : b.clients.length ? "#0F172A" : "#94A3B8",
                fontWeight: highlighted ? 600 : 400,
                padding: highlighted ? "1px 6px" : undefined,
                borderRadius: highlighted ? 4 : undefined,
                fontSize: 12,
              }}
            >
              {text}
            </span>
          );
        },
      },
      {
        id: "clinicians",
        header: "Clinicians",
        cell: (b) => {
          const { text, highlighted } = renderNameList(b.clinicians, filterValues.clinician ?? "");
          const title = b.clinicians.length ? b.clinicians.join(", ") : undefined;
          return (
            <span
              title={title}
              style={{
                display: "inline-block",
                maxWidth: 200,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                verticalAlign: "middle",
                background: highlighted ? "#FEF3C7" : undefined,
                color: highlighted ? "#92400E" : b.clinicians.length ? "#0F172A" : "#94A3B8",
                fontWeight: highlighted ? 600 : 400,
                padding: highlighted ? "1px 6px" : undefined,
                borderRadius: highlighted ? 4 : undefined,
                fontSize: 12,
              }}
            >
              {text}
            </span>
          );
        },
      },
      {
        id: "dosRange",
        header: "Dates of service",
        cell: (b) => {
          const highlighted = dosRangeOverlapsFilter(
            b.dosFrom,
            b.dosTo,
            filterValues.dosFrom ?? "",
            filterValues.dosTo ?? "",
          );
          const text = formatDosRange(b.dosFrom, b.dosTo);
          const empty = !b.dosFrom && !b.dosTo;
          return (
            <span
              style={{
                fontSize: 12,
                color: highlighted ? "#92400E" : empty ? "#94A3B8" : "#0F172A",
                background: highlighted ? "#FEF3C7" : undefined,
                fontWeight: highlighted ? 600 : 400,
                padding: highlighted ? "1px 6px" : undefined,
                borderRadius: highlighted ? 4 : undefined,
                whiteSpace: "nowrap",
              }}
            >
              {text}
            </span>
          );
        },
      },
      { id: "receivedAt", header: "Received date", cell: (b) => formatDate(b.receivedAt) },
      {
        id: "totalPaymentAmount",
        header: "Payment amount",
        align: "right",
        cell: (b) => money(b.totalPaymentAmount),
      },
      {
        id: "claimCount",
        header: "Claim count",
        align: "right",
        cell: (b) => b.counts.total.toLocaleString(),
      },
      {
        id: "eft",
        header: "Check/EFT number",
        cell: (b) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {b.eftOrCheckNumber ?? "—"}
          </span>
        ),
      },
      {
        id: "importStatus",
        header: "Import status",
        cell: (b) => {
          const status = b.markedDuplicateOf
            ? "duplicate"
            : b.importStatus;
          const map: Record<string, { bg: string; fg: string }> = {
            uploaded: { bg: "#DBEAFE", fg: "#1E40AF" },
            parsed: { bg: "#E0E7FF", fg: "#3730A3" },
            matched: { bg: "#DCFCE7", fg: "#166534" },
            posted: { bg: "#D1FAE5", fg: "#065F46" },
            blocked: { bg: "#FEE2E2", fg: "#991B1B" },
            failed: { bg: "#FEE2E2", fg: "#991B1B" },
            duplicate: { bg: "#FEF3C7", fg: "#92400E" },
          };
          const tone = map[status] ?? { bg: "#F1F5F9", fg: "#475569" };
          return (
            <span
              style={{
                background: tone.bg,
                color: tone.fg,
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {status}
            </span>
          );
        },
      },
      {
        id: "unmatched",
        header: "Unmatched count",
        align: "right",
        cell: (b) => (
          <span
            style={{
              color: b.counts.unmatched > 0 ? "#92400E" : "#475569",
              fontWeight: b.counts.unmatched > 0 ? 700 : 400,
            }}
          >
            {b.counts.unmatched.toLocaleString()}
          </span>
        ),
      },
    ],
    [filterValues],
  );

  // ── Selection lifecycle
  useEffect(() => {
    if (!selectedRowId) return;
    if (!filtered.some((b) => b.id === selectedRowId)) setSelectedRowId(null);
  }, [filtered, selectedRowId]);

  // ── Mutations
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const patchRow = useCallback((id: string, patch: Partial<BatchListItem>) => {
    setItems((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const markDuplicate = useCallback(
    async (b: BatchListItem) => {
      if (typeof window === "undefined") return;
      const ofId =
        window.prompt(
          `Mark ${b.fileName ?? b.id.slice(0, 8)} as a duplicate of which batch ID? (Leave blank to just flag.)`,
          "",
        ) ?? null;
      if (ofId === null) return;
      const trimmed = ofId.trim() || undefined;
      setBusyId(b.id);
      const snapshot = items;
      patchRow(b.id, {
        markedDuplicateOf: trimmed ?? b.id,
        archivedAt: new Date().toISOString(),
      });
      try {
        const res = await fetch(`/api/billing/era-batches/${b.id}/archive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            reason: "duplicate",
            duplicateOfBatchId: trimmed,
          }),
        });
        const json = await res.json();
        if (!res.ok || json.success === false) throw new Error(json.error || "Mark duplicate failed");
        setMessage({ tone: "success", text: "Marked as duplicate." });
        reload();
      } catch (e) {
        setItems(snapshot);
        setMessage({ tone: "error", text: e instanceof Error ? e.message : "Mark duplicate failed" });
      } finally {
        setBusyId(null);
      }
    },
    [items, organizationId, patchRow, reload],
  );

  const postPayments = useCallback(
    async (b: BatchListItem) => {
      setBusyId(b.id);
      setMessage(null);
      try {
        // Auto-match anything still loose, then route the biller to the
        // poster where they confirm and commit the actual ledger writes.
        const res = await fetch(`/api/billing/era-batches/${b.id}/auto-match`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId }),
        });
        const json = await res.json();
        if (res.ok && json.success) {
          const bound = json.bound ?? 0;
          const processed = json.processed ?? 0;
          if (processed > 0) {
            setMessage({
              tone: "success",
              text: `Auto-matched ${bound}/${processed}. Opening poster…`,
            });
          }
        }
      } catch {
        // Auto-match is best-effort — fall through to the poster regardless.
      } finally {
        setBusyId(null);
      }
      router.push(`/billing/era-import/${b.id}`);
    },
    [organizationId, router],
  );

  const reviewPayments = useCallback(
    (b: BatchListItem) => {
      router.push(`/billing/era-import/${b.id}`);
    },
    [router],
  );

  const triggerImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onImportFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setImporting(true);
      setMessage(null);
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("organizationId", organizationId);
        const res = await fetch("/api/payments/import-835", { method: "POST", body: form });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.success === false) {
          throw new Error(json?.error || `Import failed (${res.status})`);
        }
        const s = json?.summary ?? {};
        const parts: string[] = [`Imported ${file.name}`];
        if (typeof s.claimsFound === "number") parts.push(`${s.claimsFound} claim(s)`);
        if (typeof s.matchedClaims === "number") parts.push(`${s.matchedClaims} matched`);
        if (typeof s.unmatchedClaims === "number" && s.unmatchedClaims > 0)
          parts.push(`${s.unmatchedClaims} unmatched`);
        setMessage({ tone: "success", text: parts.join(" · ") });
        reload();
      } catch (err) {
        setMessage({ tone: "error", text: err instanceof Error ? err.message : "835 import failed" });
      } finally {
        setImporting(false);
      }
    },
    [organizationId, reload],
  );

  const exportReport = useCallback(
    (b: BatchListItem) => {
      const fname = `era-${(b.fileName ?? b.id.slice(0, 8)).replace(/[^A-Za-z0-9_.-]+/g, "_")}.csv`;
      downloadCsv(fname, [b]);
      setMessage({ tone: "success", text: `Exported ${fname}.` });
    },
    [],
  );

  // ── Row actions (spec: Import ERA, Review payments, Post payments, Mark duplicate, Export report)
  const rowActions: RowAction<BatchListItem>[] = useMemo(
    () => [
      {
        id: "import",
        label: importing ? "Importing…" : "Import ERA",
        onClick: () => triggerImport(),
        disabled: () => importing,
      },
      {
        id: "review",
        label: "Review payments",
        onClick: (b) => reviewPayments(b),
      },
      {
        id: "post",
        label: "Post payments",
        variant: "primary",
        onClick: (b) => void postPayments(b),
        disabled: (b) => busyId === b.id || b.counts.total === 0 || !!b.archivedAt,
      },
      {
        id: "duplicate",
        label: "Mark duplicate",
        onClick: (b) => void markDuplicate(b),
        disabled: (b) => busyId === b.id || !!b.markedDuplicateOf,
      },
      {
        id: "export",
        label: "Export report",
        onClick: (b) => exportReport(b),
      },
    ],
    [busyId, exportReport, importing, markDuplicate, postPayments, reviewPayments, triggerImport],
  );

  // ── Header actions
  const selectedRow = useMemo(
    () => filtered.find((b) => b.id === selectedRowId) ?? null,
    [filtered, selectedRowId],
  );

  const headerActions: PrimaryAction[] = useMemo(
    () => [
      {
        id: "import",
        label: importing ? "Importing 835…" : "Import ERA",
        variant: "primary",
        onClick: triggerImport,
        disabled: importing,
      },
      {
        id: "refresh",
        label: "Refresh",
        onClick: reload,
      },
      {
        id: "export-all",
        label: "Export report",
        onClick: () => {
          downloadCsv(`era-import-${activeTab}.csv`, tabRows);
          setMessage({ tone: "success", text: `Exported ${tabRows.length} row(s).` });
        },
        disabled: tabRows.length === 0,
      },
    ],
    [activeTab, importing, reload, tabRows, triggerImport],
  );

  // ── Detail panel sections (spec)
  const detailTabs: DetailTab[] = useMemo(() => {
    if (!selectedRow) return [];
    const d = detail;
    const b = selectedRow;
    const card = (label: string, value: React.ReactNode) => (
      <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 4, fontSize: 12 }}>
        <span style={{ color: "#64748B" }}>{label}</span>
        <span style={{ fontWeight: 500 }}>{value}</span>
      </div>
    );
    return [
      {
        id: "fileSummary",
        label: "835 file summary",
        render: () => (
          <div style={{ display: "grid", gap: 8 }}>
            {card("ERA file name", b.fileName ?? "—")}
            {card("Source", b.source ?? "—")}
            {card("Import status", b.importStatus)}
            {card("Received", formatDate(b.receivedAt))}
            {card("Payer", `${b.payer.name}${b.payer.identifier ? ` (${b.payer.identifier})` : ""}`)}
            {card("Marked duplicate of", b.markedDuplicateOf ?? "—")}
            {card("Deferred", b.deferred ? "Yes" : "No")}
            {d?.batch.rawContent ? (
              <details>
                <summary style={{ fontSize: 12, cursor: "pointer", color: "#0369A1" }}>
                  Raw 835 envelope
                </summary>
                <pre
                  style={{
                    marginTop: 8,
                    padding: 8,
                    background: "#0F172A",
                    color: "#F1F5F9",
                    fontSize: 11,
                    borderRadius: 4,
                    maxHeight: 200,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {d.batch.rawContent.split("~").slice(0, 12).join("~\n")}
                </pre>
              </details>
            ) : null}
          </div>
        ),
      },
      {
        id: "paymentDetails",
        label: "Payment details",
        render: () => (
          <div style={{ display: "grid", gap: 8 }}>
            {card("Payment amount", money(b.totalPaymentAmount))}
            {card("Allocated", money(b.totalAllocated))}
            {card(
              "Unallocated",
              <span
                style={{
                  color:
                    b.unallocated > 0.01 ? "#92400E" : b.unallocated < -0.01 ? "#991B1B" : "#166534",
                  fontWeight: 600,
                }}
              >
                {money(b.unallocated)}
              </span>,
            )}
            {card("Client responsibility", money(b.totalPatientResponsibility))}
            {card("Payment date", formatDate(b.paymentDate))}
            {card("Check / EFT", b.eftOrCheckNumber ?? "—")}
            {card("Payment method", b.paymentMethodCode ?? "—")}
          </div>
        ),
      },
      {
        id: "claimLines",
        label: "Claim payment lines",
        render: () =>
          detailLoading ? (
            <div style={{ color: "#64748B", fontSize: 12 }}>Loading…</div>
          ) : !d || d.claimPayments.length === 0 ? (
            <div style={{ color: "#64748B", fontSize: 12 }}>No claim payment lines.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ background: "#F1F5F9" }}>
                  <th style={{ padding: 4, textAlign: "left" }}>Client / CLP</th>
                  <th style={{ padding: 4, textAlign: "right" }}>Charge</th>
                  <th style={{ padding: 4, textAlign: "right" }}>Paid</th>
                  <th style={{ padding: 4, textAlign: "right" }}>Pt resp</th>
                  <th style={{ padding: 4, textAlign: "left" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.claimPayments.map((cp) => (
                  <tr key={cp.id} style={{ borderTop: "1px solid #E2E8F0" }}>
                    <td style={{ padding: 4 }}>
                      <div>{cp.client?.displayName ?? <em style={{ color: "#92400E" }}>Unmatched</em>}</div>
                      <div style={{ color: "#64748B", fontFamily: "ui-monospace, monospace", fontSize: 10 }}>
                        {cp.clp01ClaimControlNumber}
                      </div>
                    </td>
                    <td style={{ padding: 4, textAlign: "right" }}>{money(cp.totalCharge)}</td>
                    <td style={{ padding: 4, textAlign: "right" }}>{money(cp.paymentAmount)}</td>
                    <td style={{ padding: 4, textAlign: "right" }}>{money(cp.patientResponsibility)}</td>
                    <td style={{ padding: 4, color: cp.postingStatus === "posted" ? "#166534" : "#475569" }}>
                      {cp.claimMatchStatus} / {cp.postingStatus}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ),
      },
      {
        id: "plb",
        label: "PLB adjustments",
        render: () => {
          const plb = (d?.adjustments ?? []).filter(
            (a) => a.scope === "provider_level" || a.adjustmentType === "recoupment",
          );
          if (detailLoading) return <div style={{ color: "#64748B", fontSize: 12 }}>Loading…</div>;
          if (plb.length === 0)
            return <div style={{ color: "#64748B", fontSize: 12 }}>No PLB adjustments recorded.</div>;
          return (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ background: "#F1F5F9" }}>
                  <th style={{ padding: 4, textAlign: "left" }}>Type</th>
                  <th style={{ padding: 4, textAlign: "left" }}>Reason</th>
                  <th style={{ padding: 4, textAlign: "right" }}>Amount</th>
                  <th style={{ padding: 4, textAlign: "left" }}>Description</th>
                </tr>
              </thead>
              <tbody>
                {plb.map((a) => (
                  <tr key={a.id} style={{ borderTop: "1px solid #E2E8F0" }}>
                    <td style={{ padding: 4 }}>{a.adjustmentType}</td>
                    <td style={{ padding: 4 }}>
                      {[a.groupCode, a.reasonCode].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td style={{ padding: 4, textAlign: "right" }}>{money(a.amount)}</td>
                    <td style={{ padding: 4, color: "#475569" }}>{a.description ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        },
      },
      {
        id: "errors",
        label: "Import errors",
        render: () => {
          if (detailLoading) return <div style={{ color: "#64748B", fontSize: 12 }}>Loading…</div>;
          const blocking =
            d?.claimPayments.flatMap((cp) =>
              cp.validation.blocking.map((iss) => ({ ...iss, clp: cp.clp01ClaimControlNumber })),
            ) ?? [];
          const warnings =
            d?.claimPayments.flatMap((cp) =>
              cp.validation.warning.map((iss) => ({ ...iss, clp: cp.clp01ClaimControlNumber })),
            ) ?? [];
          if (b.importStatus !== "failed" && blocking.length === 0 && warnings.length === 0) {
            return <div style={{ color: "#166534", fontSize: 12 }}>No import errors detected.</div>;
          }
          return (
            <div style={{ display: "grid", gap: 8 }}>
              {b.importStatus === "failed" ? (
                <div
                  style={{
                    padding: 8,
                    background: "#FEF2F2",
                    color: "#991B1B",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  Import failed. Re-upload the 835 or check the source feed.
                </div>
              ) : null}
              {blocking.length > 0 ? (
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                    Blocking ({blocking.length})
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                    {blocking.map((iss, i) => (
                      <li key={i} style={{ color: "#991B1B" }}>
                        <span style={{ fontFamily: "ui-monospace, monospace" }}>{iss.clp}</span>{" "}
                        — {iss.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {warnings.length > 0 ? (
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                    Warnings ({warnings.length})
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                    {warnings.map((iss, i) => (
                      <li key={i} style={{ color: "#92400E" }}>
                        <span style={{ fontFamily: "ui-monospace, monospace" }}>{iss.clp}</span>{" "}
                        — {iss.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        },
      },
    ];
  }, [selectedRow, detail, detailLoading]);

  // ── Detail panel actions
  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    return [
      {
        id: "import",
        label: importing ? "Importing…" : "Import ERA",
        onClick: () => triggerImport(),
        disabled: importing,
      },
      {
        id: "review",
        label: "Review payments",
        onClick: () => reviewPayments(selectedRow),
      },
      {
        id: "post",
        label: "Post payments",
        variant: "primary",
        onClick: () => void postPayments(selectedRow),
        disabled: busyId === selectedRow.id || selectedRow.counts.total === 0,
      },
      {
        id: "duplicate",
        label: "Mark duplicate",
        onClick: () => void markDuplicate(selectedRow),
        disabled: busyId === selectedRow.id || !!selectedRow.markedDuplicateOf,
      },
      {
        id: "export",
        label: "Export report",
        onClick: () => exportReport(selectedRow),
      },
    ];
  }, [busyId, exportReport, importing, markDuplicate, postPayments, reviewPayments, selectedRow, triggerImport]);

  const primaryTabs: PrimaryTab[] = TAB_DEFS.map((t) => ({
    id: t.id,
    label: t.label,
    count: tabCounts[t.id],
  }));

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".835,.edi,.txt,text/plain,application/edi-x12"
        style={{ display: "none" }}
        onChange={onImportFile}
      />
      <WorkqueueShell<BatchListItem>
        title={queueDef?.title ?? "ERA Import"}
        description={queueDef?.description}
        headerActions={headerActions}
        summary={summary}
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTab}
        onPrimaryTabChange={(id) => setActiveTab(id as TabId)}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace="wq"
        rows={filtered}
        columns={columns}
        rowId={(b) => b.id}
        loading={loading}
        emptyMessage="No ERA files in this tab."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        rowActions={rowActions}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />
    </>
  );
}
