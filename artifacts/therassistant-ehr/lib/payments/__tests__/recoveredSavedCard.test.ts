/**
 * Task #674: persistRecoveredSavedCardFromPaymentIntent unit tests.
 *
 * After the client completes the portal "Fix payment" Checkout flow
 * (setup_future_usage='off_session'), the webhook calls this helper to
 * mirror the resulting PaymentMethod onto clients.stripe_payment_method_*
 * so the next autopay cycle uses the fresh card.
 */
import { strict as assert } from "node:assert";
import { before, beforeEach, mock, test } from "node:test";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const tables: Tables = {};
const updated: Array<{ table: string; patch: Row }> = [];

function resetState() {
  for (const k of Object.keys(tables)) delete tables[k];
  updated.length = 0;
}

function fakeBuilder(table: string) {
  let rows = [...(tables[table] ?? [])];
  let pendingUpdate: Row | null = null;
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
  chain.update = (patch: Row) => {
    pendingUpdate = patch;
    for (const r of rows) Object.assign(r, patch);
    updated.push({ table, patch });
    return chain;
  };
  chain.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
    Promise.resolve(
      resolve({
        data: pendingUpdate ? rows : rows,
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

let persistRecoveredSavedCardFromPaymentIntent: typeof import(
  "../savedCardService"
).persistRecoveredSavedCardFromPaymentIntent;

before(async () => {
  const mod = await import("../savedCardService");
  persistRecoveredSavedCardFromPaymentIntent =
    mod.persistRecoveredSavedCardFromPaymentIntent;
});

beforeEach(() => {
  resetState();
  tables.clients = [
    {
      id: "cli-1",
      organization_id: "org-1",
      first_name: "Jane",
      last_name: "Doe",
      email: "jane@example.com",
      stripe_connect_account_id: "acct_1",
      stripe_customer_id: "cus_1",
      stripe_payment_method_id: "pm_old",
      stripe_payment_method_brand: "visa",
      stripe_payment_method_last4: "1111",
      stripe_payment_method_exp_month: 1,
      stripe_payment_method_exp_year: 2030,
      stripe_payment_method_saved_at: null,
      autopay_enabled: true,
    },
  ];
});

test("saves new card and detaches the old one when PI has a fresh PM", async () => {
  const detachCalls: Array<{ pm: string }> = [];
  const out = await persistRecoveredSavedCardFromPaymentIntent({
    organizationId: "org-1",
    clientId: "cli-1",
    paymentIntentId: "pi_recover",
    deps: {
      retrievePaymentIntent: async () => ({
        id: "pi_recover",
        status: "succeeded",
        customer: "cus_1",
        payment_method: "pm_new",
      }),
      retrievePaymentMethod: async () => ({
        id: "pm_new",
        type: "card",
        customer: "cus_1",
        card: { brand: "mastercard", last4: "4444", exp_month: 9, exp_year: 2031 },
      }),
      detachPaymentMethod: async ({ paymentMethodId }) => {
        detachCalls.push({ pm: paymentMethodId });
        return { id: paymentMethodId, type: "card" };
      },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, "saved");
  assert.equal(out.paymentMethodId, "pm_new");
  assert.deepEqual(detachCalls, [{ pm: "pm_old" }]);
  const client = tables.clients[0] as Row;
  assert.equal(client.stripe_payment_method_id, "pm_new");
  assert.equal(client.stripe_payment_method_brand, "mastercard");
  assert.equal(client.stripe_payment_method_last4, "4444");
});

test("no-op when PI's payment_method equals the existing saved one (3DS rescue)", async () => {
  const detachCalls: string[] = [];
  const out = await persistRecoveredSavedCardFromPaymentIntent({
    organizationId: "org-1",
    clientId: "cli-1",
    paymentIntentId: "pi_recover",
    deps: {
      retrievePaymentIntent: async () => ({
        id: "pi_recover",
        status: "succeeded",
        payment_method: "pm_old",
      }),
      retrievePaymentMethod: async () => {
        throw new Error("should not call retrievePaymentMethod on no_change");
      },
      detachPaymentMethod: async ({ paymentMethodId }) => {
        detachCalls.push(paymentMethodId);
        return { id: paymentMethodId, type: "card" };
      },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, "no_change");
  assert.deepEqual(detachCalls, []);
  // Saved card row stays exactly as-is.
  assert.equal(tables.clients[0].stripe_payment_method_id, "pm_old");
});

test("returns no_payment_method when PI has none (unexpected — but we don't blow up)", async () => {
  const out = await persistRecoveredSavedCardFromPaymentIntent({
    organizationId: "org-1",
    clientId: "cli-1",
    paymentIntentId: "pi_recover",
    deps: {
      retrievePaymentIntent: async () => ({
        id: "pi_recover",
        status: "succeeded",
        payment_method: null,
      }),
      retrievePaymentMethod: async () => {
        throw new Error("should not call retrievePaymentMethod with no PM");
      },
      detachPaymentMethod: async () => ({ id: "x", type: "card" }),
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, "no_payment_method");
});

test("returns no_connect_account when the client isn't pinned to a connected account", async () => {
  tables.clients[0].stripe_connect_account_id = null;
  const out = await persistRecoveredSavedCardFromPaymentIntent({
    organizationId: "org-1",
    clientId: "cli-1",
    paymentIntentId: "pi_recover",
    deps: {
      retrievePaymentIntent: async () => {
        throw new Error("should short-circuit before stripe call");
      },
      retrievePaymentMethod: async () => ({ id: "x", type: "card" }),
      detachPaymentMethod: async () => ({ id: "x", type: "card" }),
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, "no_connect_account");
});
