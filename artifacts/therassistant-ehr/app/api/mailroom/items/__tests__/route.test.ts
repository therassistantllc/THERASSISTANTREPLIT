/**
 * Tests for GET /api/mailroom/items/[itemId] (Task #195).
 *
 * The detail endpoint hydrates a mailroom item plus the patient / encounter /
 * claim it was filed against. The cases below pin:
 *
 *   - the mailroom_items lookup is org-scoped (filtered by organization_id)
 *   - a wrong-org item returns 404, never the row from another tenant
 *   - the in-org happy path returns success with the item DTO
 *   - the documents follow-up lookup is also org-scoped (so a stray cross-org
 *     filing can't be pulled back through the detail endpoint)
 *
 * Plus a regression source-pin so refactors can't drop the org-scope guards.
 */

import { strict as assert } from "node:assert";
import { before, beforeEach, mock, test, describe, it } from "node:test";
import { readFileSync } from "node:fs";

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";

type Row = Record<string, unknown>;
type Filter = { field: string; value: unknown };
type Call = { table: string; op: "select"; filters: Filter[] };

type SelectFn = (filters: Filter[]) => Row | null;
type InsertCall = { table: string; payload: Row };

function makeSupabase(
  handlers: Record<string, SelectFn>,
  insertCollector?: InsertCall[],
  insertResult?: { id: string; error: { message: string } | null },
) {
  const calls: Call[] = [];

  function builder(table: string) {
    const filters: Filter[] = [];
    function settle(): { data: Row | null; error: null } {
      const handler = handlers[table];
      const data = handler ? handler(filters) : null;
      calls.push({ table, op: "select", filters: [...filters] });
      return { data, error: null };
    }
    const chain: Record<string, unknown> = {};
    chain.select = (..._args: unknown[]) => chain;
    chain.eq = (field: string, value: unknown) => {
      filters.push({ field, value });
      return chain;
    };
    chain.neq = (..._args: unknown[]) => chain;
    chain.is = (..._args: unknown[]) => chain;
    chain.or = (..._args: unknown[]) => chain;
    chain.order = (..._args: unknown[]) => chain;
    chain.limit = (..._args: unknown[]) => chain;
    chain.maybeSingle = async () => settle();
    chain.single = async () => settle();
    return chain;
  }

  function insertBuilder(table: string, payload: Row) {
    insertCollector?.push({ table, payload });
    const result = insertResult ?? { id: "row-new", error: null };
    return {
      select: (..._args: unknown[]) => ({
        single: async () => ({
          data: result.error ? null : { id: result.id },
          error: result.error,
        }),
      }),
      then: (cb: (v: { data: null; error: { message: string } | null }) => unknown) =>
        Promise.resolve(cb({ data: null, error: result.error })),
    };
  }

  return {
    supabase: {
      from(table: string) {
        return {
          select(..._args: unknown[]) {
            return builder(table);
          },
          insert(payload: Row) {
            return insertBuilder(table, payload);
          },
        };
      },
    },
    calls,
  };
}

type Scenario = {
  sessionOrg: string;
  // Item is returned only when both id AND organization_id filters match.
  item: { id: string; organizationId: string; row: Row } | null;
  // Optional documents row returned by the documents lookup (org-scoped).
  filedDocument: (Row & { organization_id: string }) | null;
};

const scenario: Scenario = {
  sessionOrg: ORG_A,
  item: null,
  filedDocument: null,
};

