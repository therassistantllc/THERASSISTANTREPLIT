import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
type DbRow = Record<string, unknown>;

function fullName(client: DbRow | null | undefined) {
  if (!client) return "Unknown client";
  const first = typeof client.first_name === "string" ? client.first_name : "";
  const last = typeof client.last_name === "string" ? client.last_name : "";
  return [first, last].filter(Boolean).join(" ") || "Unknown client";
}

function money(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

export async function GET(request: Request, context: { params: Promise<{ clientId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { clientId } = await context.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, date_of_birth, email, phone")
      .eq("organization_id", organizationId)
      .eq("id", clientId)
      .is("archived_at", null)
      .maybeSingle();

    if (clientError || !client) {
      return NextResponse.json({ success: false, error: "Patient not found" }, { status: 404 });
    }

    const { data: invoices, error: invoiceError } = await supabase
      .from("patient_invoices")
      .select("id, invoice_number, invoice_status, patient_responsibility_amount, paid_amount, balance_amount, source, created_at, updated_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    if (invoiceError) throw invoiceError;

    const invoiceIds = (invoices ?? []).map((invoice: DbRow) => String(invoice.id));
    const { data: payments } = invoiceIds.length
      ? await supabase
          .from("patient_invoice_payments")
          .select("id, patient_invoice_id, payment_status, payment_method, amount, external_payment_id, memo, paid_at")
          .eq("organization_id", organizationId)
          .in("patient_invoice_id", invoiceIds)
          .is("archived_at", null)
          .order("paid_at", { ascending: false })
      : { data: [] as DbRow[] };

    const paymentsByInvoice = new Map<string, DbRow[]>();
    for (const payment of payments ?? []) {
      const invoiceId = String(payment.patient_invoice_id);
      const current = paymentsByInvoice.get(invoiceId) ?? [];
      current.push(payment);
      paymentsByInvoice.set(invoiceId, current);
    }

    const normalizedInvoices = (invoices ?? []).map((invoice: DbRow) => ({
      id: String(invoice.id),
      invoiceNumber: invoice.invoice_number,
      status: invoice.invoice_status,
      patientResponsibilityAmount: money(invoice.patient_responsibility_amount),
      paidAmount: money(invoice.paid_amount),
      balanceAmount: money(invoice.balance_amount),
      source: invoice.source,
      createdAt: invoice.created_at,
      updatedAt: invoice.updated_at,
      payments: paymentsByInvoice.get(String(invoice.id)) ?? [],
    }));

    const openBalance = normalizedInvoices
      .filter((invoice) => ["open", "sent", "collections"].includes(String(invoice.status)))
      .reduce((sum, invoice) => sum + invoice.balanceAmount, 0);

    const totalPaid = normalizedInvoices.reduce((sum, invoice) => sum + invoice.paidAmount, 0);
    const totalResponsibility = normalizedInvoices.reduce((sum, invoice) => sum + invoice.patientResponsibilityAmount, 0);

    // Pull insurance (ERA) payments + adjustments + write-offs to surface in the unified ledger
    const { data: claims } = await (supabase as any)
      .from("professional_claims")
      .select("id, claim_number, write_off_amount, total_charge, service_date_from, status")
      .eq("organization_id", organizationId)
      .eq("patient_id", clientId)
      .is("archived_at", null)
      .order("service_date_from", { ascending: false })
      .limit(200);

    const claimRows = (claims ?? []) as DbRow[];
    const claimIds = claimRows.map((c) => String(c.id));

    const { data: eraPayments } = claimIds.length
      ? await (supabase as any)
          .from("era_claim_payments")
          .select("id, professional_claim_id, clp04_payment_amount, adjustment_amount, check_eft_number, check_issue_date, created_at, posting_status")
          .eq("organization_id", organizationId)
          .in("professional_claim_id", claimIds)
          .is("archived_at", null)
          .order("check_issue_date", { ascending: false })
      : { data: [] as DbRow[] };

    const claimByCid = new Map<string, DbRow>();
    for (const c of claimRows) claimByCid.set(String(c.id), c);

    const insurancePayments = (eraPayments ?? []).map((row: DbRow) => {
      const claim = claimByCid.get(String(row.professional_claim_id));
      return {
        id: String(row.id),
        claimId: String(row.professional_claim_id ?? ""),
        claimNumber: claim ? String(claim.claim_number ?? "") : "",
        paymentAmount: money(row.clp04_payment_amount),
        adjustmentAmount: money(row.adjustment_amount),
        checkOrEft: row.check_eft_number ?? null,
        paidAt: row.check_issue_date ?? row.created_at ?? null,
        postingStatus: row.posting_status ?? null,
      };
    });

    const writeOffs = claimRows
      .filter((c) => Number(c.write_off_amount ?? 0) > 0)
      .map((c) => ({
        id: `wo:${String(c.id)}`,
        claimId: String(c.id),
        claimNumber: String(c.claim_number ?? ""),
        amount: money(c.write_off_amount),
        date: c.service_date_from ?? null,
      }));

    const openClaims = claimRows
      .filter((c) => {
        const totalCharge = Number(c.total_charge ?? 0);
        const writeOff = Number(c.write_off_amount ?? 0);
        return totalCharge - writeOff > 0;
      })
      .map((c) => ({
        id: String(c.id),
        claimNumber: String(c.claim_number ?? ""),
        serviceDate: c.service_date_from ?? null,
        totalCharge: money(c.total_charge),
        writeOff: money(c.write_off_amount ?? 0),
        outstanding: money(Number(c.total_charge ?? 0) - Number(c.write_off_amount ?? 0)),
        status: c.status ?? null,
      }));

    return NextResponse.json({
      success: true,
      organizationId,
      patient: {
        id: client.id,
        name: fullName(client),
        dateOfBirth: client.date_of_birth,
        email: client.email,
        phone: client.phone,
      },
      totals: {
        openBalance,
        totalPaid,
        totalResponsibility,
        invoiceCount: normalizedInvoices.length,
        insurancePaid: insurancePayments.reduce((s, p) => s + p.paymentAmount, 0),
        adjustmentsTotal: insurancePayments.reduce((s, p) => s + p.adjustmentAmount, 0),
        writeOffTotal: writeOffs.reduce((s, w) => s + w.amount, 0),
      },
      invoices: normalizedInvoices,
      insurancePayments,
      writeOffs,
      claims: openClaims,
    });
  } catch (error) {
    console.error("Patient balance API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Patient balance failed" },
      { status: 500 },
    );
  }
}
