/**
 * Minimal Stripe REST wrapper for Connect Express (Task #123).
 *
 * No SDK — mirrors the raw-fetch pattern already in
 * lib/payments/postingEngine/reversal.ts (which issues refunds via
 * api.stripe.com directly). Form-encoded bodies, optional Stripe-Account
 * header for acting on behalf of a connected account, optional
 * Idempotency-Key for safe retries.
 */

const STRIPE_API_BASE = "https://api.stripe.com/v1";

export class StripeRequestError extends Error {
  status: number;
  stripeCode?: string;
  raw?: unknown;
  constructor(message: string, status: number, raw?: unknown, stripeCode?: string) {
    super(message);
    this.status = status;
    this.raw = raw;
    this.stripeCode = stripeCode;
  }
}

export function getStripeSecretKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  return key || null;
}

export function getStripePublishableKey(): string | null {
  const key =
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() ||
    process.env.STRIPE_PUBLISHABLE_KEY?.trim();
  return key || null;
}

export function getStripeConnectWebhookSecret(): string | null {
  const key = process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
  return key || null;
}

/**
 * Flatten a nested object into Stripe's bracket form-encoding format.
 * Example: { metadata: { foo: "bar" } } -> "metadata[foo]=bar"
 */
function appendFormParams(form: URLSearchParams, params: Record<string, unknown>, prefix?: string) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v && typeof v === "object") appendFormParams(form, v as Record<string, unknown>, `${fullKey}[${i}]`);
        else form.set(`${fullKey}[${i}]`, String(v));
      });
    } else if (typeof value === "object") {
      appendFormParams(form, value as Record<string, unknown>, fullKey);
    } else if (typeof value === "boolean") {
      form.set(fullKey, value ? "true" : "false");
    } else {
      form.set(fullKey, String(value));
    }
  }
}

interface StripeRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  stripeAccount?: string | null;
  idempotencyKey?: string | null;
  params?: Record<string, unknown>;
}

async function stripeRequest<T = unknown>(path: string, options: StripeRequestOptions = {}): Promise<T> {
  const key = getStripeSecretKey();
  if (!key) {
    throw new StripeRequestError("STRIPE_SECRET_KEY not configured", 503);
  }
  const method = options.method ?? "POST";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (options.stripeAccount) headers["Stripe-Account"] = options.stripeAccount;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  let url = `${STRIPE_API_BASE}${path}`;
  let body: string | undefined;
  if (options.params && method === "GET") {
    const qs = new URLSearchParams();
    appendFormParams(qs, options.params);
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  } else if (options.params) {
    const form = new URLSearchParams();
    appendFormParams(form, options.params);
    body = form.toString();
  }

  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep null */
  }
  if (!resp.ok) {
    const errObj = (json as { error?: { message?: string; code?: string } } | null)?.error;
    throw new StripeRequestError(
      errObj?.message || `Stripe request failed (${resp.status})`,
      resp.status,
      json,
      errObj?.code,
    );
  }
  return (json as T) ?? ({} as T);
}

export interface StripeConnectAccount {
  id: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  requirements?: {
    currently_due?: string[];
    past_due?: string[];
    disabled_reason?: string | null;
    pending_verification?: string[];
  };
}

