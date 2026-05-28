/**
 * Saved-card lifecycle for client clients (Task #487).
 *
 * Direct charges on Stripe Connect require the Customer + PaymentMethod
 * to live on the practice's connected Express account. We pin a client
 * to ONE connected account; rotating practices would require detaching
 * + re-saving on the new account.
 *
 * Public surface:
 *   - startCardSetup        — mint SetupIntent + Customer, return
 *                             client_secret for Stripe.js frontend
 *   - confirmSavedCard      — after frontend confirms, persist the
 *                             attached PaymentMethod metadata
 *   - removeSavedCard       — detach + clear DB fields
 *   - setAutopayEnabled     — flip autopay flag (requires saved card)
 *   - chargeSavedCardForInvoice — off-session charge + ledger post
 *   - getSavedCardSummary   — read-only summary for UI
 */
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  attachConnectPaymentMethod,
  createConnectCustomer,
  createConnectOffSessionCharge,
  createConnectSetupIntent,
  detachConnectPaymentMethod,
  getStripePublishableKey,
  getStripeSecretKey,
  retrieveConnectPaymentIntent,
  retrieveConnectPaymentMethod,
  retrieveConnectSetupIntent,
  StripeRequestError,
} from "@/lib/stripe/connect";
import { recordPatientInvoicePayment } from "@/lib/payments/patientInvoicePaymentService";

type SupabaseAdmin = NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>;

export interface SavedCardSummary {
  hasSavedCard: boolean;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  savedAt: string | null;
  autopayEnabled: boolean;
  stripeConnectAccountId: string | null;
}

interface ClientRow {
  id: string;
  organization_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  stripe_connect_account_id: string | null;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  stripe_payment_method_brand: string | null;
  stripe_payment_method_last4: string | null;
  stripe_payment_method_exp_month: number | null;
  stripe_payment_method_exp_year: number | null;
  stripe_payment_method_saved_at: string | null;
  autopay_enabled: boolean;
}

const CLIENT_SELECT =
  "id, organization_id, first_name, last_name, email, " +
  "stripe_connect_account_id, stripe_customer_id, stripe_payment_method_id, " +
  "stripe_payment_method_brand, stripe_payment_method_last4, " +
  "stripe_payment_method_exp_month, stripe_payment_method_exp_year, " +
  "stripe_payment_method_saved_at, autopay_enabled";

function unwrapClient(row: unknown): ClientRow | null {
  if (!row) return null;
  return row as ClientRow;
}

export function summarizeSavedCard(row: ClientRow | null): SavedCardSummary {
  if (!row) {
    return {
      hasSavedCard: false,
      brand: null,
      last4: null,
      expMonth: null,
      expYear: null,
      savedAt: null,
      autopayEnabled: false,
      stripeConnectAccountId: null,
    };
  }
  return {
    hasSavedCard: !!(row.stripe_payment_method_id && row.stripe_customer_id),
    brand: row.stripe_payment_method_brand,
    last4: row.stripe_payment_method_last4,
    expMonth: row.stripe_payment_method_exp_month,
    expYear: row.stripe_payment_method_exp_year,
    savedAt: row.stripe_payment_method_saved_at,
    autopayEnabled: !!row.autopay_enabled,
    stripeConnectAccountId: row.stripe_connect_account_id,
  };
}

async function loadClient(
  supabase: SupabaseAdmin,
  organizationId: string,
  clientId: string,
): Promise<ClientRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };
  const { data, error } = await sb
    .from("clients")
    .select(CLIENT_SELECT)
    .eq("organization_id", organizationId)
    .eq("id", clientId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message ?? "Failed to load client");
  return unwrapClient(data);
}

async function pickConnectedAccount(
  supabase: SupabaseAdmin,
  organizationId: string,
): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };
  const { data } = await sb
    .from("provider_credentialing_profiles")
    .select("stripe_connect_account_id")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .eq("stripe_charges_enabled", true)
    .not("stripe_connect_account_id", "is", null)
    .is("archived_at", null)
    .order("provider_name", { ascending: true })
    .limit(1)
    .maybeSingle();
  const account = (data ?? {}) as { stripe_connect_account_id?: string | null };
  return account.stripe_connect_account_id ?? null;
}

export type SavedCardError =
  | "stripe_not_configured"
  | "db_unavailable"
  | "client_not_found"
  | "no_connected_account"
  | "no_saved_card"
  | "no_invoice"
  | "stripe_error"
  | "authentication_required"
  | "card_declined";

