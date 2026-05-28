"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type RowAction,
  type SummaryMetric,
  type FilterDef,
  type DetailTab,
  type PrimaryTab,
} from "@/components/billing/WorkqueueShell";
import { getWorkqueue } from "@/lib/billing/workqueues";

type ClaimSummary = {
  claimId: string;
  claimNumber: string;
  patientId: string;
  patientName: string;
  payerProfileId: string | null;
  payerName: string;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  totalCharge: number;
  deniedAmount: number;
  ageDays: number | null;
  carcCode: string | null;
  status: string;
  assignedBiller: string;
  followUpDue: string | null;
  practice: string;
  clinician: string;
};

type MatchingRule = {
  id: string;
  payer: string | null;
  rarcCode: string | null;
  carcCode: string | null;
  rule: string;
  recommendedAction: string | null;
  scope: "payer_specific" | "any_payer";
  updatedAt: string | null;
};

type RarcGroup = {
  id: string;
  rarcCode: string;
  rarcMessage: string;
  relatedCarc: string | null;
  claimCount: number;
  deniedAmount: number;
  payer: string;
  payerBreakdown: Array<{ payer: string; count: number; amount: number }>;
  recommendedAction: string;
  catalogRecommendedAction?: string;
  payerExplanation: string;
  suggestedCorrection: string;
  priority: "low" | "normal" | "high" | "urgent";
  oldestAgeDays: number;
  urgentCount: number;
  claims: ClaimSummary[];
  matchingRule?: MatchingRule | null;
  workedClaimCount?: number;
  suggestRule?: boolean;
};

type Payload = {
  success: boolean;
  error?: string;
  groups?: RarcGroup[];
  claimCount?: number;
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0);
}

function priorityTone(p: RarcGroup["priority"]): "default" | "amber" | "red" | "green" {
  switch (p) {
    case "urgent": return "red";
    case "high": return "amber";
    case "low": return "green";
    default: return "default";
  }
}

function priorityBadge(p: RarcGroup["priority"]) {
  const color =
    p === "urgent" ? "#B91C1C" : p === "high" ? "#B45309" : p === "low" ? "#15803D" : "#475569";
  const bg =
    p === "urgent" ? "#FEE2E2" : p === "high" ? "#FEF3C7" : p === "low" ? "#DCFCE7" : "#F1F5F9";
  return (
    <span
      style={{
        background: bg,
        color,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "capitalize",
      }}
    >
      {p}
    </span>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────
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
    >{message}</div>
  );
}

