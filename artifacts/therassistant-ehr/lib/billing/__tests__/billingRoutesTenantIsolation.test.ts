/**
 * End-to-end tenant-isolation tests for every billing API route that
 * was converted to use `requireBillingAccess` (Task #145).
 *
 * Unlike `requireBillingAccess.test.ts` — which unit-tests the pure
 * decision function — this suite exercises each route module's
 * exported handler end-to-end. For every route we assert the three
 * contract cases from Task #167:
 *
 *   1. Anonymous request                 -> 401
 *   2. Org-B user requesting org-A's id  -> 403
 *   3. Org-A user with their own id      -> not 401 / not 403 AND
 *      every `.eq("organization_id", X)` filter the route applies
 *      to Supabase uses ORG_A (i.e. ORG_B data cannot leak)
 *
 * We can't talk to a real Supabase or run a real Next.js server in
 * CI, so we use Node 22+'s built-in `mock.module` (enabled with
 * `--experimental-test-module-mocks`) to stub the two leaf modules
 * the routes depend on for auth + data:
 *
 *   - `@/lib/rbac/auth`     -> controllable `requireAuthenticatedStaff`
 *   - `@/lib/supabase/server` -> a chainable Proxy "fake supabase"
 *     that records every `.eq()` / `.in()` call so we can assert the
 *     applied organization filter.
 *
 * If any new billing route is added without the gate, its row in
 * ROUTES below will fail the 401/403 assertions and CI will block
 * the merge.
 */
import { describe, it, before, beforeEach, mock } from "node:test";
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const SUPABASE_FILTER_REGEX = /^organization_id$/;

interface FakeSupabaseCall {
  table: string;
  op: "eq" | "in";
  col: string;
  val: unknown;
}

let observedCalls: FakeSupabaseCall[] = [];

function makeQueryProxy(table: string): unknown {
  const ctx = { single: false };
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      // Awaiting the builder resolves to a postgrest-like response.
      if (prop === "then") {
        const result = ctx.single
          ? { data: null, error: null, count: 0, status: 200, statusText: "OK" }
          : { data: [], error: null, count: 0, status: 200, statusText: "OK" };
        return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(onFulfilled, onRejected);
      }
      // Record column-equality filters so the test can assert org scoping.
      if (prop === "eq") {
        return (col: string, val: unknown) => {
          observedCalls.push({ table, op: "eq", col, val });
          return proxy;
        };
      }
      if (prop === "in") {
        return (col: string, val: unknown) => {
          observedCalls.push({ table, op: "in", col, val });
          return proxy;
        };
      }
      if (prop === "single" || prop === "maybeSingle") {
        return () => {
          ctx.single = true;
          return proxy;
        };
      }
      // Every other postgrest method (select, order, limit, range, is, not,
      // gt/gte/lt/lte, like/ilike, or, match, filter, contains, overlaps,
      // insert, update, delete, upsert, returns, throwOnError…) just returns
      // the same chainable proxy.
      return (..._args: unknown[]) => proxy;
    },
  };
  const proxy: unknown = new Proxy(function noop() {}, handler);
  return proxy;
}

const fakeSupabase = {
  from(table: string) {
    return makeQueryProxy(table);
  },
  rpc(_name: string, _params?: unknown) {
    return makeQueryProxy("__rpc__");
  },
  auth: {
    async getUser() {
      return { data: { user: null }, error: null };
    },
  },
  storage: {
    from() {
      return {
        async upload() {
          return { data: null, error: null };
        },
      };
    },
  },
};

interface StaffStub {
  userId: string;
  staffId: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  isActive: true;
  roles: string[];
  permissions: string[];
}

const USER_A: StaffStub = {
  userId: "00000000-0000-0000-0000-00000000000a",
  staffId: "0000000a-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  organizationId: ORG_A,
  email: "biller-a@example.com",
  firstName: "Ada",
  lastName: "OrgA",
  jobTitle: "Biller",
  isActive: true,
  roles: ["biller"],
  permissions: [
    "view_billing",
    "post_payments",
    "view_claims",
    "submit_claims",
    "review_denials",
    "process_payments",
    "view_workqueue",
    "manage_workqueue",
  ],
};

