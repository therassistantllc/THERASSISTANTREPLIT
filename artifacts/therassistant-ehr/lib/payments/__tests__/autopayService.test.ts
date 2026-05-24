/**
 * Autopay service unit tests (Task #590).
 *
 * Covers the four control-flow branches that matter:
 *   1. skips when clients.autopay_enabled = false
 *   2. records a failed attempt + audit when autopay is on but the
 *      saved card was detached
 *   3. on Stripe success → emits autopay_succeeded audit
 *   4. on Stripe failure → inserts payment_status='failed' row + audit
 */
import { strict as assert } from "node:assert";
import { before, beforeEach, mock, test } from "node:test";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const tables: Tables = {};
const inserted: Array<{ table: string; row: Row }> = [];

function resetState() {
  for (const k of Object.keys(tables)) delete tables[k];
  inserted.length = 0;
}

function fakeBuilder(table: string) {
  let rows = [...(tables[table] ?? [])];
  let pendingInsert: Row | Row[] | null = null;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (field: string, value: unknown) => {
    rows = rows.filter((r) => r[field] === value);
    return chain;
  };
  chain.in = (field: string, values: unknown[]) => {
    const set = new Set(values);
    rows = rows.filter((r) => set.has(r[field]));
    return chain;
  };
  chain.is = (field: string, value: unknown) => {
    rows = rows.filter((r) =>
      value === null ? r[field] == null : r[field] === value,
    );
    return chain;
  };
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = () =>
    Promise.resolve({ data: rows[0] ?? null, error: null });
  chain.single = () =>
    Promise.resolve({ data: rows[0] ?? null, error: null });
  chain.insert = (row: Row | Row[]) => {
    pendingInsert = row;
    const arr = Array.isArray(row) ? row : [row];
    for (const r of arr) inserted.push({ table, row: r });
    tables[table] = [...(tables[table] ?? []), ...arr];
    return chain;
  };
  chain.update = (patch: Row) => {
    for (const r of rows) Object.assign(r, patch);
    return chain;
  };
  chain.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
    Promise.resolve(
      resolve({
        data: pendingInsert
          ? Array.isArray(pendingInsert)
            ? (pendingInsert as Row[])
            : [pendingInsert as Row]
          : rows,
        error: null,
      }),
    );
  return chain;
}

const fakeSupabase = { from: (t: string) => fakeBuilder(t) };

mock.module("@/lib/supabase/server", {
  namedExports: {
    createServerSupabaseAdminClient: () => fakeSupabase,
  },
});

let chargeOutcome:
  | { ok: true; paymentIntentId: string }
  | { ok: false; code: string; message: string } = {
  ok: true,
  paymentIntentId: "pi_test_1",
};

mock.module("@/lib/payments/savedCardService", {
  namedExports: {
    chargeSavedCardForInvoice: async () =>
      chargeOutcome.ok
        ? {
            ok: true,
            paymentIntentId: chargeOutcome.paymentIntentId,
            paymentId: "pay_1",
            invoiceStatus: "paid",
            balanceAmount: 0,
            amountChargedCents: 5000,
            brand: "visa",
            last4: "4242",
          }
        : { ok: false, code: chargeOutcome.code, message: chargeOutcome.message },
  },
});

let attemptAutopayForInvoice: (input: {
  organizationId: string;
  patientInvoiceId: string;
}) => Promise<{ attempted: boolean; ok: boolean; code: string; message: string }>;

before(async () => {
  const mod = await import("../autopayService");
  attemptAutopayForInvoice = mod.attemptAutopayForInvoice;
});

beforeEach(() => {
  resetState();
  chargeOutcome = { ok: true, paymentIntentId: "pi_test_1" };
});

