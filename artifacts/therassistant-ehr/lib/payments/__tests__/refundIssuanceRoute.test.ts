/**
 * Route-level coverage for POST /api/billing/refunds/:rowId (action=issue_refund)
 * — Task #500.
 *
 * The refund-issuance helper is verified end-to-end through the route:
 *   - client refund with a Stripe-origin client_payment → calls
 *     createConnectRefund (with stripe_connected_account_id threaded
 *     through) and stamps stripe_refund_id + refund_status='issued'
 *   - client refund where Stripe rejects → refund_status='failed' with
 *     the error in note, response success:false
 *   - insurance refund → confirmInsuranceRefund is called with the
 *     synthetic check number, stub appears in note, status='issued'
 *
 * Supabase + auth + Stripe + posting engine are all module-mocked so
 * the test is hermetic.
 */
import { strict as assert } from "node:assert";
import { before, beforeEach, mock, test } from "node:test";

const ORG = "11111111-1111-1111-1111-111111111111";
const REFUND_ID = "22222222-2222-2222-2222-222222222222";
const CP_ID = "33333333-3333-3333-3333-333333333333";

type RefundRow = {
  id: string;
  refund_type: "client" | "insurance";
  client_id: string | null;
  professional_claim_id: string | null;
  payer_profile_id: string | null;
  amount: number;
  refund_status: string;
  reason: string | null;
  note: string | null;
  requested_at: string | null;
  issued_at: string | null;
  source_client_payment_id: string | null;
  source_era_claim_payment_id: string | null;
  stripe_refund_id: string | null;
};

type ClientPaymentRow = {
  id: string;
  stripe_charge_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_connected_account_id: string | null;
};

const state: {
  refund: RefundRow;
  clientPayment: ClientPaymentRow | null;
  updates: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  stripeMode: "ok" | "fail";
  lastStripeCall: Record<string, unknown> | null;
  insuranceEngineMode: "ok" | "fail";
  lastInsuranceCall: Record<string, unknown> | null;
} = {
  refund: makeRefund({}),
  clientPayment: null,
  updates: [],
  audits: [],
  stripeMode: "ok",
  lastStripeCall: null,
  insuranceEngineMode: "ok",
  lastInsuranceCall: null,
};

function makeRefund(overrides: Partial<RefundRow>): RefundRow {
  return {
    id: REFUND_ID,
    refund_type: "client",
    client_id: "cli-1",
    professional_claim_id: null,
    payer_profile_id: null,
    amount: 50,
    refund_status: "pending",
    reason: null,
    note: null,
    requested_at: "2026-05-01T00:00:00Z",
    issued_at: null,
    source_client_payment_id: CP_ID,
    source_era_claim_payment_id: null,
    stripe_refund_id: null,
    ...overrides,
  };
}

function makeQuery(table: string) {
  const ctx: { filters: Record<string, unknown>; updates: Record<string, unknown> | null } = {
    filters: {},
    updates: null,
  };
  const q: any = {
    select: (_cols?: string) => q,
    eq: (k: string, v: unknown) => {
      ctx.filters[k] = v;
      return q;
    },
    is: (_k: string, _v: unknown) => q,
    order: () => q,
    limit: () => q,
    insert: (row: Record<string, unknown>) => {
      if (table === "audit_logs") {
        state.audits.push(row);
        return { then: (cb: any) => cb({ data: null, error: null }) };
      }
      return q;
    },
    update: (row: Record<string, unknown>) => {
      ctx.updates = row;
      // Return a chainable that records the update once .eq() resolves the row id.
      const u: any = {
        eq: (k: string, v: unknown) => {
          ctx.filters[k] = v;
          return u;
        },
        is: () => u,
        select: () => u,
        single: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (cb: any) => {
          if (table === "payment_refunds" && ctx.filters.id === REFUND_ID) {
            state.updates.push(row);
            // Mutate the in-memory refund so re-fetches see the new state.
            for (const [k, v] of Object.entries(row)) {
              (state.refund as any)[k] = v;
            }
          }
          return cb({ data: null, error: null });
        },
      };
      return u;
    },
    maybeSingle: async () => {
      if (table === "payment_refunds") {
        return { data: state.refund, error: null };
      }
      if (table === "client_payments") {
        return { data: state.clientPayment, error: null };
      }
      return { data: null, error: null };
    },
    single: async () => ({ data: null, error: null }),
  };
  return q;
}

