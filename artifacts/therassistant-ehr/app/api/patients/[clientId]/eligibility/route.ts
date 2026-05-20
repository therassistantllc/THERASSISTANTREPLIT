import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";

type DbRow = Record<string, unknown>;

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown) {
  return typeof value === "number" ? value : value === null || value === undefined ? null : Number(value);
}

function patientName(client: DbRow | null) {
  if (!client) return "Unknown patient";
  return [asString(client.first_name), asString(client.last_name)].filter(Boolean).join(" ") || "Unknown patient";
}

function policyDto(policy: DbRow) {
  return {
    id: asString(policy.id),
    planName: asString(policy.plan_name),
    policyNumber: asString(policy.policy_number),
    priority: asString(policy.priority),
    active: Boolean(policy.active_flag),
    effectiveDate: asString(policy.effective_date),
    terminationDate: asString(policy.termination_date),
    payerId: asString(policy.payer_id),
    payerName: asString((policy.insurance_payers as DbRow | null)?.payer_name),
    clearinghousePayerId: asString((policy.insurance_payers as DbRow | null)?.clearinghouse_payer_id),
  };
}

function eligibilityDto(row: DbRow) {
  return {
    id: asString(row.id),
    status: asString(row.eligibility_status),
    checkedAt: asString(row.checked_at),
    copayAmount: asNumber(row.copay_amount),
    deductibleRemaining: asNumber(row.deductible_remaining),
    coverageStartDate: asString(row.coverage_start_date),
    coverageEndDate: asString(row.coverage_end_date),
    coverageLevel: typeof row.coverage_level === "string" ? row.coverage_level : null,
    serviceTypeCode: asString(row.service_type_code),
    responseSummary: row.response_summary ?? null,
    rawResponse: row.raw_response ?? null,
    errorMessage: asString(row.error_message),
    insurancePolicyId: asString(row.insurance_policy_id),
  };
}

export async function GET(request: Request, context: { params: Promise<{ clientId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { clientId } = await context.params;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;

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

    const { data: policies, error: policiesError } = await supabase
      .from("insurance_policies")
      .select("id, plan_name, policy_number, priority, active_flag, effective_date, termination_date, payer_id, insurance_payers:payer_id(payer_name, clearinghouse_payer_id)")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("priority", { ascending: true });

    if (policiesError) {
      return NextResponse.json({ success: false, error: policiesError.message }, { status: 422 });
    }

    const { data: checks, error: checksError } = await supabase
      .from("eligibility_checks")
      .select("id, eligibility_status, checked_at, copay_amount, deductible_remaining, coverage_start_date, coverage_end_date, coverage_level, service_type_code, response_summary, raw_response, error_message, insurance_policy_id")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("checked_at", { ascending: false })
      .limit(25);

    if (checksError) {
      return NextResponse.json({ success: false, error: checksError.message }, { status: 422 });
    }

    const checkDtos = ((checks ?? []) as DbRow[]).map(eligibilityDto);

    return NextResponse.json({
      success: true,
      patient: {
        id: asString((client as DbRow).id),
        name: patientName(client as DbRow),
        dateOfBirth: asString((client as DbRow).date_of_birth),
        email: asString((client as DbRow).email),
        phone: asString((client as DbRow).phone),
      },
      policies: ((policies ?? []) as DbRow[]).map(policyDto),
      latestEligibility: checkDtos[0] ?? null,
      eligibilityHistory: checkDtos,
    });
  } catch (error) {
    console.error("Patient eligibility detail API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Patient eligibility detail failed" },
      { status: 500 },
    );
  }
}
