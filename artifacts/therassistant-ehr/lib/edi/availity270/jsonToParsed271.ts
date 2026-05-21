// Map an Availity Coverages REST JSON response into the same
// `Parsed271Response` shape produced by `parseAvaility271`, so downstream
// code (UI, financial-responsibility extraction, attribution) can ignore
// the transport (SOAP/X12 vs. REST/JSON).

import type {
  AvailityBenefitContent,
  AvailityBenefitResponse,
  AvailityEligibilityResponse,
} from "@/types/availityJsonApi";
import type { Parsed271Response, ParsedAAAError, ParsedEB271 } from "./types";

function toNumberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeInNetwork(code: string | null | undefined): "Y" | "N" | "W" | "U" | null {
  if (!code) return null;
  const v = code.toUpperCase();
  return v === "Y" || v === "N" || v === "W" || v === "U" ? v : null;
}

const BENEFIT_BUCKETS: Array<keyof AvailityBenefitResponse> = [
  "plans",
  "benefits",
  "benefitDescriptions",
  "exclusions",
  "limitations",
  "preExistingConditions",
  "disclaimers",
  "otherPayers",
  "miscellaneous",
  "cannotProcess",
  "otherSourceOfData",
  "entities",
];

function benefitContentToParsedEB(content: AvailityBenefitContent): ParsedEB271 {
  const ebCode = content.benefitInformationCode?.codeValue?.toUpperCase() ?? "";
  return {
    eligibilityCode: ebCode,
    eligibilityCodeMeaning: content.benefitInformationCode?.description ?? ebCode,
    coverageLevelCode: content.coverageLevel?.codeValue ?? null,
    coverageLevelMeaning: content.coverageLevel?.description ?? null,
    serviceTypeCode: content.serviceTypeCodes?.[0]?.codeValue ?? null,
    insuranceTypeCode: content.insuranceTypeCode?.codeValue ?? null,
    planDescription: content.planCoverageDescription ?? null,
    timePeriodQualifier: content.timePeriod?.codeValue ?? null,
    monetaryAmount: toNumberOrNull(content.monetaryAmount),
    percent: toNumberOrNull(content.percent),
    quantityQualifier: content.quantityType?.codeValue ?? null,
    quantity: toNumberOrNull(content.quantity),
    inPlanNetwork: normalizeInNetwork(content.networkIndicator?.codeValue ?? null),
    followingSegments: content.messages?.length ? content.messages.map((m) => ["MSG", m]) : [],
  };
}

export function mapAvailityJsonTo271(response: AvailityEligibilityResponse): Parsed271Response {
  const subscriber = response.subscriber ?? null;
  const details: AvailityBenefitResponse | null = subscriber?.ebResponseDetails ?? response.dependent?.ebResponseDetails ?? null;
  const benefits: ParsedEB271[] = [];
  const messages: string[] = [];
  if (details) {
    for (const bucket of BENEFIT_BUCKETS) {
      const items = details[bucket];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        benefits.push(benefitContentToParsedEB(item));
        if (item.messages?.length) messages.push(...item.messages);
      }
    }
  }

  const aaaErrors: ParsedAAAError[] = (response.transactionErrors ?? []).map((err) => ({
    code: err.rejectReason?.codeValue ?? "",
    description: err.rejectReason?.description ?? "Eligibility transaction error",
    followUpAction: err.followUpAction?.description ?? err.followUpAction?.codeValue ?? null,
    loop: err.loopId ?? err.loopName ?? null,
    rejectReason: err.rejectReason?.description ?? null,
  }));

  let status: Parsed271Response["status"] = "unknown";
  if (aaaErrors.length > 0) {
    const notFound = aaaErrors.some((e) => e.code === "75" || e.code === "77" || e.code === "78");
    status = notFound ? "not_found" : "error";
  } else if (benefits.some((b) => ["1", "2", "3", "4", "5"].includes(b.eligibilityCode))) {
    status = "active";
  } else if (benefits.some((b) => ["6", "7", "8"].includes(b.eligibilityCode))) {
    status = "inactive";
  } else {
    const statusDesc = response.responseStatus?.description?.toLowerCase() ?? "";
    const statusCode = response.responseStatus?.codeValue?.toLowerCase() ?? "";
    if (statusDesc.includes("active") || statusCode.includes("active")) status = "active";
    else if (statusDesc.includes("inactive") || statusCode.includes("inactive")) status = "inactive";
    else if (statusDesc.includes("not found") || statusDesc.includes("no match")) status = "not_found";
  }

  return {
    status,
    payerName: response.responsePayer?.name ?? response.oaPayer?.name ?? null,
    payerId: response.responsePayer?.payerId ?? response.oaPayer?.payerId ?? null,
    planName: subscriber?.planName ?? null,
    subscriberLastName: subscriber?.lastName ?? null,
    subscriberFirstName: subscriber?.firstName ?? null,
    memberId: subscriber?.memberId ?? null,
    dob: subscriber?.dob ?? subscriber?.dateOfBirth ?? null,
    gender:
      typeof subscriber?.gender === "string"
        ? subscriber.gender
        : subscriber?.gender?.codeValue ?? null,
    effectiveDate: null,
    terminationDate: null,
    aaaErrors,
    benefits,
    messages,
    isaControlNumber: null,
    gsControlNumber: null,
    stControlNumber: null,
    rawSegments: [],
  };
}
