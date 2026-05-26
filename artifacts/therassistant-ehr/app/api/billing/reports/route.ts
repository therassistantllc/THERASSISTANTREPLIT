import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type ReportClaims = {
  submitted: number;
  paid: number;
  deniedOrRejected: number;
  totalChargeSubmitted: number;
};

type ReportPayments = {
  count: number;
  totalAmount: number;
};

type ReportPatientResponsibility = {
  openBalance: number;
  invoiceCount: number;
  collectionsCount: number;
  collectionsBalance: number;
  averageOpenBalance: number;
};

type ReportWorkqueue = {
  created: number;
  resolved: number;
  deferred: number;
  openNow: number;
};

type ClaimsAging = {
  bucket0to30: { count: number; totalCharge: number };
  bucket31to60: { count: number; totalCharge: number };
  bucket61Plus: { count: number; totalCharge: number };
  totalOutstanding: number;
};

type DenialEntry = {
  groupCode: string;
  reasonCode: string;
  carcCode: string;
  occurrences: number;
  totalAmount: number;
};

type DenialReport = {
  totalAdjustmentAmount: number;
  totalAdjustmentCount: number;
  breakdown: DenialEntry[];
};

type PayerCallVolumeEntry = {
  payerProfileId: string | null;
  payerName: string;
  totalAttempts: number;
  spokeWithRep: number;
  leftVoicemail: number;
  noAnswer: number;
  faxes: number;
  otherDialed: number;
};

type PayerCallVolumeReport = {
  totalAttempts: number;
  spokeWithRep: number;
  leftVoicemail: number;
  noAnswer: number;
  faxes: number;
  voicemailRate: number;
  averageAttemptsPerClaim: number;
  breakdown: PayerCallVolumeEntry[];
};

type PayerPerformanceEntry = {
  payerProfileId: string | null;
  payerName: string;
  totalClaims: number;
  acceptedClaims: number;
  paidClaims: number;
  rejectedClaims: number;
  acceptanceRate: number;
  averageTurnaroundDays: number | null;
  totalCharge: number;
};

type CasAdjustment = {
  groupCode?: string | null;
  reasonCode?: string | null;
  amount?: number | string | null;
};

function money(value: number) {
  return Math.round(value * 100) / 100;
}

