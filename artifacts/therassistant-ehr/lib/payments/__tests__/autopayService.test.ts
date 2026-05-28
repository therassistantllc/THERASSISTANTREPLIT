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
  let countMode = false;
  let headMode = false;
  chain.select = (
    _cols?: string,
    opts?: { count?: string; head?: boolean },
  ) => {
    if (opts?.count) countMode = true;
    if (opts?.head) headMode = true;
    return chain;
  };
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
  chain.gte = (field: string, value: unknown) => {
    rows = rows.filter((r) => String(r[field]) >= String(value));
    return chain;
  };
  chain.not = (field: string, op: string, value: unknown) => {
    rows = rows.filter((r) =>
      op === "is" && value === null ? r[field] != null : r[field] !== value,
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
  chain.then = (
    resolve: (v: {
      data: Row[] | null;
      error: null;
      count?: number;
    }) => unknown,
  ) =>
    Promise.resolve(
      resolve({
        data: headMode
          ? null
          : pendingInsert
            ? Array.isArray(pendingInsert)
              ? (pendingInsert as Row[])
              : [pendingInsert as Row]
            : rows,
        error: null,
        ...(countMode ? { count: rows.length } : {}),
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

const sentEmails: Array<Record<string, unknown>> = [];
let emailOk = true;
mock.module("@/lib/email/resend", {
  namedExports: {
    sendAutopayRetryNoticeEmail: async (input: Record<string, unknown>) => {
      sentEmails.push(input);
      return emailOk
        ? { ok: true, providerId: "msg_test", fromEmail: "noreply@test" }
        : { ok: false, error: "resend_unavailable" };
    },
  },
});

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

/* Task #736: capture outbound autopay failure emails so tests can
 * assert on copy + throttling without hitting Resend. */
type SentFailureEmail = {
  to: string;
  patientName: string;
  practiceName: string;
  portalUrl: string;
  amountDollars: number;
  brand: string;
  last4: string;
  failureKind: "authentication_required" | "card_declined";
};
const sentFailureEmails: SentFailureEmail[] = [];
let failureEmailResult: { ok: true } | { ok: false; error: string } = { ok: true };

mock.module("@/lib/email/resend", {
  namedExports: {
    sendAutopayFailureEmail: async (input: SentFailureEmail) => {
      sentFailureEmails.push(input);
      return failureEmailResult.ok
        ? { ok: true, providerId: "rs_test", fromEmail: "test@from" }
        : { ok: false, error: failureEmailResult.error };
    },
  },
});

let attemptAutopayForInvoice: (input: {
  organizationId: string;
  patientInvoiceId: string;
}) => Promise<{ attempted: boolean; ok: boolean; code: string; message: string }>;

let retryEligibleAutopayFailures: (opts: {
  organizationId?: string;
  now?: Date;
  backoffHours?: readonly number[];
}) => Promise<{
  scanned: number;
  retried: number;
  succeeded: number;
  failed: number;
  skipped: number;
  decisions: Array<{
    organizationId: string;
    patientInvoiceId: string;
    outcome: string;
    attemptCountBefore: number;
    nextRetryAt?: string | null;
  }>;
}>;

before(async () => {
  const mod = await import("../autopayService");
  attemptAutopayForInvoice = mod.attemptAutopayForInvoice;
  retryEligibleAutopayFailures = mod.retryEligibleAutopayFailures;
});

beforeEach(() => {
  resetState();
  chargeOutcome = { ok: true, paymentIntentId: "pi_test_1" };
  sentFailureEmails.length = 0;
  failureEmailResult = { ok: true };
  sentEmails.length = 0;
  emailOk = true;
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
      email: "jane@example.com",
      autopay_enabled: opts.autopay,
      stripe_customer_id: opts.hasCard ?? true ? "cus_1" : null,
      stripe_payment_method_id: opts.hasCard ?? true ? "pm_1" : null,
      stripe_payment_method_brand: "visa",
      stripe_payment_method_last4: "4242",
      stripe_connect_account_id: opts.hasCard ?? true ? "acct_1" : null,
      archived_at: null,
    },
  ];
  tables.organizations = [{ id: "org-1", name: "Riverside Therapy" }];
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

  // Task #674: filing an autopay_charge_failed WQ row so the portal can
  // surface the "Fix payment" banner and a biller can chase it.
  const wqRow = inserted.find((i) => i.table === "workqueue_items");
  assert.ok(wqRow, "expected an autopay_charge_failed workqueue_items row");
  assert.equal(wqRow!.row.work_type, "autopay_charge_failed");
  assert.equal(wqRow!.row.status, "open");
  assert.equal(wqRow!.row.source_object_id, "inv-1");
  const ctx = wqRow!.row.context_payload as Record<string, unknown>;
  assert.equal(ctx.patient_invoice_id, "inv-1");
  assert.equal(ctx.error_code, "card_declined");
});

test("Task #736: emails the client with decline copy on plain card decline", async () => {
  seedInvoiceAndClient({ autopay: true });
  chargeOutcome = {
    ok: false,
    code: "card_declined",
    message: "Your card was declined.",
  };
  await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  assert.equal(sentFailureEmails.length, 1);
  const email = sentFailureEmails[0];
  assert.equal(email.to, "jane@example.com");
  assert.equal(email.failureKind, "card_declined");
  assert.equal(email.amountDollars, 50);
  assert.equal(email.brand, "visa");
  assert.equal(email.last4, "4242");
  assert.equal(email.practiceName, "Riverside Therapy");
  assert.match(email.portalUrl, /\/portal\/home$/);
  // Audit row stamped so the throttle has something to look at.
  const audit = inserted.find(
    (i) =>
      i.table === "audit_logs" &&
      i.row.event_type === "patient_billing_autopay_failure_email_sent",
  );
  assert.ok(audit, "expected failure-email audit row");
  const md = audit!.row.event_metadata as Record<string, unknown>;
  assert.equal(md.ok, true);
  assert.equal(md.failure_kind, "card_declined");
});

test("Task #736: emails the client with 3DS copy on authentication_required", async () => {
  seedInvoiceAndClient({ autopay: true });
  chargeOutcome = {
    ok: false,
    code: "authentication_required",
    message: "Authentication required by issuer.",
  };
  await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  assert.equal(sentFailureEmails.length, 1);
  assert.equal(sentFailureEmails[0].failureKind, "authentication_required");
});

test("Task #736: throttles a second failure email within the cooldown window", async () => {
  seedInvoiceAndClient({ autopay: true });
  chargeOutcome = {
    ok: false,
    code: "card_declined",
    message: "Your card was declined.",
  };
  await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  // Second failure for the same invoice immediately after — the throttle
  // audit row should suppress the re-send.
  await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  assert.equal(
    sentFailureEmails.length,
    1,
    "expected exactly one email across two back-to-back failures",
  );
});

test("Task #736: skips the email when the client has no email on file", async () => {
  seedInvoiceAndClient({ autopay: true });
  // Strip the email after seeding.
  (tables.clients![0] as Row).email = null;
  chargeOutcome = {
    ok: false,
    code: "card_declined",
    message: "Your card was declined.",
  };
  await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  assert.equal(sentFailureEmails.length, 0);
  // And we should not stamp a misleading throttle row in that case.
  const audit = inserted.find(
    (i) =>
      i.table === "audit_logs" &&
      i.row.event_type === "patient_billing_autopay_failure_email_sent",
  );
  assert.equal(audit, undefined);
});

test("dedupes the autopay_charge_failed WQ row across repeat failures", async () => {
  seedInvoiceAndClient({ autopay: true });
  chargeOutcome = {
    ok: false,
    code: "card_declined",
    message: "Your card was declined.",
  };
  await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  // A second failure for the SAME invoice should not stack another WQ
  // row (the open one is enough; biller / portal would just see "still
  // failing" and act once).
  await attemptAutopayForInvoice({
    organizationId: "org-1",
    patientInvoiceId: "inv-1",
  });
  const wqRows = inserted.filter((i) => i.table === "workqueue_items");
  assert.equal(wqRows.length, 1, "expected exactly one open WQ row per invoice");
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

/* -------- Retry sweep tests (Task #669) -------- */

const NOW = new Date("2026-05-25T12:00:00.000Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

function seedRetryFixtures(opts: {
  autopay?: boolean;
  hasCard?: boolean;
  invoiceStatus?: string;
  balance?: number;
  email?: string | null;
}) {
  tables.patient_invoices = [
    {
      id: "inv-r",
      organization_id: "org-1",
      client_id: "cli-r",
      invoice_status: opts.invoiceStatus ?? "open",
      balance_amount: opts.balance ?? 50,
      archived_at: null,
    },
  ];
  tables.clients = [
    {
      id: "cli-r",
      organization_id: "org-1",
      first_name: "Ray",
      last_name: "Tri",
      email: opts.email === undefined ? "ray@example.com" : opts.email,
      autopay_enabled: opts.autopay ?? true,
      stripe_customer_id: opts.hasCard ?? true ? "cus_r" : null,
      stripe_payment_method_id: opts.hasCard ?? true ? "pm_r" : null,
      stripe_payment_method_brand: "visa",
      stripe_payment_method_last4: "0000",
      stripe_connect_account_id: opts.hasCard ?? true ? "acct_r" : null,
      archived_at: null,
    },
  ];
  tables.organizations = [{ id: "org-1", name: "Test Practice" }];
}

function seedAuditEvents(events: Array<{ type: "failed" | "succeeded"; at: string }>) {
  tables.audit_logs = events.map((e, i) => ({
    organization_id: "org-1",
    object_type: "patient_invoice",
    object_id: "inv-r",
    event_type:
      e.type === "failed"
        ? "patient_billing_autopay_failed"
        : "patient_billing_autopay_succeeded",
    event_metadata: {},
    created_at: e.at,
    _seed_order: i,
  }));
}

test("retry: skips when most recent attempt was within the backoff window", async () => {
  seedRetryFixtures({});
  seedAuditEvents([{ type: "failed", at: hoursAgo(2) }]);
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.retried, 0);
  assert.equal(r.skipped, 1);
  assert.equal(r.decisions[0].outcome, "skipped_not_due");
});

test("retry: charges when the 24h backoff has elapsed and balance is open", async () => {
  seedRetryFixtures({});
  seedAuditEvents([{ type: "failed", at: hoursAgo(25) }]);
  chargeOutcome = { ok: true, paymentIntentId: "pi_retry_ok" };
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.retried, 1);
  assert.equal(r.succeeded, 1);
  assert.equal(r.decisions[0].outcome, "retried");
  const successAudit = inserted.find(
    (i) =>
      i.table === "audit_logs" &&
      i.row.event_type === "patient_billing_autopay_succeeded",
  );
  assert.ok(successAudit, "expected a new success audit after the retry");
});

test("retry: skips after max attempts is exhausted (1 original + 3 retries)", async () => {
  seedRetryFixtures({});
  seedAuditEvents([
    { type: "failed", at: hoursAgo(200) },
    { type: "failed", at: hoursAgo(176) },
    { type: "failed", at: hoursAgo(104) },
    { type: "failed", at: hoursAgo(32) },
  ]);
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.retried, 0);
  assert.equal(r.decisions[0].outcome, "skipped_exhausted");
});

test("retry: exhausted invoice stays exhausted even after old failure events age out of the look-back window", async () => {
  // Regression: prior implementation counted attempts only within a
  // sliding look-back window (~sum-of-backoffs+24h). Once the older
  // failures aged out, an already-exhausted invoice would look like it
  // had only 1 prior attempt and get re-charged again, violating the
  // max-3-retries contract. The fix runs an unbounded count query, so
  // this test seeds only one in-window event but pretends three older
  // failures already happened (still present in the audit_logs table).
  seedRetryFixtures({});
  // All four failures are in audit_logs, but only the most recent is
  // inside the cron's look-back window (288h with default backoffs).
  tables.audit_logs = [
    { organization_id: "org-1", object_type: "patient_invoice", object_id: "inv-r", event_type: "patient_billing_autopay_failed", event_metadata: {}, created_at: hoursAgo(600) },
    { organization_id: "org-1", object_type: "patient_invoice", object_id: "inv-r", event_type: "patient_billing_autopay_failed", event_metadata: {}, created_at: hoursAgo(550) },
    { organization_id: "org-1", object_type: "patient_invoice", object_id: "inv-r", event_type: "patient_billing_autopay_failed", event_metadata: {}, created_at: hoursAgo(500) },
    { organization_id: "org-1", object_type: "patient_invoice", object_id: "inv-r", event_type: "patient_billing_autopay_failed", event_metadata: {}, created_at: hoursAgo(48) },
  ];
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.retried, 0);
  assert.equal(r.decisions[0].outcome, "skipped_exhausted");
  assert.equal(r.decisions[0].attemptCountBefore, 4);
});

test("retry: skips when the latest event is a success (already recovered)", async () => {
  seedRetryFixtures({});
  seedAuditEvents([
    { type: "failed", at: hoursAgo(48) },
    { type: "succeeded", at: hoursAgo(2) },
  ]);
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.decisions[0].outcome, "skipped_recovered");
});

test("retry: skips silently when client has turned autopay off", async () => {
  seedRetryFixtures({ autopay: false });
  seedAuditEvents([{ type: "failed", at: hoursAgo(48) }]);
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.decisions[0].outcome, "skipped_autopay_off");
  // Must not emit another failed audit or failed payment row when the
  // client opted out — that is the explicit Task #669 acceptance bar.
  assert.equal(
    inserted.filter(
      (i) =>
        i.table === "audit_logs" &&
        i.row.event_type === "patient_billing_autopay_failed",
    ).length,
    0,
  );
  assert.equal(
    inserted.filter((i) => i.table === "patient_invoice_payments").length,
    0,
  );
});

