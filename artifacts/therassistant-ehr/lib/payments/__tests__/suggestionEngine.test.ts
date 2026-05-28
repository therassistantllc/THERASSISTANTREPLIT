/**
 * Unit tests for the posting suggestion engine.
 *
 * Pure rule engine — exercises every CARC mapping the biller workspace
 * relies on for one-click pre-fill.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { generatePostingSuggestions } from "../suggestionEngine";

const base = {
  clp02ClaimStatusCode: "1",
  clp03TotalCharge: 200,
  clp04PaymentAmount: 120,
  clp05PatientResponsibility: 50,
};

test("PR-1 deductible is auto-applied with high confidence", () => {
  const out = generatePostingSuggestions({
    ...base,
    casAdjustments: [{ groupCode: "PR", reasonCode: "1", amount: 50 }],
  });
  const d = out.find((s) => s.category === "deductible");
  assert.ok(d, "expected deductible suggestion");
  assert.equal(d?.action, "auto_apply");
  assert.equal(d?.suggestedValue, 50);
});

test("PR-2 + PR-3 produce coinsurance and copay suggestions independently", () => {
  const out = generatePostingSuggestions({
    ...base,
    clp05PatientResponsibility: 35,
    casAdjustments: [
      { groupCode: "PR", reasonCode: "2", amount: 20 },
      { groupCode: "PR", reasonCode: "3", amount: 15 },
    ],
  });
  assert.ok(out.some((s) => s.category === "coinsurance"));
  assert.ok(out.some((s) => s.category === "copay"));
});

test("PR sum mismatch with CLP05 surfaces a review-level conflict", () => {
  const out = generatePostingSuggestions({
    ...base,
    clp05PatientResponsibility: 50,
    casAdjustments: [
      { groupCode: "PR", reasonCode: "2", amount: 30 },
      { groupCode: "PR", reasonCode: "3", amount: 30 },
    ],
  });
  const conflict = out.find((s) => s.conflict === "patient_responsibility_mismatch");
  assert.ok(conflict);
  assert.equal(conflict?.action, "review");
});

test("CO total becomes a single contractual write-off suggestion", () => {
  const out = generatePostingSuggestions({
    ...base,
    casAdjustments: [
      { groupCode: "CO", reasonCode: "45", amount: 30 },
      { groupCode: "CO", reasonCode: "253", amount: 2 },
    ],
  });
  const contractual = out.find((s) => s.category === "contractual");
  assert.ok(contractual);
  assert.equal(contractual?.suggestedValue, 32);
});

test("zero payment + adjustments + no client resp ⇒ denial review", () => {
  const out = generatePostingSuggestions({
    ...base,
    clp04PaymentAmount: 0,
    clp05PatientResponsibility: 0,
    casAdjustments: [{ groupCode: "CO", reasonCode: "29", amount: 200 }],
  });
  const denial = out.find((s) => s.category === "denial");
  assert.ok(denial);
  assert.equal(denial?.action, "review");
});

test("CR group ⇒ reversal block-until-acknowledged", () => {
  const out = generatePostingSuggestions({
    ...base,
    casAdjustments: [{ groupCode: "CR", reasonCode: "100", amount: -50 }],
  });
  const rev = out.find((s) => s.category === "reversal");
  assert.ok(rev);
  assert.equal(rev?.action, "block_until_acknowledged");
});

test("CARC 253 ⇒ sequestration auto-apply", () => {
  const out = generatePostingSuggestions({
    ...base,
    casAdjustments: [{ groupCode: "CO", reasonCode: "253", amount: 1.5 }],
  });
  const seq = out.find((s) => s.category === "sequestration");
  assert.ok(seq);
  assert.equal(seq?.action, "auto_apply");
});

test("CARC 22/23 ⇒ COB review with conflict", () => {
  const out = generatePostingSuggestions({
    ...base,
    casAdjustments: [{ groupCode: "OA", reasonCode: "22", amount: 80 }],
  });
  const cob = out.find((s) => s.category === "cob_issue");
  assert.ok(cob);
  assert.equal(cob?.conflict, "secondary_billing_required");
});

test("negative CLP04 ⇒ recoupment block-until-acknowledged", () => {
  const out = generatePostingSuggestions({
    ...base,
    clp04PaymentAmount: -45,
    casAdjustments: [],
  });
  const rec = out.find((s) => s.category === "recoupment");
  assert.ok(rec);
  assert.equal(rec?.action, "block_until_acknowledged");
});

test("CLP02 status 22 ⇒ reversal even with no CR group present", () => {
  const out = generatePostingSuggestions({
    ...base,
    clp02ClaimStatusCode: "22",
    casAdjustments: [],
  });
  assert.ok(out.some((s) => s.category === "reversal"));
});

test("suggestions are de-duped — adjacent runs do not duplicate the same field", () => {
  const out = generatePostingSuggestions({
    ...base,
    casAdjustments: [
      { groupCode: "PR", reasonCode: "1", amount: 25 },
      { groupCode: "PR", reasonCode: "1", amount: 25 },
    ],
  });
  const deductibles = out.filter((s) => s.category === "deductible");
  assert.equal(deductibles.length, 1);
});

test("sorted by confidence desc with auto_apply ahead of review on ties", () => {
  const out = generatePostingSuggestions({
    ...base,
    casAdjustments: [
      { groupCode: "PR", reasonCode: "1", amount: 50 },
      { groupCode: "CO", reasonCode: "45", amount: 30 },
    ],
  });
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(
      out[i - 1].confidence >= out[i].confidence ||
        (out[i - 1].action === "auto_apply" && out[i].action !== "auto_apply"),
    );
  }
});
