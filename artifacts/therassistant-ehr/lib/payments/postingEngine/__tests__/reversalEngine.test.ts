/**
 * Tests for the reversal/void/recoupment/refund engine (Task #110).
 *
 * Validators are exercised directly. Commit paths are exercised against an
 * in-memory fake of the supabase admin client so we can verify ordering,
 * payload shape, and the cross-state invariants (amount caps, status
 * transitions) without needing a live database.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  reversePostedPayment,
  voidPostedPayment,
  recordRecoupment,
  recordInsuranceRefund,
  recordPatientRefund,
  confirmInsuranceRefund,
  validateReversalRequest,
  validateRefundAmount,
} from "../reversal";
import type { PostingActor } from "../types";

const ORG = "org-1";
const ACTOR: PostingActor = {
  staffId: "staff-1",
  userId: "user-1",
  role: "biller",
  source: "test",
};

/** Lightweight in-memory fake that mimics the subset of supabase-js we use. */
function makeFakeSupabase(initial: {
  era_claim_payments?: Array<Record<string, unknown>>;
  client_payments?: Array<Record<string, unknown>>;
  insurance_manual_payments?: Array<Record<string, unknown>>;
  era_posting_ledger_entries?: Array<Record<string, unknown>>;
  payment_refunds?: Array<Record<string, unknown>>;
  payment_recoupments?: Array<Record<string, unknown>>;
  patient_invoices?: Array<Record<string, unknown>>;
  professional_claims?: Array<Record<string, unknown>>;
  workqueue_items?: Array<Record<string, unknown>>;
  audit_logs?: Array<Record<string, unknown>>;
} = {}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    era_claim_payments: initial.era_claim_payments ?? [],
    client_payments: initial.client_payments ?? [],
    insurance_manual_payments: initial.insurance_manual_payments ?? [],
    era_posting_ledger_entries: initial.era_posting_ledger_entries ?? [],
    payment_refunds: initial.payment_refunds ?? [],
    payment_recoupments: initial.payment_recoupments ?? [],
    patient_invoices: initial.patient_invoices ?? [],
    professional_claims: initial.professional_claims ?? [],
    workqueue_items: initial.workqueue_items ?? [],
    audit_logs: initial.audit_logs ?? [],
  };

  function matchAll(rows: Array<Record<string, unknown>>, filters: Array<[string, unknown]>) {
    return rows.filter((r) =>
      filters.every(([k, v]) => {
        if (v === null) return r[k] === null || r[k] === undefined;
        return r[k] === v;
      }),
    );
  }
  function matchNullChecks(rows: Array<Record<string, unknown>>, isNull: string[]) {
    return rows.filter((r) => isNull.every((k) => r[k] === null || r[k] === undefined));
  }
  function matchIn(rows: Array<Record<string, unknown>>, k: string, vals: unknown[]) {
    return rows.filter((r) => vals.includes(r[k]));
  }

  function builder(tableName: string) {
    const ctx: {
      filters: Array<[string, unknown]>;
      isNull: string[];
      inSpec: Array<[string, unknown[]]>;
      mode: "select" | "insert" | "update" | "count" | null;
      selectCols: string;
      insertPayload: Record<string, unknown> | Array<Record<string, unknown>> | null;
      updatePayload: Record<string, unknown> | null;
      orderSpec: { col: string; ascending: boolean } | null;
      limitN: number | null;
      single: boolean;
      maybe: boolean;
      headOnly: boolean;
      orFilter: string | null;
      neq?: Array<[string, unknown]>;
    } = {
      filters: [],
      isNull: [],
      inSpec: [],
      mode: null,
      selectCols: "*",
      insertPayload: null,
      updatePayload: null,
      orderSpec: null,
      limitN: null,
      single: false,
      maybe: false,
      headOnly: false,
      orFilter: null,
    };

    const exec = () => {
      const rows = tables[tableName] ?? [];
      let res = matchAll(rows, ctx.filters);
      if (ctx.isNull.length) res = matchNullChecks(res, ctx.isNull);
      for (const [k, vs] of ctx.inSpec) res = matchIn(res, k, vs);
      if (ctx.orFilter) {
        // simple or filter: "field.eq.value,field.eq.value"
        const parts = ctx.orFilter.split(",");
        res = rows.filter((r) =>
          parts.some((p) => {
            const m = p.match(/^(\w+)\.eq\.(.+)$/);
            if (!m) return false;
            return String(r[m[1]] ?? "") === m[2];
          }),
        );
        // re-apply filters/null checks on the or-result
        res = matchAll(res, ctx.filters);
        if (ctx.isNull.length) res = matchNullChecks(res, ctx.isNull);
      }
      if (ctx.orderSpec) {
        const { col, ascending } = ctx.orderSpec;
        res = [...res].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (ctx.limitN !== null) res = res.slice(0, ctx.limitN);
      return res;
    };

    const thenable = {
      then(onFul: (v: { data: unknown; error: null; count?: number }) => unknown) {
        if (ctx.mode === "select") {
          const res = exec();
          if (ctx.single) return Promise.resolve({ data: res[0] ?? null, error: null }).then(onFul);
          if (ctx.maybe) return Promise.resolve({ data: res[0] ?? null, error: null }).then(onFul);
          return Promise.resolve({ data: res, error: null }).then(onFul);
        }
        if (ctx.mode === "count") {
          const res = exec();
          return Promise.resolve({ data: null, error: null, count: res.length }).then(onFul);
        }
        if (ctx.mode === "insert") {
          const payloads = Array.isArray(ctx.insertPayload)
            ? ctx.insertPayload
            : ctx.insertPayload
              ? [ctx.insertPayload]
              : [];
          const inserted = payloads.map((p) => ({
            ...p,
            id: p.id ?? `${tableName}-${(tables[tableName].length + 1).toString().padStart(3, "0")}`,
          }));
          tables[tableName] = [...(tables[tableName] ?? []), ...inserted];
          const data = ctx.single
            ? inserted[0] ?? null
            : ctx.maybe
              ? inserted[0] ?? null
              : inserted;
          return Promise.resolve({ data, error: null }).then(onFul);
        }
        if (ctx.mode === "update") {
          const targets = exec();
          for (const row of targets) Object.assign(row, ctx.updatePayload);
          return Promise.resolve({ data: targets, error: null }).then(onFul);
        }
        return Promise.resolve({ data: null, error: null }).then(onFul);
      },
    };

    const chain: Record<string, unknown> = {
      select(cols: string, opts?: { count?: string; head?: boolean }) {
        ctx.selectCols = cols;
        if (opts?.count === "exact" && opts?.head) {
          ctx.mode = "count";
          ctx.headOnly = true;
        } else if (ctx.mode === null) {
          ctx.mode = "select";
        }
        return chain;
      },
      insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
        ctx.mode = "insert";
        ctx.insertPayload = payload;
        return chain;
      },
      update(payload: Record<string, unknown>) {
        ctx.mode = "update";
        ctx.updatePayload = payload;
        return chain;
      },
      eq(k: string, v: unknown) {
        ctx.filters.push([k, v]);
        return chain;
      },
      neq(k: string, v: unknown) {
        ctx.neq = ctx.neq || [];
        (ctx.neq as Array<[string, unknown]>).push([k, v]);
        return chain;
      },
      is(k: string, _v: unknown) {
        ctx.isNull.push(k);
        return chain;
      },
      in(k: string, vs: unknown[]) {
        ctx.inSpec.push([k, vs]);
        return chain;
      },
      or(spec: string) {
        ctx.orFilter = spec;
        return chain;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        ctx.orderSpec = { col, ascending: opts?.ascending ?? true };
        return chain;
      },
      limit(n: number) {
        ctx.limitN = n;
        return chain;
      },
      single() {
        ctx.single = true;
        return thenable;
      },
      maybeSingle() {
        ctx.maybe = true;
        return thenable;
      },
      then: thenable.then,
    };
    return chain;
  }

  return {
    tables,
    client: { from: (t: string) => builder(t) } as unknown as Parameters<typeof reversePostedPayment>[1],
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("validateReversalRequest", () => {
  it("requires a reason", () => {
    const r = validateReversalRequest({ postingStatus: "posted", reversedAt: null, voidedAt: null, reason: "" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "reason_required");
  });
  it("rejects already-reversed", () => {
    const r = validateReversalRequest({
      postingStatus: "reversed",
      reversedAt: "2026-05-23T00:00:00Z",
      voidedAt: null,
      reason: "duplicate",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "already_reversed");
  });
  it("rejects voided", () => {
    const r = validateReversalRequest({
      postingStatus: "voided",
      reversedAt: null,
      voidedAt: "2026-05-23T00:00:00Z",
      reason: "duplicate",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "already_voided");
  });
  it("rejects non-posted statuses", () => {
    const r = validateReversalRequest({
      postingStatus: "blocked",
      reversedAt: null,
      voidedAt: null,
      reason: "x",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "not_posted");
  });
  it("accepts a clean posted payment with reason", () => {
    const r = validateReversalRequest({
      postingStatus: "posted",
      reversedAt: null,
      voidedAt: null,
      reason: "duplicate ERA imported",
    });
    assert.equal(r.ok, true);
  });
});

describe("validateRefundAmount", () => {
  it("rejects zero/negative", () => {
    const r = validateRefundAmount(0, 100, 0, 0);
    assert.equal(r.ok, false);
    assert.equal(r.code, "amount_required");
  });
  it("rejects over-refund", () => {
    const r = validateRefundAmount(110, 100, 0, 0);
    assert.equal(r.ok, false);
    assert.equal(r.code, "amount_exceeds_balance");
    assert.equal(r.remaining, 100);
  });
  it("accounts for prior refunds + recoups", () => {
    const r = validateRefundAmount(20, 100, 60, 30);
    // remaining = 10, asked 20 → exceeds
    assert.equal(r.ok, false);
    assert.equal(r.remaining, 10);
  });
  it("accepts within remaining balance", () => {
    const r = validateRefundAmount(10, 100, 60, 30);
    assert.equal(r.ok, true);
    assert.equal(r.remaining, 10);
  });
});

describe("reversePostedPayment", () => {
  it("returns alreadyReversed when posting_status is already 'reversed'", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-1",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-1",
          clp01_claim_control_number: "PCN1",
          clp04_payment_amount: 100,
          posting_status: "reversed",
          reversed_at: "2026-05-22T00:00:00Z",
          voided_at: null,
          archived_at: null,
        },
      ],
    });
    const r = await reversePostedPayment(
      { organizationId: ORG, target: { kind: "era_835", id: "era-1" }, reason: "dupe", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, true);
    assert.equal(r.alreadyReversed, true);
    assert.equal(r.reversed, false);
  });

  it("refuses to reverse a voided payment", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-2",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-1",
          clp01_claim_control_number: "PCN2",
          clp04_payment_amount: 100,
          posting_status: "voided",
          reversed_at: null,
          voided_at: "2026-05-22T00:00:00Z",
          archived_at: null,
        },
      ],
    });
    const r = await reversePostedPayment(
      { organizationId: ORG, target: { kind: "era_835", id: "era-2" }, reason: "x", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].field, "posting_status");
  });

  it("reverses a posted ERA payment: writes negative ledger entries, flips status, audits", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-3",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-1",
          clp01_claim_control_number: "PCN3",
          clp04_payment_amount: 100,
          posting_status: "posted",
          reversed_at: null,
          voided_at: null,
          archived_at: null,
        },
      ],
      era_posting_ledger_entries: [
        {
          id: "le-1",
          organization_id: ORG,
          source_type: "era_835",
          source_id: "era-3",
          era_claim_payment_id: "era-3",
          professional_claim_id: "claim-1",
          client_id: "c-1",
          entry_type: "insurance_payment",
          amount: 100,
          group_code: null,
          reason_code: null,
          description: "Insurance payment",
          archived_at: null,
        },
        {
          id: "le-2",
          organization_id: ORG,
          source_type: "era_835",
          source_id: "era-3",
          era_claim_payment_id: "era-3",
          professional_claim_id: "claim-1",
          client_id: "c-1",
          entry_type: "contractual_adjustment",
          amount: 25,
          group_code: "CO",
          reason_code: "45",
          description: "CO contractual",
          archived_at: null,
        },
      ],
      professional_claims: [
        { id: "claim-1", organization_id: ORG, claim_status: "paid" },
      ],
    });
    const r = await reversePostedPayment(
      {
        organizationId: ORG,
        target: { kind: "era_835", id: "era-3" },
        reason: "duplicate ERA imported",
        actor: ACTOR,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.reversed, true);
    assert.equal(r.ledgerEntriesWritten, 2);

    // Original ledger rows untouched; two new reversal rows present, both negative.
    const reversalRows = fake.tables.era_posting_ledger_entries.filter(
      (r) => r.source_type === "reversal",
    );
    assert.equal(reversalRows.length, 2);
    for (const row of reversalRows) {
      assert.ok(Number(row.amount) < 0, "reversal row must be negative");
      assert.equal(row.source_id, "era-3");
    }

    // ERA row now has posting_status='reversed' with timestamp + reason.
    const era = fake.tables.era_claim_payments[0];
    assert.equal(era.posting_status, "reversed");
    assert.ok(era.reversed_at);
    assert.equal(era.reversal_reason, "duplicate ERA imported");

    // Claim restored to 'billed'.
    assert.equal(fake.tables.professional_claims[0].claim_status, "billed");

    // Audit row written.
    const auditRows = fake.tables.audit_logs.filter((a) => a.action === "payment_reversed");
    assert.equal(auditRows.length, 1);
  });
});

