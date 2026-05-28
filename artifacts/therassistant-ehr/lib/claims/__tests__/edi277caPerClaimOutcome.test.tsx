// Per-claim outcome attribution test for intake277CAAcknowledgement.
// In a mixed-rejection batch (one claim accepted, one rejected), each
// linked professional_claims row must be tagged from its OWN matching
// 2200D STC entries instead of every claim collapsing to the batch
// outcome.

import { describe, it, beforeEach, mock } from "node:test";
import { strict as assert } from "node:assert";

const ORG = "11111111-1111-1111-1111-111111111111";
const BATCH_ID = "batch-mixed";
const ACK_ID = "ack-mixed";

// Two linked claims. PAT-MEM carries a rejection STC (A7:562); PAT-OK
// carries an accept STC (A2:20). The batch-level outcome is "partial"
// — so the old code would have tagged both as accepted_payer. The new
// code must tag PAT-MEM as rejected_payer and PAT-OK as accepted_payer.
const CLAIM_ROWS = [
  {
    id: "claim-mem",
    patient_id: "client-mem",
    appointment_id: "appt-mem",
    claim_number: "CLM-MEM",
    patient_account_number: "PAT-MEM",
    claim_status: "submitted",
  },
  {
    id: "claim-ok",
    patient_id: "client-ok",
    appointment_id: "appt-ok",
    claim_number: "CLM-OK",
    patient_account_number: "PAT-OK",
    claim_status: "submitted",
  },
];

const MIXED_OUTCOME_277CA = [
  "ISA*00*          *00*          *ZZ*030240928      *ZZ*SBH2024        *260524*1234*^*00501*000099999*0*P*:",
  "GS*HN*030240928*SBH2024*20260524*1234*999*X*005010X214",
  "ST*277*0001*005010X214",
  "BHT*0085*08*BATCH-MIXED*20260524*1234*TH",
  "HL*1**20*1",
  "NM1*PR*2*AETNA*****PI*60054",
  "HL*2*1*21*1",
  "NM1*41*2*SBH*****46*SBH2024",
  "HL*3*2*19*1",
  "NM1*85*2*PRACTICE*****XX*1234567890",
  // Claim 1 — rejected (invalid subscriber)
  "HL*4*3*23",
  "NM1*QC*1*SMITH*JOHN",
  "TRN*2*PAT-MEM",
  "STC*A7:562:IL*20260524*U*100.00*******Subscriber not found",
  // Claim 2 — accepted
  "HL*5*3*23",
  "NM1*QC*1*JONES*JANE",
  "TRN*2*PAT-OK",
  "STC*A2:20:PR*20260524*A*200.00*******Accepted for processing",
  "SE*16*0001",
  "GE*1*999",
  "IEA*1*000099999",
].join("~") + "~";

type Row = Record<string, unknown>;

const claimUpdates: Array<{ ids: string[]; status: string }> = [];

