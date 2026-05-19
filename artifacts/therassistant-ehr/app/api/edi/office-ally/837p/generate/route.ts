import { NextResponse } from "next/server";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import { generateOfficeAlly837PBatch } from "@/lib/edi/officeAlly837p/generate837p";
import type {
  ClaimPartiesSnapshot,
  OfficeAllyConnection,
  OfficeAlly837PGenerationInput,
  ProfessionalClaim,
  ProfessionalClaimServiceLine,
} from "@/lib/edi/officeAlly837p/types";
import { validateOfficeAlly837PClaim } from "@/lib/edi/officeAlly837p/validate837p";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeClaim(row: Record<string, unknown>): ProfessionalClaim {
  return {
    id: asString(row.id),
    organization_id: asString(row.organization_id),
    patient_id: (row.patient_id as string | null | undefined) ?? null,
    appointment_id: (row.appointment_id as string | null | undefined) ?? null,
    payer_profile_id: (row.payer_profile_id as string | null | undefined) ?? null,
    claim_number: (row.claim_number as string | null | undefined) ?? null,
    patient_account_number: (row.patient_account_number as string | null | undefined) ?? null,
    claim_status: (row.claim_status as string | null | undefined) ?? null,
    total_charge: (row.total_charge as number | string | null | undefined) ?? 0,
    place_of_service: (row.place_of_service as string | null | undefined) ?? null,
    diagnosis_codes: Array.isArray(row.diagnosis_codes)
      ? row.diagnosis_codes.map((item) => String(item))
      : [],
    prior_authorization_number: (row.prior_authorization_number as string | null | undefined) ?? null,
    accept_assignment: typeof row.accept_assignment === "boolean" ? row.accept_assignment : true,
    benefits_assignment: typeof row.benefits_assignment === "boolean" ? row.benefits_assignment : true,
    release_of_information: typeof row.release_of_information === "boolean" ? row.release_of_information : true,
    signature_on_file: typeof row.signature_on_file === "boolean" ? row.signature_on_file : true,
    validation_errors: row.validation_errors,
    last_validated_at: (row.last_validated_at as string | null | undefined) ?? null,
    created_at: (row.created_at as string | null | undefined) ?? null,
    updated_at: (row.updated_at as string | null | undefined) ?? null,
  };
}

function normalizeServiceLine(row: Record<string, unknown>): ProfessionalClaimServiceLine {
  return {
    id: asString(row.id),
    claim_id: asString(row.claim_id),
    line_number: asNumber(row.line_number, 1),
    service_date_from: asString(row.service_date_from),
    service_date_to: (row.service_date_to as string | null | undefined) ?? null,
    procedure_code: asString(row.procedure_code),
    modifiers: Array.isArray(row.modifiers) ? row.modifiers.map((item) => String(item)) : [],
    charge_amount: (row.charge_amount as number | string | undefined) ?? 0,
    units: (row.units as number | string | undefined) ?? 1,
    diagnosis_pointers: Array.isArray(row.diagnosis_pointers)
      ? row.diagnosis_pointers.map((item) => String(item))
      : ["1"],
    place_of_service: (row.place_of_service as string | null | undefined) ?? null,
    rendering_provider_npi: (row.rendering_provider_npi as string | null | undefined) ?? null,
    authorization_number: (row.authorization_number as string | null | undefined) ?? null,
    created_at: (row.created_at as string | null | undefined) ?? null,
    updated_at: (row.updated_at as string | null | undefined) ?? null,
  };
}