describe("reversePostedPayment — patient refund initiation (fail-closed)", () => {
  it("rolls the reversal back when the auto-refund insert fails", async () => {
    const fake = makeFakeSupabase({
      client_payments: [
        {
          id: "cp-fc-1",
          organization_id: ORG,
          client_id: "c-1",
          claim_id: null,
          amount: 75,
          payment_method: "stripe",
          stripe_charge_id: "ch_test_1",
          patient_invoice_id: null,
          posting_status: "posted",
          archived_at: null,
        },
      ],
    });
    // Force the payment_refunds insert to error to simulate a DB-side failure.
    const client = fake.client as { from: (t: string) => unknown };
    const origFrom = client.from.bind(client);
    client.from = ((t: string) => {
      const b = origFrom(t);
      if (t !== "payment_refunds") return b;
      const wrapped = b as unknown as { insert: (p: unknown) => unknown };
      const origInsert = wrapped.insert.bind(wrapped);
      wrapped.insert = (p: unknown) => {
        const chain = origInsert(p) as { single: () => Promise<unknown>; then: unknown; select: (c: string) => unknown };
        const failResult = { data: null, error: { message: "payment_refunds insert blocked by test" } };
        chain.single = async () => failResult;
        chain.select = () => ({
          single: async () => failResult,
          maybeSingle: async () => failResult,
          then: (cb: (v: unknown) => unknown) => Promise.resolve(failResult).then(cb),
        });
        return chain;
      };
      return b;
    }) as typeof origFrom;

    const r = await reversePostedPayment(
      { organizationId: ORG, target: { kind: "client_payment", id: "cp-fc-1" }, reason: "patient dispute", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, false, "reversal must fail when refund init fails");
    assert.ok(
      r.errors.some((e) => /Auto-refund initiation failed/.test(e.message)),
      "must surface auto-refund failure in errors",
    );
    // Header status must have been restored to 'posted' (compensating rollback).
    const cp = fake.tables.client_payments[0] as Record<string, unknown>;
    assert.equal(cp.posting_status, "posted", "posting_status must be restored after failed refund init");
    assert.equal(cp.reversed_at, null, "reversed_at must be cleared by restoreStatus()");
  });
});

describe("confirmInsuranceRefund (two-step issuance)", () => {
  it("flips pending→issued, posts compensating ledger row, and writes audit", async () => {
    const refundId = "11111111-1111-1111-1111-111111111111";
    const fake = makeFakeSupabase({
      payment_refunds: [
        {
          id: refundId,
          organization_id: ORG,
          refund_type: "insurance",
          amount: 25,
          refund_status: "pending",
          source_era_claim_payment_id: "era-conf-1",
          source_client_payment_id: null,
          source_insurance_manual_payment_id: null,
          professional_claim_id: "claim-conf-1",
          client_id: "c-1",
          archived_at: null,
        },
      ],
      professional_claims: [{ id: "claim-conf-1", organization_id: ORG, claim_status: "paid" }],
    });
    const r = await confirmInsuranceRefund(
      { organizationId: ORG, refundId, reason: "check #4823", externalReferenceNumber: "4823", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.refundStatus, "issued");
    const refundRow = fake.tables.payment_refunds[0] as Record<string, unknown>;
    assert.equal(refundRow.refund_status, "issued");
    assert.ok(refundRow.issued_at);
    // Compensating ledger entry posted.
    const led = fake.tables.era_posting_ledger_entries[0] as Record<string, unknown>;
    assert.equal(led.source_type, "refund");
    assert.equal(Number(led.amount), -25);
    assert.equal(led.source_id, refundId);
    // Claim restored to billed.
    assert.equal(
      (fake.tables.professional_claims[0] as Record<string, unknown>).claim_status,
      "billed",
    );
    // Audit log present.
    assert.equal(fake.tables.audit_logs.length, 1);
  });

  it("returns ok=false and does not flip status when refund row is not pending", async () => {
    const refundId = "22222222-2222-2222-2222-222222222222";
    const fake = makeFakeSupabase({
      payment_refunds: [
        {
          id: refundId,
          organization_id: ORG,
          refund_type: "insurance",
          amount: 25,
          refund_status: "issued",
          source_era_claim_payment_id: "era-conf-2",
          professional_claim_id: "claim-conf-2",
          client_id: "c-1",
          archived_at: null,
        },
      ],
    });
    const r = await confirmInsuranceRefund(
      { organizationId: ORG, refundId, reason: "dup", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /not found, already issued|already issued/i);
    // No ledger row posted.
    assert.equal(fake.tables.era_posting_ledger_entries.length, 0);
  });
});

describe("integration: reverse → ledger restoration → audit chain", () => {
  it("posts paired negative ledger rows, marks header reversed, and produces audit trail", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-int-1",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-int-1",
          clp01_claim_control_number: "PCN-INT",
          clp04_payment_amount: 200,
          posting_status: "posted",
          reversed_at: null,
          voided_at: null,
          archived_at: null,
        },
      ],
      era_posting_ledger_entries: [
        {
          id: "le-pos-1",
          organization_id: ORG,
          source_id: "era-int-1",
          source_type: "era_payment",
          entry_type: "payment",
          amount: 150,
          professional_claim_id: "claim-int-1",
          client_id: "c-1",
          archived_at: null,
        },
        {
          id: "le-pos-2",
          organization_id: ORG,
          source_id: "era-int-1",
          source_type: "era_payment",
          entry_type: "adjustment",
          amount: 50,
          professional_claim_id: "claim-int-1",
          client_id: "c-1",
          archived_at: null,
        },
      ],
      professional_claims: [{ id: "claim-int-1", organization_id: ORG, claim_status: "paid" }],
    });
    const r = await reversePostedPayment(
      { organizationId: ORG, target: { kind: "era_835", id: "era-int-1" }, reason: "duplicate ERA", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.reversed, true);
    assert.equal(r.ledgerEntriesWritten, 2);
    // Two negative compensating rows added (source_type='reversal').
    const reversalRows = fake.tables.era_posting_ledger_entries.filter(
      (e) => (e as Record<string, unknown>).source_type === "reversal",
    );
    assert.equal(reversalRows.length, 2);
    const sum = reversalRows.reduce(
      (s, e) => s + Number((e as Record<string, unknown>).amount ?? 0),
      0,
    );
    assert.equal(sum, -200, "compensating sum must equal -original");
    // Header marked reversed; claim restored to billed.
    const hdr = fake.tables.era_claim_payments[0] as Record<string, unknown>;
    assert.equal(hdr.posting_status, "reversed");
    assert.equal(
      (fake.tables.professional_claims[0] as Record<string, unknown>).claim_status,
      "billed",
    );
    // Audit log written for the reversal.
    assert.ok(fake.tables.audit_logs.length >= 1);
  });
});

