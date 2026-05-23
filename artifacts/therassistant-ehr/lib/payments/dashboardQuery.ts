/**
 * Payment Posting — master dashboard query layer (Task #111 / PP-5).
 *
 * One typed `queryPaymentsDashboard(filters)` returns:
 *   - rows: unified list of ERA / manual_insurance / patient payments
 *   - totals: imported, posted, unmatched, unapplied, denied, recoupments,
 *             refunds, pending_review (filter-aware)
 *   - filters: echo of the active filter set
 *
 * Rows use the same composite-id scheme as the posted-payment detail page
 * (`era:|cp:|mi:<uuid>`) so the row→detail navigation is consistent.
 *
 * IMPORTANT: this is a UI-facing query — every Supabase call is scoped to
 * the requested organization_id by an explicit `.eq("organization_id", …)`
 * predicate. The caller is responsible for the org-binding check (see
 * `requireAuthenticatedPaymentPoster`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type PaymentSource = "era" | "manual_insurance" | "patient";

export interface DashboardFilters {
  organizationId: string;
  payerProfileId?: string | null;
  providerNpi?: string | null;
  clientId?: string | null;
  /** One or many payment sources. Empty/undefined = all sources. */
  paymentSource?: PaymentSource[] | null;
  /** Filter by side of the ledger. */
  paymentType?: "insurance" | "patient" | null;
  postingStatus?: string[] | null;
  /** Deposit date = payer-side received date (era.received_date, manual.posted_at). */
  depositDateFrom?: string | null;
  depositDateTo?: string | null;
  /** Payment date = ledger-effective date. */
  paymentDateFrom?: string | null;
  paymentDateTo?: string | null;
  eftCheckNumber?: string | null;
  eraImportDateFrom?: string | null;
  eraImportDateTo?: string | null;
  limit?: number | null;
  offset?: number | null;
}

interface DashboardRow {
  /** Composite id `era:|cp:|mi:<uuid>` matching the posted-payment detail. */
  id: string;
  source: PaymentSource;
  paymentType: "insurance" | "patient";
  postingStatus: string;
  /** ERA-only; "matched" | "unmatched" | "review" | null for non-ERA. */
  claimMatchStatus: string | null;
  payerName: string | null;
  clientId: string | null;
  clientDisplayName: string | null;
  professionalClaimId: string | null;
  checkNumber: string | null;
  amount: number;
  depositDate: string | null;
  paymentDate: string | null;
  importedAt: string | null;
  /**
   * Remaining recoupable balance for ERA-835 and client_payment sources
   * (amount - prior recoups - prior non-cancelled refunds). `null` for
   * manual_insurance (recoupments don't apply) and for non-posted rows.
   * Drives the Record-Recoupment action visibility in the dashboard UI.
   */
  remainingRecoupable: number | null;
}

interface DashboardTotals {
  imported: number;
  posted: number;
  unmatched: number;
  unapplied: number;
  denied: number;
  recoupments: number;
  refunds: number;
  pendingReview: number;
  amountPosted: number;
  amountPending: number;
}

export interface DashboardResult {
  rows: DashboardRow[];
  totals: DashboardTotals;
  filters: DashboardFilters;
  rowCount: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Pre-resolve provider NPI → list of professional_claim ids in this org.
 * Returns null when no provider filter is active (caller should skip the
 * predicate entirely). Returns empty array when the filter is active but
 * no claims match — callers should use that to short-circuit row loads.
 */
async function resolveProviderClaimIds(
  supabase: SupabaseClient,
  organizationId: string,
  providerNpi: string | null | undefined,
): Promise<string[] | null> {
  if (!providerNpi || !providerNpi.trim()) return null;
  try {
    const { data } = await supabase
      .from("professional_claims")
      .select("id")
      .eq("organization_id", organizationId)
      .or(
        `rendering_provider_npi.eq.${providerNpi},billing_provider_npi.eq.${providerNpi}`,
      )
      .limit(5000);
    return (data ?? []).map((r) => String((r as { id: string }).id));
  } catch {
    return [];
  }
}

function clampLimit(n: number | null | undefined): number {
  const v = Number(n ?? DEFAULT_LIMIT);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(v)));
}

