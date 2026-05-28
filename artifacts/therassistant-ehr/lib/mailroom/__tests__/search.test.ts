/**
 * Tests for the mailroom typeahead search (Task #151).
 *
 * The /api/mailroom/search route is a thin wrapper around the helpers in
 * lib/mailroom/search. We exercise the helpers against a fake supabase
 * client that records every chained call, so we can pin:
 *
 *   - org scoping (every table query is filtered by organization_id)
 *   - per-type result shapes (client / claim / encounter)
 *   - empty-query default list (no .or() filter is attached)
 *   - ILIKE-injection safety (%, _, \, , are escaped)
 *   - rejection of invalid `type` (via isMailroomSearchType)
 *
 * Plus a regression source-pin on the route so it can't silently drop the
 * auth check, the helper call, or the org-scope guard.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import {
  escapeIlike,
  isMailroomSearchType,
  MAILROOM_SEARCH_TYPES,
  searchMailroomEntities,
} from "../search";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

type Call = {
  table: string;
  method: string;
  args: unknown[];
};

type TableFixture = Record<string, unknown[]>;

/**
 * A chainable fake of the supabase-js query builder. Every chained call is
 * recorded so tests can assert on `organization_id` scoping, `.or()` filters
 * (or their absence), `.limit()`, and `.in()` joins. The terminal step is
 * awaiting the builder itself or a `select-only` path; we resolve to whatever
 * fixture rows the test registered for the most-recently selected table.
 */