export async function createExpressAccount(input: {
  email?: string | null;
  providerName?: string | null;
  metadata?: Record<string, string>;
}): Promise<StripeConnectAccount> {
  return stripeRequest<StripeConnectAccount>("/accounts", {
    params: {
      type: "express",
      country: "US",
      ...(input.email ? { email: input.email } : {}),
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_type: "individual",
      ...(input.providerName ? { business_profile: { name: input.providerName } } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
}

export async function retrieveAccount(accountId: string): Promise<StripeConnectAccount> {
  return stripeRequest<StripeConnectAccount>(`/accounts/${encodeURIComponent(accountId)}`, { method: "GET" });
}

export async function createAccountLink(input: {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
}): Promise<{ url: string; expires_at: number }> {
  return stripeRequest<{ url: string; expires_at: number }>("/account_links", {
    params: {
      account: input.accountId,
      return_url: input.returnUrl,
      refresh_url: input.refreshUrl,
      type: "account_onboarding",
    },
  });
}

export interface StripePaymentIntent {
  id: string;
  client_secret: string;
  amount: number;
  currency: string;
  status: string;
  latest_charge?: string | null;
  metadata?: Record<string, string>;
}

export async function createConnectPaymentIntent(input: {
  amountCents: number;
  currency?: string;
  connectedAccountId: string;
  metadata: Record<string, string>;
  description?: string;
  idempotencyKey?: string;
}): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>("/payment_intents", {
    stripeAccount: input.connectedAccountId,
    idempotencyKey: input.idempotencyKey,
    params: {
      amount: input.amountCents,
      currency: (input.currency ?? "usd").toLowerCase(),
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: input.metadata,
      ...(input.description ? { description: input.description } : {}),
    },
  });
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  payment_intent?: string | null;
  status?: string | null;
  amount_total?: number | null;
  metadata?: Record<string, string>;
}

/**
 * Create a Stripe Checkout Session on a connected Express account (Task #206).
 *
 * Used by the client portal so clients can pay an open invoice with a
 * Stripe-hosted checkout. Funds settle directly to the connected account
 * (direct charge via Stripe-Account header — same model as
 * createConnectPaymentIntent). The session-level metadata AND
 * payment_intent_data.metadata both carry organization_id / client_id /
 * patient_invoice_id so the existing stripe-webhook auto-posts the
 * payment onto the client ledger.
 */
export async function createConnectCheckoutSession(input: {
  amountCents: number;
  currency?: string;
  connectedAccountId: string;
  successUrl: string;
  cancelUrl: string;
  productName: string;
  productDescription?: string | null;
  metadata: Record<string, string>;
  customerEmail?: string | null;
  idempotencyKey?: string;
  /**
   * When set, pins the Checkout Session to an existing Stripe Customer
   * on the connected account so the resulting PaymentMethod attaches
   * to that customer (required to reuse the card off-session later).
   */
  customerId?: string | null;
  /**
   * When `'off_session'`, asks Stripe to save the resulting payment
   * method to the bound customer for future off-session use. Used by
   * the client-portal "Fix payment" recovery flow (Task #674) so a
   * declined autopay can both pay this invoice AND refresh the saved
   * card on file in a single Checkout.
   */
  setupFutureUsage?: "off_session" | "on_session" | null;
}): Promise<StripeCheckoutSession> {
  const piData: Record<string, unknown> = { metadata: input.metadata };
  if (input.setupFutureUsage) {
    piData.setup_future_usage = input.setupFutureUsage;
  }
  const params: Record<string, unknown> = {
    mode: "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: (input.currency ?? "usd").toLowerCase(),
          unit_amount: input.amountCents,
          product_data: {
            name: input.productName,
            ...(input.productDescription ? { description: input.productDescription } : {}),
          },
        },
      },
    ],
    metadata: input.metadata,
    payment_intent_data: piData,
  };
  if (input.customerId) {
    params.customer = input.customerId;
  } else if (input.customerEmail) {
    params.customer_email = input.customerEmail;
  }

  return stripeRequest<StripeCheckoutSession>("/checkout/sessions", {
    stripeAccount: input.connectedAccountId,
    idempotencyKey: input.idempotencyKey,
    params,
  });
}

export interface StripeCustomer {
  id: string;
  email?: string | null;
  name?: string | null;
  metadata?: Record<string, string>;
}

/**
 * Create a Customer on a connected Express account (Task #487).
 * Used to pin a client's saved card to the practice's connected
 * account, since direct charges require customer + payment method to
 * live on that account.
 */
