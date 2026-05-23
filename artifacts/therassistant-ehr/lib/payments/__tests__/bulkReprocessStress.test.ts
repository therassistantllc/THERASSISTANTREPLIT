/**
 * Stress test: bulk reprocess at realistic batch sizes (Task #132).
 *
 * Exercises `reprocessBulkTargets` (the extracted core loop of
 * POST /api/billing/payments/bulk/reprocess) end-to-end against an
 * in-memory fake Supabase with ~100 mixed ERA + manual rows.
 *
 * Asserts the spec's invariants:
 *   • Every target gets either a workqueue delta (success path) or an
 *     entry in summary.errors — `reprocessed + errors === targets.length`.
 *   • Every successful target writes one audit_logs row with
 *     metadata.source = "bulk_reprocess".
 *   • The partial unique index `uq_workqueue_items_open_source_dedupe`
 *     (modelled here as (org, source_object_id, work_type) unique while
 *     status ∈ {open, in_progress, blocked} and archived_at IS NULL)
 *     prevents duplicates: a second reprocess of the same set creates
 *     zero new workqueue items.
 *   • Wall-clock budget is recorded as a regression signal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  reprocessBulkTargets,
  type BulkReprocessTarget,
} from "../bulkReprocess";
import type { PostingActor } from "../postingEngine";

/* ─── Fake Supabase ──────────────────────────────────────────────────── */

type Row = Record<string, unknown>;
interface FakeDB {
  tables: Record<string, Row[]>;
  nextId: number;
}

const OPEN_STATUSES = new Set(["open", "in_progress", "blocked"]);

function makeFakeSupabase(db: FakeDB): SupabaseClient {
  function from(table: string) {
    const rows = () => (db.tables[table] ??= []);
    return {
      select(_cols?: string) {
        const filters: Array<(r: Row) => boolean> = [];
        let lim = Infinity;
        const run = () => {
          let out = rows().filter((r) => filters.every((f) => f(r)));
          if (lim !== Infinity) out = out.slice(0, lim);
          return out;
        };
        const qb: Record<string, unknown> = {
          eq(f: string, v: unknown) {
            filters.push((r) => r[f] === v);
            return qb;
          },
          is(f: string, v: unknown) {
            filters.push((r) => (v === null ? r[f] == null : r[f] === v));
            return qb;
          },
          in(f: string, v: unknown[]) {
            filters.push((r) => (v as unknown[]).includes(r[f]));
            return qb;
          },
          neq(f: string, v: unknown) {
            filters.push((r) => r[f] !== v);
            return qb;
          },
          or(_expr: string) {
            return qb;
          },
          limit(n: number) {
            lim = n;
            return qb;
          },
          async maybeSingle() {
            const out = run();
            return { data: out[0] ?? null, error: null };
          },
          async single() {
            const out = run();
            return out[0]
              ? { data: out[0], error: null }
              : { data: null, error: { message: "not found" } };
          },
          then(
            resolve: (v: { data: Row[]; error: null }) => unknown,
            reject?: (e: unknown) => unknown,
          ) {
            return Promise.resolve({ data: run(), error: null }).then(
              resolve,
              reject,
            );
          },
        };
        return qb;
      },
      insert(payload: Row | Row[]) {
        const payloads = Array.isArray(payload) ? payload : [payload];
        let conflict: { code: string; message: string } | null = null;
        if (table === "workqueue_items") {
          for (const p of payloads) {
            const dup = rows().find(
              (r) =>
                r.organization_id === p.organization_id &&
                r.source_object_id === p.source_object_id &&
                r.work_type === p.work_type &&
                OPEN_STATUSES.has(String(r.status)) &&
                r.archived_at == null,
            );
            if (dup) {
              conflict = { code: "23505", message: "duplicate key value" };
              break;
            }
          }
        }
        const inserted: Row[] = [];
        if (!conflict) {
          for (const p of payloads) {
            const r: Row = { id: `${table}-${++db.nextId}`, ...p };
            rows().push(r);
            inserted.push(r);
          }
        }
        const tail = {
          select(_cols?: string) {
            return {
              async single() {
                if (conflict) return { data: null, error: conflict };
                return { data: inserted[0] ?? null, error: null };
              },
              then(resolve: (v: unknown) => unknown) {
                return Promise.resolve(
                  conflict
                    ? { data: null, error: conflict }
                    : { data: inserted, error: null },
                ).then(resolve);
              },
            };
          },
          then(resolve: (v: unknown) => unknown) {
            return Promise.resolve(
              conflict
                ? { data: null, error: conflict }
                : { data: inserted, error: null },
            ).then(resolve);
          },
        };
        return tail;
      },
      update(patch: Row) {
        const filters: Array<(r: Row) => boolean> = [];
        const apply = () => {
          const matched = rows().filter((r) => filters.every((f) => f(r)));
          for (const r of matched) Object.assign(r, patch);
          return matched;
        };
        const upd: Record<string, unknown> = {
          eq(f: string, v: unknown) {
            filters.push((r) => r[f] === v);
            return upd;
          },
          select(_cols?: string) {
            return {
              then(resolve: (v: unknown) => unknown) {
                return Promise.resolve({ data: apply(), error: null }).then(
                  resolve,
                );
              },
            };
          },
          then(resolve: (v: unknown) => unknown) {
            return Promise.resolve({ data: apply(), error: null }).then(
              resolve,
            );
          },
        };
        return upd;
      },
    };
  }
  return { from } as unknown as SupabaseClient;
}

