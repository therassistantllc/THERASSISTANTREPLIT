/**
 * Tests for the scheduled payer-status auto-check scanner (Task #540).
 *
 * Verifies that the scanner:
 *   1. Skips claims that already have a recent inquiry (manual or auto)
 *      inside the recheck-interval window.
 *   2. Queues new inquiries with `trigger_source='auto'` and a null
 *      `created_by_user_id` so the UI can distinguish them from manual
 *      "Check payer status" clicks.
 *   3. Dispatches each queued inquiry through `dispatchClaimStatusInquiry`
 *      so wire/persistence/history behavior matches the manual button.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runClaimStatusAutoCheck } from "../claimStatusAutoCheck";

interface Op {
  table: string;
  kind: "insert" | "update" | "select";
  payload?: Record<string, unknown>;
  filters: Array<{ col: string; val: unknown }>;
}

interface FakeRows {
  professional_claims?: Record<string, unknown>[];
  claim_status_inquiries_recent?: Record<string, unknown>[];
  payer_profiles?: Record<string, unknown> | null;
  insurance_policies?: Record<string, unknown> | null;
  clearinghouse_connections?: Record<string, unknown> | null;
}

function makeFakeSupabase(rows: FakeRows) {
  const ops: Op[] = [];

  function builder(table: string) {
    const filters: Array<{ col: string; val: unknown }> = [];
    const ctx: {
      maybeSingle: boolean;
      single: boolean;
      action: null | { kind: "insert" | "update"; payload: Record<string, unknown> };
      selectAfterAction: boolean;
      recorded: boolean;
    } = {
      maybeSingle: false,
      single: false,
      action: null,
      selectAfterAction: false,
      recorded: false,
    };

    const recordAction = () => {
      if (ctx.action && !ctx.recorded) {
        ops.push({
          table,
          kind: ctx.action.kind,
          payload: ctx.action.payload,
          filters: [...filters],
        });
        ctx.recorded = true;
      }
    };

    const finishRead = () => {
      // Special-case: claim_status_inquiries SELECT used by the scanner
      // to compute "recent inquiries per claim". The fake routes this to
      // a dedicated bucket so the test can seed claim-specific recency.
      if (table === "claim_status_inquiries" && !ctx.action) {
        const seed = rows.claim_status_inquiries_recent ?? [];
        return { data: seed, error: null };
      }
      if (table === "professional_claims" && !ctx.action) {
        const list = rows.professional_claims ?? [];
        return ctx.maybeSingle || ctx.single
          ? { data: list[0] ?? null, error: null }
          : { data: list, error: null };
      }
      if (table === "payer_profiles" && !ctx.action) {
        return ctx.maybeSingle
          ? { data: rows.payer_profiles ?? null, error: null }
          : { data: rows.payer_profiles ? [rows.payer_profiles] : [], error: null };
      }
      if (table === "insurance_policies" && !ctx.action) {
        return ctx.maybeSingle
          ? { data: rows.insurance_policies ?? null, error: null }
          : { data: rows.insurance_policies ? [rows.insurance_policies] : [], error: null };
      }
      if (table === "clearinghouse_connections" && !ctx.action) {
        return ctx.maybeSingle
          ? { data: rows.clearinghouse_connections ?? null, error: null }
          : { data: rows.clearinghouse_connections ? [rows.clearinghouse_connections] : [], error: null };
      }
      return ctx.maybeSingle || ctx.single
        ? { data: null, error: null }
        : { data: [], error: null };
    };

    const finish = () => {
      if (ctx.action) {
        recordAction();
        const returned =
          ctx.action.kind === "insert"
            ? { ...ctx.action.payload, id: ctx.action.payload.id ?? "fake-id" }
            : { ...ctx.action.payload };
        if (ctx.selectAfterAction) {
          return ctx.single || ctx.maybeSingle
            ? { data: returned, error: null }
            : { data: [returned], error: null };
        }
        return { data: null, error: null };
      }
      return finishRead();
    };

    const proxy: Record<string, unknown> = {};
    proxy.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(finish()).then(onFulfilled, onRejected);
    proxy.catch = (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(finish()).catch(onRejected);
    proxy.select = () => {
      if (ctx.action) ctx.selectAfterAction = true;
      return proxy;
    };
    proxy.eq = (col: string, val: unknown) => { filters.push({ col, val }); return proxy; };
    proxy.in = (col: string, val: unknown) => { filters.push({ col, val }); return proxy; };
    proxy.not = (col: string, _op: string, val: unknown) => {
      filters.push({ col: `not:${col}`, val });
      return proxy;
    };
    proxy.lte = (col: string, val: unknown) => { filters.push({ col: `lte:${col}`, val }); return proxy; };
    proxy.gte = (col: string, val: unknown) => { filters.push({ col: `gte:${col}`, val }); return proxy; };
    proxy.is = () => proxy;
    proxy.order = () => proxy;
    proxy.limit = () => proxy;
    proxy.maybeSingle = () => { ctx.maybeSingle = true; return Promise.resolve(finish()); };
    proxy.single = () => { ctx.single = true; return Promise.resolve(finish()); };
    proxy.insert = (payload: Record<string, unknown>) => {
      ctx.action = { kind: "insert", payload };
      return proxy;
    };
    proxy.update = (payload: Record<string, unknown>) => {
      ctx.action = { kind: "update", payload };
      return proxy;
    };
    return proxy;
  }

  const supabase = { from(table: string) { return builder(table); } };
  return { supabase, ops };
}

const ORG = "org-540-1";
const OLD_CLAIM = {
  id: "claim-old",
  organization_id: ORG,
  patient_id: "client-1",
  encounter_id: null,
  payer_profile_id: "payer-1",
  claim_status: "accepted_payer",
  total_charge: 100,
  submitted_at: new Date(Date.now() - 10 * 86400_000).toISOString(),
};
const STALE_CLAIM_RECENTLY_CHECKED = {
  ...OLD_CLAIM,
  id: "claim-stale-but-just-checked",
};

describe("runClaimStatusAutoCheck", () => {
  it("queues an inquiry with trigger_source='auto' and a null user id, then dispatches it", async () => {
    const { supabase, ops } = makeFakeSupabase({
      professional_claims: [OLD_CLAIM],
      payer_profiles: { payer_name: "Demo HMO", availity_payer_id: "DEMO01" },
      insurance_policies: { subscriber_id: "MBR-1", policy_number: "POL-1" },
      claim_status_inquiries_recent: [], // no recent activity ⇒ eligible
    });

    const result = await runClaimStatusAutoCheck(supabase as never, {
      organizationId: ORG,
      ageDays: 3,
      recheckIntervalDays: 2,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.dispatched, 1);
    assert.equal(result.failures, 0);

    const inquiryInserts = ops.filter(
      (o) => o.table === "claim_status_inquiries" && o.kind === "insert",
    );
    assert.equal(inquiryInserts.length, 1, "expected one queued inquiry");
    const payload = inquiryInserts[0].payload!;
    assert.equal(payload.trigger_source, "auto");
    assert.equal(payload.created_by_user_id, null);
    assert.equal(payload.inquiry_status, "queued");
    assert.equal(payload.organization_id, ORG);
    assert.equal(payload.claim_id, OLD_CLAIM.id);

    // Dispatcher should have run: it flips the row sent → received.
    const inquiryUpdates = ops.filter(
      (o) => o.table === "claim_status_inquiries" && o.kind === "update",
    );
    const statuses = inquiryUpdates.map((u) => u.payload?.inquiry_status);
    assert.deepEqual(statuses, ["sent", "received"]);
  });

  it("skips claims whose latest inquiry is inside the recheck window", async () => {
    const recentAt = new Date(Date.now() - 6 * 3600_000).toISOString(); // 6h ago
    const { supabase, ops } = makeFakeSupabase({
      professional_claims: [STALE_CLAIM_RECENTLY_CHECKED],
      claim_status_inquiries_recent: [
        { claim_id: STALE_CLAIM_RECENTLY_CHECKED.id, requested_at: recentAt },
      ],
    });

    const result = await runClaimStatusAutoCheck(supabase as never, {
      organizationId: ORG,
      ageDays: 3,
      recheckIntervalDays: 2,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.dispatched, 0);
    assert.equal(result.outcomes[0].inquiryStatus, "skipped");

    const inquiryInserts = ops.filter(
      (o) => o.table === "claim_status_inquiries" && o.kind === "insert",
    );
    assert.equal(inquiryInserts.length, 0, "must not queue a fresh inquiry");
  });
});
