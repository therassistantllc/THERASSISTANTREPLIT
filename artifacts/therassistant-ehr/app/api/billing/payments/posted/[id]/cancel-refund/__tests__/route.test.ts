/**
 * Route-level coverage for POST /api/billing/payments/posted/:id/cancel-refund.
 *
 * The engine (`cancelPendingRefund`) has its own unit tests against a fake
 * supabase. This file pins the things only the route layer can break:
 *   - composite-id parsing (era:|cp:|mi: + UUID) is enforced BEFORE the
 *     engine is called, so a malformed id is a 400 not a 500
 *   - body validation: organizationId required (400), refundId must be UUID
 *     (400), reason required (400 — must be the route's pre-check, not the
 *     engine, so the engine is never reached with empty input)
 *   - auth guard: PaymentPostingUnauthenticatedError → 401,
 *     PaymentPostingForbiddenError (cross-org) → 403
 *   - status-code mapping for engine results:
 *       reason error                  → 400
 *       refund_status / refund_type   → 409 (already-issued, wrong org row)
 *       anything else (db, system)    → 500
 *   - happy path: 200 with success:true and the engine result spread in
 */
import { strict as assert } from "node:assert";
import { before, beforeEach, mock, test } from "node:test";

type EngineInput = {
  organizationId: string;
  refundId: string;
  reason: string;
  actor: unknown;
};
type EngineResult = {
  ok: boolean;
  refundId: string | null;
  refundStatus: "cancelled" | null;
  workqueueItemClosed: boolean;
  auditLogIds: string[];
  errors: Array<{ field: string; message: string }>;
};

const scenario: {
  authMode: "ok" | "unauthenticated" | "forbidden";
  engineCalls: EngineInput[];
  engineResult: EngineResult;
} = {
  authMode: "ok",
  engineCalls: [],
  engineResult: {
    ok: true,
    refundId: null,
    refundStatus: "cancelled",
    workqueueItemClosed: true,
    auditLogIds: ["audit-1"],
    errors: [],
  },
};

class PaymentPostingForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message = "You do not have permission to post payments.") {
    super(message);
    this.name = "PaymentPostingForbiddenError";
  }
}
class PaymentPostingUnauthenticatedError extends Error {
  readonly statusCode = 401;
  constructor(message = "Authentication required to post payments.") {
    super(message);
    this.name = "PaymentPostingUnauthenticatedError";
  }
}

before(() => {
  mock.module("@/lib/payments/postingEngine", {
    namedExports: {
      PaymentPostingForbiddenError,
      PaymentPostingUnauthenticatedError,
      requireAuthenticatedPaymentPoster: async (orgId: string) => {
        if (scenario.authMode === "unauthenticated") {
          throw new PaymentPostingUnauthenticatedError();
        }
        if (scenario.authMode === "forbidden") {
          throw new PaymentPostingForbiddenError(
            "You cannot post payments for a different organization.",
          );
        }
        return {
          staffId: "staff-1",
          userId: "user-1",
          role: "biller",
          source: "api:authenticated_staff",
          organizationId: orgId,
        };
      },
      cancelPendingRefund: async (input: EngineInput) => {
        scenario.engineCalls.push(input);
        return scenario.engineResult;
      },
    },
  });
});

beforeEach(() => {
  scenario.authMode = "ok";
  scenario.engineCalls = [];
  scenario.engineResult = {
    ok: true,
    refundId: "11111111-1111-1111-1111-111111111111",
    refundStatus: "cancelled",
    workqueueItemClosed: true,
    auditLogIds: ["audit-1"],
    errors: [],
  };
});

type PostHandler = (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

async function loadHandler(): Promise<PostHandler> {
  const mod = await import("../route");
  return mod.POST as PostHandler;
}

function call(
  id: string,
  body: Record<string, unknown> | string,
): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  const req = new Request(
    `https://app.test/api/billing/payments/posted/${id}/cancel-refund`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
  return { req, ctx: { params: Promise.resolve({ id }) } };
}

const REFUND_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COMPOSITE_ID = "era:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

test("happy path: forwards to engine and returns 200 with spread result", async () => {
  const POST = await loadHandler();
  const { req, ctx } = call(COMPOSITE_ID, {
    organizationId: "org-1",
    refundId: REFUND_ID,
    reason: "Opened in error",
  });
  const res = await POST(req, ctx);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.success, true);
  assert.equal(body.refundStatus, "cancelled");
  assert.equal(body.workqueueItemClosed, true);

  // Engine was called exactly once with the parsed body — note the route
  // passes the trimmed reason and the resolved actor.
  assert.equal(scenario.engineCalls.length, 1);
  const e = scenario.engineCalls[0];
  assert.equal(e.organizationId, "org-1");
  assert.equal(e.refundId, REFUND_ID);
  assert.equal(e.reason, "Opened in error");
  assert.ok(e.actor, "actor must be threaded through to the engine");
});

test("400 when organizationId is missing (never reaches engine)", async () => {
  const POST = await loadHandler();
  const { req, ctx } = call(COMPOSITE_ID, {
    refundId: REFUND_ID,
    reason: "x",
  });
  const res = await POST(req, ctx);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { success: boolean; error: string };
  assert.equal(body.success, false);
  assert.match(body.error, /organizationId/i);
  assert.equal(scenario.engineCalls.length, 0);
});

