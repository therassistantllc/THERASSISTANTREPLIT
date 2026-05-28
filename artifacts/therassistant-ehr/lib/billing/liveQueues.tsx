/**
 * liveQueues.ts
 * ───────────────────────────────────────────────────────────────────────────
 * Per-queue data loaders for the 13 second-wave billing workqueues.
 *
 * Each entry exposes:
 *   - load():   fetch the queue's rows from the database, classify into
 *               tabs, and roll up a summary.
 *   - actions:  whitelist of action ids the queue accepts (action POSTs
 *               are recorded in `audit_logs` under `<prefix>_<action>`
 *               and a few set state on the underlying record).
 *
 * The audit-log-overlay pattern mirrors the existing cob-issues and
 * recoupments queues: a row's tab is derived from base data, optionally
 * overridden by the latest action stamped on the row.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type DbRow = Record<string, unknown>;

const txt = (v: unknown) => String(v ?? "").trim();
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const money = (v: unknown) => Math.round(num(v) * 100) / 100;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function agingBucket(days: number | null): "0_30" | "31_60" | "61_90" | "90_plus" {
  const d = days ?? 0;
  if (d <= 30) return "0_30";
  if (d <= 60) return "31_60";
  if (d <= 90) return "61_90";
  return "90_plus";
}

function priorityFor(days: number | null, amount: number): "low" | "medium" | "high" | "critical" {
  const d = days ?? 0;
  if (d >= 90 || amount >= 5000) return "critical";
  if (d >= 60 || amount >= 1000) return "high";
  if (d >= 30) return "medium";
  return "low";
}

// ── Filter helpers ─────────────────────────────────────────────────────────
export interface UniversalFilters {
  payer?: string;
  client?: string;
  dosFrom?: string;
  dosTo?: string;
  minAmount?: string;
  maxAmount?: string;
  agingBucket?: string;
  priority?: string;
}

export function readUniversalFilters(sp: URLSearchParams): UniversalFilters {
  return {
    payer: sp.get("payer") ?? undefined,
    client: sp.get("client") ?? undefined,
    dosFrom: sp.get("dosFrom") ?? undefined,
    dosTo: sp.get("dosTo") ?? undefined,
    minAmount: sp.get("minAmount") ?? undefined,
    maxAmount: sp.get("maxAmount") ?? undefined,
    agingBucket: sp.get("agingBucket") ?? undefined,
    priority: sp.get("priority") ?? undefined,
  };
}

interface BaseRow {
  id: string;
  tabs: string[];
  state: string;
  priority: "low" | "medium" | "high" | "critical";
  charge_amount: number;
  age_days: number | null;
  aging_bucket: string;
  // raw display fields (queue-specific)
  payer_name?: string | null;
  client_name?: string | null;
  client_id?: string | null;
  date_of_service?: string | null;
  [k: string]: unknown;
}

function applyUniversalFilter(rows: BaseRow[], f: UniversalFilters): BaseRow[] {
  return rows.filter((r) => {
    if (f.payer) {
      const p = (r.payer_name ?? "").toString().toLowerCase();
      if (!p.includes(f.payer.toLowerCase())) return false;
    }
    if (f.client) {
      const c = (r.client_name ?? "").toString().toLowerCase();
      if (!c.includes(f.client.toLowerCase())) return false;
    }
    if (f.dosFrom && r.date_of_service && r.date_of_service < f.dosFrom) return false;
    if (f.dosTo && r.date_of_service && r.date_of_service > f.dosTo) return false;
    if (f.minAmount && Number.isFinite(Number(f.minAmount))) {
      if (r.charge_amount < Number(f.minAmount)) return false;
    }
    if (f.maxAmount && Number.isFinite(Number(f.maxAmount))) {
      if (r.charge_amount > Number(f.maxAmount)) return false;
    }
    if (f.agingBucket && r.aging_bucket !== f.agingBucket) return false;
    if (f.priority && r.priority !== f.priority) return false;
    return true;
  });
}

export interface QueueLoadResult {
  items: BaseRow[];
  summary: {
    total_count: number;
    total_dollars: number;
    oldest_age_days: number | null;
    urgent_count: number;
    by_tab: Record<string, number>;
  };
}

function summarize(items: BaseRow[], tabIds: string[]): QueueLoadResult["summary"] {
  const by_tab: Record<string, number> = {};
  for (const t of tabIds) by_tab[t] = 0;
  let total_dollars = 0;
  let oldest_age_days: number | null = null;
  let urgent_count = 0;
  for (const r of items) {
    total_dollars += r.charge_amount;
    if (r.age_days != null) {
      if (oldest_age_days == null || r.age_days > oldest_age_days) {
        oldest_age_days = r.age_days;
      }
    }
    if (r.priority === "critical" || r.priority === "high") urgent_count += 1;
    for (const t of r.tabs) if (by_tab[t] != null) by_tab[t] += 1;
  }
  return {
    total_count: items.length,
    total_dollars: Math.round(total_dollars * 100) / 100,
    oldest_age_days,
    urgent_count,
    by_tab,
  };
}

// ── Per-queue loaders ──────────────────────────────────────────────────────

type Loader = (
  supabase: SupabaseClient,
  organizationId: string,
  tab: string,
  filters: UniversalFilters,
) => Promise<QueueLoadResult>;

const ACTION_PREFIX: Record<string, string> = {
  "payer-rejections": "pr",
  "resubmissions": "rs",
  "partial-denials": "pd",
  "adjustments-review": "ar",
  "medical-necessity": "mn",
  "unposted-payments": "up",
  "credit-balances": "cb",
  "reconciliation-exceptions": "re",
  "bad-debt-review": "bd",
  "write-offs": "wo",
  "audit-queue": "aq",
  "compliance-holds": "ch",
};

// Helper: pull audit overlay for a set of object ids, organized by id.
async function loadAuditOverlay(
  supabase: SupabaseClient,
  organizationId: string,
  endpoint: string,
  objectIds: string[],
): Promise<Map<string, { tab: string | null; lastAction: string | null }>> {
  const prefix = ACTION_PREFIX[endpoint];
  const out = new Map<string, { tab: string | null; lastAction: string | null }>();
  if (!prefix || objectIds.length === 0) return out;
  const { data } = await (supabase as unknown as { from: (t: string) => any })
    .from("audit_logs")
    .select("object_id, event_type, event_metadata, created_at")
    .eq("organization_id", organizationId)
    .in("object_id", objectIds)
    .ilike("event_type", `${prefix}_%`)
    .order("created_at", { ascending: true });
  for (const row of ((data ?? []) as DbRow[])) {
    const k = txt(row.object_id);
    if (!k) continue;
    const md = (row.event_metadata as Record<string, unknown> | null) ?? {};
    const tab = md.tab ? txt(md.tab) : null;
    out.set(k, {
      tab: tab || out.get(k)?.tab || null,
      lastAction: txt(row.event_type) || null,
    });
  }
  return out;
}

// ── Common claim hydration ─────────────────────────────────────────────────
interface ClaimCtx {
  claimsById: Map<string, DbRow>;
  payerById: Map<string, DbRow>;
  clientById: Map<string, DbRow>;
}

async function hydrateClaims(
  supabase: SupabaseClient,
  organizationId: string,
  claimIds: string[],
): Promise<ClaimCtx> {
  const empty: ClaimCtx = {
    claimsById: new Map(),
    payerById: new Map(),
    clientById: new Map(),
  };
  if (claimIds.length === 0) return empty;
  const sb = supabase as unknown as { from: (t: string) => any };
  const { data: claims } = await sb
    .from("professional_claims")
    .select(
      "id, claim_number, claim_status, total_charge, patient_id, payer_profile_id, created_at, first_billed_date, last_billed_date, denial_reason_code, denial_reason_description, billing_notes",
    )
    .eq("organization_id", organizationId)
    .in("id", claimIds);
  const claimRows = (claims ?? []) as DbRow[];
  const payerIds = [
    ...new Set(claimRows.map((c) => txt(c.payer_profile_id)).filter(Boolean)),
  ];
  const clientIds = [
    ...new Set(claimRows.map((c) => txt(c.patient_id)).filter(Boolean)),
  ];
  const [payers, clients] = await Promise.all([
    payerIds.length
      ? sb
          .from("payer_profiles")
          .select("id, payer_name, payer_type")
          .in("id", payerIds)
      : Promise.resolve({ data: [] }),
    clientIds.length
      ? sb
          .from("clients")
          .select("id, first_name, last_name")
          .in("id", clientIds)
      : Promise.resolve({ data: [] }),
  ]);
  return {
    claimsById: new Map(claimRows.map((c) => [txt(c.id), c])),
    payerById: new Map(((payers.data ?? []) as DbRow[]).map((p) => [txt(p.id), p])),
    clientById: new Map(((clients.data ?? []) as DbRow[]).map((c) => [txt(c.id), c])),
  };
}

function clientName(client: DbRow | undefined): string {
  if (!client) return "Unknown client";
  const f = txt(client.first_name);
  const l = txt(client.last_name);
  const name = `${f} ${l}`.trim();
  return name || "Unknown client";
}

// ── 1. payer-rejections ────────────────────────────────────────────────────
const loadPayerRejections: Loader = async (sb, orgId, tab, f) => {
  const lookback = new Date();
  lookback.setMonth(lookback.getMonth() - 6);
  const { data } = await (sb as any)
    .from("professional_claims")
    .select(
      "id, claim_number, claim_status, total_charge, patient_id, payer_profile_id, created_at, last_billed_date, denial_reason_code, denial_reason_description, updated_at",
    )
    .eq("organization_id", orgId)
    .in("claim_status", ["rejected_payer", "rejected_oa"])
    .gte("created_at", lookback.toISOString())
    .order("updated_at", { ascending: false })
    .limit(1000);
  const claims = (data ?? []) as DbRow[];
  const ctx = await hydrateClaims(sb, orgId, claims.map((c) => txt(c.id)));
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "payer-rejections",
    claims.map((c) => txt(c.id)),
  );
  const tabIds = ["new", "in_review", "fixed_pending", "resubmitted"];
  let rows: BaseRow[] = claims.map((c) => {
    const id = txt(c.id);
    const charge = money(c.total_charge);
    const received = txt(c.updated_at) || txt(c.created_at);
    const age = daysSince(received);
    const payer = ctx.payerById.get(txt(c.payer_profile_id));
    const client = ctx.clientById.get(txt(c.patient_id));
    const ov = overlay.get(id);
    const tabId = ov?.tab ?? "new";
    return {
      id,
      tabs: [tabId],
      state: tabId,
      charge_amount: charge,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, charge),
      claim_number: txt(c.claim_number) || id.slice(0, 8),
      client_id: txt(c.patient_id) || null,
      client_name: clientName(client),
      payer_name: payer ? txt(payer.payer_name) : null,
      reason:
        txt(c.denial_reason_description) ||
        txt(c.denial_reason_code) ||
        "Front-end rejection",
      reason_code: txt(c.denial_reason_code) || null,
      received_at: received || null,
      date_of_service: txt(c.last_billed_date) || null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 2. resubmissions ───────────────────────────────────────────────────────
const loadResubmissions: Loader = async (sb, orgId, tab, f) => {
  const lookback = new Date();
  lookback.setMonth(lookback.getMonth() - 6);
  const { data } = await (sb as any)
    .from("professional_claims")
    .select(
      "id, claim_number, claim_status, total_charge, patient_id, payer_profile_id, created_at, last_billed_date, denial_reason_code, denial_reason_description, updated_at, billing_notes",
    )
    .eq("organization_id", orgId)
    .in("claim_status", [
      "rejected_payer",
      "rejected_oa",
      "denied",
      "ready",
      "corrected_pending",
    ])
    .gte("created_at", lookback.toISOString())
    .order("updated_at", { ascending: false })
    .limit(1000);
  const claims = (data ?? []) as DbRow[];
  const ctx = await hydrateClaims(sb, orgId, claims.map((c) => txt(c.id)));
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "resubmissions",
    claims.map((c) => txt(c.id)),
  );
  const tabIds = ["ready", "queued", "submitted", "blocked"];
  let rows: BaseRow[] = claims.map((c) => {
    const id = txt(c.id);
    const charge = money(c.total_charge);
    const age = daysSince(txt(c.last_billed_date) || txt(c.created_at));
    const payer = ctx.payerById.get(txt(c.payer_profile_id));
    const client = ctx.clientById.get(txt(c.patient_id));
    const status = txt(c.claim_status);
    const ov = overlay.get(id);
    let tabId = ov?.tab ?? "ready";
    if (!ov && status === "ready") tabId = "queued";
    return {
      id,
      tabs: [tabId],
      state: tabId,
      charge_amount: charge,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, charge),
      claim_number: txt(c.claim_number) || id.slice(0, 8),
      client_id: txt(c.patient_id) || null,
      client_name: clientName(client),
      payer_name: payer ? txt(payer.payer_name) : null,
      frequency_code: "7",
      reason:
        txt(c.denial_reason_description) ||
        txt(c.denial_reason_code) ||
        "Corrected claim",
      date_of_service: txt(c.last_billed_date) || null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 3. partial-denials ─────────────────────────────────────────────────────
const loadPartialDenials: Loader = async (sb, orgId, tab, f) => {
  const { data } = await (sb as any)
    .from("era_claim_payments")
    .select(
      "id, professional_claim_id, client_id, clp01_claim_control_number, clp03_total_charge, clp04_payment_amount, carc_codes, rarc_codes, posting_status, claim_match_status, created_at, era_import_batch_id, check_issue_date",
    )
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(2000);
  const allPayments = (data ?? []) as DbRow[];
  const partials = allPayments.filter((p) => {
    const paid = num(p.clp04_payment_amount);
    const billed = num(p.clp03_total_charge);
    return paid > 0 && paid < billed;
  });
  const claimIds = [
    ...new Set(partials.map((p) => txt(p.professional_claim_id)).filter(Boolean)),
  ];
  const ctx = await hydrateClaims(sb, orgId, claimIds);
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "partial-denials",
    partials.map((p) => txt(p.id)),
  );
  const tabIds = ["open", "appealing", "recovered", "written_off"];
  let rows: BaseRow[] = partials.map((p) => {
    const id = txt(p.id);
    const claim = ctx.claimsById.get(txt(p.professional_claim_id));
    const client = ctx.clientById.get(txt(claim?.patient_id));
    const payer = ctx.payerById.get(txt(claim?.payer_profile_id));
    const billed = money(p.clp03_total_charge);
    const paid = money(p.clp04_payment_amount);
    const shortfall = Math.round((billed - paid) * 100) / 100;
    const checkDate = txt(p.check_issue_date) || txt(p.created_at);
    const age = daysSince(checkDate);
    const carc = Array.isArray(p.carc_codes) ? (p.carc_codes as string[]) : [];
    const rarc = Array.isArray(p.rarc_codes) ? (p.rarc_codes as string[]) : [];
    const ov = overlay.get(id);
    const tabId = ov?.tab ?? "open";
    return {
      id,
      tabs: [tabId],
      state: tabId,
      charge_amount: shortfall,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, shortfall),
      claim_id: txt(p.professional_claim_id) || null,
      claim_number: claim ? txt(claim.claim_number) : txt(p.clp01_claim_control_number),
      client_id: txt(claim?.patient_id) || null,
      client_name: clientName(client),
      payer_name: payer ? txt(payer.payer_name) : null,
      billed_amount: billed,
      paid_amount: paid,
      shortfall,
      carc: carc.join(", ") || "—",
      rarc: rarc.join(", ") || "—",
      date_of_service: txt(claim?.last_billed_date) || null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 4. adjustments-review ──────────────────────────────────────────────────
const loadAdjustmentsReview: Loader = async (sb, orgId, tab, f) => {
  const lookback = new Date();
  lookback.setMonth(lookback.getMonth() - 6);
  const { data } = await (sb as any)
    .from("payment_adjustments")
    .select(
      "id, professional_claim_id, client_id, adjustment_type, amount, group_code, reason_code, description, posted_at, posted_by_user_id, source, scope, created_at",
    )
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .gte("created_at", lookback.toISOString())
    .order("created_at", { ascending: false })
    .limit(2000);
  const adjustments = ((data ?? []) as DbRow[]).filter((a) => {
    // surface non-contractual, large, or interest/penalty adjustments
    const code = txt(a.group_code).toUpperCase();
    const amt = Math.abs(num(a.amount));
    if (code === "OA" || code === "PI") return true;       // other adjustments
    if (amt >= 100) return true;
    return false;
  });
  const claimIds = [
    ...new Set(adjustments.map((a) => txt(a.professional_claim_id)).filter(Boolean)),
  ];
  const ctx = await hydrateClaims(sb, orgId, claimIds);
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "adjustments-review",
    adjustments.map((a) => txt(a.id)),
  );
  const tabIds = ["needs_review", "approved", "reversed"];
  let rows: BaseRow[] = adjustments.map((a) => {
    const id = txt(a.id);
    const claim = ctx.claimsById.get(txt(a.professional_claim_id));
    const client = ctx.clientById.get(txt(claim?.patient_id));
    const payer = ctx.payerById.get(txt(claim?.payer_profile_id));
    const amount = money(a.amount);
    const postedAt = txt(a.posted_at) || txt(a.created_at);
    const age = daysSince(postedAt);
    const ov = overlay.get(id);
    const tabId = ov?.tab ?? "needs_review";
    return {
      id,
      tabs: [tabId],
      state: tabId,
      charge_amount: Math.abs(amount),
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, Math.abs(amount)),
      claim_id: txt(a.professional_claim_id) || null,
      claim_number: claim ? txt(claim.claim_number) : "—",
      client_id: txt(claim?.patient_id) || null,
      client_name: clientName(client),
      payer_name: payer ? txt(payer.payer_name) : null,
      adjustment_type: txt(a.adjustment_type) || "adjustment",
      group_reason: `${txt(a.group_code) || "—"} / ${txt(a.reason_code) || "—"}`,
      amount,
      posted_by: txt(a.posted_by_user_id) || txt(a.source) || "system",
      posted_at: postedAt || null,
      description: txt(a.description) || null,
      date_of_service: txt(claim?.last_billed_date) || null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 5. medical-necessity ───────────────────────────────────────────────────
const MED_NEC_CARC = new Set(["50", "11", "55", "167"]); // medical necessity / non-covered
const loadMedicalNecessity: Loader = async (sb, orgId, tab, f) => {
  const { data } = await (sb as any)
    .from("era_claim_payments")
    .select(
      "id, professional_claim_id, client_id, clp01_claim_control_number, clp03_total_charge, clp04_payment_amount, carc_codes, rarc_codes, created_at, check_issue_date",
    )
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(2000);
  const eras = ((data ?? []) as DbRow[]).filter((p) => {
    const carcs = Array.isArray(p.carc_codes) ? (p.carc_codes as string[]) : [];
    return carcs.some((c) => MED_NEC_CARC.has(String(c)));
  });
  const claimIds = [
    ...new Set(eras.map((p) => txt(p.professional_claim_id)).filter(Boolean)),
  ];
  const ctx = await hydrateClaims(sb, orgId, claimIds);
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "medical-necessity",
    eras.map((p) => txt(p.id)),
  );
  const tabIds = ["open", "records_gathered", "appeal_sent", "decided"];
  let rows: BaseRow[] = eras.map((p) => {
    const id = txt(p.id);
    const claim = ctx.claimsById.get(txt(p.professional_claim_id));
    const client = ctx.clientById.get(txt(claim?.patient_id));
    const payer = ctx.payerById.get(txt(claim?.payer_profile_id));
    const billed = money(p.clp03_total_charge);
    const carc = (Array.isArray(p.carc_codes) ? (p.carc_codes as string[]) : []).join(", ");
    const checkDate = txt(p.check_issue_date) || txt(p.created_at);
    const age = daysSince(checkDate);
    const ov = overlay.get(id);
    const tabId = ov?.tab ?? "open";
    return {
      id,
      tabs: [tabId],
      state: tabId,
      charge_amount: billed,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, billed),
      claim_id: txt(p.professional_claim_id) || null,
      claim_number: claim ? txt(claim.claim_number) : txt(p.clp01_claim_control_number),
      client_id: txt(claim?.patient_id) || null,
      client_name: clientName(client),
      payer_name: payer ? txt(payer.payer_name) : null,
      denial_code: carc || "—",
      diagnosis: Array.isArray(claim?.diagnosis_codes) && (claim?.diagnosis_codes as string[])[0]
        ? (claim?.diagnosis_codes as string[])[0]
        : "—",
      cpt: "—",
      date_of_service: txt(claim?.last_billed_date) || null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 6. unposted-payments ───────────────────────────────────────────────────
const loadUnpostedPayments: Loader = async (sb, orgId, tab, f) => {
  const lookback = new Date();
  lookback.setMonth(lookback.getMonth() - 6);
  const [eras, clients, vccs] = await Promise.all([
    (sb as any)
      .from("era_claim_payments")
      .select(
        "id, posting_status, claim_match_status, clp04_payment_amount, payer_trace_number, check_eft_number, created_at, check_issue_date, era_import_batch_id, professional_claim_id, client_id",
      )
      .eq("organization_id", orgId)
      .eq("posting_status", "unposted")
      .gte("created_at", lookback.toISOString())
      .limit(1000),
    (sb as any)
      .from("client_payments")
      .select(
        "id, amount, reference_number, payment_method, posting_status, posted_at, created_at, client_id, note",
      )
      .eq("organization_id", orgId)
      .eq("posting_status", "unposted")
      .gte("created_at", lookback.toISOString())
      .limit(1000),
    (sb as any)
      .from("vcc_payments")
      .select(
        "id, payment_amount, status, reference_number, payer_name, processed_at, created_at, client_id",
      )
      .eq("organization_id", orgId)
      .neq("status", "posted")
      .gte("created_at", lookback.toISOString())
      .limit(1000),
  ]);
  const tabIds = ["all", "ach", "check", "card", "client"];
  const overlayIds = [
    ...((eras.data ?? []) as DbRow[]).map((r) => txt(r.id)),
    ...((clients.data ?? []) as DbRow[]).map((r) => txt(r.id)),
    ...((vccs.data ?? []) as DbRow[]).map((r) => txt(r.id)),
  ];
  const overlay = await loadAuditOverlay(sb, orgId, "unposted-payments", overlayIds);

  const eraRows: BaseRow[] = ((eras.data ?? []) as DbRow[]).map((p) => {
    const id = txt(p.id);
    const amt = money(p.clp04_payment_amount);
    const received = txt(p.check_issue_date) || txt(p.created_at);
    const age = daysSince(received);
    const ov = overlay.get(id);
    return {
      id,
      tabs: ov?.tab ? [ov.tab, "all"] : ["ach", "all"],
      state: ov?.tab ?? "unposted",
      charge_amount: amt,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, amt),
      received_at: received || null,
      source: "ACH / ERA",
      reference: txt(p.check_eft_number) || txt(p.payer_trace_number) || "—",
      payer_name: null,
      client_name: null,
      amount: amt,
      assigned: null,
      status_label: "Unposted ERA",
      last_action: ov?.lastAction || null,
    };
  });

  const clientRows: BaseRow[] = ((clients.data ?? []) as DbRow[]).map((p) => {
    const id = txt(p.id);
    const amt = money(p.amount);
    const received = txt(p.posted_at) || txt(p.created_at);
    const age = daysSince(received);
    const ov = overlay.get(id);
    const method = txt(p.payment_method).toLowerCase();
    const inferred = method.includes("card") ? "card" : method.includes("check") ? "check" : "client";
    return {
      id,
      tabs: ov?.tab ? [ov.tab, "all"] : [inferred, "all"],
      state: ov?.tab ?? "unposted",
      charge_amount: amt,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, amt),
      received_at: received || null,
      source: `Client (${txt(p.payment_method) || "card"})`,
      reference: txt(p.reference_number) || "—",
      payer_name: null,
      client_name: null,
      amount: amt,
      assigned: null,
      status_label: "Unposted client payment",
      last_action: ov?.lastAction || null,
    };
  });

  const vccRows: BaseRow[] = ((vccs.data ?? []) as DbRow[]).map((p) => {
    const id = txt(p.id);
    const amt = money(p.payment_amount);
    const received = txt(p.processed_at) || txt(p.created_at);
    const age = daysSince(received);
    const ov = overlay.get(id);
    return {
      id,
      tabs: ov?.tab ? [ov.tab, "all"] : ["card", "all"],
      state: ov?.tab ?? "unposted",
      charge_amount: amt,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, amt),
      received_at: received || null,
      source: "VCC",
      reference: txt(p.reference_number) || "—",
      payer_name: txt(p.payer_name) || null,
      client_name: null,
      amount: amt,
      assigned: null,
      status_label: `VCC ${txt(p.status)}`,
      last_action: ov?.lastAction || null,
    };
  });

  let rows = [...eraRows, ...clientRows, ...vccRows];
  rows = applyUniversalFilter(rows, f);
  const inTab = tab && tab !== "all" ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 7. credit-balances ─────────────────────────────────────────────────────
const loadCreditBalances: Loader = async (sb, orgId, tab, f) => {
  const { data: balances } = await (sb as any)
    .from("patient_balances")
    .select(
      "id, client_id, current_balance, computed_at, last_payment_date, last_payment_amount",
    )
    .eq("organization_id", orgId)
    .lt("current_balance", 0)
    .limit(1000);
  const balRows = (balances ?? []) as DbRow[];
  const clientIds = [...new Set(balRows.map((b) => txt(b.client_id)).filter(Boolean))];
  const sb2 = sb as unknown as { from: (t: string) => any };
  const { data: clientRowsRaw } = clientIds.length
    ? await sb2.from("clients").select("id, first_name, last_name").in("id", clientIds)
    : { data: [] };
  const clientById = new Map(
    ((clientRowsRaw ?? []) as DbRow[]).map((c) => [txt(c.id), c]),
  );
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "credit-balances",
    balRows.map((b) => txt(b.id)),
  );
  const tabIds = ["client", "payer", "needs_refund", "transfer_pending", "resolved"];
  let rows: BaseRow[] = balRows.map((b) => {
    const id = txt(b.id);
    const credit = Math.abs(money(b.current_balance));
    const since = txt(b.last_payment_date) || txt(b.computed_at);
    const age = daysSince(since);
    const ov = overlay.get(id);
    const tabId = ov?.tab ?? (credit >= 25 ? "needs_refund" : "client");
    const tabs = ov?.tab ? [ov.tab] : ["client", tabId];
    const client = clientById.get(txt(b.client_id));
    return {
      id,
      tabs,
      state: tabId,
      charge_amount: credit,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, credit),
      client_id: txt(b.client_id) || null,
      holder: clientName(client),
      client_name: clientName(client),
      account: txt(b.client_id).slice(0, 8) || "—",
      balance: credit,
      since: since || null,
      proposed_action: credit >= 25 ? "Refund client" : "Apply to next visit",
      assigned: null,
      payer_name: null,
      date_of_service: null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 8. reconciliation-exceptions ───────────────────────────────────────────
const loadReconciliationExceptions: Loader = async (sb, orgId, tab, f) => {
  const lookback = new Date();
  lookback.setMonth(lookback.getMonth() - 3);
  const { data } = await (sb as any)
    .from("external_transactions")
    .select(
      "id, processing_status, error_class, error_description, payload_type, created_at, response_timestamp, source_object_id, payload_id",
    )
    .eq("organization_id", orgId)
    .in("processing_status", ["failed", "errored", "exception"])
    .gte("created_at", lookback.toISOString())
    .order("created_at", { ascending: false })
    .limit(1000);
  const txns = (data ?? []) as DbRow[];
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "reconciliation-exceptions",
    txns.map((t) => txt(t.id)),
  );
  const tabIds = ["open", "investigating", "resolved"];
  let rows: BaseRow[] = txns.map((t) => {
    const id = txt(t.id);
    const created = txt(t.created_at);
    const age = daysSince(created);
    const ov = overlay.get(id);
    const tabId = ov?.tab ?? "open";
    return {
      id,
      tabs: [tabId],
      state: tabId,
      charge_amount: 0,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, 0),
      deposit_date: created || null,
      bank_ref: txt(t.payload_id) || id.slice(0, 8),
      bank_amount: 0,
      ehr_amount: 0,
      variance: 0,
      exception_type: txt(t.error_class) || txt(t.payload_type) || "Exception",
      error_description: txt(t.error_description) || "—",
      assigned: null,
      payer_name: null,
      client_name: null,
      date_of_service: null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 9. bad-debt-review ─────────────────────────────────────────────────────
const loadBadDebtReview: Loader = async (sb, orgId, tab, f) => {
  const { data } = await (sb as any)
    .from("patient_balances")
    .select(
      "id, client_id, current_balance, balance_91_120, balance_120_plus, last_payment_date, last_statement_date, in_collections, computed_at",
    )
    .eq("organization_id", orgId)
    .gt("current_balance", 0)
    .or("balance_91_120.gt.0,balance_120_plus.gt.0,in_collections.eq.true")
    .limit(1000);
  const balRows = (data ?? []) as DbRow[];
  const clientIds = [...new Set(balRows.map((b) => txt(b.client_id)).filter(Boolean))];
  const { data: clientRowsRaw } = clientIds.length
    ? await (sb as any).from("clients").select("id, first_name, last_name").in("id", clientIds)
    : { data: [] };
  const clientById = new Map(((clientRowsRaw ?? []) as DbRow[]).map((c) => [txt(c.id), c]));
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "bad-debt-review",
    balRows.map((b) => txt(b.id)),
  );
  const tabIds = ["proposed", "approved", "denied", "written_off"];
  let rows: BaseRow[] = balRows.map((b) => {
    const id = txt(b.id);
    const bal = money(b.current_balance);
    const oldest = txt(b.last_statement_date) || txt(b.computed_at);
    const age = daysSince(oldest);
    const ov = overlay.get(id);
    const tabId = ov?.tab ?? "proposed";
    const client = clientById.get(txt(b.client_id));
    return {
      id,
      tabs: [tabId],
      state: tabId,
      charge_amount: bal,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, bal),
      client_id: txt(b.client_id) || null,
      client: clientName(client),
      client_name: clientName(client),
      guarantor: clientName(client),
      balance: bal,
      oldest_dos: oldest || null,
      statements_sent: 0,
      last_payment: txt(b.last_payment_date) || null,
      proposed_by: "system",
      supervisor: "—",
      payer_name: null,
      date_of_service: oldest || null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 10. write-offs ─────────────────────────────────────────────────────────
const loadWriteOffs: Loader = async (sb, orgId, tab, f) => {
  const lookback = new Date();
  lookback.setMonth(lookback.getMonth() - 6);
  const { data } = await (sb as any)
    .from("payment_adjustments")
    .select(
      "id, professional_claim_id, client_id, adjustment_type, amount, group_code, reason_code, description, posted_at, posted_by_user_id, source, created_at",
    )
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .gte("created_at", lookback.toISOString())
    .order("created_at", { ascending: false })
    .limit(2000);
  const adjustments = ((data ?? []) as DbRow[]).filter((a) => {
    const type = txt(a.adjustment_type).toLowerCase();
    const code = txt(a.group_code).toUpperCase();
    return (
      type.includes("write") ||
      type.includes("writeoff") ||
      code === "CO" ||
      code === "OA"
    );
  });
  const claimIds = [...new Set(adjustments.map((a) => txt(a.professional_claim_id)).filter(Boolean))];
  const ctx = await hydrateClaims(sb, orgId, claimIds);
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "write-offs",
    adjustments.map((a) => txt(a.id)),
  );
  const tabIds = ["recent", "reversals", "by_reason"];
  let rows: BaseRow[] = adjustments.map((a) => {
    const id = txt(a.id);
    const claim = ctx.claimsById.get(txt(a.professional_claim_id));
    const client = ctx.clientById.get(txt(claim?.patient_id));
    const payer = ctx.payerById.get(txt(claim?.payer_profile_id));
    const amount = money(a.amount);
    const postedAt = txt(a.posted_at) || txt(a.created_at);
    const age = daysSince(postedAt);
    const ov = overlay.get(id);
    const isReversal = num(a.amount) < 0;
    const tabId = ov?.tab ?? (isReversal ? "reversals" : "recent");
    const tabs = ov?.tab ? [ov.tab, "by_reason"] : [tabId, "by_reason"];
    return {
      id,
      tabs,
      state: tabId,
      charge_amount: Math.abs(amount),
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, Math.abs(amount)),
      date: postedAt || null,
      client: clientName(client),
      client_name: clientName(client),
      client_id: txt(claim?.patient_id) || null,
      claim_number: claim ? txt(claim.claim_number) : "—",
      payer_name: payer ? txt(payer.payer_name) : null,
      reason: txt(a.description) || `${txt(a.group_code)}/${txt(a.reason_code)}`,
      amount,
      posted_by: txt(a.posted_by_user_id) || txt(a.source) || "system",
      approved_by: ov?.lastAction?.includes("approve") ? "supervisor" : "—",
      date_of_service: txt(claim?.last_billed_date) || null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 11. audit-queue ────────────────────────────────────────────────────────
const loadAuditQueue: Loader = async (sb, orgId, tab, f) => {
  const lookback = new Date();
  lookback.setMonth(lookback.getMonth() - 6);
  // Selected claims = top-charge claims OR claims with billing_alerts of high severity
  const { data: alerts } = await (sb as any)
    .from("billing_alerts")
    .select("id, claim_id, severity, title, status, created_at")
    .eq("organization_id", orgId)
    .in("severity", ["high", "critical"])
    .gte("created_at", lookback.toISOString())
    .order("created_at", { ascending: false })
    .limit(500);
  const alertRows = (alerts ?? []) as DbRow[];
  const claimIds = [...new Set(alertRows.map((a) => txt(a.claim_id)).filter(Boolean))];
  const ctx = await hydrateClaims(sb, orgId, claimIds);
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "audit-queue",
    alertRows.map((a) => txt(a.id)),
  );
  const tabIds = ["pre_bill", "post_payment", "in_progress", "complete"];
  let rows: BaseRow[] = alertRows.map((a) => {
    const id = txt(a.id);
    const claim = ctx.claimsById.get(txt(a.claim_id));
    const client = ctx.clientById.get(txt(claim?.patient_id));
    const payer = ctx.payerById.get(txt(claim?.payer_profile_id));
    const charge = money(claim?.total_charge);
    const created = txt(a.created_at);
    const age = daysSince(created);
    const claimStatus = txt(claim?.claim_status);
    const ov = overlay.get(id);
    const tabId =
      ov?.tab ??
      (claimStatus === "paid" || claimStatus === "denied"
        ? "post_payment"
        : "pre_bill");
    return {
      id,
      tabs: [tabId],
      state: tabId,
      charge_amount: charge,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, charge),
      selected_on: created || null,
      claim_id: txt(a.claim_id) || null,
      claim_number: claim ? txt(claim.claim_number) : "—",
      client_id: txt(claim?.patient_id) || null,
      client_name: clientName(client),
      payer_name: payer ? txt(payer.payer_name) : null,
      audit_type: txt(a.title) || "Selected for audit",
      auditor: "Unassigned",
      date_of_service: txt(claim?.last_billed_date) || null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── 12. compliance-holds ───────────────────────────────────────────────────
const loadComplianceHolds: Loader = async (sb, orgId, tab, f) => {
  const lookback = new Date();
  lookback.setMonth(lookback.getMonth() - 12);
  const { data } = await (sb as any)
    .from("professional_claims")
    .select(
      "id, claim_number, claim_status, total_charge, patient_id, payer_profile_id, created_at, last_billed_date, billing_notes, updated_at",
    )
    .eq("organization_id", orgId)
    .in("claim_status", ["held", "compliance_hold", "on_hold"])
    .gte("created_at", lookback.toISOString())
    .order("updated_at", { ascending: false })
    .limit(1000);
  const allHeld = (data ?? []) as DbRow[];
  // narrow to compliance-flavored holds via note prefix when present;
  // include all held claims as a fallback so the queue has something to work.
  const held = allHeld.filter((c) => {
    const notes = txt(c.billing_notes).toLowerCase();
    return notes.includes("compliance") || notes.includes("sanction") || allHeld.length < 50;
  });
  const ctx = await hydrateClaims(sb, orgId, held.map((c) => txt(c.id)));
  const overlay = await loadAuditOverlay(
    sb,
    orgId,
    "compliance-holds",
    held.map((c) => txt(c.id)),
  );
  const tabIds = ["active", "under_review", "released"];
  let rows: BaseRow[] = held.map((c) => {
    const id = txt(c.id);
    const charge = money(c.total_charge);
    const placed = txt(c.updated_at) || txt(c.created_at);
    const age = daysSince(placed);
    const payer = ctx.payerById.get(txt(c.payer_profile_id));
    const client = ctx.clientById.get(txt(c.patient_id));
    const ov = overlay.get(id);
    const tabId = ov?.tab ?? "active";
    return {
      id,
      tabs: [tabId],
      state: tabId,
      charge_amount: charge,
      age_days: age,
      aging_bucket: agingBucket(age),
      priority: priorityFor(age, charge),
      placed: placed || null,
      claim_number: txt(c.claim_number) || id.slice(0, 8),
      client_id: txt(c.patient_id) || null,
      client_name: clientName(client),
      provider: "—",
      reason: txt(c.billing_notes) || "Compliance hold",
      placed_by: "compliance",
      payer_name: payer ? txt(payer.payer_name) : null,
      date_of_service: txt(c.last_billed_date) || null,
      last_action: ov?.lastAction || null,
    };
  });
  rows = applyUniversalFilter(rows, f);
  const inTab = tab ? rows.filter((r) => r.tabs.includes(tab)) : rows;
  return { items: inTab, summary: summarize(rows, tabIds) };
};

// ── Registry ───────────────────────────────────────────────────────────────
export const LIVE_QUEUE_LOADERS: Record<string, Loader> = {
  "payer-rejections": loadPayerRejections,
  "resubmissions": loadResubmissions,
  "partial-denials": loadPartialDenials,
  "adjustments-review": loadAdjustmentsReview,
  "medical-necessity": loadMedicalNecessity,
  "unposted-payments": loadUnpostedPayments,
  "credit-balances": loadCreditBalances,
  "reconciliation-exceptions": loadReconciliationExceptions,
  "bad-debt-review": loadBadDebtReview,
  "write-offs": loadWriteOffs,
  "audit-queue": loadAuditQueue,
  "compliance-holds": loadComplianceHolds,
};

// ── Action whitelist + tab mapping ─────────────────────────────────────────
// Each action sets the row's tab (used by the loader's audit overlay).
export const LIVE_QUEUE_ACTIONS: Record<string, Record<string, string>> = {
  "payer-rejections": {
    start_review: "in_review",
    mark_fixed: "fixed_pending",
    mark_resubmitted: "resubmitted",
    reopen: "new",
  },
  "resubmissions": {
    queue_for_batch: "queued",
    mark_submitted: "submitted",
    block: "blocked",
    reopen: "ready",
  },
  "partial-denials": {
    appeal: "appealing",
    mark_recovered: "recovered",
    write_off: "written_off",
    reopen: "open",
  },
  "adjustments-review": {
    approve: "approved",
    reverse: "reversed",
    reopen: "needs_review",
  },
  "medical-necessity": {
    gather_records: "records_gathered",
    send_appeal: "appeal_sent",
    decide: "decided",
    reopen: "open",
  },
  "unposted-payments": {
    assign: "all",
    post_to_claim: "all",
    return_to_payer: "all",
  },
  "credit-balances": {
    propose_refund: "needs_refund",
    transfer: "transfer_pending",
    resolve: "resolved",
    reopen: "client",
  },
  "reconciliation-exceptions": {
    investigate: "investigating",
    resolve: "resolved",
    reopen: "open",
  },
  "bad-debt-review": {
    approve: "approved",
    deny: "denied",
    mark_written_off: "written_off",
    reopen: "proposed",
  },
  "write-offs": {
    flag_for_audit: "recent",
    mark_reversal: "reversals",
  },
  "audit-queue": {
    start_audit: "in_progress",
    complete_audit: "complete",
    reopen: "pre_bill",
  },
  "compliance-holds": {
    start_review: "under_review",
    release: "released",
    reopen: "active",
  },
};


// ── Generic action recorder (atomic via Postgres RPC) ──────────────────────
/**
 * The 12 second-wave billing workqueues all funnel row actions through this
 * function. Both the underlying-record mutation (claim_status flip, adjustment
 * row insert, refund row insert, alert resolve, …) AND the audit_logs overlay
 * stamp must happen in the SAME Postgres transaction — otherwise a failure
 * after the mutation can leave history out of sync with state, or vice versa.
 *
 * Atomicity is enforced by the `record_queue_action_atomic` SQL function
 * (see supabase/migrations/20260617000000_record_queue_action_atomic.sql),
 * which wraps both writes in a single PL/pgSQL body and raises on any
 * sub-step failure — so partial writes cannot occur.
 */
