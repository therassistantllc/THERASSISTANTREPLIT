import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  generateAvaility837PMultiClaimBatch,
  type MultiClaimBatchClaimInput,
} from "@/lib/edi/availity837p/generate837pMultiClaimBatch";
import type {
  AvailityConnection,
  ClaimPartiesSnapshot,
  ProfessionalClaim,
  ProfessionalClaimServiceLine,
} from "@/lib/edi/availity837p/types";

type Row = Record<string, unknown>;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeClaim(row: Row): ProfessionalClaim {
  return {
    id: asString(row.id),
    organization_id: asString(row.organization_id),
    patient_id: (row.patient_id as string | null | undefined) ?? null,
    appointment_id: (row.appointment_id as string | null | undefined) ?? null,
    payer_profile_id: (row.payer_profile_id as string | null | undefined) ?? null,
    claim_number: (row.claim_number as string | null | undefined) ?? null,
    patient_account_number: (row.patient_account_number as string | null | undefined) ?? null,
    claim_status: (row.claim_status as string | null | undefined) ?? null,
    claim_frequency_code: (row.claim_frequency_code as string | null | undefined) ?? "1",
    original_payer_claim_control_number:
      (row.original_payer_claim_control_number as string | null | undefined) ?? null,
    total_charge: (row.total_charge as number | string | null | undefined) ?? 0,
    place_of_service: (row.place_of_service as string | null | undefined) ?? null,
    diagnosis_codes: Array.isArray(row.diagnosis_codes) ? row.diagnosis_codes.map(String) : [],
    prior_authorization_number: (row.prior_authorization_number as string | null | undefined) ?? null,
    accept_assignment: typeof row.accept_assignment === "boolean" ? row.accept_assignment : true,
    benefits_assignment: typeof row.benefits_assignment === "boolean" ? row.benefits_assignment : true,
    release_of_information: typeof row.release_of_information === "boolean" ? row.release_of_information : true,
    signature_on_file: typeof row.signature_on_file === "boolean" ? row.signature_on_file : true,
    validation_errors: row.validation_errors,
    last_validated_at: (row.last_validated_at as string | null | undefined) ?? null,
    created_at: (row.created_at as string | null | undefined) ?? null,
    updated_at: (row.updated_at as string | null | undefined) ?? null,
    // COB pass-through — drives the secondary-child COB loops emitted by
    // generate837pMultiClaimBatch when cob_billing_role==='secondary'.
    cob_billing_role:
      row.cob_billing_role === "primary" ||
      row.cob_billing_role === "secondary" ||
      row.cob_billing_role === "tertiary"
        ? row.cob_billing_role
        : null,
    original_claim_id: (row.original_claim_id as string | null | undefined) ?? null,
    prior_payer_profile_id: (row.prior_payer_profile_id as string | null | undefined) ?? null,
    prior_payer_paid_amount:
      (row.prior_payer_paid_amount as number | string | null | undefined) ?? null,
    prior_payer_adjustment_amount:
      (row.prior_payer_adjustment_amount as number | string | null | undefined) ?? null,
    prior_payer_patient_responsibility_amount:
      (row.prior_payer_patient_responsibility_amount as
        | number
        | string
        | null
        | undefined) ?? null,
    prior_payer_eob_data:
      row.prior_payer_eob_data && typeof row.prior_payer_eob_data === "object"
        ? (row.prior_payer_eob_data as Record<string, unknown>)
        : null,
  };
}

function normalizeServiceLine(row: Row): ProfessionalClaimServiceLine {
  return {
    id: asString(row.id),
    claim_id: asString(row.claim_id),
    line_number: asNumber(row.line_number, 1),
    service_date_from: asString(row.service_date_from),
    service_date_to: (row.service_date_to as string | null | undefined) ?? null,
    procedure_code: asString(row.procedure_code),
    modifiers: Array.isArray(row.modifiers) ? row.modifiers.map(String) : [],
    charge_amount: (row.charge_amount as number | string | undefined) ?? 0,
    units: (row.units as number | string | undefined) ?? 1,
    diagnosis_pointers: Array.isArray(row.diagnosis_pointers)
      ? row.diagnosis_pointers.map(String)
      : ["1"],
    place_of_service: (row.place_of_service as string | null | undefined) ?? null,
    rendering_provider_npi: (row.rendering_provider_npi as string | null | undefined) ?? null,
    authorization_number: (row.authorization_number as string | null | undefined) ?? null,
    created_at: (row.created_at as string | null | undefined) ?? null,
    updated_at: (row.updated_at as string | null | undefined) ?? null,
  };
}

