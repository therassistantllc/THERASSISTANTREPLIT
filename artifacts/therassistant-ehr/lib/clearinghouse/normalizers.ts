// File: lib/clearinghouse/normalizers.ts
import type {
  ClaimStatusResponseNormalized,
  EligibilityResponseNormalized,
} from "@/types/clearinghouse";

export function normalizeEligibilityResponse(input: EligibilityResponseNormalized): EligibilityResponseNormalized {
  return {
    status: input.status,
    payerName: input.payerName ?? null,
    payerId: input.payerId ?? null,
    planName: input.planName ?? null,
    memberId: input.memberId ?? null,
    subscriberName: input.subscriberName ?? null,
    effectiveDate: input.effectiveDate ?? null,
    terminationDate: input.terminationDate ?? null,
    copayAmount: input.copayAmount ?? null,
    deductibleTotal: input.deductibleTotal ?? null,
    deductibleRemaining: input.deductibleRemaining ?? null,
    coinsurancePercent: input.coinsurancePercent ?? null,
    outOfPocketRemaining: input.outOfPocketRemaining ?? null,
    serviceTypeCode: input.serviceTypeCode ?? "98",
    message: input.message ?? null,
    rawBenefits: input.rawBenefits ?? {},
  };
}

export function normalizeClaimStatusResponse(input: ClaimStatusResponseNormalized): ClaimStatusResponseNormalized {
  return {
    status: input.status,
    payerName: input.payerName ?? null,
    payerId: input.payerId ?? null,
    statusCategoryCode: input.statusCategoryCode ?? null,
    statusCode: input.statusCode ?? null,
    entityCode: input.entityCode ?? null,
    billedAmount: input.billedAmount ?? null,
    paidAmount: input.paidAmount ?? null,
    checkEftNumber: input.checkEftNumber ?? null,
    finalizedDate: input.finalizedDate ?? null,
    payerMessage: input.payerMessage ?? null,
    rawStatus: input.rawStatus ?? {},
  };
}
