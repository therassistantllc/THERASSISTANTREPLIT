// File: lib/edi/availity270/categorizeBenefits.ts
//
// Phase 5 (CAQH CORE Data Content Rule vEB.2.1 §1.3.2.5–§1.3.2.13):
// turn raw EB segments into typed financial-responsibility categories
// with the qualifier context the rule demands (time period, quantity,
// in/out of network, auth required, tier, telemedicine).
//
// Lives next to parse271.ts but in its own module so the parser stays
// focused on "walk segments → fill ParsedEB271 fields" and this module
// owns the interpretation step.

import type { ParsedEB271, ParsedEB271Category, Parsed271Financials } from "./types";

// EB06 — Time Period Qualifier (X12 271 v5010 element 615). Subset
// covering the values CORE Data Content Rule §1.3.2.13 calls out for
// max/remaining coverage; unknown codes pass through as the raw value.
const TIME_PERIOD_QUALIFIER_MEANINGS: Record<string, string> = {
  "6": "Hour",
  "7": "Day",
  "13": "24 hours",
  "21": "Years",
  "22": "Service Year",
  "23": "Calendar Year",
  "24": "Year to Date",
  "25": "Contract",
  "26": "Episode",
  "27": "Visit",
  "28": "Outlier",
  "29": "Remaining",
  "30": "Exceeded",
  "31": "Not Exceeded",
  "32": "Lifetime",
  "33": "Lifetime Remaining",
  "34": "Month",
  "35": "Week",
  "36": "Admission",
};

export function describeTimePeriodQualifier(code: string | null | undefined): string | null {
  if (!code) return null;
  return TIME_PERIOD_QUALIFIER_MEANINGS[code] ?? code;
}

const REMAINING_QUANTITY_QUALIFIERS = new Set(["29"]);
const REMAINING_TIME_QUALIFIERS = new Set(["29", "33"]);

function detectRemaining(b: ParsedEB271): boolean {
  if (b.quantityQualifier && REMAINING_QUANTITY_QUALIFIERS.has(b.quantityQualifier)) return true;
  if (b.timePeriodQualifier && REMAINING_TIME_QUALIFIERS.has(b.timePeriodQualifier)) return true;
  return (b.followingSegments ?? []).some(
    (seg) => seg[0] === "MSG" && /remaining/i.test(seg[1] ?? ""),
  );
}

function collectMessageText(b: ParsedEB271): string | null {
  const msgs = (b.followingSegments ?? [])
    .filter((s) => s[0] === "MSG")
    .map((s) => s[1] ?? "")
    .filter((s) => s.length > 0);
  return msgs.length > 0 ? msgs.join(" | ") : null;
}

function detectTelemedicine(b: ParsedEB271): boolean {
  // Telemedicine is conveyed several ways in v5010 271s:
  //   * an attached III (Healthcare Information Codes) segment with a
  //     "telemedicine" / "telehealth" descriptor,
  //   * MSG free text mentioning it,
  //   * service type code 96/A6 etc. on a covered benefit (varies by payer).
  const text = [
    b.planDescription ?? "",
    ...(b.followingSegments ?? []).flatMap((s) => s.slice(1)),
  ]
    .filter((s): s is string => typeof s === "string")
    .join(" ");
  return /tele(?:health|medicine)/i.test(text);
}