function wantSource(filters: DashboardFilters, src: PaymentSource): boolean {
  if (filters.paymentType === "insurance" && src === "patient") return false;
  if (filters.paymentType === "patient" && src !== "patient") return false;
  const list = filters.paymentSource;
  if (!list || list.length === 0) return true;
  return list.includes(src);
}

// ── ERA rows ────────────────────────────────────────────────────────────────

/**
 * For correct global pagination across 3 union'd sources we must fetch
 * `offset + limit` rows from each source (the merged page can draw any
 * subset of those rows after sorting). Without this, a single-source
 * dataset >limit rows truncates and the export pager returns empty
 * pages past the first.
 */
function pageSize(filters: DashboardFilters): number {
  const lim = clampLimit(filters.limit);
  const off = Math.max(0, Math.floor(Number(filters.offset ?? 0)) || 0);
  return Math.min(MAX_LIMIT * 50, off + lim);
}

async function loadEraRows(
  supabase: SupabaseClient,
  filters: DashboardFilters,
  providerClaimIds: string[] | null,
): Promise<DashboardRow[]> {
  if (!wantSource(filters, "era")) return [];
  // Provider filter is active but no claim ids matched → short-circuit.
  if (providerClaimIds && providerClaimIds.length === 0) return [];
  let q = supabase
    .from("era_claim_payments")
    .select(
      "id, organization_id, client_id, professional_claim_id, payer_name, payer_identifier, posting_status, claim_match_status, clp04_payment_amount, check_number, era_import_batch_id, created_at, era_received_date, era_import_batches(received_at)",
    )
    .eq("organization_id", filters.organizationId)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(pageSize(filters));
  if (filters.clientId) q = q.eq("client_id", filters.clientId);
  if (providerClaimIds) q = q.in("professional_claim_id", providerClaimIds);
  // Payer filter parity: ERA carries payer_identifier (X12 payer key);
  // we also accept payer_profile_id matches in case the org's payer
  // profile id was mirrored into the identifier column.
  if (filters.payerProfileId) q = q.eq("payer_identifier", filters.payerProfileId);
  if (filters.postingStatus && filters.postingStatus.length > 0) {
    q = q.in("posting_status", filters.postingStatus);
  }
  if (filters.eftCheckNumber) q = q.ilike("check_number", `%${filters.eftCheckNumber}%`);
  if (filters.depositDateFrom) q = q.gte("era_received_date", filters.depositDateFrom);
  if (filters.depositDateTo) q = q.lte("era_received_date", filters.depositDateTo);
  if (filters.paymentDateFrom) q = q.gte("created_at", filters.paymentDateFrom);
  if (filters.paymentDateTo) q = q.lte("created_at", filters.paymentDateTo);
  if (filters.eraImportDateFrom) q = q.gte("created_at", filters.eraImportDateFrom);
  if (filters.eraImportDateTo) q = q.lte("created_at", filters.eraImportDateTo);

  const { data, error } = await q;
  if (error) {
    // tolerate missing era_received_date / payer_name columns by retrying once with a slim select
    if (/era_received_date|payer_name|payer_identifier|check_number/.test(error.message)) {
      const slim = await supabase
        .from("era_claim_payments")
        .select(
          "id, organization_id, client_id, professional_claim_id, posting_status, claim_match_status, clp04_payment_amount, era_import_batch_id, created_at",
        )
        .eq("organization_id", filters.organizationId)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(clampLimit(filters.limit));
      if (slim.error) return [];
      return (slim.data ?? []).map((r) => mapEraRow(r as Record<string, unknown>));
    }
    return [];
  }
  return (data ?? []).map((r) => mapEraRow(r as Record<string, unknown>));
}

