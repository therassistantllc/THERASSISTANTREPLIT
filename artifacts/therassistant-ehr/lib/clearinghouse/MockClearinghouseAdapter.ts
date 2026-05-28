// File: lib/clearinghouse/MockClearinghouseAdapter.ts
import { buildMock270Request, buildMock276Request } from "@/lib/clearinghouse/ediBuilders";
import { parseMock271Response, parseMock277Response } from "@/lib/clearinghouse/ediParsers";
import type { ClearinghouseAdapter } from "@/lib/clearinghouse/ClearinghouseAdapter";
import type { CoreEligibilityAdapter, CoreEligibilityRunResult } from "@/lib/clearinghouse/pickEligibilityAdapter";
import type { Eligibility270Input } from "@/lib/edi/availity270/types";
import type {
  ClaimStatusRequestInput,
  ClaimStatusResponseNormalized,
  EligibilityRequestInput,
  EligibilityResponseNormalized,
} from "@/types/clearinghouse";

function buildControlNumber(seed: string): string {
  const suffix = seed.replace(/[^0-9]/g, "").slice(-6).padStart(6, "0");
  return `CH${suffix}`;
}

function buildCorrelationId(seed: string): string {
  return `corr-${seed.replace(/[^a-zA-Z0-9]/g, "").slice(-16) || "mock"}`;
}

function mockEligibilityStatus(memberId?: string | null): EligibilityResponseNormalized["status"] {
  const last = String(memberId ?? "").slice(-1);
  if (last === "0") return "inactive";
  if (last === "9") return "not_found";
  return "active";
}

function mockClaimStatus(input: ClaimStatusRequestInput): ClaimStatusResponseNormalized["status"] {
  const current = String(input.currentClaimStatus ?? "").toLowerCase();
  if (current.includes("denied")) return "denied";
  if (current.includes("paid")) return "paid";
  if ((input.claimAmount ?? 0) > 1000) return "pending";
  return current.includes("reject") ? "rejected" : "accepted";
}

export class MockClearinghouseAdapter implements ClearinghouseAdapter, CoreEligibilityAdapter {
  readonly vendor = "mock" as const;

  /**
   * Phase 2 CORE entrypoint — takes the rich `Eligibility270Input` and
   * returns the same shape `AvailityRealtimeAdapter.runEligibility`
   * does, so `ClearinghouseService` can stay transport-agnostic. The
   * mock derives status from the last digit of the member id (matching
   * `runEligibility270`) so existing tests keep working.
   */
  async runEligibilityCORE(input: Eligibility270Input): Promise<CoreEligibilityRunResult> {
    const seed =
      input.subscriber.memberId ||
      `${input.subscriber.lastName}-${input.subscriber.firstName}` ||
      "mock";
    const controlNumber = buildControlNumber(seed);
    const correlationId = buildCorrelationId(`${seed}-${input.informationSource.payerId}`);
    const status = mockEligibilityStatus(input.subscriber.memberId);
    const serviceTypeCode = input.serviceTypeCodes[0] ?? "98";

    const normalized: EligibilityResponseNormalized = {
      status,
      payerName: input.informationSource.payerName ?? "Mock Payer",
      payerId: input.informationSource.payerId ?? "MOCK001",
      planName: status === "active" ? "Mock PPO Gold" : null,
      memberId: input.subscriber.memberId ?? null,
      subscriberName: [input.subscriber.firstName, input.subscriber.lastName].filter(Boolean).join(" ") || null,
      effectiveDate: status === "active" ? "2026-01-01" : null,
      terminationDate: status === "inactive" ? "2026-03-31" : null,
      copayAmount: status === "active" ? 25 : null,
      deductibleTotal: status === "active" ? 1500 : null,
      deductibleRemaining: status === "active" ? 830 : null,
      coinsurancePercent: status === "active" ? 20 : null,
      outOfPocketRemaining: status === "active" ? 1700 : null,
      serviceTypeCode,
      coverageLevel: status === "active" ? "individual" : null,
      message:
        status === "inactive"
          ? "Coverage inactive based on mock 271."
          : status === "not_found"
          ? "Member not found based on mock 271."
          : "Coverage active based on mock 271.",
      rawBenefits: {
        vendor: "mock",
        serviceTypeCode,
      },
    };

    const legacyInput: EligibilityRequestInput = {
      organizationId: input.connection.organization_id,
      patientId: seed,
      clearinghouseConnectionId: input.connection.id ?? "mock-conn",
      payerId: input.informationSource.payerId,
      payerName: input.informationSource.payerName,
      memberId: input.subscriber.memberId,
      subscriberName: normalized.subscriberName ?? undefined,
      patientName: normalized.subscriberName ?? undefined,
      serviceTypeCode,
    };
    const rawRequest = buildMock270Request(legacyInput, controlNumber, correlationId);
    const rawResponse = [
      `ST*271*${controlNumber}*005010X279A1~`,
      `TRN*2*${correlationId}*MOCKCLEARING~`,
      `EB*1**${serviceTypeCode}***${normalized.planName ?? "Mock Plan"}~`,
      `MSG*${normalized.message ?? "Mock eligibility response"}~`,
      `SE*4*${controlNumber}~`,
    ].join("\n");

    return {
      rawRequest,
      rawResponse,
      normalized: parseMock271Response(rawResponse, normalized),
      controlNumber,
      correlationId,
    };
  }