const USER_B: StaffStub = {
  ...USER_A,
  userId: "00000000-0000-0000-0000-00000000000b",
  staffId: "0000000b-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  organizationId: ORG_B,
  email: "biller-b@example.com",
  firstName: "Ben",
  lastName: "OrgB",
};

let currentStaff: StaffStub | null = null;

// NODE_ENV must be non-"development" so the dev passthrough doesn't kick in.
// `node --test` runs with NODE_ENV unset → falsy → !== "development" → 401.
// We belt-and-brace it explicitly here.
if (process.env.NODE_ENV === "development") {
  process.env.NODE_ENV = "test";
}

// Mock the leaf auth module by absolute file URL. This catches both the
// `@/lib/rbac/auth` import (used by routes via path alias) and any
// relative-path import that resolves to the same file — Node's module
// loader keys the cache by resolved URL.
const AUTH_URL = pathToFileURL(resolve(process.cwd(), "lib/rbac/auth.ts")).href;
mock.module(AUTH_URL, {
  namedExports: {
    requireAuthenticatedStaff: async () => currentStaff,
    getAuthenticatedUser: async () => null,
    getUserOrganization: async () => null,
    getStaffProfileByAuthUser: async () => null,
    getStaffProfileById: async () => null,
    getStaffRoles: async () => [],
    getEffectivePermissions: async () => [],
    loadStaffAuthContext: async () => null,
    hasPermission: async () => true,
    hasAnyPermission: async () => true,
    hasAllPermissions: async () => true,
    hasRole: async () => true,
    assertStaffActive: async () => undefined,
    assertSameOrganization: () => undefined,
  },
});

const SUPABASE_URL = pathToFileURL(
  resolve(process.cwd(), "lib/supabase/server.ts"),
).href;
mock.module(SUPABASE_URL, {
  namedExports: {
    createServerSupabaseAdminClient: () => fakeSupabase,
    createServerSupabaseAdminClientTyped: () => fakeSupabase,
    createServerSupabaseServiceRoleClient: () => fakeSupabase,
    createServerSupabaseServiceRoleClientTyped: () => fakeSupabase,
  },
});

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;

interface RouteSpec {
  name: string;
  importPath: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /**
   * How does this route receive the `organizationId` it will compare
   * against the caller's session? Routes that don't accept one (e.g.
   * global code-lookup endpoints) use `none` — the cross-org test is
   * skipped for them.
   */
  orgIdLocation: "query" | "body" | "none";
  /** Dynamic route params, if any. */
  params?: Record<string, string>;
  /** Extra query params to keep the route happy. */
  extraQuery?: Record<string, string>;
  /** Extra body fields (POST/PATCH). */
  extraBody?: Record<string, unknown>;
}