// ─── Modal shell + template/assign/rule modals ────────────────────────────
function ModalShell({
  title, onClose, children, width = 560,
}: {
  title: string; onClose: () => void; children: React.ReactNode; width?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", width, maxWidth: "92vw", maxHeight: "88vh",
          overflow: "auto", borderRadius: 8, padding: 24,
          boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button
            type="button" onClick={onClose}
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" }}
          >×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

type TemplateKind = "correction" | "appeal";

function TemplateModal({
  group, kind, onClose, onSaved,
}: {
  group: RarcGroup; kind: TemplateKind; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const defaultName = kind === "correction"
    ? `Correction — ${group.rarcCode}`
    : `Appeal — ${group.rarcCode}`;
  const ruleAction =
    kind === "correction" && group.matchingRule?.recommendedAction
      ? group.matchingRule.recommendedAction
      : group.recommendedAction;
  const rulePrefix =
    kind === "correction" && group.matchingRule
      ? `[Saved payer rule — ${
          group.matchingRule.payer ?? "any payer"
        } / ${group.matchingRule.rarcCode ?? group.rarcCode}]
${group.matchingRule.rule}

`
      : "";
  const defaultBody = kind === "correction"
    ? `${rulePrefix}Correction template for RARC ${group.rarcCode} (${group.rarcMessage})

Recommended action: ${ruleAction}

Steps:
${group.suggestedCorrection}

Affected claims: ${group.claimCount}
Denied amount: ${formatCurrency(group.deniedAmount)}`
    : `Appeal letter outline for RARC ${group.rarcCode} (${group.rarcMessage})

Payer explanation: ${group.payerExplanation}

Argument:
${group.suggestedCorrection}

Supporting documentation: [attach clinical notes / EOBs / authorization]

Claims included: ${group.claims.map((c) => c.claimNumber).join(", ")}`;

  const [name, setName] = useState(defaultName);
  const [body, setBody] = useState(defaultBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim() || !body.trim()) { setError("Name and body required"); return; }
    setBusy(true); setError(null);
    try {
      // We persist as a claim appeal template — same backend powers correction
      // notes and appeal letters today.
      const res = await fetch(`/api/billing/claim-appeal-templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: getOrganizationId(),
          name: name.trim(),
          body: body.trim(),
          kind,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? `Failed to save (${res.status})`);
      }
      onSaved(`${kind === "correction" ? "Correction" : "Appeal"} template saved`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save template");
    } finally { setBusy(false); }
  }

  return (
    <ModalShell
      title={`Create ${kind} template — ${group.rarcCode}`}
      onClose={onClose}
      width={680}
    >
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Template name</label>
      <input
        value={name} onChange={(e) => setName(e.target.value)}
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4 }}
      />
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 4 }}>Body</label>
      <textarea
        value={body} onChange={(e) => setBody(e.target.value)} rows={14}
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4, fontFamily: "inherit" }}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save template"}
        </button>
      </div>
    </ModalShell>
  );
}

function AssignModal({
  group, onClose, onSaved,
}: {
  group: RarcGroup; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!assignee.trim()) { setError("Choose an assignee"); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/billing/workqueue/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: getOrganizationId(),
          claimIds: group.claims.map((c) => c.claimId),
          assignee: assignee.trim(),
          reason: `Assigned via Denials by RARC (${group.rarcCode})`,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? `Failed to assign (${res.status})`);
      }
      onSaved(`Assigned ${group.claimCount} claims to ${assignee.trim()}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign claims");
    } finally { setBusy(false); }
  }

  return (
    <ModalShell title={`Assign ${group.claimCount} claims`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        RARC {group.rarcCode} · {group.payer} · {formatCurrency(group.deniedAmount)}
      </p>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Assignee (email or name)</label>
      <input
        value={assignee} onChange={(e) => setAssignee(e.target.value)}
        placeholder="biller@example.com"
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4 }}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="button" onClick={save} disabled={busy}>
          {busy ? "Assigning…" : "Assign"}
        </button>
      </div>
    </ModalShell>
  );
}

function PayerRuleModal({
  group, onClose, onSaved,
}: {
  group: RarcGroup; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [ruleNote, setRuleNote] = useState(
    `When ${group.payerBreakdown[0]?.payer ?? "this payer"} returns RARC ${group.rarcCode}:\n${group.recommendedAction}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/billing/payer-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: getOrganizationId(),
          payer: group.payerBreakdown[0]?.payer ?? null,
          rarcCode: group.rarcCode,
          carcCode: group.relatedCarc,
          rule: ruleNote.trim(),
          recommendedAction: group.recommendedAction || null,
          claimIds: group.claims.map((c) => c.claimId),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? `Failed to save (${res.status})`);
      }
      onSaved("Payer rule updated");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update payer rule");
    } finally { setBusy(false); }
  }

  return (
    <ModalShell title={`Update payer rule — ${group.rarcCode}`} onClose={onClose}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Rule</label>
      <textarea
        value={ruleNote} onChange={(e) => setRuleNote(e.target.value)} rows={8}
        style={{ width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 4, fontFamily: "inherit" }}
      />
      {error ? <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save rule"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────
const queueDef = getWorkqueue("denials_by_rarc");

export default function DenialsByRarcClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [groups, setGroups] = useState<RarcGroup[]>([]);
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<string>("grouped");

  const [templateModal, setTemplateModal] = useState<{ group: RarcGroup; kind: TemplateKind } | null>(null);
  const [assignModal, setAssignModal] = useState<RarcGroup | null>(null);
  const [ruleModal, setRuleModal] = useState<RarcGroup | null>(null);

  type HistoryEntry = {
    id: string;
    kind: "note" | "audit";
    claimId: string;
    claimNumber: string;
    author: string;
    body: string;
    createdAt: string;
    resolvedDenial: boolean;
    rarcCodes: string[];
  };
  // History cache is keyed by `${groupId}:${resolvedOnly ? "resolved" : "all"}`
  // so toggling the "Resolved by" filter refetches without trampling the
  // unfiltered list.
  const [historyByKey, setHistoryByKey] = useState<Record<string, HistoryEntry[]>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [resolvedOnlyByGroup, setResolvedOnlyByGroup] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/denials-by-rarc?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as Payload;
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setGroups(json.groups ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  // Load historical resolution notes for the selected group on demand.
  // Refetches when the "Resolved by" toggle flips for this group.
  useEffect(() => {
    if (!selectedRowId || !organizationId) return;
    const resolvedOnly = Boolean(resolvedOnlyByGroup[selectedRowId]);
    const cacheKey = `${selectedRowId}:${resolvedOnly ? "resolved" : "all"}`;
    if (historyByKey[cacheKey]) return;
    const group = groups.find((g) => g.id === selectedRowId);
    if (!group) return;
    setHistoryLoading(true);
    fetch(`/api/billing/denials-by-rarc/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        claimIds: group.claims.map((c) => c.claimId),
        rarcCode: group.rarcCode,
        resolvedOnly,
      }),
    })
      .then((r) => r.json())
      .then((json) => {
        if (json?.success) {
          setHistoryByKey((prev) => ({
            ...prev,
            [cacheKey]: json.entries ?? [],
          }));
        }
      })
      .catch(() => undefined)
      .finally(() => setHistoryLoading(false));
  }, [selectedRowId, organizationId, groups, historyByKey, resolvedOnlyByGroup]);

  // ── Filter rail (universal) ─────────────────────────────────────────────
  const payerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) for (const p of g.payerBreakdown) if (p.payer) set.add(p.payer);
    return Array.from(set).sort().map((p) => ({ value: p, label: p }));
  }, [groups]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "text", placeholder: "Practice…" },
      { id: "clinician", label: "Clinician", kind: "text", placeholder: "Clinician…" },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Client name…" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status", label: "Status", kind: "select",
        options: [
          { value: "open", label: "Open" },
          { value: "in_progress", label: "In progress" },
          { value: "resolved", label: "Resolved" },
        ],
      },
      { id: "assignedBiller", label: "Assigned biller", kind: "text", placeholder: "Biller…" },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket", label: "Aging", kind: "select",
        options: [
          { value: "0-30", label: "0-30 days" },
          { value: "31-60", label: "31-60 days" },
          { value: "61-90", label: "61-90 days" },
          { value: "90+", label: "90+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. M15 or 97" },
      {
        id: "priority", label: "Priority", kind: "select",
        options: [
          { value: "urgent", label: "Urgent" },
          { value: "high", label: "High" },
          { value: "normal", label: "Normal" },
          { value: "low", label: "Low" },
        ],
      },
      { id: "followUpDue", label: "Follow-up due", kind: "date" },
    ],
    [payerOptions],
  );

  const filteredGroups = useMemo(() => {
    const v = filterValues;
    return groups.filter((g) => {
      if (v.payer && !g.payerBreakdown.some((p) => p.payer === v.payer)) return false;
      if (v.client) {
        const q = v.client.toLowerCase();
        if (!g.claims.some((c) => c.patientName.toLowerCase().includes(q))) return false;
      }
      if (v.practice) {
        const q = v.practice.toLowerCase();
        if (!g.claims.some((c) => (c.practice ?? "").toLowerCase().includes(q))) return false;
      }
      if (v.clinician) {
        const q = v.clinician.toLowerCase();
        if (!g.claims.some((c) => (c.clinician ?? "").toLowerCase().includes(q))) return false;
      }
      if (v.status && !g.claims.some((c) => (c.status ?? "") === v.status)) return false;
      if (v.assignedBiller) {
        const q = v.assignedBiller.toLowerCase();
        if (!g.claims.some((c) => (c.assignedBiller ?? "").toLowerCase().includes(q))) return false;
      }
      if (v.followUpDue) {
        if (!g.claims.some((c) => (c.followUpDue ?? "") <= v.followUpDue && (c.followUpDue ?? "") !== "")) return false;
      }
      if (v.dosFrom && !g.claims.some((c) => (c.serviceDateFrom ?? "") >= v.dosFrom)) return false;
      if (v.dosTo && !g.claims.some((c) => (c.serviceDateFrom ?? "") <= v.dosTo)) return false;
      if (v.minAmount) {
        const n = Number(v.minAmount);
        if (!Number.isNaN(n) && g.deniedAmount < n) return false;
      }
      if (v.maxAmount) {
        const n = Number(v.maxAmount);
        if (!Number.isNaN(n) && g.deniedAmount > n) return false;
      }
      if (v.agingBucket) {
        const a = g.oldestAgeDays;
        const ok = v.agingBucket === "0-30" ? a <= 30
          : v.agingBucket === "31-60" ? a > 30 && a <= 60
          : v.agingBucket === "61-90" ? a > 60 && a <= 90
          : v.agingBucket === "90+" ? a > 90
          : true;
        if (!ok) return false;
      }
      if (v.carcRarc) {
        const q = v.carcRarc.toUpperCase();
        if (!g.rarcCode.toUpperCase().includes(q) &&
            !(g.relatedCarc ?? "").toUpperCase().includes(q) &&
            !g.rarcMessage.toUpperCase().includes(q)) return false;
      }
      if (v.priority && g.priority !== v.priority) return false;
      return true;
    });
  }, [groups, filterValues]);

  // ── Summary strip ──────────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const totalClaims = filteredGroups.reduce((s, g) => s + g.claimCount, 0);
    const totalDollars = filteredGroups.reduce((s, g) => s + g.deniedAmount, 0);
    const oldest = filteredGroups.reduce((m, g) => Math.max(m, g.oldestAgeDays), 0);
    const urgent = filteredGroups.reduce((s, g) => s + g.urgentCount, 0);
    return [
      { id: "count", label: "Denied claims", value: totalClaims.toLocaleString() },
      {
        id: "dollars", label: "Denied amount",
        value: formatCurrency(totalDollars),
        tone: totalDollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest", label: "Oldest (days)", value: oldest,
        tone: oldest > 60 ? "red" : oldest > 30 ? "amber" : "default",
      },
      {
        id: "urgent", label: "Urgent (>60d)", value: urgent,
        tone: urgent > 0 ? "red" : "default",
      },
    ];
  }, [filteredGroups]);

  const primaryTabs: PrimaryTab[] = useMemo(
    () => [
      {
        id: "grouped",
        label:
          "Grouped list of RARCs with claim count, denied amount, and recommended action",
        count: filteredGroups.length,
      },
    ],
    [filteredGroups.length],
  );

  // ── Columns (match spec exactly) ───────────────────────────────────────
  const columns: ColumnDef<RarcGroup>[] = useMemo(
    () => [
      {
        id: "rarcCode", header: "RARC code", width: 110,
        cell: (g) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{g.rarcCode}</span>
        ),
      },
      { id: "rarcMessage", header: "RARC message", cell: (g) => g.rarcMessage },
      {
        id: "relatedCarc", header: "Related CARC", width: 120,
        cell: (g) => g.relatedCarc
          ? <span style={{ fontFamily: "ui-monospace, monospace" }}>{g.relatedCarc}</span>
          : <span style={{ color: "#9CA3AF" }}>—</span>,
      },
      {
        id: "claimCount", header: "Claim count", align: "right", width: 110,
        cell: (g) => g.claimCount.toLocaleString(),
      },
      {
        id: "deniedAmount", header: "Denied amount", align: "right", width: 140,
        cell: (g) => (
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {formatCurrency(g.deniedAmount)}
          </span>
        ),
      },
      { id: "payer", header: "Payer", cell: (g) => g.payer || "—" },
      {
        id: "recommendedAction", header: "Recommended action",
        cell: (g) => (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {g.matchingRule ? (
                <span
                  title={`Saved rule — ${g.matchingRule.payer ?? "any payer"} / ${g.matchingRule.rarcCode ?? g.rarcCode}\n${g.matchingRule.rule}`}
                  style={{
                    background: "#DBEAFE", color: "#1D4ED8",
                    padding: "1px 6px", borderRadius: 999,
                    fontSize: 10, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: 0.3,
                  }}
                >
                  {g.matchingRule.scope === "payer_specific" ? "Payer rule" : "Rule (any payer)"}
                </span>
              ) : null}
              {g.suggestRule ? (
                <button
                  type="button"
                  onClick={(ev) => { ev.stopPropagation(); setRuleModal(g); }}
                  title={`${g.workedClaimCount ?? 0} claims worked — save reusable guidance`}
                  style={{
                    background: "#FEF3C7", color: "#92400E",
                    padding: "1px 6px", borderRadius: 999,
                    fontSize: 10, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: 0.3,
                    border: "1px solid #FDE68A", cursor: "pointer",
                  }}
                >
                  Save as payer rule
                </button>
              ) : null}
            </div>
            <span style={{ color: "#0F172A" }}>{g.recommendedAction}</span>
          </div>
        ),
      },
      {
        id: "priority", header: "Priority", align: "center", width: 100,
        cell: (g) => priorityBadge(g.priority),
      },
    ],
    [],
  );

  const rowActions: RowAction<RarcGroup>[] = useMemo(
    () => [
      { id: "correction", label: "Correction template", onClick: (g) => setTemplateModal({ group: g, kind: "correction" }) },
      { id: "appeal", label: "Appeal template", variant: "primary", onClick: (g) => setTemplateModal({ group: g, kind: "appeal" }) },
      { id: "assign", label: "Assign", onClick: (g) => setAssignModal(g) },
      { id: "rule", label: "Payer rule", onClick: (g) => setRuleModal(g) },
    ],
    [],
  );

  const selectedGroup = useMemo(
    () => filteredGroups.find((g) => g.id === selectedRowId) ?? null,
    [filteredGroups, selectedRowId],
  );

  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "claims",
        label: "Claims tied to this RARC",
        render: () => selectedGroup ? (
          <div>
            <div style={{ fontSize: 12, color: "#64748B", marginBottom: 8 }}>
              {selectedGroup.claimCount} claim{selectedGroup.claimCount === 1 ? "" : "s"} ·
              {" "}{formatCurrency(selectedGroup.deniedAmount)} denied · priority{" "}
              {priorityBadge(selectedGroup.priority)}
            </div>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748B" }}>
                  <th style={{ padding: "4px 6px" }}>Claim</th>
                  <th style={{ padding: "4px 6px" }}>Client</th>
                  <th style={{ padding: "4px 6px" }}>Payer</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Denied</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Age</th>
                </tr>
              </thead>
              <tbody>
                {selectedGroup.claims.map((c) => (
                  <tr key={c.claimId} style={{ borderTop: "1px solid #F1F5F9" }}>
                    <td style={{ padding: "4px 6px", fontFamily: "ui-monospace, monospace" }}>{c.claimNumber}</td>
                    <td style={{ padding: "4px 6px" }}>{c.patientName}</td>
                    <td style={{ padding: "4px 6px" }}>{c.payerName}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {formatCurrency(c.deniedAmount)}
                    </td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      {typeof c.ageDays === "number" ? `${c.ageDays}d` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null,
      },
      {
        id: "explanation",
        label: "Payer explanation",
        render: () => selectedGroup ? (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {selectedGroup.rarcCode} — {selectedGroup.rarcMessage}
            </div>
            {selectedGroup.relatedCarc ? (
              <div style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>
                Related CARC: {selectedGroup.relatedCarc}
              </div>
            ) : null}
            <p style={{ fontSize: 13, color: "#0F172A", lineHeight: 1.5 }}>
              {selectedGroup.payerExplanation || "No payer explanation on file. Review the raw 835/277 for details."}
            </p>
            <div style={{ marginTop: 16, fontSize: 12, color: "#64748B" }}>
              Payer breakdown
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
              {selectedGroup.payerBreakdown.map((p) => (
                <li key={p.payer} style={{
                  display: "flex", justifyContent: "space-between",
                  fontSize: 13, padding: "4px 0", borderBottom: "1px solid #F1F5F9",
                }}>
                  <span>{p.payer}</span>
                  <span style={{ color: "#64748B" }}>
                    {p.count} · {formatCurrency(p.amount)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      },
      {
        id: "correction",
        label: "Suggested correction",
        render: () => selectedGroup ? (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              Recommended action
            </div>
            <p style={{ fontSize: 13, color: "#0F172A", lineHeight: 1.5, margin: "0 0 16px" }}>
              {selectedGroup.recommendedAction}
            </p>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              Step-by-step
            </div>
            <p style={{ fontSize: 13, color: "#0F172A", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {selectedGroup.suggestedCorrection || "No correction guidance on file — consult the payer's remittance guide."}
            </p>
          </div>
        ) : null,
      },
      {
        id: "history",
        label: "Historical resolution notes",
        render: () => {
          if (!selectedGroup) return null;
          const resolvedOnly = Boolean(resolvedOnlyByGroup[selectedGroup.id]);
          const cacheKey = `${selectedGroup.id}:${resolvedOnly ? "resolved" : "all"}`;
          const entries = historyByKey[cacheKey] ?? [];
          const toggle = (
            <label
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                fontSize: 12, color: "#0F172A", cursor: "pointer",
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={resolvedOnly}
                onChange={(ev) =>
                  setResolvedOnlyByGroup((prev) => ({
                    ...prev,
                    [selectedGroup.id]: ev.target.checked,
                  }))
                }
              />
              Resolved by only (notes that closed the denial)
            </label>
          );
          let bodyEl: React.ReactNode;
          if (historyLoading && entries.length === 0) {
            bodyEl = (
              <div style={{ fontSize: 13, color: "#64748B" }}>
                Loading resolution history…
              </div>
            );
          } else if (entries.length === 0) {
            bodyEl = (
              <div style={{ fontSize: 13, color: "#64748B", lineHeight: 1.5 }}>
                {resolvedOnly
                  ? `No notes have been marked as resolving RARC ${selectedGroup.rarcCode} yet.`
                  : `No prior notes or audit events tagged with RARC ${selectedGroup.rarcCode}. Use the actions above to start one — new notes added to denied claims are tagged automatically.`}
              </div>
            );
          } else {
            bodyEl = (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {entries.map((e) => (
                  <li
                    key={e.id}
                    style={{
                      padding: "8px 0",
                      borderBottom: "1px solid #F1F5F9",
                      fontSize: 13,
                      lineHeight: 1.5,
                    }}
                  >
                    <div style={{ fontSize: 11, color: "#64748B", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span
                        style={{
                          textTransform: "uppercase",
                          fontWeight: 600,
                          color: e.kind === "audit" ? "#0369A1" : "#475569",
                        }}
                      >
                        {e.kind}
                      </span>
                      <span style={{ fontFamily: "ui-monospace, monospace" }}>
                        {e.claimNumber || e.claimId.slice(0, 8)}
                      </span>
                      <span>·</span>
                      <span>{e.author}</span>
                      <span>·</span>
                      <span>{e.createdAt ? new Date(e.createdAt).toLocaleString() : "—"}</span>
                      {e.resolvedDenial ? (
                        <span
                          style={{
                            background: "#DCFCE7", color: "#15803D",
                            padding: "1px 6px", borderRadius: 999,
                            fontSize: 10, fontWeight: 600,
                            textTransform: "uppercase", letterSpacing: 0.3,
                          }}
                        >
                          Resolved
                        </span>
                      ) : null}
                    </div>
                    <div style={{ marginTop: 2, color: "#0F172A", whiteSpace: "pre-wrap" }}>
                      {e.body}
                    </div>
                  </li>
                ))}
              </ul>
            );
          }
          return (
            <div>
              <div style={{ marginBottom: 10 }}>{toggle}</div>
              {bodyEl}
            </div>
          );
        },
      },
    ],
    [selectedGroup, historyByKey, historyLoading, resolvedOnlyByGroup],
  );

  const detailActions = selectedGroup
    ? [
        { id: "correction", label: "Create correction template", onClick: () => setTemplateModal({ group: selectedGroup, kind: "correction" }) },
        { id: "appeal", label: "Create appeal template", variant: "primary" as const, onClick: () => setTemplateModal({ group: selectedGroup, kind: "appeal" }) },
        { id: "assign", label: "Assign claims", onClick: () => setAssignModal(selectedGroup) },
        { id: "rule", label: "Update payer rule", onClick: () => setRuleModal(selectedGroup) },
      ]
    : [];

  const message = !organizationId
    ? { tone: "error" as const, text: "Missing organizationId. Add ?organizationId=… to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID." }
    : error
    ? { tone: "error" as const, text: error }
    : null;

  // Reuse priorityTone to satisfy lint (it's also used implicitly via badge styling).
  void priorityTone;

  return (
    <>
      <WorkqueueShell<RarcGroup>
        title={queueDef?.title ?? "Denied Claims by RARC"}
        description={queueDef?.description}
        headerActions={[
          { id: "refresh", label: loading ? "Loading…" : "Refresh", onClick: () => void load(), disabled: loading },
        ]}
        summary={summary}
        primaryTabs={primaryTabs}
        activePrimaryTabId={activeTabId}
        onPrimaryTabChange={setActiveTabId}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace="denials_rarc"
        rows={filteredGroups}
        columns={columns}
        rowId={(g) => g.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No denials grouped by RARC."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {templateModal ? (
        <TemplateModal
          group={templateModal.group}
          kind={templateModal.kind}
          onClose={() => setTemplateModal(null)}
          onSaved={(msg) => {
            setToast(msg);
            // Template creation writes an audit_log; drop both cache
            // variants (all / resolved-only) for this group so the
            // History tab refetches.
            const prefix = `${templateModal.group.id}:`;
            setHistoryByKey((prev) => {
              const next = { ...prev };
              for (const k of Object.keys(next)) if (k.startsWith(prefix)) delete next[k];
              return next;
            });
            void load();
          }}
        />
      ) : null}
      {assignModal ? (
        <AssignModal
          group={assignModal}
          onClose={() => setAssignModal(null)}
          onSaved={(msg) => {
            setToast(msg);
            const prefix = `${assignModal.id}:`;
            setHistoryByKey((prev) => {
              const next = { ...prev };
              for (const k of Object.keys(next)) if (k.startsWith(prefix)) delete next[k];
              return next;
            });
            void load();
          }}
        />
      ) : null}
      {ruleModal ? (
        <PayerRuleModal
          group={ruleModal}
          onClose={() => setRuleModal(null)}
          onSaved={(msg) => {
            setToast(msg);
            const prefix = `${ruleModal.id}:`;
            setHistoryByKey((prev) => {
              const next = { ...prev };
              for (const k of Object.keys(next)) if (k.startsWith(prefix)) delete next[k];
              return next;
            });
            void load();
          }}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