let lastCalls: Call[] = [];
const insertCalls: InsertCall[] = [];
const insertResult: { id: string; error: { message: string } | null } = {
  id: "row-new",
  error: null,
};

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
        const built = makeSupabase(
          {
          mailroom_items: (filters) => {
            if (!scenario.item) return null;
            const idF = filters.find((f) => f.field === "id");
            const orgF = filters.find((f) => f.field === "organization_id");
            if (idF?.value !== scenario.item.id) return null;
            if (orgF?.value !== scenario.item.organizationId) return null;
            return scenario.item.row;
          },
          documents: (filters) => {
            if (!scenario.filedDocument) return null;
            const orgF = filters.find((f) => f.field === "organization_id");
            if (orgF?.value !== scenario.filedDocument.organization_id) return null;
            return scenario.filedDocument;
          },
          clients: () => null,
          encounters: () => null,
          claims: () => null,
          providers: () => null,
          insurance_policies: () => null,
          insurance_payers: () => null,
          },
          insertCalls,
          insertResult,
        );
        lastCalls = built.calls;
        return built.supabase;
      },
    },
  });
});

beforeEach(() => {
  scenario.sessionOrg = ORG_A;
  scenario.item = null;
  scenario.filedDocument = null;
  lastCalls = [];
  insertCalls.length = 0;
  insertResult.id = "row-new";
  insertResult.error = null;
});

async function loadGet() {
  const mod = await import("../[itemId]/route");
  return mod.GET as (
    r: Request,
    ctx: { params: Promise<{ itemId: string }> },
  ) => Promise<Response>;
}

function detailRequest(itemId: string, queryOrg?: string): Request {
  const q = queryOrg ? `?organizationId=${encodeURIComponent(queryOrg)}` : "";
  return new Request(`https://app.test/api/mailroom/items/${itemId}${q}`);
}

function detailContext(itemId: string) {
  return { params: Promise.resolve({ itemId }) };
}