function normalizeParties(row: Record<string, unknown>): ClaimPartiesSnapshot {
  return {
    id: asString(row.id),
    claim_id: asString(row.claim_id),
    billing_provider_entity_type: (row.billing_provider_entity_type === "1" ? "1" : "2") as "1" | "2",
    billing_provider_name: asString(row.billing_provider_name),
    billing_provider_first_name: (row.billing_provider_first_name as string | null | undefined) ?? null,
    billing_provider_npi: asString(row.billing_provider_npi),
    billing_provider_tax_id: asString(row.billing_provider_tax_id),
    billing_provider_tax_id_type: (row.billing_provider_tax_id_type === "SY" ? "SY" : "EI") as "EI" | "SY",
    billing_provider_address1: asString(row.billing_provider_address1),
    billing_provider_address2: (row.billing_provider_address2 as string | null | undefined) ?? null,
    billing_provider_city: asString(row.billing_provider_city),
    billing_provider_state: asString(row.billing_provider_state),
    billing_provider_zip: asString(row.billing_provider_zip),
    subscriber_last_name: asString(row.subscriber_last_name),
    subscriber_first_name: asString(row.subscriber_first_name),
    subscriber_member_id: asString(row.subscriber_member_id),
    subscriber_dob: asString(row.subscriber_dob),
    subscriber_gender:
      row.subscriber_gender === "F" || row.subscriber_gender === "M" || row.subscriber_gender === "U"
        ? row.subscriber_gender
        : null,
    subscriber_address1: asString(row.subscriber_address1),
    subscriber_city: asString(row.subscriber_city),
    subscriber_state: asString(row.subscriber_state),
    subscriber_zip: asString(row.subscriber_zip),
    patient_is_subscriber: asBoolean(row.patient_is_subscriber, true),
    patient_last_name: (row.patient_last_name as string | null | undefined) ?? null,
    patient_first_name: (row.patient_first_name as string | null | undefined) ?? null,
    patient_dob: (row.patient_dob as string | null | undefined) ?? null,
    patient_gender:
      row.patient_gender === "F" || row.patient_gender === "M" || row.patient_gender === "U"
        ? row.patient_gender
        : null,
    patient_address1: (row.patient_address1 as string | null | undefined) ?? null,
    patient_city: (row.patient_city as string | null | undefined) ?? null,
    patient_state: (row.patient_state as string | null | undefined) ?? null,
    patient_zip: (row.patient_zip as string | null | undefined) ?? null,
    payer_name: asString(row.payer_name),
    payer_id: asString(row.payer_id),
    rendering_same_as_billing: asBoolean(row.rendering_same_as_billing, true),
    rendering_provider_entity_type:
      row.rendering_provider_entity_type === "1" || row.rendering_provider_entity_type === "2"
        ? row.rendering_provider_entity_type
        : null,
    rendering_provider_last_name_or_org:
      (row.rendering_provider_last_name_or_org as string | null | undefined) ?? null,
    rendering_provider_first_name: (row.rendering_provider_first_name as string | null | undefined) ?? null,
    rendering_provider_npi: (row.rendering_provider_npi as string | null | undefined) ?? null,
    service_facility_same_as_billing: asBoolean(row.service_facility_same_as_billing, true),
    service_facility_name: (row.service_facility_name as string | null | undefined) ?? null,
    service_facility_npi: (row.service_facility_npi as string | null | undefined) ?? null,
    service_facility_address1: (row.service_facility_address1 as string | null | undefined) ?? null,
    service_facility_city: (row.service_facility_city as string | null | undefined) ?? null,
    service_facility_state: (row.service_facility_state as string | null | undefined) ?? null,
    service_facility_zip: (row.service_facility_zip as string | null | undefined) ?? null,
    created_at: (row.created_at as string | null | undefined) ?? null,
    updated_at: (row.updated_at as string | null | undefined) ?? null,
  };
}

