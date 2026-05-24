/**
 * Pins the contract that `createProfessionalClaimDraft` pulls
 * `rendering_provider_taxonomy` for the claim_parties_snapshot directly
 * from `provider_profiles.taxonomy_code` for the appointment's rendering
 * provider — so every new 837P claim carries the correct loop 2310B
 * PRV*PXC value without anyone having to type it in.
 */
import { test, before, mock } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;

const ORG = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const APPT = "33333333-3333-3333-3333-333333333333";
const PROVIDER = "44444444-4444-4444-4444-444444444444";
const POLICY = "55555555-5555-5555-5555-555555555555";
const PAYER = "66666666-6666-6666-6666-666666666666";
const SUBSCRIBER = "77777777-7777-7777-7777-777777777777";
const TAXONOMY = "103TC0700X";

interface Tables {
  appointments: Row[];
  provider_profiles: Row[];
  clients: Row[];
  insurance_policies: Row[];
  insurance_payers: Row[];
  insurance_subscribers: Row[];
  payer_profiles: Row[];
  professional_claims: Row[];
  professional_claim_service_lines: Row[];
  claim_parties_snapshot: Row[];
  diagnosis_codes: Row[];
  procedure_codes: Row[];
}

let tables: Tables;
let nextClaimId = 0;

function freshTables(): Tables {
  return {
    appointments: [
      { id: APPT, organization_id: ORG, provider_id: PROVIDER },
    ],
    provider_profiles: [
      {
        id: "pp-1",
        organization_id: ORG,
        staff_id: PROVIDER,
        taxonomy_code: TAXONOMY,
        archived_at: null,
      },
    ],
    clients: [
      {
        id: CLIENT,
        organization_id: ORG,
        first_name: "Pat",
        last_name: "Doe",
        date_of_birth: "1990-01-01",
        sex_at_birth: "F",
        address_line_1: "123 Main St",
        city: "Austin",
        state: "TX",
        postal_code: "78701",
        archived_at: null,
      },
    ],
    insurance_policies: [
      {
        id: POLICY,
        organization_id: ORG,
        client_id: CLIENT,
        payer_id: PAYER,
        subscriber_id: SUBSCRIBER,
        priority: "primary",
        active_flag: true,
        archived_at: null,
      },
    ],
    insurance_payers: [
      { id: PAYER, payer_name: "Test Payer", payer_id: "12345", archived_at: null },
    ],
    insurance_subscribers: [
      {
        id: SUBSCRIBER,
        first_name: "Pat",
        last_name: "Doe",
        date_of_birth: "1990-01-01",
        member_id: "MEM-1",
        archived_at: null,
      },
    ],
    payer_profiles: [],
    professional_claims: [],
    professional_claim_service_lines: [],
    claim_parties_snapshot: [],
    diagnosis_codes: [{ code: "F32.9", is_active: true }],
    procedure_codes: [{ code: "90837", is_active: true }],
  };
}

interface Filter {
  op: "eq" | "in" | "is";
  col: string;
  val: unknown;
}

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.op === "eq" && row[f.col] !== f.val) return false;
    if (f.op === "in" && !(f.val as unknown[]).includes(row[f.col])) return false;
    if (f.op === "is" && row[f.col] !== f.val) return false;
  }
  return true;
}

