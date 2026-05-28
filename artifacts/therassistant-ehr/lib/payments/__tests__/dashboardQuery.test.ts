/**
 * Tests for queryPaymentsDashboard — Task #111 / PP-5.
 *
 * Exercises filter routing (paymentSource list, paymentType discriminator)
 * and the row merge/sort contract using a minimal fake supabase that only
 * needs to support .from(table).select().eq().is().order().limit() chain
 * plus .head:true count queries.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { queryPaymentsDashboard } from "../dashboardQuery";

const ORG = "org-1";

function makeFakeSupabase(seed: Record<string, Array<Record<string, unknown>>>) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    era_claim_payments: seed.era_claim_payments ?? [],
    insurance_manual_payments: seed.insurance_manual_payments ?? [],
    client_payments: seed.client_payments ?? [],
    payment_recoupments: seed.payment_recoupments ?? [],
    payment_refunds: seed.payment_refunds ?? [],
    workqueue_items: seed.workqueue_items ?? [],
    professional_claims: seed.professional_claims ?? [],
  };

  function makeQuery(table: string) {
    const state: {
      eqs: Array<[string, unknown]>;
      ins: Array<[string, unknown[]]>;
      iss: Array<[string, unknown]>;
      gtes: Array<[string, unknown]>;
      ltes: Array<[string, unknown]>;
      ilikes: Array<[string, string]>;
      limit: number | null;
      countMode: boolean;
    } = { eqs: [], ins: [], iss: [], gtes: [], ltes: [], ilikes: [], limit: null, countMode: false };

    const exec = async () => {
      const rows = tables[table] ?? [];
      const filtered = rows.filter((r) => {
        for (const [c, v] of state.eqs) if (r[c] !== v) return false;
        for (const [c, vs] of state.ins) if (!vs.includes(r[c])) return false;
        for (const [c] of state.iss) if (r[c] != null) return false;
        for (const [c, v] of state.gtes) if ((r[c] ?? "") < (v as string)) return false;
        for (const [c, v] of state.ltes) if ((r[c] ?? "") > (v as string)) return false;
        for (const [c, v] of state.ilikes) {
          const cell = String(r[c] ?? "").toLowerCase();
          const needle = v.replace(/%/g, "").toLowerCase();
          if (!cell.includes(needle)) return false;
        }
        return true;
      });
      const limited = state.limit ? filtered.slice(0, state.limit) : filtered;
      if (state.countMode) {
        return { data: null, count: filtered.length, error: null };
      }
      return { data: limited, count: filtered.length, error: null };
    };

    const builder: Record<string, unknown> = {};
    builder.eq = (c: string, v: unknown) => { state.eqs.push([c, v]); return builder; };
    builder.in = (c: string, vs: unknown[]) => { state.ins.push([c, vs]); return builder; };
    builder.is = (c: string, v: unknown) => { state.iss.push([c, v]); return builder; };
    builder.gte = (c: string, v: unknown) => { state.gtes.push([c, v]); return builder; };
    builder.lte = (c: string, v: unknown) => { state.ltes.push([c, v]); return builder; };
    builder.ilike = (c: string, v: string) => { state.ilikes.push([c, v]); return builder; };
    builder.order = () => builder;
    builder.limit = (n: number) => { state.limit = n; return builder; };
    builder.neq = () => builder;
    builder.maybeSingle = () => exec().then((r) => ({ data: r.data && (r.data as unknown[])[0] ? (r.data as unknown[])[0] : null, error: null }));
    builder.select = (_cols: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.count === "exact") state.countMode = true;
      return builder;
    };
    builder.then = (cb: (r: unknown) => unknown) => exec().then(cb);
    return builder;
  }

  const client = {
    from: (table: string) => ({
      select: (cols: string, opts?: { count?: string; head?: boolean }) => {
        const q = makeQuery(table);
        return (q.select as (c: string, o?: unknown) => unknown)(cols, opts);
      },
    }),
  };
  return { client: client as never, tables };
}

describe("queryPaymentsDashboard", () => {
  it("merges rows from all three sources and sorts by date desc", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "e1",
          organization_id: ORG,
          posting_status: "posted",
          claim_match_status: "matched",
          clp04_payment_amount: 100,
          created_at: "2026-05-01T00:00:00Z",
          archived_at: null,
        },
      ],
      insurance_manual_payments: [
        {
          id: "m1",
          organization_id: ORG,
          paid_amount: 50,
          posted_at: "2026-05-10T00:00:00Z",
          archived_at: null,
        },
      ],
      client_payments: [
        {
          id: "c1",
          organization_id: ORG,
          amount: 25,
          payment_method: "stripe",
          posted_at: "2026-05-20T00:00:00Z",
          archived_at: null,
        },
      ],
    });

    const r = await queryPaymentsDashboard(fake.client, { organizationId: ORG });
    assert.equal(r.rows.length, 3);
    assert.equal(r.rows[0].id, "cp:c1", "most recent sorts first");
    assert.equal(r.rows[1].id, "mi:m1");
    assert.equal(r.rows[2].id, "era:e1");
  });

  it("paymentType='client' filters out insurance rows", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "e1",
          organization_id: ORG,
          posting_status: "posted",
          claim_match_status: "matched",
          clp04_payment_amount: 100,
          created_at: "2026-05-01T00:00:00Z",
          archived_at: null,
        },
      ],
      client_payments: [
        {
          id: "c1",
          organization_id: ORG,
          amount: 25,
          payment_method: "cash",
          posted_at: "2026-05-20T00:00:00Z",
          archived_at: null,
        },
      ],
    });
    const r = await queryPaymentsDashboard(fake.client, {
      organizationId: ORG,
      paymentType: "client",
    });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].source, "client");
  });

  it("paymentSource list restricts rows to listed sources", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "e1",
          organization_id: ORG,
          posting_status: "posted",
          claim_match_status: "matched",
          clp04_payment_amount: 100,
          created_at: "2026-05-01T00:00:00Z",
          archived_at: null,
        },
      ],
      insurance_manual_payments: [
        {
          id: "m1",
          organization_id: ORG,
          paid_amount: 50,
          posted_at: "2026-05-10T00:00:00Z",
          archived_at: null,
        },
      ],
    });
    const r = await queryPaymentsDashboard(fake.client, {
      organizationId: ORG,
      paymentSource: ["manual_insurance"],
    });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].source, "manual_insurance");
  });

  it("totals include posted count from rows + count(*) for cross-source figures", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "e1",
          organization_id: ORG,
          posting_status: "posted",
          claim_match_status: "matched",
          clp04_payment_amount: 100,
          created_at: "2026-05-01T00:00:00Z",
          archived_at: null,
        },
        {
          id: "e2",
          organization_id: ORG,
          posting_status: "ready",
          claim_match_status: "unmatched",
          clp04_payment_amount: 0,
          created_at: "2026-05-02T00:00:00Z",
          archived_at: null,
        },
      ],
    });
    const r = await queryPaymentsDashboard(fake.client, { organizationId: ORG });
    assert.equal(r.totals.imported, 2);
    assert.equal(r.totals.posted, 1);
    assert.equal(r.totals.unmatched, 1);
  });
});
