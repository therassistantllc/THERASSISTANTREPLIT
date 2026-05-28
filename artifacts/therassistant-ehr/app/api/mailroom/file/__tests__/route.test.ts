/**
 * Tests for POST /api/mailroom/file (Task #195).
 *
 * The filing endpoint moves a mailroom item into a target row by inserting a
 * `documents` record with the right FK and flipping the mailroom item status
 * to `filed`. The cases below pin:
 *
 *   - org scoping (mailroom_items lookup filtered by organization_id; a
 *     wrong-org item returns 404 even when the row exists in another org)
 *   - rejection when target_id is missing for a destination that requires it
 *   - rejection of cross-org target_id (the FK target must belong to the
 *     session organization — not just the mailroom item)
 *   - each filing_destination branch routes to the correct FK column
 *     (patient_chart -> client_id, claim -> claim_id, encounter ->
 *     encounter_id, practice_documents -> no FK column)
 *   - mailroom_items status is flipped to "filed" with the same org guard
 *
 * Plus a regression source-pin on the route so it can't silently drop the
 * org-access guard, the missing-target guard, or the cross-org target guard.
 */

import { strict as assert } from "node:assert";
import { before, beforeEach, mock, test, describe, it } from "node:test";
import { readFileSync } from "node:fs";

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";

type Row = Record<string, unknown>;
type Filter = { field: string; value: unknown };
type Call = {
  table: string;
  op: "select" | "insert" | "update";
  payload?: Row | Row[];
  filters: Filter[];
};

type TableHandler = {
  select?: (filters: Filter[]) => Row | Row[] | null;
  insert?: (payload: Row | Row[]) => Row | null;
  update?: (payload: Row, filters: Filter[]) => Row | null;
};

function makeSupabase(handlers: Record<string, TableHandler>) {
  const calls: Call[] = [];

  function builderFor(table: string, op: Call["op"], payload?: Row | Row[]) {
    const filters: Filter[] = [];

    function settle(): { data: Row | Row[] | null; error: null | { message: string } } {
      const handler = handlers[table];
      let data: Row | Row[] | null = null;
      if (handler) {
        if (op === "select" && handler.select) data = handler.select(filters);
        else if (op === "insert" && handler.insert) data = handler.insert(payload ?? {});
        else if (op === "update" && handler.update)
          data = handler.update((payload ?? {}) as Row, filters);
      }
      calls.push({ table, op, payload, filters: [...filters] });
      return { data, error: null };
    }

    const chain: Record<string, unknown> = {};
    chain.select = (..._args: unknown[]) => chain;
    chain.eq = (field: string, value: unknown) => {
      filters.push({ field, value });
      return chain;
    };
    chain.single = async () => settle();
    chain.maybeSingle = async () => settle();
    chain.then = (onFulfilled: (v: ReturnType<typeof settle>) => unknown) =>
      Promise.resolve(onFulfilled(settle()));
    return chain;
  }

  return {
    supabase: {
      from(table: string) {
        return {
          select(..._args: unknown[]) {
            return builderFor(table, "select");
          },
          insert(payload: Row | Row[]) {
            return builderFor(table, "insert", payload);
          },
          update(payload: Row) {
            return builderFor(table, "update", payload);
          },
        };
      },
    },
    calls,
  };
}

// Mutable scenario refs swapped per test — the modules are mocked ONCE in a
// before() hook so we don't fight Node's "module already mocked" guard.
type Scenario = {
  sessionOrg: string;
  // Items keyed by the org we expect to find them in. The fake supabase only
  // returns the row when both id AND organization_id filters match — that is
  // how the route's "wrong-org item is invisible" guarantee is exercised.
  mailroomItem: { id: string; organizationId: string; row: Row } | null;
  // Target rows keyed by table — same org-scoped visibility.
  targets: { clients?: Row & { id: string; organization_id: string }; claims?: Row & { id: string; organization_id: string }; encounters?: Row & { id: string; organization_id: string } };
};

const scenario: Scenario = {
  sessionOrg: ORG_A,
  mailroomItem: null,
  targets: {},
};

let lastCalls: Call[] = [];

