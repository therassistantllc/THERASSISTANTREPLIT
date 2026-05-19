// File: lib/clearinghouse/ClearinghouseAdapter.ts
import type {
  ClaimStatusRequestInput,
  ClaimStatusResponseNormalized,
  EligibilityRequestInput,
  EligibilityResponseNormalized,
} from "@/types/clearinghouse";

export interface ClearinghouseAdapter {
  runEligibility270(input: EligibilityRequestInput): Promise<{
    rawRequest: string;
    rawResponse: string;
    normalized: EligibilityResponseNormalized;
    controlNumber: string;
    correlationId: string;
  }>;

  runClaimStatus276(input: ClaimStatusRequestInput): Promise<{
    rawRequest: string;
    rawResponse: string;
    normalized: ClaimStatusResponseNormalized;
    controlNumber: string;
    correlationId: string;
  }>;
}
