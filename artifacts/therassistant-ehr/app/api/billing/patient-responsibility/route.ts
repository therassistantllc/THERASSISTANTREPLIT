import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import {
  loadPatientResponsibility,
  type PatientResponsibilityFilters,
} from "@/lib/patient-responsibility/patientResponsibilityService";

const FILTER_KEYS: Array<keyof PatientResponsibilityFilters> = [
  "practice",
  "clinician",
  "client",
  "payer",
  "dosFrom",
  "dosTo",
  "status",
  "priority",
  "minAmount",
  "maxAmount",
  "agingBucket",
  "assignedBiller",
  "carcRarc",
  "followUpDue",
];

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

    const filters: PatientResponsibilityFilters = {};
    for (const key of FILTER_KEYS) {
      const v = searchParams.get(key);
      if (v != null && v !== "") filters[key] = v;
    }

    const rows = await loadPatientResponsibility({
      supabase,
      organizationId: guard.organizationId,
      filters: Object.keys(filters).length ? filters : undefined,
    });
    return NextResponse.json({ success: true, rows, appliedFilters: filters });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed to load client responsibility queue" },
      { status: 500 },
    );
  }
}
