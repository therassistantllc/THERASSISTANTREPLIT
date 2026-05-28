/**
 * POST /api/billing/stripe-connect/webhook
 *
 * Stripe Connect webhook receiver for events delivered against the
 * platform's Connect application. Handles three event types:
 *
 *   - account.updated              → refresh provider connect status
 *   - payment_intent.succeeded     → auto-post copay to client ledger
 *   - payment_intent.payment_failed → workqueue review row
 *
 * Verification mirrors the existing client-card stripe-webhook handler
 * (HMAC-SHA256 of `${t}.${rawBody}` with STRIPE_CONNECT_WEBHOOK_SECRET).
 * Idempotency on copay posting is provided by the existing unique index
 * on (organization_id, payment_method='stripe', external_payment_id).
 *
 * Connect events include an `account` field that names the connected
 * account the event originated on. We persist it on the client_payments
 * row (stripe_connected_account_id) so future refunds can include the
 * required Stripe-Account header.
 */
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  commitPatientPayment,
  type PatientPaymentApplyTo,
  type PostingActor,
} from "@/lib/payments/postingEngine";
import { getStripeConnectWebhookSecret } from "@/lib/stripe/connect";

const REPLAY_WINDOW_SECONDS = 300;

const WEBHOOK_ACTOR: PostingActor = {
  staffId: null,
  userId: null,
  role: "system",
  source: "service:stripe-connect-webhook",
};

interface StripeEvent {
  id?: string;
  type?: string;
  account?: string;
  data?: { object?: Record<string, unknown> };
}

function verifyStripeSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim());
  let timestamp: string | null = null;
  const sigs: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === "t") timestamp = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!timestamp || sigs.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_SECONDS) return false;
  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signedPayload).digest();
  for (const sig of sigs) {
    let provided: Buffer;
    try {
      provided = Buffer.from(sig, "hex");
    } catch {
      continue;
    }
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

async function handleAccountUpdated(event: StripeEvent): Promise<NextResponse> {
  const account = event.data?.object as
    | {
        id?: string;
        charges_enabled?: boolean;
        payouts_enabled?: boolean;
        details_submitted?: boolean;
        requirements?: unknown;
      }
    | undefined;
  if (!account?.id) return NextResponse.json({ success: true, ignored: true });
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 503 });
  }
  const { error } = await supabase
    .from("provider_credentialing_profiles")
    .update({
      stripe_charges_enabled: Boolean(account.charges_enabled),
      stripe_payouts_enabled: Boolean(account.payouts_enabled),
      stripe_details_submitted: Boolean(account.details_submitted),
      stripe_requirements: account.requirements ?? null,
      stripe_account_status_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_connect_account_id", account.id);
  if (error) {
    console.error("[connect-webhook] account.updated persist failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 503 });
  }
  return NextResponse.json({ success: true, type: "account.updated", account: account.id });
}

async function writeReviewRow(
  reason: string,
  ctx: {
    organizationId: string | null;
    clientId: string | null;
    appointmentId: string | null;
    providerId: string | null;
    chargeId: string | null;
    paymentIntentId: string | null;
    amountCents: number;
    connectedAccountId: string | null;
  },
): Promise<boolean> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase || !ctx.organizationId) {
    console.error("[connect-webhook] cannot create workqueue (no org):", reason, ctx);
    return false;
  }
  const dollars = (ctx.amountCents / 100).toFixed(2);
  const labelRef = ctx.chargeId ?? ctx.paymentIntentId ?? "unknown";
  const syntheticId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  const { error } = await supabase.from("workqueue_items").insert({
    organization_id: ctx.organizationId,
    client_id: ctx.clientId,
    work_type: "patient_payment_review",
    status: "open",
    priority: "high",
    title: `Review Stripe Connect copay $${dollars} (${labelRef})`,
    description: `Stripe Connect webhook could not auto-post: ${reason}. Charge=${ctx.chargeId ?? "n/a"}, PI=${ctx.paymentIntentId ?? "n/a"}, Appt=${ctx.appointmentId ?? "n/a"}, Account=${ctx.connectedAccountId ?? "n/a"}.`,
    source_object_type: "payment_posting",
    source_object_id: syntheticId,
    context_payload: {
      origin: "stripe_connect_webhook",
      reason,
      stripe_charge_id: ctx.chargeId,
      stripe_payment_intent_id: ctx.paymentIntentId,
      stripe_connected_account_id: ctx.connectedAccountId,
      provider_id: ctx.providerId,
      appointment_id: ctx.appointmentId,
      amount_cents: ctx.amountCents,
    },
  });
  if (error) {
    console.error("[connect-webhook] failed to write workqueue item:", error.message);
    return false;
  }
  return true;
}