export async function recordQueueAction(
  endpoint: string,
  organizationId: string,
  rowId: string,
  action: string,
  userId: string | null,
  extras: Record<string, unknown>,
): Promise<{ ok: true; mutation: Record<string, unknown> | null } | { ok: false; error: string; status: number }> {
  const prefix = ACTION_PREFIX[endpoint];
  if (!prefix) return { ok: false, error: "Unknown queue", status: 400 };
  const targetTab = LIVE_QUEUE_ACTIONS[endpoint]?.[action];
  if (targetTab === undefined) {
    return { ok: false, error: `Unsupported action "${action}"`, status: 400 };
  }
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, error: "Database unavailable", status: 500 };

  const eventType = `${prefix}_${action}`;
  const eventSummary = `${endpoint} → ${action}`;

  const { data, error } = await (supabase as any).rpc("record_queue_action_atomic", {
    p_organization_id: organizationId,
    p_endpoint: endpoint,
    p_action: action,
    p_row_id: rowId,
    p_user_id: userId,
    p_extras: extras ?? {},
    p_target_tab: targetTab,
    p_event_type: eventType,
    p_event_summary: eventSummary,
  });

  if (error) {
    const msg = String(error.message || "queue action failed");
    // Postgres no-data ('P0002') → 404 so the route returns the right status.
    const status = error.code === "P0002" ? 404 : 400;
    return { ok: false, error: msg, status };
  }
  const mutation = (data && typeof data === "object" && "mutation" in data)
    ? ((data as any).mutation ?? null)
    : null;
  return { ok: true, mutation };
}

