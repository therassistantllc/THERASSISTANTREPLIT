/**
 * Unit coverage for `lib/billing/cobBilling` — the helpers behind the
 * COB Issues queue's "Bill primary" / "Bill secondary" actions.
 *
 * These tests pin the data-side contract that the COB action route
 * relies on:
 *   - billSecondary clones the original claim into a child claim
 *     payable to the *secondary* policy's payer, stamps prior-payer
 *     amounts from the ERA on file, copies service lines, and marks
 *     the original `secondary_billing_state='generated'`.
 *   - billPrimary re-points an existing claim at the primary policy's
 *     payer and flips it back to `ready_for_batch`.
 *   - Both helpers honor a biller-supplied `orderedPolicyIds`
 *     re-priority list against `insurance_policies`.
 *   - Missing prerequisites (no secondary policy / no EOB on file)
 *     return a structured error rather than producing a half-built
 *     clone.
 */
import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

import { billPrimary, billSecondary } from "../cobBilling";

const ORG = "11111111-1111-1111-1111-111111111111";
const CLAIM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLIENT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PRIMARY_PAYER = "cccccccc-cccc-cccc-cccc-ccccccccccc1";
const SECONDARY_PAYER = "cccccccc-cccc-cccc-cccc-ccccccccccc2";
const PRIMARY_POLICY = "dddddddd-dddd-dddd-dddd-dddddddddd11";
const SECONDARY_POLICY = "dddddddd-dddd-dddd-dddd-dddddddddd22";

type Row = Record<string, any>;

interface Tables {
  professional_claims: Row[];
  professional_claim_service_lines: Row[];
  insurance_policies: Row[];
  era_claim_payments: Row[];
  claim_parties_snapshot: Row[];
}

let tables: Tables;
let nextChildId = 0;

function freshTables(): Tables {
  return {
    professional_claims: [
      {
        id: CLAIM_ID,
        organization_id: ORG,
        patient_id: CLIENT_ID,
        appointment_id: "11111111-2222-3333-4444-555555555555",
        payer_profile_id: PRIMARY_PAYER,
        claim_status: "paid",
        claim_frequency_code: "1",
        total_charge: 200,
        place_of_service: "11",
        diagnosis_codes: ["F32.9"],
        prior_authorization_number: null,
        accept_assignment: true,
        benefits_assignment: true,
        release_of_information: true,
        signature_on_file: true,
        patient_responsibility_amount: 20,
        payer_responsibility_amount: 150,
        secondary_billing_state: null,
        secondary_billing_eob_attached_at: null,
        secondary_billing_eob_reference: null,
      },
    ],
    professional_claim_service_lines: [
      {
        claim_id: CLAIM_ID,
        line_number: 1,
        service_date_from: "2026-05-01",
        service_date_to: "2026-05-01",
        procedure_code: "90837",
        modifiers: [],
        charge_amount: 200,
        units: 1,
        diagnosis_pointers: ["1"],
        place_of_service: "11",
        rendering_provider_npi: "1234567890",
        authorization_number: null,
      },
    ],
    insurance_policies: [
      {
        id: PRIMARY_POLICY,
        organization_id: ORG,
        client_id: CLIENT_ID,
        payer_id: PRIMARY_PAYER,
        priority: "primary",
        active_flag: true,
        archived_at: null,
      },
      {
        id: SECONDARY_POLICY,
        organization_id: ORG,
        client_id: CLIENT_ID,
        payer_id: SECONDARY_PAYER,
        priority: "secondary",
        active_flag: true,
        archived_at: null,
      },
    ],
    era_claim_payments: [
      {
        id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1",
        era_import_batch_id: "ffffffff-ffff-ffff-ffff-ffffffffff01",
        professional_claim_id: CLAIM_ID,
        organization_id: ORG,
        clp03_total_charge: 200,
        clp04_payment_amount: 150,
        clp05_patient_responsibility: 20,
        payer_claim_control_number: "PCCN-1",
        cas_adjustments: [{ group_code: "CO", reason_code: "45", amount: 30 }],
        service_lines: [],
        created_at: "2026-05-10T00:00:00Z",
        archived_at: null,
      },
    ],
    claim_parties_snapshot: [],
  };
}

