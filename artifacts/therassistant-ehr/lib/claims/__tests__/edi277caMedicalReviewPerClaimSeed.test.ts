// Per-claim attribution test for the 277CA → Medical Review auto-seed.
// A single 277CA batch with TWO claims where only ONE claim carries
// a documentation-request STC must seed a medical_review_requested
// audit row for that ONE claim — not for both.

import { describe, it, beforeEach, mock } from "node:test";
import { strict as assert } from "node:assert";

const ORG = "11111111-1111-1111-1111-111111111111";
const BATCH_ID = "batch-doc-req";
const ACK_ID = "ack-doc-req";

// Two linked claims. PAT-DOC carries the doc-request STC (A6:287);
// PAT-CLEAN carries a plain accept (A2:20) and must NOT get a row.
const CLAIM_ROWS = [
  {
    id: "claim-doc",
    patient_id: "patient-doc",
    appointment_id: "appt-doc",
    claim_number: "CLM-DOC",
    patient_account_number: "PAT-DOC",
    claim_status: "submitted",
  },
  {
    id: "claim-clean",
    patient_id: "patient-clean",
    appointment_id: "appt-clean",
    claim_number: "CLM-CLEAN",
    patient_account_number: "PAT-CLEAN",
    claim_status: "submitted",
  },
];

const MIXED_DOC_REQUEST_277CA = [
  "ISA*00*          *00*          *ZZ*030240928      *ZZ*SBH2024        *260524*1234*^*00501*000099999*0*P*:",
  "GS*HN*030240928*SBH2024*20260524*1234*999*X*005010X214",
  "ST*277*0001*005010X214",
  "BHT*0085*08*BATCH-DOC*20260524*1234*TH",
  "HL*1**20*1",
  "NM1*PR*2*AETNA*****PI*60054",
  "HL*2*1*21*1",
  "NM1*41*2*SBH*****46*SBH2024",
  "HL*3*2*19*1",
  "NM1*85*2*PRACTICE*****XX*1234567890",
  // Claim 1 — payer asking for records (A6:287)
  "HL*4*3*23",
  "NM1*QC*1*SMITH*JOHN",
  "TRN*2*PAT-DOC",
  "STC*A6:287:PR*20260524*U*100.00*******Need additional documentation",
  // Claim 2 — plain accept, NOT a doc request
  "HL*5*3*23",
  "NM1*QC*1*JONES*JANE",
  "TRN*2*PAT-CLEAN",
  "STC*A2:20:PR*20260524*A*200.00*******Accepted for processing",
  "SE*16*0001",
  "GE*1*999",
  "IEA*1*000099999",
].join("~") + "~";

type Row = Record<string, unknown>;

const insertedAuditRows: Row[] = [];
const insertedAcks: Row[] = [];

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
    let isOpenStatusCheck = false;

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
      if (table === "audit_logs") {
        // Dedupe lookup — match by org + action + claim_id.
        const matched = insertedAuditRows.filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: matched, error: null };
      }
      if (table === "workqueue_items") {
        if (isOpenStatusCheck) return { data: null, error: null };
        return { data: null, error: null };
      }
      if (table === "system_settings") return { data: null, error: null };
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
      update(_p: unknown) {
        op = "update";
        return q;
      },
      eq(col, val) {
        filters[col] = val;
        return q;
      },
      in(col, vals) {
        inFilters[col] = vals as unknown[];
        if (col === "status") isOpenStatusCheck = true;
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
          const row = { ...(payload as Row), id: ACK_ID };
          insertedAcks.push(row);
          return { data: { id: ACK_ID }, error: null };
        }
        return { data: null, error: null };
      },
      async maybeSingle() {
        const { data, error } = finishSelect();
        // maybeSingle returns single row or null
        if (Array.isArray(data)) return { data: data[0] ?? null, error };
        return { data, error };
      },
      then(onFulfilled) {
        if (op === "insert") {
          if (table === "audit_logs") {
            insertedAuditRows.push({
              ...(payload as Row),
              id: `audit-${insertedAuditRows.length + 1}`,
            });
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        }
        if (op === "update") {
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
// tests and would require their own fake schema. We only care that
// the medical-review seeding block attributes per-claim.
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

describe("intake277CAAcknowledgement — per-claim medical-review seeding", () => {
  beforeEach(async () => {
    ({ intake277CAAcknowledgement } = await import(
      "@/lib/claims/edi277caAcknowledgementService"
    ));
    insertedAuditRows.length = 0;
    insertedAcks.length = 0;
  });

  it("seeds a medical_review_requested row for ONLY the claim whose TRN carried the doc-request STC", async () => {
    const result = await intake277CAAcknowledgement({
      organizationId: ORG,
      batchId: BATCH_ID,
      fileName: "doc-req.277ca",
      rawContent: MIXED_DOC_REQUEST_277CA,
    });

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    // The batch carries an accept and a doc-request → overall partial.
    assert.equal(result.outcome, "partial");

    // Only ONE audit row, and it must be for the claim with the doc-request TRN.
    assert.equal(
      insertedAuditRows.length,
      1,
      `expected exactly 1 medical-review audit row, got ${insertedAuditRows.length}`,
    );

    const row = insertedAuditRows[0];
    assert.equal(row.action, "medical_review_requested");
    assert.equal(row.claim_id, "claim-doc");
    assert.equal(row.patient_id, "patient-doc");
    assert.equal(row.appointment_id, "appt-doc");

    const meta = row.event_metadata as Record<string, unknown>;
    assert.equal(meta.origin, "277CA");
    assert.equal(meta.sourceObjectId, ACK_ID);
    assert.ok(
      Array.isArray(meta.triggerCodes) && (meta.triggerCodes as string[]).includes("A6:287"),
      "trigger codes must include A6:287",
    );
  });

  it("does not seed the queue when no per-claim STC asks for documentation", async () => {
    const ALL_CLEAN = [
      "ST*277*0001*005010X214",
      "BHT*0085*08*BATCH-CLEAN*20260524*1234*TH",
      "HL*1**20*1",
      "NM1*PR*2*AETNA*****PI*60054",
      "HL*4*1*23",
      "TRN*2*PAT-DOC",
      "STC*A2:20:PR*20260524*A*100.00",
      "HL*5*1*23",
      "TRN*2*PAT-CLEAN",
      "STC*A2:20:PR*20260524*A*200.00",
      "SE*9*0001",
    ].join("~") + "~";

    const result = await intake277CAAcknowledgement({
      organizationId: ORG,
      batchId: BATCH_ID,
      fileName: "clean.277ca",
      rawContent: ALL_CLEAN,
    });

    assert.equal(result.ok, true);
    assert.equal(insertedAuditRows.length, 0, "no doc-request STCs → no audit rows");
  });
});
