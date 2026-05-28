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
import { getWorkqueue } from "@/lib/billing/workqueues";

type TabId =
  | "client_match_needed"
  | "claim_number_mismatch"
  | "payer_mismatch"
  | "duplicate_match"
  | "manual_review";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "client_match_needed", label: "Client Match Needed" },
  { id: "claim_number_mismatch", label: "Claim Number Mismatch" },
  { id: "payer_mismatch", label: "Payer Mismatch" },
  { id: "duplicate_match", label: "Duplicate Match" },
  { id: "manual_review", label: "Manual Review" },
];

type ActionId =
  | "match_claim"
  | "create_missing_claim_record"
  | "post_manually"
  | "ignore_line"
  | "escalate";

interface Candidate {
  professionalClaimId: string;
  claimNumber: string | null;
  payerClaimControlNumber?: string | null;
  patientDisplayName: string | null;
  dateOfServiceFrom: string | null;
  totalCharge: number;
  confidence: number;
  strategy: string;
  reasons: string[];
}

interface Row {
  id: string;
  eraClaimPaymentId: string;
  eraBatchId: string;
  workqueueItemId: string | null;
  payerProfileId: string | null;
  payerName: string | null;
  payerCheckEft: string | null;
  clientId: string | null;
  clientName: string;
  patientName: string;
  claimNumberFromEra: string;
  payerClaimControlNumber: string | null;
  dos: string | null;
  paidAmount: number;
  totalCharge: number;
  patientResponsibility: number;
  reasonUnmatched: string;
  postingStatus: string;
  matchStatus: string;
  receivedAt: string | null;
  agingDays: number | null;
  tab: TabId;
  possibleMatch: Candidate | null;
  duplicateCandidateCount: number;
  confidenceScore: number | null;
  candidates: Candidate[];
  assignedTo: string | null;
  priority: string | null;
  followUpDue: string | null;
  status: string | null;
  notes: Array<{
    id: string;
    body: string;
    type: string;
    createdAt: string | null;
    createdBy: string | null;
  }>;
}

interface ApiPayload {
  success: boolean;
  error?: string;
  items?: Row[];
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

function money(value: number): string {
  return Number(value ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function confidencePct(score: number | null): string {
  if (score == null) return "—";
  return `${Math.round(score * 100)}%`;
}

const queueDef = getWorkqueue("unmatched_era_claims");

export default function UnmatchedEraClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeTab, setActiveTab] = useState<TabId>("client_match_needed");
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);