  async runEligibility270(input: EligibilityRequestInput) {
    const patientSeed = input.patientId ?? input.clientId ?? input.memberId ?? "mock";
    const controlNumber = buildControlNumber(patientSeed);
    const correlationId = buildCorrelationId(`${patientSeed}-${input.insurancePolicyId ?? "policy"}`);
    const status = mockEligibilityStatus(input.memberId);

    const normalized: EligibilityResponseNormalized = {
      status,
      payerName: input.payerName ?? "Mock Payer",
      payerId: input.payerId ?? "MOCK001",
      planName: status === "active" ? "Mock PPO Gold" : null,
      memberId: input.memberId ?? null,
      subscriberName: input.subscriberName ?? input.patientName ?? null,
      effectiveDate: status === "active" ? "2026-01-01" : null,
      terminationDate: status === "inactive" ? "2026-03-31" : null,
      copayAmount: status === "active" ? 25 : null,
      deductibleTotal: status === "active" ? 1500 : null,
      deductibleRemaining: status === "active" ? 830 : null,
      coinsurancePercent: status === "active" ? 20 : null,
      outOfPocketRemaining: status === "active" ? 1700 : null,
      serviceTypeCode: input.serviceTypeCode ?? "98",
      coverageLevel: status === "active" ? "individual" : null,
      message:
        status === "inactive"
          ? "Coverage inactive based on mock 271."
          : status === "not_found"
          ? "Member not found based on mock 271."
          : "Coverage active based on mock 271.",
      rawBenefits: {
        vendor: "mock",
        serviceTypeCode: input.serviceTypeCode ?? "98",
      },
    };

    const rawRequest = buildMock270Request(input, controlNumber, correlationId);
    const rawResponse = [
      `ST*271*${controlNumber}*005010X279A1~`,
      `TRN*2*${correlationId}*MOCKCLEARING~`,
      `EB*1**${input.serviceTypeCode ?? "98"}***${normalized.planName ?? "Mock Plan"}~`,
      `MSG*${normalized.message ?? "Mock eligibility response"}~`,
      `SE*4*${controlNumber}~`,
    ].join("\n");

    return {
      rawRequest,
      rawResponse,
      normalized: parseMock271Response(rawResponse, normalized),
      controlNumber,
      correlationId,
    };
  }

  async runClaimStatus276(input: ClaimStatusRequestInput) {
    const controlNumber = buildControlNumber(input.claimId);
    const correlationId = buildCorrelationId(`${input.claimId}-${input.patientId ?? "client"}`);
    const status = mockClaimStatus(input);

    const normalized: ClaimStatusResponseNormalized = {
      status,
      payerName: input.payerName ?? "Mock Payer",
      payerId: input.payerId ?? "MOCK001",
      statusCategoryCode:
        status === "paid" ? "P3" : status === "denied" ? "F2" : status === "pending" ? "P1" : "A1",
      statusCode:
        status === "paid" ? "19" : status === "denied" ? "29" : status === "pending" ? "30" : "20",
      entityCode: "41",
      billedAmount: input.claimAmount ?? null,
      paidAmount: status === "paid" ? input.claimAmount ?? 0 : 0,
      checkEftNumber: status === "paid" ? "MOCK-EFT-1001" : null,
      finalizedDate: status === "paid" ? "2026-04-15" : null,
      payerMessage:
        status === "denied"
          ? "Mock payer denied the claim."
          : status === "pending"
          ? "Mock payer indicates the claim is pending review."
          : status === "paid"
          ? "Mock payer indicates payment completed."
          : "Mock payer accepted the claim status inquiry.",
      rawStatus: {
        vendor: "mock",
        sourceStatus: status,
      },
    };

    const rawRequest = buildMock276Request(input, controlNumber, correlationId);
    const rawResponse = [
      `ST*277*${controlNumber}*005010X212~`,
      `TRN*2*${correlationId}*MOCKCLEARING~`,
      `STC*${normalized.statusCategoryCode ?? "A1"}:${normalized.statusCode ?? "20"}~`,
      `QTY*AA*1~`,
      `SE*4*${controlNumber}~`,
    ].join("\n");

    return {
      rawRequest,
      rawResponse,
      normalized: parseMock277Response(rawResponse, normalized),
      controlNumber,
      correlationId,
    };
  }
}
