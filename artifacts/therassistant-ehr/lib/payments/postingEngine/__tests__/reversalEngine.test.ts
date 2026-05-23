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
  cancelPendingRefund,
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

describe("reversePostedPayment — auto-refund workqueue schema", () => {
  it("writes a workqueue_items row that matches the actual schema (Task #140)", async () => {
    const fake = makeFakeSupabase({
      client_payments: [
        {
          id: "cp-wq-1",
          organization_id: ORG,
          client_id: "c-1",
          claim_id: null,
          amount: 60,
          payment_method: "stripe",
          stripe_charge_id: "ch_test_wq",
          patient_invoice_id: null,
          posting_status: "posted",
          archived_at: null,
        },
      ],
    });
    const r = await reversePostedPayment(
      {
        organizationId: ORG,
        target: { kind: "client_payment", id: "cp-wq-1" },
        reason: "patient dispute",
        actor: ACTOR,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(fake.tables.payment_refunds.length, 1);
    assert.equal(fake.tables.workqueue_items.length, 1);
    const wq = fake.tables.workqueue_items[0] as Record<string, unknown>;
    // Schema invariants from .agents/memory/workqueue-items-schema.md:
    //   - column is `work_type`; never `queue_type`
    //   - `source_object_type` enum only allows `payment_posting`
    //     (NOT `payment_refund`)
    //   - column is `client_id` (no `patient_id`)
    //   - refund linkage lives in `context_payload`
    assert.equal(wq.work_type, "patient_refund");
    assert.equal(wq.source_object_type, "payment_posting");
    assert.equal(wq.client_id, "c-1");
    assert.equal(wq.source_object_id, fake.tables.payment_refunds[0].id);
    assert.ok(!("queue_type" in wq), "must not write legacy queue_type column");
    assert.ok(!("patient_id" in wq), "must not write dropped patient_id column");
    assert.ok(!("payer_id" in wq), "must not write nonexistent payer_id column");
    const ctx = (wq.context_payload ?? {}) as Record<string, unknown>;
    assert.equal(ctx.origin, "reversal_auto_refund");
    assert.equal(ctx.payment_refund_id, fake.tables.payment_refunds[0].id);
    assert.equal(ctx.stripe_charge_id, "ch_test_wq");
    assert.equal(ctx.source_kind, "client_payment");
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

describe("cancelPendingRefund (Task #169)", () => {
  it("flips pending→cancelled, archives the row, closes workqueue, writes audit", async () => {
    const refundId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
    const wqId = "wq-cancel-1";
    const fake = makeFakeSupabase({
      payment_refunds: [
        {
          id: refundId,
          organization_id: ORG,
          refund_type: "insurance",
          amount: 80,
          refund_status: "pending",
          source_era_claim_payment_id: "era-cancel-1",
          source_client_payment_id: null,
          source_insurance_manual_payment_id: null,
          professional_claim_id: "claim-cancel-1",
          client_id: "c-1",
          workqueue_item_id: wqId,
          archived_at: null,
        },
      ],
      workqueue_items: [
        { id: wqId, organization_id: ORG, status: "open", resolved_at: null },
      ],
    });
    const r = await cancelPendingRefund(
      { organizationId: ORG, refundId, reason: "Opened in error", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.refundStatus, "cancelled");
    assert.equal(r.workqueueItemClosed, true);
    const refundRow = fake.tables.payment_refunds[0] as Record<string, unknown>;
    assert.equal(refundRow.refund_status, "cancelled");
    assert.ok(refundRow.archived_at, "archived_at must be stamped");
    assert.equal(refundRow.note, "Opened in error");
    // No ledger entry was posted — cancellation is a metadata-only flip.
    assert.equal(fake.tables.era_posting_ledger_entries.length, 0);
    // Workqueue item closed.
    const wq = fake.tables.workqueue_items[0] as Record<string, unknown>;
    assert.equal(wq.status, "cancelled");
    assert.ok(wq.resolved_at);
    // Audit row written with refund_cancelled action.
    assert.equal(fake.tables.audit_logs.length, 1);
    assert.equal(
      (fake.tables.audit_logs[0] as Record<string, unknown>).action,
      "refund_cancelled",
    );
  });

  it("requires a non-blank reason", async () => {
    const fake = makeFakeSupabase({});
    const r = await cancelPendingRefund(
      { organizationId: ORG, refundId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1", reason: "  ", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].field, "reason");
  });

  it("refuses to cancel an already-issued refund", async () => {
    const refundId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const fake = makeFakeSupabase({
      payment_refunds: [
        {
          id: refundId,
          organization_id: ORG,
          refund_type: "insurance",
          amount: 50,
          refund_status: "issued",
          source_era_claim_payment_id: "era-x",
          professional_claim_id: "claim-x",
          client_id: "c-1",
          archived_at: null,
        },
      ],
    });
    const r = await cancelPendingRefund(
      { organizationId: ORG, refundId, reason: "too late", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].field, "refund_status");
    // Row was NOT mutated.
    const row = fake.tables.payment_refunds[0] as Record<string, unknown>;
    assert.equal(row.refund_status, "issued");
    assert.equal(row.archived_at, null);
  });

  it("refuses to cancel a patient refund", async () => {
    const refundId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const fake = makeFakeSupabase({
      payment_refunds: [
        {
          id: refundId,
          organization_id: ORG,
          refund_type: "patient",
          amount: 50,
          refund_status: "pending",
          source_client_payment_id: "cp-1",
          client_id: "c-1",
          archived_at: null,
        },
      ],
    });
    const r = await cancelPendingRefund(
      { organizationId: ORG, refundId, reason: "nope", actor: ACTOR },
      fake.client,
    );
    assert.equal(r.ok, false);
    const row = fake.tables.payment_refunds[0] as Record<string, unknown>;
    assert.equal(row.refund_status, "pending");
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

describe("reversePostedPayment — dry-run preview", () => {
  it("returns a preview without mutating any table", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-dry-1",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-dry-1",
          clp01_claim_control_number: "PCN-DRY",
          clp04_payment_amount: 150,
          posting_status: "posted",
          reversed_at: null,
          voided_at: null,
          archived_at: null,
        },
      ],
      era_posting_ledger_entries: [
        {
          id: "le-d-1",
          organization_id: ORG,
          source_id: "era-dry-1",
          source_type: "era_payment",
          entry_type: "payment",
          amount: 100,
          professional_claim_id: "claim-dry-1",
          client_id: "c-1",
          description: "Insurance payment",
          archived_at: null,
        },
        {
          id: "le-d-2",
          organization_id: ORG,
          source_id: "era-dry-1",
          source_type: "era_payment",
          entry_type: "adjustment",
          amount: 50,
          professional_claim_id: "claim-dry-1",
          client_id: "c-1",
          description: "CO adjustment",
          archived_at: null,
        },
      ],
      professional_claims: [{ id: "claim-dry-1", organization_id: ORG, claim_status: "paid" }],
      workqueue_items: [
        {
          id: "wq-d-1",
          organization_id: ORG,
          source_object_type: "era_claim_payment",
          source_object_id: "era-dry-1",
          status: "open",
          archived_at: null,
        },
      ],
    });
    const r = await reversePostedPayment(
      {
        organizationId: ORG,
        target: { kind: "era_835", id: "era-dry-1" },
        reason: "preview-only",
        actor: ACTOR,
        dryRun: true,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.reversed, false, "reversed must remain false in dry-run");
    assert.ok(r.preview);
    assert.equal(r.preview!.paymentTotalImpact, 150);
    assert.equal(r.preview!.ledgerReversalEntries.length, 2);
    const sum = r.preview!.ledgerReversalEntries.reduce((s, e) => s + e.amount, 0);
    assert.equal(sum, -150, "preview compensating sum must equal -original");
    assert.ok(r.preview!.claimStatusChange);
    assert.equal(r.preview!.claimStatusChange!.to, "billed");
    assert.equal(r.preview!.workqueueItemsToClose, 1);
    // No writes / status changes.
    assert.equal(
      (fake.tables.era_claim_payments[0] as Record<string, unknown>).posting_status,
      "posted",
    );
    assert.equal(
      fake.tables.era_posting_ledger_entries.filter(
        (e) => (e as Record<string, unknown>).source_type === "reversal",
      ).length,
      0,
    );
    assert.equal(fake.tables.audit_logs.length, 0);
  });

  it("client_payment dry-run previews auto patient-refund initiation and invoice delta", async () => {
    const fake = makeFakeSupabase({
      client_payments: [
        {
          id: "cp-dry-rev",
          organization_id: ORG,
          client_id: "c-2",
          claim_id: null,
          patient_invoice_id: "inv-rev",
          amount: 60,
          payment_method: "stripe",
          stripe_charge_id: "ch_rev",
          posting_status: "posted",
          reversed_at: null,
          voided_at: null,
          archived_at: null,
        },
      ],
      patient_invoices: [
        {
          id: "inv-rev",
          organization_id: ORG,
          paid_amount: 60,
          balance_amount: 0,
          patient_responsibility_amount: 60,
          invoice_status: "paid",
          archived_at: null,
        },
      ],
    });
    const r = await reversePostedPayment(
      {
        organizationId: ORG,
        target: { kind: "client_payment", id: "cp-dry-rev" },
        reason: "preview Stripe path",
        actor: ACTOR,
        dryRun: true,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.ok(r.preview);
    assert.ok(r.preview!.autoPatientRefund);
    assert.equal(r.preview!.autoPatientRefund!.amount, 60);
    assert.equal(r.preview!.autoPatientRefund!.stripeChargeId, "ch_rev");
    assert.ok(r.preview!.patientInvoice);
    assert.equal(r.preview!.patientInvoice!.paidAmountDelta, -60);
    assert.equal(r.preview!.patientInvoice!.newPaidAmount, 0);
    assert.equal(r.preview!.patientInvoice!.newStatus, "open");
    // Invoice unchanged in DB.
    assert.equal(
      (fake.tables.patient_invoices[0] as Record<string, unknown>).paid_amount,
      60,
    );
    assert.equal(fake.tables.payment_refunds.length, 0);
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
    // PP-5: workqueue_items.source_object_type is a Postgres ENUM that
    // does not include `payment_recoupment`. We use the closest valid
    // value `payment_posting` and stash the recoupment linkage in
    // context_payload so downstream filters/audit chain still resolve.
    assert.equal(wq.source_object_type, "payment_posting");
    assert.equal(wq.source_object_id, recoupRow.id);
    assert.equal(wq.work_type, "recoupment_review");
    assert.equal(wq.client_id, recoupRow.client_id);
    const ctx = (wq.context_payload ?? {}) as Record<string, unknown>;
    assert.equal(ctx.origin, "recoupment");
    assert.equal(ctx.payment_recoupment_id, recoupRow.id);
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
    // PP-5: workqueue_items uses `work_type` (no `queue_type` column).
    assert.equal(fake.tables.workqueue_items[0].work_type, "recoupment_review");
    assert.equal(fake.tables.workqueue_items[0].source_object_type, "payment_posting");
  });

  it("dry-run returns a preview without writing any rows (Task #172)", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-r3",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-1",
          clp01_claim_control_number: "PCN-R3",
          clp04_payment_amount: 100,
          posting_status: "posted",
          archived_at: null,
        },
      ],
    });
    const r = await recordRecoupment(
      {
        organizationId: ORG,
        target: { kind: "era_835", id: "era-r3" },
        amount: 25,
        reason: "Payer takeback preview",
        reasonCode: "WO",
        actor: ACTOR,
        dryRun: true,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.recoupmentId, null);
    assert.equal(r.ledgerEntryId, null);
    assert.equal(r.workqueueItemId, null);
    // No writes against any table.
    assert.equal(fake.tables.payment_recoupments.length, 0);
    assert.equal(fake.tables.era_posting_ledger_entries.length, 0);
    assert.equal(fake.tables.workqueue_items.length, 0);
    // Preview surfaces every field a confirm modal needs.
    assert.ok(r.preview, "preview must be populated in dry-run mode");
    assert.equal(r.preview.amount, 25);
    assert.equal(r.preview.paymentTotalImpact, 100);
    assert.equal(r.preview.remainingRecoupableBefore, 100);
    assert.equal(r.preview.remainingRecoupableAfter, 75);
    assert.equal(r.preview.compensatingLedgerEntry.amount, -25);
    assert.equal(r.preview.compensatingLedgerEntry.groupCode, "OA");
    assert.equal(r.preview.compensatingLedgerEntry.reasonCode, "WO");
    assert.equal(r.preview.workqueueItem.wouldOpen, true);
    assert.equal(r.preview.workqueueItem.workType, "recoupment_review");
    assert.ok(r.preview.workqueueItem.title?.includes("25.00"));
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
    const wq = fake.tables.workqueue_items[0] as Record<string, unknown>;
    // Schema invariants (see .agents/memory/workqueue-items-schema.md):
    //   - column is `work_type` (no `queue_type`)
    //   - column is `client_id` (no `patient_id`)
    //   - `payer_id` is NOT a column
    //   - `source_object_type` enum only allows `payment_posting`
    //     (NOT `payment_refund`); refund/payer linkage lives in
    //     `context_payload`.
    assert.equal(wq.work_type, "insurance_refund");
    assert.equal(wq.source_object_type, "payment_posting");
    assert.equal(wq.client_id, "c-1");
    assert.equal(wq.source_object_id, fake.tables.payment_refunds[0].id);
    assert.ok(!("queue_type" in wq), "must not write legacy queue_type column");
    assert.ok(!("patient_id" in wq), "must not write dropped patient_id column");
    assert.ok(!("payer_id" in wq), "must not write nonexistent payer_id column");
    const ctx = (wq.context_payload ?? {}) as Record<string, unknown>;
    assert.equal(ctx.origin, "refund_request");
    assert.equal(ctx.refund_type, "insurance");
    assert.equal(ctx.payer_profile_id, "pp-1");
    assert.equal(ctx.payment_refund_id, fake.tables.payment_refunds[0].id);
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

  it("dryRun=true returns a refund preview without mutating any table", async () => {
    const fake = makeFakeSupabase({
      insurance_manual_payments: [
        {
          id: "mi-dry-1",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-d",
          payer_profile_id: "pp-1",
          payer_payment_amount: 200,
          posting_status: "posted",
          check_number: "9999",
          archived_at: null,
        },
      ],
    });
    const r = await recordInsuranceRefund(
      {
        organizationId: ORG,
        target: { kind: "insurance_manual", id: "mi-dry-1" },
        amount: 75,
        reason: "Overpayment preview",
        actor: ACTOR,
        dryRun: true,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.refundId, null, "no refund row should be inserted in dry-run");
    assert.ok(r.preview, "preview must be populated");
    assert.equal(r.preview!.refundType, "insurance");
    assert.equal(r.preview!.amount, 75);
    assert.equal(r.preview!.paymentTotalImpact, 200);
    assert.equal(r.preview!.remainingRefundableBefore, 200);
    assert.equal(r.preview!.remainingRefundableAfter, 125);
    assert.equal(r.preview!.initialRefundStatus, "pending");
    // Pending insurance refund: no compensating ledger entry yet, but workqueue would open.
    assert.equal(r.preview!.compensatingLedgerEntry, null);
    assert.equal(r.preview!.workqueueItem.wouldOpen, true);
    assert.equal(r.preview!.workqueueItem.queueType, "insurance_refund");
    // Nothing written.
    assert.equal(fake.tables.payment_refunds.length, 0);
    assert.equal(fake.tables.workqueue_items.length, 0);
    assert.equal(fake.tables.era_posting_ledger_entries.length, 0);
    assert.equal(fake.tables.audit_logs.length, 0);
  });

  it("dryRun=true with alreadyIssued=true previews compensating ledger entry", async () => {
    const fake = makeFakeSupabase({
      insurance_manual_payments: [
        {
          id: "mi-dry-2",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-d2",
          payer_profile_id: "pp-1",
          payer_payment_amount: 300,
          posting_status: "posted",
          check_number: "12345",
          archived_at: null,
        },
      ],
    });
    const r = await recordInsuranceRefund(
      {
        organizationId: ORG,
        target: { kind: "insurance_manual", id: "mi-dry-2" },
        amount: 50,
        reason: "Confirmed check issued",
        alreadyIssued: true,
        actor: ACTOR,
        dryRun: true,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.refundStatus, "issued");
    assert.ok(r.preview);
    assert.equal(r.preview!.initialRefundStatus, "issued");
    assert.ok(r.preview!.compensatingLedgerEntry, "issued insurance refund must preview a ledger entry");
    assert.equal(r.preview!.compensatingLedgerEntry!.amount, -50);
    assert.equal(r.preview!.compensatingLedgerEntry!.entryType, "payment");
    // Already-issued: no workqueue follow-up.
    assert.equal(r.preview!.workqueueItem.wouldOpen, false);
    // Still no writes.
    assert.equal(fake.tables.payment_refunds.length, 0);
    assert.equal(fake.tables.era_posting_ledger_entries.length, 0);
  });

  it("dryRun preview reports invoice paid_amount delta for issued patient refund", async () => {
    const fake = makeFakeSupabase({
      client_payments: [
        {
          id: "cp-dry-pat",
          organization_id: ORG,
          client_id: "c-1",
          claim_id: null,
          patient_invoice_id: "inv-dry",
          amount: 80,
          payment_method: "stripe",
          posting_status: "posted",
          stripe_charge_id: "ch_dry",
          archived_at: null,
        },
      ],
      patient_invoices: [
        {
          id: "inv-dry",
          organization_id: ORG,
          paid_amount: 80,
          balance_amount: 0,
          patient_responsibility_amount: 80,
          invoice_status: "paid",
          archived_at: null,
        },
      ],
    });
    const r = await recordPatientRefund(
      {
        organizationId: ORG,
        target: { kind: "client_payment", id: "cp-dry-pat" },
        amount: 30,
        reason: "Partial refund preview",
        stripeRefundId: "re_dry",
        alreadyIssued: true,
        actor: ACTOR,
        dryRun: true,
      },
      fake.client,
    );
    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.ok(r.preview);
    assert.ok(r.preview!.patientInvoice, "invoice delta must be populated");
    assert.equal(r.preview!.patientInvoice!.invoiceId, "inv-dry");
    assert.equal(r.preview!.patientInvoice!.paidAmountDelta, -30);
    assert.equal(r.preview!.patientInvoice!.newPaidAmount, 50);
    assert.equal(r.preview!.patientInvoice!.newBalanceAmount, 30);
    assert.equal(r.preview!.patientInvoice!.newStatus, "open");
    // Stripe preview should report not_applicable / already_issued path.
    assert.ok(r.preview!.stripeRefund);
    assert.equal(r.preview!.stripeRefund!.wouldFire, false);
    assert.equal(r.preview!.stripeRefund!.reason, "already_issued");
    // No mutations.
    assert.equal(fake.tables.payment_refunds.length, 0);
    assert.equal(
      (fake.tables.patient_invoices[0] as Record<string, unknown>).paid_amount,
      80,
      "invoice paid_amount must be unchanged",
    );
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

// ─────────────────────────────────────────────────────────────────────────────
// Task #135 — commitPosting dispatch shim for refund / reversal sources.
//
// These tests target the public commitPosting entrypoint (not the underlying
// recordPatientRefund / reversePostedPayment helpers), so a regression that
// drops the `refund` metadata field, mis-maps `posted`, skips the dry-run
// short-circuit, or forgets to mirror workqueueItemsClosed back into the
// CommitPostingResult is caught here.
// ─────────────────────────────────────────────────────────────────────────────

import { commitPosting } from "../index";

describe("commitPosting → refund dispatch", () => {
  it("returns posted=true and a populated refund field after a successful patient refund", async () => {
    const fake = makeFakeSupabase({
      client_payments: [
        {
          id: "cp-disp-1",
          organization_id: ORG,
          client_id: "c-1",
          claim_id: null,
          amount: 80,
          payment_method: "stripe",
          stripe_charge_id: null,
          patient_invoice_id: null,
          posting_status: "posted",
          archived_at: null,
        },
      ],
    });

    const r = await commitPosting(
      {
        organizationId: ORG,
        actor: ACTOR,
        source: {
          type: "refund",
          target: { kind: "client_payment", id: "cp-disp-1" },
          amount: 30,
          reason: "patient overpaid",
        },
      },
      fake.client,
    );

    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.posted, true, "posted must be true when a refund row was written");
    assert.ok(r.refund, "refund metadata must be surfaced for dashboard callers");
    assert.ok(r.refund!.refundId, "refund.refundId must be populated");
    // refund_status comes straight from the inserted row — pending until a
    // stripe issuance (not exercised here) or confirmInsuranceRefund flips it.
    assert.equal(r.refund!.refundStatus, "pending");

    // A payment_refunds row must actually exist for the refund the engine
    // claims to have created.
    const refundRow = fake.tables.payment_refunds.find(
      (row) => row.id === r.refund!.refundId,
    ) as Record<string, unknown> | undefined;
    assert.ok(refundRow, "payment_refunds row must exist for the returned refundId");
    assert.equal(refundRow!.refund_type, "patient");
    assert.equal(Number(refundRow!.amount), 30);
    assert.equal(refundRow!.source_client_payment_id, "cp-disp-1");
  });
});

describe("commitPosting → reversal dispatch", () => {
  it("returns posted=true and mirrors workqueueItemsClosed from the engine", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-disp-1",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-disp-1",
          clp01_claim_control_number: "PCN-DISP",
          clp04_payment_amount: 100,
          posting_status: "posted",
          reversed_at: null,
          voided_at: null,
          archived_at: null,
        },
      ],
      era_posting_ledger_entries: [
        {
          id: "le-disp-1",
          organization_id: ORG,
          source_type: "era_835",
          source_id: "era-disp-1",
          era_claim_payment_id: "era-disp-1",
          professional_claim_id: "claim-disp-1",
          client_id: "c-1",
          entry_type: "insurance_payment",
          amount: 100,
          archived_at: null,
        },
      ],
      professional_claims: [
        { id: "claim-disp-1", organization_id: ORG, claim_status: "paid" },
      ],
      // Two open ERA-mismatch workqueue rows that the reversal engine should
      // close. The dispatch shim must mirror this count into the
      // CommitPostingResult so dashboard callers don't have to re-query.
      workqueue_items: [
        {
          id: "wq-disp-1",
          organization_id: ORG,
          source_object_type: "era_claim_payment",
          source_object_id: "era-disp-1",
          work_type: "era_mismatch",
          status: "open",
          archived_at: null,
        },
        {
          id: "wq-disp-2",
          organization_id: ORG,
          source_object_type: "era_claim_payment",
          source_object_id: "era-disp-1",
          work_type: "era_835_exception",
          status: "in_progress",
          archived_at: null,
        },
      ],
    });

    const r = await commitPosting(
      {
        organizationId: ORG,
        actor: ACTOR,
        source: {
          type: "reversal",
          target: { kind: "era_835", id: "era-disp-1" },
          reason: "duplicate ERA imported",
        },
      },
      fake.client,
    );

    assert.equal(r.ok, true, r.errors.map((e) => e.message).join("; "));
    assert.equal(r.posted, true, "posted must mirror reversal engine's `reversed`");
    assert.equal(
      r.workqueueItemsClosed,
      2,
      "workqueueItemsClosed must mirror the engine's count exactly",
    );

    // Sanity: the workqueue rows really were closed under the hood, so the
    // mirrored count above isn't a coincidence.
    const closedRows = fake.tables.workqueue_items.filter(
      (row) => row.status === "resolved",
    );
    assert.equal(closedRows.length, 2);
  });
});

describe("commitPosting → dryRun short-circuit for refund + reversal", () => {
  it("refund dry-run returns ok=true and writes nothing", async () => {
    const fake = makeFakeSupabase({
      client_payments: [
        {
          id: "cp-dry-1",
          organization_id: ORG,
          client_id: "c-1",
          amount: 50,
          posting_status: "posted",
          archived_at: null,
        },
      ],
    });

    const r = await commitPosting(
      {
        organizationId: ORG,
        actor: ACTOR,
        dryRun: true,
        source: {
          type: "refund",
          target: { kind: "client_payment", id: "cp-dry-1" },
          amount: 20,
          reason: "preview only",
        },
      },
      fake.client,
    );

    assert.equal(r.ok, true);
    assert.equal(r.posted, false, "dry-run must not report a write");
    assert.equal(r.refund, undefined, "dry-run must not populate refund metadata");
    // No DB rows of any kind should have been written.
    assert.equal(fake.tables.payment_refunds.length, 0);
    assert.equal(fake.tables.era_posting_ledger_entries.length, 0);
    assert.equal(fake.tables.audit_logs.length, 0);
  });

  it("reversal dry-run returns ok=true and writes nothing", async () => {
    const fake = makeFakeSupabase({
      era_claim_payments: [
        {
          id: "era-dry-1",
          organization_id: ORG,
          client_id: "c-1",
          professional_claim_id: "claim-dry-1",
          clp01_claim_control_number: "PCN-DRY",
          clp04_payment_amount: 100,
          posting_status: "posted",
          reversed_at: null,
          voided_at: null,
          archived_at: null,
        },
      ],
      era_posting_ledger_entries: [
        {
          id: "le-dry-1",
          organization_id: ORG,
          source_type: "era_835",
          source_id: "era-dry-1",
          era_claim_payment_id: "era-dry-1",
          professional_claim_id: "claim-dry-1",
          client_id: "c-1",
          entry_type: "insurance_payment",
          amount: 100,
          archived_at: null,
        },
      ],
      professional_claims: [
        { id: "claim-dry-1", organization_id: ORG, claim_status: "paid" },
      ],
    });

    const r = await commitPosting(
      {
        organizationId: ORG,
        actor: ACTOR,
        dryRun: true,
        source: {
          type: "reversal",
          target: { kind: "era_835", id: "era-dry-1" },
          reason: "preview only",
        },
      },
      fake.client,
    );

    assert.equal(r.ok, true);
    assert.equal(r.posted, false, "dry-run must not report a write");
    assert.equal(r.workqueueItemsClosed, 0);
    // ERA header untouched.
    const era = fake.tables.era_claim_payments[0] as Record<string, unknown>;
    assert.equal(era.posting_status, "posted");
    assert.equal(era.reversed_at, null);
    // No compensating ledger row appended, no audit row written.
    assert.equal(fake.tables.era_posting_ledger_entries.length, 1);
    assert.equal(fake.tables.audit_logs.length, 0);
  });
});
