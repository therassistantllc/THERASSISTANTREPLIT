import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type DbRow = Record<string, unknown>;

function fullName(client: DbRow | null | undefined) {
  if (!client) return "Unknown client";
  const first = typeof client.first_name === "string" ? client.first_name : "";
  const last = typeof client.last_name === "string" ? client.last_name : "";
  return [first, last].filter(Boolean).join(" ") || "Unknown client";
}

function fullProviderName(provider: DbRow | null | undefined) {
  if (!provider) return "Unknown provider";
  const displayName = typeof provider.display_name === "string" ? provider.display_name.trim() : "";
  if (displayName) return displayName;
  const first = typeof provider.first_name === "string" ? provider.first_name : "";
  const last = typeof provider.last_name === "string" ? provider.last_name : "";
  return [first, last].filter(Boolean).join(" ") || "Unknown provider";
}

function isMedicaidPayerType(value: unknown): boolean {
  return typeof value === "string" && /medicaid|mcd/i.test(value);
}

export async function GET(request: Request, context: { params: Promise<{ encounterId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { encounterId } = await context.params;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    const { data: encounter, error: encounterError } = await supabase
      .from("encounters")
      .select("id, organization_id, appointment_id, client_id, provider_id, encounter_status, service_date, started_at, ended_at, required_billing_fields_complete")
      .eq("organization_id", organizationId)
      .eq("id", encounterId)
      .is("archived_at", null)
      .maybeSingle();

    if (encounterError || !encounter) {
      return NextResponse.json({ success: false, error: "Encounter not found" }, { status: 404 });
    }

    const { data: client } = await supabase
      .from("clients")
      .select("id, first_name, last_name, date_of_birth, preferred_name, pronouns")
      .eq("organization_id", organizationId)
      .eq("id", encounter.client_id)
      .is("archived_at", null)
      .maybeSingle();

    const { data: organization } = await supabase
      .from("organizations")
      .select("id, name, legal_name")
      .eq("id", organizationId)
      .is("archived_at", null)
      .maybeSingle();

    const { data: provider } = encounter.provider_id
      ? await supabase
          .from("providers")
          .select("id, first_name, last_name, display_name, credential")
          .eq("organization_id", organizationId)
          .eq("id", encounter.provider_id)
          .is("archived_at", null)
          .maybeSingle()
      : { data: null };

    const { data: appointment } = encounter.appointment_id
      ? await supabase
          .from("appointments")
          .select("id, scheduled_start_at, scheduled_end_at, appointment_type, service_location, telehealth_url, appointment_status")
          .eq("organization_id", organizationId)
          .eq("id", encounter.appointment_id)
          .is("archived_at", null)
          .maybeSingle()
      : { data: null };

    const { data: policies } = await supabase
      .from("insurance_policies")
      .select("id, payer_id, plan_name, priority, active_flag, termination_date")
      .eq("organization_id", organizationId)
      .eq("client_id", encounter.client_id)
      .is("archived_at", null)
      .order("priority", { ascending: true })
      .limit(5);

    const primaryPolicy = (policies ?? []).find((policy) => policy.active_flag !== false) ?? policies?.[0] ?? null;

    const { data: primaryPayer } = primaryPolicy?.payer_id
      ? await supabase
          .from("insurance_payers")
        .select("id, payer_name, payer_category")
          .eq("organization_id", organizationId)
          .eq("id", primaryPolicy.payer_id)
          .is("archived_at", null)
          .maybeSingle()
      : { data: null };

    const { data: diagnoses } = await supabase
      .from("encounter_diagnoses")
      .select("id, diagnosis_code, diagnosis_description, is_primary, sequence_number, present_on_claim")
      .eq("organization_id", organizationId)
      .eq("encounter_id", encounterId)
      .is("archived_at", null)
      .order("sequence_number", { ascending: true });

    const { data: serviceLines } = await supabase
      .from("encounter_service_lines")
      .select("id, service_date, sequence_number, cpt_hcpcs_code, modifier_1, modifier_2, modifier_3, modifier_4, units, charge_amount, place_of_service_code")
      .eq("organization_id", organizationId)
      .eq("encounter_id", encounterId)
      .is("archived_at", null)
      .order("sequence_number", { ascending: true });

    const { data: clinicalNote } = await supabase
      .from("encounter_clinical_notes")
      .select("id, note_status, subjective, objective, assessment, plan, signed_at, signed_by_user_id, updated_at")
      .eq("organization_id", organizationId)
      .eq("encounter_id", encounterId)
      .is("archived_at", null)
      .maybeSingle();

    return NextResponse.json({
      success: true,
      organizationId,
      encounter,
      practice: organization
        ? {
            id: String(organization.id),
            name: typeof organization.name === "string" ? organization.name : null,
            legalName: typeof organization.legal_name === "string" ? organization.legal_name : null,
          }
        : null,
      provider: provider
        ? {
            id: String(provider.id),
            name: fullProviderName(provider as DbRow),
            credential: typeof provider.credential === "string" ? provider.credential : null,
          }
        : null,
      client: client
        ? {
            id: client.id,
            name: fullName(client as DbRow),
            preferredName: client.preferred_name,
            dateOfBirth: client.date_of_birth,
            pronouns: client.pronouns,
          }
        : null,
      appointment: appointment ?? null,
      coverage: {
        isMedicaid:
          isMedicaidPayerType(primaryPayer?.payer_category) ||
          isMedicaidPayerType(primaryPayer?.payer_name) ||
          isMedicaidPayerType(primaryPolicy?.plan_name),
        primaryPayerName: primaryPayer?.payer_name ?? null,
        primaryPayerType: primaryPayer?.payer_category ?? null,
        primaryPlanName: primaryPolicy?.plan_name ?? null,
      },
      diagnoses: diagnoses ?? [],
      serviceLines: serviceLines ?? [],
      clinicalNote: clinicalNote ?? null,
    });
  } catch (error) {
    console.error("Encounter summary API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Encounter summary failed" },
      { status: 500 },
    );
  }
}
