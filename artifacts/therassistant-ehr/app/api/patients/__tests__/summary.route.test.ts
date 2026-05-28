// Coverage for the client summary endpoint's "Credit on account" rollup.
//
// Pins two contracts the UI's Summary card depends on:
//   1. `creditOnAccount` equals the sum of `balance_amount` across the
//      client's non-archived `client_credits` rows scoped to organization.
//   2. A query error on `client_credits` falls back to `creditOnAccount = null`
//      so the rest of the summary still renders (legacy envs may not have
//      the table at all).

import { strict as assert } from "node:assert";
import { before, mock, test } from "node:test";

const ORG = "org-1";
const CLIENT = "client-1";

type Row = Record<string, unknown>;
type Filter = { field: string; value: unknown };

type Result = { data: Row | Row[] | null; error: { message: string } | null };

type QueryHandler = (filters: Filter[]) => Result;

const handlers: Record<string, QueryHandler> = {};

function builder(table: string) {
  const filters: Filter[] = [];

  function settle(): Result {
    const handler = handlers[table];
    if (!handler) return { data: null, error: null };
    return handler(filters);
  }

  const chain: Record<string, unknown> = {};
  chain.select = (..._args: unknown[]) => chain;
  chain.eq = (field: string, value: unknown) => {
    filters.push({ field, value });
    return chain;
  };
  chain.in = (field: string, value: unknown) => {
    filters.push({ field, value });
    return chain;
  };
  chain.is = (field: string, value: unknown) => {
    filters.push({ field, value });
    return chain;
  };
  chain.order = (..._args: unknown[]) => chain;
  chain.limit = (..._args: unknown[]) => chain;
  chain.maybeSingle = async () => settle();
  chain.single = async () => settle();
  chain.then = (onFulfilled: (v: Result) => unknown) =>
    Promise.resolve(onFulfilled(settle()));
  return chain;
}

function setHandlers(next: Record<string, QueryHandler>) {
  for (const key of Object.keys(handlers)) delete handlers[key];
  Object.assign(handlers, next);
}

before(() => {
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createServerSupabaseAdminClient: () => ({
        from(table: string) {
          return builder(table);
        },
      }),
    },
  });
  // The route is tenant-isolated via requireOrgAccess; stub it out so the
  // tests can exercise the credit-rollup logic without a real Supabase
  // auth cookie. We return the org the test passes via ?organizationId=.
  mock.module("@/lib/auth/requireOrgAccess", {
    namedExports: {
      requireOrgAccess: async (options: { requestedOrganizationId?: string | null } = {}) => ({
        organizationId: options.requestedOrganizationId || ORG,
        staffId: "staff-test",
        userId: "user-test",
        roles: [],
        permissions: [],
        isDevPassthrough: false,
      }),
    },
  });
  mock.module("@/lib/rbac/auth", {
    namedExports: {
      requireAuthenticatedStaff: async () => ({
        organizationId: ORG,
        staffId: "staff-test",
        userId: "user-test",
        email: null,
        firstName: null,
        lastName: null,
        roles: [],
        permissions: [],
      }),
    },
  });
});

const defaultClient: Row = {
  id: CLIENT,
  organization_id: ORG,
  first_name: "Pat",
  last_name: "Doe",
};

function baseHandlers(overrides: Record<string, QueryHandler> = {}): Record<string, QueryHandler> {
  return {
    clients: () => ({ data: defaultClient, error: null }),
    insurance_policies: () => ({ data: [], error: null }),
    eligibility_checks: () => ({ data: null, error: null }),
    encounters: () => ({ data: [], error: null }),
    workqueue_items: () => ({ data: [], error: null }),
    patient_invoices: () => ({ data: [], error: null }),
    client_credits: () => ({ data: [], error: null }),
    ...overrides,
  };
}

async function loadGet() {
  const mod = await import("../[clientId]/summary/route");
  return mod.GET as (
    r: Request,
    ctx: { params: Promise<{ clientId: string }> },
  ) => Promise<Response>;
}

function summaryRequest(): Request {
  return new Request(
    `https://app.test/api/patients/${CLIENT}/summary?organizationId=${ORG}`,
  );
}

function summaryContext() {
  return { params: Promise.resolve({ clientId: CLIENT }) };
}

test("creditOnAccount sums non-archived client_credits scoped to the org/client", async () => {
  let creditFilters: Filter[] = [];
  setHandlers(
    baseHandlers({
      client_credits: (filters) => {
        creditFilters = filters;
        return {
          data: [
            { balance_amount: 25 },
            { balance_amount: "10.5" },
            { balance_amount: 4.25 },
            { balance_amount: null },
          ],
          error: null,
        };
      },
    }),
  );

  const GET = await loadGet();
  const res = await GET(summaryRequest(), summaryContext());
  assert.equal(res.status, 200);

  const body = (await res.json()) as { success: boolean; creditOnAccount: number | null };
  assert.equal(body.success, true);
  assert.equal(body.creditOnAccount, 39.75);

  // Must scope to org + client and exclude archived rows.
  const has = (field: string, value: unknown) =>
    creditFilters.some((f) => f.field === field && f.value === value);
  assert.ok(has("organization_id", ORG), "must filter by organization_id");
  assert.ok(has("client_id", CLIENT), "must filter by client_id");
  assert.ok(has("archived_at", null), "must exclude archived rows (archived_at IS NULL)");
});

test("creditOnAccount falls back to null when the client_credits query errors", async () => {
  setHandlers(
    baseHandlers({
      client_credits: () => ({
        data: null,
        error: { message: 'relation "client_credits" does not exist' },
      }),
    }),
  );

  const GET = await loadGet();
  const res = await GET(summaryRequest(), summaryContext());
  assert.equal(res.status, 200);

  const body = (await res.json()) as { success: boolean; creditOnAccount: number | null };
  assert.equal(body.success, true);
  assert.equal(body.creditOnAccount, null);
});

test("creditOnAccount is 0 when the client has no credit rows", async () => {
  setHandlers(baseHandlers());

  const GET = await loadGet();
  const res = await GET(summaryRequest(), summaryContext());
  assert.equal(res.status, 200);

  const body = (await res.json()) as { success: boolean; creditOnAccount: number | null };
  assert.equal(body.success, true);
  assert.equal(body.creditOnAccount, 0);
});
