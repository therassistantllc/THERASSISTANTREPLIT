/**
 * Pure rule-based insight generator for the billing reports page (Task #772).
 *
 * Given a ReportPayload-shaped object, returns 0-3 plain-language strings
 * suitable for rendering as banners at the top of the page. All thresholds
 * are deterministic — NO LLM call. The wording must stay stable enough
 * that unit tests can pin it.
 *
 * Inputs are intentionally permissive (`unknown`-ish nested fields) so the
 * helper can be called with the live API payload without re-typing every
 * field site-side.
 */

export interface InsightInputs {
  month?: string | null;
  claims?: {
    submitted?: number | null;
    paid?: number | null;
    deniedOrRejected?: number | null;
    totalChargeSubmitted?: number | null;
  } | null;
  payments?: {
    count?: number | null;
    totalAmount?: number | null;
  } | null;
  derived?: {
    collectionRate?: number | null;
    netCollectionPct?: number | null;
    averageDaysInAR?: number | null;
    outstandingAR?: number | null;
    topDenial?: {
      carcCode?: string | null;
      groupCode?: string | null;
      reasonCode?: string | null;
      occurrences?: number | null;
      totalAmount?: number | null;
    } | null;
  } | null;
  priorMonth?: {
    claimsSubmitted?: number | null;
    claimsPaid?: number | null;
    denials?: number | null;
    chargesSubmitted?: number | null;
    paymentsPosted?: number | null;
    outstandingAR?: number | null;
    averageDaysInAR?: number | null;
    collectionRate?: number | null;
  } | null;
  payerPerformance?: Array<{
    payerName?: string | null;
    totalClaims?: number | null;
    averageTurnaroundDays?: number | null;
  }> | null;
}

export type InsightTone = "warning" | "positive" | "neutral";

export interface Insight {
  tone: InsightTone;
  message: string;
}

function pct(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return Math.round(((numerator - denominator) / denominator) * 1000) / 10;
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function generateBillingInsights(input: InsightInputs): Insight[] {
  const insights: Insight[] = [];

  const denialsCurrent = num(input.claims?.deniedOrRejected);
  const denialsPrior = num(input.priorMonth?.denials);
  const submittedCurrent = num(input.claims?.submitted);
  const submittedPrior = num(input.priorMonth?.claimsSubmitted);
  const chargesCurrent = num(input.claims?.totalChargeSubmitted);
  const chargesPrior = num(input.priorMonth?.chargesSubmitted);
  const paymentsCurrent = num(input.payments?.totalAmount);
  const paymentsPrior = num(input.priorMonth?.paymentsPosted);

  // Denial-rate change > 10 percentage points (or absolute jump if no
  // prior baseline). Use rate-of-submitted to normalize for volume.
  const denialRateCurrent = submittedCurrent > 0 ? (denialsCurrent / submittedCurrent) * 100 : 0;
  const denialRatePrior = submittedPrior > 0 ? (denialsPrior / submittedPrior) * 100 : 0;
  const denialRateDelta = denialRateCurrent - denialRatePrior;
  if (submittedCurrent >= 5 && submittedPrior >= 5 && denialRateDelta >= 10) {
    const topReason = input.derived?.topDenial?.carcCode ?? null;
    const reasonClause = topReason ? `, led by ${topReason}` : "";
    insights.push({
      tone: "warning",
      message: `Denial rate climbed ${denialRateDelta.toFixed(1)} points this month (${denialRateCurrent.toFixed(0)}% vs ${denialRatePrior.toFixed(0)}%)${reasonClause}.`,
    });
  } else if (submittedCurrent >= 5 && submittedPrior >= 5 && denialRateDelta <= -10) {
    insights.push({
      tone: "positive",
      message: `Denial rate dropped ${Math.abs(denialRateDelta).toFixed(1)} points this month (${denialRateCurrent.toFixed(0)}% vs ${denialRatePrior.toFixed(0)}%).`,
    });
  }

  // Collections trend: payments posted vs prior month.
  const paymentsDelta = pct(paymentsCurrent, paymentsPrior);
  if (paymentsPrior >= 100 && paymentsDelta !== null) {
    if (paymentsDelta >= 15) {
      insights.push({
        tone: "positive",
        message: `Payments posted are up ${paymentsDelta.toFixed(0)}% vs the prior month.`,
      });
    } else if (paymentsDelta <= -15) {
      insights.push({
        tone: "warning",
        message: `Payments posted are down ${Math.abs(paymentsDelta).toFixed(0)}% vs the prior month.`,
      });
    }
  }

  // Per-payer days-in-AR outlier: a payer whose averageTurnaroundDays is
  // materially above the practice median (>= 10 days above) flags as an
  // operational concern.
  const turnaroundSamples = (input.payerPerformance ?? [])
    .filter((p) => typeof p.averageTurnaroundDays === "number" && (p.totalClaims ?? 0) >= 3)
    .map((p) => ({ name: p.payerName ?? "Unknown payer", days: p.averageTurnaroundDays as number }));
  if (turnaroundSamples.length >= 3) {
    const sorted = [...turnaroundSamples].sort((a, b) => a.days - b.days);
    const median = sorted[Math.floor(sorted.length / 2)].days;
    const outlier = sorted[sorted.length - 1];
    if (outlier.days - median >= 10) {
      const extra = Math.round(outlier.days - median);
      insights.push({
        tone: "warning",
        message: `${outlier.name} claims are averaging ${extra} additional days in AR vs the practice median.`,
      });
    }
  }

  // Charges-trend nudge — only as a fallback if we have nothing else.
  if (insights.length === 0) {
    const chargesDelta = pct(chargesCurrent, chargesPrior);
    if (chargesPrior >= 100 && chargesDelta !== null && Math.abs(chargesDelta) >= 10) {
      insights.push({
        tone: chargesDelta >= 0 ? "positive" : "warning",
        message:
          chargesDelta >= 0
            ? `Charges submitted are up ${chargesDelta.toFixed(0)}% vs the prior month.`
            : `Charges submitted are down ${Math.abs(chargesDelta).toFixed(0)}% vs the prior month.`,
      });
    }
  }

  // Days-in-AR creep
  const arNow = input.derived?.averageDaysInAR;
  const arPrior = input.priorMonth?.averageDaysInAR;
  if (
    typeof arNow === "number" &&
    typeof arPrior === "number" &&
    arPrior > 0 &&
    arNow - arPrior >= 7
  ) {
    insights.push({
      tone: "warning",
      message: `Average days in AR rose to ${arNow.toFixed(0)} days (up from ${arPrior.toFixed(0)}).`,
    });
  }

  return insights.slice(0, 3);
}