test("400 when reason is missing or blank (never reaches engine)", async () => {
  const POST = await loadHandler();
  for (const reason of [undefined, "", "   "]) {
    scenario.engineCalls = [];
    const { req, ctx } = call(COMPOSITE_ID, {
      organizationId: "org-1",
      refundId: REFUND_ID,
      reason,
    });
    const res = await POST(req, ctx);
    assert.equal(res.status, 400, `reason=${JSON.stringify(reason)}`);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /reason/i);
    assert.equal(
      scenario.engineCalls.length,
      0,
      "the engine must NOT be invoked when reason validation fails at the route layer",
    );
  }
});

test("400 when refundId is not a UUID", async () => {
  const POST = await loadHandler();
  const { req, ctx } = call(COMPOSITE_ID, {
    organizationId: "org-1",
    refundId: "not-a-uuid",
    reason: "x",
  });
  const res = await POST(req, ctx);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /refundId/);
  assert.equal(scenario.engineCalls.length, 0);
});

test("400 for malformed composite ids (bad prefix, missing colon, bad UUID)", async () => {
  const POST = await loadHandler();
  const bads = [
    "no-colon-here",
    "xx:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", // unknown prefix
    "era:not-a-uuid",
    ":bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", // empty prefix
  ];
  for (const id of bads) {
    scenario.engineCalls = [];
    const { req, ctx } = call(id, {
      organizationId: "org-1",
      refundId: REFUND_ID,
      reason: "x",
    });
    const res = await POST(req, ctx);
    assert.equal(res.status, 400, `id=${id}`);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Invalid posted-payment id/);
    assert.equal(scenario.engineCalls.length, 0, `engine called for id=${id}`);
  }
});

test("401 when the auth guard rejects as unauthenticated", async () => {
  scenario.authMode = "unauthenticated";
  const POST = await loadHandler();
  const { req, ctx } = call(COMPOSITE_ID, {
    organizationId: "org-1",
    refundId: REFUND_ID,
    reason: "x",
  });
  const res = await POST(req, ctx);
  assert.equal(res.status, 401);
  assert.equal(scenario.engineCalls.length, 0);
});

test("403 when the auth guard rejects as cross-org / forbidden", async () => {
  scenario.authMode = "forbidden";
  const POST = await loadHandler();
  const { req, ctx } = call(COMPOSITE_ID, {
    organizationId: "org-OTHER",
    refundId: REFUND_ID,
    reason: "x",
  });
  const res = await POST(req, ctx);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /different organization/i);
  assert.equal(scenario.engineCalls.length, 0);
});

test("409 when the engine reports the refund is already issued / wrong-org / client refund", async () => {
  scenario.engineResult = {
    ok: false,
    refundId: null,
    refundStatus: null,
    workqueueItemClosed: false,
    auditLogIds: [],
    errors: [
      {
        field: "refund_status",
        message:
          "Refund could not be cancelled — not found, already issued/cancelled, not an insurance refund, or wrong org.",
      },
    ],
  };
  const POST = await loadHandler();
  const { req, ctx } = call(COMPOSITE_ID, {
    organizationId: "org-1",
    refundId: REFUND_ID,
    reason: "too late",
  });
  const res = await POST(req, ctx);
  assert.equal(res.status, 409);
  const body = (await res.json()) as {
    success: boolean;
    errors: Array<{ field: string }>;
  };
  assert.equal(body.success, false);
  assert.equal(body.errors[0].field, "refund_status");
});

test("400 (not 409) when the engine reports a reason-field error", async () => {
  // The route lets the engine's own reason validation collapse to a 400 so
  // the UI surfaces it as a form error, not a conflict.
  scenario.engineResult = {
    ok: false,
    refundId: null,
    refundStatus: null,
    workqueueItemClosed: false,
    auditLogIds: [],
    errors: [{ field: "reason", message: "Cancellation reason is required." }],
  };
  const POST = await loadHandler();
  const { req, ctx } = call(COMPOSITE_ID, {
    organizationId: "org-1",
    refundId: REFUND_ID,
    reason: "x",
  });
  const res = await POST(req, ctx);
  assert.equal(res.status, 400);
});

test("500 when the engine reports a non-client error (db / system)", async () => {
  scenario.engineResult = {
    ok: false,
    refundId: null,
    refundStatus: null,
    workqueueItemClosed: false,
    auditLogIds: [],
    errors: [{ field: "payment_refunds", message: "connection reset" }],
  };
  const POST = await loadHandler();
  const { req, ctx } = call(COMPOSITE_ID, {
    organizationId: "org-1",
    refundId: REFUND_ID,
    reason: "x",
  });
  const res = await POST(req, ctx);
  assert.equal(res.status, 500);
  const body = (await res.json()) as {
    success: boolean;
    errors: Array<{ field: string }>;
  };
  assert.equal(body.success, false);
  assert.equal(body.errors[0].field, "payment_refunds");
});
