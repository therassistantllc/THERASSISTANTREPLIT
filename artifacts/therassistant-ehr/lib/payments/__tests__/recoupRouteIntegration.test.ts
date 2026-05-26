/**
 * Integration-style test for POST /api/billing/payments/posted/:id/recoup
 * (Task #176).
 *
 * Pins the route's wiring contract:
 *   - happy path → 200 with the recordRecoupment result echoed in the body
 *   - over-cap (recordRecoupment rejects with field='amount') → 409, not 500
 *
 * recordRecoupment + auth guard are module-mocked so the test is hermetic
 * and so the over-cap path exercises the route's status-code classifier
 * deterministically. The cap-math itself is covered in
 * postingEngine/__tests__/reversalEngine.test.ts and the dispatch wiring
 * in commitPostingRecoupmentDispatch.test.ts.
 */
import { test, before, mock } from "node:test";
import assert from "node:assert/strict";

const ORG = "11111111-1111-1111-1111-111111111111";
const ERA_ID = "22222222-2222-2222-2222-222222222222";

type RecoupCall = {
  organizationId: string;
  target: { kind: string; id: string };
  amount: number;
  reason: string;
  reasonCode: string | null;
  offsetEraClaimPaymentId: string | null;
};

const scenario: {
  result:
    | {
        ok: true;
        recoupmentId: string;
        ledgerEntryId: string;
        workqueueItemId: string;
        auditLogIds: string[];
        errors: never[];
      }
    | {
        ok: false;
        recoupmentId: null;
        ledgerEntryId: null;
        workqueueItemId: null;
        auditLogIds: never[];
        errors: Array<{ field: string; message: string }>;
      };
} = {
  result: {
    ok: true,
    recoupmentId: "rec-1",
    ledgerEntryId: "le-1",
    workqueueItemId: "wq-1",
    auditLogIds: ["aud-1"],
    errors: [],
  },
};

let lastRecoupCall: RecoupCall | null = null;

before(() => {
  // Stub auth so the route's role guard returns a system_dev actor in the
  // non-production test env without touching Supabase auth cookies.
  mock.module("@/lib/payments/postingEngine", {
    namedExports: {
      // Error classes the route imports — preserve names so `instanceof`
      // checks in the route catch block still work.
      PaymentPostingForbiddenError: class extends Error {
        readonly statusCode = 403;
        constructor(message?: string) {
          super(message ?? "forbidden");
          this.name = "PaymentPostingForbiddenError";
        }
      },
      PaymentPostingUnauthenticatedError: class extends Error {
        readonly statusCode = 401;
        constructor(message?: string) {
          super(message ?? "unauthenticated");
          this.name = "PaymentPostingUnauthenticatedError";
        }
      },
      requireAuthenticatedPaymentPoster: async (_org: string) => ({
        staffId: "staff-test",
        userId: "user-test",
        role: "biller",
        source: "test:recoup-route",
      }),
      recordRecoupment: async (input: RecoupCall) => {
        lastRecoupCall = input;
        return scenario.result;
      },
    },
  });
});

function postRequest(body: unknown): Request {
  return new Request("https://app.test/api/billing/payments/posted/x/recoup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loadPOST() {
  // path traverses `app/api/billing/payments/posted/[id]/recoup/route`
  const mod = await import(
    "../../../app/api/billing/payments/posted/[id]/recoup/route"
  );
  return mod.POST as (
    r: Request,
    ctx: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
}

test("happy path: posts a recoupment and echoes the engine result with 200", async () => {
  scenario.result = {
    ok: true,
    recoupmentId: "rec-happy",
    ledgerEntryId: "le-happy",
    workqueueItemId: "wq-happy",
    auditLogIds: ["aud-happy"],
    errors: [],
  };
  lastRecoupCall = null;

  const POST = await loadPOST();
  const res = await POST(
    postRequest({
      organizationId: ORG,
      amount: 25,
      reason: "Payer takeback per remit",
      reasonCode: "WO",
    }),
    { params: Promise.resolve({ id: `era:${ERA_ID}` }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    success: boolean;
    recoupmentId: string;
    ledgerEntryId: string;
    workqueueItemId: string;
  };
  assert.equal(body.success, true);
  assert.equal(body.recoupmentId, "rec-happy");
  assert.equal(body.ledgerEntryId, "le-happy");
  assert.equal(body.workqueueItemId, "wq-happy");

  // Route must thread the parsed composite id + body through to recordRecoupment.
  assert.ok(lastRecoupCall);
  const lastCall = lastRecoupCall as RecoupCall;
  assert.equal(lastCall?.organizationId, ORG);
  assert.deepEqual(lastCall?.target, { kind: "era_835", id: ERA_ID });
  assert.equal(lastCall?.amount, 25);
  assert.equal(lastCall?.reason, "Payer takeback per remit");
  assert.equal(lastCall?.reasonCode, "WO");
});

test("over-cap rejection: amount-field error must return 409 (not 500)", async () => {
  scenario.result = {
    ok: false,
    recoupmentId: null,
    ledgerEntryId: null,
    workqueueItemId: null,
    auditLogIds: [],
    errors: [
      {
        field: "amount",
        message:
          "Recoupment 500.00 exceeds remaining recoupable balance 100.00 (original 100.00, prior recoups 0.00, prior refunds 0.00).",
      },
    ],
  };

  const POST = await loadPOST();
  const res = await POST(
    postRequest({
      organizationId: ORG,
      amount: 500,
      reason: "Over the cap",
    }),
    { params: Promise.resolve({ id: `era:${ERA_ID}` }) },
  );
  // 409 = caller can retry with a corrected amount. 500 would page the
  // on-call engineer for what is actually a normal validation outcome.
  assert.equal(res.status, 409);
  const body = (await res.json()) as {
    success: boolean;
    errors: Array<{ field: string; message: string }>;
  };
  assert.equal(body.success, false);
  assert.equal(body.errors[0].field, "amount");
  assert.match(body.errors[0].message, /exceeds remaining recoupable/);
});

test("rejects request with missing organizationId before invoking the engine", async () => {
  lastRecoupCall = null;
  const POST = await loadPOST();
  const res = await POST(
    postRequest({ amount: 10, reason: "x" }),
    { params: Promise.resolve({ id: `era:${ERA_ID}` }) },
  );
  assert.equal(res.status, 400);
  // Engine must not have been called when the input was malformed.
  assert.equal(lastRecoupCall, null);
});

test("rejects malformed composite id (no valid UUID suffix)", async () => {
  lastRecoupCall = null;
  const POST = await loadPOST();
  const res = await POST(
    postRequest({ organizationId: ORG, amount: 10, reason: "x" }),
    { params: Promise.resolve({ id: "era:not-a-uuid" }) },
  );
  assert.equal(res.status, 400);
  assert.equal(lastRecoupCall, null);
});
