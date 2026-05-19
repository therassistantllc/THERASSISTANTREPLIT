import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export interface RecordPatientInvoicePaymentInput {
  organizationId: string;
  patientInvoiceId: string;
  amount: number;
  paymentMethod?: "manual" | "cash" | "check" | "card" | "stripe" | "portal" | "other";
  externalPaymentId?: string | null;
  memo?: string | null;
  paidAt?: string | null;
}

export interface PatientInvoiceActionInput {
  organizationId: string;
  patientInvoiceId: string;
  memo?: string | null;
}

export interface PatientInvoicePaymentResult {
  ok: boolean;
  invoiceId: string;
  paymentId: string | null;
  invoiceStatus: string | null;
  balanceAmount: number | null;
  errors: Array<{ field: string; message: string }>;
}

type InvoiceRow = {
  id: string;
  organization_id: string;
  client_id: string;
  invoice_status: string;
  patient_responsibility_amount: number;
  paid_amount: number;
  balance_amount: number;
};

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

async function loadInvoice(organizationId: string, invoiceId: string) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("patient_invoices")
    .select("id, organization_id, client_id, invoice_status, patient_responsibility_amount, paid_amount, balance_amount")
    .eq("organization_id", organizationId)
    .eq("id", invoiceId)
    .is("archived_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as InvoiceRow | null;
}

export async function recordPatientInvoicePayment(
  input: RecordPatientInvoicePaymentInput,
): Promise<PatientInvoicePaymentResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: null,
      balanceAmount: null,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const invoice = await loadInvoice(input.organizationId, input.patientInvoiceId);
  if (!invoice) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: null,
      balanceAmount: null,
      errors: [{ field: "patient_invoices", message: "Patient invoice not found" }],
    };
  }

  if (["paid", "voided"].includes(invoice.invoice_status)) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: invoice.invoice_status,
      balanceAmount: Number(invoice.balance_amount),
      errors: [{ field: "invoice_status", message: `Cannot post payment to invoice with status ${invoice.invoice_status}` }],
    };
  }

  const amount = roundMoney(Number(input.amount ?? 0));
  if (amount <= 0) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: invoice.invoice_status,
      balanceAmount: Number(invoice.balance_amount),
      errors: [{ field: "amount", message: "Payment amount must be greater than zero" }],
    };
  }

  const currentPaid = Number(invoice.paid_amount ?? 0);
  const currentBalance = Number(invoice.balance_amount ?? 0);
  const newPaidAmount = roundMoney(currentPaid + amount);
  const newBalance = roundMoney(Math.max(currentBalance - amount, 0));
  const newStatus = newBalance <= 0 ? "paid" : invoice.invoice_status === "draft" ? "open" : invoice.invoice_status;

  const { data: payment, error: paymentError } = await supabase
    .from("patient_invoice_payments")
    .insert({
      organization_id: input.organizationId,
      patient_invoice_id: input.patientInvoiceId,
      client_id: invoice.client_id,
      payment_status: "posted",
      payment_method: input.paymentMethod ?? "manual",
      amount,
      external_payment_id: input.externalPaymentId ?? null,
      memo: input.memo ?? null,
      paid_at: input.paidAt ?? new Date().toISOString(),
    })
    .select("id")
    .single();

  if (paymentError || !payment) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: invoice.invoice_status,
      balanceAmount: Number(invoice.balance_amount),
      errors: [{ field: "patient_invoice_payments", message: paymentError?.message ?? "Failed to create payment" }],
    };
  }

  const { error: invoiceUpdateError } = await supabase
    .from("patient_invoices")
    .update({
      paid_amount: newPaidAmount,
      balance_amount: newBalance,
      invoice_status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.patientInvoiceId);

  if (invoiceUpdateError) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: String(payment.id),
      invoiceStatus: invoice.invoice_status,
      balanceAmount: Number(invoice.balance_amount),
      errors: [{ field: "patient_invoices", message: invoiceUpdateError.message }],
    };
  }

  return {
    ok: true,
    invoiceId: input.patientInvoiceId,
    paymentId: String(payment.id),
    invoiceStatus: newStatus,
    balanceAmount: newBalance,
    errors: [],
  };
}

export async function markPatientInvoiceSent(input: PatientInvoiceActionInput): Promise<PatientInvoicePaymentResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: null,
      balanceAmount: null,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const invoice = await loadInvoice(input.organizationId, input.patientInvoiceId);
  if (!invoice) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: null,
      balanceAmount: null,
      errors: [{ field: "patient_invoices", message: "Patient invoice not found" }],
    };
  }

  if (["paid", "voided"].includes(invoice.invoice_status)) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: invoice.invoice_status,
      balanceAmount: Number(invoice.balance_amount),
      errors: [{ field: "invoice_status", message: `Cannot mark invoice ${invoice.invoice_status} as sent` }],
    };
  }

  const { error } = await supabase
    .from("patient_invoices")
    .update({ invoice_status: "sent", updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("id", input.patientInvoiceId);

  if (error) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: invoice.invoice_status,
      balanceAmount: Number(invoice.balance_amount),
      errors: [{ field: "patient_invoices", message: error.message }],
    };
  }

  return {
    ok: true,
    invoiceId: input.patientInvoiceId,
    paymentId: null,
    invoiceStatus: "sent",
    balanceAmount: Number(invoice.balance_amount),
    errors: [],
  };
}

export async function voidPatientInvoice(input: PatientInvoiceActionInput): Promise<PatientInvoicePaymentResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: null,
      balanceAmount: null,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const invoice = await loadInvoice(input.organizationId, input.patientInvoiceId);
  if (!invoice) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: null,
      balanceAmount: null,
      errors: [{ field: "patient_invoices", message: "Patient invoice not found" }],
    };
  }

  if (invoice.invoice_status === "paid") {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: invoice.invoice_status,
      balanceAmount: Number(invoice.balance_amount),
      errors: [{ field: "invoice_status", message: "Paid invoices cannot be voided by this workflow" }],
    };
  }

  const { error } = await supabase
    .from("patient_invoices")
    .update({
      invoice_status: "voided",
      balance_amount: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.patientInvoiceId);

  if (error) {
    return {
      ok: false,
      invoiceId: input.patientInvoiceId,
      paymentId: null,
      invoiceStatus: invoice.invoice_status,
      balanceAmount: Number(invoice.balance_amount),
      errors: [{ field: "patient_invoices", message: error.message }],
    };
  }

  return {
    ok: true,
    invoiceId: input.patientInvoiceId,
    paymentId: null,
    invoiceStatus: "voided",
    balanceAmount: 0,
    errors: [],
  };
}