function makeFakeSupabase() {
  type Q = {
    select(_c?: string): Q;
    insert(_p: unknown): Q;
    update(_p: unknown): Q;
    eq(col: string, val: unknown): Q;
    in(col: string, val: unknown): Q;
    is(col: string, val: unknown): Q;
    limit(_n: number): Q;
    single(): Promise<{ data: unknown; error: null }>;
    maybeSingle(): Promise<{ data: unknown; error: null }>;
    then(onFulfilled: (v: { data: unknown; error: null }) => unknown): Promise<unknown>;
  };

  const makeBuilder = (table: string): Q => {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;

    const finishSelect = () => {
      if (table === "edi_batches") {
        return {
          data: {
            id: BATCH_ID,
            organization_id: ORG,
            status: "submitted",
            transaction_type: "837P",
          },
          error: null,
        };
      }
      if (table === "edi_batch_claims") {
        return { data: CLAIM_ROWS.map((c) => ({ claim_id: c.id })), error: null };
      }
      if (table === "professional_claims") {
        const requested = (inFilters["id"] ?? []) as string[];
        const rows = CLAIM_ROWS.filter((r) => requested.includes(r.id));
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    };

    const q: Q = {
      select(_c?: string) {
        op = op === "insert" || op === "update" ? op : "select";
        return q;
      },
      insert(p: unknown) {
        op = "insert";
        payload = p as Row;
        return q;
      },
      update(p: unknown) {
        op = "update";
        payload = p as Row;
        return q;
      },
      eq(col, val) {
        filters[col] = val;
        return q;
      },
      in(col, vals) {
        inFilters[col] = vals as unknown[];
        return q;
      },
      is() {
        return q;
      },
      limit() {
        return q;
      },
      async single() {
        if (op === "insert" && table === "edi_acknowledgements") {
          return { data: { id: ACK_ID }, error: null };
        }
        return { data: null, error: null };
      },
      async maybeSingle() {
        const { data, error } = finishSelect();
        if (Array.isArray(data)) return { data: data[0] ?? null, error };
        return { data, error };
      },
      then(onFulfilled) {
        if (op === "update" && table === "professional_claims") {
          const ids = (inFilters["id"] ?? []) as string[];
          const status = String((payload as Row)?.claim_status ?? "");
          claimUpdates.push({ ids: [...ids], status });
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        }
        if (op === "insert" || op === "update") {
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        }
        return Promise.resolve(finishSelect()).then(onFulfilled);
      },
    };
    return q;
  };

  return {
    from(table: string) {
      return makeBuilder(table);
    },
  };
}

mock.module("@/lib/supabase/server", {
  namedExports: {
    createServerSupabaseAdminClient: () => makeFakeSupabase(),
  },
});

// Stub the workqueue routing — its internals are exercised by other
// tests. We only care here about per-claim status updates.
mock.module("@/lib/workqueue/claimRejectionWorkqueueService", {
  namedExports: {
    routeRejectedClaimsToWorkqueue: async () => ({
      ok: true,
      created: 0,
      skipped: 0,
      autoRouted: 0,
      errors: [],
    }),
  },
});

let intake277CAAcknowledgement: typeof import(
  "@/lib/claims/edi277caAcknowledgementService"
)["intake277CAAcknowledgement"];

describe("intake277CAAcknowledgement — per-claim outcome", () => {
  beforeEach(async () => {
    ({ intake277CAAcknowledgement } = await import(
      "@/lib/claims/edi277caAcknowledgementService"
    ));
    claimUpdates.length = 0;
  });

  it("tags each claim with its own STC outcome in a mixed batch", async () => {
    const result = await intake277CAAcknowledgement({
      organizationId: ORG,
      batchId: BATCH_ID,
      fileName: "mixed.277ca",
      rawContent: MIXED_OUTCOME_277CA,
    });

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.outcome, "partial");

    // Build a claimId → status map from the captured update calls.
    const finalStatus = new Map<string, string>();
    for (const upd of claimUpdates) {
      for (const id of upd.ids) finalStatus.set(id, upd.status);
    }

    assert.equal(
      finalStatus.get("claim-mem"),
      "rejected_payer",
      "rejected claim must be tagged rejected_payer, not the batch outcome",
    );
    assert.equal(
      finalStatus.get("claim-ok"),
      "accepted_payer",
      "accepted claim must be tagged accepted_payer",
    );
  });

  it("falls back to the batch outcome for claims with no matching ref", async () => {
    // 277CA whose TRNs don't match any linked claim → both claims must
    // still be flipped to the batch-level status (back-compat for older
    // acks that don't slice per claim).
    const NO_MATCH_277CA = [
      "ST*277*0001*005010X214",
      "BHT*0085*08*BATCH-MIXED*20260524*1234*TH",
      "HL*1**20*1",
      "NM1*PR*2*AETNA*****PI*60054",
      "HL*4*1*23",
      "TRN*2*UNKNOWN-TRN-A",
      "STC*A7:562:IL*20260524*U*100.00",
      "HL*5*1*23",
      "TRN*2*UNKNOWN-TRN-B",
      "STC*A7:562:IL*20260524*U*200.00",
      "SE*9*0001",
    ].join("~") + "~";

    const result = await intake277CAAcknowledgement({
      organizationId: ORG,
      batchId: BATCH_ID,
      fileName: "no-match.277ca",
      rawContent: NO_MATCH_277CA,
    });

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.outcome, "rejected");

    const finalStatus = new Map<string, string>();
    for (const upd of claimUpdates) {
      for (const id of upd.ids) finalStatus.set(id, upd.status);
    }
    assert.equal(finalStatus.get("claim-mem"), "rejected_payer");
    assert.equal(finalStatus.get("claim-ok"), "rejected_payer");
  });
});
