/**
 * POST /api/billing/payments/stripe-webhook
 *
 * Stripe webhook receiver for client card payments. Verifies
 * `Stripe-Signature` (HMAC-SHA256 over `${t}.${rawBody}` with
 * STRIPE_WEBHOOK_SECRET), then routes Stripe events through the posting
 * engine.
 *
 * Handled event types:
 *   - `payment_intent.succeeded` / `charge.succeeded` (Task #114)
 *       → auto-post via commitPatientPayment
 *   - `charge.refunded`           (Task #136)
 *       → reconcile each refund in the charge: flip matching
 *         payment_refunds row pending→issued, or create a new client
 *         refund row via recordPatientRefund (alreadyIssued=true)
 *   - `refund.updated`            (Task #136)
 *       → same reconciliation, scoped to the single refund object
 *   - `charge.dispute.created`    (Task #136)
 *       → open a high-priority workqueue item linked to the original
 *         client_payment
 *   - `charge.dispute.closed`     (Task #136 / #173)
 *       → resolve the open dispute workqueue item with the final status.
 *         When status='lost', also auto-reverse the matching client_payment
 *         via reversePostedPayment (Task #173) so the client ledger
 *         matches Stripe (Stripe has debited us for the original charge).
 *         reversePostedPayment opens a pending client refund row for AR.
 *         Won/warning_closed/etc. do not move money — no financial action.
 *
 * Idempotency: payment posting collapses on the unique
 * (organization_id, payment_method='stripe', external_payment_id) index;
 * refund reconciliation is conditional on refund_status='pending' so
 * repeat deliveries collapse; dispute WQ uses stripe_dispute_id stashed
 * in context_payload as a soft dedupe key.
 *
 * Failure handling:
 *   - Signature invalid → 401 (Stripe will retry).
 *   - Missing secret → 503 (Stripe will retry).
 *   - Unknown event type → 200 acknowledged + ignored.
 *   - Reconciliation can't proceed → write a workqueue_items row for
 *     biller review and return 200. If even the workqueue write fails,
 *     return 5xx so Stripe retries instead of silently dropping.
 *
 * Stripe Checkout / PaymentIntents must include these metadata fields:
 *   - metadata.organization_id   (required for auto-posting)
 *   - metadata.client_id         (required for auto-posting)
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
  confirmPatientRefund,
  recordPatientRefund,
  reversePostedPayment,
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

type SupabaseAdmin = NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>;

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
  refunds?: { data?: StripeRefundLike[] };
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

interface StripeRefundLike {
  id?: string;
  amount?: number;
  charge?: string | null;
  payment_intent?: string | null;
  status?: string;
  reason?: string | null;
  metadata?: Record<string, string>;
}

interface StripeDisputeLike {
  id?: string;
  amount?: number;
  charge?: string | null;
  payment_intent?: string | null;
  reason?: string | null;
  status?: string;
  metadata?: Record<string, string>;
}

/**
 * Verify the `Stripe-Signature` header. The header format is
 * `t=<unix>,v1=<hex>[,v1=<hex>...]` and the signed payload is
 * `${t}.${rawBody}` HMAC-SHA256 with the webhook secret.
 *
 * Exported for tests — must remain a pure function of its inputs (no I/O,
 * no env reads) so the test suite can pin behavior for timing-window,
 * hex-parse, and multi-v1 cases without spinning up a request.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string): boolean {
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
export function extractPaymentDetails(event: StripeEvent): {
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
 *   - `source_object_type` is an enum — Stripe charges/refunds/disputes
 *     are not first-class in that enum, so we use the closest valid value
 *     `payment_posting` and stash the real Stripe identifiers in
 *     `context_payload` (jsonb).
 *   - `source_object_id` is uuid NOT NULL with a check constraint
 *     requiring it alongside source_object_type. When we have a matching
 *     client_payments uuid we use it; otherwise we mint a synthetic uuid
 *     and stash the Stripe ids in context_payload.
 */