async function handlePaymentIntentSucceeded(event: StripeEvent): Promise<NextResponse> {
  const pi = event.data?.object as
    | {
        id?: string;
        amount?: number;
        amount_received?: number;
        currency?: string;
        latest_charge?: string | { id?: string };
        charges?: { data?: Array<{ id?: string; metadata?: Record<string, string> }> };
        metadata?: Record<string, string>;
      }
    | undefined;
  if (!pi) return NextResponse.json({ success: false, error: "missing object" }, { status: 400 });

  const chargeId =
    typeof pi.latest_charge === "string"
      ? pi.latest_charge
      : pi.latest_charge?.id ?? pi.charges?.data?.[0]?.id ?? null;
  const paymentIntentId = pi.id ?? null;
  const amountCents = Number(pi.amount_received ?? pi.amount ?? 0);
  const metadata = pi.metadata ?? pi.charges?.data?.[0]?.metadata ?? {};
  const connectedAccountId = event.account ?? null;

  if (!chargeId) {
    return NextResponse.json({
      success: true,
      deferred: true,
      reason: "payment_intent.succeeded had no resolvable charge id; waiting for charge event",
    });
  }

  const organizationId = (metadata.organization_id ?? "").trim() || null;
  const clientId = (metadata.client_id ?? "").trim() || null;
  const providerId = (metadata.provider_id ?? "").trim() || null;
  const appointmentId = (metadata.appointment_id ?? "").trim() || null;
  const amountDollars = Math.round(amountCents) / 100;

  if (!organizationId || !clientId) {
    const queued = await writeReviewRow("Connect event missing organization_id or client_id metadata", {
      organizationId,
      clientId,
      appointmentId,
      providerId,
      chargeId,
      paymentIntentId,
      amountCents,
      connectedAccountId,
    });
    if (!queued) {
      return NextResponse.json({ success: false, error: "Could not record review item" }, { status: 503 });
    }
    return NextResponse.json({ success: false, queuedForReview: true });
  }

  const applyTo: PatientPaymentApplyTo = appointmentId
    ? { kind: "encounter", appointmentId }
    : { kind: "account_balance" };

  try {
    const result = await commitPatientPayment({
      organizationId,
      clientId,
      amount: amountDollars,
      method: "stripe",
      applyTo,
      externalPaymentId: chargeId,
      stripeChargeId: chargeId,
      stripeConnectedAccountId: connectedAccountId,
      referenceNumber: paymentIntentId,
      note: `Auto-posted by Stripe Connect webhook (event ${event.id ?? "?"})`,
      actor: WEBHOOK_ACTOR,
    });
    if (result.ok) {
      return NextResponse.json({
        success: true,
        alreadyPosted: result.alreadyPosted,
        paymentId: result.paymentId,
      });
    }
    const summary = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ") || "Unknown commit failure";
    const queued = await writeReviewRow(`commitPatientPayment failed: ${summary}`, {
      organizationId,
      clientId,
      appointmentId,
      providerId,
      chargeId,
      paymentIntentId,
      amountCents,
      connectedAccountId,
    });
    if (!queued) {
      return NextResponse.json(
        { success: false, error: "Could not record review item", errors: result.errors },
        { status: 503 },
      );
    }
    return NextResponse.json({ success: false, queuedForReview: true, errors: result.errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const queued = await writeReviewRow(`Unexpected error: ${message}`, {
      organizationId,
      clientId,
      appointmentId,
      providerId,
      chargeId,
      paymentIntentId,
      amountCents,
      connectedAccountId,
    });
    if (!queued) {
      return NextResponse.json(
        { success: false, error: `Failed to record review. Original: ${message}` },
        { status: 503 },
      );
    }
    return NextResponse.json({ success: false, queuedForReview: true, error: message });
  }
}

async function handlePaymentIntentFailed(event: StripeEvent): Promise<NextResponse> {
  const pi = event.data?.object as
    | { id?: string; amount?: number; metadata?: Record<string, string>; last_payment_error?: { message?: string } }
    | undefined;
  if (!pi) return NextResponse.json({ success: false, error: "missing object" }, { status: 400 });
  const meta = pi.metadata ?? {};
  const queued = await writeReviewRow(
    `Stripe payment_intent.payment_failed: ${pi.last_payment_error?.message ?? "no error message"}`,
    {
      organizationId: (meta.organization_id ?? "").trim() || null,
      clientId: (meta.client_id ?? "").trim() || null,
      providerId: (meta.provider_id ?? "").trim() || null,
      appointmentId: (meta.appointment_id ?? "").trim() || null,
      chargeId: null,
      paymentIntentId: pi.id ?? null,
      amountCents: Number(pi.amount ?? 0),
      connectedAccountId: event.account ?? null,
    },
  );
  if (!queued) {
    return NextResponse.json({ success: false, error: "Could not record review item" }, { status: 503 });
  }
  return NextResponse.json({ success: true, queuedForReview: true });
}

export async function POST(request: Request) {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ success: false, error: "Could not read body" }, { status: 400 });
  }
  const secret = getStripeConnectWebhookSecret();
  if (!secret) {
    return NextResponse.json(
      { success: false, error: "STRIPE_CONNECT_WEBHOOK_SECRET not configured" },
      { status: 503 },
    );
  }
  if (!verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), secret)) {
    return NextResponse.json({ success: false, error: "Invalid signature" }, { status: 401 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  const type = String(event.type ?? "");
  if (type === "account.updated") return handleAccountUpdated(event);
  if (type === "payment_intent.succeeded") return handlePaymentIntentSucceeded(event);
  if (type === "payment_intent.payment_failed") return handlePaymentIntentFailed(event);
  return NextResponse.json({ success: true, ignored: true, type });
}