/* ─── Fixture seeding ────────────────────────────────────────────────── */

const ORG = "org-stress-1";

const ACTOR: PostingActor = {
  staffId: "staff-1",
  userId: "user-1",
  role: "biller",
  source: "test",
};

function uuid(i: number, kind: string) {
  // Deterministic — not RFC-strict but the helper doesn't validate UUIDs.
  return `${kind}-${String(i).padStart(8, "0")}`;
}

interface Seeded {
  db: FakeDB;
  targets: BulkReprocessTarget[];
  totalEra: number;
  totalManual: number;
}

function seedFixture(eraCount: number, manualCount: number): Seeded {
  const db: FakeDB = { tables: {}, nextId: 0 };
  const targets: BulkReprocessTarget[] = [];
  const era: Row[] = (db.tables.era_claim_payments = []);
  const manual: Row[] = (db.tables.insurance_manual_payments = []);
  const claims: Row[] = (db.tables.professional_claims = []);

  for (let i = 0; i < eraCount; i++) {
    // Cycle through a mix of scenarios:
    //   0 — matched, denied (zero pay + CO denial CARC)
    //   1 — matched, underpayment-ish (paid < threshold × allowed)
    //   2 — matched, normal (no rule fires)
    //   3 — unmatched (only era_unmatched_claim rule fires)
    const scenario = i % 4;
    const claimId = uuid(i, "pc");
    if (scenario !== 3) {
      claims.push({
        id: claimId,
        organization_id: ORG,
        patient_id: uuid(i, "pt"),
        payer_profile_id: uuid(i % 3, "payer"),
      });
    }
    const isMatched = scenario !== 3;
    const isDenied = scenario === 0;
    const isUnderpay = scenario === 1;
    era.push({
      id: uuid(i, "era"),
      organization_id: ORG,
      professional_claim_id: isMatched ? claimId : null,
      client_id: isMatched ? uuid(i, "pt") : null,
      claim_match_status: isMatched ? "matched" : "unmatched",
      clp01_claim_control_number: `CLM-${i}`,
      clp03_total_charge: 200,
      clp04_payment_amount: isDenied ? 0 : isUnderpay ? 100 : 180,
      cas_adjustments: isDenied
        ? [{ groupCode: "CO", reasonCode: "29", amount: 200 }]
        : isUnderpay
          ? [{ groupCode: "CO", reasonCode: "45", amount: 20 }]
          : [{ groupCode: "CO", reasonCode: "45", amount: 20 }],
      archived_at: null,
    });
    targets.push({ kind: "era_835", id: uuid(i, "era") });
  }

  for (let i = 0; i < manualCount; i++) {
    // Half denied (zero pay), half normal.
    const denied = i % 2 === 0;
    const claimId = uuid(i + 100000, "pc");
    claims.push({
      id: claimId,
      organization_id: ORG,
      patient_id: uuid(i + 100000, "pt"),
      payer_profile_id: uuid(i % 3, "payer"),
    });
    manual.push({
      id: uuid(i, "mi"),
      organization_id: ORG,
      claim_id: claimId,
      client_id: uuid(i + 100000, "pt"),
      paid_amount: denied ? 0 : 150,
      allowed_amount: 150,
      adjustment_amount: 0,
      payer_profile_id: uuid(i % 3, "payer"),
      archived_at: null,
    });
    targets.push({ kind: "insurance_manual", id: uuid(i, "mi") });
  }

  db.tables.workqueue_items = [];
  db.tables.audit_logs = [];
  db.tables.organization_settings = [];
  db.tables.eligibility_coverages = [];

  return { db, targets, totalEra: eraCount, totalManual: manualCount };
}

/* ─── The stress test ───────────────────────────────────────────────── */

