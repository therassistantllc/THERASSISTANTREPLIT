import "server-only";

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export interface GetLatestEligibilityInput {
  organization_id: string;
  patient_id: string;
  payer_id?: string | null;
}

export interface LatestEligibilityResult {
  eligibilityRequestId: string | null;
  eligibilityStatus: string | null;
  requestStatus: string | null;
  payerId: string | null;
  payerName: string | null;
  copayAmount: number | null;
  deductibleRemaining: number | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  serviceTypeCode: string;
  serviceTypeDescription: string;
  coverageLevel: string | null;
  checkedAt: string | null;
  daysSinceChecked: number | null;
  displayStatus: "Active" | "Inactive" | "Not checked" | "Not checked in 30+ days" | "Unknown";
}

function baseNotChecked(): LatestEligibilityResult {
  return {
    eligibilityRequestId: null,
    eligibilityStatus: null,
    requestStatus: null,
    payerId: null,
    payerName: null,
    copayAmount: null,
    deductibleRemaining: null,
    effectiveDate: null,
    terminationDate: null,
    serviceTypeCode: "98",
    serviceTypeDescription: "Professional Services",
    coverageLevel: null,
    checkedAt: null,
    daysSinceChecked: null,
    displayStatus: "Not checked",
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function computeDaysSince(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const checkedAt = new Date(value);
  if (Number.isNaN(checkedAt.getTime())) {
    return null;
  }
  const diffMs = Date.now() - checkedAt.getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

function deriveDisplayStatus(
  eligibilityStatus: string | null,
  daysSinceChecked: number | null
): LatestEligibilityResult["displayStatus"] {
  if (daysSinceChecked === null) {
    return "Not checked";
  }
  if (daysSinceChecked > 30) {
    return "Not checked in 30+ days";
  }

  const normalized = String(eligibilityStatus || "").toLowerCase();
  if (normalized === "active") {
    return "Active";
  }
  if (normalized === "inactive") {
    return "Inactive";
  }
  return "Unknown";
}

export async function getLatestEligibilityForPatient(
  input: GetLatestEligibilityInput
): Promise<LatestEligibilityResult> {
  if (!input.organization_id || !input.patient_id) {
    return baseNotChecked();
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return baseNotChecked();
  }

  let query = supabase
    .from("eligibility_requests")
    .select(
      "id,eligibility_status,status,payer_id,payer_name,copay_amount,deductible_remaining,effective_date,termination_date,service_type_code,service_type_description,coverage_level,created_at"
    )
    .eq("organization_id", input.organization_id)
    .eq("patient_id", input.patient_id)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1);

  if (input.payer_id) {
    query = query.eq("payer_id", input.payer_id);
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data) {
    return baseNotChecked();
  }

  const checkedAt = data.created_at || null;
  const daysSinceChecked = computeDaysSince(checkedAt);
  const eligibilityStatus = data.eligibility_status || null;

  return {
    eligibilityRequestId: data.id || null,
    eligibilityStatus,
    requestStatus: data.status || null,
    payerId: data.payer_id || null,
    payerName: data.payer_name || null,
    copayAmount: toNumber(data.copay_amount),
    deductibleRemaining: toNumber(data.deductible_remaining),
    effectiveDate: data.effective_date || null,
    terminationDate: data.termination_date || null,
    serviceTypeCode: data.service_type_code || "98",
    serviceTypeDescription: data.service_type_description || "Professional Services",
    coverageLevel:
      typeof (data as { coverage_level?: string | null }).coverage_level === "string"
        ? ((data as { coverage_level?: string | null }).coverage_level as string)
        : null,
    checkedAt,
    daysSinceChecked,
    displayStatus: deriveDisplayStatus(eligibilityStatus, daysSinceChecked),
  };
}