describe("integration: recoupment linkage", () => {
  it("links payment_recoupments → workqueue → audit chain by source_object_id", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-rec-1",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-rec-1",
          clp01_claim_control_number: "PCN-REC",
          clp04_payment_amount: 100,
          posting_status: "posted",
          archived_at: null,
        },
      ],
    });
    const r = await recordRecoupment(
      {
        organizationId: ORG,
        target: { kind: "era_835", id: "era-rec-1" },
        amount: 25,
        reason: "Payer takeback",
        reasonCode: "WO",
        actor: ACTOR,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    const recoupRow = fake.tables.payment_recoupments[0] as Record<string, unknown>;
    assert.equal(recoupRow.source_era_claim_payment_id, "era-rec-1");
    const wq = fake.tables.workqueue_items[0] as Record<string, unknown>;
    assert.equal(wq.source_object_type, "payment_recoupment");
    assert.equal(wq.source_object_id, recoupRow.id);
    const audit = fake.tables.audit_logs.find(
      (a) => (a as Record<string, unknown>).object_type === "payment_recoupment",
    );
    assert.ok(audit, "audit row keyed on payment_recoupment must exist");
  });
});

describe("voidPostedPayment", () => {
  it("refuses to void a posted payment with ledger impact", async () => {
    const fake = makeFakeSupabase({
      client_payments: [
        {
          id: "cp-1",
          organization_id: ORG,
          client_id: "c-1",
          claim_id: null,
          amount: 50,
          payment_method: "stripe",
          posting_status: "posted",
          archived_at: null,
        },
      ],
      era_posting_ledger_entries: [
        {
          id: "le-a",
          organization_id: ORG,
          source_id: "cp-1",
          source_type: "patient_payment",
          archived_at: null,
        },
      ],
    });
    const r = await voidPostedPayment(
      { organizationId: ORG, target: { kind: "client_payment", id: "cp-1" }, reason: "x", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /Use reversal instead/);
  });
});

describe("recordRecoupment", () => {
  it("rejects amount exceeding the original payment", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-r1",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-1",
          clp01_claim_control_number: "PCN-R",
          clp04_payment_amount: 100,
          posting_status: "posted",
          archived_at: null,
        },
      ],
    });
    const r = await recordRecoupment(
      {
        organizationId: ORG,
        target: { kind: "era_835", id: "era-r1" },
        amount: 150,
        reason: "Payer takeback",
        actor: ACTOR,
      },
      fake.client,
    );
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].field, "amount");
  });

  it("writes recoupment row, negative ledger entry, and workqueue item", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-r2",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-1",
          clp01_claim_control_number: "PCN-R2",
          clp04_payment_amount: 100,
          posting_status: "posted",
          archived_at: null,
        },
      ],
    });
    const r = await recordRecoupment(
      {
        organizationId: ORG,
        target: { kind: "era_835", id: "era-r2" },
        amount: 40,
        reason: "Payer takeback",
        actor: ACTOR,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.ok(r.recoupmentId);
    assert.equal(fake.tables.payment_recoupments.length, 1);
    const ledger = fake.tables.era_posting_ledger_entries[0];
    assert.equal(ledger.source_type, "recoupment");
    assert.equal(Number(ledger.amount), -40);
    assert.equal(fake.tables.workqueue_items.length, 1);
    assert.equal(fake.tables.workqueue_items[0].queue_type, "recoupment_review");
  });
});

