/**
 * Client-portal invoice checkout (Task #206).
 *
 * Given an authenticated portal session and an invoice the client owns,
 * pick the practice's connected Stripe Express account, mint a Stripe
 * Checkout Session against that account, and hand the client the hosted
 * checkout URL. The webhook at /api/billing/payments/stripe-webhook then
 * auto-posts the payment back onto the client ledger using
 * metadata.patient_invoice_id (so the balance reflects on next portal
 * load).
 *
 * Connected account selection: patient_invoices does not link to a
 * specific provider, so for the portal flow we pick any active
 * provider_credentialing_profiles row in the org with charges_enabled.
 * Most small practices have a single billing account, which makes this
 * a safe default; if the org has multiple, the first active one wins.
 */
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import type { PortalSession } from "@/lib/portal/session";
import {
  createConnectCheckoutSession,
  createConnectCustomer,
  getStripeSecretKey,
  StripeRequestError,
} from "@/lib/stripe/connect";

export type StartInvoiceCheckoutResult =
  | { ok: true; url: string; sessionId: string }
  | { ok: false; code: StartInvoiceCheckoutError; message: string };

export type StartInvoiceCheckoutError =
  | "stripe_not_configured"
  | "db_unavailable"
  | "invoice_not_found"
  | "invoice_not_payable"
  | "no_balance"
  | "below_minimum"
  | "invalid_amount"
  | "amount_exceeds_balance"
  | "no_connected_account"
  | "stripe_error";

const STRIPE_MIN_CENTS = 50;

function dollarsToCents(amount: number): number {
  return Math.round(Number(amount ?? 0) * 100);
}