before(() => {
  mock.module("@/lib/auth/requireOrgAccess", {
    namedExports: {
      requireOrgAccess: async (opts: { requestedOrganizationId?: string | null } = {}) => {
        const { NextResponse } = await import("next/server");
        const requested = opts.requestedOrganizationId
          ? String(opts.requestedOrganizationId).trim()
          : null;
        if (requested && requested !== scenario.sessionOrg) {
          return NextResponse.json(
            { success: false, error: "Cannot access data for a different organization" },
            { status: 403 },
          );
        }
        return {
          organizationId: scenario.sessionOrg,
          staffId: "staff-1",
          userId: "user-1",
          roles: [],
          permissions: [],
          isDevPassthrough: false,
        };
      },
    },
  });

  mock.module("@/lib/supabase/server", {
    namedExports: {
      createServerSupabaseAdminClient: () => {
        const built = makeSupabase({
          mailroom_items: {
            select: (filters) => {
              const idF = filters.find((f) => f.field === "id");
              const orgF = filters.find((f) => f.field === "organization_id");
              if (!scenario.mailroomItem) return null;
              if (idF?.value !== scenario.mailroomItem.id) return null;
              if (orgF?.value !== scenario.mailroomItem.organizationId) return null;
              return scenario.mailroomItem.row;
            },
            update: () => ({}),
          },
          documents: {
            insert: (payload) => {
              const row = Array.isArray(payload) ? payload[0] : payload;
              return { id: "doc-new", ...(row as Row) };
            },
          },
          clients: {
            select: (filters) => {
              const target = scenario.targets.clients;
              if (!target) return null;
              const idF = filters.find((f) => f.field === "id");
              const orgF = filters.find((f) => f.field === "organization_id");
              if (idF?.value !== target.id) return null;
              if (orgF?.value !== target.organization_id) return null;
              return target;
            },
          },
          claims: {
            select: (filters) => {
              const target = scenario.targets.claims;
              if (!target) return null;
              const idF = filters.find((f) => f.field === "id");
              const orgF = filters.find((f) => f.field === "organization_id");
              if (idF?.value !== target.id) return null;
              if (orgF?.value !== target.organization_id) return null;
              return target;
            },
          },
          encounters: {
            select: (filters) => {
              const target = scenario.targets.encounters;
              if (!target) return null;
              const idF = filters.find((f) => f.field === "id");
              const orgF = filters.find((f) => f.field === "organization_id");
              if (idF?.value !== target.id) return null;
              if (orgF?.value !== target.organization_id) return null;
              return target;
            },
          },
        });
        lastCalls = built.calls;
        return built.supabase;
      },
    },
  });
});

beforeEach(() => {
  // Required by getSupabase() in the route — the call has to succeed before
  // our @supabase/supabase-js mock takes over.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  scenario.sessionOrg = ORG_A;
  scenario.mailroomItem = null;
  scenario.targets = {};
  lastCalls = [];
});

async function loadPost() {
  const mod = await import("../route");
  return mod.POST as (r: import("next/server").NextRequest) => Promise<Response>;
}

