/**
 * GET /api/billing/patient-balances
 * Returns professional_claims with patient_responsibility_amount > 0,
 * joined with client, payer, and appointment/provider data.
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
         payer_responsibility_amount, denial_reason_code, first_billed_date, billing_notes,
         diagnosis_codes, place_of_service, prior_authorization_number, client_id,
         payer_profile_id, appointment_id, created_at, updated_at,
         clients(id, first_name, last_name, email, phone,
                 stripe_payment_method_id, stripe_customer_id,
                 stripe_payment_method_brand, stripe_payment_method_last4,
                 stripe_payment_method_exp_month, stripe_payment_method_exp_year,
                 autopay_enabled),
         payer_profiles(payer_name),
         appointments(id, scheduled_start_at, provider_id,
                      providers(id, first_name, last_name, display_name, npi))`,
      )
      .eq("organization_id", organizationId)
      .gt("patient_responsibility_amount", 0)
      .is("archived_at", null)
      .is("write_off_at", null)
      .not("claim_status", "in", '("draft","archived")')
      .order("created_at", { ascending: false });

    if (error) throw error;

    const rows = (data ?? []).map((r) => {
      const client = r.clients as unknown as Record<string, unknown> | null;
      const payer = r.payer_profiles as unknown as Record<string, unknown> | null;
      const appt = r.appointments as unknown as Record<string, unknown> | null;
      const provider = appt?.providers as Record<string, unknown> | null;

      const hasCard = Boolean(client?.stripe_payment_method_id);
      const cardBrand = str(client?.stripe_payment_method_brand) || null;
      const cardLast4 = str(client?.stripe_payment_method_last4) || null;
      const autopay = Boolean(client?.autopay_enabled);
      const providerName =
        str(provider?.display_name) ||
        [str(provider?.first_name), str(provider?.last_name)].filter(Boolean).join(" ") ||
        null;

      return {
        id: str(r.id),
        claimId: str(r.id),
        claimNumber: str(r.claim_number),
        claimStatus: str(r.claim_status),
        clientId: str(client?.id ?? r.client_id),
        clientName: client
          ? [str(client.first_name), str(client.last_name)].filter(Boolean).join(" ")
          : "—",
        clientEmail: str(client?.email) || null,
        clientPhone: str(client?.phone) || null,
        payerName: str(payer?.payer_name) || "—",
        providerName,
        providerId: str(provider?.id) || null,
        dateOfService: appt?.scheduled_start_at
          ? new Date(str(appt.scheduled_start_at)).toISOString().split("T")[0]
          : str(r.first_billed_date) || null,
        totalCharge: num(r.total_charge),
        patientResponsibility: num(r.patient_responsibility_amount),
        payerPaid: num(r.payer_responsibility_amount),
        amountPaid: 0, // placeholder — client payments not yet tracked separately
        adjustmentAmount: num(r.total_charge) - num(r.patient_responsibility_amount) - num(r.payer_responsibility_amount),
        diagnosisCodes: Array.isArray(r.diagnosis_codes) ? (r.diagnosis_codes as string[]) : [],
        placeOfService: str(r.place_of_service),
        priorAuthNumber: str(r.prior_authorization_number) || null,
        billingNotes: str(r.billing_notes) || null,
        hasCardOnFile: hasCard,
        cardSummary: hasCard && cardLast4 ? `${cardBrand ?? "Card"} ••••${cardLast4}` : null,
        autopayEnabled: autopay,
        createdAt: str(r.created_at),
      };
    });

    return NextResponse.json({ success: true, rows });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
