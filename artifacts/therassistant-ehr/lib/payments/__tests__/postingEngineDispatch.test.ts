/**
 * Smoke test for commitPosting dispatcher.
 *
 * Verifies that PP-3 source types route to the right handler (no longer
 * the "not implemented" stub from Foundation phase). We can only assert
 * the surface shape without a real DB; the handlers themselves are
 * covered by the dedicated validator tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { commitPosting } from "../postingEngine";

test("recoupment dispatch reaches recordRecoupment (no longer stubbed)", async () => {
  // PP-5: the recoupment branch now routes to recordRecoupment. Without a
  // real DB the supabase admin client returns null and the handler
  // surfaces a "Database connection not available" error; the important
  // assertion is that we no longer see the old "not implemented" stub.
  const r = await commitPosting({
    organizationId: "org-1",
    source: {
      type: "recoupment",
      target: { kind: "era_835", id: "era-1" },
      amount: 5,
      reason: "Payer takeback",
    },
  });
  assert.equal(r.ok, false);
  for (const e of r.errors) {
    assert.doesNotMatch(e.message, /not implemented/i);
  }
});

test("recoupment dry-run reaches recordRecoupment validation (no longer a stub)", async () => {
  // Task #172: the old early-return stub that returned ok=true with no
  // preview is gone. Dry-run now flows into recordRecoupment so billers
  // get a real preview. Without a real DB the handler surfaces the same
  // "Database connection not available" error as the live path; the
  // important assertion is that we no longer see the old stub behaviour.
  const r = await commitPosting({
    organizationId: "org-1",
    dryRun: true,
    source: {
      type: "recoupment",
      target: { kind: "client_payment", id: "cp-1" },
      amount: 12.5,
      reason: "dry-run smoke",
    },
  });
  assert.equal(r.posted, false);
  for (const e of r.errors) {
    assert.doesNotMatch(e.message, /not implemented/i);
  }
});

test("manual_insurance dispatch reaches the validator (no longer stubbed)", async () => {
  // Without a real DB, the supabase admin client will return null and the
  // engine surfaces a "Database connection not available" error. The
  // important assertion is that we *don't* see the old "Posting source
  // \"manual_insurance\" is not implemented" stub message any more — the
  // dispatcher now routes correctly.
  const r = await commitPosting({
    organizationId: "org-1",
    source: {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: "client-1",
      payerPaymentAmount: 100,
      contractualAdjustmentAmount: 50,
      patientResponsibilityAmount: 50,
      checkOrEftNumber: "CHK-1",
      paymentDate: "2026-05-23",
      totalChargeAmount: 200,
    },
  });
  assert.equal(r.ok, false);
  for (const e of r.errors) {
    assert.doesNotMatch(e.message, /not implemented/i);
  }
});

test("patient_payment dispatch reaches the validator (no longer stubbed)", async () => {
  const r = await commitPosting({
    organizationId: "org-1",
    source: {
      type: "patient_payment",
      clientId: "client-1",
      patientInvoiceId: null,
      amount: 75,
      method: "cash",
      reference: null,
      paymentDate: "2026-05-23",
    },
  });
  assert.equal(r.ok, false);
  for (const e of r.errors) {
    assert.doesNotMatch(e.message, /not implemented/i);
  }
});
