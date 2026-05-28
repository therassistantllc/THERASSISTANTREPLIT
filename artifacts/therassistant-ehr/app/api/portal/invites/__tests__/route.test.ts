/**
 * Coverage for the portal invite POST endpoint.
 *
 * Pins the cross-org guard, the email-without-an-email-on-file rejection,
 * the auto-revoke-of-prior-pending-invite behavior on resend, and the
 * delivery-failure path that must return 502 with the invite still recorded.
 */
import { test, before, mock } from "node:test";
import assert from "node:assert/strict";

const ORG_A = "org-a";
const ORG_B = "org-b";
const STAFF = "staff-1";
const CLIENT = "client-1";

type Row = Record<string, unknown>;

type Call = {
  table: string;
  op: "select" | "insert" | "update";
  payload?: Row;
  filters: Array<{ field: string; value: unknown }>;
};

type TableHandler = {
  select?: (filters: Array<{ field: string; value: unknown }>) => Row | null;
  insert?: (payload: Row) => Row | null;
  update?: (
    payload: Row,
    filters: Array<{ field: string; value: unknown }>,
  ) => Row | null;
};

function makeSupabase(handlers: Record<string, TableHandler>) {
  const calls: Call[] = [];

  function builderFor(table: string, op: Call["op"], payload?: Row) {
    const filters: Call["filters"] = [];

    function settle(): { data: Row | null; error: null } {
      const handler = handlers[table];
      let data: Row | null = null;
      if (handler) {
        if (op === "select" && handler.select) data = handler.select(filters);
        else if (op === "insert" && handler.insert) data = handler.insert(payload ?? {});
        else if (op === "update" && handler.update)
          data = handler.update(payload ?? {}, filters);
      }
      calls.push({ table, op, payload, filters: [...filters] });
      return { data, error: null };
    }

    const chain: Record<string, unknown> = {};
    chain.eq = (field: string, value: unknown) => {
      filters.push({ field, value });
      return chain;
    };
    chain.select = (..._args: unknown[]) => chain;
    chain.single = async () => settle();
    chain.maybeSingle = async () => settle();
    chain.then = (onFulfilled: (v: { data: Row | null; error: null }) => unknown) => {
      const v = settle();
      return Promise.resolve(onFulfilled(v));
    };
    return chain;
  }

  return {
    supabase: {
      from(table: string) {
        return {
          select(..._args: unknown[]) {
            return builderFor(table, "select");
          },
          insert(payload: Row) {
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

// Mutable refs swapped per test — the modules are mocked ONCE in a before()
// hook so we don't fight Node's "module is already mocked" guard on re-imports.
type Scenario = {
  organizationId: string;
  client: Row | null;
  inserted: Row | null;
  emailResult:
    | { ok: true; providerId: string | null; fromEmail: string }
    | { ok: false; error: string };
};

const scenario: Scenario = {
  organizationId: ORG_A,
  client: null,
  inserted: null,
  emailResult: { ok: true, providerId: "prov-1", fromEmail: "from@x" },
};

let lastCalls: Call[] = [];
let lastEmailCalls: Array<Record<string, unknown>> = [];

before(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";

  mock.module("@/lib/rbac/middleware", {
    namedExports: {
      requirePermissionInRoute: async () => ({
        staffId: STAFF,
        organizationId: scenario.organizationId,
        email: null,
        firstName: null,
        lastName: null,
        roles: [],
        permissions: [],
      }),
    },
  });

  mock.module("@/lib/supabase/server", {
    namedExports: {
      createServerSupabaseAdminClient: () => {
        const built = makeSupabase({
          clients: {
            select: () => scenario.client,
            update: () => ({}),
          },
          organizations: {
            select: () => ({ name: "Test Practice" }),
          },
          portal_invites: {
            update: () => ({}),
            insert: () => scenario.inserted,
          },
        });
        lastCalls = built.calls;
        return built.supabase;
      },
    },
  });

  mock.module("@/lib/email/resend", {
    namedExports: {
      sendPortalInviteEmail: async (input: Record<string, unknown>) => {
        lastEmailCalls.push(input);
        return scenario.emailResult;
      },
    },
  });
});

function setScenario(patch: Partial<Scenario>) {
  Object.assign(scenario, patch);
  lastCalls = [];
  lastEmailCalls = [];
}

function jsonRequest(body: unknown): Request {
  return new Request("https://app.test/api/portal/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const defaultClient: Row = {
  id: CLIENT,
  organization_id: ORG_A,
  email: "client@example.com",
  first_name: "Pat",
  last_name: "Doe",
  preferred_name: null,
};

const defaultInserted: Row = {
  id: "invite-1",
  token: "tok-abc",
  expires_at: "2030-01-01T00:00:00.000Z",
  status: "pending",
  delivery_method: "email",
};

async function loadPost() {
  const mod = await import("../route");
  return mod.POST as (r: Request) => Promise<Response>;
}

test("rejects when the client is in a different organization (cross-org guard)", async () => {
  setScenario({
    organizationId: ORG_B,
    client: { ...defaultClient, organization_id: ORG_A },
    inserted: defaultInserted,
    emailResult: { ok: true, providerId: "prov-1", fromEmail: "from@x" },
  });
  const POST = await loadPost();
  const res = await POST(jsonRequest({ clientId: CLIENT, delivery: "email" }));
  assert.equal(res.status, 403);
  const body = (await res.json()) as { success: boolean; error: string };
  assert.equal(body.success, false);
  assert.match(body.error, /not in your organization/i);
  // Cross-org rejection must short-circuit before we touch portal_invites.
  assert.equal(lastCalls.filter((c) => c.table === "portal_invites").length, 0);
});

test("rejects email delivery when the client has no email on file", async () => {
  setScenario({
    organizationId: ORG_A,
    client: { ...defaultClient, email: "" },
    inserted: defaultInserted,
    emailResult: { ok: true, providerId: "prov-1", fromEmail: "from@x" },
  });
  const POST = await loadPost();
  const res = await POST(jsonRequest({ clientId: CLIENT, delivery: "email" }));
  assert.equal(res.status, 400);
  const body = (await res.json()) as { success: boolean; error: string };
  assert.equal(body.success, false);
  assert.match(body.error, /does not have an email on file/i);
  // Must not attempt delivery and must not write to portal_invites.
  assert.equal(lastEmailCalls.length, 0);
  assert.equal(lastCalls.filter((c) => c.table === "portal_invites").length, 0);
});

test("resend revokes prior pending invites for the same client before creating a new one", async () => {
  setScenario({
    organizationId: ORG_A,
    client: defaultClient,
    inserted: defaultInserted,
    emailResult: { ok: true, providerId: "prov-1", fromEmail: "from@x" },
  });
  const POST = await loadPost();
  const res = await POST(jsonRequest({ clientId: CLIENT, delivery: "clipboard" }));
  assert.equal(res.status, 200);

  const portalInviteOps = lastCalls.filter((c) => c.table === "portal_invites");
  const revokeIndex = portalInviteOps.findIndex(
    (c) =>
      c.op === "update" &&
      (c.payload as Row | undefined)?.status === "revoked" &&
      c.filters.some((f) => f.field === "client_id" && f.value === CLIENT) &&
      c.filters.some((f) => f.field === "status" && f.value === "pending"),
  );
  const insertIndex = portalInviteOps.findIndex((c) => c.op === "insert");

  assert.ok(revokeIndex >= 0, "expected a revoke-pending update on portal_invites");
  assert.ok(insertIndex >= 0, "expected an insert on portal_invites");
  assert.ok(
    revokeIndex < insertIndex,
    "revoke of prior pending invites must happen before inserting the new one",
  );
});

test("delivery failure returns 502 with the invite still recorded", async () => {
  setScenario({
    organizationId: ORG_A,
    client: defaultClient,
    inserted: defaultInserted,
    emailResult: { ok: false, error: "Resend down" },
  });
  const POST = await loadPost();
  const res = await POST(jsonRequest({ clientId: CLIENT, delivery: "email" }));
  assert.equal(res.status, 502);

  const body = (await res.json()) as {
    success: boolean;
    error: string;
    invite?: { id: string; token: string };
  };
  assert.equal(body.success, false);
  assert.match(body.error, /Resend down/);
  assert.ok(body.invite, "failed delivery must still surface the invite row");
  assert.equal(body.invite?.id, "invite-1");
  assert.equal(body.invite?.token, "tok-abc");

  // Invite row was inserted before the failed send, and a failure marker was written after.
  const portalInviteOps = lastCalls.filter((c) => c.table === "portal_invites");
  assert.ok(
    portalInviteOps.some((c) => c.op === "insert"),
    "invite row must be inserted even when delivery fails",
  );
  assert.ok(
    portalInviteOps.some(
      (c) =>
        c.op === "update" &&
        (c.payload as Row | undefined)?.delivery_status === "failed" &&
        (c.payload as Row | undefined)?.delivery_error === "Resend down",
    ),
    "failure path must mark the invite row delivery_status=failed with the error",
  );
});