const defaultItemRow: Row = {
  id: "item-1",
  organization_id: ORG_A,
  client_id: "",
  file_name: "scan.pdf",
  mime_type: "application/pdf",
  storage_path: `${ORG_A}/scan.pdf`,
  status: "needs_review",
  document_type: "lab_result",
  source: "manual_upload",
  notes: "",
  admin_comments: "",
  uploaded_by_user_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("GET /api/mailroom/items/[itemId] — org scoping", () => {
  it("returns the item DTO when the item is in the session organization", async () => {
    scenario.item = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    const GET = await loadGet();
    const res = await GET(detailRequest("item-1"), detailContext("item-1"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; item: { id: string; organizationId: string } };
    assert.equal(body.success, true);
    assert.equal(body.item.id, "item-1");
    assert.equal(body.item.organizationId, ORG_A);

    // Must have scoped the mailroom_items lookup by organization_id.
    const itemSelect = lastCalls.find((c) => c.table === "mailroom_items");
    assert.ok(itemSelect);
    assert.ok(
      itemSelect!.filters.some((f) => f.field === "organization_id" && f.value === ORG_A),
      "mailroom_items lookup must be scoped to the session organization",
    );
  });

  it("returns 404 when the item exists but in a different organization (wrong-org item is invisible)", async () => {
    scenario.sessionOrg = ORG_A;
    scenario.item = {
      id: "item-1",
      organizationId: ORG_B,
      row: { ...defaultItemRow, organization_id: ORG_B },
    };
    const GET = await loadGet();
    const res = await GET(detailRequest("item-1"), detailContext("item-1"));
    assert.equal(res.status, 404);
    const body = (await res.json()) as { success: boolean; error: string };
    assert.equal(body.success, false);
    assert.match(body.error, /Mailroom item not found/);
    // No follow-up document lookup should run when the item lookup misses.
    assert.equal(lastCalls.filter((c) => c.table === "documents").length, 0);
  });

  it("returns 403 when the caller passes an organizationId that doesn't match the session", async () => {
    scenario.sessionOrg = ORG_A;
    scenario.item = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    const GET = await loadGet();
    const res = await GET(detailRequest("item-1", ORG_B), detailContext("item-1"));
    assert.equal(res.status, 403);
  });

  it("scopes the filed-documents follow-up lookup by organization_id (cross-org filings stay hidden)", async () => {
    scenario.item = { id: "item-1", organizationId: ORG_A, row: defaultItemRow };
    // A stale documents row in ORG_B should never surface — guarantee that
    // the documents query carries the org filter.
    scenario.filedDocument = {
      organization_id: ORG_B,
      id: "doc-x",
      client_id: "c-x",
      encounter_id: "",
      claim_id: "",
    };
    const GET = await loadGet();
    const res = await GET(detailRequest("item-1"), detailContext("item-1"));
    assert.equal(res.status, 200);

    const docSelect = lastCalls.find((c) => c.table === "documents");
    assert.ok(docSelect, "expected a documents lookup");
    assert.ok(
      docSelect!.filters.some((f) => f.field === "organization_id" && f.value === ORG_A),
      "documents lookup must be scoped to the session org",
    );
  });
});

describe("regression: /api/mailroom/items/[itemId] route wiring", () => {
  const src = readFileSync("app/api/mailroom/items/[itemId]/route.ts", "utf8");

  it("gates the request behind requireOrgAccess", () => {
    assert.match(src, /requireOrgAccess\s*\(/);
    assert.match(src, /guard instanceof NextResponse/);
  });

  it("scopes the mailroom_items lookup by organization_id", () => {
    assert.match(src, /\.from\("mailroom_items"\)[\s\S]*?\.eq\("organization_id", organizationId\)/);
  });

  it("scopes the documents follow-up by organization_id", () => {
    assert.match(src, /\.from\("documents"\)[\s\S]*?\.eq\("organization_id", organizationId\)/);
  });

  it("returns 404 (not 500) when the org-scoped item lookup misses", () => {
    assert.match(src, /Mailroom item not found/);
    assert.match(src, /\b404\b/);
  });
});

async function loadItemsPost() {
  const mod = await import("../route");
  return mod.POST as (r: Request) => Promise<Response>;
}

function itemsPostRequest(body: Record<string, unknown>): Request {
  return new Request("https://app.test/api/mailroom/items", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/mailroom/items — legacy `title` column dropped (Task #407)", () => {
  it("succeeds without a caller-supplied title and does not write the dropped `title` column", async () => {
    const POST = await loadItemsPost();
    const res = await POST(
      itemsPostRequest({
        organizationId: ORG_A,
        fileName: "remit-april.pdf",
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; mailroomItemId: string };
    assert.equal(body.success, true);

    const mailroomInsert = insertCalls.find((c) => c.table === "mailroom_items");
    assert.ok(mailroomInsert, "expected a mailroom_items insert");
    assert.ok(
      !("title" in mailroomInsert!.payload),
      "insert payload must not include the dropped `title` column",
    );
    // Compat columns are still set.
    assert.equal(mailroomInsert!.payload.file_name, "remit-april.pdf");
    assert.equal(mailroomInsert!.payload.status, "needs_review");
  });

  it("ignores a caller-supplied title (column no longer exists)", async () => {
    const POST = await loadItemsPost();
    const res = await POST(
      itemsPostRequest({
        organizationId: ORG_A,
        fileName: "scan.pdf",
        title: "EOB from Aetna",
      }),
    );
    assert.equal(res.status, 200);
    const mailroomInsert = insertCalls.find((c) => c.table === "mailroom_items");
    assert.ok(!("title" in mailroomInsert!.payload));
  });
});

describe("regression: /api/mailroom/items POST wiring", () => {
  const src = readFileSync("app/api/mailroom/items/route.ts", "utf8");

  it("does not write the dropped legacy `title` column on the mailroom_items insert (Task #407)", () => {
    // Match only the mailroom_items insert block (the file also inserts into
    // workqueue_items, which legitimately has a `title:` column).
    const m = src.match(/from\("mailroom_items"\)[\s\S]*?\.insert\(\{([\s\S]*?)\}\)/);
    assert.ok(m, "expected a mailroom_items insert");
    assert.doesNotMatch(m![1], /\btitle\s*[,:]/);
  });
});
