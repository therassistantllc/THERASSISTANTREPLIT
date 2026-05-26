/**
 * GET /api/billing/denied-claims
 * Returns professional_claims where claim_status = 'denied',
 * joined with client, payer, appointment/provider data.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

function str(v: unknown): string {
  return String(v ?? "").trim();
}
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const { organizationId } = guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase)
      return NextResponse.json({ success: false, error: "Database not available" }, { status: 500 });

    const { data, error } = await supabase
      .from("professional_claims")
      .select(
        `id, claim_number, claim_status, total_charge, patient_responsibility_amount,
         payer_responsibility_amount, denial_reason_code, denial_reason_description,
         first_billed_date, submitted_at, appeal_deadline_date, billing_notes,
         diagnosis_codes, place_of_service, prior_authorization_number,
         correction_status, correction_type, client_id, payer_profile_id, appointment_id,
         created_at, updated_at,
         clients(id, first_name, last_name, email),
         payer_profiles(payer_name),
         appointments(id, scheduled_start_at, provider_id,
                      providers(id, first_name, last_name, display_name))`,
      )
      .eq("organization_id", organizationId)
      .eq("claim_status", "denied")
      .is("archived_at", null)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    const rows = (data ?? []).map((r) => {
      const client = r.clients as unknown as Record<string, unknown> | null;
      const payer = r.payer_profiles as unknown as Record<string, unknown> | null;
      const appt = r.appointments as unknown as Record<string, unknown> | null;
      const provider = appt?.providers as Record<string, unknown> | null;
      const providerName =
        str(provider?.display_name) ||
        [str(provider?.first_name), str(provider?.last_name)].filter(Boolean).join(" ") ||
        null;
      const totalCharge = num(r.total_charge);
      const patientResp = num(r.patient_responsibility_amount);
      const payerPaid = num(r.payer_responsibility_amount);
      const adjAmt = totalCharge - patientResp - payerPaid;

      return {
        id: str(r.id),
        claimId: str(r.id),
        claimNumber: str(r.claim_number),
        claimStatus: str(r.claim_status),
        clientId: str(client?.id ?? r.client_id),
        clientName: client
          ? [str(client.first_name), str(client.last_name)].filter(Boolean).join(" ")
          : "—",
        payerName: str(payer?.payer_name) || "—",
        providerName,
        dateOfService: appt?.scheduled_start_at
          ? new Date(str(appt.scheduled_start_at)).toISOString().split("T")[0]
          : str(r.first_billed_date) || null,
        totalCharge,
        allowedAmount: payerPaid + patientResp,
        adjustmentAmount: adjAmt,
        patientResponsibility: patientResp,
        payerPaid,
        amountPaid: 0,
        denialReasonCode: str(r.denial_reason_code) || null,
        denialReasonDescription: str(r.denial_reason_description) || null,
        appealDeadline: str(r.appeal_deadline_date) || null,
        correctionStatus: str(r.correction_status) || null,
        correctionType: str(r.correction_type) || null,
        billingNotes: str(r.billing_notes) || null,
        submittedAt: str(r.submitted_at) || null,
        createdAt: str(r.created_at),
      };
    });

    return NextResponse.json({ success: true, rows, total: rows.length });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
