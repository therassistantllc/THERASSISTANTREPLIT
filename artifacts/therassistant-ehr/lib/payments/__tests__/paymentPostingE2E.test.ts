/**
 * E2E-lite for PP-3 payment-posting flows (Task #109).
 *
 * No real DB — an in-memory fake Supabase client stands in. The test
 * exercises the *real* commit paths in commitManualInsurancePosting and
 * commitPatientPayment, asserting that:
 *   1. Paper-EOB manual insurance with per-service-line allocation writes
 *      one ledger entry per line plus a client invoice when PR > 0.
 *   2. Stripe (external_card) client payment with apply-to-invoice closes
 *      the invoice and dedupes on the unique external_payment_id.
 *   3. Cash to account_balance creates a client_credit, then applyClientCredit
 *      drains it against a later invoice (full unapplied-credit lifecycle).
 *   4. transferred_balance writes a payment_transfers row + paired ledger
 *      entries that move the source's balance to the destination.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateInsert,
  validateWritePayload,
} from "../../supabase/__tests__/schemaGuard";

type Row = Record<string, unknown>;

function makeFakeSupabase() {
  const tables: Record<string, Row[]> = {
    professional_claims: [],
    insurance_manual_payments: [],
    era_posting_ledger_entries: [],
    patient_invoices: [],
    professional_claim_service_lines: [],
    client_payments: [],
    payment_applications: [],
    client_credits: [],
    client_credit_applications: [],
    payment_transfers: [],
    audit_logs: [],
    appointments: [],
  };

  function rowsMatch(row: Row, filters: Array<[string, string, unknown]>) {
    for (const [op, k, v] of filters) {
      if (op === "is" && v === null) {
        if (row[k] !== null && row[k] !== undefined) return false;
      } else if (op === "eq" || op === "is") {
        if (row[k] !== v) return false;
      } else if (op === "in") {
        if (!(v as unknown[]).includes(row[k])) return false;
      }
    }
    return true;
  }

  function from(name: string) {
    const list = (tables[name] ??= []);
    const filters: Array<[string, string, unknown]> = [];
    let mode: "select" | "insert" | "update" | "delete" | null = null;
    let insertItems: Row[] = [];
    let updatePatch: Row = {};

    const exec = (): Promise<{ data: unknown; error: null }> => {
      if (mode === "insert") {
        for (const it of insertItems) {
          if (!it.id) it.id = `${name}-${list.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
          list.push({ ...it });
        }
        return Promise.resolve({ data: insertItems, error: null });
      }
      if (mode === "update") {
        const updated: Row[] = [];
        for (const r of list) {
          if (rowsMatch(r, filters)) {
            Object.assign(r, updatePatch);
            updated.push(r);
          }
        }
        return Promise.resolve({ data: updated, error: null });
      }
      return Promise.resolve({ data: list.filter((r) => rowsMatch(r, filters)), error: null });
    };

    const builder: Record<string, unknown> = {
      select() { mode = mode ?? "select"; return builder; },
      eq(k: string, v: unknown) { filters.push(["eq", k, v]); return builder; },
      is(k: string, v: unknown) { filters.push(["is", k, v]); return builder; },
      in(k: string, v: unknown[]) { filters.push(["in", k, v]); return builder; },
      or() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      not() { return builder; },
      gte() { return builder; },
      lte() { return builder; },
      async maybeSingle() {
        const { data } = await exec();
        const arr = data as Row[];
        return { data: arr[0] ?? null, error: null };
      },
      async single() {
        const { data } = await exec();
        const arr = data as Row[];
        return { data: arr[0] ?? null, error: null };
      },
      then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        return exec().then(onF, onR);
      },
      insert(payload: Row | Row[]) {
        mode = "insert";
        insertItems = Array.isArray(payload) ? [...payload] : [payload];
        validateInsert(name, insertItems);
        // Pre-assign ids so .select().single() can find them.
        for (const it of insertItems) {
          if (!it.id) it.id = `${name}-${list.length + insertItems.indexOf(it) + 1}-${Math.random().toString(36).slice(2, 8)}`;
        }
        return builder;
      },
      update(patch: Row) {
        mode = "update";
        updatePatch = { ...patch };
        validateWritePayload(name, updatePatch);
        return builder;
      },
      delete() { mode = "delete"; return builder; },
    };
    return builder;
  }

  return { from, _tables: tables };
}

import { commitManualInsurancePosting } from "../postingEngine/manualInsurance";
import { commitPatientPayment, applyClientCredit } from "../postingEngine/patientPayment";

type FakeClient = ReturnType<typeof makeFakeSupabase>;
function asClient(c: FakeClient) {
  return c as unknown as NonNullable<Parameters<typeof commitManualInsurancePosting>[4]>;
}

const ORG = "org-1";
const CLIENT = "client-1";
const ACTOR = { staffId: null, userId: null, role: "biller", source: "test" } as const;

test("manual EOB with per-line allocation writes one ledger per line and a client invoice", async () => {
  const fake = makeFakeSupabase();
  // inject fake as last positional arg below
  fake._tables.professional_claims.push({
    id: "pc-1",
    organization_id: ORG,
    patient_id: CLIENT,
    total_charge: 200,
    patient_responsibility_amount: 0,
    claim_status: "submitted",
    archived_at: null,
  });
  fake._tables.professional_claim_service_lines.push(
    { id: "sl-a", claim_id: "pc-1", line_number: 1, charge_amount: 120 },
    { id: "sl-b", claim_id: "pc-1", line_number: 2, charge_amount: 80 },
  );

  const r = await commitManualInsurancePosting(
    ORG,
    {
      type: "manual_insurance",
      professionalClaimId: "pc-1",
      clientId: CLIENT,
      payerPaymentAmount: 150,
      contractualAdjustmentAmount: 30,
      patientResponsibilityAmount: 20,
      checkOrEftNumber: "CHK-1",
      paymentDate: "2026-05-23",
      totalChargeAmount: 200,
      serviceLineAllocations: [
        { serviceLineId: "sl-a", chargeAmount: 120, paidAmount: 90, adjustmentAmount: 20, patientResponsibilityAmount: 10 },
        { serviceLineId: "sl-b", chargeAmount: 80, paidAmount: 60, adjustmentAmount: 10, patientResponsibilityAmount: 10 },
      ],
    },
    ACTOR,
    false,
    asClient(fake),
  );

  assert.equal(r.ok, true, `commit failed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.posted, true);
  // 2 lines × 3 entry types each = 6 ledger entries.
  assert.equal(fake._tables.era_posting_ledger_entries.length, 6);
  // PR > 0 → client invoice created.
  assert.equal(fake._tables.patient_invoices.length, 1);
  assert.equal(Number((fake._tables.patient_invoices[0] as Row).patient_responsibility_amount), 20);
});

test("stripe payment applies to invoice, closes it, dedupes on external_payment_id", async () => {
  const fake = makeFakeSupabase();
  // inject fake as last positional arg below
  fake._tables.patient_invoices.push({
    id: "inv-1",
    organization_id: ORG,
    client_id: CLIENT,
    balance_amount: 100,
    paid_amount: 0,
    invoice_status: "open",
    archived_at: null,
  });

  const first = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 100,
    method: "stripe",
    applyTo: { kind: "invoice", patientInvoiceId: "inv-1" },
    externalPaymentId: "ch_test_123",
    actor: ACTOR,
  }, asClient(fake));
  assert.equal(first.ok, true);
  assert.equal(first.appliedAmount, 100);
  assert.equal(Number((fake._tables.patient_invoices[0] as Row).balance_amount), 0);
  assert.equal((fake._tables.patient_invoices[0] as Row).invoice_status, "paid");

  const dup = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 100,
    method: "stripe",
    applyTo: { kind: "invoice", patientInvoiceId: "inv-1" },
    externalPaymentId: "ch_test_123",
    actor: ACTOR,
  }, asClient(fake));
  assert.equal(dup.alreadyPosted, true);
  assert.equal(fake._tables.client_payments.length, 1); // not double-inserted
});

test("cash to account_balance creates a credit; applyClientCredit drains it onto a later invoice", async () => {
  const fake = makeFakeSupabase();
  // inject fake as last positional arg below

  const cash = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 75,
    method: "cash",
    applyTo: { kind: "account_balance" },
    actor: ACTOR,
  }, asClient(fake));
  assert.equal(cash.ok, true);
  assert.equal(cash.unappliedAmount, 75);
  assert.equal(fake._tables.client_credits.length, 1);

  fake._tables.patient_invoices.push({
    id: "inv-later",
    organization_id: ORG,
    client_id: CLIENT,
    balance_amount: 50,
    paid_amount: 0,
    invoice_status: "open",
    archived_at: null,
  });

  const credit = fake._tables.client_credits[0] as Row;
  const apply = await applyClientCredit({
    organizationId: ORG,
    clientCreditId: String(credit.id),
    amount: 50,
    applyTo: { kind: "invoice", patientInvoiceId: "inv-later" },
    actor: ACTOR,
  }, asClient(fake));
  assert.equal(apply.ok, true, `apply failed: ${JSON.stringify(apply.errors)}`);
  assert.equal(apply.newCreditBalance, 25);
  assert.equal(Number((fake._tables.patient_invoices.find((i) => i.id === "inv-later") as Row).balance_amount), 0);
});

test("transferred_balance writes payment_transfers row and restores source balance", async () => {
  const fake = makeFakeSupabase();
  // inject fake as last positional arg below
  fake._tables.patient_invoices.push(
    {
      id: "inv-src",
      organization_id: ORG,
      client_id: CLIENT,
      balance_amount: 0,
      paid_amount: 80,
      invoice_status: "paid",
      archived_at: null,
    },
    {
      id: "inv-dst",
      organization_id: ORG,
      client_id: CLIENT,
      balance_amount: 80,
      paid_amount: 0,
      invoice_status: "open",
      archived_at: null,
    },
  );

  const r = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 80,
    method: "transferred_balance",
    applyTo: { kind: "invoice", patientInvoiceId: "inv-dst" },
    transferFrom: { fromInvoiceId: "inv-src" },
    transferReason: "Posted to wrong DOS",
    actor: ACTOR,
  }, asClient(fake));
  assert.equal(r.ok, true, `transfer failed: ${JSON.stringify(r.errors)}`);
  assert.equal(fake._tables.payment_transfers.length, 1);
  const t = fake._tables.payment_transfers[0] as Row;
  assert.equal(t.from_invoice_id, "inv-src");
  assert.equal(t.to_invoice_id, "inv-dst");
  assert.equal(Number(t.amount), 80);

  // Source restored: balance back to 80, paid back to 0.
  const src = fake._tables.patient_invoices.find((i) => i.id === "inv-src") as Row;
  assert.equal(Number(src.balance_amount), 80);
  assert.equal(Number(src.paid_amount), 0);
  // Destination paid in full.
  const dst = fake._tables.patient_invoices.find((i) => i.id === "inv-dst") as Row;
  assert.equal(Number(dst.balance_amount), 0);
  assert.equal((dst.invoice_status as string), "paid");
});

test("applyTo=claim posts against patient_responsibility and decrements it", async () => {
  const fake = makeFakeSupabase();
  fake._tables.professional_claims.push({
    id: "pc-pr",
    organization_id: ORG,
    patient_id: CLIENT,
    patient_responsibility_amount: 40,
    archived_at: null,
  });

  const r = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 40,
    method: "cash",
    applyTo: { kind: "claim", professionalClaimId: "pc-pr" },
    actor: ACTOR,
  }, asClient(fake));

  assert.equal(r.ok, true, `commit failed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.appliedAmount, 40);
  assert.equal(r.unappliedAmount, 0);
  // PR balance reduced to zero on the claim.
  const pc = fake._tables.professional_claims.find((c) => c.id === "pc-pr") as Row;
  assert.equal(Number(pc.patient_responsibility_amount), 0);
  // payment_applications row links to the claim.
  assert.equal(fake._tables.payment_applications.length, 1);
  assert.equal((fake._tables.payment_applications[0] as Row).claim_id, "pc-pr");
  // Ledger entry is a negative insurance_payment against the claim.
  const ledger = fake._tables.era_posting_ledger_entries.find(
    (e) => e.professional_claim_id === "pc-pr" && e.source_type === "patient_payment",
  ) as Row;
  assert.ok(ledger);
  assert.equal(Number(ledger.amount), -40);
});

test("applyTo=claim with amount > PR posts the cap and overflows the rest into client_credits", async () => {
  const fake = makeFakeSupabase();
  fake._tables.professional_claims.push({
    id: "pc-cap",
    organization_id: ORG,
    patient_id: CLIENT,
    patient_responsibility_amount: 30,
    archived_at: null,
  });

  const r = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 100,
    method: "cash",
    applyTo: { kind: "claim", professionalClaimId: "pc-cap" },
    actor: ACTOR,
  }, asClient(fake));

  assert.equal(r.ok, true, `commit failed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.appliedAmount, 30);
  assert.equal(r.unappliedAmount, 70);
  // Claim PR drained.
  const pc = fake._tables.professional_claims.find((c) => c.id === "pc-cap") as Row;
  assert.equal(Number(pc.patient_responsibility_amount), 0);
  // Overflow lands in client_credits.
  assert.equal(fake._tables.client_credits.length, 1);
  const credit = fake._tables.client_credits[0] as Row;
  assert.equal(Number(credit.balance_amount), 70);
  assert.equal(Number(credit.initial_amount), 70);
  assert.equal(credit.client_id, CLIENT);
  assert.equal(credit.source_payment_id, r.paymentId);
});

test("applyTo=encounter resolves the claim via appointment_id and posts to it", async () => {
  const fake = makeFakeSupabase();
  fake._tables.professional_claims.push({
    id: "pc-enc",
    organization_id: ORG,
    patient_id: CLIENT,
    appointment_id: "appt-1",
    patient_responsibility_amount: 25,
    archived_at: null,
  });

  const r = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 25,
    method: "cash",
    applyTo: { kind: "encounter", appointmentId: "appt-1" },
    actor: ACTOR,
  }, asClient(fake));

  assert.equal(r.ok, true, `commit failed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.appliedAmount, 25);
  assert.equal((fake._tables.payment_applications[0] as Row).claim_id, "pc-enc");
  const pc = fake._tables.professional_claims.find((c) => c.id === "pc-enc") as Row;
  assert.equal(Number(pc.patient_responsibility_amount), 0);
});

test("applyTo=encounter with no matching claim parks the whole payment as unapplied credit", async () => {
  const fake = makeFakeSupabase();
  // No professional_claims row for appointment 'appt-orphan'.

  const r = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 60,
    method: "cash",
    applyTo: { kind: "encounter", appointmentId: "appt-orphan" },
    actor: ACTOR,
  }, asClient(fake));

  assert.equal(r.ok, true, `commit failed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.appliedAmount, 0);
  assert.equal(r.unappliedAmount, 60);
  assert.equal(fake._tables.client_credits.length, 1);
  assert.equal(Number((fake._tables.client_credits[0] as Row).balance_amount), 60);
  assert.equal(fake._tables.payment_applications.length, 0);
});

test("applyTo=invoice with amount > invoice balance posts the cap and overflows into client_credits", async () => {
  const fake = makeFakeSupabase();
  fake._tables.patient_invoices.push({
    id: "inv-small",
    organization_id: ORG,
    client_id: CLIENT,
    balance_amount: 40,
    paid_amount: 0,
    invoice_status: "open",
    archived_at: null,
  });

  const r = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 100,
    method: "cash",
    applyTo: { kind: "invoice", patientInvoiceId: "inv-small" },
    actor: ACTOR,
  }, asClient(fake));

  assert.equal(r.ok, true, `commit failed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.appliedAmount, 40);
  assert.equal(r.unappliedAmount, 60);
  // Invoice closed.
  const inv = fake._tables.patient_invoices.find((i) => i.id === "inv-small") as Row;
  assert.equal(Number(inv.balance_amount), 0);
  assert.equal(inv.invoice_status, "paid");
  // Overflow → client_credits.
  assert.equal(fake._tables.client_credits.length, 1);
  assert.equal(Number((fake._tables.client_credits[0] as Row).balance_amount), 60);
});

test("transferred_balance writes paired ledger entries (negative on destination, positive on source)", async () => {
  const fake = makeFakeSupabase();
  fake._tables.professional_claims.push(
    {
      id: "pc-src",
      organization_id: ORG,
      patient_id: CLIENT,
      patient_responsibility_amount: 0,
      archived_at: null,
    },
    {
      id: "pc-dst",
      organization_id: ORG,
      patient_id: CLIENT,
      patient_responsibility_amount: 50,
      archived_at: null,
    },
  );

  const r = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 50,
    method: "transferred_balance",
    applyTo: { kind: "claim", professionalClaimId: "pc-dst" },
    transferFrom: { fromClaimId: "pc-src" },
    transferReason: "DOS correction",
    actor: ACTOR,
  }, asClient(fake));

  assert.equal(r.ok, true, `transfer failed: ${JSON.stringify(r.errors)}`);

  // Destination side: negative insurance_payment ledger entry against pc-dst.
  const dstLedger = fake._tables.era_posting_ledger_entries.find(
    (e) => e.professional_claim_id === "pc-dst" && e.source_type === "patient_payment",
  ) as Row;
  assert.ok(dstLedger, "expected destination ledger entry");
  assert.equal(Number(dstLedger.amount), -50);

  // Source side: positive insurance_payment ledger entry against pc-src tied to the transfer.
  const srcLedger = fake._tables.era_posting_ledger_entries.find(
    (e) => e.professional_claim_id === "pc-src" && e.source_type === "payment_transfer",
  ) as Row;
  assert.ok(srcLedger, "expected paired source ledger entry");
  assert.equal(Number(srcLedger.amount), 50);

  // payment_transfers row records the move.
  assert.equal(fake._tables.payment_transfers.length, 1);
  const t = fake._tables.payment_transfers[0] as Row;
  assert.equal(t.from_claim_id, "pc-src");
  assert.equal(t.to_claim_id, "pc-dst");
  assert.equal(Number(t.amount), 50);

  // Source PR restored, destination PR drained.
  const src = fake._tables.professional_claims.find((c) => c.id === "pc-src") as Row;
  const dst = fake._tables.professional_claims.find((c) => c.id === "pc-dst") as Row;
  assert.equal(Number(src.patient_responsibility_amount), 50);
  assert.equal(Number(dst.patient_responsibility_amount), 0);
});

test("transferred_balance rejects a source claim belonging to a different client", async () => {
  const fake = makeFakeSupabase();
  const OTHER_CLIENT = "client-OTHER-2";
  fake._tables.professional_claims.push(
    {
      id: "pc-src-other",
      organization_id: ORG,
      patient_id: OTHER_CLIENT,
      patient_responsibility_amount: 0,
      archived_at: null,
    },
    {
      id: "pc-dst-mine",
      organization_id: ORG,
      patient_id: CLIENT,
      patient_responsibility_amount: 45,
      archived_at: null,
    },
  );

  const r = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 45,
    method: "transferred_balance",
    applyTo: { kind: "claim", professionalClaimId: "pc-dst-mine" },
    transferFrom: { fromClaimId: "pc-src-other" },
    transferReason: "Should be blocked",
    actor: ACTOR,
  }, asClient(fake));

  assert.equal(r.ok, false, "expected cross-client claim transfer to be rejected");
  assert.ok(
    r.errors.some((e) => /does not belong to this client/.test(e.message)),
    `expected cross-client error, got: ${JSON.stringify(r.errors)}`,
  );
  // No writes occurred.
  assert.equal(fake._tables.payment_transfers.length, 0);
  assert.equal(fake._tables.client_payments.length, 0);
  assert.equal(fake._tables.payment_applications.length, 0);
  // Neither claim mutated.
  const otherSrc = fake._tables.professional_claims.find((c) => c.id === "pc-src-other") as Row;
  const dst = fake._tables.professional_claims.find((c) => c.id === "pc-dst-mine") as Row;
  assert.equal(Number(otherSrc.patient_responsibility_amount), 0);
  assert.equal(Number(dst.patient_responsibility_amount), 45);
});

test("transferred_balance rejects a source invoice belonging to a different client", async () => {
  const fake = makeFakeSupabase();
  const OTHER_CLIENT = "client-OTHER";
  // Source invoice owned by a DIFFERENT client in the same org.
  fake._tables.patient_invoices.push(
    {
      id: "inv-other",
      organization_id: ORG,
      client_id: OTHER_CLIENT,
      balance_amount: 0,
      paid_amount: 60,
      invoice_status: "paid",
      archived_at: null,
    },
    {
      id: "inv-dst2",
      organization_id: ORG,
      client_id: CLIENT,
      balance_amount: 60,
      paid_amount: 0,
      invoice_status: "open",
      archived_at: null,
    },
  );

  const r2 = await commitPatientPayment({
    organizationId: ORG,
    clientId: CLIENT,
    amount: 60,
    method: "transferred_balance",
    applyTo: { kind: "invoice", patientInvoiceId: "inv-dst2" },
    transferFrom: { fromInvoiceId: "inv-other" },
    transferReason: "Should be blocked",
    actor: ACTOR,
  }, asClient(fake));
  assert.equal(r2.ok, false, "expected cross-client transfer to be rejected");
  assert.ok(
    r2.errors.some((e) => /does not belong to this client/.test(e.message)),
    `expected cross-client error, got: ${JSON.stringify(r2.errors)}`,
  );
  // No transfer row, no payment row, no application row was written.
  assert.equal(fake._tables.payment_transfers.length, 0);
  assert.equal(fake._tables.client_payments.length, 0);
  assert.equal(fake._tables.payment_applications.length, 0);
  // Source invoice on the OTHER client is untouched.
  const otherSrc = fake._tables.patient_invoices.find((i) => i.id === "inv-other") as Row;
  assert.equal(Number(otherSrc.balance_amount), 0);
  assert.equal(Number(otherSrc.paid_amount), 60);
  // Destination invoice on THIS client is untouched (no partial mutation).
  const dst2 = fake._tables.patient_invoices.find((i) => i.id === "inv-dst2") as Row;
  assert.equal(Number(dst2.balance_amount), 60);
  assert.equal(Number(dst2.paid_amount), 0);
});
