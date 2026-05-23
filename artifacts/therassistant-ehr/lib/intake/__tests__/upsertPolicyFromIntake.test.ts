/**
 * Task #244 regression: two near-simultaneous intake submits must NOT
 * leave behind two "primary" policies for the same client. The partial
 * unique index on insurance_policies (client_id, priority) WHERE
 * archived_at IS NULL raises 23505 on the racing second INSERT; the
 * upsert helper has to catch it and fall back to UPDATE so both callers
 * converge on a single row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  IntakePoliciesSupabase,
  IntakePolicyFields,
  UNIQUE_VIOLATION,
  upsertPolicyFromIntake,
} from "../upsertPolicyFromIntake";

type StoredPolicy = { id: string; fields: IntakePolicyFields };

function makeFakeDb(opts: { selectGate?: () => Promise<void>; insertGate?: () => Promise<void> } = {}) {
  const rows: StoredPolicy[] = [];
  let nextId = 0;
  const selectGate = opts.selectGate ?? (async () => {});
  const insertGate = opts.insertGate ?? (async () => {});

  const supabase: IntakePoliciesSupabase = {
    from() {
      return {
        select() {
          return {
            eq(_f1: string, v1: string) {
              return {
                eq(_f2: string, v2: string) {
                  return {
                    async maybeSingle() {
                      await selectGate();
                      const found = rows.find(
                        (r) => r.fields.client_id === v1 && r.fields.priority === v2,
                      );
                      return { data: found ? ({ id: found.id } as never) : null, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        async insert(row: Record<string, unknown>) {
          await insertGate();
          const fields = row as IntakePolicyFields;
          const dup = rows.find(
            (r) => r.fields.client_id === fields.client_id && r.fields.priority === fields.priority,
          );
          if (dup) {
            return { error: { message: "duplicate key", code: UNIQUE_VIOLATION } };
          }
          rows.push({ id: `policy-${++nextId}`, fields });
          return { error: null };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(_f: string, id: string) {
              const found = rows.find((r) => r.id === id);
              if (!found) {
                return Promise.resolve({ error: { message: "not found", code: "PGRST116" } });
              }
              found.fields = { ...found.fields, ...(patch as Partial<IntakePolicyFields>) };
              return Promise.resolve({ error: null });
            },
          };
        },
      } as ReturnType<IntakePoliciesSupabase["from"]>;
    },
  };

  return { supabase, rows };
}

const baseFields = (overrides: Partial<IntakePolicyFields> = {}): IntakePolicyFields => ({
  organization_id: "org-1",
  client_id: "client-1",
  priority: "primary",
  plan_name: "Aetna PPO",
  policy_number: "P-1",
  group_number: null,
  subscriber_relationship: "self",
  active_flag: true,
  ...overrides,
});

test("upsertPolicyFromIntake: first submit inserts, second submit updates the same row", async () => {
  const { supabase, rows } = makeFakeDb();

  const r1 = await upsertPolicyFromIntake(supabase, baseFields({ plan_name: "Aetna PPO" }));
  const r2 = await upsertPolicyFromIntake(supabase, baseFields({ plan_name: "Aetna PPO v2" }));

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.policyId, r2.policyId);
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields.plan_name, "Aetna PPO v2");
});

test("upsertPolicyFromIntake: two concurrent intake submits converge on a single policy row", async () => {
  // Both callers run their SELECT before either runs their INSERT,
  // mirroring the production race where two intake POSTs land within
  // a few ms of each other.
  let pendingSelect: Array<() => void> = [];
  let pendingInsert: Array<() => void> = [];

  const selectGate = () => new Promise<void>((resolve) => pendingSelect.push(resolve));
  const insertGate = () => new Promise<void>((resolve) => pendingInsert.push(resolve));

  const { supabase, rows } = makeFakeDb({ selectGate, insertGate });

  const p1 = upsertPolicyFromIntake(supabase, baseFields({ plan_name: "First Caller Plan" }));
  const p2 = upsertPolicyFromIntake(supabase, baseFields({ plan_name: "Second Caller Plan" }));

  // Release both SELECTs together — both see no existing row.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  pendingSelect.splice(0).forEach((r) => r());

  // Then drain everything (INSERTs race, second one gets 23505, then
  // its re-select + UPDATE has to fire).
  let settled = false;
  const done = Promise.all([p1, p2]).then((r) => {
    settled = true;
    return r;
  });
  while (!settled) {
    await new Promise((r) => setImmediate(r));
    pendingInsert.splice(0).forEach((r) => r());
    pendingSelect.splice(0).forEach((r) => r());
  }

  const [r1, r2] = await done;
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.policyId, r2.policyId, "both submits must converge on the same policy id");
  assert.equal(rows.length, 1, "exactly one insurance_policies row written");
  assert.equal([r1.created, r2.created].filter(Boolean).length, 1, "exactly one caller saw the insert");
  // Whichever caller lost the race still applied its UPDATE, so the
  // stored row reflects the loser's payload — never a stale half-write.
  assert.ok(
    rows[0].fields.plan_name === "First Caller Plan" ||
      rows[0].fields.plan_name === "Second Caller Plan",
  );
});

test("upsertPolicyFromIntake: surfaces non-23505 insert errors verbatim", async () => {
  const supabase: IntakePoliciesSupabase = {
    from() {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        }),
        insert: async () => ({ error: { message: "fk violation", code: "23503" } }),
        update: () => ({ eq: async () => ({ error: null }) }),
      } as ReturnType<IntakePoliciesSupabase["from"]>;
    },
  };

  const r = await upsertPolicyFromIntake(supabase, baseFields());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /fk violation/);
  assert.equal(r.code, "23503");
});

test("regression: migration adds the partial unique index covering (client_id, priority)", () => {
  const sql = readFileSync(
    "supabase/migrations/20260602000000_insurance_policies_intake_dedupe_unique.sql",
    "utf8",
  );
  assert.match(
    sql,
    /idx_insurance_policies_unique_active_client_priority[\s\S]*insurance_policies[\s\S]*\(client_id,\s*priority\)/i,
  );
  assert.match(sql, /where\s+archived_at\s+is\s+null/i);
});

test("regression: intake route uses the race-safe upsert helper", () => {
  const route = readFileSync("app/api/intake/[token]/route.ts", "utf8");
  assert.match(route, /from "@\/lib\/intake\/upsertPolicyFromIntake"/);
  assert.match(route, /upsertPolicyFromIntake\(/);
  // The old read-then-insert pattern must be gone — otherwise the race
  // would still bypass the helper.
  assert.doesNotMatch(route, /\.from\("insurance_policies"\)\s*\.insert\(/);
});