function normalizeConnection(row: Record<string, unknown>): OfficeAllyConnection {
  const mode = row.mode === "production" ? "production" : "test";

  return {
    id: asString(row.id),
    organization_id: asString(row.organization_id),
    clearinghouse_name: asString(row.clearinghouse_name, "office_ally"),
    mode,
    submitter_id: asString(row.submitter_id),
    sender_qualifier: row.sender_qualifier === "30" ? "30" : "ZZ",
    receiver_qualifier: row.receiver_qualifier === "ZZ" ? "ZZ" : "30",
    receiver_id: asString(row.receiver_id, "330897513"),
    receiver_name: asString(row.receiver_name, "OFFICEALLY"),
    gs_receiver_code: asString(row.gs_receiver_code, "OA"),
    x12_version: asString(row.x12_version, "005010X222A1"),
    isa_usage_indicator: mode === "production" ? "P" : "T",
    sftp_host: (row.sftp_host as string | null | undefined) ?? null,
    sftp_port: typeof row.sftp_port === "number" ? row.sftp_port : 22,
    sftp_username: (row.sftp_username as string | null | undefined) ?? null,
    inbound_folder: (row.inbound_folder as string | null | undefined) ?? "inbound",
    outbound_folder: (row.outbound_folder as string | null | undefined) ?? "outbound",
    is_active: asBoolean(row.is_active, true),
    created_at: (row.created_at as string | null | undefined) ?? null,
    updated_at: (row.updated_at as string | null | undefined) ?? null,
  };
}

