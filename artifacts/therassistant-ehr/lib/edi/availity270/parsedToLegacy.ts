// Bridge: convert a `Parsed271Response` (foundation shape) into the legacy
// `EligibilityResponseNormalized` consumed by `ClearinghouseService`.
//
// Phase 5 will extend `EligibilityResponseNormalized` with the full set of
// CAQH CORE Data Content financial-responsibility fields; until then we
// surface copay (B), coinsurance (A), deductible (C), out-of-pocket (G).

import type { EligibilityResponseNormalized } from "@/types/clearinghouse";
import type { Parsed271Response, ParsedEB271 } from "./types";

function pickBenefit(benefits: ParsedEB271[], code: string): ParsedEB271 | null {
  return benefits.find((b) => b.eligibilityCode === code) ?? null;
}

function isRemainingContext(b: ParsedEB271): boolean {
  // X12 271: "remaining" deductible/OOP is conventionally signalled by
  // quantity qualifier "29" (remaining) or an MSG segment containing
  // "REMAINING". Treat absence as base/total.
  if (b.quantityQualifier === "29") return true;
  return (b.followingSegments ?? []).some((s) => s[0] === "MSG" && /remaining/i.test(s[1] ?? ""));
}

export function parsed271ToLegacyNormalized(
  parsed: Parsed271Response,
  fallbackServiceTypeCode = "98",
): EligibilityResponseNormalized {
  const copay = pickBenefit(parsed.benefits, "B");
  const coinsurance = pickBenefit(parsed.benefits, "A");
  const deductibles = parsed.benefits.filter((b) => b.eligibilityCode === "C");
  const oop = parsed.benefits.filter((b) => b.eligibilityCode === "G");

  const deductibleBase = deductibles.find((b) => !isRemainingContext(b)) ?? deductibles[0] ?? null;
  const deductibleRemaining = deductibles.find(isRemainingContext) ?? null;
  const oopRemaining = oop.find(isRemainingContext) ?? oop[0] ?? null;

  let message: string | null = null;
  if (parsed.aaaErrors.length > 0) {
    message = parsed.aaaErrors
      .map((e) => `${e.code ? `[${e.code}] ` : ""}${e.description}${e.followUpAction ? ` — ${e.followUpAction}` : ""}`)
      .join("; ");
  } else if (parsed.messages.length > 0) {
    message = parsed.messages.slice(0, 5).join(" | ");
  }

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
    copayAmount: copay?.monetaryAmount ?? null,
    coinsurancePercent: coinsurance?.percent ?? null,
    deductibleTotal: deductibleBase?.monetaryAmount ?? null,
    deductibleRemaining: deductibleRemaining?.monetaryAmount ?? null,
    outOfPocketRemaining: oopRemaining?.monetaryAmount ?? null,
    coverageLevel: parsed.benefits[0]?.coverageLevelMeaning ?? parsed.benefits[0]?.coverageLevelCode ?? null,
    serviceTypeCode: parsed.benefits[0]?.serviceTypeCode ?? fallbackServiceTypeCode,
    message,
    rawBenefits: {
      parsed271: parsed as unknown as Record<string, unknown>,
    },
  };
}
