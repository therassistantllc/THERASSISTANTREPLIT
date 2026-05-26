/**
 * PATCH /api/billing/claims/[claimId]/correct
 * Saves corrected claim data and queues for resubmission.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

interface CorrectionBody {
  organizationId: string;
  diagnosisCodes?: string[];
  placeOfService?: string;
  priorAuthorizationNumber?: string;
  billingNotes?: string;
  correctionReason?: string;
  correctionType?: "replacement" | "void";
  serviceLinesJson?: unknown; // free-form from CMS-1500 edits
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ claimId: string }> },
) {
  try {
    const { claimId } = await ctx.params;
    const body: CorrectionBody = await request.json();
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId || null,
    });
    if (guard instanceof NextResponse) return guard;
    const { organizationId } = guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase)
      return NextResponse.json({ success: false, error: "Database not available" }, { status: 500 });

    const now = new Date().toISOString();

    // Build update payload — only include fields that were provided
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: Record<string, any> = {
      claim_status: "ready_for_batch",
      correction_status: "pending_resubmission",
      correction_reason: body.correctionReason ?? "Corrected claim",
      correction_type: body.correctionType ?? "replacement",
      correction_sent_at: null,
      updated_at: now,
    };

    if (body.diagnosisCodes !== undefined) update.diagnosis_codes = body.diagnosisCodes;
    if (body.placeOfService !== undefined) update.place_of_service = body.placeOfService;
    if (body.priorAuthorizationNumber !== undefined)
      update.prior_authorization_number = body.priorAuthorizationNumber || null;
    if (body.billingNotes !== undefined) update.billing_notes = body.billingNotes || null;

    const { error } = await supabase
      .from("professional_claims")
      .update(update)
      .eq("id", claimId)
      .eq("organization_id", organizationId);

    if (error) throw error;

    return NextResponse.json({ success: true, claimId, status: "ready_for_batch" });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
