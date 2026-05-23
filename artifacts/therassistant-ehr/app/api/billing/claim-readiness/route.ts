import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function money(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function extractCptCodes(serviceLines: unknown): string[] {
  if (!Array.isArray(serviceLines)) return [];
  const codes: string[] = [];
  for (const line of serviceLines) {
    if (line && typeof line === "object") {
      const code = text((line as DbRow).procedure_code ?? (line as DbRow).cpt_code);
      if (code) codes.push(code);
    }
  }
  return codes;
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { data: chargeRows, error: chargeError } = await supabase
      .from("charge_capture_items")
      .select("id, encounter_id, client_id, provider_id, appointment_id, insurance_policy_id, charge_status, service_date, total_charge, diagnosis_codes, service_lines, blocker_reasons, updated_at")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .neq("charge_status", "voided")
      .order("updated_at", { ascending: false })
      .limit(100);

    if (chargeError) throw chargeError;

    const clientIds = [...new Set((chargeRows ?? []).map((row: DbRow) => text(row.client_id)).filter(Boolean))];
    const encounterIds = [...new Set((chargeRows ?? []).map((row: DbRow) => text(row.encounter_id)).filter(Boolean))];
    const providerIds = [...new Set((chargeRows ?? []).map((row: DbRow) => text(row.provider_id)).filter(Boolean))];
    const policyIds = [...new Set((chargeRows ?? []).map((row: DbRow) => text(row.insurance_policy_id)).filter(Boolean))];

    const { data: clients } = clientIds.length
      ? await supabase.from("clients").select("id, first_name, last_name, date_of_birth").in("id", clientIds)
      : { data: [] as DbRow[] };

    const { data: claims } = encounterIds.length
      ? await supabase
          .from("professional_claims")
          .select("id, patient_id, appointment_id, claim_number, claim_status, total_charge_amount, payer_profile_id, created_at, updated_at")
          .eq("organization_id", organizationId)
          .in("patient_id", clientIds)
          .neq("claim_status", "voided")
          .order("updated_at", { ascending: false })
      : { data: [] as DbRow[] };

    const { data: providers } = providerIds.length
      ? await supabase
          .from("provider_profiles")
          .select("id, staff_id, credentials")
          .in("id", providerIds)
      : { data: [] as DbRow[] };

    const staffIds = [...new Set((providers ?? []).map((row: DbRow) => text(row.staff_id)).filter(Boolean))];

    const { data: staff } = staffIds.length
      ? await supabase
          .from("staff_profiles")
          .select("id, first_name, last_name")
          .in("id", staffIds)
      : { data: [] as DbRow[] };

    const { data: policies } = policyIds.length
      ? await supabase
          .from("insurance_policies")
          .select("id, payer_id, plan_name")
          .in("id", policyIds)
      : { data: [] as DbRow[] };

    const payerIds = [...new Set((policies ?? []).map((row: DbRow) => text(row.payer_id)).filter(Boolean))];

    const { data: payers } = payerIds.length
      ? await supabase
          .from("insurance_payers")
          .select("id, payer_name")
          .in("id", payerIds)
      : { data: [] as DbRow[] };

    const payerProfileIds = [...new Set((claims ?? []).map((row: DbRow) => text(row.payer_profile_id)).filter(Boolean))];

    const { data: payerProfiles } = payerProfileIds.length
      ? await supabase
          .from("payer_profiles")
          .select("id, payer_name")
          .in("id", payerProfileIds)
      : { data: [] as DbRow[] };

    const clientById = new Map<string, DbRow>((clients ?? []).map((client: DbRow) => [text(client.id), client]));
    const staffById = new Map<string, DbRow>((staff ?? []).map((row: DbRow) => [text(row.id), row]));
    const providerById = new Map<string, DbRow>((providers ?? []).map((row: DbRow) => [text(row.id), row]));
    const policyById = new Map<string, DbRow>((policies ?? []).map((row: DbRow) => [text(row.id), row]));
    const payerById = new Map<string, DbRow>((payers ?? []).map((row: DbRow) => [text(row.id), row]));
    const payerProfileById = new Map<string, DbRow>((payerProfiles ?? []).map((row: DbRow) => [text(row.id), row]));

    const claimsByPatientAppointment = new Map<string, DbRow>();
    for (const claim of claims ?? []) {
      const key = `${text(claim.patient_id)}:${text(claim.appointment_id)}`;
      if (!claimsByPatientAppointment.has(key)) claimsByPatientAppointment.set(key, claim);
    }

    const items = (chargeRows ?? []).map((charge: DbRow) => {
      const client = clientById.get(text(charge.client_id));
      const claim = claimsByPatientAppointment.get(`${text(charge.client_id)}:${text(charge.appointment_id)}`) ?? null;
      const patientName = client ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") : "Unknown patient";

      const provider = providerById.get(text(charge.provider_id));
      const staffRow = provider ? staffById.get(text(provider.staff_id)) : null;
      const credentials = text(provider?.credentials);
      const providerNameParts = staffRow ? [staffRow.first_name, staffRow.last_name].map(text).filter(Boolean) : [];
      const providerBaseName = providerNameParts.join(" ");
      const providerName = providerBaseName
        ? credentials
          ? `${providerBaseName}, ${credentials}`
          : providerBaseName
        : "";

      const policy = policyById.get(text(charge.insurance_policy_id));
      const policyPayer = policy ? payerById.get(text(policy.payer_id)) : null;
      const claimPayerProfile = claim ? payerProfileById.get(text(claim.payer_profile_id)) : null;
      const payerName = text(policyPayer?.payer_name) || text(claimPayerProfile?.payer_name) || text(policy?.plan_name);

      const cptCodes = extractCptCodes(charge.service_lines);

      return {
        chargeCaptureId: text(charge.id),
        encounterId: text(charge.encounter_id),
        clientId: text(charge.client_id),
        patientName,
        dateOfBirth: client?.date_of_birth ?? null,
        serviceDate: charge.service_date ?? null,
        chargeStatus: charge.charge_status ?? null,
        totalCharge: money(charge.total_charge),
        diagnosisCount: arrayLength(charge.diagnosis_codes),
        serviceLineCount: arrayLength(charge.service_lines),
        cptCodes,
        providerName,
        payerName,
        blockers: Array.isArray(charge.blocker_reasons) ? charge.blocker_reasons : [],
        updatedAt: charge.updated_at ?? null,
        claim: claim
          ? {
              id: text(claim.id),
              claimNumber: claim.claim_number ?? null,
              status: claim.claim_status ?? null,
              totalChargeAmount: money(claim.total_charge_amount),
              updatedAt: claim.updated_at ?? null,
            }
          : null,
      };
    });

    const metrics = {
      total: items.length,
      blocked: items.filter((item) => item.chargeStatus === "blocked").length,
      readyForClaim: items.filter((item) => item.chargeStatus === "ready_for_claim").length,
      claimCreated: items.filter((item) => item.chargeStatus === "claim_created").length,
      validationFailed: items.filter((item) => item.claim?.status === "validation_failed").length,
      readyForBatch: items.filter((item) => item.claim?.status === "ready_for_batch").length,
    };

    return NextResponse.json({ success: true, organizationId, metrics, items });
  } catch (error) {
    console.error("Claim readiness API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Claim readiness API failed" },
      { status: 500 },
    );
  }
}