export interface StartCardSetupResult {
  ok: true;
  setupIntentId: string;
  clientSecret: string;
  publishableKey: string;
  connectAccountId: string;
  customerId: string;
}

export type StartCardSetupOutcome =
  | StartCardSetupResult
  | { ok: false; code: SavedCardError; message: string };

export async function startCardSetup(input: {
  organizationId: string;
  clientId: string;
}): Promise<StartCardSetupOutcome> {
  const publishable = getStripePublishableKey();
  if (!getStripeSecretKey() || !publishable) {
    return { ok: false, code: "stripe_not_configured", message: "Stripe is not set up." };
  }
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, code: "db_unavailable", message: "Database unavailable." };

  const client = await loadClient(supabase, input.organizationId, input.clientId);
  if (!client) return { ok: false, code: "client_not_found", message: "Client not found." };

  // Lock the client to the practice's currently-active connected
  // account; if one was already chosen previously, stick with it (the
  // existing customer/payment-method records live there).
  let connectAccountId = client.stripe_connect_account_id;
  if (!connectAccountId) {
    connectAccountId = await pickConnectedAccount(supabase, input.organizationId);
  }
  if (!connectAccountId) {
    return {
      ok: false,
      code: "no_connected_account",
      message: "No connected Stripe account on file for this practice.",
    };
  }

  // Re-use existing customer when possible; otherwise create one.
  let customerId = client.stripe_customer_id;
  try {
    if (!customerId) {
      const fullName = [client.first_name, client.last_name].filter(Boolean).join(" ").trim();
      const customer = await createConnectCustomer({
        connectedAccountId: connectAccountId,
        email: client.email || undefined,
        name: fullName || undefined,
        metadata: {
          organization_id: input.organizationId,
          client_id: client.id,
        },
        idempotencyKey: `client-customer-${client.id}`,
      });
      customerId = customer.id;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as unknown as { from: (t: string) => any };
      const { error: upErr } = await sb
        .from("clients")
        .update({
          stripe_connect_account_id: connectAccountId,
          stripe_customer_id: customerId,
        })
        .eq("organization_id", input.organizationId)
        .eq("id", client.id);
      if (upErr) {
        return { ok: false, code: "db_unavailable", message: upErr.message };
      }
    }

    const setupIntent = await createConnectSetupIntent({
      connectedAccountId: connectAccountId,
      customerId: customerId!,
      metadata: {
        organization_id: input.organizationId,
        client_id: client.id,
      },
    });
    return {
      ok: true,
      setupIntentId: setupIntent.id,
      clientSecret: setupIntent.client_secret,
      publishableKey: publishable,
      connectAccountId,
      customerId: customerId!,
    };
  } catch (err) {
    return mapStripeError(err);
  }
}

export interface ConfirmSavedCardInput {
  organizationId: string;
  clientId: string;
  /** Either pass setupIntentId (server will read .payment_method) … */
  setupIntentId?: string | null;
  /** … or pass the payment_method_id directly (already attached). */
  paymentMethodId?: string | null;
}

export type ConfirmSavedCardOutcome =
  | { ok: true; summary: SavedCardSummary }
  | { ok: false; code: SavedCardError; message: string };

