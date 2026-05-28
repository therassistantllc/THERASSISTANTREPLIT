import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  POSTING_BALANCE_TOLERANCE,
  isAlreadyPosted,
  validateEra835Posting,
} from "../validation";
import type { EraClaimPaymentRow } from "../types";

function baseRow(overrides: Partial<EraClaimPaymentRow> = {}): EraClaimPaymentRow {
  return {
    id: "era-1",
    professional_claim_id: "claim-1",
    client_id: "client-1",
    clp01_claim_control_number: "PCN001",
    clp03_total_charge: 200,
    clp04_payment_amount: 120,
    clp05_patient_responsibility: 30,
    cas_adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 50 }],
    claim_match_status: "matched",
    posting_status: "ready",
    ...overrides,
  };
}

describe("validateEra835Posting", () => {
  it("returns no issues for a clean, balanced posting", () => {
    const result = validateEra835Posting(baseRow());
    assert.deepEqual(result.blocking, []);
    assert.deepEqual(result.warning, []);
  });

  it("blocks when claim is not matched", () => {
    const result = validateEra835Posting(
      baseRow({ claim_match_status: "unmatched", professional_claim_id: null }),
    );
    assert.equal(result.blocking.length, 1);
    assert.equal(result.blocking[0].code, "claim_not_matched");
  });

  it("blocks when posting_status is 'blocked'", () => {
    const result = validateEra835Posting(baseRow({ posting_status: "blocked" }));
    assert.equal(
      result.blocking.some((issue) => issue.code === "posting_status_blocked"),
      true,
    );
  });

  it("blocks when insurance payment is negative", () => {
    const result = validateEra835Posting(baseRow({ clp04_payment_amount: -10 }));
    assert.equal(
      result.blocking.some((issue) => issue.code === "negative_insurance_payment"),
      true,
    );
  });

  it("blocks on a > 1 cent balance mismatch", () => {
    // charge=200 but payment(50) + adj(50) + pr(30) = 130 → variance -70
    const result = validateEra835Posting(
      baseRow({ clp04_payment_amount: 50, clp05_patient_responsibility: 30 }),
    );
    assert.equal(
      result.blocking.some((issue) => issue.code === "balance_mismatch"),
      true,
    );
  });

  it("warns (does not block) on sub-cent rounding noise", () => {
    // charge=200, payment=120.007, adj=50, pr=30 → sum=200.007 → variance=0.007
    // 0.007 > tolerance (0.005) but ≤ 2*tolerance (0.01) → warn, not block.
    const row = baseRow({ clp04_payment_amount: 120.007 });
    const result = validateEra835Posting(row);
    assert.equal(result.blocking.length, 0);
    assert.equal(
      result.warning.some((issue) => issue.code === "balance_rounding"),
      true,
      `expected rounding warning, got: ${JSON.stringify(result.warning)}`,
    );
  });

  it("warns when client responsibility exists but no client linked", () => {
    const result = validateEra835Posting(baseRow({ client_id: null }));
    assert.equal(
      result.warning.some((issue) => issue.code === "patient_resp_without_client"),
      true,
    );
  });

  it("warns on CAS adjustment with missing group code", () => {
    const result = validateEra835Posting(
      baseRow({
        cas_adjustments: [{ reasonCode: "45", amount: 50 }],
      }),
    );
    assert.equal(
      result.warning.some((issue) => issue.code === "cas_missing_group"),
      true,
    );
  });

  it("warns on CAS adjustment with unknown group code", () => {
    const result = validateEra835Posting(
      baseRow({
        cas_adjustments: [{ groupCode: "XX", reasonCode: "99", amount: 50 }],
      }),
    );
    assert.equal(
      result.warning.some((issue) => issue.code === "cas_unknown_group"),
      true,
    );
  });

  it("warns when posting looks like a denial (zero payment + adjustments + no PR)", () => {
    const result = validateEra835Posting(
      baseRow({
        clp03_total_charge: 100,
        clp04_payment_amount: 0,
        clp05_patient_responsibility: 0,
        cas_adjustments: [{ groupCode: "CO", reasonCode: "29", amount: 100 }],
      }),
    );
    assert.equal(
      result.warning.some((issue) => issue.code === "likely_denial"),
      true,
    );
  });

  it("supports snake_case group_code/reason_code from JSON storage", () => {
    const result = validateEra835Posting(
      baseRow({
        cas_adjustments: [{ group_code: "CO", reason_code: "45", amount: 50 }],
      }),
    );
    assert.deepEqual(result.blocking, []);
  });
});

describe("isAlreadyPosted", () => {
  it("returns true when posting_status === 'posted'", () => {
    assert.equal(isAlreadyPosted(baseRow({ posting_status: "posted" })), true);
  });
  it("returns false for any other status", () => {
    for (const status of ["ready", "blocked", "skipped"]) {
      assert.equal(isAlreadyPosted(baseRow({ posting_status: status })), false);
    }
  });
});

describe("POSTING_BALANCE_TOLERANCE", () => {
  it("is half a cent", () => {
    assert.equal(POSTING_BALANCE_TOLERANCE, 0.005);
  });
});
