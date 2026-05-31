import { NextResponse, NextRequest } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";

function errMsg(e: unknown) {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message?: unknown }).message ?? "Unknown error");
  return "Unknown error";
}

/**
 * POST { organizationId, professionalClaimId? | claimId? | claimNumber?, clientId? }
 * Manually binds a professional_claim (and optionally a client) to an imported
 * payment item row. Sets match_status='matched' and payment_import_status='ready_to_post'.
 *
 * Requires an authenticated payment poster (role guard).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = createServerSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ success: false, error: "Service role key not configured" }, { status: 503 });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* allow empty */ }
  const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
  const claimNumber = typeof body.claimNumber === "string" ? body.claimNumber.trim() : "";
  const claimIdInput =
    (typeof body.professionalClaimId === "string" && body.professionalClaimId.trim()) ||
    (typeof body.claimId === "string" && body.claimId.trim()) ||
    "";

  if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
  if (!claimNumber && !claimIdInput)
    return NextResponse.json(
      { success: false, error: "professionalClaimId, claimId, or claimNumber is required" },
      { status: 400 },
    );

  try {
    await requireAuthenticatedPaymentPoster(organizationId);
    let claimId = claimIdInput;
    if (!claimId) {
      const { data: claim, error: claimErr } = await supabase
        .from("professional_claims")
        .select("id, claim_number")
        .eq("organization_id", organizationId)
        .eq("claim_number", claimNumber)
        .maybeSingle();
      if (claimErr) throw claimErr;
      if (!claim?.id) {
        return NextResponse.json({ success: false, error: `No claim found with number "${claimNumber}" in this organization.` }, { status: 404 });
      }
      claimId = String(claim.id);
    } else {
      // CRITICAL: caller-supplied claim IDs must be re-verified to belong
      // to the same organization, otherwise a biller in org A could bind
      // an ERA payment to an out-of-org claim (cross-tenant FK injection).
      const { data: ownClaim, error: ownErr } = await supabase
        .from("professional_claims")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("id", claimId)
        .maybeSingle();
      if (ownErr) throw ownErr;
      if (!ownClaim?.id) {
        return NextResponse.json(
          { success: false, error: "Professional claim not found in this organization." },
          { status: 404 },
        );
      }
    }

    const clientIdInput = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (clientIdInput) {
      // Same cross-tenant guard for clientId.
      const { data: ownClient, error: ownClientErr } = await supabase
        .from("clients")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("id", clientIdInput)
        .maybeSingle();
      if (ownClientErr) throw ownClientErr;
      if (!ownClient?.id) {
        return NextResponse.json(
          { success: false, error: "Client not found in this organization." },
          { status: 404 },
        );
      }
    }
    const updatePayload: Record<string, unknown> = {
      claim_id: claimId,
      match_status: "matched",
      payment_import_status: "ready_to_post",
      posting_ready: true,
      matched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (clientIdInput) updatePayload.client_id = clientIdInput;

    const { data, error } = await supabase
      .from("payment_import_items")
      .update(updatePayload)
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select("id, claim_id, client_id, match_status, payment_import_status")
      .single();
    if (error) throw error;

    return NextResponse.json({ success: true, payment: data });
  } catch (e) {
    if (e instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ success: false, error: e.message }, { status: 401 });
    }
    if (e instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ success: false, error: e.message }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 });
  }
}
