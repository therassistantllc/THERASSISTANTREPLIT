/**
 * POST /api/billing/payments/stripe-webhook
 *
 * Stripe webhook receiver for patient card payments (Task #114). Verifies
 * `Stripe-Signature` (HMAC-SHA256 over `${t}.${rawBody}` with
 * STRIPE_WEBHOOK_SECRET), then routes `payment_intent.succeeded` and
 * `charge.succeeded` events through `commitPatientPayment`. Idempotency
 * is handled by the existing unique index on
 * (organization_id, payment_method, external_payment_id) — we pass the
 * Stripe charge id as `externalPaymentId` so retries collapse into the
 * same client_payments row.
 *
 * Failure handling:
 *   - Signature invalid → 401 (Stripe will retry).
 *   - Missing secret → 503 (Stripe will retry).
 *   - Unknown event type → 200 acknowledged + ignored.
 *   - Missing org/client metadata or commit error → write a workqueue_items
 *     row for biller review and return 200 (so Stripe does not retry
 *     indefinitely; the WQ row is the source of truth for follow-up).
 *
 * Stripe Checkout / PaymentIntents must include these metadata fields:
 *   - metadata.organization_id   (required)
 *   - metadata.client_id         (required)
 *   - metadata.patient_invoice_id (optional, but enables auto-apply)
 *   - metadata.professional_claim_id (optional)
 *
 * Operator runbook (setting STRIPE_WEBHOOK_SECRET, choosing events,
 * required metadata, and how to recover a queued-for-review row):
 *   ../../../../../STRIPE_WEBHOOK_RUNBOOK.md
 *   (repo path: artifacts/therassistant-ehr/STRIPE_WEBHOOK_RUNBOOK.md)
 */
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  commitPatientPayment,
  type PatientPaymentApplyTo,
  type PostingActor,
} from "@/lib/payments/postingEngine";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

const WEBHOOK_ACTOR: PostingActor = {
  staffId: null,
  userId: null,
  role: "system",
  source: "service:stripe-webhook",
};

// Reject events older than 5 minutes to bound replay risk (Stripe's
// recommended default).
const REPLAY_WINDOW_SECONDS = 300;

interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

interface StripeChargeLike {
  id?: string;
  amount?: number;
  amount_refunded?: number;
  currency?: string;
  payment_intent?: string;
  metadata?: Record<string, string>;
  status?: string;
}

interface StripePaymentIntentLike {
  id?: string;
  amount?: number;
  amount_received?: number;
  currency?: string;
  latest_charge?: string | { id?: string };
  charges?: { data?: StripeChargeLike[] };
  metadata?: Record<string, string>;
  status?: string;
}

/**
 * Verify the `Stripe-Signature` header. The header format is
 * `t=<unix>,v1=<hex>[,v1=<hex>...]` and the signed payload is
 * `${t}.${rawBody}` HMAC-SHA256 with the webhook secret.
 */
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
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_SECONDS) {
    return false;
  }
  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signedPayload).digest();
  for (const sig of sigs) {
    let provided: Buffer;
    try {
      provided = Buffer.from(sig, "hex");
    } catch {
      continue;
    }
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return false;
}

/** Pull (chargeId, paymentIntentId, amountCents, metadata) from either event shape. */
function extractPaymentDetails(event: StripeEvent): {
  chargeId: string | null;
  paymentIntentId: string | null;
  amountCents: number;
  metadata: Record<string, string>;
} | null {
  const obj = event.data?.object as Record<string, unknown> | undefined;
  if (!obj) return null;

  if (event.type === "charge.succeeded") {
    const ch = obj as StripeChargeLike;
    return {
      chargeId: ch.id ?? null,
      paymentIntentId: typeof ch.payment_intent === "string" ? ch.payment_intent : null,
      amountCents: Number(ch.amount ?? 0),
      metadata: ch.metadata ?? {},
    };
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = obj as StripePaymentIntentLike;
    let chargeId: string | null = null;
    if (typeof pi.latest_charge === "string") chargeId = pi.latest_charge;
    else if (pi.latest_charge && typeof pi.latest_charge === "object") chargeId = pi.latest_charge.id ?? null;
    else if (pi.charges?.data && pi.charges.data.length > 0) chargeId = pi.charges.data[0]?.id ?? null;
    return {
      chargeId,
      paymentIntentId: pi.id ?? null,
      amountCents: Number(pi.amount_received ?? pi.amount ?? 0),
      // Prefer the PI's metadata; fall back to the latest charge's metadata
      // when the merchant only set metadata on one of the two objects.
      metadata: pi.metadata ?? pi.charges?.data?.[0]?.metadata ?? {},
    };
  }

  return null;
}