function mapEraRow(r: Record<string, unknown>): DashboardRow {
  const batch = r["era_import_batches"] as { received_at?: string | null } | null | undefined;
  return {
    id: `era:${String(r["id"] ?? "")}`,
    source: "era",
    paymentType: "insurance",
    postingStatus: String(r["posting_status"] ?? "pending"),
    claimMatchStatus: (r["claim_match_status"] as string | null) ?? null,
    payerName: (r["payer_name"] as string | null) ?? null,
    clientId: (r["client_id"] as string | null) ?? null,
    clientDisplayName: null,
    professionalClaimId: (r["professional_claim_id"] as string | null) ?? null,
    checkNumber: (r["check_number"] as string | null) ?? null,
    amount: Number(r["clp04_payment_amount"] ?? 0),
    depositDate:
      (r["era_received_date"] as string | null) ?? batch?.received_at ?? null,
    paymentDate: (r["created_at"] as string | null) ?? null,
    importedAt: batch?.received_at ?? (r["created_at"] as string | null) ?? null,
    remainingRecoupable: null,
  };
}

// ── manual insurance rows ───────────────────────────────────────────────────

async function loadManualRows(
  supabase: SupabaseClient,
  filters: DashboardFilters,
  providerClaimIds: string[] | null,
): Promise<DashboardRow[]> {
  if (!wantSource(filters, "manual_insurance")) return [];
  if (providerClaimIds && providerClaimIds.length === 0) return [];
  // Manual rows are always "posted" the moment they're inserted (there's
  // no staged/unmatched intermediate state). If the caller restricts
  // postingStatus to anything that excludes 'posted', no manual rows
  // can match by definition.
  if (
    filters.postingStatus &&
    filters.postingStatus.length > 0 &&
    !filters.postingStatus.includes("posted")
  ) {
    return [];
  }
  let q = supabase
    .from("insurance_manual_payments")
    .select(
      "id, organization_id, client_id, claim_id, paid_amount, posted_at, created_at, eob_reference, payer_profile_id, archived_at",
    )
    .eq("organization_id", filters.organizationId)
    .is("archived_at", null)
    .order("posted_at", { ascending: false })
    .limit(pageSize(filters));
  if (filters.clientId) q = q.eq("client_id", filters.clientId);
  if (filters.payerProfileId) q = q.eq("payer_profile_id", filters.payerProfileId);
  if (providerClaimIds) q = q.in("claim_id", providerClaimIds);
  if (filters.eftCheckNumber) q = q.ilike("eob_reference", `%${filters.eftCheckNumber}%`);
  if (filters.depositDateFrom) q = q.gte("posted_at", filters.depositDateFrom);
  if (filters.depositDateTo) q = q.lte("posted_at", filters.depositDateTo);
  if (filters.paymentDateFrom) q = q.gte("posted_at", filters.paymentDateFrom);
  if (filters.paymentDateTo) q = q.lte("posted_at", filters.paymentDateTo);

  const { data, error } = await q;
  if (error) {
    if (/payer_profile_id|eob_reference|posting_status/.test(error.message)) {
      const slim = await supabase
        .from("insurance_manual_payments")
        .select("id, organization_id, client_id, claim_id, paid_amount, posted_at, created_at")
        .eq("organization_id", filters.organizationId)
        .is("archived_at", null)
        .order("posted_at", { ascending: false })
        .limit(clampLimit(filters.limit));
      if (slim.error) return [];
      return (slim.data ?? []).map((r) => mapManualRow(r as Record<string, unknown>));
    }
    return [];
  }
  return (data ?? []).map((r) => mapManualRow(r as Record<string, unknown>));
}

function mapManualRow(r: Record<string, unknown>): DashboardRow {
  return {
    id: `mi:${String(r["id"] ?? "")}`,
    source: "manual_insurance",
    paymentType: "insurance",
    postingStatus: "posted",
    claimMatchStatus: null,
    payerName: null,
    clientId: (r["client_id"] as string | null) ?? null,
    clientDisplayName: null,
    professionalClaimId: (r["claim_id"] as string | null) ?? null,
    checkNumber: (r["eob_reference"] as string | null) ?? null,
    amount: Number(r["paid_amount"] ?? 0),
    depositDate: (r["posted_at"] as string | null) ?? null,
    paymentDate: (r["posted_at"] as string | null) ?? null,
    importedAt: (r["created_at"] as string | null) ?? null,
    remainingRecoupable: null,
  };
}