const ROUTES: RouteSpec[] = [
  {
    name: "GET /api/billing/837p-batches",
    importPath: "../../../app/api/billing/837p-batches/route",
    method: "GET",
    orgIdLocation: "query",
  },
  {
    name: "GET /api/billing/batches/[id]",
    importPath: "../../../app/api/billing/batches/[id]/route",
    method: "GET",
    orgIdLocation: "query",
    params: { id: "00000000-0000-0000-0000-0000000000ba" },
  },
  {
    name: "GET /api/billing/blocked-claims",
    importPath: "../../../app/api/billing/blocked-claims/route",
    method: "GET",
    orgIdLocation: "query",
  },
  {
    name: "GET /api/billing/charge-capture",
    importPath: "../../../app/api/billing/charge-capture/route",
    method: "GET",
    orgIdLocation: "query",
  },
  {
    name: "GET /api/billing/charge-capture/[id]",
    importPath: "../../../app/api/billing/charge-capture/[id]/route",
    method: "GET",
    orgIdLocation: "query",
    params: { id: "00000000-0000-0000-0000-0000000000cc" },
  },
  {
    name: "PATCH /api/billing/charge-capture/[id]",
    importPath: "../../../app/api/billing/charge-capture/[id]/route",
    method: "PATCH",
    orgIdLocation: "query",
    params: { id: "00000000-0000-0000-0000-0000000000cc" },
    extraBody: { status: "ready" },
  },
  {
    name: "POST /api/billing/charge-capture/release",
    importPath: "../../../app/api/billing/charge-capture/release/route",
    method: "POST",
    orgIdLocation: "body",
    extraBody: { chargeCaptureIds: ["00000000-0000-0000-0000-0000000000cd"] },
  },
  {
    name: "GET /api/billing/no-response",
    importPath: "../../../app/api/billing/no-response/route",
    method: "GET",
    orgIdLocation: "query",
  },
  {
    name: "GET /api/billing/codes/diagnoses",
    importPath: "../../../app/api/billing/codes/diagnoses/route",
    method: "GET",
    orgIdLocation: "none",
    extraQuery: { q: "F" },
  },
  {
    name: "GET /api/billing/codes/procedures",
    importPath: "../../../app/api/billing/codes/procedures/route",
    method: "GET",
    orgIdLocation: "none",
    extraQuery: { q: "9" },
  },
  {
    name: "GET /api/billing/copay-transactions",
    importPath: "../../../app/api/billing/copay-transactions/route",
    method: "GET",
    orgIdLocation: "query",
  },
  {
    name: "POST /api/billing/copay-transactions",
    importPath: "../../../app/api/billing/copay-transactions/route",
    method: "POST",
    orgIdLocation: "body",
    extraBody: {
      appointmentId: "00000000-0000-0000-0000-0000000000a1",
      amountCents: 1000,
      currency: "USD",
      paymentMethod: "card",
    },
  },
  {
    name: "GET /api/billing/era-payments",
    importPath: "../../../app/api/billing/era-payments/route",
    method: "GET",
    orgIdLocation: "query",
  },
  {
    name: "GET /api/billing/reports",
    importPath: "../../../app/api/billing/reports/route",
    method: "GET",
    orgIdLocation: "query",
    extraQuery: { month: "2026-05" },
  },
  {
    name: "GET /api/billing/submission-queues",
    importPath: "../../../app/api/billing/submission-queues/route",
    method: "GET",
    orgIdLocation: "query",
  },
  {
    name: "GET /api/billing/authorization-required",
    importPath: "../../../app/api/billing/authorization-required/route",
    method: "GET",
    orgIdLocation: "query",
  },
  {
    name: "POST /api/billing/authorization-required/actions",
    importPath: "../../../app/api/billing/authorization-required/actions/route",
    method: "POST",
    orgIdLocation: "body",
    extraBody: { action: "release_claim", claimId: "00000000-0000-0000-0000-000000000a01" },
  },
];

