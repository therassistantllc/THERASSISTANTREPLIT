import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

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

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    const { month, periodStart, periodEnd } = monthBounds(searchParams.get("month"));

    const { data: submittedClaims } = await supabase
      .from("professional_claims")
      .select("id, total_charge")
      .eq("organization_id", organizationId)
      .gte("submitted_at", periodStart)
      .lt("submitted_at", periodEnd);

    const { count: paidClaimsCount } = await supabase
      .from("professional_claims")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("claim_status", "paid")
      .gte("updated_at", periodStart)
      .lt("updated_at", periodEnd);

    const { count: deniedOrRejectedCount } = await supabase
      .from("professional_claims")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("claim_status", ["denied", "rejected_oa", "rejected_payer"])
      .gte("updated_at", periodStart)
      .lt("updated_at", periodEnd);

    const { data: payments } = await supabase
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
    const { data: outstandingClaims } = await supabase
      .from("professional_claims")
      .select("id, total_charge, claim_status, submitted_at")
      .eq("organization_id", organizationId)
      .in("claim_status", Array.from(OUTSTANDING_STATUSES))
      .not("submitted_at", "is", null);

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
    const { data: eraPayments } = await supabase
      .from("era_claim_payments")
      .select("id, cas_adjustments, created_at")
      .eq("organization_id", organizationId)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd)
      .is("archived_at", null);

    const denialMap = new Map<string, DenialEntry>();
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
    const { data: claimsForPayer } = await supabase
      .from("professional_claims")
      .select("id, payer_profile_id, claim_status, total_charge, submitted_at, updated_at")
      .eq("organization_id", organizationId)
      .not("payer_profile_id", "is", null)
      .gte("submitted_at", periodStart)
      .lt("submitted_at", periodEnd);

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
      const existing =
        payerAggMap.get(claim.payer_profile_id) ??
        ({
          payerProfileId: claim.payer_profile_id,
          payerName: payerNameById.get(claim.payer_profile_id) ?? "Unknown payer",
          totalClaims: 0,
          acceptedClaims: 0,
          paidClaims: 0,
          rejectedClaims: 0,
          totalCharge: 0,
          turnaroundSamples: [],
        } satisfies PayerAgg);
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
    });
  } catch (error) {
    console.error("Billing reports API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Billing reports API failed" },
      { status: 500 },
    );
  }
}