/**
 * Persist a Stripe webhook failure as a workqueue_items row so a biller
 * can manually review/post the payment. Returns true on success, false on
 * failure — the caller MUST fail-loud (5xx) when this returns false so
 * Stripe retries the delivery and the obligation is not silently lost.
 *
 * Schema notes (Task #114):
 *   - workqueue_items uses `client_id` (not patient_id) and `work_type`
 *     (not queue_type).
 *   - `source_object_type` is an enum — Stripe charges are not first-class
 *     in that enum, so we use the closest valid value `payment_posting`
 *     and stash the real Stripe identifiers in `context_payload` (jsonb).
 *   - `source_object_id` is uuid NOT NULL with a check constraint requiring
 *     it alongside source_object_type. Stripe ids are not uuids, so we
 *     generate a synthetic uuid for the review task itself.
 */
async function writeUnmatchedWorkqueueItem(
  reason: string,
  context: {
    organizationId: string | null;
    clientId: string | null;
    invoiceId: string | null;
    chargeId: string | null;
    paymentIntentId: string | null;
    amountCents: number;
  },
): Promise<boolean> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase || !context.organizationId) {
    // No org context = no organization scope to attach the WQ row to.
    // This is unrecoverable for this delivery; signal failure so the caller
    // returns 5xx and Stripe retries (giving us a chance to receive the
    // metadata-bearing delivery if this was a malformed one).
    console.error("[stripe-webhook] cannot create workqueue item (no org):", reason, context);
    return false;
  }
  const amountDollars = (context.amountCents / 100).toFixed(2);
  const labelRef = context.chargeId ?? context.paymentIntentId ?? "unknown";
  const syntheticId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  const { error } = await supabase.from("workqueue_items").insert({
    organization_id: context.organizationId,
    client_id: context.clientId,
    work_type: "patient_payment_review",
    status: "open",
    priority: "high",
    title: `Review Stripe payment $${amountDollars} (${labelRef})`,
    description: `Stripe webhook could not auto-post this payment: ${reason}. Charge=${
      context.chargeId ?? "n/a"
    }, PaymentIntent=${context.paymentIntentId ?? "n/a"}, Invoice=${context.invoiceId ?? "n/a"}.`,
    source_object_type: "payment_posting",
    source_object_id: syntheticId,
    context_payload: {
      origin: "stripe_webhook",
      reason,
      stripe_charge_id: context.chargeId,
      stripe_payment_intent_id: context.paymentIntentId,
      patient_invoice_id: context.invoiceId,
      amount_cents: context.amountCents,
    },
  });
  if (error) {
    console.error("[stripe-webhook] failed to write workqueue item:", error.message);
    return false;
  }
  return true;
}

