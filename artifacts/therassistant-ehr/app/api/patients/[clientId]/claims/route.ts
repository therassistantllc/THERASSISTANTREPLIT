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

    const includeArchivedParam = (searchParams.get("includeArchived") ?? "").toLowerCase();
    const includeArchived = includeArchivedParam === "1" || includeArchivedParam === "true";

    // professional_claims uses patient_id which maps to clients.id
    let query = supabase
      .from("professional_claims")
      .select("id, claim_number, claim_status, total_charge, patient_responsibility_amount, diagnosis_codes, created_at, submitted_at, appointment_id, encounter_id, payer_profile_id, archived_at")
      .eq("organization_id", organizationId)
      .eq("patient_id", clientId);
    if (!includeArchived) {
      query = query.is("archived_at", null);
    }
    const { data: claims, error } = await query
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });

    // Resolve payer names via payer_profiles (primary) with a fallback to the
    // client's active insurance policy → insurance_payers so claims without
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
        archivedAt: (claim.archived_at as string | null) ?? null,
      };
    });

    // Surface signed-but-not-yet-billed visits (charge_capture_items without a
    // professional_claim) so the user can see their visit on the Claims tab
    // even when claim creation was blocked by missing fields.
    const claimedEncounterIds = new Set(
      (claims ?? [])
        .map((c: DbRow) => text(c.encounter_id))
        .filter(Boolean),
    );

    const { data: pendingCharges } = await supabase
      .from("charge_capture_items")
      .select("id, encounter_id, appointment_id, service_date, total_charge, diagnosis_codes, charge_status, blocker_reasons, claim_id, created_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .is("claim_id", null)
      .in("charge_status", ["ready_for_claim", "blocked"])
      .order("created_at", { ascending: false })
      .limit(50);

    const pendingItems = ((pendingCharges ?? []) as DbRow[])
      .filter((row) => !claimedEncounterIds.has(text(row.encounter_id)))
      .map((row) => {
        const blockerCount = Array.isArray(row.blocker_reasons) ? row.blocker_reasons.length : 0;
        const status = String(row.charge_status ?? "");
        return {
          id: `charge:${String(row.id)}`,
          claimNumber: null,
          status: status === "ready_for_claim"
            ? "pending claim"
            : status === "blocked"
              ? `blocked${blockerCount ? ` (${blockerCount})` : ""}`
              : status,
          totalCharge: Number(row.total_charge ?? 0),
          patientResponsibilityAmount: null,
          diagnosisCodes: (row.diagnosis_codes ?? []) as string[],
          createdAt: (row.created_at ?? null) as string | null,
          submittedAt: null,
          appointmentId: (row.appointment_id ?? null) as string | null,
          encounterId: (row.encounter_id ?? null) as string | null,
          payerName: fallbackPayerName || null,
          archivedAt: null,
          isPending: true,
        };
      });

    const merged = [...pendingItems, ...items];
    return NextResponse.json({ success: true, claims: merged, total: merged.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to load claims" },
      { status: 500 },
    );
  }
}
