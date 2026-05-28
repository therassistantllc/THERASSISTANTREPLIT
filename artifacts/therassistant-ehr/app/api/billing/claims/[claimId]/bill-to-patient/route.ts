/**
 * POST /api/billing/claims/[claimId]/bill-to-patient
 * Moves a denied claim to the client responsibility queue.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ claimId: string }> },
) {
  try {
    const { claimId } = await ctx.params;
    const body = await request.json();
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId || null,
    });
    if (guard instanceof NextResponse) return guard;
    const { organizationId } = guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase)
      return NextResponse.json({ success: false, error: "Database not available" }, { status: 500 });

    // Get current claim to calculate client responsibility
    const { data: claim, error: fetchError } = await supabase
      .from("professional_claims")
      .select("id, total_charge, patient_responsibility_amount, payer_responsibility_amount")
      .eq("id", claimId)
      .eq("organization_id", organizationId)
      .single();

    if (fetchError || !claim)
      return NextResponse.json({ success: false, error: "Claim not found" }, { status: 404 });

    // Move entire charge to client responsibility
    const totalCharge = Number(claim.total_charge ?? 0);
    const currentPR = Number(claim.patient_responsibility_amount ?? 0);
    // If no PR is set, treat entire charge as client responsibility
    const newPR = currentPR > 0 ? currentPR : totalCharge;

    const { error } = await supabase
      .from("professional_claims")
      .update({
        claim_status: "patient_responsibility",
        patient_responsibility_amount: newPR,
        payer_responsibility_amount: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimId)
      .eq("organization_id", organizationId);

    if (error) throw error;

    return NextResponse.json({
      success: true,
      claimId,
      newStatus: "patient_responsibility",
      patientResponsibility: newPR,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
