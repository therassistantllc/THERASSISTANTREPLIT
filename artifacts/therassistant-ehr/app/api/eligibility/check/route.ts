// File: app/api/eligibility/check/route.ts
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import type { EligibilityCheckResponse } from "@/types/integrations";
import { resolveBillingProviderIdentity } from "@/lib/providers/providerBillingIdentity";

function generateUuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function generateMockEligibilityResponse() {
  const today = new Date();
  const startDate = new Date(today.getFullYear(), 0, 1).toISOString().split("T")[0];
  const endDate = new Date(today.getFullYear(), 11, 31).toISOString().split("T")[0];

  return {
    eligibility_status: "active",
    coverage_start_date: startDate,
    coverage_end_date: endDate,
    copay_amount: 25.0,
    deductible_total: 1500.0,
    deductible_remaining: 850.0,
    coinsurance_percent: 20,
    out_of_pocket_max: 5000.0,
    out_of_pocket_remaining: 2300.0,
    plan_name: "Mock Insurance Plan (Sandbox)",
    coverage_level: "individual",
    response_summary: {
      sandbox_mode: true,
      message: "Sandbox eligibility response - mock data",
      benefits: {
        medical: {
          copay: 25.0,
          deductible_remaining: 850.0,
          coinsurance: 20,
        },
        active: true,
        coverage_dates: {
          start: startDate,
          end: endDate,
        },
      },
    },
  };
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { appointmentId, eligibilityCheckId } = body;

    if (!appointmentId && !eligibilityCheckId) {
      return NextResponse.json(
        { error: "Either appointmentId or eligibilityCheckId is required" },
        { status: 400 }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let eligibilityCheck: any = null;

    // Load existing eligibility check or find by appointment
    if (eligibilityCheckId) {
      const { data, error } = await supabase
        .from("eligibility_checks")
        .select("*")
        .eq("id", eligibilityCheckId)
        .single();

      if (error || !data) {
        return NextResponse.json(
          { error: "Eligibility check not found" },
          { status: 404 }
        );
      }

      eligibilityCheck = data;
    } else if (appointmentId) {
      // Try to find an existing eligibility check for this appointment
      const { data } = await supabase
        .from("eligibility_checks")
        .select("*")
        .eq("appointment_id", appointmentId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data) {
        eligibilityCheck = data;
      } else {
        // Create a new eligibility check if one doesn't exist
        const { data: appointment, error: apptError } = await supabase
          .from("appointments")
          .select("*")
          .eq("id", appointmentId)
          .single();

        if (apptError || !appointment) {
          return NextResponse.json(
            { error: "Appointment not found" },
            { status: 404 }
          );
        }

        if (!appointment.client_id) {
          return NextResponse.json(
            { error: "Appointment is missing client_id" },
            { status: 422 }
          );
        }

        const newCheckPayload = {
          id: generateUuid(),
          organization_id: appointment.organization_id,
          client_id: appointment.client_id,
          appointment_id: appointmentId,
          insurance_policy_id: appointment.insurance_policy_id,
          eligibility_status: "not_checked" as const,
          created_at: new Date().toISOString(),
        };

        const { data: newCheck, error: createError } = await supabase
          .from("eligibility_checks")
          .insert(newCheckPayload)
          .select()
          .single();

        if (createError || !newCheck) {
          return NextResponse.json(
            { error: "Failed to create eligibility check" },
            { status: 500 }
          );
        }

        eligibilityCheck = newCheck;
      }
    }

    const orgId = eligibilityCheck.organization_id;
    const now = new Date().toISOString();

    // Resolve actual provider NPI from canonical credentialing profile
    const billingId = await resolveBillingProviderIdentity({ organizationId: orgId });
    const providerNpi = billingId.billingProvider?.npi ?? "0000000000";
    const providerName = (billingId.billingProvider?.name ?? "PROVIDER").toUpperCase().slice(0, 35);

    // Get Office Ally clearinghouse connection
    const { data: connection } = await supabase
      .from("clearinghouse_connections")
      .select("*")
      .eq("organization_id", orgId)
      .eq("vendor", "office_ally")
      .eq("is_active", true)
      .maybeSingle();

    // Create EDI transaction record for sandbox 270/271
    const mockResponse = generateMockEligibilityResponse();

    const duplicateDetectionKey = `eligibility-${eligibilityCheck.client_id}-${eligibilityCheck.insurance_policy_id}-${now.slice(0, 10)}`;

    const transactionPayload = {
      id: generateUuid(),
      organization_id: orgId,
      client_id: eligibilityCheck.client_id,
      appointment_id: eligibilityCheck.appointment_id,
      clearinghouse_connection_id: connection?.id || null,
      transaction_type: "270",
      direction: "outbound",
      status: "parsed",
      control_number: duplicateDetectionKey,
      correlation_id: duplicateDetectionKey,
      request_payload: {
        client_id: eligibilityCheck.client_id,
        appointment_id: eligibilityCheck.appointment_id,
        insurance_policy_id: eligibilityCheck.insurance_policy_id,
        transaction_type: "270",
        service_type_code: "98",
      },
      response_payload: {
        transaction_type: "271",
        status: "active",
        ...mockResponse,
      },
      parsed_summary: mockResponse.response_summary,
      raw_request: `ISA*00*          *00*          *ZZ*THERASSISTANT  *ZZ*OFFICEALLY    *${now.slice(0, 6)}*${now.slice(11, 15)}*U*00401*000000001*0*T*:~
GS*HS*THERASSISTANT*OFFICEALLY*${now.slice(0, 8)}*${now.slice(11, 15)}*1*X*004010X092~
ST*270*0001~
BHT*0022*13*${eligibilityCheck.id}*${now.slice(0, 8)}*${now.slice(11, 19)}~
HL*1**20*1~
NM1*PR*2*MOCK PAYER*****PI*MOCKPAYER~
HL*2*1*21*1~
NM1*1P*2*${providerName}*****XX*${providerNpi}~
HL*3*2*22*0~
TRN*1*${eligibilityCheck.id}~
NM1*IL*1*DOE*JOHN****MI*${eligibilityCheck.client_id}~
DMG*D8*19800101~
DTP*291*D8*${now.slice(0, 8)}~
EQ*98~
SE*14*0001~
GE*1*1~
IEA*1*000000001~`,
      raw_response: `ISA*00*          *00*          *ZZ*OFFICEALLY    *ZZ*THERASSISTANT  *${now.slice(0, 6)}*${now.slice(11, 15)}*U*00401*000000001*0*T*:~
GS*HB*OFFICEALLY*THERASSISTANT*${now.slice(0, 8)}*${now.slice(11, 15)}*1*X*004010X092~
ST*271*0001~
BHT*0022*11*${eligibilityCheck.id}*${now.slice(0, 8)}*${now.slice(11, 19)}~
HL*1**20*1~
NM1*PR*2*MOCK INSURANCE*****PI*MOCKPAYER~
HL*2*1*21*1~
NM1*1P*2*${providerName}*****XX*${providerNpi}~
HL*3*2*22*0~
TRN*2*${eligibilityCheck.id}~
NM1*IL*1*DOE*JOHN****MI*${eligibilityCheck.client_id}~
N3*123 MAIN ST~
N4*ANYTOWN*CA*12345~
DMG*D8*19800101~
DTP*291*RD8*${mockResponse.coverage_start_date.replace(/-/g, "")}-${mockResponse.coverage_end_date.replace(/-/g, "")}~
EB*1**98**${mockResponse.plan_name}~
EB*A*IND**98~
SE*17*0001~
GE*1*1~
IEA*1*000000001~`,
      sent_at: now,
      received_at: now,
      created_at: now,
    };

    const { data: transaction, error: txnError } = await supabase
      .from("edi_transactions")
      .insert(transactionPayload)
      .select()
      .single();

    if (txnError) {
      console.error("Failed to create transaction:", txnError);
      return NextResponse.json(
        { error: "Failed to create transaction record" },
        { status: 500 }
      );
    }

    // Update eligibility_checks with sandbox response
    const updatePayload = {
      eligibility_status: mockResponse.eligibility_status,
      checked_at: now,
      coverage_start_date: mockResponse.coverage_start_date,
      coverage_end_date: mockResponse.coverage_end_date,
      copay_amount: mockResponse.copay_amount,
      deductible_remaining: mockResponse.deductible_remaining,
      out_of_pocket_remaining: mockResponse.out_of_pocket_remaining,
      response_summary: mockResponse.response_summary,
      external_transaction_id: transaction.id,
      updated_at: now,
    };

    const { data: updatedCheck, error: updateError } = await supabase
      .from("eligibility_checks")
      .update(updatePayload)
      .eq("id", eligibilityCheck.id)
      .select()
      .single();

    if (updateError) {
      console.error("Failed to update eligibility check:", updateError);
      return NextResponse.json(
        { error: "Failed to update eligibility check" },
        { status: 500 }
      );
    }

    const response: EligibilityCheckResponse = {
      success: true,
      message: "Eligibility check completed successfully (sandbox mode)",
      eligibilityCheck: {
        id: updatedCheck.id,
        eligibility_status: updatedCheck.eligibility_status ?? "unknown",
        checked_at: updatedCheck.checked_at ?? now,
        coverage_start_date: updatedCheck.coverage_start_date,
        coverage_end_date: updatedCheck.coverage_end_date,
        copay_amount: updatedCheck.copay_amount,
        deductible_remaining: updatedCheck.deductible_remaining,
        out_of_pocket_remaining: updatedCheck.out_of_pocket_remaining,
        response_summary:
          updatedCheck.response_summary && typeof updatedCheck.response_summary === "object"
            ? (updatedCheck.response_summary as Record<string, unknown>)
            : undefined,
        external_transaction_id: updatedCheck.external_transaction_id,
      },
      transactionId: transaction.id,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Eligibility check error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Eligibility check failed",
        message: "Failed to perform eligibility check",
      },
      { status: 500 }
    );
  }
}
