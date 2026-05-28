/**
 * Pure-function tests for the client cases service.
 *
 * Network/DB-backed flows (create/update/attach/move) are exercised through
 * the API routes in integration; here we cover the pure helpers that govern
 * billing routing for self-pay/charity cases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CASE_TYPES,
  PATIENT_RESPONSIBILITY_CASE_TYPES,
  isPatientResponsibilityCaseType,
} from "../clientCasesService";

test("CASE_TYPES covers all the documented coverage groupings", () => {
  for (const expected of [
    "commercial",
    "medicaid",
    "medicare",
    "workers_comp",
    "charity",
    "self_pay",
    "other",
  ]) {
    assert.ok(CASE_TYPES.includes(expected as never), `missing case type ${expected}`);
  }
});

test("client-responsibility set is exactly self_pay + charity", () => {
  assert.deepEqual([...PATIENT_RESPONSIBILITY_CASE_TYPES].sort(), ["charity", "self_pay"]);
});

test("isPatientResponsibilityCaseType routes self-pay and charity to the client", () => {
  assert.equal(isPatientResponsibilityCaseType("self_pay"), true);
  assert.equal(isPatientResponsibilityCaseType("charity"), true);
});

test("isPatientResponsibilityCaseType keeps insurance cases on the claim path", () => {
  for (const t of ["commercial", "medicaid", "medicare", "workers_comp", "other"]) {
    assert.equal(
      isPatientResponsibilityCaseType(t),
      false,
      `${t} should not route to client responsibility`,
    );
  }
});

test("isPatientResponsibilityCaseType is null/undefined-safe", () => {
  assert.equal(isPatientResponsibilityCaseType(null), false);
  assert.equal(isPatientResponsibilityCaseType(undefined), false);
  assert.equal(isPatientResponsibilityCaseType(""), false);
  assert.equal(isPatientResponsibilityCaseType("bogus_type"), false);
});
