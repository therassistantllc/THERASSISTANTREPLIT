"use client";

/**
 * Charge Capture workqueue (Task #353).
 *
 * Composed on the universal `WorkqueueShell` with the spec's six tabs,
 * fourteen columns, universal filter rail, seven detail-panel
 * sections, and the row/panel actions (Approve, Hold, Route back,
 * Change code, Add modifier, Release).
 *
 * Data comes from:
 *   - GET  /api/billing/charge-capture           (list + tab counts)
 *   - GET  /api/billing/charge-capture/:id       (per-row detail)
 *   - PATCH /api/billing/charge-capture/:id      (edit + status actions)
 *   - POST /api/billing/charge-capture/release   (release to claims)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import styles from "./charge-capture.module.css";
import CodeCombobox, { describeCodeForSaveError, fetchChildCodes, validateCode } from "./CodeCombobox";
import type { CodeOption, CodeValidation } from "./CodeCombobox";
import WorkqueueShell, {
  type ColumnDef,
  type SummaryMetric,
  type FilterDef,
  type DetailTab,
  type PrimaryAction,
  type RowAction,
} from "@/components/billing/WorkqueueShell";
import PlaceClaimOnHoldModal from "@/components/billing/PlaceClaimOnHoldModal";
import { getWorkqueue } from "@/lib/billing/workqueues";

// ── Types matching the new list API ────────────────────────────────────

type TabId =
  | "ready_for_review"
  | "documentation_missing"
  | "coding_mismatch"
  | "eligibility_auth_issue"
  | "held_charges"
  | "released_to_claims";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "ready_for_review", label: "Ready for Review" },
  { id: "documentation_missing", label: "Documentation Missing" },
  { id: "coding_mismatch", label: "Coding Mismatch" },
  { id: "eligibility_auth_issue", label: "Eligibility/Auth Issue" },
  { id: "held_charges", label: "Held Charges" },
  { id: "released_to_claims", label: "Released to Claims" },
];

interface ListRow {
  id: string;
  chargeStatus: string;
  tab: TabId;
  dateOfService: string | null;
  client: { id: string; name: string; dob: string | null };
  clinician: string;
  appointment: {
    id: string | null;
    type: string;
    status: string;
    startAt: string | null;
    endAt: string | null;
    durationMin: number | null;
  };
  encounter: {
    id: string | null;
    noteStatus: string;
    noteSigned: boolean;
    billingFieldsComplete: boolean;
    summary: string | null;
  };
  payer: { id: string; name: string; category: string | null } | null;
  policy: { id: string; planName: string | null; memberId: string | null } | null;
  providerSelectedCode: string | null;
  systemSuggestedCode: string | null;
  codingAlerts: string[];
  eligibility: {
    status: string | null;
    checkedAt: string | null;
    authorizationRequired: boolean;
    rawStatusText: string | null;
  } | null;
  authorization: { status: string; number: string | null };
  chargeAmount: number;
  agingDays: number | null;
  blockers: string[];
  actionNeeded: string;
  claimId: string | null;
}

interface ListResponse {
  success: boolean;
  error?: string;
  items?: ListRow[];
  totalItems?: number;
  tabCounts?: Record<TabId, number>;
}

// ── Detail types (per-row GET) ─────────────────────────────────────────

type ServiceLine = {
  lineNumber: number;
  procedureCode: string;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  modifiers: string[];
  diagnosisPointers: string[];
  units: number;
  unitOfMeasure: string;
  chargeAmount: number;
  placeOfService: string | null;
  renderingProviderNpi: string | null;
  authorizationNumber: string | null;
};

interface ChargeDetail {
  id: string;
  status: string;
  serviceDate: string | null;
  placeOfService: string | null;
  totalCharge: number;
  blockerReasons: unknown[];
  client: { id: string; firstName: string; lastName: string; dateOfBirth: string | null; accountNumber: string | null } | null;
  provider: { id: string; displayName: string; credential: string | null; npi: string | null } | null;
  payer: { id: string; name: string; payerType: string | null } | null;
  policy: { id: string; planName: string | null; policyNumber: string | null; subscriberId: string | null; copay: number; deductible: number; coinsurancePercent: number; priority: string | null } | null;
  diagnoses: string[];
  appointment: { id: string; type: string | null; status: string | null; startAt: string | null; endAt: string | null; cptCode: string | null; memo: string | null } | null;
  encounter: { id: string; status: string | null; billingFieldsComplete: boolean; sessionSummary: string | null; startedAt: string | null; endedAt: string | null; caseId: string | null } | null;
  eligibility: { status: string | null; checkedAt: string | null; authorizationRequired: boolean; rawStatusText: string | null; copay: number; deductibleRemaining: number } | null;
  serviceLines: ServiceLine[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function getOrganizationId(): string {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function money(v: number): string {
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function fmtMinutes(min: number | null): string {
  if (min == null) return "—";
  return `${min} min`;
}

const POS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "11", label: "11 - Office" },
  { value: "02", label: "02 - Telehealth (other)" },
  { value: "10", label: "10 - Telehealth in home" },
  { value: "12", label: "12 - Home" },
  { value: "53", label: "53 - Community Mental Health" },
  { value: "99", label: "99 - Other" },
];

const EMPTY_LINE: ServiceLine = {
  lineNumber: 0,
  procedureCode: "",
  serviceDateFrom: null,
  serviceDateTo: null,
  modifiers: [],
  diagnosisPointers: ["1"],
  units: 1,
  unitOfMeasure: "UN",
  chargeAmount: 0,
  placeOfService: null,
  renderingProviderNpi: null,
  authorizationNumber: null,
};

const queueDef = getWorkqueue("charge_capture");

// ── Component ──────────────────────────────────────────────────────────

function HeaderChildSuggestions({ parent, onPick }: { parent: string; onPick: (code: string) => void }) {
  const [children, setChildren] = useState<CodeOption[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setChildren([]);
    void fetchChildCodes("diagnosis", parent, 8).then((items) => {
      if (cancelled) return;
      setChildren(items);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [parent]);
  if (loading) return <div style={{ marginTop: 4, fontSize: 10.5, color: "#94A3B8" }}>Loading billable codes under {parent}…</div>;
  if (children.length === 0) return null;
  return (
    <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      <span style={{ fontSize: 10.5, color: "#64748B" }}>Try:</span>
      {children.map((c) => (
        <button key={c.code} type="button" onMouseDown={(e) => { e.preventDefault(); onPick(c.code.toUpperCase()); }}
          title={c.description}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 10.5, padding: "1px 6px", borderRadius: 10,
            border: "1px solid #CBD5E1", background: "#F8FAFC", color: "#0F172A", cursor: "pointer", lineHeight: 1.5 }}>
          {c.code}
        </button>
      ))}
    </div>
  );
}

export default function ChargeCaptureClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);

  const [items, setItems] = useState<ListRow[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<TabId, number>>({} as Record<TabId, number>);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChargeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [invalidDx, setInvalidDx] = useState<Map<string, CodeValidation>>(new Map());
  const [invalidProc, setInvalidProc] = useState<Map<string, CodeValidation>>(new Map());

  const [activeTab, setActiveTab] = useState<TabId>("ready_for_review");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [holdTarget, setHoldTarget] = useState<{
    claimId: string;
    subtitle: string;
    sourceRowId: string;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkHoldOpen, setBulkHoldOpen] = useState(false);

  // ── List fetch ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!organizationId) { setLoading(false); return; }
    setLoading(true);
    const params = new URLSearchParams({ organizationId, tab: activeTab });
    for (const [k, v] of Object.entries(filterValues)) {
      if (v && v.length > 0) params.set(k, v);
    }
    fetch(`/api/billing/charge-capture?${params.toString()}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<ListResponse>)
      .then((json) => {
        if (json.success && json.items) {
          setItems(json.items);
          setTabCounts((prev) => ({ ...prev, ...(json.tabCounts ?? {}) }));
          if (json.items.length > 0 && (!selectedId || !json.items.some((i) => i.id === selectedId))) {
            setSelectedId(json.items[0].id);
          }
        } else {
          setItems([]);
        }
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, reloadKey, activeTab, JSON.stringify(filterValues)]);

  // ── Detail fetch ───────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setDetailLoading(true);
    fetch(`/api/billing/charge-capture/${encodeURIComponent(selectedId)}?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => { if (json.success) setDetail(json.detail); else setDetail(null); })
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, [selectedId, organizationId, reloadKey]);

  // ── Filter rail (universal set) ────────────────────────────────────
  const clinicianOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of items) if (r.clinician && r.clinician !== "—") set.add(r.clinician);
    return [...set].map((v) => ({ value: v, label: v }));
  }, [items]);
  const payerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of items) if (r.payer?.name) set.add(r.payer.name);
    return [...set].map((v) => ({ value: v, label: v }));
  }, [items]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "text", placeholder: "Practice" },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicianOptions },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Name or CPT…" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "captured", label: "Captured" },
          { value: "ready_for_claim", label: "Ready for claim" },
          { value: "claim_created", label: "Claim created" },
          { value: "blocked", label: "Blocked" },
          { value: "voided", label: "Voided" },
        ],
      },
      { id: "assignedBiller", label: "Assigned biller", kind: "text", placeholder: "Biller" },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "" },
      {
        id: "agingBucket",
        label: "Aging",
        kind: "select",
        options: [
          { value: "0-7", label: "0-7 days" },
          { value: "8-14", label: "8-14 days" },
          { value: "15-30", label: "15-30 days" },
          { value: "30+", label: "30+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "Code" },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [{ value: "urgent", label: "Urgent only" }],
      },
      { id: "followUpDue", label: "Follow-up due", kind: "date" },
    ],
    [clinicianOptions, payerOptions],
  );

  // ── Client-side filters the backend doesn't apply (aging bucket / max $) ──
  const visibleItems = useMemo(() => {
    let list = items;
    const v = filterValues;
    if (v.maxAmount) {
      const max = Number(v.maxAmount);
      if (Number.isFinite(max)) list = list.filter((r) => r.chargeAmount <= max);
    }
    if (v.agingBucket) {
      list = list.filter((r) => {
        const a = r.agingDays ?? 0;
        switch (v.agingBucket) {
          case "0-7": return a <= 7;
          case "8-14": return a >= 8 && a <= 14;
          case "15-30": return a >= 15 && a <= 30;
          case "30+": return a > 30;
          default: return true;
        }
      });
    }
    return list;
  }, [items, filterValues]);

  // ── Summary metrics ────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const dollars = visibleItems.reduce((s, r) => s + (r.chargeAmount || 0), 0);
    const ages = visibleItems.map((r) => r.agingDays ?? 0);
    const oldest = ages.length > 0 ? Math.max(...ages) : 0;
    const urgent = visibleItems.filter(
      (r) => r.tab === "documentation_missing" || r.tab === "coding_mismatch" || r.tab === "eligibility_auth_issue" || r.tab === "held_charges",
    ).length;
    return [
      { id: "count", label: "Open charges", value: visibleItems.length.toLocaleString() },
      { id: "dollars", label: "Total charges", value: money(dollars) },
      { id: "oldest", label: "Oldest (days)", value: oldest, tone: oldest > 14 ? "red" : oldest > 7 ? "amber" : "default" },
      { id: "urgent", label: "Urgent", value: urgent, tone: urgent > 0 ? "amber" : "default" },
    ];
  }, [visibleItems]);

  // ── Spec columns (14 total) ────────────────────────────────────────
  const columns: ColumnDef<ListRow>[] = useMemo(
    () => [
      { id: "dos", header: "Date of service", cell: (r) => fmtDate(r.dateOfService) },
      {
        id: "client",
        header: "Client",
        cell: (r) => (
          <>
            <span style={{ fontWeight: 600, color: "#0F172A", display: "block" }}>{r.client.name}</span>
            <span style={{ fontSize: 11, color: "#94A3B8" }}>{r.client.dob ? `DOB ${fmtDate(r.client.dob)}` : ""}</span>
          </>
        ),
      },
      { id: "clinician", header: "Clinician", cell: (r) => r.clinician },
      { id: "apptType", header: "Appointment type", cell: (r) => r.appointment.type },
      { id: "apptStatus", header: "Appointment status", cell: (r) => r.appointment.status },
      {
        id: "noteStatus",
        header: "Note status",
        cell: (r) => (
          <span style={{ color: r.encounter.noteSigned ? "#059669" : "#D97706", fontWeight: 600, fontSize: 12 }}>
            {r.encounter.noteStatus}
          </span>
        ),
      },
      { id: "duration", header: "Duration", cell: (r) => fmtMinutes(r.appointment.durationMin) },
      {
        id: "providerCode",
        header: "Provider-selected code",
        cell: (r) => <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.providerSelectedCode ?? "—"}</span>,
      },
      {
        id: "suggestedCode",
        header: "System-suggested code",
        cell: (r) => <span style={{ fontFamily: "ui-monospace, monospace", color: "#475569" }}>{r.systemSuggestedCode ?? "—"}</span>,
      },
      {
        id: "codingAlert",
        header: "Coding alert",
        cell: (r) =>
          r.codingAlerts.length > 0 ? (
            <span style={{ fontSize: 11, color: "#991B1B", background: "#FEE2E2", padding: "1px 6px", borderRadius: 4 }}>
              {r.codingAlerts[0]}
            </span>
          ) : (
            <span style={{ color: "#94A3B8" }}>—</span>
          ),
      },
      {
        id: "eligibility",
        header: "Eligibility status",
        cell: (r) => (r.eligibility?.status ? r.eligibility.status : <span style={{ color: "#94A3B8" }}>—</span>),
      },
      {
        id: "auth",
        header: "Auth status",
        cell: (r) => (r.authorization?.status ? r.authorization.status : <span style={{ color: "#94A3B8" }}>—</span>),
      },
      {
        id: "charge",
        header: "Charge amount",
        align: "right",
        cell: (r) => <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{money(r.chargeAmount)}</span>,
      },
      {
        id: "actionNeeded",
        header: "Action needed",
        cell: (r) => <span style={{ fontSize: 12, color: "#475569" }}>{r.actionNeeded}</span>,
      },
    ],
    [],
  );

  // ── Detail editor helpers ──────────────────────────────────────────
  const updateLine = useCallback((idx: number, patch: Partial<ServiceLine>) => {
    setDetail((prev) => {
      if (!prev) return prev;
      const lines = prev.serviceLines.map((l, i) => (i === idx ? { ...l, ...patch } : l));
      const total = lines.reduce((s, l) => s + (l.chargeAmount || 0) * (l.units || 0), 0);
      return { ...prev, serviceLines: lines, totalCharge: Math.round(total * 100) / 100 };
    });
  }, []);

  const addLine = useCallback(() => {
    setDetail((prev) => prev ? {
      ...prev,
      serviceLines: [...prev.serviceLines, {
        ...EMPTY_LINE,
        lineNumber: prev.serviceLines.length + 1,
        serviceDateFrom: prev.serviceDate,
        serviceDateTo: prev.serviceDate,
        placeOfService: prev.placeOfService,
        renderingProviderNpi: prev.provider?.npi ?? null,
      }],
    } : prev);
  }, []);

  const removeLine = useCallback((idx: number) => {
    setDetail((prev) => {
      if (!prev) return prev;
      const lines = prev.serviceLines.filter((_, i) => i !== idx);
      const total = lines.reduce((s, l) => s + (l.chargeAmount || 0) * (l.units || 0), 0);
      return { ...prev, serviceLines: lines, totalCharge: Math.round(total * 100) / 100 };
    });
  }, []);

  const updateDiagnosis = useCallback((idx: number, value: string) => {
    setDetail((prev) => {
      if (!prev) return prev;
      const dx = [...prev.diagnoses];
      while (dx.length <= idx) dx.push("");
      dx[idx] = value.toUpperCase();
      while (dx.length > 0 && !dx[dx.length - 1]) dx.pop();
      return { ...prev, diagnoses: dx };
    });
  }, []);

  const validateAllCodes = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    if (!detail) return { ok: true };
    const dxCodes = detail.diagnoses.map((d) => d.trim().toUpperCase()).filter(Boolean);
    const procCodes = detail.serviceLines.map((l) => l.procedureCode.trim().toUpperCase()).filter(Boolean);
    const dxBad = new Map<string, CodeValidation>();
    const procBad = new Map<string, CodeValidation>();
    await Promise.all([
      ...dxCodes.map(async (c) => { const v = await validateCode("diagnosis", c); if (v.status !== "active") dxBad.set(c, v); }),
      ...procCodes.map(async (c) => { const v = await validateCode("procedure", c); if (v.status !== "active") procBad.set(c, v); }),
    ]);
    setInvalidDx(dxBad);
    setInvalidProc(procBad);
    if (dxBad.size === 0 && procBad.size === 0) return { ok: true };
    const parts: string[] = [];
    if (dxBad.size) parts.push(`ICD-10: ${[...dxBad.entries()].map(([c, v]) => describeCodeForSaveError(c, v)).join(", ")}`);
    if (procBad.size) parts.push(`CPT/HCPCS: ${[...procBad.entries()].map(([c, v]) => describeCodeForSaveError(c, v)).join(", ")}`);
    return { ok: false, reason: parts.join(" · ") };
  }, [detail]);

  const saveCharge = useCallback(async () => {
    if (!detail || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const codeCheck = await validateAllCodes();
      if (!codeCheck.ok) {
        setMessage({ tone: "error", text: codeCheck.reason ?? "Invalid codes" });
        setSaving(false);
        return;
      }
      const res = await fetch(
        `/api/billing/charge-capture/${encodeURIComponent(detail.id)}?organizationId=${encodeURIComponent(organizationId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            diagnoses: detail.diagnoses,
            placeOfService: detail.placeOfService,
            serviceDate: detail.serviceDate,
            serviceLines: detail.serviceLines.map((l) => ({
              procedureCode: l.procedureCode,
              serviceDateFrom: l.serviceDateFrom,
              serviceDateTo: l.serviceDateTo,
              modifiers: l.modifiers,
              diagnosisPointers: l.diagnosisPointers,
              units: l.units,
              chargeAmount: l.chargeAmount,
              placeOfService: l.placeOfService,
              renderingProviderNpi: l.renderingProviderNpi,
              authorizationNumber: l.authorizationNumber,
            })),
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Save failed");
      setMessage({ tone: "success", text: "Charge saved." });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }, [detail, saving, validateAllCodes, organizationId]);

  // ── Status-changing actions ────────────────────────────────────────
  const runAction = useCallback(
    async (chargeId: string, action: "approve" | "hold" | "route_back", reason?: string) => {
      if (acting) return;
      setActing(true);
      setMessage(null);

      // Optimistic update — flip the row's status / tab locally so the
      // table reflects the action without a full reload.
      setItems((prev) =>
        prev.map((r) => {
          if (r.id !== chargeId) return r;
          if (action === "approve") return { ...r, chargeStatus: "ready_for_claim", tab: "ready_for_review", actionNeeded: "Release to claims" };
          return { ...r, chargeStatus: "blocked", tab: "held_charges", actionNeeded: action === "hold" ? "Resolve hold" : "Awaiting clinician" };
        }),
      );

      try {
        const res = await fetch(
          `/api/billing/charge-capture/${encodeURIComponent(chargeId)}?organizationId=${encodeURIComponent(organizationId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, actionReason: reason ?? "" }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || "Action failed");
        const label = action === "approve" ? "Approved" : action === "hold" ? "Placed on hold" : "Routed back to clinician";
        setMessage({ tone: "success", text: label });
        setReloadKey((k) => k + 1);
      } catch (e) {
        setMessage({ tone: "error", text: e instanceof Error ? e.message : "Action failed" });
        setReloadKey((k) => k + 1); // revert via refetch
      } finally {
        setActing(false);
      }
    },
    [acting, organizationId],
  );

  const releaseCharge = useCallback(
    async (chargeId: string) => {
      if (acting) return;
      setActing(true);
      setMessage(null);
      try {
        const res = await fetch(`/api/billing/charge-capture/release`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, chargeCaptureIds: [chargeId] }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || "Release failed");
        const first = json.results?.[0];
        if (first && first.ok === false) {
          setMessage({ tone: "error", text: first.errors?.[0]?.message ?? "Release failed" });
        } else {
          setMessage({ tone: "success", text: "Released to claims." });
        }
        setReloadKey((k) => k + 1);
      } catch (e) {
        setMessage({ tone: "error", text: e instanceof Error ? e.message : "Release failed" });
      } finally {
        setActing(false);
      }
    },
    [acting, organizationId],
  );

  // ── Detail panel sections (spec) ───────────────────────────────────
  const renderApptDetails = useCallback(() => {
    if (!detail) return <div style={{ padding: 16, color: "#94A3B8" }}>Select a row to see details.</div>;
    const a = detail.appointment;
    return (
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        <Row label="Client" value={detail.client ? `${detail.client.lastName}, ${detail.client.firstName}` : "—"} />
        <Row label="DOB" value={fmtDate(detail.client?.dateOfBirth ?? null)} />
        <Row label="Account #" value={detail.client?.accountNumber ?? "—"} />
        <Row label="Appointment type" value={a?.type ?? "—"} />
        <Row label="Appointment status" value={a?.status ?? "—"} />
        <Row label="Scheduled" value={a?.startAt ? `${new Date(a.startAt).toLocaleString()} → ${a.endAt ? new Date(a.endAt).toLocaleTimeString() : "?"}` : "—"} />
        <Row label="Service date" value={fmtDate(detail.serviceDate)} />
        <Row label="Place of service" value={detail.placeOfService ?? "—"} />
        <Row label="Provider" value={detail.provider?.displayName ?? "—"} />
        <Row label="NPI" value={detail.provider?.npi ?? "—"} />
        {a?.memo ? <Row label="Memo" value={a.memo} /> : null}
      </div>
    );
  }, [detail]);

  const renderNotePreview = useCallback(() => {
    if (!detail) return <div style={{ padding: 16, color: "#94A3B8" }}>Select a row to see details.</div>;
    const e = detail.encounter;
    if (!e) return <div style={{ padding: 16, color: "#94A3B8" }}>No encounter linked.</div>;
    return (
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        <Row label="Note status" value={e.status ?? "—"} />
        <Row label="Billing fields complete" value={e.billingFieldsComplete ? "Yes" : "No"} />
        <Row label="Started" value={e.startedAt ? new Date(e.startedAt).toLocaleString() : "—"} />
        <Row label="Ended" value={e.endedAt ? new Date(e.endedAt).toLocaleString() : "—"} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", textTransform: "uppercase", marginBottom: 4 }}>Signed note preview</div>
          <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: 10, fontSize: 12.5, color: "#1E293B", whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>
            {e.sessionSummary?.trim() || "No session summary recorded."}
          </div>
        </div>
        {e.id ? (
          <a href={`/encounters/${e.id}`} style={{ fontSize: 12.5, color: "#3B82F6" }}>Open full encounter →</a>
        ) : null}
      </div>
    );
  }, [detail]);

  const renderTreatmentPlan = useCallback(() => {
    if (!detail) return <div style={{ padding: 16, color: "#94A3B8" }}>Select a row to see details.</div>;
    const caseId = detail.encounter?.caseId ?? null;
    return (
      <div style={{ padding: 12, fontSize: 13, display: "flex", flexDirection: "column", gap: 8 }}>
        {caseId ? (
          <>
            <Row label="Case" value={caseId} />
            <a href={`/clients/${detail.client?.id ?? ""}/cases/${caseId}/treatment-plan`} style={{ color: "#3B82F6", fontSize: 12.5 }}>
              Open treatment plan →
            </a>
          </>
        ) : (
          <span style={{ color: "#94A3B8" }}>No treatment plan linked to this encounter.</span>
        )}
      </div>
    );
  }, [detail]);

  const renderCodingIntegrity = useCallback(() => {
    if (!detail) return <div style={{ padding: 16, color: "#94A3B8" }}>Select a row to see details.</div>;
    const selectedRow = items.find((i) => i.id === detail.id);
    const alerts = selectedRow?.codingAlerts ?? [];
    const dxSlots = (() => { const a = [...detail.diagnoses]; while (a.length < 12) a.push(""); return a.slice(0, 12); })();
    return (
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
        <div className={styles.sectionCard}>
          <div className={styles.sectionTitle}>Coding alerts</div>
          {alerts.length === 0 ? (
            <div style={{ color: "#059669", fontSize: 12 }}>No coding issues detected.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "#991B1B" }}>
              {alerts.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          )}
          <Row label="Provider-selected" value={selectedRow?.providerSelectedCode ?? "—"} />
          <Row label="System-suggested" value={selectedRow?.systemSuggestedCode ?? "—"} />
        </div>
        <div className={styles.sectionCard}>
          <div className={styles.sectionTitle}>Diagnosis (ICD-10)</div>
          <div className={styles.dxGrid}>
            {dxSlots.map((code, idx) => {
              const upper = code.trim().toUpperCase();
              const badEntry = upper.length > 0 ? invalidDx.get(upper) : undefined;
              return (
                <div className={styles.dxCell} key={idx}>
                  <label>{`D${idx + 1}${idx === 0 ? "*" : ""}`}</label>
                  <CodeCombobox
                    kind="diagnosis"
                    value={code}
                    onChange={(next) => {
                      updateDiagnosis(idx, next);
                      if (invalidDx.size) {
                        setInvalidDx((prev) => { const n = new Map(prev); n.delete(upper); return n; });
                      }
                    }}
                    placeholder={idx === 0 ? "F41.1" : ""}
                    ariaLabel={`Diagnosis ${idx + 1}`}
                    invalid={Boolean(badEntry)}
                    invalidTitle={badEntry && badEntry.status !== "active" ? badEntry.reason : undefined}
                  />
                  {badEntry && badEntry.status === "header" ? (
                    <HeaderChildSuggestions parent={upper} onPick={(c) => updateDiagnosis(idx, c)} />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }, [detail, items, invalidDx, updateDiagnosis]);

  const renderEligibility = useCallback(() => {
    if (!detail) return <div style={{ padding: 16, color: "#94A3B8" }}>Select a row to see details.</div>;
    const e = detail.eligibility;
    if (!e) return <div style={{ padding: 16, color: "#94A3B8" }}>No eligibility check on file.</div>;
    return (
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        <Row label="Status" value={e.status ?? "—"} />
        <Row label="Checked at" value={e.checkedAt ? new Date(e.checkedAt).toLocaleString() : "—"} />
        <Row label="Authorization required" value={e.authorizationRequired ? "Yes" : "No"} />
        <Row label="Copay" value={money(e.copay)} />
        <Row label="Deductible remaining" value={money(e.deductibleRemaining)} />
        {e.rawStatusText ? <Row label="Raw status" value={e.rawStatusText} /> : null}
      </div>
    );
  }, [detail]);

  const renderAuthorization = useCallback(() => {
    if (!detail) return <div style={{ padding: 16, color: "#94A3B8" }}>Select a row to see details.</div>;
    const required = detail.eligibility?.authorizationRequired;
    return (
      <div style={{ padding: 12, fontSize: 13, display: "flex", flexDirection: "column", gap: 8 }}>
        <Row label="Authorization required" value={required ? "Yes" : "No"} />
        <span style={{ color: "#94A3B8", fontSize: 12 }}>Authorization records will appear here once captured.</span>
      </div>
    );
  }, [detail]);

  const renderClaimLines = useCallback(() => {
    if (detailLoading && !detail) return <div style={{ padding: 16, color: "#94A3B8" }}>Loading…</div>;
    if (!detail) return <div style={{ padding: 16, color: "#94A3B8" }}>Select a row to see details.</div>;
    return (
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className={styles.sectionCard}>
          <div className={styles.sectionTitleRow}>
            <span className={styles.sectionTitle}>Suggested claim lines</span>
            <button type="button" className={styles.smallBtn} onClick={addLine}>+ Add line</button>
          </div>
          <div className={styles.linesTableWrap}>
            <table className={styles.linesTable}>
              <thead>
                <tr>
                  <th>Proc</th><th>DOS From</th><th>DOS To</th><th>DX Ptr</th>
                  <th>M1</th><th>M2</th><th>M3</th><th>M4</th>
                  <th>Units</th><th>Charge</th><th>Total</th><th>POS</th><th>Auth #</th><th></th>
                </tr>
              </thead>
              <tbody>
                {detail.serviceLines.length === 0 ? (
                  <tr><td colSpan={14} style={{ textAlign: "center", color: "#94A3B8", padding: 16 }}>No procedure lines yet.</td></tr>
                ) : null}
                {detail.serviceLines.map((line, idx) => {
                  const lineTotal = (line.chargeAmount || 0) * (line.units || 0);
                  const mods = [0, 1, 2, 3].map((i) => line.modifiers[i] ?? "");
                  const procUpper = line.procedureCode.trim().toUpperCase();
                  const procBad = procUpper ? invalidProc.get(procUpper) : undefined;
                  return (
                    <tr key={idx}>
                      <td style={{ minWidth: 90 }}>
                        <CodeCombobox
                          kind="procedure"
                          value={line.procedureCode}
                          onChange={(next) => updateLine(idx, { procedureCode: next })}
                          className={styles.cellInput}
                          placeholder="90837"
                          ariaLabel={`Procedure code line ${idx + 1}`}
                          invalid={Boolean(procBad)}
                          invalidTitle={procBad && procBad.status !== "active" ? procBad.reason : undefined}
                        />
                      </td>
                      <td><input className={styles.cellInput} type="date" value={line.serviceDateFrom ?? ""} onChange={(e) => updateLine(idx, { serviceDateFrom: e.target.value || null })} /></td>
                      <td><input className={styles.cellInput} type="date" value={line.serviceDateTo ?? ""} onChange={(e) => updateLine(idx, { serviceDateTo: e.target.value || null })} /></td>
                      <td>
                        <input className={styles.cellInput} style={{ width: 50 }} value={line.diagnosisPointers.join(",")}
                          onChange={(e) => updateLine(idx, { diagnosisPointers: e.target.value.split(/[ ,]+/).map((s) => s.trim()).filter(Boolean) })} placeholder="1" />
                      </td>
                      {mods.map((m, mi) => (
                        <td key={mi}>
                          <input className={styles.cellInput} style={{ width: 50 }} value={m} maxLength={2}
                            onChange={(e) => {
                              const next = [...line.modifiers];
                              while (next.length <= mi) next.push("");
                              next[mi] = e.target.value.toUpperCase();
                              while (next.length > 0 && !next[next.length - 1]) next.pop();
                              updateLine(idx, { modifiers: next });
                            }} />
                        </td>
                      ))}
                      <td><input className={styles.cellInput} style={{ width: 50 }} type="number" min={1} value={line.units} onChange={(e) => updateLine(idx, { units: Number(e.target.value) || 1 })} /></td>
                      <td><input className={styles.cellInput} style={{ width: 78, textAlign: "right" }} type="number" step="0.01" min={0} value={line.chargeAmount} onChange={(e) => updateLine(idx, { chargeAmount: Number(e.target.value) || 0 })} /></td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{money(lineTotal)}</td>
                      <td>
                        <select className={styles.cellInput} style={{ width: 70 }} value={line.placeOfService ?? ""} onChange={(e) => updateLine(idx, { placeOfService: e.target.value || null })}>
                          <option value="">—</option>
                          {POS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
                        </select>
                      </td>
                      <td><input className={styles.cellInput} style={{ width: 110 }} value={line.authorizationNumber ?? ""} onChange={(e) => updateLine(idx, { authorizationNumber: e.target.value || null })} /></td>
                      <td><button type="button" className={styles.iconBtn} onClick={() => removeLine(idx)} title="Remove line">×</button></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={10} style={{ textAlign: "right", fontWeight: 600, padding: "8px 12px" }}>Total</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, padding: "8px 12px" }}>{money(detail.totalCharge)}</td>
                  <td colSpan={3}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    );
  }, [detail, detailLoading, invalidProc, updateLine, addLine, removeLine]);

  const detailTabs: DetailTab[] = useMemo(
    () => [
      { id: "appt", label: "Appointment", render: renderApptDetails },
      { id: "note", label: "Signed note", render: renderNotePreview },
      { id: "plan", label: "Treatment plan", render: renderTreatmentPlan },
      { id: "coding", label: "Coding integrity", render: renderCodingIntegrity },
      { id: "elig", label: "Eligibility", render: renderEligibility },
      { id: "auth", label: "Authorization", render: renderAuthorization },
      { id: "lines", label: "Claim lines", render: renderClaimLines },
    ],
    [renderApptDetails, renderNotePreview, renderTreatmentPlan, renderCodingIntegrity, renderEligibility, renderAuthorization, renderClaimLines],
  );

  // ── Row actions (Approve, Hold, Route back) ────────────────────────
  const rowActions: RowAction<ListRow>[] = useMemo(
    () => [
      {
        id: "approve",
        label: "Approve",
        variant: "success",
        onClick: (r) => void runAction(r.id, "approve"),
        disabled: (r) => acting || r.chargeStatus === "claim_created" || r.chargeStatus === "ready_for_claim",
      },
      {
        id: "hold",
        label: "Hold",
        onClick: (r) => {
          const reason = typeof window !== "undefined" ? (window.prompt("Hold reason?") ?? "") : "";
          void runAction(r.id, "hold", reason);
        },
        disabled: (r) => acting || r.chargeStatus === "claim_created",
      },
      {
        id: "route_back",
        label: "Route back",
        onClick: (r) => {
          const reason = typeof window !== "undefined" ? (window.prompt("What does the clinician need to fix?") ?? "") : "";
          void runAction(r.id, "route_back", reason);
        },
        disabled: (r) => acting || r.chargeStatus === "claim_created",
      },
      {
        id: "place_on_hold",
        label: "Place on hold",
        onClick: (r) => {
          if (!r.claimId) return;
          setHoldTarget({
            claimId: r.claimId,
            subtitle: `${r.client?.name ?? "Client"} · ${r.payer?.name ?? "—"}`,
            sourceRowId: r.id,
          });
        },
        disabled: (r) => acting || !r.claimId,
      },
    ],
    [runAction, acting],
  );

  // ── Detail action buttons (full set, spec) ─────────────────────────
  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!detail) return [];
    return [
      { id: "approve", label: "Approve charge", variant: "success", onClick: () => void runAction(detail.id, "approve"), disabled: acting || detail.status === "claim_created" },
      { id: "hold", label: "Hold charge", onClick: () => { const reason = window.prompt("Hold reason?") ?? ""; void runAction(detail.id, "hold", reason); }, disabled: acting || detail.status === "claim_created" },
      { id: "route_back", label: "Route back to clinician", onClick: () => { const reason = window.prompt("What does the clinician need to fix?") ?? ""; void runAction(detail.id, "route_back", reason); }, disabled: acting || detail.status === "claim_created" },
      { id: "change_code", label: "Change code", onClick: () => setMessage({ tone: "success", text: "Edit codes in the Coding integrity tab, then Save." }) },
      { id: "add_modifier", label: "Add modifier", onClick: () => setMessage({ tone: "success", text: "Add modifiers on a procedure line in the Claim lines tab, then Save." }) },
      { id: "save", label: saving ? "Saving…" : "Save edits", onClick: () => void saveCharge(), disabled: saving },
      { id: "release", label: "Release to claim creation", variant: "primary", onClick: () => void releaseCharge(detail.id), disabled: acting || detail.status !== "ready_for_claim" },
      {
        id: "place_on_hold",
        label: "Place on hold",
        onClick: () => {
          const row = items.find((r) => r.id === detail.id);
          const claimId = row?.claimId ?? null;
          if (!claimId) return;
          setHoldTarget({
            claimId,
            subtitle: `${row?.client?.name ?? "Client"} · ${row?.payer?.name ?? "—"}`,
            sourceRowId: detail.id,
          });
        },
        disabled: acting || !(items.find((r) => r.id === detail.id)?.claimId),
      },
    ];
  }, [detail, acting, saving, runAction, releaseCharge, saveCharge, items]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Spec tabs strip — sits above the universal shell because the
          shell only supports detail-pane tabs. */}
      <div role="tablist" aria-label="Charge capture tabs"
        style={{ display: "flex", gap: 4, padding: "8px 16px 0", background: "#fff", borderBottom: "1px solid #E2E8F0", overflowX: "auto" }}>
        {TABS.map((t) => {
          const count = tabCounts[t.id];
          const active = t.id === activeTab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(t.id)}
              style={{
                padding: "8px 14px",
                border: 0,
                borderBottom: `2px solid ${active ? "#3B82F6" : "transparent"}`,
                background: "transparent",
                color: active ? "#0F172A" : "#64748B",
                fontWeight: active ? 700 : 500,
                fontSize: 13,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
              {typeof count === "number" ? (
                <span style={{ marginLeft: 6, padding: "1px 7px", background: active ? "#DBEAFE" : "#F1F5F9", color: active ? "#1D4ED8" : "#64748B", borderRadius: 10, fontSize: 11.5 }}>
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <WorkqueueShell<ListRow>
          title={queueDef?.title ?? "Charge Capture"}
          description={queueDef?.description}
          headerActions={[
            ...(selectedIds.length > 0
              ? [
                  {
                    id: "bulk-hold",
                    label: `Place ${selectedIds.length} on hold`,
                    variant: "primary" as const,
                    onClick: () => setBulkHoldOpen(true),
                    disabled: acting,
                  },
                  {
                    id: "clear-selection",
                    label: "Clear selection",
                    onClick: () => setSelectedIds([]),
                  },
                ]
              : []),
            { id: "refresh", label: loading ? "Loading…" : "Refresh", onClick: () => setReloadKey((k) => k + 1), disabled: loading },
          ]}
          summary={summary}
          filters={filters}
          filterValues={filterValues}
          onFilterChange={setFilterValues}
          filterUrlNamespace="cc"
          rows={visibleItems}
          columns={columns}
          rowId={(r) => r.id}
          loading={loading}
          emptyMessage="No charges match the current filters."
          selectedRowId={selectedId}
          onSelectRow={setSelectedId}
          selectedRowIds={selectedIds}
          onSelectionChange={setSelectedIds}
          rowActions={rowActions}
          detailTabs={detailTabs}
          detailActions={detailActions}
          tablePaneWidth="auto"
          detailPaneWidth="520px"
          message={message}
        />
      </div>
      {holdTarget ? (
        <PlaceClaimOnHoldModal
          claimId={holdTarget.claimId}
          organizationId={organizationId}
          subtitle={holdTarget.subtitle}
          onClose={() => setHoldTarget(null)}
          onPlaced={() => {
            setMessage({ tone: "success", text: "Claim placed on hold." });
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}
      {bulkHoldOpen ? (
        (() => {
          const selectedRows = items.filter((r) => selectedIds.includes(r.id));
          const claimIds = selectedRows
            .map((r) => r.claimId)
            .filter((id): id is string => !!id);
          const skipped = selectedIds.length - claimIds.length;
          const subtitle =
            (claimIds.length > 0
              ? `${claimIds.length} claim${claimIds.length === 1 ? "" : "s"} selected`
              : "No selected rows have a claim yet") +
            (skipped > 0
              ? ` · ${skipped} skipped (no claim created yet)`
              : "");
          if (claimIds.length === 0) {
            return (
              <PlaceClaimOnHoldModal
                claimIds={[]}
                claimId={undefined}
                organizationId={organizationId}
                subtitle={subtitle}
                onClose={() => setBulkHoldOpen(false)}
              />
            );
          }
          return (
            <PlaceClaimOnHoldModal
              claimIds={claimIds}
              organizationId={organizationId}
              subtitle={subtitle}
              onClose={() => setBulkHoldOpen(false)}
              onPlacedBulk={(summary) => {
                const parts = [
                  `${summary.succeeded} placed on hold`,
                  summary.failed > 0 ? `${summary.failed} failed` : null,
                  skipped > 0 ? `${skipped} skipped` : null,
                ].filter(Boolean);
                setMessage({
                  tone: summary.failed > 0 ? "error" : "success",
                  text: parts.join(" · "),
                });
                setSelectedIds([]);
                setReloadKey((k) => k + 1);
              }}
            />
          );
        })()
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.04, minWidth: 130 }}>{label}</span>
      <span style={{ fontSize: 13, color: "#0F172A" }}>{value}</span>
    </div>
  );
}
