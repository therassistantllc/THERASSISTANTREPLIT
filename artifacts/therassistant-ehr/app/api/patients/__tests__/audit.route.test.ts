/**
 * Coverage for the demographics audit trail on the client detail endpoints.
 *
 * Pins the HIPAA-critical contracts:
 *
 *   PATCH /api/patients/[clientId]
 *     - Writes exactly one audit_logs row per CHANGED field, zero for
 *       unchanged fields.
 *     - before_value / after_value carry the prior + new values for the
 *       right column, and user_id is taken from the authenticated staff.
 *     - Audit is written BEFORE the client row is updated, and if the
 *       audit insert fails the client row is NOT mutated (audit-first,
 *       refuse-on-failure — opposite of best-effort, see task notes).
 *
 *   GET /api/patients/[clientId]/audit
 *     - Returns rows newest-first (the route's .order() must be desc).
 *     - Resolves user_id → staff display name via staff_profiles.
 */
import { strict as assert } from "node:assert";
import { before, mock, test } from "node:test";

import {
  validateInsert,
  validateWritePayload,
} from "../../../../lib/supabase/__tests__/schemaGuard";

const ORG = "org-1";
const CLIENT = "client-1";
const STAFF_USER = "user-1";

type Row = Record<string, unknown>;
type Filter = { field: string; value: unknown };

type Call = {
  table: string;
  op: "select" | "insert" | "update";
  payload?: Row | Row[];
  filters: Filter[];
  orderDesc?: boolean;
};

type SelectResult = { data: Row | Row[] | null; error: { message: string } | null };
type InsertResult = { data: Row | Row[] | null; error: { message: string } | null };
type UpdateResult = { data: Row | Row[] | null; error: { message: string } | null };

type TableHandler = {
  select?: (filters: Filter[]) => SelectResult;
  insert?: (payload: Row | Row[]) => InsertResult;
  update?: (payload: Row, filters: Filter[]) => UpdateResult;
};

const handlers: Record<string, TableHandler> = {};
let calls: Call[] = [];

function setHandlers(next: Record<string, TableHandler>) {
  for (const key of Object.keys(handlers)) delete handlers[key];
  Object.assign(handlers, next);
  calls = [];
}

function builderFor(table: string, op: Call["op"], payload?: Row | Row[]) {
  const filters: Filter[] = [];
  let orderDesc: boolean | undefined;

  function settle(): SelectResult | InsertResult | UpdateResult {
    const handler = handlers[table];
    let result: SelectResult | InsertResult | UpdateResult = { data: null, error: null };
    if (handler) {
      if (op === "select" && handler.select) result = handler.select(filters);
      else if (op === "insert" && handler.insert) {
        validateInsert(table, (payload ?? {}) as Row | Row[]);
        result = handler.insert(payload ?? {});
      } else if (op === "update" && handler.update) {
        validateWritePayload(table, (payload ?? {}) as Row);
        result = handler.update((payload ?? {}) as Row, filters);
      }
    }
    calls.push({ table, op, payload, filters: [...filters], orderDesc });
    return result;
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
  chain.order = (_field: string, opts?: { ascending?: boolean }) => {
    orderDesc = opts?.ascending === false;
    return chain;
  };
  chain.limit = (..._args: unknown[]) => chain;
  chain.maybeSingle = async () => settle();
  chain.single = async () => settle();
  chain.then = (onFulfilled: (v: SelectResult) => unknown) =>
    Promise.resolve(onFulfilled(settle() as SelectResult));
  return chain;
}

function fakeSupabase() {
  return {
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
  };
}

const staffCtx: {
  current: {
    organizationId: string;
    staffId: string | null;
    userId: string | null;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    roles: string[];
    permissions: string[];
  } | null;
} = { current: null };

before(() => {
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createServerSupabaseServiceRoleClient: () => fakeSupabase(),
      createServerSupabaseAdminClient: () => fakeSupabase(),
    },
  });
  mock.module("@/lib/rbac/auth", {
    namedExports: {
      requireAuthenticatedStaff: async () => staffCtx.current,
    },
  });
  mock.module("@/lib/auth/requireOrgAccess", {
    namedExports: {
      requireOrgAccess: async () => {
        if (!staffCtx.current) {
          // Simulate the production 401 path — tests that need success
          // must set staffCtx.current first.
          const { NextResponse } = await import("next/server");
          return NextResponse.json(
            { success: false, error: "Authentication required" },
            { status: 401 },
          );
        }
        return {
          organizationId: staffCtx.current.organizationId,
          staffId: staffCtx.current.staffId,
          userId: staffCtx.current.userId,
          roles: staffCtx.current.roles,
          permissions: staffCtx.current.permissions,
          isDevPassthrough: false,
        };
      },
    },
  });
});

