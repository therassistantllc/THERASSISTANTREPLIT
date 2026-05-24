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
import { getWorkqueue } from "@/lib/billing/workqueues";

type Item = {
  id: string;
  claim_number: string | null;
  claim_status: string;
  client_id: string | null;
  client_name: string;
  service_date: string | null;
  clinician_name: string | null;
  payer_name: string | null;
  payer_type: string | null;
  payer_id_value: string | null;
  cpt_codes: string[];
  diagnosis_codes: string[];
  modifiers: string[];
  charge_amount: number;
  place_of_service: string | null;
  rendering_provider_npi: string | null;
  billing_provider_name: string | null;
  billing_provider_npi: string | null;
  ready_status: "ready" | "on_hold" | "needs_batch_assignment";
  held_at: string | null;
  hold_reason: string | null;
  age_days: number | null;
  encounter_id: string | null;
  batch_id: string | null;
  practice_id: string | null;
  practice_name: string | null;
  assigned_biller_user_id: string | null;
  assigned_biller_name: string | null;
  carc_codes: string[];
  rarc_codes: string[];
  follow_up_due_at: string | null;
};

type TabId =
  | "ready"
  | "needs_batch_assignment"
  | "high_dollar_review"
  | "medicaid_claims"
  | "commercial_claims";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "ready", label: "Ready" },
  { id: "needs_batch_assignment", label: "Needs Batch Assignment" },
  { id: "high_dollar_review", label: "High Dollar Review" },
  { id: "medicaid_claims", label: "Medicaid Claims" },
  { id: "commercial_claims", label: "Commercial Claims" },
];

const HIGH_DOLLAR_THRESHOLD = 1000;

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function getInitialTab(): TabId {
  if (typeof window === "undefined") return "ready";
  const params = new URLSearchParams(window.location.search);
  const t = params.get("tab");
  return TABS.some((x) => x.id === t) ? (t as TabId) : "ready";
}

