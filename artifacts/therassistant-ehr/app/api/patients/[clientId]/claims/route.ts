import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

function text(value: unknown) {
  return String(value ?? "").trim();
}

export async function GET(request: Request, context: { params: Promise<{ clientId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 500 });

    const { clientId } = await context.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    // professional_claims uses patient_id which maps to clients.id
    const { data: claims, error } = await supabase
      .from("professional_claims")
      .select("id, claim_number, claim_status, total_charge, patient_responsibility_amount, diagnosis_codes, created_at, submitted_at, appointment_id, encounter_id, payer_profile_id")
      .eq("organization_id", organizationId)
      .eq("patient_id", clientId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });

    // Resolve payer names via payer_profiles (primary) with a fallback to the
    // patient's active insurance policy → insurance_payers so claims without
    // a payer_profile_id still show a meaningful payer label.
    const payerProfileIds = [
      ...new Set((claims ?? []).map((c: DbRow) => text(c.payer_profile_id)).filter(Boolean)),
    ];

    const { data: payerProfiles } = payerProfileIds.length
      ? await supabase
          .from("payer_profiles")
          .select("id, payer_name")
          .in("id", payerProfileIds)
      : { data: [] as DbRow[] };

    const payerProfileById = new Map<string, DbRow>(
      (payerProfiles ?? []).map((row: DbRow) => [text(row.id), row]),
    );

    let fallbackPayerName = "";
    const needsFallback = (claims ?? []).some((c: DbRow) => {
      const id = text(c.payer_profile_id);
      return !id || !payerProfileById.has(id);
    });

    if (needsFallback) {
      const { data: policies } = await supabase
        .from("insurance_policies")
        .select("id, payer_id, priority, active_flag")
        .eq("organization_id", organizationId)
        .eq("client_id", clientId)
        .is("archived_at", null);
      const sorted = [...(policies ?? [])].sort((a: DbRow, b: DbRow) => {
        const aActive = a.active_flag ? 0 : 1;
        const bActive = b.active_flag ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return Number(a.priority ?? 99) - Number(b.priority ?? 99);
      });
      const payerId = text(sorted[0]?.payer_id);
      if (payerId) {
        const { data: payer } = await supabase
          .from("insurance_payers")
          .select("payer_name")
          .eq("id", payerId)
          .maybeSingle();
        fallbackPayerName = text((payer as DbRow | null)?.payer_name);
      }
    }

    const items = (claims ?? []).map((claim: DbRow) => {
      const profile = payerProfileById.get(text(claim.payer_profile_id));
      const payerName = text(profile?.payer_name) || fallbackPayerName || null;
      return {
        id: claim.id as string,
        claimNumber: claim.claim_number as string | null,
        status: claim.claim_status as string | null,
        totalCharge: claim.total_charge as number | null,
        patientResponsibilityAmount: claim.patient_responsibility_amount as number | null,
        diagnosisCodes: (claim.diagnosis_codes ?? []) as string[],
        createdAt: claim.created_at as string | null,
        submittedAt: claim.submitted_at as string | null,
        appointmentId: claim.appointment_id as string | null,
        encounterId: claim.encounter_id as string | null,
        payerName,
      };
    });

    return NextResponse.json({ success: true, claims: items, total: items.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to load claims" },
      { status: 500 },
    );
  }
}