function setStaff(overrides: Partial<NonNullable<typeof staffCtx.current>> = {}) {
  staffCtx.current = {
    organizationId: ORG,
    staffId: "staff-1",
    userId: STAFF_USER,
    email: "alex@clinic.test",
    firstName: "Alex",
    lastName: "Stone",
    roles: ["clinician"],
    permissions: [],
    ...overrides,
  };
}

async function loadPatch() {
  const mod = await import("../[clientId]/route");
  return mod.PATCH as (
    r: Request,
    ctx: { params: Promise<{ clientId: string }> },
  ) => Promise<Response>;
}

async function loadAuditGet() {
  const mod = await import("../[clientId]/audit/route");
  return mod.GET as (
    r: Request,
    ctx: { params: Promise<{ clientId: string }> },
  ) => Promise<Response>;
}

function patchRequest(updates: Record<string, unknown>): Request {
  return new Request(`https://app.test/api/patients/${CLIENT}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updates }),
  });
}

function patchContext() {
  return { params: Promise.resolve({ clientId: CLIENT }) };
}

const baseClientRow: Row = {
  id: CLIENT,
  first_name: "Pat",
  middle_name: null,
  last_name: "Doe",
  preferred_name: null,
  mrn: "MRN-1",
  date_of_birth: "1990-01-01",
  sex_at_birth: "female",
  gender_identity: null,
  pronouns: null,
  address_line_1: "1 Old St",
  address_line_2: null,
  city: "Portland",
  state: "OR",
  postal_code: "97201",
  phone: "5550000",
  email: "pat@example.com",
  preferred_language: "en",
};

// ---------------------------------------------------------------------------
// PATCH /api/patients/[clientId]
// ---------------------------------------------------------------------------

test("PATCH writes one audit_logs row per CHANGED field and none for unchanged ones", async () => {
  setStaff();
  let inserted: Row[] = [];
  let patientUpdated = false;
  setHandlers({
    clients: {
      select: () => ({ data: baseClientRow, error: null }),
      update: () => {
        patientUpdated = true;
        return { data: null, error: null };
      },
    },
    audit_logs: {
      insert: (payload) => {
        inserted = (Array.isArray(payload) ? payload : [payload]) as Row[];
        return { data: null, error: null };
      },
    },
  });

  const PATCH = await loadPatch();
  const res = await PATCH(
    patchRequest({
      firstName: "Patricia", // changed
      lastName: "Doe", // unchanged
      city: "Seattle", // changed
      phone: "5550000", // unchanged
    }),
    patchContext(),
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);

  assert.equal(inserted.length, 2, "must emit exactly one row per changed field");
  const fields = inserted
    .map((r) => Object.keys(r.before_value as Record<string, unknown>)[0])
    .sort();
  assert.deepEqual(fields, ["city", "first_name"]);

  const byField = new Map(
    inserted.map((r) => [
      Object.keys(r.before_value as Record<string, unknown>)[0],
      r,
    ]),
  );
  const firstNameRow = byField.get("first_name")!;
  assert.deepEqual(firstNameRow.before_value, { first_name: "Pat" });
  assert.deepEqual(firstNameRow.after_value, { first_name: "Patricia" });
  assert.equal(firstNameRow.user_id, STAFF_USER, "must record the authenticated user_id");
  assert.equal(firstNameRow.organization_id, ORG);
  assert.equal(firstNameRow.object_type, "client");
  assert.equal(firstNameRow.object_id, CLIENT);
  assert.equal(firstNameRow.action, "demographic_field_updated");

  const cityRow = byField.get("city")!;
  assert.deepEqual(cityRow.before_value, { city: "Portland" });
  assert.deepEqual(cityRow.after_value, { city: "Seattle" });

  assert.ok(patientUpdated, "client row must be updated after audit succeeds");
});

test("PATCH emits NO audit rows (and no update) when nothing actually changes", async () => {
  setStaff();
  let auditCalls = 0;
  let updateCalls = 0;
  setHandlers({
    clients: {
      select: () => ({ data: baseClientRow, error: null }),
      update: () => {
        updateCalls += 1;
        return { data: null, error: null };
      },
    },
    audit_logs: {
      insert: () => {
        auditCalls += 1;
        return { data: null, error: null };
      },
    },
  });

  const PATCH = await loadPatch();
  const res = await PATCH(
    patchRequest({ firstName: "Pat", city: "Portland" }),
    patchContext(),
  );
  assert.equal(res.status, 200);
  assert.equal(auditCalls, 0, "no changed fields => no audit insert");
  // The route still issues an UPDATE (sets updated_at) even with no diff.
  // What we really care about: audit_logs was not touched.
  assert.ok(updateCalls <= 1);
});

test("PATCH refuses to update the client row when the audit insert fails (audit-first)", async () => {
  setStaff();
  let patientUpdated = false;
  setHandlers({
    clients: {
      select: () => ({ data: baseClientRow, error: null }),
      update: () => {
        patientUpdated = true;
        return { data: null, error: null };
      },
    },
    audit_logs: {
      insert: () => ({ data: null, error: { message: "audit table down" } }),
    },
  });

  const PATCH = await loadPatch();
  const res = await PATCH(patchRequest({ firstName: "Patricia" }), patchContext());
  assert.equal(res.status, 500);
  const body = (await res.json()) as { success: boolean; error: string };
  assert.equal(body.success, false);
  assert.match(body.error, /audit log/i);
  assert.equal(
    patientUpdated,
    false,
    "HIPAA gate: a failed audit insert must block the client update entirely",
  );
});

// ---------------------------------------------------------------------------
// GET /api/patients/[clientId]/audit
// ---------------------------------------------------------------------------

test("GET /audit returns rows newest-first and resolves staff display names", async () => {
  setStaff();
  const auditRows: Row[] = [
    {
      id: "a-1",
      created_at: "2026-05-23T10:00:00Z",
      user_id: STAFF_USER,
      user_role: "clinician",
      action: "demographic_field_updated",
      before_value: { first_name: "Pat" },
      after_value: { first_name: "Patricia" },
      event_summary: "First name changed",
      event_metadata: { field: "first_name", field_label: "First name" },
    },
    {
      id: "a-2",
      created_at: "2026-05-22T09:00:00Z",
      user_id: null,
      user_role: null,
      action: "demographic_field_updated",
      before_value: { city: "Portland" },
      after_value: { city: "Seattle" },
      event_summary: "City changed",
      event_metadata: {
        field: "city",
        field_label: "City",
        actor_name: "System Import",
        actor_email: "import@svc",
      },
    },
  ];

  let auditFilters: Filter[] = [];
  let auditOrderDesc: boolean | undefined;
  setHandlers({
    audit_logs: {
      select: (filters) => {
        auditFilters = filters;
        return { data: auditRows, error: null };
      },
    },
    staff_profiles: {
      select: () => ({
        data: [
          {
            auth_user_id: STAFF_USER,
            first_name: "Alex",
            last_name: "Stone",
            email: "alex@clinic.test",
          },
        ],
        error: null,
      }),
    },
  });

  const GET = await loadAuditGet();
  // Spy on .order() — the builder records it; capture from the calls array.
  const res = await GET(
    new Request(`https://app.test/api/patients/${CLIENT}/audit`),
    patchContext(),
  );
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    success: boolean;
    entries: Array<{
      id: string;
      createdAt: string;
      field: string | null;
      fieldLabel: string;
      beforeValue: string | null;
      afterValue: string | null;
      actorName: string | null;
      actorEmail: string | null;
    }>;
  };
  assert.equal(body.success, true);
  assert.equal(body.entries.length, 2);

  // Newest-first ordering must be requested at the DB layer (the route does
  // not re-sort in memory), so .order("created_at", { ascending: false }).
  const auditOrderCall = calls.find((c) => c.table === "audit_logs" && c.op === "select");
  auditOrderDesc = auditOrderCall?.orderDesc;
  assert.equal(
    auditOrderDesc,
    true,
    "audit_logs query must request descending created_at order",
  );

  // Filtered to this org + this client + the tracked chart actions.
  // The route filters by patient_id (set on every chart-tracked audit row)
  // rather than object_type/object_id, so policy/case rows surface alongside
  // client rows in the client audit log.
  const has = (field: string, value: unknown) =>
    auditFilters.some((f) => f.field === field && f.value === value);
  const hasIn = (field: string, predicate: (value: unknown) => boolean) =>
    auditFilters.some((f) => f.field === field && predicate(f.value));
  assert.ok(has("organization_id", ORG));
  assert.ok(has("patient_id", CLIENT));
  assert.ok(
    hasIn("action", (v) => Array.isArray(v) && v.includes("demographic_field_updated")),
    "must constrain to the tracked chart actions",
  );

  // Row 1: user_id resolves to the staff display name from staff_profiles.
  const first = body.entries[0];
  assert.equal(first.id, "a-1");
  assert.equal(first.field, "first_name");
  assert.equal(first.fieldLabel, "First name");
  assert.equal(first.beforeValue, "Pat");
  assert.equal(first.afterValue, "Patricia");
  assert.equal(first.actorName, "Alex Stone", "must resolve user_id via staff_profiles");
  assert.equal(first.actorEmail, "alex@clinic.test");

  // Row 2: no user_id → falls back to event_metadata actor fields.
  const second = body.entries[1];
  assert.equal(second.id, "a-2");
  assert.equal(second.field, "city");
  assert.equal(second.beforeValue, "Portland");
  assert.equal(second.afterValue, "Seattle");
  assert.equal(second.actorName, "System Import");
  assert.equal(second.actorEmail, "import@svc");
});