function makeBuilder(table: keyof Tables, mode: "select" | "insert" | "update") {
  let filters: Filter[] = [];
  let insertRows: Row[] = [];
  let updatePatch: Row | null = null;
  let singleMode: "single" | "maybeSingle" | null = null;
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    eq(col: string, val: unknown) {
      filters.push({ op: "eq", col, val });
      return builder;
    },
    in(col: string, val: unknown) {
      filters.push({ op: "in", col, val });
      return builder;
    },
    is(col: string, val: unknown) {
      filters.push({ op: "is", col, val });
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    select(_cols?: string) {
      return builder;
    },
    single() {
      singleMode = "single";
      return builder;
    },
    maybeSingle() {
      singleMode = "maybeSingle";
      return builder;
    },
    then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
      let result: { data: unknown; error: null };
      if (mode === "select") {
        const rows = (tables[table] as Row[]).filter((r) => matches(r, filters));
        result = singleMode
          ? { data: rows[0] ?? null, error: null }
          : { data: rows, error: null };
      } else if (mode === "insert") {
        const inserted: Row[] = [];
        for (const r of insertRows) {
          nextClaimId += 1;
          const withId = {
            id: r.id ?? `claim-${nextClaimId}`,
            ...r,
          };
          (tables[table] as Row[]).push(withId);
          inserted.push(withId);
        }
        result = singleMode
          ? { data: inserted[0] ?? null, error: null }
          : { data: inserted, error: null };
      } else {
        for (const r of tables[table] as Row[]) {
          if (matches(r, filters)) Object.assign(r, updatePatch ?? {});
        }
        result = { data: null, error: null };
      }
      return Promise.resolve(result).then(onFulfilled);
    },
  });
  (builder as Record<string, unknown>).insert = (rows: Row | Row[]) => {
    insertRows = Array.isArray(rows) ? rows : [rows];
    return builder;
  };
  (builder as Record<string, unknown>).update = (patch: Row) => {
    updatePatch = patch;
    return builder;
  };
  return builder;
}

const fakeSupabase = {
  from(table: keyof Tables) {
    const ops: Record<string, "select" | "insert" | "update"> = {
      select: "select",
      insert: "insert",
      update: "update",
    };
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string) {
        if (prop in ops) {
          const builder = makeBuilder(table, ops[prop]);
          return (arg?: unknown) =>
            (builder as Record<string, (a?: unknown) => unknown>)[prop](arg);
        }
        return undefined;
      },
    });
  },
};

before(() => {
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createServerSupabaseAdminClient: () => fakeSupabase,
    },
  });
});

test("snapshot writer stamps rendering_provider_taxonomy from provider_profiles", async () => {
  tables = freshTables();
  nextClaimId = 0;
  const { createProfessionalClaimDraft } = await import(
    "../claimReadinessService"
  );

  const result = await createProfessionalClaimDraft({
    organizationId: ORG,
    clientId: CLIENT,
    appointmentId: APPT,
    placeOfService: "10",
    diagnosisCodes: ["F32.9"],
    serviceLines: [
      {
        serviceDate: "2026-05-01",
        procedureCode: "90837",
        chargeAmount: 200,
        units: 1,
      },
    ],
    billingProvider: {
      name: "Test Practice",
      npi: "1234567890",
      taxId: "12-3456789",
      address1: "500 Practice Way",
      city: "Austin",
      state: "TX",
      zip: "78701",
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(tables.claim_parties_snapshot.length, 1);
  assert.equal(
    tables.claim_parties_snapshot[0].rendering_provider_taxonomy,
    TAXONOMY,
  );
});

test("snapshot writer writes null when provider_profile has no taxonomy_code", async () => {
  tables = freshTables();
  nextClaimId = 0;
  tables.provider_profiles[0].taxonomy_code = null;

  const { createProfessionalClaimDraft } = await import(
    "../claimReadinessService"
  );
  const { validateProfessionalClaimReadiness } = await import(
    "../claimReadinessService"
  );

  const draft = await createProfessionalClaimDraft({
    organizationId: ORG,
    clientId: CLIENT,
    appointmentId: APPT,
    placeOfService: "10",
    diagnosisCodes: ["F32.9"],
    serviceLines: [
      {
        serviceDate: "2026-05-01",
        procedureCode: "90837",
        chargeAmount: 200,
        units: 1,
      },
    ],
    billingProvider: {
      name: "Test Practice",
      npi: "1234567890",
      taxId: "12-3456789",
      address1: "500 Practice Way",
      city: "Austin",
      state: "TX",
      zip: "78701",
    },
  });

  assert.equal(draft.ok, true, JSON.stringify(draft.errors));
  assert.equal(
    tables.claim_parties_snapshot[0].rendering_provider_taxonomy,
    null,
  );

  // Sanity: readiness validation still runs and does not crash on the
  // null taxonomy — payer-specific enforcement of the taxonomy rule
  // happens further downstream in the rules engine.
  const readiness = await validateProfessionalClaimReadiness(
    String(draft.claimId),
    ORG,
  );
  assert.equal(typeof readiness.ok, "boolean");
});
