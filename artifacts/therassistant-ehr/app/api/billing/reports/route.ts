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
};

type ReportWorkqueue = {
  created: number;
  resolved: number;
  deferred: number;
  openNow: number;
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

    const submittedChargeTotal = (submittedClaims ?? []).reduce((sum, claim) => sum + Number(claim.total_charge ?? 0), 0);
    const postedPaymentTotal = (payments ?? []).reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);
    const openBalanceTotal = (openInvoices ?? []).reduce((sum, invoice) => sum + Number(invoice.balance_amount ?? 0), 0);

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

    const patientResponsibility: ReportPatientResponsibility = {
      openBalance: money(openBalanceTotal),
      invoiceCount: (openInvoices ?? []).length,
      collectionsCount: (openInvoices ?? []).filter((invoice) => invoice.invoice_status === "collections").length,
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
    });
  } catch (error) {
    console.error("Billing reports API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Billing reports API failed" },
      { status: 500 },
    );
  }
}