test("retry: skips silently when the saved card has been removed", async () => {
  seedRetryFixtures({ hasCard: false });
  seedAuditEvents([{ type: "failed", at: hoursAgo(48) }]);
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.decisions[0].outcome, "skipped_no_card");
  assert.equal(
    inserted.filter(
      (i) =>
        i.table === "audit_logs" &&
        i.row.event_type === "patient_billing_autopay_failed",
    ).length,
    0,
  );
});

test("retry: skips when invoice has been paid out of band", async () => {
  seedRetryFixtures({ invoiceStatus: "paid", balance: 0 });
  seedAuditEvents([{ type: "failed", at: hoursAgo(48) }]);
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.decisions[0].outcome, "skipped_invoice_closed");
});

test("retry: failed retry writes a new failed audit so its timestamp resets the backoff", async () => {
  seedRetryFixtures({});
  seedAuditEvents([{ type: "failed", at: hoursAgo(48) }]);
  chargeOutcome = {
    ok: false,
    code: "card_declined",
    message: "Your card was declined.",
  };
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.retried, 1);
  assert.equal(r.failed, 1);
  const newFailureAudit = inserted.find(
    (i) =>
      i.table === "audit_logs" &&
      i.row.event_type === "patient_billing_autopay_failed",
  );
  assert.ok(newFailureAudit, "expected a fresh failed audit so the retry is auditable");
});