export async function confirmSavedCard(
  input: ConfirmSavedCardInput,
): Promise<ConfirmSavedCardOutcome> {
  if (!getStripeSecretKey()) {
    return { ok: false, code: "stripe_not_configured", message: "Stripe is not set up." };
  }
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, code: "db_unavailable", message: "Database unavailable." };

  const client = await loadClient(supabase, input.organizationId, input.clientId);
  if (!client) return { ok: false, code: "client_not_found", message: "Client not found." };

  const connectAccountId = client.stripe_connect_account_id;
  const customerId = client.stripe_customer_id;
  if (!connectAccountId || !customerId) {
    return {
      ok: false,
      code: "no_connected_account",
      message: "Start card setup before confirming.",
    };
  }

  try {
    let paymentMethodId = (input.paymentMethodId ?? "").trim() || null;
    if (!paymentMethodId && input.setupIntentId) {
      const intent = await retrieveConnectSetupIntent({
        connectedAccountId: connectAccountId,
        setupIntentId: input.setupIntentId,
      });
      if (intent.status !== "succeeded" || !intent.payment_method) {
        return {
          ok: false,
          code: "stripe_error",
          message: `Setup not complete (status: ${intent.status}).`,
        };
      }
      paymentMethodId = intent.payment_method;
    }
    if (!paymentMethodId) {
      return { ok: false, code: "stripe_error", message: "No payment method to save." };
    }

    const pm = await retrieveConnectPaymentMethod({
      connectedAccountId: connectAccountId,
      paymentMethodId,
    });
    // Attach if Stripe says it isn't already on this customer.
    if (!pm.customer || pm.customer !== customerId) {
      await attachConnectPaymentMethod({
        connectedAccountId: connectAccountId,
        customerId,
        paymentMethodId,
      });
    }

    // Detach the prior PM (best effort) so we don't accrue orphans.
    if (
      client.stripe_payment_method_id &&
      client.stripe_payment_method_id !== paymentMethodId
    ) {
      try {
        await detachConnectPaymentMethod({
          connectedAccountId: connectAccountId,
          paymentMethodId: client.stripe_payment_method_id,
        });
      } catch {
        // Already detached / unknown — ignore.
      }
    }

    const nowIso = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };
    const { data: updated, error: upErr } = await sb
      .from("clients")
      .update({
        stripe_payment_method_id: paymentMethodId,
        stripe_payment_method_brand: pm.card?.brand ?? null,
        stripe_payment_method_last4: pm.card?.last4 ?? null,
        stripe_payment_method_exp_month: pm.card?.exp_month ?? null,
        stripe_payment_method_exp_year: pm.card?.exp_year ?? null,
        stripe_payment_method_saved_at: nowIso,
      })
      .eq("organization_id", input.organizationId)
      .eq("id", client.id)
      .select(CLIENT_SELECT)
      .maybeSingle();
    if (upErr) {
      return { ok: false, code: "db_unavailable", message: upErr.message };
    }
    return { ok: true, summary: summarizeSavedCard(unwrapClient(updated)) };
  } catch (err) {
    return mapStripeError(err);
  }
}

/**
 * Refresh `clients.stripe_payment_method_*` from a successful
 * Checkout PaymentIntent (Task #674 — client "Fix payment" recovery).
 *
 * Called from the Stripe webhook when `metadata.is_recovery === 'true'`
 * AND `metadata.save_card_on_success === 'true'`. The Checkout Session
 * was bound to the client's customer with `setup_future_usage='off_session'`,
 * so the PI has a reusable payment_method attached to that customer.
 * We mirror it onto the client row so the next autopay cycle uses it
 * instead of the stale card.
 *
 * Best-effort: returns a status string but never throws. Failures are
 * logged and surfaced to the caller (the webhook) so they can decide
 * what to do (we just log + continue — the WQ row for the biller is
 * still safety-net).
 */
