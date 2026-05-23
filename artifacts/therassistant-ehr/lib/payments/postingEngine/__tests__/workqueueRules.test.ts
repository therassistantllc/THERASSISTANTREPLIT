/**
 * Tests for workqueueRules — Task #111 / PP-5.
 *
 * The rule engine has two layers:
 *   - computeBaseEmissions(ctx) — pure; no DB
 *   - applyWorkqueueRules(supabase, ctx) — DB-touching dedupe + insert + audit
 *
 * Pure-rule tests cover every spec rule individually + the dedupe contract.
 * The applier is exercised via a fake supabase to confirm dedupe + audit.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  computeBaseEmissions,
  applyWorkqueueRules,
  runNoResponseAgingScan,
  type ApplyWorkqueueRulesContext,
} from "../workqueueRules";
import type { PostingActor } from "../types";

const ORG = "org-1";
const ACTOR: PostingActor = {
  staffId: "staff-1",
  userId: "user-1",
  role: "biller",
  source: "test",
};

function baseCtx(overrides: Partial<ApplyWorkqueueRulesContext> = {}): ApplyWorkqueueRulesContext {
  return {
    organizationId: ORG,
    sourceObjectType: "era_claim_payment",
    sourceObjectId: "src-1",
    professionalClaimId: "claim-1",
    clientId: "client-1",
    insurancePaymentAmount: 100,
    allowedAmount: 100,
    totalChargeAmount: 150,
    casAdjustments: [],
    claimMatchStatus: "matched",
    sourceKind: "era_835",
    actor: ACTOR,
    ...overrides,
  };
}

// ── computeBaseEmissions ────────────────────────────────────────────────────

describe("computeBaseEmissions", () => {
  it("emits era_unmatched_claim when ERA is not matched (and skips other rules)", () => {
    const emissions = computeBaseEmissions(
      baseCtx({ claimMatchStatus: "unmatched", insurancePaymentAmount: 0 }),
    );
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].ruleKind, "era_unmatched_claim");
    assert.equal(emissions[0].workType, "era_unmatched_claim");
    assert.equal(emissions[0].priority, "high");
  });

  it("emits denied when insurance_payment is 0 (full zero-pay)", () => {
    const emissions = computeBaseEmissions(baseCtx({ insurancePaymentAmount: 0 }));
    const denial = emissions.find((e) => e.ruleKind === "denied");
    assert.ok(denial, "denial rule must fire on zero-pay");
    assert.match(denial!.title, /zero payment/i);
  });

  it("emits denied when a denial-class CARC is present even with payment > 0", () => {
    const emissions = computeBaseEmissions(
      baseCtx({
        insurancePaymentAmount: 50,
        casAdjustments: [{ groupCode: "CO", reasonCode: "29", amount: 100 }],
      }),
    );
    const denial = emissions.find((e) => e.ruleKind === "denied");
    assert.ok(denial);
    assert.match(denial!.title, /CARC 29/);
  });

  it("emits appeal_needed for appealable CARC codes", () => {
    const emissions = computeBaseEmissions(
      baseCtx({
        casAdjustments: [{ groupCode: "CO", reasonCode: "197", amount: 50 }],
      }),
    );
    assert.ok(emissions.find((e) => e.ruleKind === "appeal_needed"));
  });

  it("emits underpayment when paid/allowed < threshold", () => {
    const emissions = computeBaseEmissions(
      baseCtx({
        insurancePaymentAmount: 50,
        allowedAmount: 100,
        underpaymentThresholdPct: 0.8,
      }),
    );
    const up = emissions.find((e) => e.ruleKind === "underpayment");
    assert.ok(up, "underpayment must fire at 50% of allowed (below 80%)");
    assert.match(up!.title, /50%/);
  });

  it("does NOT emit underpayment when paid >= threshold × allowed", () => {
    const emissions = computeBaseEmissions(
      baseCtx({
        insurancePaymentAmount: 85,
        allowedAmount: 100,
        underpaymentThresholdPct: 0.8,
      }),
    );
    assert.equal(emissions.find((e) => e.ruleKind === "underpayment"), undefined);
  });

  it("emits recoupment for sourceKind='recoupment'", () => {
    const emissions = computeBaseEmissions(baseCtx({ sourceKind: "recoupment" }));
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].ruleKind, "recoupment");
  });

  it("emits refund for sourceKind='refund'", () => {
    const emissions = computeBaseEmissions(baseCtx({ sourceKind: "refund" }));
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].ruleKind, "refund");
    assert.equal(emissions[0].workType, "refund_review");
  });

  it("does not double-emit denial when both zero-pay and denial-CARC present", () => {
    const emissions = computeBaseEmissions(
      baseCtx({
        insurancePaymentAmount: 0,
        casAdjustments: [{ groupCode: "CO", reasonCode: "29", amount: 150 }],
      }),
    );
    assert.equal(
      emissions.filter((e) => e.ruleKind === "denied").length,
      1,
      "only one denial item even when both signals are present",
    );
  });
});

// ── applyWorkqueueRules (DB-touching, with fake supabase) ───────────────────

interface FakeRow extends Record<string, unknown> {
  id: string;
}

function makeFake(
  seed: {
    workqueue_items?: FakeRow[];
    professional_claims?: FakeRow[];
    eligibility_coverages?: FakeRow[];
  } = {},
) {
  const tables: Record<string, FakeRow[]> = {
    workqueue_items: seed.workqueue_items ?? [],
    audit_logs: [],
    organization_settings: [],
    professional_claims: seed.professional_claims ?? [],
    eligibility_coverages: seed.eligibility_coverages ?? [],
  };

  function makeQuery(table: string) {
    const state: {
      eqs: Array<[string, unknown]>;
      ins: Array<[string, unknown[]]>;
      neqs: Array<[string, unknown]>;
      iss: Array<[string, unknown]>;
      ltes: Array<[string, unknown]>;
      gtes: Array<[string, unknown]>;
      limit: number | null;
      single: boolean;
      maybeSingle: boolean;
    } = {
      eqs: [],
      ins: [],
      neqs: [],
      iss: [],
      ltes: [],
      gtes: [],
      limit: null,
      single: false,
      maybeSingle: false,
    };

    const exec = async () => {
      const rows = tables[table] ?? [];
      const filtered = rows.filter((r) => {
        for (const [c, v] of state.eqs) if (r[c] !== v) return false;
        for (const [c, v] of state.neqs) if (r[c] === v) return false;
        for (const [c, vs] of state.ins) if (!vs.includes(r[c])) return false;
        for (const [c] of state.iss) if (r[c] != null) return false;
        for (const [c, v] of state.ltes) if (!(r[c] != null && String(r[c]) <= String(v))) return false;
        for (const [c, v] of state.gtes) if (!(r[c] != null && String(r[c]) >= String(v))) return false;
        return true;
      });
      const limited = state.limit ? filtered.slice(0, state.limit) : filtered;
      if (state.single || state.maybeSingle) {
        return { data: limited[0] ?? null, error: null };
      }
      return { data: limited, error: null };
    };

    const builder: Record<string, unknown> = {};
    builder.eq = (c: string, v: unknown) => {
      state.eqs.push([c, v]);
      return builder;
    };
    builder.neq = (c: string, v: unknown) => {
      state.neqs.push([c, v]);
      return builder;
    };
    builder.in = (c: string, vs: unknown[]) => {
      state.ins.push([c, vs]);
      return builder;
    };
    builder.is = (c: string, v: unknown) => {
      state.iss.push([c, v]);
      return builder;
    };
    builder.lte = (c: string, v: unknown) => {
      state.ltes.push([c, v]);
      return builder;
    };
    builder.gte = (c: string, v: unknown) => {
      state.gtes.push([c, v]);
      return builder;
    };
    builder.limit = (n: number) => {
      state.limit = n;
      return builder;
    };
    builder.maybeSingle = () => {
      state.maybeSingle = true;
      return exec();
    };
    builder.single = () => {
      state.single = true;
      return exec();
    };
    builder.select = () => builder;
    builder.order = () => builder;
    builder.then = (cb: (r: unknown) => unknown) => exec().then(cb);
    return builder;
  }

  const insertOn = (table: string, payload: Record<string, unknown> | Record<string, unknown>[]) => {
    const list = Array.isArray(payload) ? payload : [payload];
    const rows = list.map((p, i) => ({ ...p, id: p.id ?? `${table}-${tables[table].length + i + 1}` }));
    tables[table].push(...(rows as FakeRow[]));
    return {
      select: () => ({
        single: async () => ({ data: rows[0], error: null }),
      }),
    };
  };

  const updateOn = (table: string, patch: Record<string, unknown>) => {
    const state: { eqs: Array<[string, unknown]> } = { eqs: [] };
    const builder: Record<string, unknown> = {};
    builder.eq = (c: string, v: unknown) => {
      state.eqs.push([c, v]);
      return builder;
    };
    builder.then = (cb: (r: unknown) => unknown) => {
      const rows = tables[table];
      for (const r of rows) {
        if (state.eqs.every(([c, v]) => r[c] === v)) Object.assign(r, patch);
      }
      return Promise.resolve({ error: null }).then(cb);
    };
    return builder;
  };

  const client = {
    from: (table: string) => ({
      select: () => makeQuery(table),
      insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => insertOn(table, payload),
      update: (patch: Record<string, unknown>) => updateOn(table, patch),
    }),
  };
  return { client: client as never, tables };
}

describe("applyWorkqueueRules", () => {
  it("inserts a workqueue_items row + audit row for each emission", async () => {
    const fake = makeFake();
    const r = await applyWorkqueueRules(fake.client, baseCtx({
      insurancePaymentAmount: 0, // triggers denial
    }));
    assert.equal(r.itemsCreated, 1);
    assert.equal(fake.tables.workqueue_items.length, 1);
    assert.equal(fake.tables.workqueue_items[0].work_type, "denied");
    assert.equal(fake.tables.workqueue_items[0].source_object_id, "src-1");
    assert.ok(fake.tables.audit_logs.length >= 1, "audit row written for each item");
  });

  it("dedupes against existing open items on the same source+work_type", async () => {
    const fake = makeFake({
      workqueue_items: [
        {
          id: "existing-1",
          organization_id: ORG,
          source_object_id: "src-1",
          work_type: "denied",
          status: "open",
          archived_at: null,
        },
      ],
    });
    const r = await applyWorkqueueRules(fake.client, baseCtx({ insurancePaymentAmount: 0 }));
    assert.equal(r.itemsCreated, 0);
    assert.equal(fake.tables.workqueue_items.length, 1, "no new row added when one is open");
  });

  it("creates a recoupment item when sourceKind='recoupment' regardless of payment fields", async () => {
    const fake = makeFake();
    const r = await applyWorkqueueRules(
      fake.client,
      baseCtx({ sourceKind: "recoupment", sourceObjectType: "payment_recoupment" }),
    );
    assert.equal(r.itemsCreated, 1);
    assert.equal(fake.tables.workqueue_items[0].work_type, "recoupment");
  });
});

describe("runNoResponseAgingScan", () => {
  it("creates one no_response item per aged claim and dedupes on re-run", async () => {
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const freshDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const fake = makeFake({
      professional_claims: [
        {
          id: "claim-aged-1",
          organization_id: ORG,
          client_id: "client-1",
          submitted_at: oldDate,
          claim_status: "submitted",
          archived_at: null,
        },
        {
          id: "claim-aged-2",
          organization_id: ORG,
          client_id: "client-2",
          submitted_at: oldDate,
          claim_status: "accepted",
          archived_at: null,
        },
        {
          id: "claim-fresh",
          organization_id: ORG,
          client_id: "client-3",
          submitted_at: freshDate,
          claim_status: "submitted",
          archived_at: null,
        },
      ],
    });

    const first = await runNoResponseAgingScan(fake.client, {
      organizationId: ORG,
      actor: ACTOR,
      noResponseDays: 30,
    });
    assert.equal(first.itemsCreated, 2, "two aged claims should produce two items");
    assert.equal(fake.tables.workqueue_items.length, 2);
    assert.ok(
      fake.tables.workqueue_items.every((r) => r.work_type === "no_response"),
      "all emissions are no_response",
    );

    // Second run must be a no-op (dedupe against existing open items).
    const second = await runNoResponseAgingScan(fake.client, {
      organizationId: ORG,
      actor: ACTOR,
      noResponseDays: 30,
    });
    assert.equal(second.itemsCreated, 0, "rerun must dedupe via existingOpenItem");
    assert.equal(fake.tables.workqueue_items.length, 2);
  });
});