async function writeUnmatchedWorkqueueItem(
  supabase: SupabaseAdmin | null,
  params: {
    organizationId: string;
    clientId: string | null;
    reason: string;
    title: string;
    description: string;
    sourceObjectId?: string | null;
    contextPayload: Record<string, unknown>;
    priority?: "low" | "normal" | "high" | "urgent";
    workType?: string;
  },
): Promise<boolean> {
  if (!params.organizationId) {
    // No org context = no organization scope to attach the WQ row to.
    // This is unrecoverable for this delivery; signal failure so the caller
    // returns 5xx and Stripe retries.
    console.error(
      "[stripe-webhook] cannot create workqueue item (no org):",
      params.reason,
      params.contextPayload,
    );
    return false;
  }
  if (!supabase) {
    // No DB connection. Same fail-loud contract: return false so the
    // caller returns 5xx and Stripe retries once the DB is reachable.
    console.error(
      "[stripe-webhook] cannot create workqueue item (no supabase):",
      params.reason,
    );
    return false;
  }
  const syntheticId =
    params.sourceObjectId ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`);
  const { error } = await supabase.from("workqueue_items").insert({
    organization_id: params.organizationId,
    client_id: params.clientId,
    work_type: params.workType ?? "patient_payment_review",
    status: "open",
    priority: params.priority ?? "high",
    title: params.title,
    description: params.description,
    source_object_type: "payment_posting",
    source_object_id: syntheticId,
    context_payload: {
      origin: "stripe_webhook",
      reason: params.reason,
      ...params.contextPayload,
    },
  });
  if (error) {
    console.error("[stripe-webhook] failed to write workqueue item:", error.message);
    return false;
  }
  return true;
}

/**
 * Dependencies the webhook handler reads from the outside world. Pulled
 * into an interface so tests can substitute the supabase client factory
 * and the posting engine without monkey-patching modules. The default
 * wiring (`defaultStripeWebhookDeps`) preserves production behavior.
 */
export interface StripeWebhookDeps {
  getSupabase: () => ReturnType<typeof createServerSupabaseAdminClient>;
  commitPayment: typeof commitPatientPayment;
  /**
   * Injected for testability — the live wiring is `reversePostedPayment`.
   * Used by handleDisputeClosed to auto-reverse a client_payment when a
   * dispute closes as lost (Task #173).
   */
  reversePayment: typeof reversePostedPayment;
  getSecret: () => string | undefined;
  now?: () => number;
}

export const defaultStripeWebhookDeps: StripeWebhookDeps = {
  getSupabase: () => createServerSupabaseAdminClient(),
  commitPayment: commitPatientPayment,
  reversePayment: reversePostedPayment,
  getSecret: () => process.env.STRIPE_WEBHOOK_SECRET?.trim(),
};

export async function processStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  deps: StripeWebhookDeps = defaultStripeWebhookDeps,
): Promise<Response> {
  const secret = deps.getSecret();
  if (!secret) {
    // Refuse to process anything without a configured shared secret —
    // returning 503 lets Stripe retry once the secret is set rather than
    // silently dropping events.
    return NextResponse.json(
      { success: false, error: "STRIPE_WEBHOOK_SECRET not configured" },
      { status: 503 },
    );
  }

  if (!verifyStripeSignature(rawBody, signatureHeader, secret)) {
    return NextResponse.json({ success: false, error: "Invalid signature" }, { status: 401 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = String(event.type ?? "");

  // Ignored events: acknowledge immediately so Stripe doesn't retry, and
  // skip the supabase fetch entirely (an unrelated event type doesn't
  // need DB access — failing it on a missing DB connection would be
  // gratuitous noise).
  const HANDLED_TYPES = new Set([
    "charge.succeeded",
    "payment_intent.succeeded",
    "charge.refunded",
    "refund.updated",
    "charge.dispute.created",
    "charge.dispute.closed",
  ]);
  if (!HANDLED_TYPES.has(eventType)) {
    return NextResponse.json({ success: true, ignored: true, type: eventType });
  }

  // Fetch supabase lazily — handlers that need it gate themselves on a
  // missing client and return 5xx so Stripe retries. handlePaymentSucceeded
  // only needs it on the fallback (queued-for-review) path; the happy
  // dedupe path goes through deps.commitPayment without touching the DB.
  const supabase = deps.getSupabase();

  switch (eventType) {
    case "charge.succeeded":
    case "payment_intent.succeeded":
      return handlePaymentSucceeded(event, supabase, deps);
    case "charge.refunded":
      if (!supabase) return dbUnavailable();
      return handleChargeRefunded(event, supabase);
    case "refund.updated":
      if (!supabase) return dbUnavailable();
      return handleRefundUpdated(event, supabase);
    case "charge.dispute.created":
      if (!supabase) return dbUnavailable();
      return handleDisputeCreated(event, supabase);
    case "charge.dispute.closed":
      if (!supabase) return dbUnavailable();
      return handleDisputeClosed(event, supabase, deps);
    default:
      // Unreachable — HANDLED_TYPES guards above.
      return NextResponse.json({ success: true, ignored: true, type: eventType });
  }
}

function dbUnavailable(): Response {
  return NextResponse.json(
    { success: false, error: "Database connection not available" },
    { status: 503 },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler: payment_intent.succeeded / charge.succeeded
// ─────────────────────────────────────────────────────────────────────────────

async function handlePaymentSucceeded(
  event: StripeEvent,
  supabase: SupabaseAdmin | null,
  deps: StripeWebhookDeps,
): Promise<Response> {
  // supabase may be null here: the happy dedupe path goes through
  // deps.commitPayment without touching the DB. The fallback paths that
  // need to write a workqueue_items row pass supabase to
  // writeUnmatchedWorkqueueItem, which already fails-loud (returns false
  // → caller returns 5xx so Stripe retries) when supabase is missing.
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
  // deliveries into one client_payments row.
  const externalPaymentId = details.chargeId;
  if (!externalPaymentId) {
    return NextResponse.json({
      success: true,
      deferred: true,
      reason: "payment_intent.succeeded had no resolvable charge id; waiting for charge.succeeded",
    });
  }

  const queueContext = {
    chargeId: details.chargeId,
    paymentIntentId: details.paymentIntentId,
    invoiceId,
    amountCents: details.amountCents,
  };
  const amountDollarsStr = (details.amountCents / 100).toFixed(2);
  const labelRef = details.chargeId ?? details.paymentIntentId ?? "unknown";

  if (!organizationId || !clientId) {
    const queued = await writeUnmatchedWorkqueueItem(supabase, {
      organizationId: organizationId ?? "",
      clientId,
      reason: "Stripe event missing metadata.organization_id or metadata.client_id",
      title: `Review Stripe payment $${amountDollarsStr} (${labelRef})`,
      description: `Stripe webhook could not auto-post this payment. Charge=${details.chargeId ?? "n/a"}, PaymentIntent=${details.paymentIntentId ?? "n/a"}.`,
      contextPayload: {
        stripe_charge_id: details.chargeId,
        stripe_payment_intent_id: details.paymentIntentId,
        patient_invoice_id: invoiceId,
        amount_cents: details.amountCents,
      },
    });
    if (!queued) {
      // Fail-loud: if we couldn't even persist the review obligation,
      // return 5xx so Stripe retries instead of silently losing the
      // payment from our records.
      return NextResponse.json(
        { success: false, error: "Failed to record review item; retry expected" },
        { status: 503 },
      );
    }
    return NextResponse.json({ success: false, queuedForReview: true });
  }

  if (amountDollars <= 0) {
    const queued = await writeUnmatchedWorkqueueItem(supabase, {
      organizationId,
      clientId,
      reason: "Stripe event reported zero amount",
      title: `Review Stripe payment $${amountDollarsStr} (${labelRef})`,
      description: `Stripe webhook could not auto-post this payment (zero amount). Charge=${details.chargeId ?? "n/a"}.`,
      contextPayload: {
        stripe_charge_id: details.chargeId,
        stripe_payment_intent_id: details.paymentIntentId,
        patient_invoice_id: invoiceId,
        amount_cents: details.amountCents,
      },
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
    const result = await deps.commitPayment({
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
      // Task #674: if this Stripe payment cleared an invoice that had
      // an open autopay_charge_failed WQ row (filed by attemptAutopay),
      // close it. Covers the client-portal self-serve "Fix payment"
      // flow (Checkout) and any other path that lands a payment on the
      // invoice (e.g. biller-triggered Checkout link).
      if (invoiceId && supabase) {
        try {
          const { closeAutopayFailureWorkqueueItem } = await import(
            "@/lib/payments/autopayService"
          );
          await closeAutopayFailureWorkqueueItem({
            organizationId,
            patientInvoiceId: invoiceId,
            reason: `Resolved by client payment (Stripe ${details.chargeId ?? details.paymentIntentId ?? "?"}).`,
            supabase,
          });
        } catch (err) {
          console.warn(
            "[stripe-webhook] closeAutopayFailureWorkqueueItem failed (non-fatal)",
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Task #674: when the client just resolved a declined autopay via
      // the "Fix payment" Checkout flow, the Checkout Session was bound
      // to their Stripe Customer with setup_future_usage='off_session'.
      // Mirror the resulting payment_method onto clients.stripe_payment_method_*
      // so the NEXT autopay cycle uses the fresh card instead of the
      // stale one that triggered this whole loop in the first place.
      const isRecovery = (details.metadata.is_recovery ?? "") === "true";
      const saveCard = (details.metadata.save_card_on_success ?? "") === "true";
      if (
        isRecovery &&
        saveCard &&
        details.paymentIntentId &&
        supabase
      ) {
        try {
          const { persistRecoveredSavedCardFromPaymentIntent } = await import(
            "@/lib/payments/savedCardService"
          );
          const persisted = await persistRecoveredSavedCardFromPaymentIntent({
            organizationId,
            clientId,
            paymentIntentId: details.paymentIntentId,
            supabase,
          });
          if (!persisted.ok) {
            console.warn(
              "[stripe-webhook] saved-card recovery skipped",
              persisted.status,
              persisted.message ?? "",
            );
          }
        } catch (err) {
          console.warn(
            "[stripe-webhook] persistRecoveredSavedCardFromPaymentIntent failed (non-fatal)",
            err instanceof Error ? err.message : err,
          );
        }
      }
      return NextResponse.json({
        success: true,
        alreadyPosted: result.alreadyPosted,
        paymentId: result.paymentId,
      });
    }

    const errorSummary = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ") || "Unknown commit failure";
    const queued = await writeUnmatchedWorkqueueItem(supabase, {
      organizationId,
      clientId,
      reason: `commitPatientPayment failed: ${errorSummary}`,
      title: `Review Stripe payment $${amountDollarsStr} (${labelRef})`,
      description: `commitPatientPayment failed: ${errorSummary}`,
      contextPayload: { ...queueContext },
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
    const queued = await writeUnmatchedWorkqueueItem(supabase, {
      organizationId,
      clientId,
      reason: `Unexpected error: ${message}`,
      title: `Review Stripe payment $${amountDollarsStr} (${labelRef})`,
      description: `Unexpected error auto-posting Stripe payment: ${message}`,
      contextPayload: { ...queueContext },
    });
    if (!queued) {
      return NextResponse.json(
        { success: false, error: `Failed to record review item; retry expected. Original: ${message}` },
        { status: 503 },
      );
    }
    return NextResponse.json({ success: false, queuedForReview: true, error: message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler: refund reconciliation (charge.refunded / refund.updated)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Look up the originating client_payment row for a given Stripe charge id.
 * Card payments posted by this webhook live under
 * (payment_method='stripe', external_payment_id=<charge id>); some legacy
 * rows additionally have stripe_charge_id populated.
 */
async function findClientPaymentByChargeId(
  supabase: SupabaseAdmin,
  chargeId: string,
): Promise<{
  id: string;
  organization_id: string;
  client_id: string | null;
  patient_invoice_id: string | null;
} | null> {
  // Try external_payment_id first (the canonical dedupe key for stripe
  // payments). Then fall back to stripe_charge_id (set by some flows).
  const byExternal = await supabase
    .from("client_payments")
    .select("id, organization_id, client_id, patient_invoice_id")
    .eq("external_payment_id", chargeId)
    .eq("payment_method", "stripe")
    .is("archived_at", null)
    .maybeSingle();
  const rowExt = (byExternal.data ?? null) as {
    id: string;
    organization_id: string;
    client_id: string | null;
    patient_invoice_id: string | null;
  } | null;
  if (rowExt) return rowExt;
  const byCharge = await supabase
    .from("client_payments")
    .select("id, organization_id, client_id, patient_invoice_id")
    .eq("stripe_charge_id", chargeId)
    .is("archived_at", null)
    .maybeSingle();
  return ((byCharge.data ?? null) as {
    id: string;
    organization_id: string;
    client_id: string | null;
    patient_invoice_id: string | null;
  } | null);
}

interface RefundReconcileResult {
  refundId: string | null;
  outcome:
    | "confirmed"
    | "already_issued"
    | "created"
    | "ignored"
    | "queued_for_review"
    | "failed"
    | "marked_failed";
  /**
   * True when reconciliation could not complete AND we also could not
   * persist a workqueue row capturing the obligation. The caller MUST
   * return 5xx so Stripe retries — otherwise the refund silently
   * disappears from our records.
   */
  unrecoverable?: boolean;
  errors?: Array<{ field: string; message: string }>;
}

async function reconcileStripeRefund(
  supabase: SupabaseAdmin,
  args: { refund: StripeRefundLike; chargeId: string | null; eventId: string | null },
): Promise<RefundReconcileResult> {
  const refund = args.refund;
  if (!refund.id) return { refundId: null, outcome: "ignored" };

  // 1. Existing refund row matched by stripe_refund_id?
  const { data: existing } = await supabase
    .from("payment_refunds")
    .select("id, organization_id, refund_status, refund_type, source_client_payment_id, amount")
    .eq("stripe_refund_id", refund.id)
    .is("archived_at", null)
    .maybeSingle();
  const existingRow = (existing ?? null) as {
    id: string;
    organization_id: string;
    refund_status: string;
    refund_type: string;
    source_client_payment_id: string | null;
    amount: number;
  } | null;

  if (existingRow) {
    if (existingRow.refund_status === "issued") {
      return { refundId: existingRow.id, outcome: "already_issued" };
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      await supabase
        .from("payment_refunds")
        .update({ refund_status: refund.status === "canceled" ? "cancelled" : "failed" })
        .eq("id", existingRow.id)
        .eq("organization_id", existingRow.organization_id)
        .in("refund_status", ["pending", "issued"]);
      return { refundId: existingRow.id, outcome: "marked_failed" };
    }
    if (refund.status === "succeeded" && existingRow.refund_status === "pending") {
      if (existingRow.refund_type === "client") {
        const r = await confirmPatientRefund({
          organizationId: existingRow.organization_id,
          refundId: existingRow.id,
          stripeRefundId: refund.id,
          actor: WEBHOOK_ACTOR,
        });
        if (r.ok) {
          return { refundId: existingRow.id, outcome: "confirmed" };
        }
        // Fail-loud: confirmation failed (e.g. DB error during state flip).
        // Capture the obligation in a workqueue row; if THAT also fails,
        // surface unrecoverable so the caller returns 5xx and Stripe retries.
        const errorSummary = r.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
        const amountDollarsStr = (Number(refund.amount ?? 0) / 100).toFixed(2);
        const queued = await writeUnmatchedWorkqueueItem(supabase, {
          organizationId: existingRow.organization_id,
          clientId: null,
          reason: `confirmPatientRefund failed: ${errorSummary}`,
          title: `Reconcile Stripe refund $${amountDollarsStr} (${refund.id})`,
          description: `Stripe webhook could not confirm pending client refund ${existingRow.id} for Stripe refund ${refund.id}: ${errorSummary}.`,
          sourceObjectId: existingRow.source_client_payment_id ?? null,
          contextPayload: {
            stripe_refund_id: refund.id,
            stripe_charge_id: args.chargeId,
            payment_refund_id: existingRow.id,
            client_payment_id: existingRow.source_client_payment_id,
            amount_cents: Number(refund.amount ?? 0),
            event_id: args.eventId,
          },
        });
        return {
          refundId: existingRow.id,
          outcome: queued ? "queued_for_review" : "failed",
          unrecoverable: !queued,
          errors: r.errors,
        };
      }
      // Insurance refunds are not initiated by Stripe charges (they target
      // ERA/manual sources), so we should never get here. Leave the row
      // alone and log for ops.
      console.warn(
        "[stripe-webhook] insurance refund matched a Stripe refund event; unexpected",
        { refundId: existingRow.id, stripeRefundId: refund.id },
      );
      return { refundId: existingRow.id, outcome: "ignored" };
    }
    return { refundId: existingRow.id, outcome: "ignored" };
  }

  // 2. No matching refund row — only create one for SUCCEEDED refunds.
  if (refund.status && refund.status !== "succeeded") {
    return { refundId: null, outcome: "ignored" };
  }
  const chargeId = args.chargeId ?? (typeof refund.charge === "string" ? refund.charge : null);
  if (!chargeId) {
    return { refundId: null, outcome: "ignored" };
  }
  const cp = await findClientPaymentByChargeId(supabase, chargeId);
  if (!cp) {
    // Unknown charge: queue for review if we can attribute an org via
    // refund metadata; otherwise ack and ignore (likely not our charge).
    const orgFromMeta = (refund.metadata?.organization_id ?? "").trim() || null;
    if (orgFromMeta) {
      const amountDollarsStr = (Number(refund.amount ?? 0) / 100).toFixed(2);
      const queued = await writeUnmatchedWorkqueueItem(supabase, {
        organizationId: orgFromMeta,
        clientId: null,
        reason: "Stripe refund for unknown charge (no matching client_payments row)",
        title: `Reconcile Stripe refund $${amountDollarsStr} (${refund.id})`,
        description: `Stripe refund ${refund.id} on charge ${chargeId} did not match any posted client_payment. Verify whether the original charge was captured by this system.`,
        contextPayload: {
          stripe_refund_id: refund.id,
          stripe_charge_id: chargeId,
          amount_cents: Number(refund.amount ?? 0),
          refund_reason: refund.reason ?? null,
          event_id: args.eventId,
        },
      });
      return {
        refundId: null,
        outcome: queued ? "queued_for_review" : "failed",
        unrecoverable: !queued,
      };
    }
    return { refundId: null, outcome: "ignored" };
  }

  const amountDollars = Math.round(Number(refund.amount ?? 0)) / 100;
  if (amountDollars <= 0) {
    return { refundId: null, outcome: "ignored" };
  }
  const reasonLabel = refund.reason
    ? `Stripe refund (${refund.reason}) ${refund.id}`
    : `Stripe-initiated refund ${refund.id}`;
  const result = await recordPatientRefund({
    organizationId: cp.organization_id,
    target: { kind: "client_payment", id: cp.id },
    amount: amountDollars,
    reason: reasonLabel,
    actor: WEBHOOK_ACTOR,
    stripeRefundId: refund.id,
    alreadyIssued: true,
  });
  if (!result.ok) {
    const errorSummary = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    const amountDollarsStr = amountDollars.toFixed(2);
    const queued = await writeUnmatchedWorkqueueItem(supabase, {
      organizationId: cp.organization_id,
      clientId: cp.client_id,
      reason: `recordPatientRefund failed: ${errorSummary}`,
      title: `Reconcile Stripe refund $${amountDollarsStr} (${refund.id})`,
      description: `Stripe refund ${refund.id} on charge ${chargeId} could not be auto-recorded: ${errorSummary}.`,
      sourceObjectId: cp.id,
      contextPayload: {
        stripe_refund_id: refund.id,
        stripe_charge_id: chargeId,
        client_payment_id: cp.id,
        amount_cents: Number(refund.amount ?? 0),
        event_id: args.eventId,
      },
    });
    return {
      refundId: null,
      outcome: queued ? "queued_for_review" : "failed",
      unrecoverable: !queued,
      errors: result.errors,
    };
  }
  return { refundId: result.refundId, outcome: "created" };
}

async function handleChargeRefunded(
  event: StripeEvent,
  supabase: SupabaseAdmin,
): Promise<Response> {
  const ch = event.data?.object as StripeChargeLike | undefined;
  if (!ch || !ch.id) {
    return NextResponse.json({ success: false, error: "Missing charge object" }, { status: 400 });
  }
  const refunds = ch.refunds?.data ?? [];
  if (refunds.length === 0) {
    return NextResponse.json({ success: true, ignored: true, reason: "no refund objects in payload" });
  }
  const results: RefundReconcileResult[] = [];
  for (const r of refunds) {
    const res = await reconcileStripeRefund(supabase, {
      refund: r,
      chargeId: ch.id,
      eventId: event.id ?? null,
    });
    results.push(res);
  }
  // Fail-loud if ANY refund couldn't be reconciled or queued for review,
  // so Stripe retries instead of us silently dropping the obligation.
  if (results.some((r) => r.unrecoverable)) {
    return NextResponse.json(
      { success: false, error: "Failed to record refund review item; retry expected", results },
      { status: 503 },
    );
  }
  return NextResponse.json({ success: true, results });
}

async function handleRefundUpdated(
  event: StripeEvent,
  supabase: SupabaseAdmin,
): Promise<Response> {
  const refund = event.data?.object as StripeRefundLike | undefined;
  if (!refund || !refund.id) {
    return NextResponse.json({ success: false, error: "Missing refund object" }, { status: 400 });
  }
  const chargeId = typeof refund.charge === "string" ? refund.charge : null;
  const result = await reconcileStripeRefund(supabase, {
    refund,
    chargeId,
    eventId: event.id ?? null,
  });
  if (result.unrecoverable) {
    return NextResponse.json(
      { success: false, error: "Failed to record refund review item; retry expected", result },
      { status: 503 },
    );
  }
  return NextResponse.json({ success: true, result });
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler: charge.dispute.created / charge.dispute.closed
// ─────────────────────────────────────────────────────────────────────────────

async function findDisputeWorkqueueItem(
  supabase: SupabaseAdmin,
  organizationId: string,
  disputeId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("workqueue_items")
    .select("id, context_payload")
    .eq("organization_id", organizationId)
    .eq("work_type", "stripe_dispute_review")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  for (const row of (data ?? []) as Array<{ id: string; context_payload?: Record<string, unknown> | null }>) {
    const ctx = row.context_payload ?? {};
    if ((ctx as Record<string, unknown>).stripe_dispute_id === disputeId) {
      return row.id;
    }
  }
  return null;
}

async function handleDisputeCreated(
  event: StripeEvent,
  supabase: SupabaseAdmin,
): Promise<Response> {
  const dispute = event.data?.object as StripeDisputeLike | undefined;
  if (!dispute || !dispute.id) {
    return NextResponse.json({ success: false, error: "Missing dispute object" }, { status: 400 });
  }
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : null;
  if (!chargeId) {
    return NextResponse.json({ success: true, ignored: true, reason: "dispute without charge id" });
  }
  const cp = await findClientPaymentByChargeId(supabase, chargeId);
  const amountDollars = (Number(dispute.amount ?? 0) / 100).toFixed(2);
  const orgFromMeta = (dispute.metadata?.organization_id ?? "").trim() || null;
  const organizationId = cp?.organization_id ?? orgFromMeta;
  if (!organizationId) {
    // Not our charge — ack.
    return NextResponse.json({ success: true, ignored: true, reason: "dispute charge not found" });
  }
  // Idempotency: if a WQ item already exists for this dispute id, do nothing.
  const existing = await findDisputeWorkqueueItem(supabase, organizationId, dispute.id);
  if (existing) {
    return NextResponse.json({ success: true, alreadyOpen: true, workqueueItemId: existing });
  }
  const queued = await writeUnmatchedWorkqueueItem(supabase, {
    organizationId,
    clientId: cp?.client_id ?? null,
    reason: `Stripe dispute opened (${dispute.reason ?? "unknown reason"})`,
    title: `Stripe dispute $${amountDollars} on charge ${chargeId}`,
    description: `Stripe dispute ${dispute.id} opened on charge ${chargeId}. Reason: ${dispute.reason ?? "n/a"}. Status: ${dispute.status ?? "needs_response"}. Respond in the Stripe Dashboard.`,
    sourceObjectId: cp?.id ?? null,
    priority: "urgent",
    workType: "stripe_dispute_review",
    contextPayload: {
      stripe_dispute_id: dispute.id,
      stripe_charge_id: chargeId,
      client_payment_id: cp?.id ?? null,
      amount_cents: Number(dispute.amount ?? 0),
      dispute_reason: dispute.reason ?? null,
      dispute_status: dispute.status ?? null,
      event_id: event.id ?? null,
    },
  });
  if (!queued) {
    return NextResponse.json(
      { success: false, error: "Failed to record dispute workqueue item; retry expected" },
      { status: 503 },
    );
  }
  return NextResponse.json({ success: true, disputeId: dispute.id });
}

async function handleDisputeClosed(
  event: StripeEvent,
  supabase: SupabaseAdmin,
  deps: StripeWebhookDeps,
): Promise<Response> {
  const dispute = event.data?.object as StripeDisputeLike | undefined;
  if (!dispute || !dispute.id) {
    return NextResponse.json({ success: false, error: "Missing dispute object" }, { status: 400 });
  }
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : null;
  const cp = chargeId ? await findClientPaymentByChargeId(supabase, chargeId) : null;
  const orgFromMeta = (dispute.metadata?.organization_id ?? "").trim() || null;
  const organizationId = cp?.organization_id ?? orgFromMeta;
  if (!organizationId) {
    return NextResponse.json({ success: true, ignored: true, reason: "dispute charge not found" });
  }
  const wqId = await findDisputeWorkqueueItem(supabase, organizationId, dispute.id);
  const status = String(dispute.status ?? "closed");
  const isWon = status === "won";
  const isLost = status === "lost";

  // When the dispute is LOST, money has actually left the building (Stripe
  // debits us for the original charge + fee). The matching client_payment
  // must be reversed so the client ledger matches Stripe — otherwise the
  // invoice still reads as paid even though we no longer have the funds.
  // Won/warning_closed/etc. do not move money, so no financial action.
  let reversalInfo: {
    attempted: boolean;
    ok: boolean;
    alreadyReversed: boolean;
    clientPaymentId: string | null;
    error: string | null;
  } = { attempted: false, ok: false, alreadyReversed: false, clientPaymentId: null, error: null };

  if (isLost && cp?.id) {
    reversalInfo.attempted = true;
    reversalInfo.clientPaymentId = cp.id;
    try {
      const rev = await deps.reversePayment(
        {
          organizationId,
          target: { kind: "client_payment", id: cp.id },
          reason: `Stripe dispute ${dispute.id} closed as lost`,
          actor: WEBHOOK_ACTOR,
        },
        supabase,
      );
      reversalInfo.ok = rev.ok;
      reversalInfo.alreadyReversed = rev.alreadyReversed;
      if (!rev.ok) {
        reversalInfo.error =
          rev.errors.map((e) => `${e.field}: ${e.message}`).join("; ") || "Unknown reversal failure";
      }
    } catch (err) {
      reversalInfo.error = err instanceof Error ? err.message : String(err);
    }
  }

  if (wqId) {
    const now = new Date().toISOString();
    // Resolve the WQ item when the dispute is won (no work left) OR when
    // the dispute is lost AND the auto-reversal succeeded (the financial
    // obligation is now tracked on the new pending client refund row
    // reversePostedPayment opened). Otherwise leave it open/in_progress
    // so a biller picks it up.
    const resolved = isWon || (isLost && (reversalInfo.ok || reversalInfo.alreadyReversed));
    const descriptionParts = [`Stripe dispute ${dispute.id} closed with status: ${status}.`];
    if (isLost) {
      // Check alreadyReversed BEFORE ok — the engine sets both true for
      // idempotent re-deliveries, but the user-facing note should be the
      // more specific "was already reversed".
      if (reversalInfo.alreadyReversed && reversalInfo.clientPaymentId) {
        descriptionParts.push(
          `client_payment ${reversalInfo.clientPaymentId} was already reversed before this dispute closed.`,
        );
      } else if (reversalInfo.ok && reversalInfo.clientPaymentId) {
        descriptionParts.push(
          `Auto-reversed client_payment ${reversalInfo.clientPaymentId}; a pending client refund row was opened to track the AR write-off.`,
        );
      } else if (reversalInfo.attempted) {
        descriptionParts.push(
          `Auto-reversal FAILED (${reversalInfo.error ?? "no detail"}); biller must reverse manually.`,
        );
      } else {
        descriptionParts.push(
          `No matching client_payment found for charge ${chargeId ?? "n/a"}; biller must reconcile manually.`,
        );
      }
    }
    await supabase
      .from("workqueue_items")
      .update({
        status: resolved ? "resolved" : "in_progress",
        resolved_at: resolved ? now : null,
        updated_at: now,
        description: descriptionParts.join(" "),
      })
      .eq("id", wqId)
      .eq("organization_id", organizationId);
    return NextResponse.json({
      success: true,
      workqueueItemId: wqId,
      disputeStatus: status,
      reversal: isLost ? reversalInfo : undefined,
    });
  }
  // No prior WQ — open one now for visibility (e.g. created event missed).
  const amountDollars = (Number(dispute.amount ?? 0) / 100).toFixed(2);
  const reversalNote = isLost
    ? reversalInfo.ok
      ? ` Auto-reversed client_payment ${reversalInfo.clientPaymentId}; pending client refund row opened.`
      : reversalInfo.alreadyReversed
        ? ` client_payment ${reversalInfo.clientPaymentId} was already reversed.`
        : reversalInfo.attempted
          ? ` Auto-reversal FAILED (${reversalInfo.error ?? "no detail"}); biller must reverse manually.`
          : ` No matching client_payment found; biller must reconcile manually.`
    : "";
  const queued = await writeUnmatchedWorkqueueItem(supabase, {
    organizationId,
    clientId: cp?.client_id ?? null,
    reason: `Stripe dispute closed (${status})`,
    title: `Stripe dispute $${amountDollars} closed (${status})`,
    description: `Stripe dispute ${dispute.id} on charge ${chargeId ?? "n/a"} closed with status ${status}.${reversalNote}`,
    sourceObjectId: cp?.id ?? null,
    priority: isWon ? "normal" : "urgent",
    workType: "stripe_dispute_review",
    contextPayload: {
      stripe_dispute_id: dispute.id,
      stripe_charge_id: chargeId,
      client_payment_id: cp?.id ?? null,
      amount_cents: Number(dispute.amount ?? 0),
      dispute_status: status,
      event_id: event.id ?? null,
      auto_reversal: isLost ? reversalInfo : undefined,
    },
  });
  if (!queued) {
    return NextResponse.json(
      { success: false, error: "Failed to record dispute workqueue item; retry expected" },
      { status: 503 },
    );
  }
  return NextResponse.json({
    success: true,
    disputeId: dispute.id,
    disputeStatus: status,
    reversal: isLost ? reversalInfo : undefined,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ success: false, error: "Could not read body" }, { status: 400 });
  }
  return processStripeWebhook(rawBody, request.headers.get("stripe-signature"));
}