before(() => {
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createServerSupabaseAdminClient: () => ({
        from: (t: string) => makeQuery(t),
      }),
    },
  });

  mock.module("@/lib/billing/requireBillingAccess", {
    namedExports: {
      requireBillingAccess: async () => ({
        organizationId: ORG,
        userId: "user-1",
        staffId: "staff-1",
        roles: ["biller"],
      }),
    },
  });

  mock.module("@/lib/stripe/connect", {
    namedExports: {
      getStripeSecretKey: () => "sk_test_xxx",
      StripeRequestError: class extends Error {
        status: number;
        stripeCode?: string;
        constructor(message: string, status: number, _raw?: unknown, code?: string) {
          super(message);
          this.status = status;
          this.stripeCode = code;
        }
      },
      createConnectRefund: async (input: Record<string, unknown>) => {
        state.lastStripeCall = input;
        if (state.stripeMode === "fail") {
          const Err = (await import("@/lib/stripe/connect")).StripeRequestError as any;
          throw new Err("No such charge: ch_x", 404, null, "resource_missing");
        }
        return {
          id: "re_test_1",
          amount: input.amountCents as number,
          currency: "usd",
          status: "succeeded",
        };
      },
    },
  });

  mock.module("@/lib/payments/postingEngine", {
    namedExports: {
      confirmInsuranceRefund: async (input: Record<string, unknown>) => {
        state.lastInsuranceCall = input;
        if (state.insuranceEngineMode === "fail") {
          return {
            ok: false,
            refundId: null,
            refundStatus: null,
            ledgerEntriesWritten: 0,
            errors: [{ field: "era_posting_ledger_entries", message: "Ledger write failed" }],
          };
        }
        return {
          ok: true,
          refundId: REFUND_ID,
          refundStatus: "issued",
          ledgerEntriesWritten: 1,
          errors: [],
        };
      },
    },
  });
});

beforeEach(() => {
  state.refund = makeRefund({});
  state.clientPayment = null;
  state.updates = [];
  state.audits = [];
  state.stripeMode = "ok";
  state.lastStripeCall = null;
  state.insuranceEngineMode = "ok";
  state.lastInsuranceCall = null;
});

async function loadPOST() {
  const mod = await import("../../../app/api/billing/refunds/[rowId]/route");
  return mod.POST as (
    r: Request,
    ctx: { params: Promise<{ rowId: string }> },
  ) => Promise<Response>;
}

