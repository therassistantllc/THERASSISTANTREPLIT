/**
 * POST /api/billing/stripe-connect/payment-intent
 *
 * Creates a Stripe PaymentIntent on a clinician's connected Express
 * account so funds settle to their account (no platform fee). The browser
 * confirms the PaymentIntent via Stripe Elements using the returned
 * client_secret and stripeAccountId. Auto-posting to the client ledger
 * happens via the Connect webhook (and a fallback inline call from the
 * UI on success; the unique-index dedupe collapses both into one row).
 *
 * Request:
 *   { providerId, appointmentId, clientId, amountCents, organizationId? }
 * Response (200):
 *   { success, clientSecret, paymentIntentId, stripeAccountId, publishableKey }
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";
import {
  createConnectPaymentIntent,
  getStripePublishableKey,
  getStripeSecretKey,
  StripeRequestError,
} from "@/lib/stripe/connect";

export async function POST(request: Request) {
  try {
    if (!getStripeSecretKey()) {
      return NextResponse.json(
        { success: false, error: "STRIPE_SECRET_KEY not configured" },
        { status: 503 },
      );
    }
    const publishableKey = getStripePublishableKey();
    if (!publishableKey) {
      return NextResponse.json(
        {
          success: false,
          error:
            "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (or STRIPE_PUBLISHABLE_KEY) not configured — required for Stripe Elements.",
        },
        { status: 503 },
      );
    }
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 503 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      providerId?: string;
      appointmentId?: string | null;
      clientId?: string;
      amountCents?: number;
      organizationId?: string;
    };
    const providerId = String(body.providerId ?? "").trim();
    const clientId = String(body.clientId ?? "").trim();
    const organizationId = String(body.organizationId ?? DEFAULT_ORG_ID).trim();
    const appointmentId = body.appointmentId ? String(body.appointmentId) : null;
    const amountCents = Math.round(Number(body.amountCents ?? 0));

    if (!providerId) return NextResponse.json({ success: false, error: "providerId is required" }, { status: 400 });
    if (!clientId) return NextResponse.json({ success: false, error: "clientId is required" }, { status: 400 });
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return NextResponse.json({ success: false, error: "amountCents must be > 0" }, { status: 400 });
    }
    if (amountCents < 50) {
      return NextResponse.json({ success: false, error: "Stripe minimum charge is $0.50" }, { status: 400 });
    }

    const { data: provider, error: provErr } = await supabase
      .from("provider_credentialing_profiles")
      .select(
        "id, provider_name, stripe_connect_account_id, stripe_charges_enabled, stripe_details_submitted, stripe_requirements",
      )
      .eq("id", providerId)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .maybeSingle();
    if (provErr) throw provErr;
    if (!provider) {
      return NextResponse.json({ success: false, error: "Provider not found" }, { status: 404 });
    }
    const acct = (provider as { stripe_connect_account_id?: string | null }).stripe_connect_account_id ?? null;
    const chargesEnabled = Boolean((provider as { stripe_charges_enabled?: boolean }).stripe_charges_enabled);
    if (!acct) {
      return NextResponse.json(
        { success: false, error: "Provider has not connected a Stripe account yet", code: "not_connected" },
        { status: 409 },
      );
    }
    if (!chargesEnabled) {
      return NextResponse.json(
        {
          success: false,
          error: "Provider's Stripe account cannot accept charges yet — onboarding incomplete or restricted",
          code: "charges_disabled",
        },
        { status: 409 },
      );
    }

    const { data: client, error: cliErr } = await supabase
      .from("clients")
      .select("id, first_name, last_name")
      .eq("id", clientId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (cliErr) throw cliErr;
    if (!client) {
      return NextResponse.json({ success: false, error: "Client not found" }, { status: 404 });
    }

    const metadata: Record<string, string> = {
      origin: "ehr_copay",
      organization_id: organizationId,
      client_id: clientId,
      provider_id: providerId,
      ...(appointmentId ? { appointment_id: appointmentId } : {}),
    };
    const description = appointmentId
      ? `Copay for appointment ${appointmentId}`
      : `Copay for client ${clientId}`;

    const idempotencyKey = `copay-${organizationId}-${appointmentId ?? clientId}-${amountCents}`;
    const intent = await createConnectPaymentIntent({
      amountCents,
      currency: "usd",
      connectedAccountId: acct,
      metadata,
      description,
      idempotencyKey,
    });

    return NextResponse.json({
      success: true,
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      stripeAccountId: acct,
      publishableKey,
    });
  } catch (err) {
    if (err instanceof StripeRequestError) {
      return NextResponse.json(
        { success: false, error: err.message, stripeCode: err.stripeCode },
        { status: err.status === 401 ? 500 : err.status },
      );
    }
    console.error("[stripe-connect/payment-intent]", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "PaymentIntent creation failed" },
      { status: 500 },
    );
  }
}