// ── patient payment rows ────────────────────────────────────────────────────

async function loadPatientRows(
  supabase: SupabaseClient,
  filters: DashboardFilters,
  providerClaimIds: string[] | null,
): Promise<DashboardRow[]> {
  if (!wantSource(filters, "patient")) return [];
  if (providerClaimIds && providerClaimIds.length === 0) return [];
  let q = supabase
    .from("client_payments")
    .select(
      "id, organization_id, client_id, claim_id, amount, payment_method, reference_number, posted_at, created_at, posting_status",
    )
    .eq("organization_id", filters.organizationId)
    .is("archived_at", null)
    .order("posted_at", { ascending: false })
    .limit(pageSize(filters));
  if (filters.clientId) q = q.eq("client_id", filters.clientId);
  if (providerClaimIds) q = q.in("claim_id", providerClaimIds);
  if (filters.eftCheckNumber) q = q.ilike("reference_number", `%${filters.eftCheckNumber}%`);
  if (filters.postingStatus && filters.postingStatus.length > 0) {
    q = q.in("posting_status", filters.postingStatus);
  }
  if (filters.depositDateFrom) q = q.gte("posted_at", filters.depositDateFrom);
  if (filters.depositDateTo) q = q.lte("posted_at", filters.depositDateTo);
  if (filters.paymentDateFrom) q = q.gte("posted_at", filters.paymentDateFrom);
  if (filters.paymentDateTo) q = q.lte("posted_at", filters.paymentDateTo);

  const { data, error } = await q;
  if (error) {
    if (/posting_status|reference_number/.test(error.message)) {
      const slim = await supabase
        .from("client_payments")
        .select("id, organization_id, client_id, claim_id, amount, payment_method, posted_at, created_at")
        .eq("organization_id", filters.organizationId)
        .is("archived_at", null)
        .order("posted_at", { ascending: false })
        .limit(clampLimit(filters.limit));
      if (slim.error) return [];
      return (slim.data ?? []).map((r) => mapPatientRow(r as Record<string, unknown>));
    }
    return [];
  }
  return (data ?? []).map((r) => mapPatientRow(r as Record<string, unknown>));
}

function mapPatientRow(r: Record<string, unknown>): DashboardRow {
  return {
    id: `cp:${String(r["id"] ?? "")}`,
    source: "patient",
    paymentType: "patient",
    postingStatus: String(r["posting_status"] ?? "posted"),
    claimMatchStatus: null,
    payerName: (r["payment_method"] as string | null) ?? null,
    clientId: (r["client_id"] as string | null) ?? null,
    clientDisplayName: null,
    professionalClaimId: (r["claim_id"] as string | null) ?? null,
    checkNumber: (r["reference_number"] as string | null) ?? null,
    amount: Number(r["amount"] ?? 0),
    depositDate: (r["posted_at"] as string | null) ?? null,
    paymentDate: (r["posted_at"] as string | null) ?? null,
    importedAt: (r["created_at"] as string | null) ?? null,
    remainingRecoupable: null,
  };
}

/**
 * Annotate posted ERA / client_payment rows with the per-row remaining
 * recoupable balance so the dashboard UI can hide the Record-Recoupment
 * action when nothing is left to take back. Manual-insurance rows never
 * carry recoupments, so they stay `null`. Aggregates payment_recoupments
 * + non-cancelled payment_refunds keyed on the source-payment id.
 */