export async function POST(request: Request) {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ success: false, error: "Could not read body" }, { status: 400 });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    // Refuse to process anything without a configured shared secret —
    // returning 503 lets Stripe retry once the secret is set rather than
    // silently dropping events.
    return NextResponse.json(
      { success: false, error: "STRIPE_WEBHOOK_SECRET not configured" },
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

  const eventType = String(event.type ?? "");
  if (eventType !== "charge.succeeded" && eventType !== "payment_intent.succeeded") {
    // Acknowledge so Stripe doesn't retry; we just don't act on other types.
    return NextResponse.json({ success: true, ignored: true, type: eventType });
  }

  const details = extractPaymentDetails(event);
  if (!details) {
    return NextResponse.json({ success: false, error: "Could not parse event object" }, { status: 400 });
  }

  const organizationId = (details.metadata.organization_id ?? "").trim() || null;
  const clientId = (details.metadata.client_id ?? "").trim() || null;
  const invoiceId = (details.metadata.patient_invoice_id ?? "").trim() || null;
  const claimId = (details.metadata.professional_claim_id ?? "").trim() || null;
  const amountDollars = Math.round(details.amountCents) / 100;

  // Standardize the dedupe key on the Stripe CHARGE id. Both
  // `charge.succeeded` and `payment_intent.succeeded` events ultimately
  // describe the same charge, so keying on the charge id collapses dual
  // deliveries (PI+charge) into one client_payments row via the unique
  // index on (organization_id, payment_method='stripe',
  // external_payment_id). If a PI event arrives without a resolvable
  // charge id (uncommon for card flows), we defer to the charge.succeeded
  // delivery instead of double-posting under the PI id.
  const externalPaymentId = details.chargeId;
  if (!externalPaymentId) {
    return NextResponse.json({
      success: true,
      deferred: true,
      reason: "payment_intent.succeeded had no resolvable charge id; waiting for charge.succeeded",
    });
  }

  if (!organizationId || !clientId) {
    const queued = await writeUnmatchedWorkqueueItem(
      "Stripe event missing metadata.organization_id or metadata.client_id",
      {
        organizationId,
        clientId,
        invoiceId,
        chargeId: details.chargeId,
        paymentIntentId: details.paymentIntentId,
        amountCents: details.amountCents,
      },
    );
    if (!queued) {
      // Fail-loud: if we couldn't even persist the review obligation,
      // return 5xx so Stripe retries instead of silently losing the
      // payment from our records.
      return NextResponse.json(
        { success: false, error: "Failed to record review item; retry expected" },
        { status: 503 },
      );
    }
    // 200: Stripe should not retry this event forever; a biller can
    // resolve the workqueue item by adding metadata on the source
    // payment link and re-issuing if needed.
    return NextResponse.json({ success: false, queuedForReview: true });
  }

  if (amountDollars <= 0) {
    const queued = await writeUnmatchedWorkqueueItem("Stripe event reported zero amount", {
      organizationId,
      clientId,
      invoiceId,
      chargeId: details.chargeId,
      paymentIntentId: details.paymentIntentId,
      amountCents: details.amountCents,
    });
    if (!queued) {
      return NextResponse.json(
        { success: false, error: "Failed to record review item; retry expected" },
        { status: 503 },
      );
    }
    return NextResponse.json({ success: false, queuedForReview: true });
  }

  const applyTo: PatientPaymentApplyTo = invoiceId
    ? { kind: "invoice", patientInvoiceId: invoiceId }
    : claimId
      ? { kind: "claim", professionalClaimId: claimId }
      : { kind: "account_balance" };

  try {
    const result = await commitPatientPayment({
      organizationId,
      clientId,
      amount: amountDollars,
      method: "stripe",
      applyTo,
      externalPaymentId,
      stripeChargeId: details.chargeId,
      referenceNumber: details.paymentIntentId ?? null,
      note: `Auto-posted by Stripe webhook (event ${event.id ?? "?"})`,
      actor: WEBHOOK_ACTOR,
    });

    if (result.ok) {
      return NextResponse.json({
        success: true,
        alreadyPosted: result.alreadyPosted,
        paymentId: result.paymentId,
      });
    }

    const errorSummary = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ") || "Unknown commit failure";
    const queued = await writeUnmatchedWorkqueueItem(`commitPatientPayment failed: ${errorSummary}`, {
      organizationId,
      clientId,
      invoiceId,
      chargeId: details.chargeId,
      paymentIntentId: details.paymentIntentId,
      amountCents: details.amountCents,
    });
    if (!queued) {
      return NextResponse.json(
        { success: false, error: "Failed to record review item; retry expected", errors: result.errors },
        { status: 503 },
      );
    }
    return NextResponse.json({ success: false, queuedForReview: true, errors: result.errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const queued = await writeUnmatchedWorkqueueItem(`Unexpected error: ${message}`, {
      organizationId,
      clientId,
      invoiceId,
      chargeId: details.chargeId,
      paymentIntentId: details.paymentIntentId,
      amountCents: details.amountCents,
    });
    if (!queued) {
      return NextResponse.json(
        { success: false, error: `Failed to record review item; retry expected. Original: ${message}` },
        { status: 503 },
      );
    }
    // 200 here: the WQ row holds the obligation, so Stripe doesn't need
    // to pile up retries on a deterministic bug we already captured.
    return NextResponse.json({ success: false, queuedForReview: true, error: message });
  }
}