function monthBounds(monthValue: string | null) {
  const now = new Date();
  const fallback = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const safeMonth = /^\d{4}-\d{2}$/.test(monthValue ?? "") ? String(monthValue) : fallback;
  const start = new Date(`${safeMonth}-01T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    const defaultStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const defaultEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return {
      month: fallback,
      periodStart: defaultStart.toISOString(),
      periodEnd: defaultEnd.toISOString(),
    };
  }

  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return {
    month: safeMonth,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

const ACCEPTED_STATUSES = new Set(["accepted_oa", "accepted_payer", "submitted", "paid"]);
const REJECTED_STATUSES = new Set(["denied", "rejected_oa", "rejected_payer"]);
const OUTSTANDING_STATUSES = new Set([
  "submitted",
  "accepted_oa",
  "accepted_payer",
  "denied",
  "rejected_oa",
  "rejected_payer",
]);

function dayDiff(from: string | null, to: string | null) {
  if (!from || !to) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const diff = (b - a) / (1000 * 60 * 60 * 24);
  return diff >= 0 ? diff : null;
}

/**
 * Shift a `YYYY-MM` month string by N months (negative for past).
 */
function shiftMonth(month: string, deltaMonths: number): string {
  const [y, m] = month.split("-").map((s) => Number(s));
  const date = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

type MonthlyHeadline = {
  month: string;
  claimsSubmitted: number;
  claimsPaid: number;
  denials: number;
  chargesSubmitted: number;
  paymentsPosted: number;
  paymentCount: number;
  outstandingAR: number;
  averageDaysInAR: number | null;
  collectionRate: number;
};

/**
 * Cheap per-month roll-up used for prior-month deltas and the 6-month
 * sparkline series. Does NOT include the heavy aggregations (denial
 * breakdown, payer performance, call activity). Respects clinician
 * scoping when `claimAppointmentFilter` is provided (null = practice-wide).
 *
 * Outstanding AR & average days in AR are computed as a snapshot at the
 * end of the month: every claim currently in an outstanding status whose
 * submitted_at is on/before monthEnd is counted. This is an approximation
 * (status may have changed since), but it is the best signal we have
 * without an audited status-history table.
 */
async function computeMonthlyHeadline(args: {
  supabase: ReturnType<typeof createServerSupabaseAdminClient>;
  organizationId: string;
  month: string;
  claimAppointmentFilter: string[] | null;
  includePatientPayments: boolean;
}): Promise<MonthlyHeadline> {
  const { supabase, organizationId, month, claimAppointmentFilter, includePatientPayments } = args;
  if (!supabase) {
    return emptyMonthlyHeadline(month);
  }
  const { periodStart, periodEnd } = monthBounds(month);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function scope(query: any): any {
    if (claimAppointmentFilter === null) return query;
    if (claimAppointmentFilter.length === 0) return query.in("id", ["00000000-0000-0000-0000-000000000000"]);
    return query.in("appointment_id", claimAppointmentFilter);
  }

  const submittedQ = scope(
    supabase
      .from("professional_claims")
      .select("id, total_charge")
      .eq("organization_id", organizationId)
      .gte("submitted_at", periodStart)
      .lt("submitted_at", periodEnd),
  ) as Promise<{ data: Array<{ id: string; total_charge: number | string | null }> | null }>;

  const paidQ = scope(
    supabase
      .from("professional_claims")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("claim_status", "paid")
      .gte("updated_at", periodStart)
      .lt("updated_at", periodEnd),
  ) as Promise<{ count: number | null }>;

  const deniedQ = scope(
    supabase
      .from("professional_claims")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("claim_status", ["denied", "rejected_oa", "rejected_payer"])
      .gte("updated_at", periodStart)
      .lt("updated_at", periodEnd),
  ) as Promise<{ count: number | null }>;

  const paymentsQ = includePatientPayments
    ? supabase
        .from("patient_invoice_payments")
        .select("id, amount")
        .eq("organization_id", organizationId)
        .gte("paid_at", periodStart)
        .lt("paid_at", periodEnd)
        .is("archived_at", null)
    : Promise.resolve({ data: [] as Array<{ id: string; amount: number | string | null }> });

  // Outstanding AR as-of monthEnd
  const outstandingQ = scope(
    supabase
      .from("professional_claims")
      .select("id, total_charge, submitted_at")
      .eq("organization_id", organizationId)
      .in("claim_status", Array.from(OUTSTANDING_STATUSES))
      .not("submitted_at", "is", null)
      .lt("submitted_at", periodEnd),
  ) as Promise<{ data: Array<{ id: string; total_charge: number | string | null; submitted_at: string | null }> | null }>;

  const [{ data: submittedClaims }, { count: paidCount }, { count: deniedCount }, paymentsRes, { data: outstandingRows }] =
    await Promise.all([submittedQ, paidQ, deniedQ, paymentsQ, outstandingQ]);

  const chargesSubmitted = (submittedClaims ?? []).reduce(
    (s, c) => s + Number(c.total_charge ?? 0),
    0,
  );
  const paymentsRows = (paymentsRes as { data: Array<{ id: string; amount: number | string | null }> | null }).data ?? [];
  const paymentsTotal = paymentsRows.reduce((s, p) => s + Number(p.amount ?? 0), 0);

  const monthEndMs = new Date(periodEnd).getTime();
  let outstandingTotal = 0;
  const ageSamples: number[] = [];
  for (const c of outstandingRows ?? []) {
    const charge = Number(c.total_charge ?? 0);
    outstandingTotal += charge;
    const submittedMs = c.submitted_at ? new Date(c.submitted_at).getTime() : null;
    if (submittedMs !== null && !Number.isNaN(submittedMs) && submittedMs <= monthEndMs) {
      ageSamples.push((monthEndMs - submittedMs) / (1000 * 60 * 60 * 24));
    }
  }
  const avgDaysInAR =
    ageSamples.length > 0
      ? Math.round((ageSamples.reduce((a, b) => a + b, 0) / ageSamples.length) * 10) / 10
      : null;

  const collectionRate =
    chargesSubmitted > 0 ? Math.round((paymentsTotal / chargesSubmitted) * 1000) / 10 : 0;

  return {
    month,
    claimsSubmitted: (submittedClaims ?? []).length,
    claimsPaid: paidCount ?? 0,
    denials: deniedCount ?? 0,
    chargesSubmitted: money(chargesSubmitted),
    paymentsPosted: money(paymentsTotal),
    paymentCount: paymentsRows.length,
    outstandingAR: money(outstandingTotal),
    averageDaysInAR: avgDaysInAR,
    collectionRate,
  };
}

function emptyMonthlyHeadline(month: string): MonthlyHeadline {
  return {
    month,
    claimsSubmitted: 0,
    claimsPaid: 0,
    denials: 0,
    chargesSubmitted: 0,
    paymentsPosted: 0,
    paymentCount: 0,
    outstandingAR: 0,
    averageDaysInAR: null,
    collectionRate: 0,
  };
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { month, periodStart, periodEnd } = monthBounds(searchParams.get("month"));
    const providerId = searchParams.get("providerId");

    // When a clinician is selected, scope claims to that provider via their
    // appointments. Pre-fetch the matching appointment_ids and `.in(...)` them
    // into each claims query below. Empty set → zero counts.
    let claimAppointmentFilter: string[] | null = null;
    if (providerId) {
      const { data: apptRows } = await supabase
        .from("appointments")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("provider_id", providerId);
      claimAppointmentFilter = (apptRows ?? []).map((r: { id: string }) => r.id);
    }

    function scopeClaims<T extends { in: (col: string, values: string[]) => T }>(query: T): T {
      if (claimAppointmentFilter === null) return query;
      if (claimAppointmentFilter.length === 0) return query.in("id", ["00000000-0000-0000-0000-000000000000"]);
      return query.in("appointment_id", claimAppointmentFilter);
    }

    const { data: submittedClaims } = await scopeClaims(
      supabase
        .from("professional_claims")
        .select("id, total_charge, appointment_id")
        .eq("organization_id", organizationId)
        .gte("submitted_at", periodStart)
        .lt("submitted_at", periodEnd) as unknown as { in: (c: string, v: string[]) => unknown },
    ) as unknown as { data: Array<{ id: string; total_charge: number | string | null; appointment_id: string | null }> | null };

    const { count: paidClaimsCount } = await scopeClaims(
      supabase
        .from("professional_claims")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("claim_status", "paid")
        .gte("updated_at", periodStart)
        .lt("updated_at", periodEnd) as unknown as { in: (c: string, v: string[]) => unknown },
    ) as unknown as { count: number | null };

    const { count: deniedOrRejectedCount } = await scopeClaims(
      supabase
        .from("professional_claims")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .in("claim_status", ["denied", "rejected_oa", "rejected_payer"])
        .gte("updated_at", periodStart)
        .lt("updated_at", periodEnd) as unknown as { in: (c: string, v: string[]) => unknown },
    ) as unknown as { count: number | null };

    // Patient payments are not directly tied to a provider; when a clinician is
    // selected, return 0 instead of practice-wide totals to keep the KPI honest.
    const { data: payments } = providerId
      ? { data: [] as Array<{ id: string; amount: number | string | null }> }
      : await supabase
          .from("patient_invoice_payments")
          .select("id, amount")
          .eq("organization_id", organizationId)
          .gte("paid_at", periodStart)
          .lt("paid_at", periodEnd)
          .is("archived_at", null);

    const { data: openInvoices } = await supabase
      .from("patient_invoices")
      .select("id, balance_amount, invoice_status")
      .eq("organization_id", organizationId)
      .in("invoice_status", ["open", "sent", "collections"])
      .is("archived_at", null);

    const { count: workqueueCreatedCount } = await supabase
      .from("workqueue_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd)
      .is("archived_at", null);

    const { count: workqueueResolvedCount } = await supabase
      .from("workqueue_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("resolved_at", periodStart)
      .lt("resolved_at", periodEnd)
      .is("archived_at", null);

    const { count: workqueueDeferredCount } = await supabase
      .from("workqueue_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("deferred_until", periodStart)
      .lt("deferred_until", periodEnd)
      .is("archived_at", null);

    const { count: workqueueOpenNowCount } = await supabase
      .from("workqueue_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("status", ["open", "in_progress", "blocked", "deferred"])
      .is("archived_at", null);

    // Claims aging: every claim that is outstanding (submitted but not paid/voided/draft),
    // bucketed by days since submitted_at.
    const { data: outstandingClaims } = await scopeClaims(
      supabase
        .from("professional_claims")
        .select("id, total_charge, claim_status, submitted_at")
        .eq("organization_id", organizationId)
        .in("claim_status", Array.from(OUTSTANDING_STATUSES))
        .not("submitted_at", "is", null) as unknown as { in: (c: string, v: string[]) => unknown },
    ) as unknown as { data: Array<{ id: string; total_charge: number | string | null; claim_status: string; submitted_at: string | null }> | null };

    const aging: ClaimsAging = {
      bucket0to30: { count: 0, totalCharge: 0 },
      bucket31to60: { count: 0, totalCharge: 0 },
      bucket61Plus: { count: 0, totalCharge: 0 },
      totalOutstanding: 0,
    };
    const now = Date.now();
    for (const claim of outstandingClaims ?? []) {
      const submitted = claim.submitted_at ? new Date(claim.submitted_at).getTime() : null;
      if (submitted === null || Number.isNaN(submitted)) continue;
      const ageDays = Math.floor((now - submitted) / (1000 * 60 * 60 * 24));
      const charge = Number(claim.total_charge ?? 0);
      aging.totalOutstanding += 1;
      if (ageDays <= 30) {
        aging.bucket0to30.count += 1;
        aging.bucket0to30.totalCharge += charge;
      } else if (ageDays <= 60) {
        aging.bucket31to60.count += 1;
        aging.bucket31to60.totalCharge += charge;
      } else {
        aging.bucket61Plus.count += 1;
        aging.bucket61Plus.totalCharge += charge;
      }
    }
    aging.bucket0to30.totalCharge = money(aging.bucket0to30.totalCharge);
    aging.bucket31to60.totalCharge = money(aging.bucket31to60.totalCharge);
    aging.bucket61Plus.totalCharge = money(aging.bucket61Plus.totalCharge);

    // Denial / CARC breakdown from era_claim_payments.cas_adjustments (current month).
    // When a clinician is selected, scope ERA rows to that provider's claims.
    let scopedClaimIdsForEra: string[] | null = null;
    if (providerId) {
      if (claimAppointmentFilter && claimAppointmentFilter.length === 0) {
        scopedClaimIdsForEra = [];
      } else {
        const { data: claimIdRows } = await scopeClaims(
          supabase
            .from("professional_claims")
            .select("id")
            .eq("organization_id", organizationId) as unknown as { in: (c: string, v: string[]) => unknown },
        ) as unknown as { data: Array<{ id: string }> | null };
        scopedClaimIdsForEra = (claimIdRows ?? []).map((r) => r.id);
      }
    }
    let eraPaymentsQuery = supabase
      .from("era_claim_payments")
      .select(
        "id, cas_adjustments, created_at, updated_at, posting_status, claim_match_status, professional_claim_id",
      )
      .eq("organization_id", organizationId)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd)
      .is("archived_at", null);
    if (scopedClaimIdsForEra !== null) {
      eraPaymentsQuery = scopedClaimIdsForEra.length === 0
        ? eraPaymentsQuery.in("id", ["00000000-0000-0000-0000-000000000000"])
        : eraPaymentsQuery.in("professional_claim_id", scopedClaimIdsForEra);
    }
    const { data: eraPayments } = await eraPaymentsQuery;

    const denialMap = new Map<string, DenialEntry>();
    // Track which claim IDs contributed to each CARC so we can later enrich
    // the top denial with the payer it most commonly came from.
    const denialClaimIdsByCarc = new Map<string, Set<string>>();
    let totalAdjustmentAmount = 0;
    let totalAdjustmentCount = 0;
    for (const era of eraPayments ?? []) {
      const adjustments = Array.isArray(era.cas_adjustments)
        ? (era.cas_adjustments as CasAdjustment[])
        : [];
      for (const adj of adjustments) {
        const groupCode = (adj.groupCode ?? "").toString().toUpperCase();
        const reasonCode = (adj.reasonCode ?? "").toString();
        if (!groupCode && !reasonCode) continue;
        const amount = Number(adj.amount ?? 0);
        const carcCode = `${groupCode || "?"}-${reasonCode || "?"}`;
        const existing = denialMap.get(carcCode);
        if (existing) {
          existing.occurrences += 1;
          existing.totalAmount += amount;
        } else {
          denialMap.set(carcCode, {
            groupCode,
            reasonCode,
            carcCode,
            occurrences: 1,
            totalAmount: amount,
          });
        }
        if (era.professional_claim_id) {
          let claimSet = denialClaimIdsByCarc.get(carcCode);
          if (!claimSet) {
            claimSet = new Set<string>();
            denialClaimIdsByCarc.set(carcCode, claimSet);
          }
          claimSet.add(era.professional_claim_id);
        }
        totalAdjustmentAmount += amount;
        totalAdjustmentCount += 1;
      }
    }

    const denialBreakdown = Array.from(denialMap.values())
      .map((entry) => ({ ...entry, totalAmount: money(entry.totalAmount) }))
      .sort((a, b) => b.totalAmount - a.totalAmount || b.occurrences - a.occurrences)
      .slice(0, 10);

    const denials: DenialReport = {
      totalAdjustmentAmount: money(totalAdjustmentAmount),
      totalAdjustmentCount,
      breakdown: denialBreakdown,
    };

    // Payer performance: aggregate every claim with a payer_profile_id submitted in this month.
    const { data: claimsForPayer } = await scopeClaims(
      supabase
        .from("professional_claims")
        .select("id, payer_profile_id, claim_status, total_charge, submitted_at, updated_at")
        .eq("organization_id", organizationId)
        .not("payer_profile_id", "is", null)
        .gte("submitted_at", periodStart)
        .lt("submitted_at", periodEnd) as unknown as { in: (c: string, v: string[]) => unknown },
    ) as unknown as { data: Array<{ id: string; payer_profile_id: string | null; claim_status: string; total_charge: number | string | null; submitted_at: string | null; updated_at: string | null }> | null };

    const payerIds = Array.from(
      new Set((claimsForPayer ?? []).map((c) => c.payer_profile_id).filter((id): id is string => Boolean(id))),
    );

    let payerNameById = new Map<string, string>();
    if (payerIds.length > 0) {
      const { data: payerRows } = await supabase
        .from("payer_profiles")
        .select("id, payer_name")
        .in("id", payerIds);
      payerNameById = new Map((payerRows ?? []).map((row) => [row.id, row.payer_name ?? "Unknown payer"]));
    }

    type PayerAgg = {
      payerProfileId: string;
      payerName: string;
      totalClaims: number;
      acceptedClaims: number;
      paidClaims: number;
      rejectedClaims: number;
      totalCharge: number;
      turnaroundSamples: number[];
    };

    const payerAggMap = new Map<string, PayerAgg>();
    for (const claim of claimsForPayer ?? []) {
      if (!claim.payer_profile_id) continue;
      const existing: PayerAgg =
        payerAggMap.get(claim.payer_profile_id) ??
        {
          payerProfileId: claim.payer_profile_id,
          payerName: payerNameById.get(claim.payer_profile_id) ?? "Unknown payer",
          totalClaims: 0,
          acceptedClaims: 0,
          paidClaims: 0,
          rejectedClaims: 0,
          totalCharge: 0,
          turnaroundSamples: [],
        };
      existing.totalClaims += 1;
      existing.totalCharge += Number(claim.total_charge ?? 0);
      if (claim.claim_status === "paid") {
        existing.paidClaims += 1;
        const days = dayDiff(claim.submitted_at, claim.updated_at);
        if (days !== null) existing.turnaroundSamples.push(days);
      }
      if (ACCEPTED_STATUSES.has(claim.claim_status)) existing.acceptedClaims += 1;
      if (REJECTED_STATUSES.has(claim.claim_status)) existing.rejectedClaims += 1;
      payerAggMap.set(claim.payer_profile_id, existing);
    }

    const payerPerformance: PayerPerformanceEntry[] = Array.from(payerAggMap.values())
      .map((agg) => {
        const avgTurnaround =
          agg.turnaroundSamples.length > 0
            ? Math.round(
                (agg.turnaroundSamples.reduce((s, n) => s + n, 0) / agg.turnaroundSamples.length) * 10,
              ) / 10
            : null;
        const acceptanceRate =
          agg.totalClaims === 0 ? 0 : Math.round((agg.acceptedClaims / agg.totalClaims) * 1000) / 10;
        return {
          payerProfileId: agg.payerProfileId,
          payerName: agg.payerName,
          totalClaims: agg.totalClaims,
          acceptedClaims: agg.acceptedClaims,
          paidClaims: agg.paidClaims,
          rejectedClaims: agg.rejectedClaims,
          acceptanceRate,
          averageTurnaroundDays: avgTurnaround,
          totalCharge: money(agg.totalCharge),
        };
      })
      .sort((a, b) => b.totalClaims - a.totalClaims)
      .slice(0, 10);

    // Payer-call volume & disposition mix (Task #634). Sourced from the
    // structured payer_call_attempts ledger. When a clinician is selected we
    // restrict to call attempts on that clinician's claims so the operational
    // row stays scope-consistent.
    let callAttemptsQuery = supabase
      .from("payer_call_attempts")
      .select("payer_profile_id, contact_channel, disposition, claim_id, created_at")
      .eq("organization_id", organizationId)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd);
    if (scopedClaimIdsForEra !== null) {
      callAttemptsQuery =
        scopedClaimIdsForEra.length === 0
          ? callAttemptsQuery.in("claim_id", ["00000000-0000-0000-0000-000000000000"])
          : callAttemptsQuery.in("claim_id", scopedClaimIdsForEra);
    }
    const { data: callAttemptsRaw } = await callAttemptsQuery;

    const callAttempts = (callAttemptsRaw ?? []) as Array<{
      payer_profile_id: string | null;
      contact_channel: string | null;
      disposition: string | null;
      claim_id: string | null;
    }>;

    const callPayerIds = Array.from(
      new Set(
        callAttempts
          .map((a) => a.payer_profile_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const missingCallPayerIds = callPayerIds.filter(
      (id) => !payerNameById.has(id),
    );
    if (missingCallPayerIds.length > 0) {
      const { data: extraPayerRows } = await supabase
        .from("payer_profiles")
        .select("id, payer_name")
        .in("id", missingCallPayerIds);
      for (const row of extraPayerRows ?? []) {
        payerNameById.set(row.id, row.payer_name ?? "Unknown payer");
      }
    }

    const callAggMap = new Map<string, PayerCallVolumeEntry>();
    const distinctClaims = new Set<string>();
    let totalAttempts = 0;
    let totalSpoke = 0;
    let totalVm = 0;
    let totalNoAnswer = 0;
    let totalFaxes = 0;
    for (const att of callAttempts) {
      const key = att.payer_profile_id ?? "__no_payer__";
      const existing =
        callAggMap.get(key) ??
        {
          payerProfileId: att.payer_profile_id,
          payerName: att.payer_profile_id
            ? payerNameById.get(att.payer_profile_id) ?? "Unknown payer"
            : "Unknown payer",
          totalAttempts: 0,
          spokeWithRep: 0,
          leftVoicemail: 0,
          noAnswer: 0,
          faxes: 0,
          otherDialed: 0,
        };
      existing.totalAttempts += 1;
      totalAttempts += 1;
      if (att.claim_id) distinctClaims.add(att.claim_id);
      switch (att.disposition) {
        case "spoke_with_rep":
          existing.spokeWithRep += 1;
          totalSpoke += 1;
          break;
        case "left_voicemail":
          existing.leftVoicemail += 1;
          totalVm += 1;
          break;
        case "no_answer":
          existing.noAnswer += 1;
          totalNoAnswer += 1;
          break;
        case "sent_fax":
          existing.faxes += 1;
          totalFaxes += 1;
          break;
        default:
          existing.otherDialed += 1;
          break;
      }
      callAggMap.set(key, existing);
    }

    const callVolumeBreakdown = Array.from(callAggMap.values())
      .sort((a, b) => b.totalAttempts - a.totalAttempts)
      .slice(0, 10);

    const payerCallVolume: PayerCallVolumeReport = {
      totalAttempts,
      spokeWithRep: totalSpoke,
      leftVoicemail: totalVm,
      noAnswer: totalNoAnswer,
      faxes: totalFaxes,
      voicemailRate:
        totalAttempts > 0
          ? Math.round((totalVm / totalAttempts) * 1000) / 10
          : 0,
      averageAttemptsPerClaim:
        distinctClaims.size > 0
          ? Math.round((totalAttempts / distinctClaims.size) * 10) / 10
          : 0,
      breakdown: callVolumeBreakdown,
    };

    const submittedChargeTotal = (submittedClaims ?? []).reduce(
      (sum, claim) => sum + Number(claim.total_charge ?? 0),
      0,
    );
    const postedPaymentTotal = (payments ?? []).reduce(
      (sum, payment) => sum + Number(payment.amount ?? 0),
      0,
    );
    const openBalanceTotal = (openInvoices ?? []).reduce(
      (sum, invoice) => sum + Number(invoice.balance_amount ?? 0),
      0,
    );
    const collectionsInvoices = (openInvoices ?? []).filter(
      (invoice) => invoice.invoice_status === "collections",
    );
    const collectionsBalanceTotal = collectionsInvoices.reduce(
      (sum, invoice) => sum + Number(invoice.balance_amount ?? 0),
      0,
    );

    const claims: ReportClaims = {
      submitted: (submittedClaims ?? []).length,
      paid: paidClaimsCount ?? 0,
      deniedOrRejected: deniedOrRejectedCount ?? 0,
      totalChargeSubmitted: money(submittedChargeTotal),
    };

    const paymentsSummary: ReportPayments = {
      count: (payments ?? []).length,
      totalAmount: money(postedPaymentTotal),
    };

    const invoiceCount = (openInvoices ?? []).length;
    const patientResponsibility: ReportPatientResponsibility = {
      openBalance: money(openBalanceTotal),
      invoiceCount,
      collectionsCount: collectionsInvoices.length,
      collectionsBalance: money(collectionsBalanceTotal),
      averageOpenBalance: invoiceCount > 0 ? money(openBalanceTotal / invoiceCount) : 0,
    };

    const workqueue: ReportWorkqueue = {
      created: workqueueCreatedCount ?? 0,
      resolved: workqueueResolvedCount ?? 0,
      deferred: workqueueDeferredCount ?? 0,
      openNow: workqueueOpenNowCount ?? 0,
    };

    // Prior-month + 6-month time series for sparklines & trend charts.
    // The current month is included in the series as the last point.
    const seriesMonths = Array.from({ length: 6 }, (_, i) => shiftMonth(month, -(5 - i)));
    const headlinePromises = seriesMonths.map((m) =>
      computeMonthlyHeadline({
        supabase,
        organizationId,
        month: m,
        claimAppointmentFilter,
        includePatientPayments: !providerId,
      }),
    );
    const priorMonth = shiftMonth(month, -1);
    const priorHeadlinePromise = computeMonthlyHeadline({
      supabase,
      organizationId,
      month: priorMonth,
      claimAppointmentFilter,
      includePatientPayments: !providerId,
    });
    const [timeSeries, priorMonthMetrics] = await Promise.all([
      Promise.all(headlinePromises),
      priorHeadlinePromise,
    ]);

    // Derived metrics for the executive snapshot.
    // Outstanding AR + avg days in AR snapshot as of "now" come from the
    // existing `aging` aggregation above (which uses live status); for the
    // current-period collection rate we reuse charges submitted vs payments
    // posted within the period.
    const liveOutstandingTotal =
      aging.bucket0to30.totalCharge +
      aging.bucket31to60.totalCharge +
      aging.bucket61Plus.totalCharge;

    const liveAgeSamples: number[] = [];
    const liveNow = Date.now();
    for (const claim of outstandingClaims ?? []) {
      const submitted = claim.submitted_at ? new Date(claim.submitted_at).getTime() : null;
      if (submitted === null || Number.isNaN(submitted)) continue;
      liveAgeSamples.push((liveNow - submitted) / (1000 * 60 * 60 * 24));
    }
    const liveAverageDaysInAR =
      liveAgeSamples.length > 0
        ? Math.round((liveAgeSamples.reduce((s, n) => s + n, 0) / liveAgeSamples.length) * 10) / 10
        : null;

    const periodCollectionRate =
      claims.totalChargeSubmitted > 0
        ? Math.round((paymentsSummary.totalAmount / claims.totalChargeSubmitted) * 1000) / 10
        : 0;

    // Net collection % = payments / (charges - contractual adjustments).
    // We approximate contractual adjustments as the CARC group code "CO"
    // total within the period (the same CAS rows we already walked above).
    let contractualAdjustments = 0;
    for (const era of eraPayments ?? []) {
      const adjustments = Array.isArray(era.cas_adjustments) ? (era.cas_adjustments as CasAdjustment[]) : [];
      for (const adj of adjustments) {
        if ((adj.groupCode ?? "").toString().toUpperCase() === "CO") {
          contractualAdjustments += Number(adj.amount ?? 0);
        }
      }
    }
    const netDenominator = Math.max(0, claims.totalChargeSubmitted - contractualAdjustments);
    const netCollectionPct =
      netDenominator > 0 ? Math.round((paymentsSummary.totalAmount / netDenominator) * 1000) / 10 : 0;

    // Enrich the top denial with the payer that contributed it most. We
    // look up payer_profile_id for the claims that produced the top CARC,
    // pick the most common, and resolve its display name. Falls back to
    // null when the top CARC has no linked claims.
    let topDenialPayerName: string | null = null;
    if (denialBreakdown[0]) {
      const carc = denialBreakdown[0].carcCode;
      const claimIds = Array.from(denialClaimIdsByCarc.get(carc) ?? []);
      if (claimIds.length > 0) {
        const { data: payerRowsForCarc } = await supabase
          .from("professional_claims")
          .select("payer_profile_id")
          .eq("organization_id", organizationId)
          .in("id", claimIds);
        const payerCounts = new Map<string, number>();
        for (const row of payerRowsForCarc ?? []) {
          if (!row.payer_profile_id) continue;
          payerCounts.set(row.payer_profile_id, (payerCounts.get(row.payer_profile_id) ?? 0) + 1);
        }
        if (payerCounts.size > 0) {
          const [topPayerId] = Array.from(payerCounts.entries()).sort((a, b) => b[1] - a[1])[0];
          const cached = payerNameById.get(topPayerId);
          if (cached) {
            topDenialPayerName = cached;
          } else {
            const { data: payerLookup } = await supabase
              .from("payer_profiles")
              .select("payer_name")
              .eq("id", topPayerId)
              .maybeSingle();
            topDenialPayerName = (payerLookup as { payer_name?: string } | null)?.payer_name ?? null;
          }
        }
      }
    }

    const topDenial = denialBreakdown[0]
      ? {
          carcCode: denialBreakdown[0].carcCode,
          groupCode: denialBreakdown[0].groupCode,
          reasonCode: denialBreakdown[0].reasonCode,
          occurrences: denialBreakdown[0].occurrences,
          totalAmount: denialBreakdown[0].totalAmount,
          payerName: topDenialPayerName,
        }
      : null;

    // ERA processing lag: avg days from ERA created_at → updated_at for
    // rows that finished posting this period. Also count rows still in
    // a non-posted / unmatched state as the operational backlog.
    const eraLagSamples: number[] = [];
    let eraUnposted = 0;
    let eraUnmatched = 0;
    for (const era of eraPayments ?? []) {
      const status = (era.posting_status ?? "").toString();
      const matchStatus = (era.claim_match_status ?? "").toString();
      if (status && status !== "posted") eraUnposted += 1;
      if (matchStatus && matchStatus !== "matched") eraUnmatched += 1;
      if (status === "posted" && era.created_at && era.updated_at) {
        const days = dayDiff(era.created_at, era.updated_at);
        if (days !== null) eraLagSamples.push(days);
      }
    }
    const eraLagAverageDays =
      eraLagSamples.length > 0
        ? Math.round((eraLagSamples.reduce((s, n) => s + n, 0) / eraLagSamples.length) * 10) / 10
        : null;

    // Eligibility / auth-issue backlog: open workqueue items whose work_type
    // is the eligibility queue id ("eligibility_issues"). Best-effort — when
    // the project doesn't use that work_type the count is simply 0.
    const { count: authIssuesOpenCount } = await supabase
      .from("workqueue_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("work_type", "eligibility_issues")
      .in("status", ["open", "in_progress", "blocked", "deferred"])
      .is("archived_at", null);

    const operational = {
      unresolvedClaims: aging.totalOutstanding,
      eraLagAverageDays,
      eraUnpostedCount: eraUnposted,
      eraUnmatchedCount: eraUnmatched,
      authIssuesOpen: authIssuesOpenCount ?? 0,
    };

    // Clinician productivity: claims & charges this month, grouped by the
    // rendering provider. Computed by mapping each submitted claim's
    // appointment_id → provider_id → provider_name.
    const claimAppointmentIds = Array.from(
      new Set(
        (submittedClaims ?? [])
          .map((c) => c.appointment_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    let providerByAppointment = new Map<string, string>();
    let providerNameById = new Map<string, string>();
    if (claimAppointmentIds.length > 0) {
      const { data: apptProviderRows } = await supabase
        .from("appointments")
        .select("id, provider_id")
        .eq("organization_id", organizationId)
        .in("id", claimAppointmentIds);
      providerByAppointment = new Map(
        (apptProviderRows ?? [])
          .filter((r: { id: string; provider_id: string | null }) => r.provider_id)
          .map((r: { id: string; provider_id: string | null }) => [r.id, r.provider_id as string]),
      );
      const providerIds = Array.from(new Set(providerByAppointment.values()));
      if (providerIds.length > 0) {
        const { data: providerRows } = await supabase
          .from("providers")
          .select("id, provider_name")
          .in("id", providerIds);
        providerNameById = new Map(
          (providerRows ?? []).map((p: { id: string; provider_name: string | null }) => [
            p.id,
            p.provider_name ?? "Unnamed clinician",
          ]),
        );
      }
    }
    const productivityMap = new Map<string, { providerId: string; providerName: string; claimsSubmitted: number; chargesSubmitted: number }>();
    for (const claim of submittedClaims ?? []) {
      const providerIdForClaim = claim.appointment_id
        ? providerByAppointment.get(claim.appointment_id)
        : undefined;
      if (!providerIdForClaim) continue;
      const existing =
        productivityMap.get(providerIdForClaim) ??
        {
          providerId: providerIdForClaim,
          providerName: providerNameById.get(providerIdForClaim) ?? "Unknown clinician",
          claimsSubmitted: 0,
          chargesSubmitted: 0,
        };
      existing.claimsSubmitted += 1;
      existing.chargesSubmitted += Number(claim.total_charge ?? 0);
      productivityMap.set(providerIdForClaim, existing);
    }
    const clinicianProductivity = Array.from(productivityMap.values())
      .map((p) => ({ ...p, chargesSubmitted: money(p.chargesSubmitted) }))
      .sort((a, b) => b.claimsSubmitted - a.claimsSubmitted)
      .slice(0, 12);

    const derived = {
      collectionRate: periodCollectionRate,
      netCollectionPct,
      contractualAdjustments: money(contractualAdjustments),
      averageDaysInAR: liveAverageDaysInAR,
      outstandingAR: money(liveOutstandingTotal),
      topDenial,
    };

    return NextResponse.json({
      success: true,
      organizationId,
      month,
      periodStart,
      periodEnd,
      claims,
      payments: paymentsSummary,
      patientResponsibility,
      workqueue,
      aging,
      denials,
      payerPerformance,
      payerCallVolume,
      priorMonth: priorMonthMetrics,
      timeSeries,
      derived,
      operational,
      clinicianProductivity,
    });
  } catch (error) {
    console.error("Billing reports API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Billing reports API failed" },
      { status: 500 },
    );
  }
}