function detectTier(b: ParsedEB271): string | null {
  const haystacks = [b.planDescription ?? "", collectMessageText(b) ?? ""];
  for (const h of haystacks) {
    const m = /\b(tier\s*[0-9A-Z]+)\b/i.exec(h);
    if (m) return m[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

function detectAuthRequired(b: ParsedEB271): boolean | null {
  if (b.authorizationRequiredCode === "Y") return true;
  if (b.authorizationRequiredCode === "N") return false;
  const text = collectMessageText(b) ?? "";
  if (/(prior\s*authorization|pre[-\s]?auth(?:orization)?\s+required|auth(?:orization)?\s+required)/i.test(text)) {
    return true;
  }
  return null;
}

/**
 * Bucket an EB segment into a CORE Data Content Rule category. Operates
 * on the already-extracted ParsedEB271 (no string parsing of raw EB
 * elements) so callers can reuse it on benefits loaded from the DB.
 */
export function categorizeBenefit(b: ParsedEB271, isRemaining: boolean): ParsedEB271Category {
  const code = (b.eligibilityCode ?? "").toUpperCase();
  switch (code) {
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
      return "active_coverage";
    case "6":
    case "7":
    case "8":
      return "inactive_coverage";
    case "A":
      return "coinsurance";
    case "B":
      return "copay";
    case "C":
      return "deductible";
    case "G":
      return "out_of_pocket";
    case "F":
      // EB01=F "Limitations" is the primary CORE Data Content Rule
      // §1.3.2.13 signal for max / remaining coverage when accompanied
      // by EB07 (monetary amount). Without an amount it's a plain
      // limitation row.
      if (b.monetaryAmount != null || b.quantity != null) {
        return isRemaining ? "remaining_coverage" : "max_coverage";
      }
      return "limitation";
    case "K":
      return "limitation";
    case "E":
      return "exclusion";
    case "I":
      return "non_covered";
    case "D":
      return "benefit_description";
    case "H":
      // EB01=H "Unlimited" — when paired with a monetary amount it is a
      // max coverage statement; remaining variant rolls up the same way.
      if (b.monetaryAmount != null) {
        return isRemaining ? "remaining_coverage" : "max_coverage";
      }
      return "benefit_description";
    default:
      return "other";
  }
}

/**
 * Run the full categorization pass on the parser output. Mutates each
 * ParsedEB271 in place to attach category/isRemaining/etc., and
 * returns the headline `Parsed271Financials` rollup.
 */
export function annotateBenefits(benefits: ParsedEB271[]): Parsed271Financials {
  const financials: Parsed271Financials = {
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

  for (const b of benefits) {
    const isRemaining = detectRemaining(b);
    const category = categorizeBenefit(b, isRemaining);
    const tier = detectTier(b);
    const telemedicine = detectTelemedicine(b);
    const authRequired = detectAuthRequired(b);
    const message = collectMessageText(b);

    b.category = category;
    b.isRemaining = isRemaining;
    b.timePeriodQualifierMeaning = describeTimePeriodQualifier(b.timePeriodQualifier);
    b.tier = tier;
    b.telemedicineFlag = telemedicine;
    b.authorizationRequired = authRequired;
    b.messageText = message;

    // Headline rollup. First non-null wins for each field; we don't try
    // to aggregate across multiple tiered or in/out-of-network benefits
    // (UI walks segments directly for that).
    if (category === "copay" && financials.copayAmount == null) {
      financials.copayAmount = b.monetaryAmount ?? null;
    }
    if (category === "coinsurance" && financials.coinsurancePercent == null) {
      // Payers report percent as 0.20 OR 20; normalize to whole percent.
      const raw = b.percent;
      if (raw != null) {
        financials.coinsurancePercent = raw > 0 && raw < 1 ? raw * 100 : raw;
      }
    }
    if (category === "deductible") {
      if (isRemaining && financials.deductibleRemaining == null) {
        financials.deductibleRemaining = b.monetaryAmount ?? null;
      } else if (!isRemaining && financials.deductibleTotal == null) {
        financials.deductibleTotal = b.monetaryAmount ?? null;
      }
    }
    if (category === "out_of_pocket") {
      if (isRemaining && financials.outOfPocketRemaining == null) {
        financials.outOfPocketRemaining = b.monetaryAmount ?? null;
      } else if (!isRemaining && financials.outOfPocketTotal == null) {
        financials.outOfPocketTotal = b.monetaryAmount ?? null;
      }
    }
    if (category === "max_coverage" && financials.maxCoverageAmount == null) {
      financials.maxCoverageAmount = b.monetaryAmount ?? null;
      financials.maxCoveragePeriod = b.timePeriodQualifierMeaning ?? null;
    }
    if (category === "remaining_coverage" && financials.remainingCoverageAmount == null) {
      financials.remainingCoverageAmount = b.monetaryAmount ?? null;
      financials.remainingCoveragePeriod = b.timePeriodQualifierMeaning ?? null;
    }
    if (authRequired === true && financials.authorizationRequired !== true) {
      financials.authorizationRequired = true;
    } else if (authRequired === false && financials.authorizationRequired == null) {
      financials.authorizationRequired = false;
    }
    if (telemedicine && financials.telemedicineCovered !== true) {
      financials.telemedicineCovered = true;
    }
    if (tier && !financials.benefitTier) {
      financials.benefitTier = tier;
    }
  }

  return financials;
}