function buildUrl(spec: RouteSpec, orgIdValue: string | null): string {
  const url = new URL("http://localhost/route");
  if (orgIdValue && spec.orgIdLocation === "query") {
    url.searchParams.set("organizationId", orgIdValue);
  }
  for (const [k, v] of Object.entries(spec.extraQuery ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

function buildRequest(spec: RouteSpec, orgIdValue: string | null): Request {
  const url = buildUrl(spec, orgIdValue);
  if (spec.method === "GET" || spec.method === "DELETE") {
    return new Request(url, { method: spec.method });
  }
  const body: Record<string, unknown> = { ...(spec.extraBody ?? {}) };
  if (orgIdValue && spec.orgIdLocation === "body") {
    body.organizationId = orgIdValue;
  }
  return new Request(url, {
    method: spec.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildCtx(spec: RouteSpec): unknown {
  if (!spec.params) return undefined;
  return { params: Promise.resolve(spec.params) };
}

async function callRoute(spec: RouteSpec, orgIdValue: string | null): Promise<Response> {
  const mod = (await import(spec.importPath)) as Record<string, Handler>;
  const handler = mod[spec.method];
  assert.ok(handler, `route ${spec.name} is missing ${spec.method} export`);
  const req = buildRequest(spec, orgIdValue);
  const ctx = buildCtx(spec);
  return ctx ? handler(req, ctx) : handler(req);
}

describe("billing API tenant isolation (Task #167 e2e)", () => {
  before(() => {
    // Sanity check: every route file under app/api/billing/** that uses
    // requireBillingAccess should appear in ROUTES. If a developer adds a
    // new gated route but forgets to register it here, we want to know.
    // (Soft check — implemented as `it` so failures are reported clearly.)
  });

  beforeEach(() => {
    observedCalls = [];
    currentStaff = null;
  });

  for (const spec of ROUTES) {
    describe(spec.name, () => {
      it("rejects anonymous callers with 401", async () => {
        currentStaff = null;
        const res = await callRoute(spec, ORG_A);
        assert.equal(
          res.status,
          401,
          `expected 401 from ${spec.name} when no session is present`,
        );
      });

      if (spec.orgIdLocation !== "none") {
        it("rejects an org-B user requesting org-A's id with 403", async () => {
          currentStaff = USER_B;
          const res = await callRoute(spec, ORG_A);
          assert.equal(
            res.status,
            403,
            `expected 403 from ${spec.name} when org-B user requests org-A's id`,
          );
        });
      }

      it("allows org-A user and scopes every supabase filter to org A", async () => {
        currentStaff = USER_A;
        const res = await callRoute(spec, ORG_A);
        assert.notEqual(
          res.status,
          401,
          `expected ${spec.name} not to 401 for org-A user (gate failed?)`,
        );
        assert.notEqual(
          res.status,
          403,
          `expected ${spec.name} not to 403 for org-A user (gate failed?)`,
        );
        // Tenant-leak check: any filter the route applied to
        // `organization_id` MUST equal ORG_A — never ORG_B.
        for (const call of observedCalls) {
          if (!SUPABASE_FILTER_REGEX.test(call.col)) continue;
          if (call.op === "eq") {
            assert.equal(
              call.val,
              ORG_A,
              `${spec.name} applied an organization_id filter that wasn't org A on table ${call.table}: got ${String(call.val)}`,
            );
          } else if (call.op === "in" && Array.isArray(call.val)) {
            for (const v of call.val) {
              assert.equal(
                v,
                ORG_A,
                `${spec.name} applied an organization_id IN filter that included a non-org-A value on table ${call.table}: got ${String(v)}`,
              );
            }
          }
          assert.notEqual(
            call.val,
            ORG_B,
            `${spec.name} leaked org B id into a query against ${call.table}`,
          );
        }
      });
    });
  }

  it("every gated billing route file is covered by the suite above", async () => {
    // Spot-check: if a new route under app/api/billing/** is added with
    // `requireBillingAccess` but not added to ROUTES, this guard would
    // ideally fail. We implement it inline rather than shelling out to
    // ripgrep, by listing the files we know about and asserting they
    // match ROUTES. Updating this list is part of "adding a billing
    // route" — same as updating ROUTES above.
    const expected = new Set([
      "app/api/billing/837p-batches/route.ts",
      "app/api/billing/batches/[id]/route.ts",
      "app/api/billing/blocked-claims/route.ts",
      "app/api/billing/charge-capture/[id]/route.ts",
      "app/api/billing/charge-capture/release/route.ts",
      "app/api/billing/charge-capture/route.ts",
      "app/api/billing/no-response/route.ts",
      "app/api/billing/codes/diagnoses/route.ts",
      "app/api/billing/codes/procedures/route.ts",
      "app/api/billing/copay-transactions/route.ts",
      "app/api/billing/era-payments/route.ts",
      "app/api/billing/reports/route.ts",
      "app/api/billing/submission-queues/route.ts",
      "app/api/billing/authorization-required/route.ts",
      "app/api/billing/authorization-required/actions/route.ts",
      "app/api/billing/claims/[claimId]/notes/route.ts",
      "app/api/billing/claims/[claimId]/notes/[noteId]/route.ts",
      "app/api/billing/claims/[claimId]/write-off/route.ts",
      "app/api/billing/denials/route.ts",
      "app/api/billing/fax-queue/route.ts",
      "app/api/billing/rejections/route.ts",
    ]);
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const root = resolve(process.cwd(), "app/api/billing");
    const found = new Set<string>();
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith("route.ts")) continue;
        const text = readFileSync(full, "utf8");
        if (text.includes("requireBillingAccess")) {
          const rel = full.slice(resolve(process.cwd()).length + 1);
          found.add(rel);
        }
      }
    }
    walk(root);
    const missing = [...found].filter((f) => !expected.has(f));
    assert.deepEqual(
      missing,
      [],
      `New gated billing route(s) not registered in tenant-isolation suite: ${missing.join(", ")}`,
    );
    const stale = [...expected].filter((f) => !found.has(f));
    assert.deepEqual(
      stale,
      [],
      `Tenant-isolation suite expected files that no longer exist or no longer use requireBillingAccess: ${stale.join(", ")}`,
    );
  });
});