/* -------- Final-retry heads-up email (Task #732) -------- */

test("retry-notice: sends heads-up email before the FINAL retry and records audit", async () => {
  seedRetryFixtures({});
  // 3 prior failures → upcoming attempt would be #4 (the final one).
  // Backoff between the 3rd failure and the upcoming attempt is 168h,
  // so the most recent failure must be ≥ 168h old for the retry to be
  // due. NOW - 200h satisfies that while still being inside the
  // engine's look-back window (288h with default backoffs).
  seedAuditEvents([
    { type: "failed", at: hoursAgo(400) },
    { type: "failed", at: hoursAgo(300) },
    { type: "failed", at: hoursAgo(200) },
  ]);
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.retried, 1, "the final retry should still execute");
  assert.equal(sentEmails.length, 1, "expected exactly one heads-up email");
  assert.equal(sentEmails[0]!.to, "ray@example.com");
  assert.equal(sentEmails[0]!.practiceName, "Test Practice");
  const noticeAudit = inserted.find(
    (i) =>
      i.table === "audit_logs" &&
      i.row.event_type === "patient_billing_autopay_retry_notice_sent",
  );
  assert.ok(noticeAudit, "expected a patient_billing_autopay_retry_notice_sent audit row");
  const md = noticeAudit!.row.event_metadata as Record<string, unknown>;
  assert.equal(md.attempt, 4);
  assert.equal(md.patient_invoice_id, "inv-r");
  assert.equal(md.ok, true);
});

