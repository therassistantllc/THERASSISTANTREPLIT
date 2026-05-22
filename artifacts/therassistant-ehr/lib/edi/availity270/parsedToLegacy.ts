// Bridge: convert a `Parsed271Response` (foundation shape) into the legacy
// `EligibilityResponseNormalized` consumed by `ClearinghouseService`.
//
// Phase 5 wires in the typed financial-responsibility rollup from
// `parse271`'s `annotateBenefits` pass plus a normalized per-segment
// breakdown for `eligibility_benefit_segments`. The CORE Data Content
// Rule vEB.2.1 §1.3.2.5–§1.3.2.13 fields (telemedicine, auth/cert,
// tiered, max/remaining coverage) flow through as flat columns; the
// per-segment list flows through `benefitSegments` and is persisted by
// ClearinghouseService after the check row is created.

import type { EligibilityResponseNormalized, NormalizedBenefitSegment } from "@/types/clearinghouse";
import type { Parsed271Response, ParsedEB271 } from "./types";

function toBenefitSegment(b: ParsedEB271, index: number): NormalizedBenefitSegment {
  const inPlanNetworkCode = b.inPlanNetwork ?? null;
  const isInNetwork =
    inPlanNetworkCode === "Y"
      ? true
      : inPlanNetworkCode === "N"
      ? false
      : null;

  return {
    segmentIndex: index,
    category: b.category ?? "other",
    isRemaining: b.isRemaining ?? false,
    isInNetwork,
    eligibilityCode: b.eligibilityCode,
    coverageLevelCode: b.coverageLevelCode ?? null,
    serviceTypeCode: b.serviceTypeCode ?? null,
    insuranceTypeCode: b.insuranceTypeCode ?? null,
    planCoverageDescription: b.planDescription ?? null,
    timePeriodQualifier: b.timePeriodQualifier ?? null,
    monetaryAmount: b.monetaryAmount ?? null,
    percent: b.percent ?? null,
    quantityQualifier: b.quantityQualifier ?? null,
    quantity: b.quantity ?? null,
    authorizationRequired: b.authorizationRequired ?? null,
    inPlanNetworkCode,
    benefitTier: b.tier ?? null,
    telemedicineFlag: b.telemedicineFlag ?? null,
    messageText: b.messageText ?? null,
    raw: {
      eligibilityCodeMeaning: b.eligibilityCodeMeaning,
      coverageLevelMeaning: b.coverageLevelMeaning ?? null,
      timePeriodQualifierMeaning: b.timePeriodQualifierMeaning ?? null,
      followingSegments: b.followingSegments ?? [],
    },
  };
}

export function parsed271ToLegacyNormalized(
  parsed: Parsed271Response,
  fallbackServiceTypeCode = "98",
): EligibilityResponseNormalized {
  const financials = parsed.financials ?? {
    copayAmount: null,
    coinsurancePercent: null,
    deductibleTotal: null,
    deductibleRemaining: null,
    outOfPocketTotal: null,
    outOfPocketRemaining: null,
    maxCoverageAmount: null,
    maxCoveragePeriod: null,
    remainingCoverageAmount: null,
    remainingCoveragePeriod: null,
    authorizationRequired: null,
    telemedicineCovered: null,
    benefitTier: null,
  };

  let message: string | null = null;
  if (parsed.aaaErrors.length > 0) {
    message = parsed.aaaErrors
      .map((e) => `${e.code ? `[${e.code}] ` : ""}${e.description}${e.followUpAction ? ` — ${e.followUpAction}` : ""}`)
      .join("; ");
  } else if (parsed.messages.length > 0) {
    message = parsed.messages.slice(0, 5).join(" | ");
  }

  const benefitSegments = parsed.benefits.map((b, i) => toBenefitSegment(b, i));

  return {
    status: parsed.status,
    payerName: parsed.payerName ?? null,
    payerId: parsed.payerId ?? null,
    planName: parsed.planName ?? null,
    memberId: parsed.memberId ?? null,
    subscriberName:
      [parsed.subscriberFirstName, parsed.subscriberLastName].filter(Boolean).join(" ") || null,
    effectiveDate: parsed.effectiveDate ?? null,
    terminationDate: parsed.terminationDate ?? null,
    copayAmount: financials.copayAmount,
    coinsurancePercent: financials.coinsurancePercent,
    deductibleTotal: financials.deductibleTotal,
    deductibleRemaining: financials.deductibleRemaining,
    outOfPocketRemaining: financials.outOfPocketRemaining,
    outOfPocketTotal: financials.outOfPocketTotal,
    telemedicineCovered: financials.telemedicineCovered,
    authorizationRequired: financials.authorizationRequired,
    benefitTier: financials.benefitTier,
    maxCoverageAmount: financials.maxCoverageAmount,
    maxCoveragePeriod: financials.maxCoveragePeriod,
    remainingCoverageAmount: financials.remainingCoverageAmount,
    remainingCoveragePeriod: financials.remainingCoveragePeriod,
    coverageLevel:
      parsed.benefits[0]?.coverageLevelMeaning ?? parsed.benefits[0]?.coverageLevelCode ?? null,
    serviceTypeCode: parsed.benefits[0]?.serviceTypeCode ?? fallbackServiceTypeCode,
    message,
    benefitSegments,
    rawBenefits: {
      parsed271: parsed as unknown as Record<string, unknown>,
    },
  };
}