test("bulk reprocess processes ~100 mixed targets end-to-end", async () => {
  const { db, targets } = seedFixture(60, 40);
  assert.equal(targets.length, 100);
  const supabase = makeFakeSupabase(db);

  const matchCalls: string[] = [];
  const deps = {
    async matchClaim() {
      matchCalls.push("called");
      // Unmatched fixtures stay unmatched so the era_unmatched_claim
      // rule still fires (which is the production behaviour when no
      // claim exists yet).
      return null;
    },
  };

  const t0 = Date.now();
  const summary = await reprocessBulkTargets({
    supabase,
    organizationId: ORG,
    actor: ACTOR,
    targets,
    deps,
  });
  const elapsedMs = Date.now() - t0;

  // ── Per-target accounting ────────────────────────────────────────
  assert.equal(
    summary.reprocessed + summary.errors.length,
    targets.length,
    "every target must be counted as either reprocessed or errored",
  );
  // With well-formed fixtures the loop should not throw on any row.
  assert.equal(summary.errors.length, 0, `unexpected errors: ${JSON.stringify(summary.errors)}`);
  assert.equal(summary.reprocessed, 100);

  // Unmatched ERA rows should have triggered matchClaim attempts.
  // (60 ERA rows, 15 unmatched at scenario%4===3 → matchClaim called 15×.)
  assert.equal(matchCalls.length, 15);

  // Rules must have fired at least once — otherwise the dedupe assertion
  // below would be a no-op and we wouldn't actually be exercising the
  // partial unique index.
  assert.ok(
    summary.itemsCreated > 0,
    "expected at least some workqueue items to be emitted by rule engine",
  );

  // ── Audit invariant ──────────────────────────────────────────────
  const audits = db.tables.audit_logs ?? [];
  const bulkAudits = audits.filter(
    (a) =>
      (a.event_metadata as { source?: string } | null)?.source ===
      "bulk_reprocess",
  );
  assert.equal(
    bulkAudits.length,
    summary.reprocessed,
    "one bulk_reprocess audit row per successful target",
  );
  // Workqueue rule emissions ALSO write audits, but tagged source=workqueue_rule.
  const ruleAudits = audits.filter(
    (a) =>
      (a.event_metadata as { source?: string } | null)?.source ===
      "workqueue_rule",
  );
  assert.equal(
    ruleAudits.length,
    summary.itemsCreated,
    "one workqueue_rule audit row per emitted item",
  );

  // ── Wall-clock budget (regression signal) ────────────────────────
  // The fake DB is in-memory so this should run in well under a second.
  // The bound is intentionally generous (30s) so CI flake doesn't fail
  // the build, but the actual duration is logged for trend tracking.
  // eslint-disable-next-line no-console
  console.log(
    `[bulkReprocessStress] reprocessed ${summary.reprocessed} targets, ` +
      `emitted ${summary.itemsCreated} workqueue items in ${elapsedMs}ms`,
  );
  assert.ok(
    elapsedMs < 30_000,
    `bulk reprocess of 100 targets took ${elapsedMs}ms — investigate engine perf`,
  );

  // ── Dedupe: second pass should create zero new workqueue items ───
  const before = (db.tables.workqueue_items ?? []).length;
  const auditsBefore = (db.tables.audit_logs ?? []).length;
  const summary2 = await reprocessBulkTargets({
    supabase,
    organizationId: ORG,
    actor: ACTOR,
    targets,
    deps,
  });
  const after = (db.tables.workqueue_items ?? []).length;
  assert.equal(
    summary2.itemsCreated,
    0,
    "partial unique index must prevent duplicate workqueue items on replay",
  );
  assert.equal(
    after,
    before,
    "no new workqueue rows must land in the table on the second reprocess",
  );
  // Bulk-reprocess audit rows DO accumulate (every successful target
  // still writes its own per-target audit row), but no NEW workqueue_rule
  // audits because no new items were emitted.
  const auditsAfter = (db.tables.audit_logs ?? []).length;
  assert.equal(
    auditsAfter - auditsBefore,
    summary2.reprocessed,
    "second reprocess adds exactly one bulk_reprocess audit per target and zero rule audits",
  );
});

