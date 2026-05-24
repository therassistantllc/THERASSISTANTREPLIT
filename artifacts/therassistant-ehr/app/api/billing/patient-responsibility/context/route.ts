import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { loadPatientResponsibilityContext } from "@/lib/patient-responsibility/patientResponsibilityService";

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const eraClaimPaymentId = searchParams.get("eraClaimPaymentId");
    if (!eraClaimPaymentId) {
      return NextResponse.json(
        { success: false, error: "eraClaimPaymentId required" },
        { status: 400 },
      );
    }
    const context = await loadPatientResponsibilityContext(
      supabase,
      guard.organizationId,
      eraClaimPaymentId,
    );
    if (!context) {
      return NextResponse.json({ success: false, error: "ERA payment not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, context });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed to load context" },
      { status: 500 },
    );
  }
}