function normalizeParties(row: Row): ClaimPartiesSnapshot {
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

function normalizeConnection(row: Row): AvailityConnection {
  const mode = row.mode === "production" ? "production" : "test";
  return {
    id: asString(row.id),
    organization_id: asString(row.organization_id),
    clearinghouse_name: asString(row.clearinghouse_name, "availity"),
    mode,
    submitter_id: asString(row.submitter_id),
    sender_qualifier: row.sender_qualifier === "30" ? "30" : "ZZ",
    receiver_qualifier: row.receiver_qualifier === "ZZ" ? "ZZ" : "30",
    receiver_id: asString(row.receiver_id, "030240928"),
    receiver_name: asString(row.receiver_name, "Availity"),
    gs_receiver_code: asString(row.gs_receiver_code, "030240928"),
    x12_version: asString(row.x12_version, "005010X222A1"),
    isa_usage_indicator: mode === "production" ? "P" : "T",
    submitter_contact_phone: (row.submitter_contact_phone as string | null | undefined) ?? null,
    submitter_contact_email: (row.submitter_contact_email as string | null | undefined) ?? null,
    is_active: asBoolean(row.is_active, true),
  };
}

export interface Rebuild837PBatchResult {
  ok: boolean;
  batchId: string;
  fileName?: string;
  claimCount?: number;
  error?: string;
}

/**
 * Loads the batch's professional claims (via claim_837p_batch_claims), runs the
 * spec-compliant Availity 837P generator over the set, and persists the new
 * file content/name back onto claim_837p_batches with batch_status='generated'.
 *
 * Throws on infrastructure failures; returns ok:false with a user-readable
 * error message for content/validation issues so the route can surface it.
 */
export async function rebuild837PBatchFile(args: {
  batchId: string;
  organizationId: string;
}): Promise<Rebuild837PBatchResult> {
  const { batchId, organizationId } = args;
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return { ok: false, batchId, error: "Database connection not available" };
  }

  const { data: linkRows, error: linkErr } = await (supabase as any)
    .from("claim_837p_batch_claims")
    .select("professional_claim_id")
    .eq("batch_id", batchId)
    .eq("organization_id", organizationId)
    .is("archived_at", null);
  if (linkErr) return { ok: false, batchId, error: linkErr.message };
  const claimIds = ((linkRows ?? []) as Row[]).map((r) => String(r.professional_claim_id));
  if (claimIds.length === 0) {
    return { ok: false, batchId, error: "Batch has no claims to rebuild" };
  }

  const { data: claimRows, error: claimErr } = await (supabase as any)
    .from("professional_claims")
    .select("*")
    .in("id", claimIds)
    .eq("organization_id", organizationId);
  if (claimErr) return { ok: false, batchId, error: claimErr.message };
  const claims = ((claimRows ?? []) as Row[]).map(normalizeClaim);
  if (claims.length !== claimIds.length) {
    return { ok: false, batchId, error: "One or more linked claims were not found" };
  }

  // Build a map of original_claim_id → most recent payer Claim Control Number
  // for any corrected children (frequency 7/8) in this batch, so the
  // generator can emit REF*F8 in loop 2300. Looked up dynamically rather
  // than persisted on the corrected claim so it tolerates ERA arriving
  // after the corrected child was created.
  const originalClaimIdByChild = new Map<string, string>();
  for (const row of (claimRows ?? []) as Row[]) {
    const freq = (row.claim_frequency_code as string | null | undefined) ?? "1";
    const orig = row.original_claim_id;
    if ((freq === "7" || freq === "8") && typeof orig === "string" && orig) {
      originalClaimIdByChild.set(asString(row.id), orig);
    }
  }
  const originalIds = Array.from(new Set(originalClaimIdByChild.values()));
  const icnByOriginal = new Map<string, string>();
  if (originalIds.length > 0) {
    const { data: eraRows } = await (supabase as any)
      .from("era_claim_payments")
      .select("professional_claim_id, payer_claim_control_number, clp01_claim_control_number, created_at")
      .in("professional_claim_id", originalIds)
      .is("archived_at", null)
      .order("created_at", { ascending: false });
    for (const row of ((eraRows ?? []) as Row[])) {
      const pcid = asString(row.professional_claim_id);
      if (!pcid || icnByOriginal.has(pcid)) continue;
      const icn =
        (typeof row.payer_claim_control_number === "string" && row.payer_claim_control_number) ||
        (typeof row.clp01_claim_control_number === "string" && row.clp01_claim_control_number) ||
        "";
      if (icn) icnByOriginal.set(pcid, icn);
    }
  }
  for (const claim of claims) {
    const origId = originalClaimIdByChild.get(claim.id);
    if (origId) {
      const icn = icnByOriginal.get(origId);
      if (icn && !claim.original_payer_claim_control_number) {
        claim.original_payer_claim_control_number = icn;
      }
    }
  }

  const [{ data: lineRows, error: lineErr }, { data: partiesRows, error: partiesErr }] = await Promise.all([
    (supabase as any)
      .from("professional_claim_service_lines")
      .select("*")
      .in("claim_id", claimIds)
      .order("line_number", { ascending: true }),
    (supabase as any).from("claim_parties_snapshot").select("*").in("claim_id", claimIds),
  ]);
  if (lineErr) return { ok: false, batchId, error: lineErr.message };
  if (partiesErr) return { ok: false, batchId, error: partiesErr.message };

  const linesByClaim = new Map<string, ProfessionalClaimServiceLine[]>();
  for (const row of (lineRows ?? []) as Row[]) {
    const cid = asString(row.claim_id);
    const line = normalizeServiceLine(row);
    if (!linesByClaim.has(cid)) linesByClaim.set(cid, []);
    linesByClaim.get(cid)!.push(line);
  }

  const partiesByClaim = new Map<string, ClaimPartiesSnapshot>();
  for (const row of (partiesRows ?? []) as Row[]) {
    partiesByClaim.set(asString(row.claim_id), normalizeParties(row));
  }

  const payerProfileIds = Array.from(
    new Set(claims.map((c) => c.payer_profile_id).filter((v): v is string => !!v)),
  );
  const payerById = new Map<string, MultiClaimBatchClaimInput["payerProfile"]>();
  if (payerProfileIds.length > 0) {
    const { data: payerRows, error: payerErr } = await (supabase as any)
      .from("payer_profiles")
      .select("id, organization_id, payer_name, availity_payer_id, payer_type, is_active, notes")
      .in("id", payerProfileIds);
    if (payerErr) return { ok: false, batchId, error: payerErr.message };
    for (const row of (payerRows ?? []) as Row[]) {
      payerById.set(asString(row.id), {
        id: asString(row.id),
        organization_id: asString(row.organization_id),
        payer_name: asString(row.payer_name),
        availity_payer_id: asString(row.availity_payer_id),
        payer_type: (row.payer_type as string | null | undefined) ?? null,
        is_active: (row.is_active as boolean | null | undefined) ?? null,
        notes: (row.notes as string | null | undefined) ?? null,
      });
    }
  }

  const { data: connectionRow, error: connErr } = await (supabase as any)
    .from("clearinghouse_connections")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("vendor", "availity")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (connErr) return { ok: false, batchId, error: connErr.message };
  if (!connectionRow) {
    return { ok: false, batchId, error: "Active Availity clearinghouse connection not found" };
  }
  const connection = normalizeConnection(connectionRow as Row);

  const { data: orgRow } = await (supabase as any)
    .from("organizations")
    .select("name")
    .eq("id", organizationId)
    .maybeSingle();
  const submitterName =
    asString((orgRow as Row | null)?.name, "") || asString(connection.submitter_id, "THERASSISTANT");

  const claimInputs: MultiClaimBatchClaimInput[] = [];
  for (const claim of claims) {
    const serviceLines = linesByClaim.get(claim.id) ?? [];
    const parties = partiesByClaim.get(claim.id);
    if (!parties) {
      return { ok: false, batchId, error: `Claim ${claim.id} is missing its parties snapshot` };
    }
    const payerProfile = claim.payer_profile_id ? payerById.get(claim.payer_profile_id) : undefined;
    if (!payerProfile) {
      return { ok: false, batchId, error: `Claim ${claim.id} is missing its payer profile` };
    }
    claimInputs.push({ claim, serviceLines, parties, payerProfile });
  }

  let generated;
  try {
    generated = generateAvaility837PMultiClaimBatch({
      connection,
      submitterName,
      claims: claimInputs,
    });
  } catch (e) {
    return {
      ok: false,
      batchId,
      error: e instanceof Error ? e.message : "Failed to build 837P content",
    };
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await (supabase as any)
    .from("claim_837p_batches")
    .update({
      batch_status: "generated",
      generated_file_content: generated.fileContent,
      generated_file_name: generated.fileName,
      claim_count: generated.claimCount,
      submission_error: null,
      updated_at: now,
    })
    .eq("id", batchId)
    .eq("organization_id", organizationId);
  if (updateErr) return { ok: false, batchId, error: updateErr.message };

  return {
    ok: true,
    batchId,
    fileName: generated.fileName,
    claimCount: generated.claimCount,
  };
}