function money(value: number) {
  return Number(value ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

function isMedicaidPayerType(t: string | null): boolean {
  if (!t) return false;
  return /medicaid|mcd/i.test(t);
}

function isCommercialPayerType(t: string | null): boolean {
  if (!t) return false;
  return /commercial|comm|bcbs|ppo|hmo/i.test(t);
}

function applyTab(items: Item[], tab: TabId): Item[] {
  switch (tab) {
    case "ready":
      return items.filter((i) => i.ready_status === "ready");
    case "needs_batch_assignment":
      // Per spec: claims that are ready_for_batch but not yet linked to a
      // pending 837P batch. Today that's the same set as "Ready" — but the
      // tab is here so the spec is met and we can layer batch state on top.
      return items.filter((i) => i.ready_status !== "on_hold" && !i.batch_id);
    case "high_dollar_review":
      return items.filter((i) => (i.charge_amount ?? 0) >= HIGH_DOLLAR_THRESHOLD);
    case "medicaid_claims":
      return items.filter((i) => isMedicaidPayerType(i.payer_type));
    case "commercial_claims":
      return items.filter((i) => isCommercialPayerType(i.payer_type));
    default:
      return items;
  }
}

const queueDef = getWorkqueue("ready_to_generate");

export default function ReadyToGenerateClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>(getInitialTab);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [preview, setPreview] = useState<{
    loading: boolean;
    text: string | null;
    error: string | null;
  }>({ loading: false, text: null, error: null });
  const [holdReason, setHoldReason] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // ── Initial load + URL tab sync ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(
      `/api/billing/ready-to-generate?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success) {
          setItems(json.items ?? []);
        } else {
          setMessage({ tone: "error", text: json.error ?? "Failed to load worklist" });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setMessage({ tone: "error", text: e instanceof Error ? e.message : "Failed to load" });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId, reloadKey]);

  // Persist active tab to the URL so back/forward + share-links work.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (activeTab === "ready") url.searchParams.delete("tab");
    else url.searchParams.set("tab", activeTab);
    window.history.replaceState({}, "", url.toString());
  }, [activeTab]);

  // ── Filter options derived from data ────────────────────────────────────
  const payerOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const i of items) {
      if (i.payer_name) set.set(i.payer_name, i.payer_name);
    }
    return [...set.entries()].map(([value, label]) => ({ value, label }));
  }, [items]);

  const clinicianOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const i of items) {
      if (i.clinician_name) set.set(i.clinician_name, i.clinician_name);
    }
    return [...set.entries()].map(([value, label]) => ({ value, label }));
  }, [items]);

  const practiceOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const i of items) {
      if (i.practice_id) {
        set.set(i.practice_id, i.practice_name || i.practice_id);
      }
    }
    return [...set.entries()].map(([value, label]) => ({ value, label }));
  }, [items]);

  const billerOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const i of items) {
      if (i.assigned_biller_user_id) {
        set.set(
          i.assigned_biller_user_id,
          i.assigned_biller_name || i.assigned_biller_user_id,
        );
      }
    }
    set.set("__unassigned__", "Unassigned");
    return [...set.entries()].map(([value, label]) => ({ value, label }));
  }, [items]);

  // ── Universal filter rail ───────────────────────────────────────────────
  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "select", options: practiceOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Patient or claim #" },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicianOptions },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "assignedBiller", label: "Assigned biller", kind: "select", options: billerOptions },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "Code" },
      { id: "followUpDueFrom", label: "Follow-up from", kind: "date" },
      { id: "followUpDueTo", label: "Follow-up to", kind: "date" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "ready", label: "Ready" },
          { value: "on_hold", label: "On Hold" },
          { value: "needs_batch_assignment", label: "Needs Batch" },
        ],
      },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Aging",
        kind: "select",
        options: [
          { value: "0_7", label: "0–7 days" },
          { value: "8_14", label: "8–14 days" },
          { value: "15_30", label: "15–30 days" },
          { value: "30_plus", label: "30+ days" },
        ],
      },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [
          { value: "high_dollar", label: "High Dollar" },
          { value: "aged", label: "Aged > 14d" },
        ],
      },
      { id: "cpt", label: "CPT/HCPCS", kind: "text", placeholder: "e.g. 90834" },
      { id: "dx", label: "Diagnosis", kind: "text", placeholder: "e.g. F33.1" },
      { id: "modifier", label: "Modifier", kind: "text", placeholder: "e.g. 95" },
      { id: "pos", label: "POS", kind: "text", placeholder: "e.g. 11" },
      { id: "billingProvider", label: "Billing provider", kind: "text", placeholder: "Name or NPI" },
      { id: "renderingProvider", label: "Rendering NPI", kind: "text", placeholder: "NPI" },
    ],
    [clinicianOptions, payerOptions, practiceOptions, billerOptions],
  );

  // ── Filter + tab pipeline ───────────────────────────────────────────────
  const filteredAll = useMemo(() => {
    let list = items;
    const v = filterValues;
    if (v.client) {
      const q = v.client.toLowerCase();
      list = list.filter(
        (c) =>
          c.client_name.toLowerCase().includes(q) ||
          (c.claim_number ?? "").toLowerCase().includes(q) ||
          c.cpt_codes.some((p) => p.toLowerCase().includes(q)),
      );
    }
    if (v.clinician) list = list.filter((c) => c.clinician_name === v.clinician);
    if (v.payer) list = list.filter((c) => c.payer_name === v.payer);
    if (v.status) list = list.filter((c) => c.ready_status === v.status);
    if (v.dosFrom) {
      const from = Date.parse(v.dosFrom);
      list = list.filter((c) => {
        const t = Date.parse(c.service_date ?? "");
        return !Number.isNaN(t) && !Number.isNaN(from) && t >= from;
      });
    }
    if (v.dosTo) {
      const to = Date.parse(v.dosTo);
      list = list.filter((c) => {
        const t = Date.parse(c.service_date ?? "");
        return !Number.isNaN(t) && !Number.isNaN(to) && t <= to;
      });
    }
    if (v.minAmount) {
      const n = Number(v.minAmount);
      if (!Number.isNaN(n)) list = list.filter((c) => c.charge_amount >= n);
    }
    if (v.maxAmount) {
      const n = Number(v.maxAmount);
      if (!Number.isNaN(n)) list = list.filter((c) => c.charge_amount <= n);
    }
    if (v.agingBucket) {
      list = list.filter((c) => {
        const a = c.age_days ?? 0;
        switch (v.agingBucket) {
          case "0_7": return a <= 7;
          case "8_14": return a >= 8 && a <= 14;
          case "15_30": return a >= 15 && a <= 30;
          case "30_plus": return a > 30;
          default: return true;
        }
      });
    }
    if (v.priority === "high_dollar") {
      list = list.filter((c) => c.charge_amount >= HIGH_DOLLAR_THRESHOLD);
    } else if (v.priority === "aged") {
      list = list.filter((c) => (c.age_days ?? 0) > 14);
    }
    if (v.cpt) {
      const q = v.cpt.toLowerCase();
      list = list.filter((c) => c.cpt_codes.some((p) => p.toLowerCase().includes(q)));
    }
    if (v.dx) {
      const q = v.dx.toLowerCase();
      list = list.filter((c) => c.diagnosis_codes.some((d) => d.toLowerCase().includes(q)));
    }
    if (v.modifier) {
      const q = v.modifier.toLowerCase();
      list = list.filter((c) => c.modifiers.some((m) => m.toLowerCase().includes(q)));
    }
    if (v.pos) {
      const q = v.pos.toLowerCase();
      list = list.filter((c) => (c.place_of_service ?? "").toLowerCase().includes(q));
    }
    if (v.billingProvider) {
      const q = v.billingProvider.toLowerCase();
      list = list.filter(
        (c) =>
          (c.billing_provider_name ?? "").toLowerCase().includes(q) ||
          (c.billing_provider_npi ?? "").toLowerCase().includes(q),
      );
    }
    if (v.renderingProvider) {
      const q = v.renderingProvider.toLowerCase();
      list = list.filter((c) => (c.rendering_provider_npi ?? "").toLowerCase().includes(q));
    }
    if (v.practice) {
      list = list.filter((c) => c.practice_id === v.practice);
    }
    if (v.assignedBiller) {
      if (v.assignedBiller === "__unassigned__") {
        list = list.filter((c) => !c.assigned_biller_user_id);
      } else {
        list = list.filter((c) => c.assigned_biller_user_id === v.assignedBiller);
      }
    }
    if (v.carcRarc) {
      const q = v.carcRarc.toLowerCase();
      list = list.filter(
        (c) =>
          c.carc_codes.some((code) => code.toLowerCase().includes(q)) ||
          c.rarc_codes.some((code) => code.toLowerCase().includes(q)),
      );
    }
    if (v.followUpDueFrom) {
      const from = Date.parse(v.followUpDueFrom);
      list = list.filter((c) => {
        const t = Date.parse(c.follow_up_due_at ?? "");
        return !Number.isNaN(t) && !Number.isNaN(from) && t >= from;
      });
    }
    if (v.followUpDueTo) {
      const to = Date.parse(v.followUpDueTo);
      list = list.filter((c) => {
        const t = Date.parse(c.follow_up_due_at ?? "");
        return !Number.isNaN(t) && !Number.isNaN(to) && t <= to;
      });
    }
    return list;
  }, [items, filterValues]);

  const rows = useMemo(() => applyTab(filteredAll, activeTab), [filteredAll, activeTab]);

  // Keep selection valid when tab/filter changes.
  useEffect(() => {
    if (selectedId && !rows.some((r) => r.id === selectedId)) {
      setSelectedId(rows.length > 0 ? rows[0].id : null);
    } else if (!selectedId && rows.length > 0) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  // Drop any multi-select rows that have left the current view (filter or
  // tab change). Server-side validation will still catch stale ids, but
  // this keeps the header count honest.
  useEffect(() => {
    if (selectedIds.length === 0) return;
    const visible = new Set(items.map((i) => i.id));
    const next = selectedIds.filter((id) => visible.has(id));
    if (next.length !== selectedIds.length) setSelectedIds(next);
  }, [items, selectedIds]);

  // Selected rows (across the full dataset, not just the current view).
  const selectedRows = useMemo(() => {
    const set = new Set(selectedIds);
    return items.filter((i) => set.has(i.id));
  }, [items, selectedIds]);

  const selectedTotal = useMemo(
    () => selectedRows.reduce((s, r) => s + (r.charge_amount || 0), 0),
    [selectedRows],
  );

  const selectionHasIneligible = useMemo(
    () => selectedRows.some((r) => r.ready_status !== "ready"),
    [selectedRows],
  );

  const selectionPayerIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of selectedRows) {
      // payer_name is a stable display proxy; the API filters on payer_profile_id.
      if (r.payer_name) set.add(r.payer_name);
    }
    return [...set];
  }, [selectedRows]);

  // ── Header summary strip ────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const dollars = rows.reduce((s, r) => s + (r.charge_amount || 0), 0);
    const ages = rows.map((r) => r.age_days ?? 0);
    const oldest = ages.length > 0 ? Math.max(...ages) : 0;
    const urgent = rows.filter(
      (r) => (r.age_days ?? 0) > 14 || r.charge_amount >= HIGH_DOLLAR_THRESHOLD,
    ).length;
    return [
      { id: "count", label: "Claims", value: rows.length.toLocaleString() },
      { id: "dollars", label: "Total $", value: money(dollars) },
      {
        id: "selected",
        label: "Selected",
        value: selectedIds.length.toLocaleString(),
        tone: selectedIds.length > 0 ? "green" : "default",
      },
      {
        id: "selectedDollars",
        label: "Selected $",
        value: money(selectedTotal),
        tone: selectedIds.length > 0 ? "green" : "default",
      },
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
  }, [rows, selectedIds, selectedTotal]);

  // ── Action handlers (optimistic UI) ─────────────────────────────────────
  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  const runAction = useCallback(
    async (
      claimId: string,
      action: "generate" | "add_to_batch" | "return_to_charge_capture" | "hold" | "unhold",
      reason?: string,
    ) => {
      if (busy) return;
      setBusy(true);
      setMessage(null);
      try {
        const res = await fetch(
          `/api/billing/ready-to-generate/${encodeURIComponent(claimId)}/action`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId, action, reason }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error ?? "Action failed");

        // Optimistic local update — drop the row for terminal transitions,
        // mutate for hold/unhold so the user sees the change immediately.
        setItems((prev) => {
          if (action === "generate" || action === "add_to_batch" || action === "return_to_charge_capture") {
            return prev.filter((i) => i.id !== claimId);
          }
          if (action === "hold") {
            return prev.map((i) =>
              i.id === claimId
                ? { ...i, ready_status: "on_hold" as const, held_at: new Date().toISOString(), hold_reason: reason ?? "Held" }
                : i,
            );
          }
          if (action === "unhold") {
            return prev.map((i) =>
              i.id === claimId
                ? { ...i, ready_status: "ready" as const, held_at: null, hold_reason: null }
                : i,
            );
          }
          return prev;
        });

        const label =
          action === "generate"
            ? "Claim queued for 837P generation."
            : action === "add_to_batch"
            ? `Added to batch ${json.batchNumber ?? ""}.`
            : action === "return_to_charge_capture"
            ? "Returned to Charge Capture."
            : action === "hold"
            ? "Claim placed on hold."
            : "Hold released.";
        setMessage({ tone: "success", text: label });
        setHoldReason("");
      } catch (e) {
        setMessage({ tone: "error", text: e instanceof Error ? e.message : "Action failed" });
        // Refresh from server on error so optimistic state can't drift.
        setReloadKey((k) => k + 1);
      } finally {
        setBusy(false);
      }
    },
    [busy, organizationId],
  );

  // Bulk: bundle every checked claim into a single 837P batch.
  const runBulkBatch = useCallback(async () => {
    if (busy) return;
    if (selectedIds.length === 0) return;

    if (selectionHasIneligible) {
      setMessage({
        tone: "error",
        text: "Some selected claims are on hold or not ready. Clear them from the selection first.",
      });
      return;
    }

    let payerProfileId: string | null = null;
    if (selectionPayerIds.length > 1) {
      const ok =
        typeof window === "undefined"
          ? true
          : window.confirm(
              `You've selected claims across ${selectionPayerIds.length} payers (${selectionPayerIds.join(", ")}).\n\nBundling mixed payers into one 837P file is unusual — clearinghouses normally expect one payer per file. Continue anyway?`,
            );
      if (!ok) return;
    }

    const confirmText = `Generate one 837P batch from ${selectedIds.length} claim${
      selectedIds.length === 1 ? "" : "s"
    } totaling ${money(selectedTotal)}?`;
    if (typeof window !== "undefined" && !window.confirm(confirmText)) return;

    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/billing/ready-to-generate/bulk-batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          claimIds: selectedIds,
          payerProfileId,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Bulk batch failed");

      const batchedIds = new Set<string>(selectedIds);
      setItems((prev) => prev.filter((i) => !batchedIds.has(i.id)));
      setSelectedIds([]);
      setMessage({
        tone: "success",
        text: `Created batch ${json.batchNumber ?? ""} from ${json.claimCount ?? selectedIds.length} claims (${money(json.totalChargeAmount ?? selectedTotal)}).`,
      });
    } catch (e) {
      setMessage({
        tone: "error",
        text: e instanceof Error ? e.message : "Bulk batch failed",
      });
      setReloadKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    selectedIds,
    selectedTotal,
    selectionHasIneligible,
    selectionPayerIds,
    organizationId,
  ]);

  // Load 837 preview when the user opens the preview tab.
  const loadPreview = useCallback(
    async (claimId: string) => {
      setPreview({ loading: true, text: null, error: null });
      try {
        const res = await fetch(
          `/api/billing/ready-to-generate/${encodeURIComponent(claimId)}/preview?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error ?? "Preview failed");
        setPreview({ loading: false, text: json.preview ?? "", error: null });
      } catch (e) {
        setPreview({
          loading: false,
          text: null,
          error: e instanceof Error ? e.message : "Preview failed",
        });
      }
    },
    [organizationId],
  );

  // Reset preview cache when selection changes.
  useEffect(() => {
    setPreview({ loading: false, text: null, error: null });
  }, [selectedId]);

  // ── Columns (match spec exactly) ────────────────────────────────────────
  const columns: ColumnDef<Item>[] = useMemo(
    () => [
      {
        id: "client",
        header: "Client",
        cell: (r) => (
          <>
            <div style={{ fontWeight: 600 }}>{r.client_name}</div>
            <div style={{ fontSize: 11.5, color: "#94A3B8" }}>
              {r.claim_number ?? "—"} ·{" "}
              {r.ready_status === "on_hold"
                ? "On Hold"
                : r.ready_status === "needs_batch_assignment"
                ? "Needs Batch"
                : "Ready"}
            </div>
          </>
        ),
      },
      { id: "dos", header: "DOS", cell: (r) => formatDate(r.service_date) },
      { id: "clinician", header: "Clinician", cell: (r) => r.clinician_name ?? "—" },
      { id: "payer", header: "Payer", cell: (r) => r.payer_name ?? "—" },
      {
        id: "cpt",
        header: "CPT/HCPCS",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.cpt_codes.length > 0 ? r.cpt_codes.join(", ") : "—"}
          </span>
        ),
      },
      {
        id: "dx",
        header: "Diagnosis",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {r.diagnosis_codes.length > 0 ? r.diagnosis_codes.slice(0, 3).join(", ") : "—"}
            {r.diagnosis_codes.length > 3 ? ` +${r.diagnosis_codes.length - 3}` : ""}
          </span>
        ),
      },
      {
        id: "modifiers",
        header: "Modifiers",
        cell: (r) => (r.modifiers.length > 0 ? r.modifiers.join(", ") : "—"),
      },
      {
        id: "charge",
        header: "Charge amount",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {money(r.charge_amount)}
          </span>
        ),
      },
      { id: "pos", header: "Place of service", cell: (r) => r.place_of_service ?? "—" },
      {
        id: "rendering",
        header: "Rendering provider",
        cell: (r) => r.rendering_provider_npi ?? "—",
      },
      {
        id: "billing",
        header: "Billing provider",
        cell: (r) => (
          <>
            <div>{r.billing_provider_name ?? "—"}</div>
            <div style={{ fontSize: 11, color: "#94A3B8" }}>
              {r.billing_provider_npi ?? "—"}
            </div>
          </>
        ),
      },
      {
        id: "ready",
        header: "Ready status",
        cell: (r) => {
          const tone =
            r.ready_status === "ready"
              ? "#15803D"
              : r.ready_status === "on_hold"
              ? "#B45309"
              : "#2563EB";
          return (
            <span style={{ color: tone, fontWeight: 600 }}>
              {r.ready_status === "ready"
                ? "Ready"
                : r.ready_status === "on_hold"
                ? "On Hold"
                : "Needs Batch"}
            </span>
          );
        },
      },
    ],
    [],
  );

  // ── Row actions ─────────────────────────────────────────────────────────
  const rowActions: RowAction<Item>[] = useMemo(
    () => [
      {
        id: "generate",
        label: "Generate",
        variant: "primary",
        onClick: (r) => void runAction(r.id, "generate"),
        disabled: (r) => busy || r.ready_status === "on_hold",
      },
      {
        id: "hold",
        label: "Hold",
        onClick: (r) =>
          void runAction(r.id, r.ready_status === "on_hold" ? "unhold" : "hold", "Held from row"),
        disabled: () => busy,
      },
    ],
    [busy, runAction],
  );

  // ── Detail panel ────────────────────────────────────────────────────────
  const renderClaimPreviewTab = useCallback(() => {
    if (!selected) return null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Section title="Claim header">
          <Field label="Claim #" value={selected.claim_number ?? "—"} />
          <Field label="Client" value={selected.client_name} />
          <Field label="DOS" value={formatDate(selected.service_date)} />
          <Field label="Payer" value={selected.payer_name ?? "—"} />
          <Field label="Payer ID" value={selected.payer_id_value ?? "—"} />
          <Field label="Total charge" value={money(selected.charge_amount)} />
        </Section>
        <Section title="Status">
          <Field label="Ready" value={selected.ready_status} />
          {selected.held_at ? (
            <>
              <Field label="Held at" value={formatDate(selected.held_at)} />
              <Field label="Hold reason" value={selected.hold_reason ?? "—"} />
            </>
          ) : null}
          <Field label="Age" value={`${selected.age_days ?? 0}d`} />
        </Section>
      </div>
    );
  }, [selected]);

  const renderChecklistTab = useCallback(() => {
    if (!selected) return null;
    const checks: Array<{ id: string; ok: boolean; label: string }> = [
      { id: "ref", ok: !!selected.claim_number, label: "CLM01 — Patient account / claim ref" },
      { id: "amt", ok: selected.charge_amount > 0, label: "CLM02 — Total charge > 0" },
      { id: "pos", ok: !!selected.place_of_service, label: "CLM05 — Place of service" },
      { id: "dx", ok: selected.diagnosis_codes.length > 0, label: "HI — At least one ICD-10 diagnosis" },
      { id: "lines", ok: selected.cpt_codes.length > 0, label: "LX/SV1 — At least one service line with a procedure code" },
      { id: "billing", ok: !!selected.billing_provider_npi, label: "2010AA NM1*85 — Billing provider NPI" },
      { id: "rendering", ok: !!selected.rendering_provider_npi, label: "2310B NM1*82 — Rendering provider NPI" },
      { id: "payer", ok: !!selected.payer_id_value, label: "2010BB NM1*PR — Payer ID" },
    ];
    return (
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
        {checks.map((c) => (
          <li
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 0",
              borderBottom: "1px solid #F1F5F9",
              fontSize: 13,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 16,
                color: c.ok ? "#15803D" : "#C53030",
                fontWeight: 700,
              }}
            >
              {c.ok ? "✓" : "✗"}
            </span>
            <span style={{ color: c.ok ? "#0F172A" : "#7F1D1D" }}>{c.label}</span>
          </li>
        ))}
      </ul>
    );
  }, [selected]);

  const renderValidationTab = useCallback(() => {
    if (!selected) return null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Section title="Billing provider">
          <Field label="Name" value={selected.billing_provider_name ?? "—"} />
          <Field label="NPI" value={selected.billing_provider_npi ?? "—"} />
        </Section>
        <Section title="Payer">
          <Field label="Name" value={selected.payer_name ?? "—"} />
          <Field label="Type" value={selected.payer_type ?? "—"} />
          <Field label="Payer ID" value={selected.payer_id_value ?? "—"} />
        </Section>
        <Section title="Rendering provider">
          <Field label="NPI" value={selected.rendering_provider_npi ?? "—"} />
        </Section>
      </div>
    );
  }, [selected]);

  const renderDxPointersTab = useCallback(() => {
    if (!selected) return null;
    if (selected.diagnosis_codes.length === 0) {
      return <div style={{ color: "#94A3B8" }}>No diagnoses on this claim.</div>;
    }
    return (
      <ol style={{ margin: 0, paddingLeft: 20, fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
        {selected.diagnosis_codes.map((dx, idx) => (
          <li key={`${dx}-${idx}`} style={{ padding: "4px 0" }}>
            <strong>D{idx + 1}</strong> {dx}
          </li>
        ))}
      </ol>
    );
  }, [selected]);

  const renderLinesTab = useCallback(() => {
    if (!selected) return null;
    return (
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#64748B" }}>
            <th style={{ padding: "4px 6px" }}>CPT</th>
            <th style={{ padding: "4px 6px" }}>Mods</th>
            <th style={{ padding: "4px 6px", textAlign: "right" }}>Charge</th>
            <th style={{ padding: "4px 6px" }}>POS</th>
          </tr>
        </thead>
        <tbody>
          {selected.cpt_codes.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ padding: 8, color: "#94A3B8" }}>
                No service lines.
              </td>
            </tr>
          ) : (
            selected.cpt_codes.map((cpt, idx) => (
              <tr key={`${cpt}-${idx}`} style={{ borderTop: "1px solid #F1F5F9" }}>
                <td style={{ padding: "4px 6px", fontFamily: "ui-monospace, monospace" }}>{cpt}</td>
                <td style={{ padding: "4px 6px" }}>{selected.modifiers.join(", ") || "—"}</td>
                <td style={{ padding: "4px 6px", textAlign: "right" }}>
                  {idx === 0 ? money(selected.charge_amount) : ""}
                </td>
                <td style={{ padding: "4px 6px" }}>{selected.place_of_service ?? "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    );
  }, [selected]);

  const renderPreviewTab = useCallback(() => {
    if (!selected) return null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          type="button"
          onClick={() => void loadPreview(selected.id)}
          disabled={preview.loading}
          style={{
            alignSelf: "flex-start",
            padding: "4px 10px",
            fontSize: 12,
            border: "1px solid #CBD5E1",
            borderRadius: 4,
            background: "#F8FAFC",
            cursor: "pointer",
          }}
        >
          {preview.loading ? "Loading…" : preview.text ? "Reload preview" : "Load 837 preview"}
        </button>
        {preview.error ? (
          <div style={{ color: "#C53030", fontSize: 12 }}>{preview.error}</div>
        ) : null}
        {preview.text ? (
          <pre
            style={{
              margin: 0,
              padding: 8,
              background: "#0F172A",
              color: "#E2E8F0",
              fontFamily: "ui-monospace, monospace",
              fontSize: 11.5,
              borderRadius: 4,
              maxHeight: 360,
              overflow: "auto",
              whiteSpace: "pre",
            }}
          >
            {preview.text}
          </pre>
        ) : null}
      </div>
    );
  }, [selected, preview, loadPreview]);

  const detailTabs: DetailTab[] = useMemo(
    () => [
      { id: "preview", label: "Claim preview", render: renderClaimPreviewTab },
      { id: "checklist", label: "837P field checklist", render: renderChecklistTab },
      { id: "validation", label: "Provider/payer validation", render: renderValidationTab },
      { id: "dx", label: "Diagnosis pointers", render: renderDxPointersTab },
      { id: "lines", label: "Claim line details", render: renderLinesTab },
      { id: "x12", label: "Preview 837", render: renderPreviewTab },
    ],
    [
      renderClaimPreviewTab,
      renderChecklistTab,
      renderValidationTab,
      renderDxPointersTab,
      renderLinesTab,
      renderPreviewTab,
    ],
  );

  // ── Detail panel actions ────────────────────────────────────────────────
  const detailActions: PrimaryAction[] = useMemo(() => {
    if (!selected) return [];
    const acts: PrimaryAction[] = [
      {
        id: "generate",
        label: "Generate claim",
        variant: "primary",
        disabled: busy || selected.ready_status === "on_hold",
        onClick: () => void runAction(selected.id, "generate"),
      },
      {
        id: "add_to_batch",
        label: "Add to batch",
        disabled: busy || selected.ready_status === "on_hold",
        onClick: () => void runAction(selected.id, "add_to_batch"),
      },
      {
        id: "preview",
        label: "Preview 837",
        disabled: busy,
        onClick: () => void loadPreview(selected.id),
      },
      {
        id: "return",
        label: "Return to charge capture",
        variant: "danger",
        disabled: busy,
        onClick: () => {
          if (typeof window !== "undefined" &&
            !window.confirm("Move this claim back to Charge Capture? It will be re-editable as a draft.")) return;
          void runAction(selected.id, "return_to_charge_capture");
        },
      },
      {
        id: "hold",
        label: selected.ready_status === "on_hold" ? "Release hold" : "Hold claim",
        disabled: busy,
        onClick: () => {
          if (selected.ready_status === "on_hold") {
            void runAction(selected.id, "unhold");
            return;
          }
          const reason = (typeof window !== "undefined"
            ? window.prompt("Why is this claim being held?", holdReason || "")
            : "") ?? "";
          if (!reason.trim()) return;
          setHoldReason(reason.trim());
          void runAction(selected.id, "hold", reason.trim());
        },
      },
    ];
    return acts;
  }, [busy, selected, runAction, loadPreview, holdReason]);

  // ── Header actions: tab switcher + refresh + bulk batch ────────────────
  const headerActions: PrimaryAction[] = useMemo(() => {
    const acts: PrimaryAction[] = [
      ...TABS.map((t) => ({
        id: `tab-${t.id}`,
        label: `${t.label} (${applyTab(filteredAll, t.id).length})`,
        variant: t.id === activeTab ? ("primary" as const) : ("default" as const),
        onClick: () => setActiveTab(t.id),
      })),
    ];
    if (selectedIds.length > 0) {
      acts.push({
        id: "bulk-batch",
        label: `Generate batch (${selectedIds.length} · ${money(selectedTotal)})`,
        variant: "success",
        onClick: () => void runBulkBatch(),
        disabled: busy || selectionHasIneligible,
      });
      acts.push({
        id: "clear-selection",
        label: "Clear selection",
        onClick: () => setSelectedIds([]),
        disabled: busy,
      });
    }
    acts.push({
      id: "refresh",
      label: loading ? "Refreshing…" : "Refresh",
      onClick: () => setReloadKey((k) => k + 1),
      disabled: loading,
    });
    return acts;
  }, [
    filteredAll,
    activeTab,
    loading,
    selectedIds,
    selectedTotal,
    busy,
    selectionHasIneligible,
    runBulkBatch,
  ]);

  return (
    <WorkqueueShell<Item>
      title={queueDef?.title ?? "Ready to Generate"}
      description={queueDef?.description}
      headerActions={headerActions}
      summary={summary}
      filters={filters}
      filterValues={filterValues}
      onFilterChange={setFilterValues}
      filterUrlNamespace="rtg"
      rows={rows}
      columns={columns}
      rowId={(r) => r.id}
      loading={loading}
      emptyMessage="No claims in this view."
      selectedRowId={selectedId}
      onSelectRow={setSelectedId}
      selectedRowIds={selectedIds}
      onSelectionChange={setSelectedIds}
      rowActions={rowActions}
      detailTabs={detailTabs}
      detailActions={detailActions}
      message={message}
    />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "#64748B",
          letterSpacing: 0.4,
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 13 }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <span style={{ fontSize: 10.5, color: "#94A3B8", textTransform: "uppercase" }}>{label}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