test("bulk reprocess surfaces per-target errors instead of failing the batch", async () => {
  // Seed a small set, then make the era_claim_payments fetch throw for
  // one specific id (simulating a transient postgrest failure on the
  // initial row read). The route must catch the failure, record it in
  // summary.errors, and keep processing the remaining targets.
  //
  // Note: per-emission failures *inside* applyWorkqueueRules (e.g. a
  // workqueue_items insert throwing) are also surfaced now — see the
  // separate "surfaces workqueue rule errors" test below. Here we
  // poison the outer row-fetch path to cover the try/catch route.
  const { db, targets } = seedFixture(5, 0);
  const supabase = makeFakeSupabase(db);

  const poisonedId = targets[2].id;
  // Cast through unknown — we built makeFakeSupabase as a SupabaseClient
  // for the caller's signature, but here we're surgically swapping out
  // one chain method, which the strict postgrest types don't model.
  type AnyChain = Record<string, (...args: unknown[]) => unknown>;
  const fake = supabase as unknown as {
    from: (t: string) => Record<string, (...args: unknown[]) => AnyChain>;
  };
  const originalFrom = fake.from.bind(fake);
  fake.from = (table: string) => {
    const tbl = originalFrom(table);
    if (table !== "era_claim_payments") return tbl;
    const realSelect = tbl.select.bind(tbl);
    tbl.select = ((cols?: string) => {
      const q = realSelect(cols as unknown) as AnyChain;
      let targetingPoisoned = false;
      const realEq = (q.eq as (f: string, v: unknown) => AnyChain).bind(q);
      q.eq = ((f: string, v: unknown) => {
        if (f === "id" && v === poisonedId) targetingPoisoned = true;
        return realEq(f, v);
      }) as (...args: unknown[]) => AnyChain;
      const realMaybeSingle = (q.maybeSingle as () => Promise<unknown>).bind(q);
      q.maybeSingle = (async () => {
        if (targetingPoisoned) throw new Error("simulated DB outage");
        return realMaybeSingle();
      }) as unknown as (...args: unknown[]) => unknown;
      return q;
    }) as (...args: unknown[]) => AnyChain;
    return tbl;
  };

  const summary = await reprocessBulkTargets({
    supabase,
    organizationId: ORG,
    actor: ACTOR,
    targets,
    deps: { async matchClaim() { return null; } },
  });

  assert.equal(
    summary.reprocessed + summary.errors.length,
    targets.length,
    "every target accounted for even when one row errors",
  );
  assert.equal(summary.reprocessed, targets.length - 1);
  assert.ok(
    summary.errors.some((e) => e.id.endsWith(poisonedId)),
    `poisoned target must appear in summary.errors: ${JSON.stringify(summary.errors)}`,
  );
});

test("bulk reprocess surfaces workqueue rule errors (Task #157)", async () => {
  // Regression for Task #157: failures inside applyWorkqueueRules (e.g.
  // workqueue_items insert throwing) used to be swallowed into the rule
  // engine's own result.errors and dropped on the floor. A biller could
  // see "N reprocessed, 0 errors" while individual emissions silently
  // failed to insert. The summary must now bubble those errors back out
  // tagged with the originating target and rule.
  const { db, targets } = seedFixture(3, 0);
  const supabase = makeFakeSupabase(db);

  // Poison every workqueue_items insert so each emission lands in the
  // rule engine's per-emission error path (not the outer try/catch).
  type AnyChain = Record<string, (...args: unknown[]) => unknown>;
  const fake = supabase as unknown as {
    from: (t: string) => Record<string, (...args: unknown[]) => AnyChain>;
  };
  const originalFrom = fake.from.bind(fake);
  fake.from = (table: string) => {
    const tbl = originalFrom(table);
    if (table !== "workqueue_items") return tbl;
    tbl.insert = ((_payload: unknown) => {
      const chain: AnyChain = {
        select: () => ({
          single: async () => {
            throw new Error("simulated workqueue insert outage");
          },
        }),
        then: (_resolve: (v: unknown) => unknown) => {
          throw new Error("simulated workqueue insert outage");
        },
      } as unknown as AnyChain;
      return chain;
    }) as (...args: unknown[]) => AnyChain;
    return tbl;
  };

  const summary = await reprocessBulkTargets({
    supabase,
    organizationId: ORG,
    actor: ACTOR,
    targets,
    deps: { async matchClaim() { return null; } },
  });

  // Outer loop still completes every target — rule failures don't blow
  // up the per-target try/catch.
  assert.equal(summary.reprocessed, targets.length);
  assert.equal(summary.itemsCreated, 0, "no items should have been created");
  assert.ok(
    summary.errors.length > 0,
    "rule-engine insert failures must surface in summary.errors",
  );
  assert.ok(
    summary.errors.every((e) => e.id.includes(":rule:")),
    `every surfaced error should be tagged as a rule error: ${JSON.stringify(summary.errors)}`,
  );
  assert.ok(
    summary.errors.every((e) =>
      e.message.includes("simulated workqueue insert outage"),
    ),
    "rule error messages must carry the underlying cause",
  );
});