function postRequest(body: Record<string, unknown>) {
  return new Request("https://x.test/api/billing/refunds/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("client refund issuance: calls Stripe with connected-account header, stamps stripe_refund_id", async () => {
  state.clientPayment = {
    id: CP_ID,
    stripe_charge_id: "ch_test_1",
    stripe_payment_intent_id: null,
    stripe_connected_account_id: "acct_test_1",
  };
  const POST = await loadPOST();
  const res = await POST(
    postRequest({ organizationId: ORG, action: "issue_refund" }),
    { params: Promise.resolve({ rowId: `refund:${REFUND_ID}` }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.success, true);
  assert.equal(body.refundStatus, "issued");
  assert.equal(body.stripeRefundId, "re_test_1");

  assert.ok(state.lastStripeCall);
  assert.equal(state.lastStripeCall?.chargeId, "ch_test_1");
  assert.equal(state.lastStripeCall?.connectedAccountId, "acct_test_1");
  assert.equal(state.lastStripeCall?.amountCents, 5000);
  // Idempotency key must derive from the refund id so a retry collapses.
  assert.match(String(state.lastStripeCall?.idempotencyKey ?? ""), /^wq-refund-/);

  // The refund row was updated with the Stripe id and issued status.
  const stripeUpdate = state.updates.find((u) => u.stripe_refund_id);
  assert.ok(stripeUpdate);
  assert.equal(stripeUpdate?.stripe_refund_id, "re_test_1");
  assert.equal(stripeUpdate?.refund_status, "issued");
});

test("client refund: Stripe failure → refund_status='failed' and error in note", async () => {
  state.clientPayment = {
    id: CP_ID,
    stripe_charge_id: "ch_test_1",
    stripe_payment_intent_id: null,
    stripe_connected_account_id: "acct_test_1",
  };
  state.stripeMode = "fail";
  const POST = await loadPOST();
  const res = await POST(
    postRequest({ organizationId: ORG, action: "issue_refund", reason: "duplicate" }),
    { params: Promise.resolve({ rowId: `refund:${REFUND_ID}` }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.success, false);
  assert.equal(body.refundStatus, "failed");
  assert.equal(body.stripeRefundId, null);
  assert.match(String(body.error ?? ""), /resource_missing|No such charge/);

  const failUpdate = state.updates.find((u) => u.refund_status === "failed");
  assert.ok(failUpdate, "expected a refund_status='failed' update");
  assert.match(String(failUpdate?.note ?? ""), /STRIPE_REFUND_FAILED/);
});

test("insurance refund issuance: stamps check stub, calls confirmInsuranceRefund with check number", async () => {
  state.refund = makeRefund({
    refund_type: "insurance",
    source_client_payment_id: null,
    source_era_claim_payment_id: "era-1",
    payer_profile_id: "payer-1",
    professional_claim_id: "claim-1",
    amount: 125,
  });
  const POST = await loadPOST();
  const res = await POST(
    postRequest({ organizationId: ORG, action: "issue_refund", reason: "Overpaid" }),
    { params: Promise.resolve({ rowId: `refund:${REFUND_ID}` }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.success, true);
  assert.equal(body.refundStatus, "issued");
  assert.match(String(body.checkNumber ?? ""), /^RFD-\d{8}-/);

  // The route stamped the printable check stub into the note before
  // calling the engine so a paper trail exists even on engine failure.
  const noteUpdate = state.updates.find((u) =>
    String((u as { note?: string }).note ?? "").includes("CHECK_STUB"),
  );
  assert.ok(noteUpdate, "expected a check-stub note line");
  assert.match(String(noteUpdate?.note ?? ""), /era=era-1/);
  assert.match(String(noteUpdate?.note ?? ""), /payer_profile_id=payer-1/);

  // Engine was called with the same external reference the response surfaces.
  assert.ok(state.lastInsuranceCall);
  assert.equal(state.lastInsuranceCall?.refundId, REFUND_ID);
  assert.equal(state.lastInsuranceCall?.externalReferenceNumber, body.checkNumber);
});

test("insurance refund: engine failure → refund_status='failed'", async () => {
  state.refund = makeRefund({
    refund_type: "insurance",
    source_client_payment_id: null,
    source_era_claim_payment_id: "era-1",
    payer_profile_id: "payer-1",
    amount: 75,
  });
  state.insuranceEngineMode = "fail";
  const POST = await loadPOST();
  const res = await POST(
    postRequest({ organizationId: ORG, action: "issue_refund" }),
    { params: Promise.resolve({ rowId: `refund:${REFUND_ID}` }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.success, false);
  assert.equal(body.refundStatus, "failed");
  const failUpdate = state.updates.find((u) => u.refund_status === "failed");
  assert.ok(failUpdate);
  assert.match(String(failUpdate?.note ?? ""), /INSURANCE_REFUND_FAILED/);
});
