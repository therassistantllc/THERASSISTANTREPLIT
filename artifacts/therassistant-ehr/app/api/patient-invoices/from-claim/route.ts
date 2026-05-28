import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { markPatientInvoiceSent } from "@/lib/payments/patientInvoicePaymentService";
import { attemptAutopayForInvoice } from "@/lib/payments/autopayService";

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const body = await request.json().catch(() => ({}));
    const guard = await requireBillingAccess({ requestedOrganizationId: body?.organizationId ?? null });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const claimId = String(body?.claimId ?? "").trim();
    if (!claimId) {
      return NextResponse.json({ success: false, error: "claimId is required" }, { status: 400 });
    }

    const { data: claim, error: claimErr } = await (supabase as any)
      .from("professional_claims")
      .select("id, organization_id, patient_id, claim_number, total_charge, write_off_amount")
      .eq("organization_id", organizationId)
      .eq("id", claimId)
      .maybeSingle();

    if (claimErr) throw claimErr;
    if (!claim) {
      return NextResponse.json({ success: false, error: "Claim not found" }, { status: 404 });
    }
    if (!claim.patient_id) {
      return NextResponse.json({ success: false, error: "Claim has no responsible client" }, { status: 422 });
    }

    const totalCharge = Number(claim.total_charge ?? 0);
    const writeOff = Number(claim.write_off_amount ?? 0);
    const requestedAmount = body?.amount != null ? Number(body.amount) : totalCharge - writeOff;
    const amount = Math.round(Math.max(0, requestedAmount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, error: "Outstanding balance is zero" }, { status: 422 });
    }

    const invoiceNumber = `INV-${(claim.claim_number || claim.id).toString().slice(0, 16)}-${Date.now()
      .toString()
      .slice(-6)}`;

    const { data: invoice, error: invoiceErr } = await (supabase as any)
      .from("patient_invoices")
      .insert({
        organization_id: organizationId,
        client_id: claim.patient_id,
        professional_claim_id: claim.id,
        invoice_status: "open",
        invoice_number: invoiceNumber,
        patient_responsibility_amount: amount,
        paid_amount: 0,
        balance_amount: amount,
        source: "denied_claim",
      })
      .select("id")
      .single();

    if (invoiceErr) throw invoiceErr;
    const invoiceId = String(invoice?.id ?? "");

    const sentResult = await markPatientInvoiceSent({
      organizationId,
      patientInvoiceId: invoiceId,
    });

    // Best-effort autopay: if the client has autopay on with a saved
    // card, charge the new invoice immediately. Never fails the request —
    // failures get surfaced into the Client Billing queue separately.
    const autopayResult = await attemptAutopayForInvoice({
      organizationId,
      patientInvoiceId: invoiceId,
    }).catch((err) => ({
      attempted: false,
      ok: false,
      code: "failed" as const,
      message: err instanceof Error ? err.message : "Autopay attempt threw",
    }));

    const { data: patientRow } = await (supabase as any)
      .from("clients")
      .select("first_name, last_name")
      .eq("id", claim.patient_id)
      .maybeSingle();

    const patientName = patientRow
      ? [patientRow.first_name, patientRow.last_name].filter(Boolean).join(" ")
      : "client";

    return NextResponse.json({
      success: sentResult.ok,
      invoiceId,
      patientName,
      amount,
      sentResult,
      autopayResult,
    });
  } catch (error) {
    console.error("Client invoice from-claim error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create client invoice" },
      { status: 500 },
    );
  }
}
