/**
 * Unit tests for manual_insurance per-service-line allocation validation
 * (Task #109 PP-3, response to code-review gap on line-level posting).
 *
 * Pure-validator tests (no DB). The commit path's per-line ledger writes
 * are covered by the E2E test in manualInsuranceE2E.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateManualInsurancePosting,
  type ManualInsuranceServiceLine,
} from "../postingEngine/manualInsurance";

const claim = {
  id: "pc-1",
  organization_id: "org-1",
  patient_id: "client-1",
  total_charge: 200,
  claim_status: "submitted",
};

const lines: ManualInsuranceServiceLine[] = [
  { id: "sl-a", line_number: 1, charge_amount: 120 },
  { id: "sl-b", line_number: 2, charge_amount: 80 },
];

test("accepts balanced per-line allocation", () => {
  const r = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: 150,
      contractualAdjustmentAmount: 30,
      patientResponsibilityAmount: 20,
      checkOrEftNumber: null,
      paymentDate: "2026-05-23",
      totalChargeAmount: 200,
      serviceLineAllocations: [
        { serviceLineId: "sl-a", chargeAmount: 120, paidAmount: 90, adjustmentAmount: 20, patientResponsibilityAmount: 10 },
        { serviceLineId: "sl-b", chargeAmount: 80, paidAmount: 60, adjustmentAmount: 10, patientResponsibilityAmount: 10 },
      ],
    },
    claim,
    lines,
  );
  assert.deepEqual(
    r.blocking.map((b) => b.code),
    [],
  );
});

test("blocks when a per-line sum does not equal that line's charge", () => {
  const r = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: 150,
      contractualAdjustmentAmount: 30,
      patientResponsibilityAmount: 20,
      checkOrEftNumber: null,
      paymentDate: "2026-05-23",
      totalChargeAmount: 200,
      serviceLineAllocations: [
        { serviceLineId: "sl-a", chargeAmount: 120, paidAmount: 50, adjustmentAmount: 20, patientResponsibilityAmount: 10 }, // 80 ≠ 120
        { serviceLineId: "sl-b", chargeAmount: 80, paidAmount: 100, adjustmentAmount: 10, patientResponsibilityAmount: 10 }, // 120 ≠ 80
      ],
    },
    claim,
    lines,
  );
  assert.ok(r.blocking.some((b) => b.code === "line_balance_mismatch"));
});

test("blocks when per-line totals do not match claim-level totals", () => {
  const r = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: 200, // claim says 200 but lines sum to 150
      contractualAdjustmentAmount: 0,
      patientResponsibilityAmount: 0,
      checkOrEftNumber: null,
      paymentDate: "2026-05-23",
      totalChargeAmount: 200,
      serviceLineAllocations: [
        { serviceLineId: "sl-a", chargeAmount: 120, paidAmount: 90, adjustmentAmount: 20, patientResponsibilityAmount: 10 },
        { serviceLineId: "sl-b", chargeAmount: 80, paidAmount: 60, adjustmentAmount: 10, patientResponsibilityAmount: 10 },
      ],
    },
    claim,
    lines,
  );
  assert.ok(r.blocking.some((b) => b.code === "line_total_paid_mismatch"));
});

test("blocks unknown service line id when service lines are loaded", () => {
  const r = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: 90,
      contractualAdjustmentAmount: 20,
      patientResponsibilityAmount: 10,
      checkOrEftNumber: null,
      paymentDate: "2026-05-23",
      totalChargeAmount: 120,
      serviceLineAllocations: [
        { serviceLineId: "sl-MISSING", chargeAmount: 120, paidAmount: 90, adjustmentAmount: 20, patientResponsibilityAmount: 10 },
      ],
    },
    claim,
    lines,
  );
  assert.ok(r.blocking.some((b) => b.code === "service_line_not_found"));
});
