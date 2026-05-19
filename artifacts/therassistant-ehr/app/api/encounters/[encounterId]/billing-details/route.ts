import { NextResponse } from "next/server";
import { captureSignedEncounterCharge } from "@/lib/charges/signedEncounterChargeCaptureService";
import { createClaimDraftFromChargeCapture } from "@/lib/claims/chargeCaptureClaimBridgeService";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type DiagnosisInput = {
  diagnosisCode?: string;
  diagnosisDescription?: string | null;
  isPrimary?: boolean;
  presentOnClaim?: boolean;
};

type ServiceLineInput = {
  serviceDate?: string;
  procedureCode?: string;
  modifier1?: string | null;
  modifier2?: string | null;
  modifier3?: string | null;
  modifier4?: string | null;
  units?: number;
  chargeAmount?: number;
  placeOfServiceCode?: string | null;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function money(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

export async function GET(request: Request, context: { params: Promise<{ encounterId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { encounterId } = await context.params;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");

    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

    const { data: encounter, error: encounterError } = await supabase
      .from("encounters")
      .select("id, client_id, provider_id, appointment_id, encounter_status, service_date, started_at, ended_at")
      .eq("organization_id", organizationId)
      .eq("id", encounterId)
      .is("archived_at", null)
      .maybeSingle();

    if (encounterError || !encounter) return NextResponse.json({ success: false, error: "Encounter not found" }, { status: 404 });

    const { data: diagnoses } = await supabase
      .from("encounter_diagnoses")
      .select("id, diagnosis_code, diagnosis_description, is_primary, sequence_number, present_on_claim")
      .eq("organization_id", organizationId)
      .eq("encounter_id", encounterId)
      .is("archived_at", null)
      .order("sequence_number", { ascending: true });

    const { data: serviceLines } = await supabase
      .from("encounter_service_lines")
      .select("id, service_date, sequence_number, cpt_hcpcs_code, modifier_1, modifier_2, modifier_3, modifier_4, units, charge_amount, place_of_service_code, rendering_provider_id")
      .eq("organization_id", organizationId)
      .eq("encounter_id", encounterId)
      .is("archived_at", null)
      .order("sequence_number", { ascending: true });

    return NextResponse.json({ success: true, organizationId, encounter, diagnoses: diagnoses ?? [], serviceLines: serviceLines ?? [] });
  } catch (error) {
    console.error("Encounter billing details GET error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Encounter billing details failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, context: { params: Promise<{ encounterId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { encounterId } = await context.params;
    const body = await request.json();
    const organizationId = text(body.organizationId);
    const diagnoses = Array.isArray(body.diagnoses) ? (body.diagnoses as DiagnosisInput[]) : [];
    const serviceLines = Array.isArray(body.serviceLines) ? (body.serviceLines as ServiceLineInput[]) : [];

    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

    const { data: encounter, error: encounterError } = await supabase
      .from("encounters")
      .select("id, client_id, provider_id, service_date, encounter_status")
      .eq("organization_id", organizationId)
      .eq("id", encounterId)
      .is("archived_at", null)
      .maybeSingle();

    if (encounterError || !encounter) return NextResponse.json({ success: false, error: "Encounter not found" }, { status: 404 });

    const now = new Date().toISOString();

    await supabase
      .from("encounter_diagnoses")
      .update({ archived_at: now, updated_at: now })
      .eq("organization_id", organizationId)
      .eq("encounter_id", encounterId)
      .is("archived_at", null);

    await supabase
      .from("encounter_service_lines")
      .update({ archived_at: now, updated_at: now })
      .eq("organization_id", organizationId)
      .eq("encounter_id", encounterId)
      .is("archived_at", null);

    const diagnosisPayload = diagnoses
      .map((diagnosis, index) => ({
        organization_id: organizationId,
        encounter_id: encounterId,
        client_id: encounter.client_id,
        diagnosis_code: text(diagnosis.diagnosisCode).toUpperCase(),
        diagnosis_description: text(diagnosis.diagnosisDescription) || null,
        is_primary: diagnosis.isPrimary ?? index === 0,
        sequence_number: index + 1,
        present_on_claim: diagnosis.presentOnClaim ?? true,
        created_at: now,
        updated_at: now,
      }))
      .filter((diagnosis) => diagnosis.diagnosis_code);

    const servicePayload = serviceLines
      .map((line, index) => ({
        organization_id: organizationId,
        encounter_id: encounterId,
        client_id: encounter.client_id,
        service_date: text(line.serviceDate) || encounter.service_date,
        sequence_number: index + 1,
        cpt_hcpcs_code: text(line.procedureCode).toUpperCase(),
        modifier_1: text(line.modifier1) || null,
        modifier_2: text(line.modifier2) || null,
        modifier_3: text(line.modifier3) || null,
        modifier_4: text(line.modifier4) || null,
        units: Number(line.units ?? 1) || 1,
        charge_amount: money(line.chargeAmount),
        place_of_service_code: text(line.placeOfServiceCode) || null,
        rendering_provider_id: encounter.provider_id,
        created_at: now,
        updated_at: now,
      }))
      .filter((line) => line.cpt_hcpcs_code && line.charge_amount > 0 && line.service_date);

    if (diagnosisPayload.length > 0) {
      const { error } = await supabase.from("encounter_diagnoses").insert(diagnosisPayload);
      if (error) throw error;
    }

    if (servicePayload.length > 0) {
      const { error } = await supabase.from("encounter_service_lines").insert(servicePayload);
      if (error) throw error;
    }

    let chargeCapture = null;
    let claimDraft = null;
    if (encounter.encounter_status === "signed") {
      chargeCapture = await captureSignedEncounterCharge({ organizationId, encounterId });
      if (chargeCapture.chargeId && chargeCapture.status === "ready_for_claim") {
        claimDraft = await createClaimDraftFromChargeCapture({ organizationId, chargeCaptureId: chargeCapture.chargeId });
      }
    }

    return NextResponse.json({
      success: true,
      encounterId,
      diagnosisCount: diagnosisPayload.length,
      serviceLineCount: servicePayload.length,
      chargeCapture,
      claimDraft,
    });
  } catch (error) {
    console.error("Encounter billing details POST error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Encounter billing details save failed" },
      { status: 500 },
    );
  }
}
