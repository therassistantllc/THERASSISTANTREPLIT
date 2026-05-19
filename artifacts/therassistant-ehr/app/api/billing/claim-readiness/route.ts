import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

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

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");

    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

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

    const { data: clients } = clientIds.length
      ? await supabase.from("clients").select("id, first_name, last_name, date_of_birth").in("id", clientIds)
      : { data: [] as DbRow[] };

    const { data: claims } = encounterIds.length
      ? await supabase
          .from("professional_claims")
          .select("id, patient_id, appointment_id, claim_number, claim_status, total_charge_amount, created_at, updated_at")
          .eq("organization_id", organizationId)
          .in("patient_id", clientIds)
          .neq("claim_status", "voided")
          .order("updated_at", { ascending: false })
      : { data: [] as DbRow[] };

    const clientById = new Map<string, DbRow>((clients ?? []).map((client: DbRow) => [text(client.id), client]));
    const claimsByPatientAppointment = new Map<string, DbRow>();
    for (const claim of claims ?? []) {
      const key = `${text(claim.patient_id)}:${text(claim.appointment_id)}`;
      if (!claimsByPatientAppointment.has(key)) claimsByPatientAppointment.set(key, claim);
    }

    const items = (chargeRows ?? []).map((charge: DbRow) => {
      const client = clientById.get(text(charge.client_id));
      const claim = claimsByPatientAppointment.get(`${text(charge.client_id)}:${text(charge.appointment_id)}`) ?? null;
      const patientName = client ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") : "Unknown patient";
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
