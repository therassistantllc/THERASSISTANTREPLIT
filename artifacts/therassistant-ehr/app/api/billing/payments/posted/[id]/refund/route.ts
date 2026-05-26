/**
 * POST /api/billing/payments/posted/:id/refund
 *
 * Records an insurance refund OR a patient refund against a posted payment.
 * `refundType` defaults to the natural fit for the source (client_payment →
 * patient; era_835/insurance_manual → insurance). Stripe issuance is
 * handled outside this route (Task #114 webhook); callers that have
 * already issued via Stripe may pass `stripeRefundId` + `alreadyIssued`.
 *
 * When `dryRun: true` is passed in the body, the engine runs all
 * validation + the same reads it would do live, returns a `preview`
 * (projected remaining balance, compensating ledger entry, invoice
 * delta, Stripe issuance plan, workqueue follow-up) and writes NOTHING
 * to the DB. The dashboard uses this to render a confirm-modal before
 * money actually moves (Task #168).
 */
import { NextResponse } from "next/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  recordInsuranceRefund,
  recordPatientRefund,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";
import type { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { parseCompositePostedPaymentId as parseCompositeId } from "../_compositeId";

interface Body {
  organizationId?: string;
  refundType?: "insurance" | "patient";
  amount?: number;
  reason?: string;
  stripeRefundId?: string | null;
  alreadyIssued?: boolean;
  dryRun?: boolean;
}

type SupabaseAdmin = NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>;

/** Injectable dependencies so the processor is unit-testable end-to-end. */
export interface RefundRouteDeps {
  requireAuth: typeof requireAuthenticatedPaymentPoster;
  recordInsuranceRefund: typeof recordInsuranceRefund;
  recordPatientRefund: typeof recordPatientRefund;
  /** Optional injected supabase client — forwarded to the engine handlers. */
  supabase?: SupabaseAdmin | null;
}

export const defaultRefundRouteDeps: RefundRouteDeps = {
  requireAuth: requireAuthenticatedPaymentPoster,
  recordInsuranceRefund,
  recordPatientRefund,
};

/**
 * Testable inner pipeline. Returns `{ status, payload }` so the POST
 * wrapper can keep concerns separated. Throws auth errors so the
 * wrapper can map them to 401/403 cleanly.
 */
export async function processRefundRequest(
  rawId: string,
  body: Body,
  deps: RefundRouteDeps = defaultRefundRouteDeps,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const organizationId = body.organizationId ? String(body.organizationId) : "";
  if (!organizationId) {
    return {
      status: 400,
      payload: { success: false, error: "organizationId is required" },
    };
  }
  const target = parseCompositeId(rawId);
  if (!target) {
    return {
      status: 400,
      payload: {
        success: false,
        error: "Invalid posted-payment id (expected era:|cp:|mi: prefix)",
      },
    };
  }
  const actor = await deps.requireAuth(organizationId);
  const refundType: "insurance" | "patient" =
    body.refundType ?? (target.kind === "client_payment" ? "patient" : "insurance");
  const fn =
    refundType === "patient" ? deps.recordPatientRefund : deps.recordInsuranceRefund;
  const result = await fn(
    {
      organizationId,
      target,
      amount: Number(body.amount ?? 0),
      reason: String(body.reason ?? "").trim(),
      stripeRefundId: body.stripeRefundId ?? null,
      alreadyIssued: body.alreadyIssued === true,
      dryRun: Boolean(body.dryRun),
      actor,
    },
    deps.supabase ?? undefined,
  );
  if (!result.ok) {
    const isClientError = result.errors.some((e) =>
      ["amount", "reason", "target.kind", "posting_status", target.kind].includes(e.field),
    );
    return {
      status: isClientError ? 409 : 500,
      payload: { success: false, ...result },
    };
  }
  return { status: 200, payload: { success: true, ...result } };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Body;
    const { status, payload } = await processRefundRequest(rawId, body);
    return NextResponse.json(payload, { status });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError)
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    if (error instanceof PaymentPostingForbiddenError)
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    console.error("Refund posted-payment API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to record refund" },
      { status: 500 },
    );
  }
}