// ── Undo dispatcher ────────────────────────────────────────────────────────
/**
 * Reverse the most recent action recorded on `<endpoint>:<rowId>`. The SQL
 * function (`undo_queue_action_atomic`) finds the latest `<prefix>_*` audit
 * row, applies the inverse mutation (restore captured `previous_patch`,
 * archive an inserted adjustment / cancel an inserted refund, or un-link a
 * reversal pair), and stamps a `<prefix>_undo` audit_logs entry — all in a
 * single transaction. It refuses (raises 22023) when a downstream action
 * (refund issued, reversal already archived, claim status drifted) would
 * make the undo unsafe.
 */
export async function undoQueueAction(
  endpoint: string,
  organizationId: string,
  rowId: string,
  userId: string | null,
): Promise<
  | { ok: true; mutation: Record<string, unknown> | null; undoneEventType: string | null; tab: string | null }
  | { ok: false; error: string; status: number }
> {
  const prefix = ACTION_PREFIX[endpoint];
  if (!prefix) return { ok: false, error: "Unknown queue", status: 400 };
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, error: "Database unavailable", status: 500 };

  const { data, error } = await (supabase as any).rpc("undo_queue_action_atomic", {
    p_organization_id: organizationId,
    p_endpoint: endpoint,
    p_row_id: rowId,
    p_user_id: userId,
  });
  if (error) {
    const msg = String(error.message || "undo failed");
    const status = error.code === "P0002" ? 404 : 400;
    return { ok: false, error: msg, status };
  }
  const obj = (data && typeof data === "object") ? (data as any) : {};
  return {
    ok: true,
    mutation: obj.mutation ?? null,
    undoneEventType: obj.undone_event_type ?? null,
    tab: obj.tab ?? null,
  };
}
