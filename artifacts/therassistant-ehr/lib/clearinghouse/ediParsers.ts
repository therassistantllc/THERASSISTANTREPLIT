// File: lib/clearinghouse/ediParsers.ts
import { normalizeClaimStatusResponse, normalizeEligibilityResponse } from "@/lib/clearinghouse/normalizers";
import type {
  ClaimStatusResponseNormalized,
  EligibilityResponseNormalized,
} from "@/types/clearinghouse";

export function parseMock271Response(rawResponse: string, fallback: EligibilityResponseNormalized): EligibilityResponseNormalized {
  return normalizeEligibilityResponse({
    ...fallback,
    rawBenefits: {
      rawResponse,
      parsed: true,
    },
  });
}

export function parseMock277Response(rawResponse: string, fallback: ClaimStatusResponseNormalized): ClaimStatusResponseNormalized {
  return normalizeClaimStatusResponse({
    ...fallback,
    rawStatus: {
      rawResponse,
      parsed: true,
    },
  });
}