async function annotateRemainingRecoupable(
  supabase: SupabaseClient,
  organizationId: string,
  rows: DashboardRow[],
): Promise<void> {
  const eraIds: string[] = [];
  const cpIds: string[] = [];
  for (const r of rows) {
    if (r.postingStatus !== "posted") continue;
    if (r.source === "era") eraIds.push(r.id.slice(4));
    else if (r.source === "patient") cpIds.push(r.id.slice(3));
  }
  if (eraIds.length === 0 && cpIds.length === 0) return;

  const sumByKey = (
    rows: Array<Record<string, unknown>>,
    key: string,
  ): Map<string, number> => {
    const out = new Map<string, number>();
    for (const r of rows) {
      const id = String(r[key] ?? "");
      if (!id) continue;
      const amt = Number(r["amount"] ?? 0);
      if (!Number.isFinite(amt)) continue;
      out.set(id, (out.get(id) ?? 0) + amt);
    }
    return out;
  };

  const queries: Array<Promise<{ data?: Array<Record<string, unknown>> | null }>> = [];
  if (eraIds.length > 0) {
    queries.push(
      supabase
        .from("payment_recoupments")
        .select("source_era_claim_payment_id, amount")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .in("source_era_claim_payment_id", eraIds) as unknown as Promise<{
        data?: Array<Record<string, unknown>> | null;
      }>,
      supabase
        .from("payment_refunds")
        .select("source_era_claim_payment_id, amount, refund_status")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .neq("refund_status", "cancelled")
        .in("source_era_claim_payment_id", eraIds) as unknown as Promise<{
        data?: Array<Record<string, unknown>> | null;
      }>,
    );
  } else {
    queries.push(Promise.resolve({ data: [] }), Promise.resolve({ data: [] }));
  }
  if (cpIds.length > 0) {
    queries.push(
      supabase
        .from("payment_recoupments")
        .select("source_client_payment_id, amount")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .in("source_client_payment_id", cpIds) as unknown as Promise<{
        data?: Array<Record<string, unknown>> | null;
      }>,
      supabase
        .from("payment_refunds")
        .select("source_client_payment_id, amount, refund_status")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .neq("refund_status", "cancelled")
        .in("source_client_payment_id", cpIds) as unknown as Promise<{
        data?: Array<Record<string, unknown>> | null;
      }>,
    );
  } else {
    queries.push(Promise.resolve({ data: [] }), Promise.resolve({ data: [] }));
  }

  try {
    const [eraRecoups, eraRefunds, cpRecoups, cpRefunds] = await Promise.all(queries);
    const eraRecoupSum = sumByKey(
      (eraRecoups.data ?? []) as Array<Record<string, unknown>>,
      "source_era_claim_payment_id",
    );
    const eraRefundSum = sumByKey(
      (eraRefunds.data ?? []) as Array<Record<string, unknown>>,
      "source_era_claim_payment_id",
    );
    const cpRecoupSum = sumByKey(
      (cpRecoups.data ?? []) as Array<Record<string, unknown>>,
      "source_client_payment_id",
    );
    const cpRefundSum = sumByKey(
      (cpRefunds.data ?? []) as Array<Record<string, unknown>>,
      "source_client_payment_id",
    );

    for (const r of rows) {
      if (r.postingStatus !== "posted") continue;
      if (r.source === "era") {
        const id = r.id.slice(4);
        const used = (eraRecoupSum.get(id) ?? 0) + (eraRefundSum.get(id) ?? 0);
        r.remainingRecoupable = Math.max(
          0,
          Math.round((Number(r.amount ?? 0) - used) * 100) / 100,
        );
      } else if (r.source === "patient") {
        const id = r.id.slice(3);
        const used = (cpRecoupSum.get(id) ?? 0) + (cpRefundSum.get(id) ?? 0);
        r.remainingRecoupable = Math.max(
          0,
          Math.round((Number(r.amount ?? 0) - used) * 100) / 100,
        );
      }
    }
  } catch {
    // best-effort; on failure the UI just falls back to showing the
    // button for any posted era/cp row and the API still enforces caps.
  }
}

// ── Totals ──────────────────────────────────────────────────────────────────

/**
 * Compute totals over the FULL filtered population — independent of the
 * row page the user is looking at. Each KPI is an independent count(*)
 * (or sum) constrained by the same predicates as the row queries so
 * "$ posted / unmatched / denied" reflect the whole filter set, not
 * just the current page of 100 rows.
 */
