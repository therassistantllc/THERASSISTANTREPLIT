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