function seedInvoiceAndClient(opts: {
  autopay: boolean;
  hasCard?: boolean;
}) {
  tables.patient_invoices = [
    {
      id: "inv-1",
      organization_id: "org-1",
      client_id: "cli-1",
      invoice_status: "open",
      balance_amount: 50,
      archived_at: null,
    },
  ];
  tables.clients = [
    {
      id: "cli-1",
      organization_id: "org-1",
      first_name: "Jane",
      last_name: "Doe",
      autopay_enabled: opts.autopay,
      stripe_customer_id: opts.hasCard ?? true ? "cus_1" : null,
      stripe_payment_method_id: opts.hasCard ?? true ? "pm_1" : null,
      stripe_payment_method_brand: "visa",
      stripe_payment_method_last4: "4242",
      stripe_connect_account_id: opts.hasCard ?? true ? "acct_1" : null,
      archived_at: null,
    },
  ];
}

test("skips when autopay flag is off", async () => {
  seedInvoiceAndClient({ autopay: false });
  const r = await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  assert.equal(r.attempted, false);
  assert.equal(r.code, "skipped_autopay_off");
  assert.equal(
    inserted.filter((i) => i.table === "patient_invoice_payments").length,
    0,
  );
  assert.equal(inserted.filter((i) => i.table === "audit_logs").length, 0);
});

test("autopay on but card detached → failed-attempt row + audit", async () => {
  seedInvoiceAndClient({ autopay: true, hasCard: false });
  const r = await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  assert.equal(r.code, "skipped_no_card");
  const failedRow = inserted.find(
    (i) => i.table === "patient_invoice_payments",
  );
  assert.ok(failedRow, "expected failed patient_invoice_payments row");
  assert.equal(failedRow!.row.payment_status, "failed");
  const auditRow = inserted.find((i) => i.table === "audit_logs");
  assert.ok(auditRow, "expected audit row");
  assert.equal(auditRow!.row.event_type, "patient_billing_autopay_failed");
});

test("autopay on + Stripe success → success audit, no failed payment row", async () => {
  seedInvoiceAndClient({ autopay: true });
  chargeOutcome = { ok: true, paymentIntentId: "pi_ok" };
  const r = await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  assert.equal(r.attempted, true);
  assert.equal(r.ok, true);
  assert.equal(r.code, "succeeded");
  const failedRow = inserted.find(
    (i) =>
      i.table === "patient_invoice_payments" &&
      i.row.payment_status === "failed",
  );
  assert.equal(failedRow, undefined);
  const auditRow = inserted.find((i) => i.table === "audit_logs");
  assert.equal(auditRow?.row.event_type, "patient_billing_autopay_succeeded");
});

test("autopay on + Stripe declined → failed payment row + failure audit", async () => {
  seedInvoiceAndClient({ autopay: true });
  chargeOutcome = {
    ok: false,
    code: "card_declined",
    message: "Your card was declined.",
  };
  const r = await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  assert.equal(r.attempted, true);
  assert.equal(r.ok, false);
  assert.equal(r.code, "failed");
  const failedRow = inserted.find(
    (i) =>
      i.table === "patient_invoice_payments" &&
      i.row.payment_status === "failed",
  );
  assert.ok(failedRow);
  assert.equal(failedRow!.row.payment_method, "stripe");
  assert.match(String(failedRow!.row.memo ?? ""), /Autopay failed/);
  const auditRow = inserted.find(
    (i) =>
      i.table === "audit_logs" &&
      i.row.event_type === "patient_billing_autopay_failed",
  );
  assert.ok(auditRow);
  const md = auditRow!.row.event_metadata as Record<string, unknown>;
  assert.equal(md.error_code, "card_declined");
});

test("invoice already paid → skipped_no_balance, no side effects", async () => {
  tables.patient_invoices = [
    {
      id: "inv-paid",
      organization_id: "org-1",
      client_id: "cli-1",
      invoice_status: "paid",
      balance_amount: 0,
      archived_at: null,
    },
  ];
  tables.clients = [
    {
      id: "cli-1",
      organization_id: "org-1",
      autopay_enabled: true,
      stripe_customer_id: "cus_1",
      stripe_payment_method_id: "pm_1",
      stripe_connect_account_id: "acct_1",
      archived_at: null,
    },
  ];
  const r = await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-paid",
  });
  assert.equal(r.code, "skipped_no_balance");
  assert.equal(inserted.length, 0);
});
