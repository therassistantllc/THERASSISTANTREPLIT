import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
type DbRow = Record<string, unknown>;

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown) {
  return typeof value === "number" ? value : value === null || value === undefined ? null : Number(value);
}

function patientName(client: DbRow | null) {
  if (!client) return "Unknown client";
  return [asString(client.first_name), asString(client.last_name)].filter(Boolean).join(" ") || "Unknown client";
}

function policyDto(policy: DbRow) {
  return {
    id: asString(policy.id),
    planName: asString(policy.plan_name),
    policyNumber: asString(policy.policy_number),
    groupNumber: asString(policy.group_number),
    priority: asString(policy.priority),
    active: Boolean(policy.active_flag),
    effectiveDate: asString(policy.effective_date),
    terminationDate: asString(policy.termination_date),
    payerId: asString(policy.payer_id),
    payerName: asString((policy.insurance_payers as DbRow | null)?.payer_name),
    clearinghousePayerId: asString((policy.insurance_payers as DbRow | null)?.clearinghouse_payer_id),
  };
}

function eligibilityDto(row: DbRow, segments: DbRow[] = []) {
  const summary = (row.response_summary as Record<string, unknown> | null) ?? null;
  return {
    id: asString(row.id),
    status: asString(row.eligibility_status),
    checkedAt: asString(row.checked_at),
    copayAmount: asNumber(row.copay_amount),
    coinsurancePercent: asNumber(row.coinsurance_percent),
    deductibleTotal: asNumber(row.deductible_total),
    deductibleRemaining: asNumber(row.deductible_remaining),
    outOfPocketTotal: asNumber(row.out_of_pocket_total),
    outOfPocketRemaining: asNumber(row.out_of_pocket_remaining),
    maxCoverageAmount: asNumber(row.max_coverage_amount),
    maxCoveragePeriod: typeof row.max_coverage_period === "string" ? row.max_coverage_period : null,
    remainingCoverageAmount: asNumber(row.remaining_coverage_amount),
    remainingCoveragePeriod:
      typeof row.remaining_coverage_period === "string" ? row.remaining_coverage_period : null,
    telemedicineCovered: typeof row.telemedicine_covered === "boolean" ? row.telemedicine_covered : null,
    authorizationRequired: typeof row.authorization_required === "boolean" ? row.authorization_required : null,
    benefitTier: typeof row.benefit_tier === "string" ? row.benefit_tier : null,
    coverageStartDate: asString(row.coverage_start_date),
    coverageEndDate: asString(row.coverage_end_date),
    coverageLevel: typeof row.coverage_level === "string" ? row.coverage_level : null,
    serviceTypeCode: asString(row.service_type_code),
    planName: typeof row.plan_name === "string" ? row.plan_name : null,
    payerName: typeof row.payer_name === "string" ? row.payer_name : null,
    memberId: typeof row.member_id === "string" ? row.member_id : null,
    subscriberName: typeof row.subscriber_name === "string" ? row.subscriber_name : null,
    aaaErrors: Array.isArray(summary?.aaaErrors) ? (summary!.aaaErrors as unknown[]) : [],
    attribution: (summary?.attribution as Record<string, unknown> | null) ?? null,
    attributionDecision: (summary?.attributionDecision as Record<string, unknown> | null) ?? null,
    benefitSegments: segments.map((seg) => ({
      id: asString(seg.id),
      segmentIndex: asNumber(seg.segment_index),
      category: typeof seg.category === "string" ? seg.category : null,
      eligibilityCode: asString(seg.benefit_information_code),
      eligibilityCodeMeaning: typeof seg.benefit_description === "string" ? seg.benefit_description : null,
      coverageLevelCode: typeof seg.coverage_level_code === "string" ? seg.coverage_level_code : null,
      serviceTypeCode: typeof seg.service_type_code === "string" ? seg.service_type_code : null,
      planCoverageDescription:
        typeof seg.plan_coverage_description === "string" ? seg.plan_coverage_description : null,
      timePeriodQualifier: typeof seg.time_period_qualifier === "string" ? seg.time_period_qualifier : null,
      monetaryAmount: asNumber(seg.monetary_amount),
      percent: asNumber(seg.percent_amount),
      quantityQualifier: typeof seg.quantity_qualifier === "string" ? seg.quantity_qualifier : null,
      quantity: asNumber(seg.quantity),
      authorizationRequired:
        typeof seg.authorization_or_certification_required === "boolean"
          ? seg.authorization_or_certification_required
          : null,
      inPlanNetworkCode:
        typeof seg.in_plan_network_indicator === "string" ? seg.in_plan_network_indicator : null,
      isInNetwork: typeof seg.is_in_network === "boolean" ? seg.is_in_network : null,
      isRemaining: typeof seg.is_remaining === "boolean" ? seg.is_remaining : null,
      benefitTier: typeof seg.benefit_tier === "string" ? seg.benefit_tier : null,
      telemedicineFlag: typeof seg.telemedicine_flag === "boolean" ? seg.telemedicine_flag : null,
      messageText: typeof seg.message_text === "string" ? seg.message_text : null,
    })),
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
      return NextResponse.json({ success: false, error: "Client not found" }, { status: 404 });
    }

    const { data: policies, error: policiesError } = await supabase
      .from("insurance_policies")
      .select("id, plan_name, policy_number, group_number, priority, active_flag, effective_date, termination_date, payer_id, insurance_payers:payer_id(payer_name, clearinghouse_payer_id)")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("priority", { ascending: true });

    if (policiesError) {
      return NextResponse.json({ success: false, error: policiesError.message }, { status: 422 });
    }

    const { data: checks, error: checksError } = await supabase
      .from("eligibility_checks")
      .select(
        "id, eligibility_status, checked_at, copay_amount, coinsurance_percent, deductible_total, deductible_remaining, out_of_pocket_total, out_of_pocket_remaining, max_coverage_amount, max_coverage_period, remaining_coverage_amount, remaining_coverage_period, telemedicine_covered, authorization_required, benefit_tier, coverage_start_date, coverage_end_date, coverage_level, service_type_code, plan_name, payer_name, member_id, subscriber_name, response_summary, raw_response, error_message, insurance_policy_id",
      )
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("checked_at", { ascending: false });

    if (checksError) {
      return NextResponse.json({ success: false, error: checksError.message }, { status: 422 });
    }

    const checkRows = (checks ?? []) as DbRow[];
    const checkIds = checkRows.map((row) => String(row.id)).filter(Boolean);

    const segmentsByCheck = new Map<string, DbRow[]>();
    if (checkIds.length > 0) {
      const { data: segs } = await supabase
        .from("eligibility_benefit_segments")
        .select(
          "eligibility_check_id, id, segment_index, category, benefit_information_code, benefit_description, coverage_level_code, service_type_code, plan_coverage_description, time_period_qualifier, monetary_amount, percent_amount, quantity_qualifier, quantity, authorization_or_certification_required, in_plan_network_indicator, is_in_network, is_remaining, benefit_tier, telemedicine_flag, message_text",
        )
        .in("eligibility_check_id", checkIds)
        .order("segment_index", { ascending: true });
      for (const seg of (segs ?? []) as DbRow[]) {
        const key = String(seg.eligibility_check_id ?? "");
        if (!key) continue;
        const arr = segmentsByCheck.get(key) ?? [];
        arr.push(seg);
        segmentsByCheck.set(key, arr);
      }
    }

    const checkDtos = checkRows.map((row) =>
      eligibilityDto(row, segmentsByCheck.get(String(row.id)) ?? []),
    );

    return NextResponse.json({
      success: true,
      client: {
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
    console.error("Client eligibility detail API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Client eligibility detail failed" },
      { status: 500 },
    );
  }
}
