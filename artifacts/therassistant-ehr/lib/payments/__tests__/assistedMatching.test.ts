/**
 * Unit tests for the assisted matching scoring function (pure).
 *
 * The DB-backed `findCandidatesForEraClaimPayment` is exercised through the
 * batch detail / auto-match API; here we focus on the scoring math because
 * it determines whether a candidate hits the 0.95 auto-bind threshold or
 * stays in the "biller picks" zone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreProbableMatch, _dateOverlaps } from "../assistedMatchingService";

test("date overlap is inclusive on both ends", () => {
  assert.equal(_dateOverlaps("2026-01-01", "2026-01-05", "2026-01-05", "2026-01-10"), true);
  assert.equal(_dateOverlaps("2026-01-01", "2026-01-05", "2026-01-06", "2026-01-10"), false);
  assert.equal(_dateOverlaps(null, null, "2026-01-01", "2026-01-02"), false);
});

test("single-claim DOS uses from-date for both ends", () => {
  assert.equal(_dateOverlaps("2026-03-15", null, "2026-03-15", null), true);
  assert.equal(_dateOverlaps("2026-03-15", null, "2026-03-16", null), false);
});

test("perfect match (charge + DOS + payer + name) scores ≥ 0.85", () => {
  const { confidence, reasons } = scoreProbableMatch(
    {
      totalCharge: 250,
      serviceDateFrom: "2026-04-10",
      serviceDateTo: "2026-04-10",
      payerProfileId: "payer-1",
      patientLastName: "Smith",
    },
    {
      totalCharge: 250,
      dateOfServiceFrom: "2026-04-10",
      dateOfServiceTo: "2026-04-10",
      payerProfileId: "payer-1",
      patientLastName: "smith",
    },
  );
  assert.ok(confidence >= 0.85, `expected >=0.85, got ${confidence}`);
  assert.ok(reasons.includes("Charge match"));
  assert.ok(reasons.includes("DOS overlap"));
  assert.ok(reasons.includes("Payer match"));
  assert.ok(reasons.includes("Client last name match"));
});

test("charge mismatch beyond $0.50 tolerance kills the charge bonus", () => {
  const { confidence, reasons } = scoreProbableMatch(
    {
      totalCharge: 250,
      serviceDateFrom: "2026-04-10",
      serviceDateTo: "2026-04-10",
      payerProfileId: "payer-1",
      patientLastName: null,
    },
    {
      totalCharge: 260,
      dateOfServiceFrom: "2026-04-10",
      dateOfServiceTo: "2026-04-10",
      payerProfileId: "payer-1",
      patientLastName: null,
    },
  );
  assert.ok(!reasons.includes("Charge match"));
  assert.ok(confidence < 0.85);
});

test("charge within ±$0.50 still counts as a match (rounding noise)", () => {
  const { reasons } = scoreProbableMatch(
    {
      totalCharge: 100,
      serviceDateFrom: null,
      serviceDateTo: null,
      payerProfileId: null,
      patientLastName: null,
    },
    {
      totalCharge: 100.49,
      dateOfServiceFrom: null,
      dateOfServiceTo: null,
      payerProfileId: null,
      patientLastName: null,
    },
  );
  assert.ok(reasons.includes("Charge match"));
});

test("confidence is capped at 0.94 — probable matches never reach the auto-bind threshold", () => {
  const { confidence } = scoreProbableMatch(
    {
      totalCharge: 99.99,
      serviceDateFrom: "2026-01-01",
      serviceDateTo: "2026-01-01",
      payerProfileId: "payer-x",
      patientLastName: "doe",
    },
    {
      totalCharge: 99.99,
      dateOfServiceFrom: "2026-01-01",
      dateOfServiceTo: "2026-01-01",
      payerProfileId: "payer-x",
      patientLastName: "DOE",
    },
  );
  assert.ok(confidence <= 0.94, `probable score must stay <= 0.94, got ${confidence}`);
});

test("name match is case-insensitive and whitespace-tolerant", () => {
  const { reasons } = scoreProbableMatch(
    {
      totalCharge: 0,
      serviceDateFrom: null,
      serviceDateTo: null,
      payerProfileId: null,
      patientLastName: " Smith ",
    },
    {
      totalCharge: 0,
      dateOfServiceFrom: null,
      dateOfServiceTo: null,
      payerProfileId: null,
      patientLastName: "smith",
    },
  );
  assert.ok(reasons.includes("Client last name match"));
});

test("no signals at all still returns a baseline (0.5) — caller's threshold drops it", () => {
  const { confidence, reasons } = scoreProbableMatch(
    {
      totalCharge: 0,
      serviceDateFrom: null,
      serviceDateTo: null,
      payerProfileId: null,
      patientLastName: null,
    },
    {
      totalCharge: 0,
      dateOfServiceFrom: null,
      dateOfServiceTo: null,
      payerProfileId: null,
      patientLastName: null,
    },
  );
  assert.equal(confidence, 0.5);
  assert.deepEqual(reasons, []);
});