describe("recordInsuranceRefund / recordPatientRefund", () => {
  it("blocks patient refund against non-client_payment source", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-x",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: null,
          clp01_claim_control_number: "PCN-X",
          clp04_payment_amount: 50,
          posting_status: "posted",
          archived_at: null,
        },
      ],
    });
    const r = await recordPatientRefund(
      {
        organizationId: ORG,
        target: { kind: "era_835", id: "era-x" },
        amount: 10,
        reason: "x",
        actor: ACTOR,
      },
      fake.client,
    );
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].field, "target.kind");
  });

  it("records pending insurance refund and opens workqueue item", async () => {
    const fake = makeFakeSupabase({
      insurance_manual_payments: [
        {
          id: "mi-1",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-1",
          payer_profile_id: "pp-1",
          payer_payment_amount: 200,
          posting_status: "posted",
          check_number: "12345",
          archived_at: null,
        },
      ],
    });
    const r = await recordInsuranceRefund(
      {
        organizationId: ORG,
        target: { kind: "insurance_manual", id: "mi-1" },
        amount: 75,
        reason: "Overpayment",
        actor: ACTOR,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.refundStatus, "pending");
    assert.equal(fake.tables.payment_refunds.length, 1);
    assert.equal(fake.tables.payment_refunds[0].refund_type, "insurance");
    assert.equal(fake.tables.workqueue_items.length, 1);
    assert.equal(fake.tables.workqueue_items[0].queue_type, "insurance_refund");
  });

  it("records issued patient refund with stripe_refund_id", async () => {
    const fake = makeFakeSupabase({
      client_payments: [
        {
          id: "cp-2",
          organization_id: ORG,
          client_id: "c-1",
          claim_id: null,
          patient_invoice_id: null,
          amount: 80,
          payment_method: "stripe",
          posting_status: "posted",
          archived_at: null,
        },
      ],
    });
    const r = await recordPatientRefund(
      {
        organizationId: ORG,
        target: { kind: "client_payment", id: "cp-2" },
        amount: 20,
        reason: "Patient overpaid copay",
        stripeRefundId: "re_test_123",
        alreadyIssued: true,
        actor: ACTOR,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.refundStatus, "issued");
    const refund = fake.tables.payment_refunds[0];
    assert.equal(refund.stripe_refund_id, "re_test_123");
    assert.equal(refund.refund_status, "issued");
    // Already-issued refunds do not open a follow-up workqueue item.
    assert.equal(fake.tables.workqueue_items.length, 0);
  });

  it("rejects refund that exceeds remaining balance after prior refunds", async () => {
    const fake = makeFakeSupabase({
      client_payments: [
        {
          id: "cp-3",
          organization_id: ORG,
          client_id: "c-1",
          claim_id: null,
          patient_invoice_id: null,
          amount: 100,
          payment_method: "stripe",
          posting_status: "posted",
          archived_at: null,
        },
      ],
      payment_refunds: [
        {
          id: "rf-prev",
          organization_id: ORG,
          source_client_payment_id: "cp-3",
          amount: 90,
          refund_status: "issued",
          archived_at: null,
        },
      ],
    });
    const r = await recordPatientRefund(
      {
        organizationId: ORG,
        target: { kind: "client_payment", id: "cp-3" },
        amount: 50,
        reason: "second refund",
        actor: ACTOR,
      },
      fake.client,
    );
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].field, "amount");
    assert.match(r.errors[0].message, /exceeds remaining/);
  });
});