async function loadTotals(
  supabase: SupabaseClient,
  filters: DashboardFilters,
  providerClaimIds: string[] | null,
): Promise<DashboardTotals> {
  const totals: DashboardTotals = {
    imported: 0,
    posted: 0,
    unmatched: 0,
    unapplied: 0,
    denied: 0,
    recoupments: 0,
    refunds: 0,
    pendingReview: 0,
    amountPosted: 0,
    amountPending: 0,
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const countQ = (table: string): any =>
    supabase.from(table).select("id", { count: "exact", head: true });

  // Apply the dashboard's filter predicates to an ERA count query.
  // Per-source filter scopers — keep these in exact parity with the row
  // loaders above so every KPI matches what the user sees in the table.
  const eraScoped = (q: any) => {
    let r = q
      .eq("organization_id", filters.organizationId)
      .is("archived_at", null);
    if (filters.clientId) r = r.eq("client_id", filters.clientId);
    if (providerClaimIds) r = r.in("professional_claim_id", providerClaimIds);
    if (filters.payerProfileId) r = r.eq("payer_identifier", filters.payerProfileId);
    if (filters.postingStatus && filters.postingStatus.length > 0) {
      r = r.in("posting_status", filters.postingStatus);
    }
    if (filters.eftCheckNumber) r = r.ilike("check_number", `%${filters.eftCheckNumber}%`);
    if (filters.depositDateFrom) r = r.gte("era_received_date", filters.depositDateFrom);
    if (filters.depositDateTo) r = r.lte("era_received_date", filters.depositDateTo);
    if (filters.paymentDateFrom) r = r.gte("created_at", filters.paymentDateFrom);
    if (filters.paymentDateTo) r = r.lte("created_at", filters.paymentDateTo);
    if (filters.eraImportDateFrom) r = r.gte("created_at", filters.eraImportDateFrom);
    if (filters.eraImportDateTo) r = r.lte("created_at", filters.eraImportDateTo);
    return r;
  };

  const manualScoped = (q: any) => {
    // Manual rows are always "posted"; if postingStatus is restricted to
    // a set that excludes 'posted', short-circuit by adding an
    // impossible predicate so this branch contributes nothing to totals.
    if (
      filters.postingStatus &&
      filters.postingStatus.length > 0 &&
      !filters.postingStatus.includes("posted")
    ) {
      return q.eq("organization_id", "00000000-0000-0000-0000-000000000000").eq("id", "00000000-0000-0000-0000-000000000000");
    }
    let r = q
      .eq("organization_id", filters.organizationId)
      .is("archived_at", null);
    if (filters.clientId) r = r.eq("client_id", filters.clientId);
    if (filters.payerProfileId) r = r.eq("payer_profile_id", filters.payerProfileId);
    if (providerClaimIds) r = r.in("claim_id", providerClaimIds);
    if (filters.eftCheckNumber) r = r.ilike("eob_reference", `%${filters.eftCheckNumber}%`);
    // Manual rows have a single posted_at; deposit and payment date
    // filters both narrow against it (same as the row loader).
    if (filters.depositDateFrom) r = r.gte("posted_at", filters.depositDateFrom);
    if (filters.depositDateTo) r = r.lte("posted_at", filters.depositDateTo);
    if (filters.paymentDateFrom) r = r.gte("posted_at", filters.paymentDateFrom);
    if (filters.paymentDateTo) r = r.lte("posted_at", filters.paymentDateTo);
    return r;
  };

  const patientScoped = (q: any) => {
    let r = q
      .eq("organization_id", filters.organizationId)
      .is("archived_at", null);
    if (filters.clientId) r = r.eq("client_id", filters.clientId);
    if (providerClaimIds) r = r.in("claim_id", providerClaimIds);
    if (filters.eftCheckNumber) r = r.ilike("reference_number", `%${filters.eftCheckNumber}%`);
    if (filters.postingStatus && filters.postingStatus.length > 0) {
      r = r.in("posting_status", filters.postingStatus);
    }
    if (filters.depositDateFrom) r = r.gte("posted_at", filters.depositDateFrom);
    if (filters.depositDateTo) r = r.lte("posted_at", filters.depositDateTo);
    if (filters.paymentDateFrom) r = r.gte("posted_at", filters.paymentDateFrom);
    if (filters.paymentDateTo) r = r.lte("posted_at", filters.paymentDateTo);
    return r;
  };

  // Side counts live on auxiliary tables (payment_recoupments,
  // payment_refunds, workqueue_items). They all carry organization_id,
  // client_id, and professional_claim_id, so apply the same client +
  // provider scoping as the row queries. payer + payment-source +
  // payment-type are NOT directly carried on these rows, so we honor
  // them by gating the entire side-count to zero when the user has
  // filtered the dashboard to a source that excludes ERA (recoupments
  // and refunds are ERA-side concepts) — see callers below.
  const sideScoped = (q: any, opts: { dateCol?: string } = {}) => {
    let r = q.eq("organization_id", filters.organizationId).is("archived_at", null);
    if (filters.clientId) r = r.eq("client_id", filters.clientId);
    if (providerClaimIds) r = r.in("professional_claim_id", providerClaimIds);
    if (opts.dateCol) {
      if (filters.paymentDateFrom) r = r.gte(opts.dateCol, filters.paymentDateFrom);
      if (filters.paymentDateTo) r = r.lte(opts.dateCol, filters.paymentDateTo);
    }
    return r;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const wantEra = wantSource(filters, "era");
  const wantManual = wantSource(filters, "manual_insurance");
  const wantPatient = wantSource(filters, "patient");

  try {
    const [
      eraTotal,
      eraPosted,
      eraUnmatched,
      eraDeniedZero,
      manualTotal,
      patientTotal,
      patientUnapplied,
      patientPosted,
      recoupments,
      refunds,
      pendingReview,
    ] = await Promise.all([
      wantEra ? eraScoped(countQ("era_claim_payments")) : Promise.resolve({ count: 0 }),
      wantEra
        ? eraScoped(countQ("era_claim_payments")).eq("posting_status", "posted")
        : Promise.resolve({ count: 0 }),
      wantEra
        ? eraScoped(countQ("era_claim_payments")).eq("claim_match_status", "unmatched")
        : Promise.resolve({ count: 0 }),
      wantEra
        ? eraScoped(countQ("era_claim_payments")).lte("clp04_payment_amount", 0)
        : Promise.resolve({ count: 0 }),
      wantManual ? manualScoped(countQ("insurance_manual_payments")) : Promise.resolve({ count: 0 }),
      wantPatient ? patientScoped(countQ("client_payments")) : Promise.resolve({ count: 0 }),
      wantPatient
        ? patientScoped(countQ("client_payments")).is("claim_id", null).is("patient_invoice_id", null)
        : Promise.resolve({ count: 0 }),
      wantPatient
        ? patientScoped(countQ("client_payments")).eq("posting_status", "posted")
        : Promise.resolve({ count: 0 }),
      // Recoupments/refunds are ERA-and-patient-side concepts (manual
      // insurance posts don't generate them). When the user filters
      // paymentSource down to *only* manual_insurance, zero these out
      // so the KPI matches the visible scope.
      wantEra || wantPatient
        ? sideScoped(countQ("payment_recoupments"), { dateCol: "created_at" })
        : Promise.resolve({ count: 0 }),
      wantEra || wantPatient
        ? sideScoped(countQ("payment_refunds"), { dateCol: "created_at" })
        : Promise.resolve({ count: 0 }),
      // pendingReview gates work types by which sources are visible
      // under the current filter so the KPI tracks the visible scope
      // (e.g., when only patient is selected, ERA-only work types like
      // era_unmatched_claim drop out of the count).
      sideScoped(countQ("workqueue_items"), { dateCol: "created_at" })
        .in(
          "work_type",
          (() => {
            const out: string[] = [];
            if (wantEra || wantManual) {
              out.push(
                "denied",
                "underpayment",
                "appeal_needed",
                "cob_issue",
                "eligibility_issue",
                "no_response",
              );
            }
            if (wantEra) out.push("era_unmatched_claim", "recoupment");
            if (wantPatient) out.push("refund_review", "recoupment");
            return [...new Set(out)];
          })(),
        )
        .in("status", ["open", "in_progress", "blocked"]),
    ]);

    const num = (c: { count?: number | null }) => (typeof c.count === "number" ? c.count : 0);
    totals.imported = num(eraTotal) + num(manualTotal) + num(patientTotal);
    totals.posted = num(eraPosted) + num(manualTotal) + num(patientPosted);
    totals.unmatched = num(eraUnmatched);
    totals.unapplied = num(patientUnapplied);
    totals.denied = num(eraDeniedZero);
    totals.recoupments = num(recoupments);
    totals.refunds = num(refunds);
    totals.pendingReview = num(pendingReview);
  } catch {
    // best-effort; KPIs stay at 0 if counts fail
  }

  // amount* totals via lightweight sum() — chunked across the filtered ERA
  // set to avoid huge transfers. We pull only the amount column with a
  // reasonable cap, then sum in memory.
  try {
    const AMOUNT_CAP = 5000;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const amountFromEra = wantEra
      ? eraScoped(
          supabase.from("era_claim_payments").select("clp04_payment_amount, posting_status") as any,
        ).limit(AMOUNT_CAP)
      : Promise.resolve({ data: [] });
    const amountFromManual = wantManual
      ? manualScoped(supabase.from("insurance_manual_payments").select("paid_amount") as any).limit(
          AMOUNT_CAP,
        )
      : Promise.resolve({ data: [] });
    const amountFromPatient = wantPatient
      ? patientScoped(
          supabase.from("client_payments").select("amount, posting_status") as any,
        ).limit(AMOUNT_CAP)
      : Promise.resolve({ data: [] });
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const [era, manual, patient] = await Promise.all([amountFromEra, amountFromManual, amountFromPatient]);
    for (const r of ((era as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown>>) {
      const amt = Number(r.clp04_payment_amount ?? 0);
      if (!Number.isFinite(amt)) continue;
      if (r.posting_status === "posted") totals.amountPosted += amt;
      else totals.amountPending += amt;
    }
    for (const r of ((manual as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown>>) {
      const amt = Number(r.paid_amount ?? 0);
      if (Number.isFinite(amt)) totals.amountPosted += amt;
    }
    for (const r of ((patient as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown>>) {
      const amt = Number(r.amount ?? 0);
      if (!Number.isFinite(amt)) continue;
      if (r.posting_status === "posted") totals.amountPosted += amt;
      else totals.amountPending += amt;
    }
  } catch {
    // best-effort
  }

  // NOTE: An earlier revision merged in a claim-level "denied claims"
  // count from professional_claims here. That count ignored the active
  // dashboard filter set (payer / client / dates / source / etc.) and
  // could inflate the denied KPI past what the visible rows justified.
  // Denied is now derived solely from the filter-scoped eraDeniedZero
  // query above so the KPI moves in lockstep with the filter bar.

  return totals;
}

// ── Public entrypoint ───────────────────────────────────────────────────────

export async function queryPaymentsDashboard(
  supabase: SupabaseClient,
  filters: DashboardFilters,
): Promise<DashboardResult> {
  const providerClaimIds = await resolveProviderClaimIds(
    supabase,
    filters.organizationId,
    filters.providerNpi,
  );
  const [eraRows, manualRows, patientRows, totals] = await Promise.all([
    loadEraRows(supabase, filters, providerClaimIds),
    loadManualRows(supabase, filters, providerClaimIds),
    loadPatientRows(supabase, filters, providerClaimIds),
    // Totals run independently against the FULL filtered population so
    // KPIs don't shrink to the visible page.
    loadTotals(supabase, filters, providerClaimIds),
  ]);
  const sorted = [...eraRows, ...manualRows, ...patientRows].sort((a, b) => {
    const ad = a.paymentDate ?? a.depositDate ?? "";
    const bd = b.paymentDate ?? b.depositDate ?? "";
    return bd.localeCompare(ad);
  });
  // Apply offset + limit at the merge tier so pagination behaves
  // consistently regardless of which source dominates a given page.
  const offset = Math.max(0, Math.floor(Number(filters.offset ?? 0)) || 0);
  const merged = sorted.slice(offset, offset + clampLimit(filters.limit));
  await annotateRemainingRecoupable(supabase, filters.organizationId, merged);
  return {
    rows: merged,
    totals,
    filters,
    rowCount: merged.length,
  };
}
