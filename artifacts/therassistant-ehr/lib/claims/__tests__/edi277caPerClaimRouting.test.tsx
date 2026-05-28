// End-to-end test for per-claim 277CA auto-routing. Verifies that when a
// single 277CA batch carries different rejection reasons for different
// claims, each claim gets its own routing decision instead of all claims
// sharing the batch-level decision.

import { describe, it, beforeEach, mock } from "node:test";
import { strict as assert } from "node:assert";

const ORG = "11111111-1111-1111-1111-111111111111";

type WorkqueueRow = Record<string, unknown>;
const insertedWorkqueueRows: WorkqueueRow[] = [];

// Seed claims the routing service will SELECT after we feed it claimIds.
//   - PAT-MEM  → subscriber rejection (entity IL) → should auto-route
//                to invalid_member / eligibility.
//   - PAT-PRV  → billing-provider rejection (entity 85) → should
//                auto-route to invalid_provider / credentialing.
const CLAIM_ROWS = [
  {
    id: "claim-member",
    patient_id: "client-1",
    claim_number: "CLM-001",
    patient_account_number: "PAT-MEM",
    claim_status: "rejected_payer",
  },
  {
    id: "claim-provider",
    patient_id: "client-2",
    claim_number: "CLM-002",
    patient_account_number: "PAT-PRV",
    claim_status: "rejected_payer",
  },
];

function makeFakeSupabase() {
  type Q = {
    eq(col: string, val: unknown): Q;
    in(col: string, val: unknown): Q;
    is(col: string, val: unknown): Q;
    select(_c?: string): Q;
    limit(_n: number): Q;
    maybeSingle(): Promise<{ data: unknown; error: null }>;
    then(
      onFulfilled: (v: { data: unknown; error: null }) => unknown,
    ): Promise<unknown>;
  };

  const makeBuilder = (table: string, op: "select" | "insert" | "update", payload?: unknown): Q => {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    let isOpenCheck = false;
    const q: Q = {
      select(_c?: string) {
        return q;
      },
      eq(col, val) {
        filters[col] = val;
        return q;
      },
      in(col, vals) {
        inFilters[col] = vals as unknown[];
        // The open-item check uses .in("status", [...]) — we use that as
        // the signal that this is the dedupe query and return "no rows".
        if (col === "status") isOpenCheck = true;
        return q;
      },
      is() {
        return q;
      },
      limit() {
        return q;
      },
      async maybeSingle() {
        return { data: null, error: null };
      },
      then(onFulfilled) {
        if (op === "insert") {
          insertedWorkqueueRows.push(payload as WorkqueueRow);
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        }
        if (table === "professional_claims" && op === "select") {
          const requested = (inFilters["id"] ?? []) as string[];
          const rows = CLAIM_ROWS.filter((r) => requested.includes(r.id));
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
        }
        if (table === "workqueue_items" && op === "select" && isOpenCheck) {
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        }
        if (table === "system_settings") {
          // Default settings — no row → defaults (enabled, both tabs on).
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        }
        return Promise.resolve({ data: null, error: null }).then(onFulfilled);
      },
    };
    return q;
  };

  return {
    from(table: string) {
      return {
        select(_cols?: string) {
          return makeBuilder(table, "select");
        },
        insert(payload: unknown) {
          return makeBuilder(table, "insert", payload);
        },
        update() {
          return makeBuilder(table, "update");
        },
      };
    },
  };
}

mock.module("@/lib/supabase/server", {
  namedExports: {
    createServerSupabaseAdminClient: () => makeFakeSupabase(),
  },
});

let routeRejectedClaimsToWorkqueue: typeof import(
  "@/lib/workqueue/claimRejectionWorkqueueService"
)["routeRejectedClaimsToWorkqueue"];

describe("routeRejectedClaimsToWorkqueue — per-claim 277CA classification", () => {
  beforeEach(async () => {
    ({ routeRejectedClaimsToWorkqueue } = await import(
      "@/lib/workqueue/claimRejectionWorkqueueService"
    ));
    insertedWorkqueueRows.length = 0;
  });

  it("auto-routes each claim using its own STC entries, not the batch's", async () => {
    const parsedContent = {
      outcome: "rejected" as const,
      // Top-level (batch) stcStatuses are the union — must NOT be the
      // only signal driving routing, otherwise every claim collapses to
      // the same tab.
      stcStatuses: [
        { category: "A7", status: "562", entity: "IL", message: "Subscriber not found" },
        { category: "A7", status: "562", entity: "85", message: "Billing provider NPI invalid" },
      ],
      claimRefs: [
        {
          trn: "PAT-MEM",
          stcStatuses: [
            { category: "A7", status: "562", entity: "IL", message: "Subscriber not found" },
          ],
          message: "Subscriber not found",
        },
        {
          trn: "PAT-PRV",
          stcStatuses: [
            { category: "A7", status: "562", entity: "85", message: "Billing provider NPI invalid" },
          ],
          message: "Billing provider NPI invalid",
        },
      ],
    };

    const result = await routeRejectedClaimsToWorkqueue({
      organizationId: ORG,
      acknowledgementId: "ack-1",
      batchId: "batch-1",
      claimIds: CLAIM_ROWS.map((c) => c.id),
      source: "277CA",
      outcome: "rejected",
      parsedContent,
    });

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.created, 2);
    assert.equal(result.autoRouted, 2);
    assert.equal(insertedWorkqueueRows.length, 2);

    const memberRow = insertedWorkqueueRows.find(
      (r) => r.source_object_id === "claim-member",
    )!;
    const providerRow = insertedWorkqueueRows.find(
      (r) => r.source_object_id === "claim-provider",
    )!;

    const memberCtx = memberRow.context_payload as Record<string, unknown>;
    const providerCtx = providerRow.context_payload as Record<string, unknown>;

    assert.equal(memberCtx.auto_routed, true);
    assert.equal(memberCtx.auto_routed_tab, "invalid_member");
    assert.equal(memberCtx.auto_routed_reason, "routed_to_eligibility");
    assert.equal(memberCtx.claim_ref_trn, "PAT-MEM");

    assert.equal(providerCtx.auto_routed, true);
    assert.equal(
      providerCtx.auto_routed_tab,
      "invalid_provider",
      "provider claim must not inherit the member claim's auto-route tab",
    );
    assert.equal(providerCtx.auto_routed_reason, "routed_to_credentialing");
    assert.equal(providerCtx.claim_ref_trn, "PAT-PRV");
  });

  it("falls back to batch-level STC entries when no per-claim ref matches", async () => {
    // No claimRefs at all → both claims share the batch decision.
    const parsedContent = {
      outcome: "rejected" as const,
      stcStatuses: [
        { category: "A7", status: "562", entity: "IL", message: "Subscriber not found" },
      ],
      claimRefs: [],
    };

    const result = await routeRejectedClaimsToWorkqueue({
      organizationId: ORG,
      acknowledgementId: "ack-2",
      batchId: "batch-2",
      claimIds: CLAIM_ROWS.map((c) => c.id),
      source: "277CA",
      outcome: "rejected",
      parsedContent,
    });

    assert.equal(result.ok, true);
    assert.equal(result.autoRouted, 2);
    for (const row of insertedWorkqueueRows) {
      const ctx = row.context_payload as Record<string, unknown>;
      assert.equal(ctx.auto_routed_tab, "invalid_member");
      assert.equal(ctx.claim_ref_trn, undefined);
    }
  });
});
