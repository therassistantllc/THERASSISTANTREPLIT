import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

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
    const organizationId = searchParams.get("organizationId");

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

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
      },
      invoices: normalizedInvoices,
    });
  } catch (error) {
    console.error("Patient balance API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Patient balance failed" },
      { status: 500 },
    );
  }
}