export async function createConnectCustomer(input: {
  connectedAccountId: string;
  email?: string | null;
  name?: string | null;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<StripeCustomer> {
  const params: Record<string, unknown> = {};
  if (input.email) params.email = input.email;
  if (input.name) params.name = input.name;
  if (input.metadata) params.metadata = input.metadata;
  return stripeRequest<StripeCustomer>("/customers", {
    stripeAccount: input.connectedAccountId,
    idempotencyKey: input.idempotencyKey,
    params,
  });
}

export interface StripeSetupIntent {
  id: string;
  client_secret: string;
  status: string;
  payment_method?: string | null;
  customer?: string | null;
  metadata?: Record<string, string>;
}

export interface StripeRefund {
  id: string;
  amount: number;
  currency: string;
  status: string;
  charge?: string | null;
  payment_intent?: string | null;
  metadata?: Record<string, string>;
}

export interface StripeChargeLike {
  id: string;
  status: string;
  amount: number;
  amount_refunded?: number;
  refunded?: boolean;
  captured?: boolean;
  currency: string;
  customer?: string | null;
  payment_method?: string | null;
  payment_intent?: string | null;
  metadata?: Record<string, string>;
}

/**
 * Create a SetupIntent on a connected account to collect & save a
 * client card without charging (Task #487). Frontend uses
 * `client_secret` with Stripe.js to mount Payment Element / confirm.
 */
export async function createConnectSetupIntent(input: {
  connectedAccountId: string;
  customerId: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<StripeSetupIntent> {
  const params: Record<string, unknown> = {
    customer: input.customerId,
    payment_method_types: ["card"],
    usage: "off_session",
  };
  if (input.metadata) params.metadata = input.metadata;
  return stripeRequest<StripeSetupIntent>("/setup_intents", {
    stripeAccount: input.connectedAccountId,
    idempotencyKey: input.idempotencyKey,
    params,
  });
}

export async function retrieveConnectSetupIntent(input: {
  connectedAccountId: string;
  setupIntentId: string;
}): Promise<StripeSetupIntent> {
  return stripeRequest<StripeSetupIntent>(
    `/setup_intents/${encodeURIComponent(input.setupIntentId)}`,
    { method: "GET", stripeAccount: input.connectedAccountId },
  );
}

export interface StripePaymentIntentLite {
  id: string;
  status?: string | null;
  customer?: string | null;
  payment_method?: string | null;
  metadata?: Record<string, string>;
}

/**
 * Read a PaymentIntent off a connected Express account. Used by the
 * Task #674 "Fix payment" webhook path so we can pull the
 * payment_method off a successful Checkout PaymentIntent and refresh
 * the client's saved card on file.
 */
export async function retrieveConnectPaymentIntent(input: {
  connectedAccountId: string;
  paymentIntentId: string;
}): Promise<StripePaymentIntentLite> {
  return stripeRequest<StripePaymentIntentLite>(
    `/payment_intents/${encodeURIComponent(input.paymentIntentId)}`,
    { method: "GET", stripeAccount: input.connectedAccountId },
  );
}

export interface StripePaymentMethod {
  id: string;
  type: string;
  customer?: string | null;
  card?: {
    brand?: string;
    last4?: string;
    exp_month?: number;
    exp_year?: number;
  };
}

export async function retrieveConnectPaymentMethod(input: {
  connectedAccountId: string;
  paymentMethodId: string;
}): Promise<StripePaymentMethod> {
  return stripeRequest<StripePaymentMethod>(
    `/payment_methods/${encodeURIComponent(input.paymentMethodId)}`,
    { method: "GET", stripeAccount: input.connectedAccountId },
  );
}

export async function attachConnectPaymentMethod(input: {
  connectedAccountId: string;
  paymentMethodId: string;
  customerId: string;
}): Promise<StripePaymentMethod> {
  return stripeRequest<StripePaymentMethod>(
    `/payment_methods/${encodeURIComponent(input.paymentMethodId)}/attach`,
    {
      stripeAccount: input.connectedAccountId,
      params: { customer: input.customerId },
    },
  );
}

export async function detachConnectPaymentMethod(input: {
  connectedAccountId: string;
  paymentMethodId: string;
}): Promise<StripePaymentMethod> {
  return stripeRequest<StripePaymentMethod>(
    `/payment_methods/${encodeURIComponent(input.paymentMethodId)}/detach`,
    { stripeAccount: input.connectedAccountId },
  );
}

/**
 * Retrieve a Stripe charge (read-only) on a connected account. Used to
 * recover the (customer, payment_method) pair off a prior successful
 * charge so we can run a new off-session charge for the same client
 * without storing card metadata locally.
 */
export async function retrieveConnectCharge(input: {
  chargeId: string;
  connectedAccountId: string;
}): Promise<StripeChargeLike> {
  return stripeRequest<StripeChargeLike>(`/charges/${encodeURIComponent(input.chargeId)}`, {
    method: "GET",
    stripeAccount: input.connectedAccountId,
  });
}

/**
 * Charge a previously-saved card off-session on a connected Express
 * account (Task #487). Confirms inline and returns the resulting
 * PaymentIntent. Throws StripeRequestError on failure (e.g.
 * `authentication_required` when the bank insists on a 3DS challenge
 * — the caller should surface that so the client can authenticate
 * via the portal).
 */
export async function createConnectOffSessionCharge(input: {
  amountCents: number;
  currency?: string;
  connectedAccountId: string;
  customerId: string;
  paymentMethodId: string;
  metadata: Record<string, string>;
  description?: string;
  idempotencyKey?: string;
  statementDescriptor?: string;
}): Promise<StripePaymentIntent> {
  const params: Record<string, unknown> = {
    amount: input.amountCents,
    currency: (input.currency ?? "usd").toLowerCase(),
    customer: input.customerId,
    payment_method: input.paymentMethodId,
    off_session: true,
    confirm: true,
    payment_method_types: ["card"],
    metadata: input.metadata,
  };
  if (input.description) params.description = input.description;
  if (input.statementDescriptor) params.statement_descriptor_suffix = input.statementDescriptor;
  return stripeRequest<StripePaymentIntent>("/payment_intents", {
    stripeAccount: input.connectedAccountId,
    idempotencyKey: input.idempotencyKey,
    params,
  });
}

/**
 * Issue a refund against a Connect charge (Task #500).
 *
 * Mirrors the inline refund logic already in
 * lib/payments/postingEngine/reversal.ts so the workqueue's "Issue refund"
 * action can call one shared helper.
 *
 * The Stripe-Account header is REQUIRED for charges that landed on a
 * connected account (Express copay flow) — without it the charge id
 * appears not to exist on the platform account and the refund 404s.
 * See .agents/memory/stripe-connect-refund-header.md.
 */
export async function createConnectRefund(input: {
  chargeId?: string | null;
  paymentIntentId?: string | null;
  amountCents: number;
  connectedAccountId?: string | null;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer";
}): Promise<StripeRefund> {
  const params: Record<string, unknown> = {
    amount: input.amountCents,
    reason: input.reason ?? "requested_by_customer",
  };
  if (input.chargeId) params.charge = input.chargeId;
  else if (input.paymentIntentId) params.payment_intent = input.paymentIntentId;
  else throw new StripeRequestError("createConnectRefund requires chargeId or paymentIntentId", 400);
  if (input.metadata) params.metadata = input.metadata;

  return stripeRequest<StripeRefund>("/refunds", {
    stripeAccount: input.connectedAccountId ?? null,
    idempotencyKey: input.idempotencyKey,
    params,
  });
}

/**
 * Charge a previously stored Stripe customer + payment method off-session
 * (i.e. without the client present). Implements the standard Stripe
 * MIT/off-session pattern: create a PaymentIntent with confirm=true,
 * off_session=true, customer, payment_method, and disable redirects.
 *
 * Throws StripeRequestError if the charge fails (declined, requires
 * authentication, network/auth errors). On success the returned
 * PaymentIntent has status='succeeded' and latest_charge populated.
 */
export async function chargeSavedPaymentMethod(input: {
  amountCents: number;
  currency?: string;
  connectedAccountId: string;
  customerId: string;
  paymentMethodId: string;
  description?: string;
  metadata: Record<string, string>;
  idempotencyKey?: string;
}): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>("/payment_intents", {
    stripeAccount: input.connectedAccountId,
    idempotencyKey: input.idempotencyKey,
    params: {
      amount: input.amountCents,
      currency: (input.currency ?? "usd").toLowerCase(),
      customer: input.customerId,
      payment_method: input.paymentMethodId,
      confirm: true,
      off_session: true,
      // off_session + redirects don't mix; never let Stripe try to redirect.
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: input.metadata,
      ...(input.description ? { description: input.description } : {}),
    },
  });
}

/**
 * Refund a Connect charge. Compensating action used when local
 * persistence fails after a successful off-session charge so the client
 * is not silently overcharged.
 */
export async function refundConnectCharge(input: {
  chargeId: string;
  connectedAccountId: string;
  reason?: string;
  idempotencyKey?: string;
}): Promise<{ id: string; status: string }> {
  return stripeRequest<{ id: string; status: string }>("/refunds", {
    stripeAccount: input.connectedAccountId,
    idempotencyKey: input.idempotencyKey,
    params: {
      charge: input.chargeId,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
}

/**
 * Map a Stripe account into a normalized status the EHR UI consumes.
 *   not_connected  — no account on file
 *   onboarding     — account exists but details_submitted=false
 *   connected      — charges_enabled=true
 *   restricted     — details submitted but charges disabled / requirements outstanding
 */
export type ConnectStatus = "not_connected" | "onboarding" | "connected" | "restricted";

export function summarizeConnectStatus(input: {
  stripe_connect_account_id?: string | null;
  stripe_charges_enabled?: boolean | null;
  stripe_details_submitted?: boolean | null;
  stripe_requirements?: { currently_due?: string[]; disabled_reason?: string | null } | null;
}): ConnectStatus {
  if (!input.stripe_connect_account_id) return "not_connected";
  if (input.stripe_charges_enabled) {
    const due = input.stripe_requirements?.currently_due ?? [];
    if (due.length > 0) return "restricted";
    return "connected";
  }
  if (input.stripe_details_submitted) return "restricted";
  return "onboarding";
}