export async function persistRecoveredSavedCardFromPaymentIntent(input: {
  organizationId: string;
  clientId: string;
  paymentIntentId: string;
  supabase?: SupabaseAdmin | null;
  /** Injection seam for tests — defaults to the real Stripe helpers. */
  deps?: {
    retrievePaymentIntent?: typeof retrieveConnectPaymentIntent;
    retrievePaymentMethod?: typeof retrieveConnectPaymentMethod;
    detachPaymentMethod?: typeof detachConnectPaymentMethod;
  };
}): Promise<{
  ok: boolean;
  status:
    | "saved"
    | "no_change"
    | "no_payment_intent"
    | "no_payment_method"
    | "client_not_found"
    | "no_connect_account"
    | "stripe_error"
    | "db_error";
  message?: string;
  paymentMethodId?: string | null;
}> {
  const supabase = input.supabase ?? createServerSupabaseAdminClient();
  if (!supabase) {
    return { ok: false, status: "db_error", message: "Database unavailable." };
  }
  const retrievePI = input.deps?.retrievePaymentIntent ?? retrieveConnectPaymentIntent;
  const retrievePM = input.deps?.retrievePaymentMethod ?? retrieveConnectPaymentMethod;
  const detachPM = input.deps?.detachPaymentMethod ?? detachConnectPaymentMethod;

  const client = await loadClient(supabase, input.organizationId, input.clientId);
  if (!client) return { ok: false, status: "client_not_found", message: "Client not found." };
  if (!client.stripe_connect_account_id) {
    return {
      ok: false,
      status: "no_connect_account",
      message: "Client is not pinned to a connected Stripe account.",
    };
  }

  let paymentMethodId: string | null = null;
  try {
    const pi = await retrievePI({
      connectedAccountId: client.stripe_connect_account_id,
      paymentIntentId: input.paymentIntentId,
    });
    if (!pi) return { ok: false, status: "no_payment_intent" };
    paymentMethodId = (pi.payment_method ?? "").trim() || null;
  } catch (err) {
    return {
      ok: false,
      status: "stripe_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!paymentMethodId) {
    return { ok: false, status: "no_payment_method" };
  }
  if (client.stripe_payment_method_id === paymentMethodId) {
    return { ok: true, status: "no_change", paymentMethodId };
  }

  let brand: string | null = null;
  let last4: string | null = null;
  let expMonth: number | null = null;
  let expYear: number | null = null;
  try {
    const pm = await retrievePM({
      connectedAccountId: client.stripe_connect_account_id,
      paymentMethodId,
    });
    brand = pm.card?.brand ?? null;
    last4 = pm.card?.last4 ?? null;
    expMonth = pm.card?.exp_month ?? null;
    expYear = pm.card?.exp_year ?? null;
  } catch (err) {
    return {
      ok: false,
      status: "stripe_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Detach the prior PM best-effort so we don't accrue orphans.
  if (
    client.stripe_payment_method_id &&
    client.stripe_payment_method_id !== paymentMethodId
  ) {
    try {
      await detachPM({
        connectedAccountId: client.stripe_connect_account_id,
        paymentMethodId: client.stripe_payment_method_id,
      });
    } catch {
      // ignore — already detached / unknown
    }
  }

  const nowIso = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };
  const { error: upErr } = await sb
    .from("clients")
    .update({
      stripe_payment_method_id: paymentMethodId,
      stripe_payment_method_brand: brand,
      stripe_payment_method_last4: last4,
      stripe_payment_method_exp_month: expMonth,
      stripe_payment_method_exp_year: expYear,
      stripe_payment_method_saved_at: nowIso,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", client.id);
  if (upErr) {
    return { ok: false, status: "db_error", message: upErr.message };
  }
  return { ok: true, status: "saved", paymentMethodId };
}

export async function removeSavedCard(input: {
  organizationId: string;
  clientId: string;
}): Promise<ConfirmSavedCardOutcome> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, code: "db_unavailable", message: "Database unavailable." };

  const client = await loadClient(supabase, input.organizationId, input.clientId);
  if (!client) return { ok: false, code: "client_not_found", message: "Client not found." };

  if (client.stripe_payment_method_id && client.stripe_connect_account_id) {
    try {
      await detachConnectPaymentMethod({
        connectedAccountId: client.stripe_connect_account_id,
        paymentMethodId: client.stripe_payment_method_id,
      });
    } catch {
      // Already detached — proceed with DB cleanup.
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };
  const { data: updated, error } = await sb
    .from("clients")
    .update({
      stripe_payment_method_id: null,
      stripe_payment_method_brand: null,
      stripe_payment_method_last4: null,
      stripe_payment_method_exp_month: null,
      stripe_payment_method_exp_year: null,
      stripe_payment_method_saved_at: null,
      autopay_enabled: false,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", client.id)
    .select(CLIENT_SELECT)
    .maybeSingle();
  if (error) return { ok: false, code: "db_unavailable", message: error.message };
  return { ok: true, summary: summarizeSavedCard(unwrapClient(updated)) };
}

export async function setAutopayEnabled(input: {
  organizationId: string;
  clientId: string;
  enabled: boolean;
}): Promise<ConfirmSavedCardOutcome> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, code: "db_unavailable", message: "Database unavailable." };
  const client = await loadClient(supabase, input.organizationId, input.clientId);
  if (!client) return { ok: false, code: "client_not_found", message: "Client not found." };
  if (input.enabled && !client.stripe_payment_method_id) {
    return {
      ok: false,
      code: "no_saved_card",
      message: "Add a card on file before enabling autopay.",
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };
  const { data: updated, error } = await sb
    .from("clients")
    .update({ autopay_enabled: input.enabled })
    .eq("organization_id", input.organizationId)
    .eq("id", client.id)
    .select(CLIENT_SELECT)
    .maybeSingle();
  if (error) return { ok: false, code: "db_unavailable", message: error.message };
  return { ok: true, summary: summarizeSavedCard(unwrapClient(updated)) };
}

export async function getSavedCardSummary(input: {
  organizationId: string;
  clientId: string;
}): Promise<SavedCardSummary | { ok: false; code: SavedCardError; message: string }> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, code: "db_unavailable", message: "Database unavailable." };
  const client = await loadClient(supabase, input.organizationId, input.clientId);
  if (!client) return { ok: false, code: "client_not_found", message: "Client not found." };
  return summarizeSavedCard(client);
}

export interface ChargeSavedCardInput {
  organizationId: string;
  clientId: string;
  patientInvoiceId: string;
  amountDollars: number;
  memo?: string | null;
  metadataExtra?: Record<string, string>;
}

export type ChargeSavedCardOutcome =
  | {
      ok: true;
      paymentIntentId: string;
      paymentId: string | null;
      invoiceStatus: string | null;
      balanceAmount: number | null;
      amountChargedCents: number;
      brand: string | null;
      last4: string | null;
    }
  | { ok: false; code: SavedCardError; message: string };

export async function chargeSavedCardForInvoice(
  input: ChargeSavedCardInput,
): Promise<ChargeSavedCardOutcome> {
  if (!getStripeSecretKey()) {
    return { ok: false, code: "stripe_not_configured", message: "Stripe is not set up." };
  }
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, code: "db_unavailable", message: "Database unavailable." };

  const client = await loadClient(supabase, input.organizationId, input.clientId);
  if (!client) return { ok: false, code: "client_not_found", message: "Client not found." };
  if (
    !client.stripe_connect_account_id ||
    !client.stripe_customer_id ||
    !client.stripe_payment_method_id
  ) {
    return {
      ok: false,
      code: "no_saved_card",
      message: "No card on file — save a card before charging.",
    };
  }

  const amount = Math.round(Math.max(0, Number(input.amountDollars ?? 0)) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: "stripe_error", message: "Charge amount must be > 0." };
  }
  const amountCents = Math.round(amount * 100);
  if (amountCents < 50) {
    return { ok: false, code: "stripe_error", message: "Charge amount is below the $0.50 minimum." };
  }

  const metadata: Record<string, string> = {
    origin: "workqueue_charge_card",
    organization_id: input.organizationId,
    client_id: client.id,
    patient_invoice_id: input.patientInvoiceId,
    ...(input.metadataExtra ?? {}),
  };

  try {
    const idempotencyKey = `wq-charge-${input.patientInvoiceId}-${amountCents}`;
    const intent = await createConnectOffSessionCharge({
      amountCents,
      connectedAccountId: client.stripe_connect_account_id,
      customerId: client.stripe_customer_id,
      paymentMethodId: client.stripe_payment_method_id,
      metadata,
      description: `Client invoice ${input.patientInvoiceId}`,
      idempotencyKey,
    });
    if (intent.status !== "succeeded") {
      return {
        ok: false,
        code: "stripe_error",
        message: `Stripe returned status ${intent.status}.`,
      };
    }

    // Apply the payment to the invoice.
    const posted = await recordPatientInvoicePayment({
      organizationId: input.organizationId,
      patientInvoiceId: input.patientInvoiceId,
      amount,
      paymentMethod: "card",
      externalPaymentId: intent.id,
      memo: input.memo ?? `Charged saved card (${client.stripe_payment_method_brand ?? "card"} •••• ${client.stripe_payment_method_last4 ?? ""}).`,
    });
    if (!posted.ok) {
      // Stripe charged but we couldn't ledger — surface the error so
      // the caller (and audit log) record both halves.
      return {
        ok: false,
        code: "db_unavailable",
        message: `Charge succeeded (${intent.id}) but ledger update failed: ${posted.errors[0]?.message ?? "unknown"}`,
      };
    }
    return {
      ok: true,
      paymentIntentId: intent.id,
      paymentId: posted.paymentId,
      invoiceStatus: posted.invoiceStatus,
      balanceAmount: posted.balanceAmount,
      amountChargedCents: amountCents,
      brand: client.stripe_payment_method_brand,
      last4: client.stripe_payment_method_last4,
    };
  } catch (err) {
    return mapStripeError(err);
  }
}

function mapStripeError(err: unknown):
  | { ok: false; code: SavedCardError; message: string } {
  if (err instanceof StripeRequestError) {
    const code = err.stripeCode;
    if (code === "authentication_required") {
      return {
        ok: false,
        code: "authentication_required",
        message: "Card requires 3DS authentication — client must confirm via the portal.",
      };
    }
    if (code === "card_declined") {
      return { ok: false, code: "card_declined", message: err.message };
    }
    return { ok: false, code: "stripe_error", message: err.message };
  }
  const message = err instanceof Error ? err.message : "Stripe error.";
  return { ok: false, code: "stripe_error", message };
}