interface Filter {
  op: "eq" | "in" | "is";
  col: string;
  val: any;
}

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.op === "eq" && row[f.col] !== f.val) return false;
    if (f.op === "in" && !(f.val as any[]).includes(row[f.col])) return false;
    if (f.op === "is" && row[f.col] !== f.val) return false;
  }
  return true;
}

function makeBuilder(table: keyof Tables, mode: "select" | "insert" | "update" | "delete") {
  let filters: Filter[] = [];
  let updatePatch: Row | null = null;
  let insertRows: Row[] = [];
  let singleMode: "single" | "maybeSingle" | null = null;
  const builder: any = {
    eq(col: string, val: any) {
      filters.push({ op: "eq", col, val });
      return builder;
    },
    in(col: string, val: any) {
      filters.push({ op: "in", col, val });
      return builder;
    },
    is(col: string, val: any) {
      filters.push({ op: "is", col, val });
      return builder;
    },
    order() {
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
    then(onFulfilled: any, onRejected: any) {
      let result: any;
      try {
        if (mode === "select") {
          const rows = tables[table].filter((r) => matches(r, filters));
          if (singleMode) result = { data: rows[0] ?? null, error: null };
          else result = { data: rows, error: null };
        } else if (mode === "update") {
          let count = 0;
          for (const r of tables[table]) {
            if (matches(r, filters)) {
              Object.assign(r, updatePatch ?? {});
              count += 1;
            }
          }
          result = { data: null, error: null, count };
        } else if (mode === "insert") {
          const inserted: Row[] = [];
          for (const r of insertRows) {
            nextChildId += 1;
            const withId = {
              id:
                r.id ??
                `99999999-9999-9999-9999-9999999999${String(nextChildId).padStart(2, "0")}`,
              claim_number: r.claim_number ?? `CN-${nextChildId}`,
              ...r,
            };
            tables[table].push(withId);
            inserted.push(withId);
          }
          if (singleMode) result = { data: inserted[0] ?? null, error: null };
          else result = { data: inserted, error: null };
        } else if (mode === "delete") {
          tables[table] = tables[table].filter((r) => !matches(r, filters));
          result = { data: null, error: null };
        }
      } catch (e) {
        return Promise.resolve().then(onFulfilled).catch(onRejected);
      }
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  builder.update = (patch: Row) => {
    updatePatch = patch;
    return builder;
  };
  builder.insert = (rows: Row | Row[]) => {
    insertRows = Array.isArray(rows) ? rows : [rows];
    return builder;
  };
  return builder;
}

const fakeSupabase = {
  from(table: keyof Tables) {
    let activeMode: "select" | "insert" | "update" | "delete" = "select";
    const builder: any = makeBuilder(table, activeMode);
    return new Proxy(builder, {
      get(_t, prop: string) {
        if (prop === "select") {
          activeMode = "select";
          const b = makeBuilder(table, "select");
          Object.assign(builder, b);
          return (cols?: string) => b.select(cols);
        }
        if (prop === "insert") {
          activeMode = "insert";
          const b = makeBuilder(table, "insert");
          Object.assign(builder, b);
          return (rows: Row | Row[]) => b.insert(rows);
        }
        if (prop === "update") {
          activeMode = "update";
          const b = makeBuilder(table, "update");
          Object.assign(builder, b);
          return (patch: Row) => b.update(patch);
        }
        if (prop === "delete") {
          activeMode = "delete";
          const b = makeBuilder(table, "delete");
          Object.assign(builder, b);
          return () => b;
        }
        return (builder as any)[prop];
      },
    });
  },
};

beforeEach(() => {
  tables = freshTables();
  nextChildId = 0;
});

describe("billSecondary", () => {
  it("clones the claim, stamps prior-payer amounts, and marks the original generated", async () => {
    const result = await billSecondary({
      supabase: fakeSupabase as any,
      organizationId: ORG,
      claimId: CLAIM_ID,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.childClaimId, "child claim id should be returned");

    const child = tables.professional_claims.find(
      (c) => c.id === result.childClaimId,
    );
    assert.ok(child, "child claim row should exist");
    assert.equal(child!.payer_profile_id, SECONDARY_PAYER, "child points at secondary payer");
    assert.equal(child!.original_claim_id, CLAIM_ID);
    assert.equal(child!.cob_billing_role, "secondary");
    assert.equal(child!.claim_status, "ready_for_batch");
    // Prior-payer amounts stamped from the ERA on file.
    assert.equal(child!.prior_payer_paid_amount, 150);
    assert.equal(child!.prior_payer_patient_responsibility_amount, 20);
    assert.equal(child!.prior_payer_adjustment_amount, 30);
    assert.equal(child!.prior_payer_profile_id, PRIMARY_PAYER);
    assert.ok(child!.prior_payer_eob_data?.era_payment_id);

    // Service lines cloned onto the child.
    const childLines = tables.professional_claim_service_lines.filter(
      (l) => l.claim_id === result.childClaimId,
    );
    assert.equal(childLines.length, 1);
    assert.equal(childLines[0].procedure_code, "90837");

    // Original marked generated so the COB row knows a child is in flight.
    const original = tables.professional_claims.find((c) => c.id === CLAIM_ID)!;
    assert.equal(original.secondary_billing_state, "generated");
    assert.ok(original.secondary_billing_generated_at);
  });

  it("returns 422 when there's no secondary policy on file", async () => {
    tables.insurance_policies = tables.insurance_policies.filter(
      (p) => p.priority !== "secondary",
    );
    const result = await billSecondary({
      supabase: fakeSupabase as any,
      organizationId: ORG,
      claimId: CLAIM_ID,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.match(result.error, /secondary policy/i);
    // No child claim should have been inserted.
    assert.equal(tables.professional_claims.length, 1);
  });

  it("returns 422 when the primary payer EOB is missing", async () => {
    tables.era_claim_payments = [];
    const result = await billSecondary({
      supabase: fakeSupabase as any,
      organizationId: ORG,
      claimId: CLAIM_ID,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.match(result.error, /EOB/i);
    assert.equal(tables.professional_claims.length, 1);
  });

  it("applies a biller-supplied policy reorder before cloning", async () => {
    // Flip both policies the wrong way so the biller has to swap them.
    tables.insurance_policies[0].priority = "secondary";
    tables.insurance_policies[1].priority = "primary";
    const result = await billSecondary({
      supabase: fakeSupabase as any,
      organizationId: ORG,
      claimId: CLAIM_ID,
      orderedPolicyIds: [PRIMARY_POLICY, SECONDARY_POLICY],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // After the reorder the originally-listed primary policy should
    // be primary again, and the child should point at the *other* one
    // (now secondary).
    const primary = tables.insurance_policies.find((p) => p.id === PRIMARY_POLICY)!;
    const secondary = tables.insurance_policies.find((p) => p.id === SECONDARY_POLICY)!;
    assert.equal(primary.priority, "primary");
    assert.equal(secondary.priority, "secondary");
    const child = tables.professional_claims.find(
      (c) => c.id === result.childClaimId,
    )!;
    assert.equal(child.payer_profile_id, SECONDARY_PAYER);
  });
});

describe("billPrimary", () => {
  it("re-points an existing claim at the primary payer and flips it back to ready_for_batch", async () => {
    // Pretend the claim was incorrectly sent to the secondary payer.
    tables.professional_claims[0].payer_profile_id = SECONDARY_PAYER;
    tables.professional_claims[0].claim_status = "rejected_payer";

    const result = await billPrimary({
      supabase: fakeSupabase as any,
      organizationId: ORG,
      claimId: CLAIM_ID,
    });
    assert.equal(result.ok, true);

    const original = tables.professional_claims.find((c) => c.id === CLAIM_ID)!;
    assert.equal(original.payer_profile_id, PRIMARY_PAYER);
    assert.equal(original.claim_status, "ready_for_batch");
    assert.equal(original.cob_billing_role, "primary");
    // No new claim row should have been created.
    assert.equal(tables.professional_claims.length, 1);
  });

  it("returns 422 when no primary policy exists", async () => {
    tables.insurance_policies = tables.insurance_policies.filter(
      (p) => p.priority !== "primary",
    );
    const result = await billPrimary({
      supabase: fakeSupabase as any,
      organizationId: ORG,
      claimId: CLAIM_ID,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.match(result.error, /primary policy/i);
  });
});
