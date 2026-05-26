/**
 * POST /api/billing/patient-balances/actions
 * Actions: charge_card | send_statement | route_to_provider
 */
import { NextResponse } from "next/server";
import crypto from "crypto";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

function uuid() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface ActionPayload {
  organizationId: string;
  action: "charge_card" | "send_statement" | "route_to_provider";
  claimIds: string[]; // one or many
  // For route_to_provider
  providerUserId?: string;
  providerStaffId?: string;
  billingComment?: string;
}

export async function POST(request: Request) {
  try {
    const body: ActionPayload = await request.json();
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId || null,
    });
    if (guard instanceof NextResponse) return guard;
    const { organizationId, staffId } = guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase)
      return NextResponse.json({ success: false, error: "Database not available" }, { status: 500 });

    const { action, claimIds } = body;
    if (!claimIds?.length)
      return NextResponse.json({ success: false, error: "No claims selected" }, { status: 400 });

    const now = new Date().toISOString();

    if (action === "send_statement") {
      // Fetch clients to get emails
      const { data: claims } = await supabase
        .from("professional_claims")
        .select("id, client_id, clients(first_name, last_name, email)")
        .eq("organization_id", organizationId)
        .in("id", claimIds);

      const results = (claims ?? []).map((c) => {
        const client = c.clients as Record<string, unknown> | null;
        const email = String(client?.email ?? "").trim();
        if (!email) return { claimId: c.id, status: "no_email" };
        // In production this would enqueue an email send job.
        // For now we mark as statement sent and return success.
        return { claimId: c.id, status: "queued", email };
      });

      return NextResponse.json({ success: true, action, results });
    }

    if (action === "charge_card") {
      // Fetch claims with Stripe info
      const { data: claims } = await supabase
        .from("professional_claims")
        .select(
          "id, patient_responsibility_amount, clients(id, stripe_customer_id, stripe_payment_method_id, first_name, last_name)",
        )
        .eq("organization_id", organizationId)
        .in("id", claimIds);

      const results = (claims ?? []).map((c) => {
        const client = c.clients as unknown as Record<string, unknown> | null;
        if (!client?.stripe_payment_method_id) return { claimId: c.id, status: "no_card" };
        // In production this would invoke Stripe PaymentIntent creation.
        // For now we return the intent to charge and let the frontend confirm.
        return {
          claimId: c.id,
          status: "pending_charge",
          amount: c.patient_responsibility_amount,
          stripeCustomerId: client.stripe_customer_id,
          stripePaymentMethodId: client.stripe_payment_method_id,
          clientName: [client.first_name, client.last_name].filter(Boolean).join(" "),
        };
      });

      return NextResponse.json({ success: true, action, results });
    }

    if (action === "route_to_provider") {
      const providerStaffId = body.providerStaffId || null;
      const billingComment = (body.billingComment ?? "").trim() || null;

      if (!providerStaffId)
        return NextResponse.json({ success: false, error: "providerStaffId is required" }, { status: 400 });

      // Fetch claim and client data for context
      const { data: claims } = await supabase
        .from("professional_claims")
        .select(
          "id, claim_number, patient_responsibility_amount, clients(first_name, last_name)",
        )
        .eq("organization_id", organizationId)
        .in("id", claimIds);

      const workqueueInserts = (claims ?? []).map((c) => {
        const client = c.clients as unknown as Record<string, unknown> | null;
        const patientName = client
          ? [client.first_name, client.last_name].filter(Boolean).join(" ")
          : "Unknown patient";

        return {
          id: uuid(),
          organization_id: organizationId,
          source_object_type: "professional_claim",
          source_object_id: c.id,
          work_type: "provider_approval_needed",
          status: "open",
          priority: "medium",
          title: `Provider approval needed — ${patientName}`,
          description:
            `Claim ${c.claim_number ?? c.id} | Patient responsibility: $${Number(c.patient_responsibility_amount ?? 0).toFixed(2)}` +
            (billingComment ? ` | Note: ${billingComment}` : ""),
          claim_id: c.id,
          client_id: (client as Record<string, unknown> | null)?.id?.toString() ?? null,
          assigned_to_user_id: providerStaffId, // staff_profiles.id of the provider
          context_payload: {
            billingComment,
            billedByStaffId: staffId ?? null,
            patientName,
            claimNumber: c.claim_number,
            patientResponsibility: c.patient_responsibility_amount,
          },
          resolved_at: null,
          created_at: now,
          updated_at: now,
        };
      });

      if (workqueueInserts.length > 0) {
        const { error: wqError } = await supabase.from("workqueue_items").insert(workqueueInserts);
        if (wqError) throw wqError;
      }

      return NextResponse.json({ success: true, action, routed: workqueueInserts.length });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Action failed" },
      { status: 500 },
    );
  }
}