async function insertClaimStatusEvent(
  supabase: ReturnType<typeof createServerSupabaseAdminClientTyped>,
  claimId: string,
  source: "validation" | "837p_batch",
  status: string,
  statusMessage: string,
  rawPayload: Record<string, unknown>,
  officeAllyFileId?: string | null,
) {
  if (!supabase) return;

  await supabase.from("claim_status_events").insert({
    claim_id: claimId,
    source,
    status: status,
    status_message: statusMessage,
    raw_payload: {
      ...rawPayload,
      transaction_type: source === "837p_batch" ? "837P" : "validation",
      status_code: status,
      status_description: statusMessage,
      office_ally_file_id: officeAllyFileId ?? null,
    },
    created_at: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClientTyped();
    if (!supabase) {
      return NextResponse.json({ error: "Database connection not available" }, { status: 500 });
    }

    const body = await request.json();
    const claimId = typeof body.claimId === "string" ? body.claimId.trim() : "";

    if (!claimId) {
      return NextResponse.json({ error: "claimId is required" }, { status: 400 });
    }

    const { data: claimRow, error: claimError } = await supabase
      .from("professional_claims")
      .select("*")
      .eq("id", claimId)
      .single();

    if (claimError || !claimRow) {
      return NextResponse.json({ error: "Professional claim not found" }, { status: 404 });
    }

    const claim = normalizeClaim(claimRow as unknown as Record<string, unknown>);

    const [{ data: serviceRows, error: serviceError }, { data: partiesRow, error: partiesError }] = await Promise.all([
      supabase
        .from("professional_claim_service_lines")
        .select("*")
        .eq("claim_id", claimId)
        .order("line_number", { ascending: true }),
      supabase.from("claim_parties_snapshot").select("*").eq("claim_id", claimId).single(),
    ]);

    if (serviceError) {
      return NextResponse.json({ error: serviceError.message }, { status: 500 });
    }

    if (partiesError || !partiesRow) {
      return NextResponse.json({ error: "Claim parties snapshot not found" }, { status: 404 });
    }

    const serviceLines = (serviceRows ?? []).map((row) =>
      normalizeServiceLine(row as unknown as Record<string, unknown>),
    );
    const parties = normalizeParties(partiesRow as unknown as Record<string, unknown>);

    const { data: payerProfileRow, error: payerError } = await supabase
      .from("payer_profiles")
      .select("*")
      .eq("id", claim.payer_profile_id ?? "")
      .single();

    if (payerError || !payerProfileRow) {
      return NextResponse.json({ error: "Payer profile not found" }, { status: 404 });
    }

    const { data: connectionRow, error: connectionError } = await supabase
      .from("clearinghouse_connections")
      .select("*")
      .eq("organization_id", claim.organization_id)
      .eq("vendor", "office_ally")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (connectionError || !connectionRow) {
      return NextResponse.json({ error: "Active Office Ally clearinghouse connection not found" }, { status: 404 });
    }

    const connection = normalizeConnection(connectionRow as unknown as Record<string, unknown>);

    const { data: organizationRow } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", claim.organization_id)
      .maybeSingle();

    const submitterName =
      asString((organizationRow as Record<string, unknown> | null)?.name, "") ||
      asString(connection.submitter_id, "THERASSISTANT");

    const generationInput: OfficeAlly837PGenerationInput = {
      connection,
      submitterName,
      claim,
      serviceLines,
      parties,
      payerProfile: {
        id: asString((payerProfileRow as Record<string, unknown>).id),
        organization_id: asString((payerProfileRow as Record<string, unknown>).organization_id),
        payer_name: asString((payerProfileRow as Record<string, unknown>).payer_name),
        office_ally_payer_id: asString((payerProfileRow as Record<string, unknown>).office_ally_payer_id),
        payer_type: ((payerProfileRow as Record<string, unknown>).payer_type as string | null | undefined) ?? null,
        is_active: (payerProfileRow as Record<string, unknown>).is_active as boolean | null | undefined,
        notes: ((payerProfileRow as Record<string, unknown>).notes as string | null | undefined) ?? null,
      },
    };

    const validation = validateOfficeAlly837PClaim(generationInput);

    if (!validation.isValid) {
      await supabase
        .from("professional_claims")
        .update({
          claim_status: "validation_failed",
          validation_errors: validation.errors as unknown as import("@/lib/supabase/database.types").Json,
          last_validated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", claimId);

      await insertClaimStatusEvent(
        supabase,
        claimId,
        "validation",
        "validation_failed",
        "Claim failed Office Ally 837P validation",
        {
          errors: validation.errors,
          warnings: validation.warnings,
        },
      );

      return NextResponse.json(
        {
          error: "Claim failed Office Ally 837P validation",
          errors: validation.errors,
          warnings: validation.warnings,
        },
        { status: 400 },
      );
    }

    const batch = generateOfficeAlly837PBatch(generationInput);

    const { data: batchRow, error: batchInsertError } = await supabase
      .from("edi_batches")
      .insert({
        organization_id: claim.organization_id,
        clearinghouse_connection_id: connection.id,
        transaction_type: "837P",
        mode: connection.mode,
        file_name: batch.fileName,
        file_content: batch.fileContent,
        isa_control_number: batch.isaControlNumber,
        gs_control_number: batch.gsControlNumber,
        st_control_number: batch.stControlNumber,
        claim_count: batch.claimCount,
        status: "generated",
        generated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (batchInsertError || !batchRow) {
      return NextResponse.json(
        { error: batchInsertError?.message ?? "Failed to insert EDI batch" },
        { status: 500 },
      );
    }

    const { error: linkError } = await supabase.from("edi_batch_claims").insert({
      edi_batch_id: (batchRow as Record<string, unknown>).id as string,
      claim_id: claimId,
      created_at: new Date().toISOString(),
    });

    if (linkError) {
      return NextResponse.json({ error: linkError.message }, { status: 500 });
    }

    await supabase
      .from("professional_claims")
      .update({
        claim_status: "batched",
        validation_errors: validation.warnings as unknown as import("@/lib/supabase/database.types").Json,
        last_validated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimId);

    await insertClaimStatusEvent(
      supabase,
      claimId,
      "837p_batch",
      "batched",
      "Claim added to generated Office Ally 837P batch",
      {
        batchId: (batchRow as Record<string, unknown>).id,
        fileName: batch.fileName,
        mode: batch.mode,
        warnings: validation.warnings,
      },
      null,
    );

    return NextResponse.json({
      batchId: (batchRow as Record<string, unknown>).id,
      fileName: batch.fileName,
      warnings: validation.warnings,
      fileContent: batch.fileContent,
      notes: batch.notes,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate Office Ally 837P batch" },
      { status: 500 },
    );
  }
}