  // ── Load ──────────────────────────────────────────────────────────────
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
    fetch(`/api/billing/unmatched-era?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<ApiPayload>)
      .then((json) => {
        if (json.success && Array.isArray(json.items)) {
          setItems(json.items);
        } else {
          setItems([]);
          if (json.error) setMessage({ tone: "error", text: json.error });
        }
      })
      .catch((e) =>
        setMessage({
          tone: "error",
          text: e instanceof Error ? e.message : "Failed to load",
        }),
      )
      .finally(() => setLoading(false));
  }, [organizationId, reloadKey, filterValues]);

  // ── Filter facets ─────────────────────────────────────────────────────
  const payerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of items)
      if (r.payerProfileId && r.payerName) map.set(r.payerProfileId, r.payerName);
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
  }, [items]);

  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of items)
      if (r.clientId && r.clientName !== "Unknown client")
        map.set(r.clientId, r.clientName);
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
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "Code or text…" },
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

  // ── Tabs + counts ─────────────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const c: Record<TabId, number> = {
      client_match_needed: 0,
      claim_number_mismatch: 0,
      payer_mismatch: 0,
      duplicate_match: 0,
      manual_review: 0,
    };
    for (const r of items) c[r.tab] += 1;
    return c;
  }, [items]);

  const primaryTabs: PrimaryTab[] = useMemo(
    () => TABS.map((t) => ({ id: t.id, label: t.label, count: tabCounts[t.id] })),
    [tabCounts],
  );

  const tabRows = useMemo(
    () => items.filter((r) => r.tab === activeTab),
    [items, activeTab],
  );

  // ── Summary strip (queue-wide; not scoped to active tab) ──────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const dollars = items.reduce((s, r) => s + (r.paidAmount || 0), 0);
    const ages = items
      .map((r) => r.agingDays)
      .filter((n): n is number => n != null);
    const oldest = ages.length ? Math.max(...ages) : 0;
    const urgent = items.filter(
      (r) => (r.priority ?? "").toLowerCase() === "urgent" || (r.agingDays ?? 0) > 14,
    ).length;
    return [
      { id: "count", label: "Unmatched lines", value: items.length.toLocaleString() },
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
  }, [items]);

  // ── Columns (spec order) ──────────────────────────────────────────────
  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      {
        id: "payer",
        header: "ERA payer",
        cell: (r) => (
          <div style={{ display: "grid", gap: 2 }}>
            <span>{r.payerName ?? "—"}</span>
            {r.payerCheckEft ? (
              <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#64748B" }}>
                {r.payerCheckEft}
              </span>
            ) : null}
          </div>
        ),
      },
      { id: "client", header: "Client name", cell: (r) => r.patientName },
      {
        id: "claimNumber",
        header: "Claim number from ERA",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.claimNumberFromEra}
          </span>
        ),
      },
      { id: "dos", header: "DOS", cell: (r) => formatDate(r.dos) },
      {
        id: "paid",
        header: "Paid amount",
        align: "right",
        cell: (r) => money(r.paidAmount),
      },
      {
        id: "reason",
        header: "Reason unmatched",
        cell: (r) => (
          <span title={r.reasonUnmatched} style={{ display: "inline-block", maxWidth: 260, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {r.reasonUnmatched}
          </span>
        ),
      },
      {
        id: "possibleMatch",
        header: "Possible match",
        cell: (r) =>
          r.possibleMatch ? (
            <span style={{ fontSize: 12 }}>
              <strong>{r.possibleMatch.claimNumber ?? r.possibleMatch.professionalClaimId.slice(0, 8)}</strong>
              {r.possibleMatch.patientDisplayName ? (
                <span style={{ color: "#64748B" }}> · {r.possibleMatch.patientDisplayName}</span>
              ) : null}
            </span>
          ) : (
            <span style={{ color: "#94A3B8" }}>None</span>
          ),
      },
      {
        id: "confidence",
        header: "Confidence score",
        align: "right",
        cell: (r) => {
          const pct = confidencePct(r.confidenceScore);
          const tone =
            r.confidenceScore == null
              ? "#94A3B8"
              : r.confidenceScore >= 0.85
                ? "#15803D"
                : r.confidenceScore >= 0.65
                  ? "#B45309"
                  : "#991B1B";
          return <span style={{ color: tone, fontWeight: 600 }}>{pct}</span>;
        },
      },
    ],
    [],
  );

  // ── Selection upkeep ───────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedRowId) return;
    if (!tabRows.some((r) => r.id === selectedRowId)) setSelectedRowId(null);
  }, [tabRows, selectedRowId]);

  const selectedRow = useMemo(
    () => tabRows.find((r) => r.id === selectedRowId) ?? null,
    [tabRows, selectedRowId],
  );

  // ── Actions ────────────────────────────────────────────────────────────
  const runAction = useCallback(
    async (
      row: Row,
      action: ActionId,
      extra?: Record<string, unknown>,
    ): Promise<boolean> => {
      setBusyId(row.id);
      setMessage(null);

      // Optimistic removal for terminal actions.
      const snapshot = items;
      if (action === "match_claim" || action === "ignore_line") {
        setItems((prev) => prev.filter((r) => r.id !== row.id));
      }
      try {
        const res = await fetch(
          `/api/billing/unmatched-era/${encodeURIComponent(row.eraClaimPaymentId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId, action, ...(extra ?? {}) }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error || "Action failed");
        }
        const labels: Record<ActionId, string> = {
          match_claim: "ERA line matched to claim.",
          create_missing_claim_record: "Opening new claim with ERA prefill…",
          post_manually: "Opening manual posting workspace…",
          ignore_line: "ERA line ignored.",
          escalate: "Escalated — priority bumped to urgent.",
        };
        setMessage({ tone: "success", text: labels[action] });
        // Patch the row in place when the server returns a rowPatch so the
        // UI reflects the queue state transition immediately.
        const patch = (json.rowPatch ?? null) as Partial<Row> | null;
        if (patch) {
          setItems((prev) =>
            prev.map((r) => (r.id === row.id ? { ...r, ...patch } : r)),
          );
        } else {
          setReloadKey((k) => k + 1);
        }
        return true;
      } catch (e) {
        setItems(snapshot);
        setMessage({
          tone: "error",
          text: e instanceof Error ? e.message : "Action failed",
        });
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [organizationId, items],
  );

  const matchHref = useCallback(
    (row: Row) =>
      `/billing/payments/era/${encodeURIComponent(row.eraBatchId)}?focus=${encodeURIComponent(row.eraClaimPaymentId)}&organizationId=${encodeURIComponent(organizationId)}`,
    [organizationId],
  );

  const newClaimHref = useCallback(
    (row: Row) => {
      const q = new URLSearchParams({
        organizationId,
        fromEraClaimPaymentId: row.eraClaimPaymentId,
        clp01: row.claimNumberFromEra,
      });
      if (row.clientId) q.set("clientId", row.clientId);
      return `/billing/charge-capture?${q.toString()}`;
    },
    [organizationId],
  );

  const manualPostHref = useCallback(
    (row: Row) =>
      `/billing/payments/manual-insurance?eraClaimPaymentId=${encodeURIComponent(row.eraClaimPaymentId)}&organizationId=${encodeURIComponent(organizationId)}`,
    [organizationId],
  );

  const openHrefIfBrowser = (href: string) => {
    if (typeof window !== "undefined") window.open(href, "_blank", "noopener");
  };

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      {
        id: "match",
        label: "Match claim",
        variant: "primary",
        onClick: (row) => {
          if (row.possibleMatch && (row.confidenceScore ?? 0) >= 0.85) {
            void runAction(row, "match_claim", {
              professionalClaimId: row.possibleMatch.professionalClaimId,
            });
          } else {
            openHrefIfBrowser(matchHref(row));
          }
        },
        disabled: (r) => busyId === r.id,
      },
      {
        id: "create",
        label: "Create claim",
        onClick: (row) => {
          void runAction(row, "create_missing_claim_record");
          openHrefIfBrowser(newClaimHref(row));
        },
        disabled: (r) => busyId === r.id,
      },
      {
        id: "post",
        label: "Post manually",
        onClick: (row) => {
          void runAction(row, "post_manually");
          openHrefIfBrowser(manualPostHref(row));
        },
        disabled: (r) => busyId === r.id,
      },
      {
        id: "ignore",
        label: "Ignore",
        variant: "danger",
        onClick: (row) => void runAction(row, "ignore_line"),
        disabled: (r) => busyId === r.id,
      },
      {
        id: "escalate",
        label: "Escalate",
        onClick: (row) => void runAction(row, "escalate"),
        disabled: (r) => busyId === r.id,
      },
    ],
    [busyId, runAction, matchHref, newClaimHref, manualPostHref],
  );

  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selectedRow) return [];
    const r = selectedRow;
    return [
      {
        id: "match",
        label: r.possibleMatch && (r.confidenceScore ?? 0) >= 0.85
          ? `Match → ${r.possibleMatch.claimNumber ?? r.possibleMatch.professionalClaimId.slice(0, 8)}`
          : "Match claim…",
        variant: "primary",
        onClick: () => {
          if (r.possibleMatch && (r.confidenceScore ?? 0) >= 0.85) {
            void runAction(r, "match_claim", {
              professionalClaimId: r.possibleMatch.professionalClaimId,
            });
          } else {
            openHrefIfBrowser(matchHref(r));
          }
        },
        disabled: busyId === r.id,
      },
      {
        id: "create",
        label: "Create missing claim record",
        onClick: () => {
          void runAction(r, "create_missing_claim_record");
          openHrefIfBrowser(newClaimHref(r));
        },
        disabled: busyId === r.id,
      },
      {
        id: "post",
        label: "Post manually",
        onClick: () => {
          void runAction(r, "post_manually");
          openHrefIfBrowser(manualPostHref(r));
        },
        disabled: busyId === r.id,
      },
      {
        id: "ignore",
        label: "Ignore line",
        variant: "danger",
        onClick: () => void runAction(r, "ignore_line"),
        disabled: busyId === r.id,
      },
      {
        id: "escalate",
        label: "Escalate",
        onClick: () => void runAction(r, "escalate"),
        disabled: busyId === r.id,
      },
    ];
  }, [selectedRow, busyId, runAction, matchHref, newClaimHref, manualPostHref]);

  // ── Detail tabs (spec sections) ───────────────────────────────────────
  const detailTabs: DetailTab[] = useMemo(() => {
    if (!selectedRow) return [];
    const r = selectedRow;
    const dl: React.CSSProperties = {
      display: "grid",
      gridTemplateColumns: "max-content 1fr",
      gap: "6px 12px",
      margin: 0,
      fontSize: 13,
    };
    return [
      {
        id: "eraLine",
        label: "ERA line",
        render: () => (
          <div style={{ display: "grid", gap: 12 }}>
            <dl style={dl}>
              <dt style={{ color: "#64748B" }}>Payer</dt>
              <dd style={{ margin: 0 }}>{r.payerName ?? "—"}</dd>
              <dt style={{ color: "#64748B" }}>Check / EFT</dt>
              <dd style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>
                {r.payerCheckEft ?? "—"}
              </dd>
              <dt style={{ color: "#64748B" }}>Claim # (CLP01)</dt>
              <dd style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>
                {r.claimNumberFromEra}
              </dd>
              <dt style={{ color: "#64748B" }}>Payer ICN (CLP07)</dt>
              <dd style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>
                {r.payerClaimControlNumber ?? "—"}
              </dd>
              <dt style={{ color: "#64748B" }}>Client</dt>
              <dd style={{ margin: 0 }}>{r.patientName}</dd>
              <dt style={{ color: "#64748B" }}>DOS</dt>
              <dd style={{ margin: 0 }}>{formatDate(r.dos)}</dd>
              <dt style={{ color: "#64748B" }}>Total charge</dt>
              <dd style={{ margin: 0 }}>{money(r.totalCharge)}</dd>
              <dt style={{ color: "#64748B" }}>Paid amount</dt>
              <dd style={{ margin: 0 }}>{money(r.paidAmount)}</dd>
              <dt style={{ color: "#64748B" }}>Client resp.</dt>
              <dd style={{ margin: 0 }}>{money(r.patientResponsibility)}</dd>
              <dt style={{ color: "#64748B" }}>Match status</dt>
              <dd style={{ margin: 0 }}>{r.matchStatus}</dd>
              <dt style={{ color: "#64748B" }}>Posting status</dt>
              <dd style={{ margin: 0 }}>{r.postingStatus}</dd>
              <dt style={{ color: "#64748B" }}>Received</dt>
              <dd style={{ margin: 0 }}>{formatDate(r.receivedAt)}</dd>
              <dt style={{ color: "#64748B" }}>Aging</dt>
              <dd style={{ margin: 0 }}>
                {r.agingDays == null ? "—" : `${r.agingDays} day(s)`}
              </dd>
            </dl>
            <Link
              href={`/billing/payments/era/${encodeURIComponent(r.eraBatchId)}?organizationId=${encodeURIComponent(organizationId)}`}
              style={{ fontSize: 12 }}
            >
              Open parent batch →
            </Link>
          </div>
        ),
      },
      {
        id: "candidates",
        label: "Possible internal claims",
        render: () =>
          r.candidates.length === 0 ? (
            <p style={{ margin: 0, color: "#64748B", fontSize: 13 }}>
              No candidate claims could be identified. Use “Create claim” or
              “Post manually” instead.
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
              {r.candidates.map((c) => (
                <li
                  key={c.professionalClaimId}
                  style={{
                    border: "1px solid #E2E8F0",
                    borderRadius: 6,
                    padding: 10,
                    fontSize: 13,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{c.claimNumber ?? c.professionalClaimId.slice(0, 8)}</strong>
                    <span style={{ color: "#475569" }}>
                      {confidencePct(c.confidence)} · {c.strategy}
                    </span>
                  </div>
                  <div style={{ color: "#475569", fontSize: 12 }}>
                    {c.patientDisplayName ?? "—"} · DOS {formatDate(c.dateOfServiceFrom)} ·{" "}
                    {money(c.totalCharge)}
                  </div>
                  {c.reasons.length > 0 ? (
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "#475569", fontSize: 12 }}>
                      {c.reasons.map((reason, i) => (
                        <li key={i}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={() =>
                        void runAction(r, "match_claim", {
                          professionalClaimId: c.professionalClaimId,
                        })
                      }
                      disabled={busyId === r.id}
                      style={{
                        height: 28,
                        padding: "0 10px",
                        fontSize: 12,
                        borderRadius: 4,
                        border: "1px solid #1d4ed8",
                        background: "#1d4ed8",
                        color: "white",
                        cursor: busyId === r.id ? "not-allowed" : "pointer",
                      }}
                    >
                      Bind this claim
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ),
      },
      {
        id: "logic",
        label: "Matching logic",
        render: () => (
          <div style={{ display: "grid", gap: 12, fontSize: 13 }}>
            <div>
              <strong style={{ fontSize: 12, color: "#475569" }}>WHY UNMATCHED</strong>
              <p style={{ margin: "4px 0 0" }}>{r.reasonUnmatched}</p>
            </div>
            <div>
              <strong style={{ fontSize: 12, color: "#475569" }}>STRATEGY TRIED</strong>
              <ol style={{ margin: "4px 0 0", paddingLeft: 18, color: "#475569" }}>
                <li>Payer ICN (CLP07) exact match</li>
                <li>Internal claim number (CLP01) exact match</li>
                <li>Client account number exact match</li>
                <li>Probable match: payer + DOS overlap + charge ±$0.50 + last name fuzzy</li>
              </ol>
            </div>
            <div>
              <strong style={{ fontSize: 12, color: "#475569" }}>TOP CANDIDATE</strong>
              {r.possibleMatch ? (
                <p style={{ margin: "4px 0 0" }}>
                  {r.possibleMatch.claimNumber ?? r.possibleMatch.professionalClaimId.slice(0, 8)} via{" "}
                  {r.possibleMatch.strategy} (confidence {confidencePct(r.confidenceScore)})
                </p>
              ) : (
                <p style={{ margin: "4px 0 0", color: "#94A3B8" }}>
                  No candidate met the confidence threshold.
                </p>
              )}
            </div>
            <div>
              <strong style={{ fontSize: 12, color: "#475569" }}>CANDIDATES FOUND</strong>
              <p style={{ margin: "4px 0 0" }}>
                {r.duplicateCandidateCount}{" "}
                {r.duplicateCandidateCount > 1
                  ? "→ duplicate-match review may be required"
                  : ""}
              </p>
            </div>
          </div>
        ),
      },
      {
        id: "compare",
        label: "Client/claim comparison",
        render: () => {
          const top = r.possibleMatch;
          const dosMatch =
            r.dos && top?.dateOfServiceFrom && r.dos === top.dateOfServiceFrom;
          const chargeMatch =
            top && Math.abs((top.totalCharge ?? 0) - r.totalCharge) < 0.5;
          return (
            <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #E2E8F0", fontSize: 11, color: "#64748B" }}>
                      Field
                    </th>
                    <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #E2E8F0", fontSize: 11, color: "#64748B" }}>
                      ERA
                    </th>
                    <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #E2E8F0", fontSize: 11, color: "#64748B" }}>
                      Top candidate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ padding: 6 }}>Claim #</td>
                    <td style={{ padding: 6, fontFamily: "ui-monospace, monospace" }}>{r.claimNumberFromEra}</td>
                    <td style={{ padding: 6, fontFamily: "ui-monospace, monospace" }}>
                      {top?.claimNumber ?? "—"}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: 6 }}>Client</td>
                    <td style={{ padding: 6 }}>{r.patientName}</td>
                    <td style={{ padding: 6 }}>{top?.patientDisplayName ?? "—"}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: 6 }}>DOS</td>
                    <td style={{ padding: 6 }}>{formatDate(r.dos)}</td>
                    <td style={{ padding: 6, color: dosMatch ? "#15803D" : undefined }}>
                      {formatDate(top?.dateOfServiceFrom ?? null)}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: 6 }}>Charge</td>
                    <td style={{ padding: 6 }}>{money(r.totalCharge)}</td>
                    <td style={{ padding: 6, color: chargeMatch ? "#15803D" : undefined }}>
                      {top ? money(top.totalCharge) : "—"}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: 6 }}>Payer ICN</td>
                    <td style={{ padding: 6, fontFamily: "ui-monospace, monospace" }}>
                      {r.payerClaimControlNumber ?? "—"}
                    </td>
                    <td style={{ padding: 6, fontFamily: "ui-monospace, monospace" }}>
                      {top?.payerClaimControlNumber ?? "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
              {r.notes.length > 0 ? (
                <div>
                  <strong style={{ fontSize: 12, color: "#475569" }}>RECENT NOTES</strong>
                  <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
                    {r.notes.slice(0, 5).map((n) => (
                      <li
                        key={n.id}
                        style={{
                          padding: 6,
                          border: "1px solid #E2E8F0",
                          borderRadius: 4,
                          fontSize: 12,
                        }}
                      >
                        <div style={{ color: "#64748B", fontSize: 11 }}>
                          {formatDate(n.createdAt)} · {n.type}
                        </div>
                        <div>{n.body}</div>
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
  }, [selectedRow, organizationId, runAction, busyId]);

  return (
    <WorkqueueShell<Row>
      title={queueDef?.title ?? "Unmatched ERA Claims"}
      description={queueDef?.description}
      headerActions={[
        {
          id: "refresh",
          label: loading ? "Refreshing…" : "Refresh",
          onClick: () => setReloadKey((k) => k + 1),
          disabled: loading,
        },
      ]}
      summary={summary}
      primaryTabs={primaryTabs}
      activePrimaryTabId={activeTab}
      onPrimaryTabChange={(t) => setActiveTab(t as TabId)}
      filters={filters}
      filterValues={filterValues}
      onFilterChange={setFilterValues}
      filterUrlNamespace="ue"
      rows={tabRows}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage="No unmatched ERA lines in this tab."
      selectedRowId={selectedRowId}
      onSelectRow={setSelectedRowId}
      rowActions={rowActions}
      detailTabs={detailTabs}
      detailActions={detailActions}
      message={message}
    />
  );
}
