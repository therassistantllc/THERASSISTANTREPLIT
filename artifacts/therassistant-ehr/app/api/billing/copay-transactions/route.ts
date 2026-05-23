import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

function extractMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Copay transaction request failed";
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Service role key is required." },
        { status: 503 },
      );
    }
    const appointmentId = searchParams.get("appointmentId");
    const clientId = searchParams.get("clientId");

    let query = supabase
      .from("copay_transactions")
      .select("*")
      .eq("organization_id", organizationId)
      .order("collected_at", { ascending: false })
      .limit(100);

    if (appointmentId) query = query.eq("appointment_id", appointmentId);
    if (clientId) query = query.eq("client_id", clientId);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ success: true, transactions: data ?? [] });
  } catch (error) {
    console.error("[GET /api/billing/copay-transactions]", error);
    return NextResponse.json({ success: false, error: extractMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      organizationId?: string;
      appointmentId?: string | null;
      clientId?: string | null;
      providerId?: string | null;
      amountCents?: number;
      amountDollars?: number;
      currency?: string;
      paymentMethod?: string;
      externalReference?: string | null;
      stripePaymentLinkUrl?: string | null;
      note?: string | null;
    };

    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Service role key is required." },
        { status: 503 },
      );
    }

    const paymentMethod = String(body.paymentMethod ?? "").trim();
    if (!paymentMethod) {
      return NextResponse.json({ success: false, error: "paymentMethod is required." }, { status: 400 });
    }

    let amountCents: number;
    if (typeof body.amountCents === "number" && Number.isFinite(body.amountCents)) {
      amountCents = Math.round(body.amountCents);
    } else if (typeof body.amountDollars === "number" && Number.isFinite(body.amountDollars)) {
      amountCents = Math.round(body.amountDollars * 100);
    } else {
      return NextResponse.json({ success: false, error: "amountCents or amountDollars is required." }, { status: 400 });
    }
    if (amountCents < 0) {
      return NextResponse.json({ success: false, error: "Amount must be non-negative." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("copay_transactions")
      .insert({
        organization_id: organizationId,
        appointment_id: body.appointmentId ?? null,
        client_id: body.clientId ?? null,
        provider_id: body.providerId ?? null,
        amount_cents: amountCents,
        currency: (body.currency ?? "USD").toUpperCase(),
        payment_method: paymentMethod,
        external_reference: body.externalReference ?? null,
        stripe_payment_link_url: body.stripePaymentLinkUrl ?? null,
        note: body.note ?? null,
        collected_at: now,
        created_at: now,
        updated_at: now,
      })
      .select("*")
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, transaction: data }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/billing/copay-transactions]", error);
    return NextResponse.json({ success: false, error: extractMessage(error) }, { status: 500 });
  }
}
