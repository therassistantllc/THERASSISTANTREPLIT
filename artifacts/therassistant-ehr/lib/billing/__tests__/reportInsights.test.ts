import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { generateBillingInsights } from "../reportInsights";

describe("generateBillingInsights", () => {
  it("flags a meaningful denial-rate jump and names the top CARC", () => {
    const insights = generateBillingInsights({
      claims: { submitted: 100, deniedOrRejected: 25, totalChargeSubmitted: 50000 },
      priorMonth: { claimsSubmitted: 100, denials: 10, chargesSubmitted: 50000, paymentsPosted: 30000 },
      payments: { totalAmount: 30000 },
      derived: { topDenial: { carcCode: "CO-197" } },
    });
    assert.ok(insights.some((i) => i.tone === "warning" && /Denial rate climbed/.test(i.message)));
    assert.ok(insights.some((i) => /CO-197/.test(i.message)));
  });

  it("does not flag denial-rate changes when volume is tiny", () => {
    const insights = generateBillingInsights({
      claims: { submitted: 3, deniedOrRejected: 2, totalChargeSubmitted: 500 },
      priorMonth: { claimsSubmitted: 2, denials: 0, chargesSubmitted: 500, paymentsPosted: 500 },
      payments: { totalAmount: 500 },
    });
    assert.equal(insights.filter((i) => /Denial rate/.test(i.message)).length, 0);
  });

  it("congratulates a meaningful denial-rate drop", () => {
    const insights = generateBillingInsights({
      claims: { submitted: 80, deniedOrRejected: 4, totalChargeSubmitted: 40000 },
      priorMonth: { claimsSubmitted: 80, denials: 20, chargesSubmitted: 40000, paymentsPosted: 30000 },
      payments: { totalAmount: 30000 },
    });
    assert.ok(insights.some((i) => i.tone === "positive" && /Denial rate dropped/.test(i.message)));
  });

  it("flags a payer whose AR turnaround is well above the median", () => {
    const insights = generateBillingInsights({
      claims: { submitted: 50, deniedOrRejected: 4, totalChargeSubmitted: 20000 },
      priorMonth: { claimsSubmitted: 50, denials: 4, chargesSubmitted: 20000, paymentsPosted: 15000 },
      payments: { totalAmount: 15000 },
      payerPerformance: [
        { payerName: "Aetna", totalClaims: 10, averageTurnaroundDays: 15 },
        { payerName: "BCBS", totalClaims: 10, averageTurnaroundDays: 18 },
        { payerName: "Colorado Access", totalClaims: 10, averageTurnaroundDays: 32 },
      ],
    });
    assert.ok(
      insights.some(
        (i) =>
          i.tone === "warning" &&
          /Colorado Access/.test(i.message) &&
          /additional days in AR/.test(i.message),
      ),
    );
  });

  it("warns when payments drop materially", () => {
    const insights = generateBillingInsights({
      claims: { submitted: 80, deniedOrRejected: 8, totalChargeSubmitted: 40000 },
      priorMonth: {
        claimsSubmitted: 80,
        denials: 8,
        chargesSubmitted: 40000,
        paymentsPosted: 30000,
      },
      payments: { totalAmount: 15000 },
    });
    assert.ok(insights.some((i) => i.tone === "warning" && /Payments posted are down/.test(i.message)));
  });

  it("returns at most 3 insights and never throws on an empty payload", () => {
    const insights = generateBillingInsights({});
    assert.ok(Array.isArray(insights));
    assert.ok(insights.length <= 3);
  });
});
