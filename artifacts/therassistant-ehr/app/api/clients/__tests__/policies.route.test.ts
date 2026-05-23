// PATCH /api/clients/[id]/policies/[policyId] — full policy editor.
//
// Pins three contracts the in-chart "Edit policy" UI depends on:
//   1. The route requires an authenticated staff session.
//   2. Effective date must be on or before termination date (cross-field
//      validation pulls the untouched side from the existing row).
//   3. payer_id must belong to the caller's organization — cross-org
//      payer ids are rejected even when the policy lookup succeeds.

import { strict as assert } from "node:assert";
import { before, mock, test } from "node:test";

const ORG = "org-1";
const CLIENT = "client-1";
const POLICY = "pol-1";

type Row = Record<string, unknown>;
type Filter = { field: string; value: unknown };
type Result = { data: Row | Row[] | null; error: { message: string } | null };
type Handler = (filters: Filter[], op: "select" | "update") => Result;

const handlers: Record<string, { select?: Handler; update?: Handler }> = {};
let lastUpdate: { table: string; values: Row } | null = null;

function builder(table: string) {
  const filters: Filter[] = [];
  let op: "select" | "update" = "select";
  let updateValues: Row | null = null;

  function settle(): Result {
    const h = handlers[table];
    const fn = op === "update" ? h?.update : h?.select;
    if (op === "update" && updateValues) {
      lastUpdate = { table, values: updateValues };
    }
    return fn ? fn(filters, op) : { data: null, error: null };
  }

  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.update = (values: Row) => {
    op = "update";
    updateValues = values;
    return chain;
  };
  chain.eq = (field: string, value: unknown) => {
    filters.push({ field, value });
    return chain;
  };
  chain.is = (field: string, value: unknown) => {
    filters.push({ field, value });
    return chain;
  };
  chain.maybeSingle = async () => settle();
  chain.single = async () => settle();
  chain.then = (onFulfilled: (v: Result) => unknown) =>
    Promise.resolve(onFulfilled(settle()));
  return chain;
}

const staffCtx: {
  current: { organizationId: string; staffId: string; userId: string } | null;
} = { current: null };

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
  mock.module("@/lib/rbac/auth", {
    namedExports: {
      requireAuthenticatedStaff: async () => staffCtx.current,
    },
  });
});

function setHandlers(next: Record<string, { select?: Handler; update?: Handler }>) {
  for (const key of Object.keys(handlers)) delete handlers[key];
  Object.assign(handlers, next);
  lastUpdate = null;
}

async function loadPatch() {
  const mod = await import("../[id]/policies/[policyId]/route");
  return mod.PATCH as (
    r: Request,
    ctx: { params: Promise<{ id: string; policyId: string }> },
  ) => Promise<Response>;
}

function req(body: unknown): Request {
  return new Request(
    `https://app.test/api/clients/${CLIENT}/policies/${POLICY}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: CLIENT, policyId: POLICY }) };
}

test("PATCH rejects unauthenticated callers", async () => {
  staffCtx.current = null;
  setHandlers({});
  const PATCH = await loadPatch();
  const res = await PATCH(req({ groupNumber: "X" }), ctx());
  assert.equal(res.status, 401);
});

test("PATCH updates all editable fields when payer + dates check out", async () => {
  staffCtx.current = { organizationId: ORG, staffId: "s1", userId: "u1" };
  setHandlers({
    insurance_policies: {
      select: () => ({
        data: {
          id: POLICY,
          organization_id: ORG,
          client_id: CLIENT,
          archived_at: null,
          effective_date: "2024-01-01",
          termination_date: null,
        },
        error: null,
      }),
      update: () => ({ data: null, error: null }),
    },
    insurance_payers: {
      select: () => ({
        data: { id: "payer-1", organization_id: ORG, archived_at: null },
        error: null,
      }),
    },
  });

  const PATCH = await loadPatch();
  const res = await PATCH(
    req({
      policyNumber: "POL-123",
      planName: "Gold PPO",
      payerId: "payer-1",
      groupNumber: "GRP-9",
      effectiveDate: "2024-02-01",
      terminationDate: "2024-12-31",
      copayAmount: "25",
    }),
    ctx(),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { success: boolean; updated: string[] };
  assert.equal(body.success, true);

  assert.ok(lastUpdate, "should have issued an update");
  assert.equal(lastUpdate!.table, "insurance_policies");
  assert.deepEqual(lastUpdate!.values, {
    group_number: "GRP-9",
    policy_number: "POL-123",
    plan_name: "Gold PPO",
    payer_id: "payer-1",
    effective_date: "2024-02-01",
    termination_date: "2024-12-31",
    copay_amount: "25.00",
  });
});

test("PATCH rejects effective date after termination date (using stored value)", async () => {
  staffCtx.current = { organizationId: ORG, staffId: "s1", userId: "u1" };
  setHandlers({
    insurance_policies: {
      select: () => ({
        data: {
          id: POLICY,
          organization_id: ORG,
          client_id: CLIENT,
          archived_at: null,
          effective_date: "2024-01-01",
          termination_date: "2024-06-01",
        },
        error: null,
      }),
      update: () => ({ data: null, error: null }),
    },
  });

  const PATCH = await loadPatch();
  // Only touches effectiveDate; termination_date from the existing row
  // ("2024-06-01") must still be honored for comparison.
  const res = await PATCH(req({ effectiveDate: "2024-09-01" }), ctx());
  assert.equal(res.status, 400);
  const body = (await res.json()) as { success: boolean; error: string };
  assert.match(body.error, /effective date/i);
  assert.equal(lastUpdate, null, "must not update on validation failure");
});

test("PATCH rejects payer_id from another organization", async () => {
  staffCtx.current = { organizationId: ORG, staffId: "s1", userId: "u1" };
  setHandlers({
    insurance_policies: {
      select: () => ({
        data: {
          id: POLICY,
          organization_id: ORG,
          client_id: CLIENT,
          archived_at: null,
          effective_date: null,
          termination_date: null,
        },
        error: null,
      }),
      update: () => ({ data: null, error: null }),
    },
    // Cross-org payer lookup returns no rows because the route filters by org.
    insurance_payers: {
      select: () => ({ data: null, error: null }),
    },
  });

  const PATCH = await loadPatch();
  const res = await PATCH(req({ payerId: "payer-other-org" }), ctx());
  assert.equal(res.status, 400);
  const body = (await res.json()) as { success: boolean; error: string };
  assert.match(body.error, /payer not found/i);
  assert.equal(lastUpdate, null);
});