export async function startInvoiceCheckout(input: {
  session: PortalSession;
  invoiceId: string;
  baseUrl: string;
  /**
   * Optional partial-payment amount in dollars. When omitted the full
   * remaining balance is charged. Must be > 0 and <= remaining balance.
   */
  amountDollars?: number;
  /**
   * Task #674: "Fix payment" recovery flow. When true, the Checkout
   * Session is bound to the client's Stripe Customer and uses
   * `setup_future_usage='off_session'` so the card the client pays
   * with becomes the new saved card on file. The webhook then refreshes
   * `clients.stripe_payment_method_*` from the resulting PaymentIntent
   * (see metadata.is_recovery). Without this, fixing a 3DS / declined
   * autopay would leave the stale card on file and the next autopay
   * cycle would fail the same way.
   */
  isRecovery?: boolean;
}): Promise<StartInvoiceCheckoutResult> {
  if (!getStripeSecretKey()) {
    return { ok: false, code: "stripe_not_configured", message: "Online payment is not set up yet." };
  }
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return { ok: false, code: "db_unavailable", message: "Database connection not available." };
  }

  const { organizationId, clientId } = input.session;

  const { data: invoiceRow, error: invErr } = await supabase
    .from("patient_invoices")
    .select(
      "id, invoice_number, invoice_status, balance_amount, patient_responsibility_amount, paid_amount, client_id, organization_id",
    )
    .eq("organization_id", organizationId)
    .eq("client_id", clientId)
    .eq("id", input.invoiceId)
    .is("archived_at", null)
    .maybeSingle();
  if (invErr) {
    return { ok: false, code: "db_unavailable", message: invErr.message };
  }
  if (!invoiceRow) {
    return { ok: false, code: "invoice_not_found", message: "Invoice not found." };
  }
  const invoice = invoiceRow as {
    id: string;
    invoice_number: string;
    invoice_status: string;
    balance_amount: number;
    patient_responsibility_amount: number;
    paid_amount: number;
  };
  if (["paid", "voided"].includes(invoice.invoice_status)) {
    return { ok: false, code: "invoice_not_payable", message: `Invoice is ${invoice.invoice_status}.` };
  }
  const balance = Number(invoice.balance_amount ?? 0);
  if (!Number.isFinite(balance) || balance <= 0) {
    return { ok: false, code: "no_balance", message: "Invoice has no remaining balance." };
  }
  const balanceCents = dollarsToCents(balance);

  let amountCents: number;
  let isPartial = false;
  if (input.amountDollars === undefined || input.amountDollars === null) {
    amountCents = balanceCents;
  } else {
    const requested = Number(input.amountDollars);
    if (!Number.isFinite(requested) || requested <= 0) {
      return { ok: false, code: "invalid_amount", message: "Please enter a payment amount greater than $0." };
    }
    amountCents = dollarsToCents(requested);
    if (amountCents > balanceCents) {
      return {
        ok: false,
        code: "amount_exceeds_balance",
        message: "Payment amount cannot exceed the remaining balance.",
      };
    }
    isPartial = amountCents < balanceCents;
  }
  if (amountCents < STRIPE_MIN_CENTS) {
    return { ok: false, code: "below_minimum", message: "Payment amount is below the $0.50 Stripe minimum." };
  }

  const { data: profileRow, error: profErr } = await supabase
    .from("provider_credentialing_profiles")
    .select("id, provider_name, stripe_connect_account_id, stripe_charges_enabled")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .eq("stripe_charges_enabled", true)
    .not("stripe_connect_account_id", "is", null)
    .is("archived_at", null)
    .order("provider_name", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (profErr) {
    return { ok: false, code: "db_unavailable", message: profErr.message };
  }
  const profile = profileRow as
    | { id: string; provider_name: string | null; stripe_connect_account_id: string | null }
    | null;
  if (!profile?.stripe_connect_account_id) {
    return {
      ok: false,
      code: "no_connected_account",
      message: "Online payment is not connected yet — please contact your practice.",
    };
  }

  const { data: clientRow } = await supabase
    .from("clients")
    .select(
      "first_name, last_name, email, stripe_customer_id, stripe_connect_account_id",
    )
    .eq("organization_id", organizationId)
    .eq("id", clientId)
    .maybeSingle();
  const client = (clientRow ?? {}) as {
    first_name?: string;
    last_name?: string;
    email?: string | null;
    stripe_customer_id?: string | null;
    stripe_connect_account_id?: string | null;
  };
  const customerEmail = (client.email ?? "").trim() || null;
  const patientLabel =
    [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || "client";

  // In recovery mode we need a Stripe Customer pinned to this connected
  // account so the resulting PaymentMethod attaches there and can be
  // reused off-session. If the client already has a customer on a
  // DIFFERENT connected account, we just fall through to the
  // customer_email path — saved-card recovery only kicks in when the
  // existing card lives on the practice's currently-active account.
  let recoveryCustomerId: string | null = null;
  if (input.isRecovery) {
    const existingAcct = (client.stripe_connect_account_id ?? "").trim() || null;
    if (!existingAcct || existingAcct === profile.stripe_connect_account_id) {
      if (client.stripe_customer_id) {
        recoveryCustomerId = client.stripe_customer_id;
      } else {
        try {
          const fullName = [client.first_name, client.last_name].filter(Boolean).join(" ").trim();
          const created = await createConnectCustomer({
            connectedAccountId: profile.stripe_connect_account_id,
            email: customerEmail,
            name: fullName || undefined,
            metadata: { organization_id: organizationId, client_id: clientId },
            idempotencyKey: `client-customer-${clientId}`,
          });
          recoveryCustomerId = created.id;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sb = supabase as unknown as { from: (t: string) => any };
          await sb
            .from("clients")
            .update({
              stripe_connect_account_id: profile.stripe_connect_account_id,
              stripe_customer_id: created.id,
            })
            .eq("organization_id", organizationId)
            .eq("id", clientId);
        } catch (err) {
          // Not fatal — fall back to non-saving Checkout (the client
          // still pays this invoice, the WQ row will surface the stale
          // card for the biller to follow up on).
          console.warn(
            "[portal] recovery createConnectCustomer failed",
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  const origin = input.baseUrl.replace(/\/$/, "");
  const successUrl = `${origin}/portal/payments/return?status=success&invoice=${encodeURIComponent(
    invoice.id,
  )}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/portal/payments/return?status=cancelled&invoice=${encodeURIComponent(invoice.id)}`;

  const isRecoverySaving = !!(input.isRecovery && recoveryCustomerId);
  const metadata: Record<string, string> = {
    origin: "portal_invoice_pay",
    organization_id: organizationId,
    client_id: clientId,
    patient_invoice_id: invoice.id,
    requested_amount_cents: String(amountCents),
    invoice_balance_cents: String(balanceCents),
    is_partial_payment: isPartial ? "true" : "false",
    is_recovery: input.isRecovery ? "true" : "false",
    save_card_on_success: isRecoverySaving ? "true" : "false",
  };

  try {
    // Tie idempotency to the invoice + balance + chosen amount so
    // retries within the same state collapse to one Stripe session;
    // once the balance changes (partial payment) or the client picks
    // a different amount the key changes and they get a fresh session.
    // Recovery sessions get their own key so they don't collide with
    // a prior non-saving session for the same invoice.
    const idempotencyKey =
      `portal-invoice-${invoice.id}-${balanceCents}-${amountCents}` +
      (input.isRecovery ? "-rec" : "");
    const checkout = await createConnectCheckoutSession({
      amountCents,
      currency: "usd",
      connectedAccountId: profile.stripe_connect_account_id,
      successUrl,
      cancelUrl,
      productName: `Invoice #${invoice.invoice_number}`,
      productDescription: `Client balance for ${patientLabel}`,
      metadata,
      customerEmail,
      customerId: recoveryCustomerId,
      setupFutureUsage: isRecoverySaving ? "off_session" : null,
      idempotencyKey,
    });
    if (!checkout.url) {
      return { ok: false, code: "stripe_error", message: "Stripe did not return a checkout URL." };
    }
    return { ok: true, url: checkout.url, sessionId: checkout.id };
  } catch (err) {
    if (err instanceof StripeRequestError) {
      return { ok: false, code: "stripe_error", message: err.message };
    }
    const message = err instanceof Error ? err.message : "Unable to start checkout.";
    return { ok: false, code: "stripe_error", message };
  }
}