function makeFakeSupabase(fixtures: TableFixture) {
  const calls: Call[] = [];

  function builder(table: string) {
    let resolveData: unknown[] = fixtures[table] ?? [];
    const node: any = {
      __table: table,
      select(...args: unknown[]) {
        calls.push({ table, method: "select", args });
        return node;
      },
      eq(...args: unknown[]) {
        calls.push({ table, method: "eq", args });
        return node;
      },
      is(...args: unknown[]) {
        calls.push({ table, method: "is", args });
        return node;
      },
      or(...args: unknown[]) {
        calls.push({ table, method: "or", args });
        return node;
      },
      in(...args: unknown[]) {
        calls.push({ table, method: "in", args });
        // For the `.in(...)` join lookups, narrow the fixture rows to ids the
        // caller asked about so the helper's downstream maps line up.
        const [field, ids] = args as [string, string[]];
        resolveData = (fixtures[table] ?? []).filter((row) =>
          ids.includes(String((row as Record<string, unknown>)[field] ?? "")),
        );
        return node;
      },
      order(...args: unknown[]) {
        calls.push({ table, method: "order", args });
        return node;
      },
      limit(...args: unknown[]) {
        calls.push({ table, method: "limit", args });
        return node;
      },
      then(onFulfilled: (value: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve({ data: resolveData, error: null }).then(onFulfilled);
      },
    };
    return node;
  }

  const supabase = {
    from(table: string) {
      calls.push({ table, method: "from", args: [] });
      return builder(table);
    },
  };

  return { supabase, calls };
}

describe("isMailroomSearchType", () => {
  it("accepts the three supported entity types", () => {
    for (const t of MAILROOM_SEARCH_TYPES) assert.equal(isMailroomSearchType(t), true);
  });
  it("rejects unknown / malformed types (prevents the route from ever calling the helper with garbage)", () => {
    for (const bad of ["", "clients", "Client", "claims; drop", null, undefined, 42, {}]) {
      assert.equal(isMailroomSearchType(bad as unknown), false);
    }
  });
});

describe("escapeIlike (ILIKE-injection safety)", () => {
  it("escapes wildcards, backslash, and the PostgREST or-list separator", () => {
    assert.equal(escapeIlike("a%b"), "a\\%b");
    assert.equal(escapeIlike("a_b"), "a\\_b");
    assert.equal(escapeIlike("a\\b"), "a\\\\b");
    assert.equal(escapeIlike("a,b"), "a\\,b");
    assert.equal(escapeIlike("100%_off,go\\"), "100\\%\\_off\\,go\\\\");
  });
  it("is a no-op for ordinary search terms", () => {
    assert.equal(escapeIlike("Jane Doe"), "Jane Doe");
    assert.equal(escapeIlike(""), "");
  });
});

describe("searchMailroomEntities — org scoping", () => {
  it("scopes the clients query to the session organization (every table, including joins)", async () => {
    const { supabase, calls } = makeFakeSupabase({
      clients: [{ id: "c1", first_name: "Jane", last_name: "Doe", date_of_birth: "1990-01-01" }],
    });
    await searchMailroomEntities(supabase, ORG_A, "client", "jane", 10);
    const eqCalls = calls.filter((c) => c.method === "eq");
    assert.ok(
      eqCalls.some((c) => c.table === "clients" && c.args[0] === "organization_id" && c.args[1] === ORG_A),
      "clients lookup must be scoped by organization_id = session org",
    );
    assert.ok(
      !eqCalls.some((c) => c.args[1] === ORG_B),
      "no query should ever leak a different organization id",
    );
  });

  it("scopes the claims query (and never passes an attacker-supplied org through)", async () => {
    const { supabase, calls } = makeFakeSupabase({ professional_claims: [] });
    await searchMailroomEntities(supabase, ORG_A, "claim", "", 10);
    const claimEq = calls.find(
      (c) => c.table === "professional_claims" && c.method === "eq" && c.args[0] === "organization_id",
    );
    assert.ok(claimEq, "professional_claims lookup must be scoped by organization_id");
    assert.equal(claimEq?.args[1], ORG_A);
  });

  it("scopes the encounters query AND the client-name pre-filter to the session org", async () => {
    // Client pre-filter must hit a row, otherwise the helper short-circuits
    // before querying encounters and we can't assert org scope on that table.
    const { supabase, calls } = makeFakeSupabase({
      clients: [{ id: "c1", first_name: "Jane", last_name: "Doe" }],
      encounters: [],
    });
    await searchMailroomEntities(supabase, ORG_A, "encounter", "jane", 10);
    const scopedTables = calls
      .filter((c) => c.method === "eq" && c.args[0] === "organization_id")
      .map((c) => ({ table: c.table, org: c.args[1] }));
    assert.ok(scopedTables.some((s) => s.table === "clients" && s.org === ORG_A));
    assert.ok(scopedTables.some((s) => s.table === "encounters" && s.org === ORG_A));
  });
});

describe("searchMailroomEntities — per-type result shapes", () => {
  it("client: returns id + name label + DOB sublabel", async () => {
    const { supabase } = makeFakeSupabase({
      clients: [
        { id: "c1", first_name: "Jane", last_name: "Doe", date_of_birth: "1990-01-01" },
        { id: "c2", first_name: "", last_name: "", date_of_birth: "" },
      ],
    });
    const results = await searchMailroomEntities(supabase, ORG_A, "client", "", 10);
    assert.deepEqual(results, [
      { id: "c1", label: "Jane Doe", sublabel: "DOB 1990-01-01" },
      { id: "c2", label: "Unnamed client", sublabel: "" },
    ]);
  });

  it("claim: returns 'Claim <number>' label and joins client/payer for the sublabel", async () => {
    const { supabase } = makeFakeSupabase({
      professional_claims: [
        {
          id: "claim-1",
          claim_number: "CLM-123",
          patient_account_number: "PA-1",
          patient_id: "c1",
          payer_profile_id: "p1",
          date_of_service_from: "2025-01-01",
          date_of_service_to: "2025-01-02",
          claim_status: "submitted",
        },
      ],
      clients: [{ id: "c1", first_name: "Jane", last_name: "Doe" }],
      insurance_payers: [{ id: "p1", payer_name: "Aetna" }],
    });
    const results = await searchMailroomEntities(supabase, ORG_A, "claim", "", 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "claim-1");
    assert.equal(results[0].label, "Claim CLM-123");
    assert.match(results[0].sublabel, /Jane Doe/);
    assert.match(results[0].sublabel, /Aetna/);
    assert.match(results[0].sublabel, /DOS 2025-01-01/);
  });

  it("encounter: returns 'service_date · client' label and provider sublabel", async () => {
    const { supabase } = makeFakeSupabase({
      encounters: [
        { id: "enc-1", client_id: "c1", provider_id: "pr1", service_date: "2025-03-04", started_at: "", encounter_status: "completed" },
      ],
      clients: [{ id: "c1", first_name: "Jane", last_name: "Doe" }],
      provider_profiles: [{ id: "pr1", staff_id: "s1" }],
      staff_profiles: [{ id: "s1", first_name: "Dr", last_name: "Smith" }],
    });
    const results = await searchMailroomEntities(supabase, ORG_A, "encounter", "", 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "enc-1");
    assert.equal(results[0].label, "2025-03-04 · Jane Doe");
    assert.equal(results[0].sublabel, "Dr Smith");
  });
});

describe("searchMailroomEntities — empty-query default list", () => {
  it("client: does NOT attach an .or() filter when q is empty (returns the recent list)", async () => {
    const { supabase, calls } = makeFakeSupabase({ clients: [] });
    await searchMailroomEntities(supabase, ORG_A, "client", "", 10);
    assert.equal(
      calls.filter((c) => c.method === "or").length,
      0,
      "empty q must produce a plain org-scoped list with no .or() filter",
    );
  });

  it("claim: empty q skips the .or() and still scopes by org", async () => {
    const { supabase, calls } = makeFakeSupabase({ professional_claims: [] });
    await searchMailroomEntities(supabase, ORG_A, "claim", "", 10);
    assert.equal(calls.filter((c) => c.method === "or").length, 0);
  });

  it("encounter: empty q skips the client pre-filter and queries encounters directly", async () => {
    const { supabase, calls } = makeFakeSupabase({ encounters: [] });
    await searchMailroomEntities(supabase, ORG_A, "encounter", "", 10);
    // No client name lookup happens (no .or on clients) and the encounters
    // query has no .in("client_id", ...) restriction.
    assert.equal(calls.filter((c) => c.table === "clients" && c.method === "or").length, 0);
    assert.equal(
      calls.filter((c) => c.table === "encounters" && c.method === "in").length,
      0,
    );
  });
});

describe("searchMailroomEntities — ILIKE-injection safety", () => {
  it("escapes wildcards in the client .or() filter so a '%' search can't match every row", async () => {
    const { supabase, calls } = makeFakeSupabase({ clients: [] });
    await searchMailroomEntities(supabase, ORG_A, "client", "100%_off,go\\", 10);
    const orCall = calls.find((c) => c.method === "or");
    assert.ok(orCall, "an .or() call must be attached when q is non-empty");
    const filter = String((orCall!.args[0] ?? "") as string);
    // The hostile metacharacters from the user input must appear escaped.
    assert.match(filter, /100\\%\\_off\\,go\\\\/);
    // The raw, un-escaped sequence must NOT appear anywhere in the filter.
    assert.equal(filter.includes("100%_off,go\\b"), false);
  });

  it("escapes wildcards in the claim .or() filter", async () => {
    const { supabase, calls } = makeFakeSupabase({ professional_claims: [] });
    await searchMailroomEntities(supabase, ORG_A, "claim", "%admin%", 10);
    const orCall = calls.find((c) => c.method === "or" && c.table === "professional_claims");
    assert.ok(orCall);
    assert.match(String(orCall!.args[0]), /\\%admin\\%/);
  });

  it("escapes wildcards in the encounter client pre-filter", async () => {
    const { supabase, calls } = makeFakeSupabase({ clients: [], encounters: [] });
    await searchMailroomEntities(supabase, ORG_A, "encounter", "_drop_", 10);
    const orCall = calls.find((c) => c.method === "or" && c.table === "clients");
    assert.ok(orCall);
    assert.match(String(orCall!.args[0]), /\\_drop\\_/);
  });
});

describe("regression: /api/mailroom/search route wiring", () => {
  // Pin the contract that the route can't silently drop auth, the org-scope
  // guard, the type validator, or the helper call. Mirrors the source-pin
  // pattern used by lib/payments/__tests__/matchRouteTenantIsolation.test.ts.
  const src = readFileSync("app/api/mailroom/search/route.ts", "utf8");

  it("requires authentication via requireOrgAccess (which wraps requireAuthenticatedStaff)", () => {
    // The route was consolidated onto requireOrgAccess, the shared guard
    // that emits 401 on no session and 403 on org mismatch. The literal
    // status codes live inside the helper, not the route — pinning the
    // helper call is what guarantees auth can't silently drop.
    assert.match(src, /requireOrgAccess\s*\(/);
  });

  it("rejects unknown `type` with 400 via the shared validator", () => {
    assert.match(src, /isMailroomSearchType/);
    assert.match(src, /\b400\b/);
  });

  it("rejects a caller-supplied organizationId that doesn't match the session", () => {
    // requireOrgAccess compares searchParams.organizationId against the
    // session org and returns 403 on mismatch. Pin that the route forwards
    // the caller-supplied id into the helper rather than trusting it.
    assert.match(src, /requireOrgAccess\s*\(\s*\{[\s\S]*requestedOrganizationId/);
  });

  it("delegates to the shared searchMailroomEntities helper (no inline query logic)", () => {
    assert.match(src, /searchMailroomEntities\s*\(/);
    // The route should NOT re-implement supabase queries inline.
    assert.equal(/\.from\("clients"\)/.test(src), false);
    assert.equal(/\.from\("professional_claims"\)/.test(src), false);
    assert.equal(/\.from\("encounters"\)/.test(src), false);
  });
});