function fileRequest(body: unknown): import("next/server").NextRequest {
  return new Request("https://app.test/api/mailroom/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

const defaultItemRow: Row = {
  id: "item-1",
  organization_id: ORG_A,
  file_name: "scan.pdf",
  mime_type: "application/pdf",
  storage_path: `${ORG_A}/scan.pdf`,
  document_type: "lab_result",
};

describe("POST /api/mailroom/file — input validation", () => {
  it("returns 400 when filing_destination is missing", async () => {
    scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    const POST = await loadPost();
    const res = await POST(fileRequest({ mailroom_item_id: "item-1", organization_id: ORG_A }));
    assert.equal(res.status, 400);
  });

  it("returns 400 when target_id is missing for patient_chart (UI guard mirrored on the API)", async () => {
    scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    const POST = await loadPost();
    const res = await POST(
      fileRequest({
        mailroom_item_id: "item-1",
        filing_destination: "patient_chart",
        organization_id: ORG_A,
      }),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /target_id is required/i);
    // Must short-circuit before any documents insert.
    assert.equal(lastCalls.filter((c) => c.table === "documents").length, 0);
  });

  for (const destination of ["claim", "encounter"] as const) {
    it(`returns 400 when target_id is missing for ${destination}`, async () => {
      scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
      const POST = await loadPost();
      const res = await POST(
        fileRequest({
          mailroom_item_id: "item-1",
          filing_destination: destination,
          organization_id: ORG_A,
        }),
      );
      assert.equal(res.status, 400);
    });
  }
});

describe("POST /api/mailroom/file — org scoping", () => {
  it("rejects an organization_id that doesn't match the session (403 via requireOrgAccess)", async () => {
    scenario.sessionOrg = ORG_A;
    scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    const POST = await loadPost();
    const res = await POST(
      fileRequest({
        mailroom_item_id: "item-1",
        filing_destination: "practice_documents",
        organization_id: ORG_B,
      }),
    );
    assert.equal(res.status, 403);
  });

  it("returns 404 when the mailroom item belongs to a different org (org-scoped lookup misses)", async () => {
    scenario.sessionOrg = ORG_A;
    // The row exists, but under ORG_B — the org-scoped select must not see it.
    scenario.mailroomItem = {
      id: "item-1",
      organizationId: ORG_B,
      row: { ...defaultItemRow, organization_id: ORG_B },
    };
    const POST = await loadPost();
    const res = await POST(
      fileRequest({
        mailroom_item_id: "item-1",
        filing_destination: "practice_documents",
      }),
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Mailroom item not found/);
    // Must have actually scoped the mailroom_items query by organization_id.
    const itemSelect = lastCalls.find((c) => c.table === "mailroom_items" && c.op === "select");
    assert.ok(itemSelect);
    assert.ok(
      itemSelect!.filters.some((f) => f.field === "organization_id" && f.value === ORG_A),
      "mailroom_items lookup must be scoped by the session organization",
    );
  });

  it("returns 404 when the target_id (client) belongs to a different org", async () => {
    scenario.sessionOrg = ORG_A;
    scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    // The target client exists, but in ORG_B. The org-scoped lookup misses,
    // so the route must refuse to file the document.
    scenario.targets.clients = { id: "client-x", organization_id: ORG_B };
    const POST = await loadPost();
    const res = await POST(
      fileRequest({
        mailroom_item_id: "item-1",
        filing_destination: "patient_chart",
        target_id: "client-x",
      }),
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /target_id not found in your organization/);
    // No documents row should have been inserted.
    assert.equal(lastCalls.filter((c) => c.table === "documents" && c.op === "insert").length, 0);
  });

  it("returns 404 when the target_id (claim) belongs to a different org", async () => {
    scenario.sessionOrg = ORG_A;
    scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    scenario.targets.claims = { id: "claim-x", organization_id: ORG_B };
    const POST = await loadPost();
    const res = await POST(
      fileRequest({
        mailroom_item_id: "item-1",
        filing_destination: "claim",
        target_id: "claim-x",
      }),
    );
    assert.equal(res.status, 404);
  });

  it("returns 404 when the target_id (encounter) belongs to a different org", async () => {
    scenario.sessionOrg = ORG_A;
    scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    scenario.targets.encounters = { id: "enc-x", organization_id: ORG_B };
    const POST = await loadPost();
    const res = await POST(
      fileRequest({
        mailroom_item_id: "item-1",
        filing_destination: "encounter",
        target_id: "enc-x",
      }),
    );
    assert.equal(res.status, 404);
  });
});

describe("POST /api/mailroom/file — filing_destination branches", () => {
  function insertedDocument(): Row {
    const insert = lastCalls.find((c) => c.table === "documents" && c.op === "insert");
    assert.ok(insert, "expected a documents insert call");
    const payload = insert!.payload;
    const row = Array.isArray(payload) ? payload[0] : (payload as Row);
    return row;
  }

  it("patient_chart with a valid in-org target writes documents.client_id and flips mailroom item to filed", async () => {
    scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    scenario.targets.clients = { id: "client-ok", organization_id: ORG_A };
    const POST = await loadPost();
    const res = await POST(
      fileRequest({
        mailroom_item_id: "item-1",
        filing_destination: "patient_chart",
        target_id: "client-ok",
        organization_id: ORG_A,
      }),
    );
    assert.equal(res.status, 200);

    const doc = insertedDocument();
    assert.equal(doc.client_id, "client-ok");
    assert.equal(doc.encounter_id, undefined);
    assert.equal(doc.claim_id, undefined);
    assert.equal(doc.organization_id, ORG_A);
    assert.equal(doc.document_scope, "other"); // patient_chart maps to scope=other
    assert.equal(doc.mailroom_item_id, "item-1");

    // Status flip must be scoped by org too.
    const update = lastCalls.find((c) => c.table === "mailroom_items" && c.op === "update");
    assert.ok(update);
    assert.equal((update!.payload as Row).status, "filed");
    assert.ok(update!.filters.some((f) => f.field === "organization_id" && f.value === ORG_A));
  });

  it("claim with a valid in-org target writes documents.claim_id and document_scope=claim", async () => {
    scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    scenario.targets.claims = { id: "claim-ok", organization_id: ORG_A };
    const POST = await loadPost();
    const res = await POST(
      fileRequest({
        mailroom_item_id: "item-1",
        filing_destination: "claim",
        target_id: "claim-ok",
      }),
    );
    assert.equal(res.status, 200);

    const doc = insertedDocument();
    assert.equal(doc.claim_id, "claim-ok");
    assert.equal(doc.client_id, undefined);
    assert.equal(doc.encounter_id, undefined);
    assert.equal(doc.document_scope, "claim");
  });

  it("encounter with a valid in-org target writes documents.encounter_id and document_scope=encounter", async () => {
    scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    scenario.targets.encounters = { id: "enc-ok", organization_id: ORG_A };
    const POST = await loadPost();
    const res = await POST(
      fileRequest({
        mailroom_item_id: "item-1",
        filing_destination: "encounter",
        target_id: "enc-ok",
      }),
    );
    assert.equal(res.status, 200);

    const doc = insertedDocument();
    assert.equal(doc.encounter_id, "enc-ok");
    assert.equal(doc.client_id, undefined);
    assert.equal(doc.claim_id, undefined);
    assert.equal(doc.document_scope, "encounter");
  });

  it("practice_documents requires no target_id and writes neither client_id, claim_id, nor encounter_id", async () => {
    scenario.mailroomItem = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    const POST = await loadPost();
    const res = await POST(
      fileRequest({
        mailroom_item_id: "item-1",
        filing_destination: "practice_documents",
      }),
    );
    assert.equal(res.status, 200);

    const doc = insertedDocument();
    assert.equal(doc.client_id, undefined);
    assert.equal(doc.claim_id, undefined);
    assert.equal(doc.encounter_id, undefined);
    assert.equal(doc.document_scope, "other");
    // The cross-org target lookup must NOT have run for practice_documents.
    assert.equal(lastCalls.filter((c) => c.table === "clients").length, 0);
    assert.equal(lastCalls.filter((c) => c.table === "claims").length, 0);
    assert.equal(lastCalls.filter((c) => c.table === "encounters").length, 0);
  });
});

describe("regression: /api/mailroom/file route wiring", () => {
  // Source-pin so refactors can't silently drop the org guard, the
  // missing-target guard, or the cross-org target guard.
  const src = readFileSync("app/api/mailroom/file/route.ts", "utf8");

  it("gates the request behind requireOrgAccess", () => {
    assert.match(src, /requireOrgAccess\s*\(/);
    assert.match(src, /guard instanceof NextResponse/);
  });

  it("rejects missing target_id when the destination requires one", () => {
    assert.match(src, /target_id is required/i);
  });

  it("scopes the cross-org target lookup by organization_id", () => {
    assert.match(src, /target_id not found in your organization/);
    assert.match(src, /\.eq\("organization_id", effectiveOrgId\)/);
  });

  it("scopes the mailroom item lookup AND the status flip by organization_id", () => {
    // Both the SELECT and the UPDATE must carry .eq("organization_id", ...).
    const orgEqs = src.match(/\.eq\("organization_id", effectiveOrgId\)/g) ?? [];
    assert.ok(orgEqs.length >= 3, `expected >=3 org-scoped eq calls, saw ${orgEqs.length}`);
  });
});