test("retry-notice: does NOT send before an intermediate (non-final) retry", async () => {
  seedRetryFixtures({});
  // Only 1 prior failure → upcoming attempt is #2 (not final)
  seedAuditEvents([{ type: "failed", at: hoursAgo(25) }]);
  const r = await retryEligibleAutopayFailures({
    organizationId: "org-1",
    now: NOW,
  });
  assert.equal(r.retried, 1);
  assert.equal(sentEmails.length, 0, "no email should fire for intermediate retries");
  const noticeAudit = inserted.find(
    (i) =>
      i.table === "audit_logs" &&
      i.row.event_type === "patient_billing_autopay_retry_notice_sent",
  );
  assert.equal(noticeAudit, undefined);
});

test("retry-notice: dedupes per (invoice, attempt) — second run of the same day does not re-email", async () => {
  seedRetryFixtures({});
  // 3 prior failures → upcoming is the final attempt; spacing chosen
  // so the 168h backoff after the 3rd failure has elapsed.
  seedAuditEvents([
    { type: "failed", at: hoursAgo(400) },
    { type: "failed", at: hoursAgo(300) },
    { type: "failed", at: hoursAgo(200) },
  ]);
  // First sweep: stripe fails so the retry doesn't recover; we still
  // sent the notice. Set failure so the invoice stays open + we don't
  // mark exhausted incorrectly via success.
  chargeOutcome = {
    ok: false,
    code: "card_declined",
    message: "Your card was declined.",
  };
  await retryEligibleAutopayFailures({ organizationId: "org-1", now: NOW });
  const firstCount = sentEmails.length;
  assert.equal(firstCount, 1);

  // Simulate the cron running again later the same day: the new failure
  // audit from the prior call bumped the attempt history to 4, which
  // means the upcoming attempt would be #5 — i.e. exhausted — so no
  // additional retry should run AND no new email. This is exactly the
  // behavior we want (one heads-up per final attempt, never spam).
  await retryEligibleAutopayFailures({ organizationId: "org-1", now: NOW });
  assert.equal(sentEmails.length, 1, "second sweep must not re-send the heads-up email");
});
