// Pure helper that builds a row for eligibility_benefit_segments.
//
// Extracted from ClearinghouseService so the attribution-routing
// invariant ("parent and child rows must share the same client_id")
// is unit-testable without spinning up Supabase.

interface BenefitSegmentInput {
  serviceTypeCode?: string | null;
  eligibilityCode: string;
  coverageLevelCode?: string | null;
  insuranceTypeCode?: string | null;
  planCoverageDescription?: string | null;
  timePeriodQualifier?: string | null;
  monetaryAmount?: number | null;
  percent?: number | null;
  quantityQualifier?: string | null;
  quantity?: number | null;
  authorizationRequired?: string | boolean | null;
  inPlanNetworkCode?: string | null;
  messageText?: string | null;
  raw?: Record<string, unknown> | null;
  segmentIndex: number;
  category?: string | null;
  isRemaining?: boolean | null;
  isInNetwork?: boolean | null;
  benefitTier?: string | null;
  telemedicineFlag?: boolean | null;
}

export interface BuildBenefitSegmentRowArgs {
  /** eligibility_checks.id (parent row) */
  eligibilityCheckId: string;
  organizationId: string;
  /** routed owner — must equal eligibility_checks.client_id */
  routedClientId: string;
  payerId?: string | null;
  payerName?: string | null;
  segment: BenefitSegmentInput;
}

export function buildBenefitSegmentRow(args: BuildBenefitSegmentRowArgs) {
  const { eligibilityCheckId, organizationId, routedClientId, payerId, payerName, segment: s } = args;
  return {
    eligibility_check_id: eligibilityCheckId,
    organization_id: organizationId,
    client_id: routedClientId,
    payer_id: payerId ?? null,
    payer_name: payerName ?? null,
    service_type_code: s.serviceTypeCode ?? null,
    benefit_information_code: s.eligibilityCode,
    benefit_description:
      (s.raw && typeof s.raw === "object" && "eligibilityCodeMeaning" in (s.raw as Record<string, unknown>)
        ? String((s.raw as Record<string, unknown>).eligibilityCodeMeaning)
        : null) ?? null,
    coverage_level_code: s.coverageLevelCode ?? null,
    insurance_type_code: s.insuranceTypeCode ?? null,
    plan_coverage_description: s.planCoverageDescription ?? null,
    time_period_qualifier: s.timePeriodQualifier ?? null,
    monetary_amount: s.monetaryAmount ?? null,
    percent_amount: s.percent ?? null,
    quantity_qualifier: s.quantityQualifier ?? null,
    quantity: s.quantity ?? null,
    authorization_or_certification_required: s.authorizationRequired ?? null,
    in_plan_network_indicator: s.inPlanNetworkCode ?? null,
    messages: s.messageText ? [s.messageText] : [],
    raw_eb_segment: s.raw ?? {},
    segment_index: s.segmentIndex,
    category: s.category,
    is_remaining: s.isRemaining,
    is_in_network: s.isInNetwork ?? null,
    benefit_tier: s.benefitTier ?? null,
    telemedicine_flag: s.telemedicineFlag ?? null,
    message_text: s.messageText ?? null,
  };
}
