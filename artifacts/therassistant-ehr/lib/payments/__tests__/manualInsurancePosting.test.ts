/**
 * Unit tests for the manual_insurance posting validator (pure).
 *
 * Mirrors the validateEra835Posting test pattern: no DB, just the
 * pure rule engine. DB-backed commitManualInsurancePosting is exercised
 * by the API route's smoke test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateManualInsurancePosting } from "../postingEngine/manualInsurance";

const baseClaim = {
  id: "pc-1",
  organization_id: "org-1",
  patient_id: "client-1",
  total_charge: 200,
  claim_status: "submitted",
};

test("blocks when claim is missing", () => {
  const r = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "x",
      clientId: null,
      payerPaymentAmount: 100,
      patientResponsibilityAmount: 0,
      contractualAdjustmentAmount: 0,
      checkOrEftNumber: null,
      paymentDate: "2026-05-23",
    },
    null,
  );
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].code, "claim_not_found");
});

test("blocks balance mismatch beyond 1¢", () => {
  const r = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: 150,
      contractualAdjustmentAmount: 30,
      patientResponsibilityAmount: 10, // 190 != 200
      checkOrEftNumber: "CHK-1",
      paymentDate: "2026-05-23",
      totalChargeAmount: 200,
    },
    baseClaim,
  );
  assert.ok(r.blocking.some((b) => b.code === "balance_mismatch"));
});

test("warns on rounding variance between ½¢ and 1¢", () => {
  const r = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: 150,
      contractualAdjustmentAmount: 40,
      patientResponsibilityAmount: 10.0075,
      checkOrEftNumber: null,
      paymentDate: "2026-05-23",
      totalChargeAmount: 200,
    },
    baseClaim,
  );
  assert.equal(r.blocking.length, 0);
  assert.ok(r.warning.some((w) => w.code === "balance_rounding"));
});

test("blocks negative amounts and zero-total postings", () => {
  const neg = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: -10,
      contractualAdjustmentAmount: 0,
      patientResponsibilityAmount: 0,
      checkOrEftNumber: null,
      paymentDate: "2026-05-23",
      totalChargeAmount: 0,
    },
    baseClaim,
  );
  assert.ok(neg.blocking.some((b) => b.code === "negative_insurance_payment"));

  const zero = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: 0,
      contractualAdjustmentAmount: 0,
      patientResponsibilityAmount: 0,
      checkOrEftNumber: null,
      paymentDate: "2026-05-23",
      totalChargeAmount: 0,
    },
    baseClaim,
  );
  assert.ok(zero.blocking.some((b) => b.code === "zero_total"));
});

test("denial signal (zero pay, nonzero adj, zero PR) is warning not blocking", () => {
  const r = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: 0,
      contractualAdjustmentAmount: 200,
      patientResponsibilityAmount: 0,
      checkOrEftNumber: null,
      paymentDate: "2026-05-23",
      totalChargeAmount: 200,
    },
    baseClaim,
  );
  assert.equal(r.blocking.length, 0);
  assert.ok(r.warning.some((w) => w.code === "likely_denial"));
});

test("PR with no client on claim emits warning, not block", () => {
  const r = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: null,
      payerPaymentAmount: 100,
      contractualAdjustmentAmount: 50,
      patientResponsibilityAmount: 50,
      checkOrEftNumber: null,
      paymentDate: "2026-05-23",
      totalChargeAmount: 200,
    },
    { ...baseClaim, patient_id: null },
  );
  assert.equal(r.blocking.length, 0);
  assert.ok(r.warning.some((w) => w.code === "patient_resp_without_client"));
});

test("clean posting passes with no blocking", () => {
  const r = validateManualInsurancePosting(
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: 120,
      contractualAdjustmentAmount: 60,
      patientResponsibilityAmount: 20,
      checkOrEftNumber: "EFT-99",
      paymentDate: "2026-05-23",
      totalChargeAmount: 200,
    },
    baseClaim,
  );
  assert.equal(r.blocking.length, 0);
});
