/**
 * Build + persist a secondary 837P batch for a single professional claim.
 *
 * The matched primary ERA (era_claim_payments.cas_adjustments + service_lines)
 * supplies the 2320/2330A/2330B/SVD/CAS loops. When no ERA is on file we fall
 * back to the manual EOB summary persisted on the claim (no per-line SVD/CAS,
 * but the claim-level AMT*D / AMT*F2 totals still go out).
 */
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  generateAvaility837PSecondaryBatch,
  type SecondaryCobPrimaryPayer,
} from "@/lib/edi/availity837p/generate837pSecondary";
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
    prior_authorization_number:
      (row.prior_authorization_number as string | null | undefined) ?? null,
    accept_assignment: typeof row.accept_assignment === "boolean" ? row.accept_assignment : true,
    benefits_assignment:
      typeof row.benefits_assignment === "boolean" ? row.benefits_assignment : true,
    release_of_information:
      typeof row.release_of_information === "boolean" ? row.release_of_information : true,
    signature_on_file:
      typeof row.signature_on_file === "boolean" ? row.signature_on_file : true,
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
  };
}

function normalizePrimaryParties(row: Row): ClaimPartiesSnapshot {
  return {
    id: asString(row.id),
    claim_id: asString(row.claim_id),
    billing_provider_entity_type: (row.billing_provider_entity_type === "1" ? "1" : "2") as
      | "1"
      | "2",
    billing_provider_name: asString(row.billing_provider_name),
    billing_provider_first_name:
      (row.billing_provider_first_name as string | null | undefined) ?? null,
    billing_provider_npi: asString(row.billing_provider_npi),
    billing_provider_tax_id: asString(row.billing_provider_tax_id),
    billing_provider_tax_id_type: (row.billing_provider_tax_id_type === "SY" ? "SY" : "EI") as
      | "EI"
      | "SY",
    billing_provider_address1: asString(row.billing_provider_address1),
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
    rendering_provider_first_name:
      (row.rendering_provider_first_name as string | null | undefined) ?? null,
    rendering_provider_npi: (row.rendering_provider_npi as string | null | undefined) ?? null,
    service_facility_same_as_billing: asBoolean(row.service_facility_same_as_billing, true),
    service_facility_name: (row.service_facility_name as string | null | undefined) ?? null,
    service_facility_npi: (row.service_facility_npi as string | null | undefined) ?? null,
    service_facility_address1: (row.service_facility_address1 as string | null | undefined) ?? null,
    service_facility_city: (row.service_facility_city as string | null | undefined) ?? null,
    service_facility_state: (row.service_facility_state as string | null | undefined) ?? null,
    service_facility_zip: (row.service_facility_zip as string | null | undefined) ?? null,
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

export interface BuildSecondary837PBatchResult {
  ok: boolean;
  batchId?: string;
  batchNumber?: string;
  fileName?: string;
  error?: string;
}

export async function buildSecondary837PBatch(args: {
  claimId: string;
  organizationId: string;
}): Promise<BuildSecondary837PBatchResult> {
  const { claimId, organizationId } = args;
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, error: "Database connection not available" };

  // ── 1. Claim, lines, parties snapshot ──────────────────────────────
  const [{ data: claimRow, error: claimErr }, { data: lineRows, error: lineErr }, { data: partiesRow, error: partiesErr }] =
    await Promise.all([
      (supabase as any)
        .from("professional_claims")
        .select("*")
        .eq("id", claimId)
        .eq("organization_id", organizationId)
        .maybeSingle(),
      (supabase as any)
        .from("professional_claim_service_lines")
        .select("*")
        .eq("claim_id", claimId)
        .order("line_number", { ascending: true }),
      (supabase as any)
        .from("claim_parties_snapshot")
        .select("*")
        .eq("claim_id", claimId)
        .maybeSingle(),
    ]);
  if (claimErr) return { ok: false, error: claimErr.message };
  if (!claimRow) return { ok: false, error: "Claim not found" };
  if (lineErr) return { ok: false, error: lineErr.message };
  if (partiesErr) return { ok: false, error: partiesErr.message };
  if (!partiesRow) return { ok: false, error: "Claim is missing its parties snapshot" };

  const claim = normalizeClaim(claimRow as Row);
  const lines = ((lineRows ?? []) as Row[]).map(normalizeServiceLine);
  if (lines.length === 0) return { ok: false, error: "Claim has no service lines" };
  const primaryParties = normalizePrimaryParties(partiesRow as Row);

  // ── 2. Insurance policies (need primary + secondary) ───────────────
  if (!claim.patient_id) return { ok: false, error: "Claim is missing patient_id" };
  const { data: policyRows, error: policyErr } = await (supabase as any)
    .from("insurance_policies")
    .select("id, client_id, priority, payer_id, policy_number, subscriber_id, active_flag")
    .eq("organization_id", organizationId)
    .eq("client_id", claim.patient_id)
    .is("archived_at", null);
  if (policyErr) return { ok: false, error: policyErr.message };
  const policies = ((policyRows ?? []) as Row[]).filter((p) => p.active_flag !== false);
  const primaryPolicy = policies.find((p) => p.priority === "primary");
  const secondaryPolicy = policies.find((p) => p.priority === "secondary");
  if (!secondaryPolicy) {
    return { ok: false, error: "Client has no active secondary insurance policy on file" };
  }

  // ── 3. Resolve secondary subscriber + payer ────────────────────────
  const subscriberIds = [
    asString(secondaryPolicy.subscriber_id),
    primaryPolicy ? asString(primaryPolicy.subscriber_id) : "",
  ].filter(Boolean);
  const payerIds = Array.from(
    new Set(
      [
        asString(secondaryPolicy.payer_id),
        primaryPolicy ? asString(primaryPolicy.payer_id) : "",
      ].filter(Boolean),
    ),
  );
  const [{ data: subscriberRows, error: subErr }, { data: payerRows, error: payerErr }] = await Promise.all([
    subscriberIds.length
      ? (supabase as any)
          .from("insurance_subscribers")
          .select(
            "id, first_name, last_name, date_of_birth, member_id, address_line_1, city, state, postal_code",
          )
          .in("id", subscriberIds)
      : Promise.resolve({ data: [] as Row[] }),
    payerIds.length
      ? (supabase as any)
          .from("payer_profiles")
          .select("id, organization_id, payer_name, availity_payer_id")
          .in("id", payerIds)
      : Promise.resolve({ data: [] as Row[] }),
  ]);
  if (subErr) return { ok: false, error: subErr.message };
  if (payerErr) return { ok: false, error: payerErr.message };

  const subById = new Map<string, Row>(((subscriberRows ?? []) as Row[]).map((r) => [asString(r.id), r]));
  const payerByIdMap = new Map<string, Row>(((payerRows ?? []) as Row[]).map((r) => [asString(r.id), r]));

  const secondarySub = subById.get(asString(secondaryPolicy.subscriber_id));
  const secondaryPayer = payerByIdMap.get(asString(secondaryPolicy.payer_id));
  if (!secondarySub) return { ok: false, error: "Secondary insurance subscriber record not found" };
  if (!secondaryPayer)
    return { ok: false, error: "Secondary insurance payer profile not found" };

  // Parties snapshot rewritten for the SECONDARY submission — keep billing
  // provider, client demographics, and provider/facility blocks; swap the
  // subscriber + payer to point at the secondary policy.
  const secondaryMemberId =
    asString(secondarySub.member_id) || asString(secondaryPolicy.policy_number);
  const secondaryParties: ClaimPartiesSnapshot = {
    ...primaryParties,
    subscriber_last_name: asString(secondarySub.last_name) || primaryParties.subscriber_last_name,
    subscriber_first_name: asString(secondarySub.first_name) || primaryParties.subscriber_first_name,
    subscriber_member_id: secondaryMemberId,
    subscriber_dob: asString(secondarySub.date_of_birth) || primaryParties.subscriber_dob,
    subscriber_address1:
      asString(secondarySub.address_line_1) || primaryParties.subscriber_address1,
    subscriber_city: asString(secondarySub.city) || primaryParties.subscriber_city,
    subscriber_state: asString(secondarySub.state) || primaryParties.subscriber_state,
    subscriber_zip: asString(secondarySub.postal_code) || primaryParties.subscriber_zip,
    payer_name: asString(secondaryPayer.payer_name),
    payer_id: asString(secondaryPayer.availity_payer_id),
  };

  // ── 4. Primary adjudication summary (ERA or manual EOB fallback) ───
  const { data: eraRows, error: eraErr } = await (supabase as any)
    .from("era_claim_payments")
    .select(
      "id, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, payer_claim_control_number, cas_adjustments, service_lines, created_at",
    )
    .eq("organization_id", organizationId)
    .eq("professional_claim_id", claimId)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (eraErr) return { ok: false, error: eraErr.message };
  const era = ((eraRows ?? []) as Row[])[0] ?? null;

  const primarySub = primaryPolicy ? subById.get(asString(primaryPolicy.subscriber_id)) : undefined;
  const primaryPayer = primaryPolicy
    ? payerByIdMap.get(asString(primaryPolicy.payer_id))
    : undefined;

  const primaryPayerName =
    asString(primaryPayer?.payer_name) || primaryParties.payer_name || "PRIMARY PAYER";
  const primaryPayerId =
    asString(primaryPayer?.availity_payer_id) || primaryParties.payer_id || "PRIMARY";
  const primarySubscriberLast =
    asString(primarySub?.last_name) || primaryParties.subscriber_last_name;
  const primarySubscriberFirst =
    asString(primarySub?.first_name) || primaryParties.subscriber_first_name;
  const primaryMemberId =
    asString(primarySub?.member_id) ||
    (primaryPolicy ? asString(primaryPolicy.policy_number) : "") ||
    primaryParties.subscriber_member_id;

  let primary: SecondaryCobPrimaryPayer;
  if (era) {
    const casAdjustments = (Array.isArray(era.cas_adjustments) ? era.cas_adjustments : []).flatMap(
      (a: any) => {
        if (!a || typeof a !== "object") return [];
        const group = String(a.group_code ?? a.groupCode ?? "");
        const reasons: string[] = Array.isArray(a.reason_codes ?? a.reasonCodes)
          ? (a.reason_codes ?? a.reasonCodes).map(String)
          : a.reason_code || a.reasonCode || a.code
            ? [String(a.reason_code ?? a.reasonCode ?? a.code)]
            : [];
        const amount = Number(a.amount ?? a.adjustment_amount ?? 0);
        if (!group || reasons.length === 0 || !Number.isFinite(amount)) return [];
        return reasons.map((r) => ({
          group_code: group,
          reason_code: r,
          amount,
          quantity: a.quantity ?? null,
        }));
      },
    );

    const eraServiceLines = (Array.isArray(era.service_lines) ? era.service_lines : []).map(
      (sl: any) => {
        const adjustments = Array.isArray(sl?.cas_adjustments ?? sl?.adjustments)
          ? (sl.cas_adjustments ?? sl.adjustments).flatMap((a: any) => {
              if (!a || typeof a !== "object") return [];
              const group = String(a.group_code ?? a.groupCode ?? "");
              const reasons: string[] = Array.isArray(a.reason_codes ?? a.reasonCodes)
                ? (a.reason_codes ?? a.reasonCodes).map(String)
                : a.reason_code || a.reasonCode || a.code
                  ? [String(a.reason_code ?? a.reasonCode ?? a.code)]
                  : [];
              const amt = Number(a.amount ?? a.adjustment_amount ?? 0);
              if (!group || reasons.length === 0 || !Number.isFinite(amt)) return [];
              return reasons.map((r) => ({
                group_code: group,
                reason_code: r,
                amount: amt,
                quantity: a.quantity ?? null,
              }));
            })
          : [];
        return {
          service_line_id: sl?.service_line_id ?? sl?.line_id ?? null,
          procedure_code: sl?.procedure_code ?? sl?.cpt ?? null,
          paid_amount: Number(sl?.paid_amount ?? sl?.line_paid ?? sl?.payment_amount ?? 0),
          original_units: sl?.units ?? sl?.original_units ?? null,
          cas_adjustments: adjustments,
        };
      },
    );

    primary = {
      payer_name: primaryPayerName,
      payer_id: primaryPayerId,
      subscriber_last_name: primarySubscriberLast,
      subscriber_first_name: primarySubscriberFirst,
      subscriber_member_id: primaryMemberId,
      adjudication_date: asString(era.created_at),
      payer_paid_amount: Number(era.clp04_payment_amount ?? 0),
      patient_responsibility_amount: Number(era.clp05_patient_responsibility ?? 0),
      cas_adjustments: casAdjustments,
      service_lines: eraServiceLines,
    };
  } else {
    // Manual EOB fallback — claim-level AMTs only, no SVD/CAS per line.
    const eobAttachedAt = asString((claimRow as Row).secondary_billing_eob_attached_at);
    if (!eobAttachedAt) {
      return {
        ok: false,
        error:
          "No primary ERA or manual EOB on file. Attach the primary EOB before generating the secondary claim.",
      };
    }
    const payerPaid = Number(
      (claimRow as Row).payer_responsibility_amount ??
        (claimRow as Row).primary_payer_paid_amount ??
        0,
    );
    const patientResp = Number((claimRow as Row).patient_responsibility_amount ?? 0);
    primary = {
      payer_name: primaryPayerName,
      payer_id: primaryPayerId,
      subscriber_last_name: primarySubscriberLast,
      subscriber_first_name: primarySubscriberFirst,
      subscriber_member_id: primaryMemberId,
      adjudication_date: eobAttachedAt,
      payer_paid_amount: payerPaid,
      patient_responsibility_amount: patientResp,
      cas_adjustments: [],
      service_lines: [],
    };
  }

  // ── 5. Clearinghouse connection + submitter name ───────────────────
  const { data: connectionRow, error: connErr } = await (supabase as any)
    .from("clearinghouse_connections")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("vendor", "availity")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (connErr) return { ok: false, error: connErr.message };
  if (!connectionRow)
    return { ok: false, error: "Active Availity clearinghouse connection not found" };
  const connection = normalizeConnection(connectionRow as Row);

  const { data: orgRow } = await (supabase as any)
    .from("organizations")
    .select("name")
    .eq("id", organizationId)
    .maybeSingle();
  const submitterName =
    asString((orgRow as Row | null)?.name, "") ||
    asString(connection.submitter_id, "THERASSISTANT");

  // ── 6. Generate ─────────────────────────────────────────────────────
  let generated;
  try {
    generated = generateAvaility837PSecondaryBatch({
      connection,
      submitterName,
      claim,
      serviceLines: lines,
      parties: secondaryParties,
      payerProfile: {
        id: asString(secondaryPayer.id),
        organization_id: organizationId,
        payer_name: asString(secondaryPayer.payer_name),
        availity_payer_id: asString(secondaryPayer.availity_payer_id),
      },
      primary,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to build secondary 837P" };
  }

  // ── 7. Persist batch + claim link ──────────────────────────────────
  const claimShort = claimId.slice(0, 8).toUpperCase();
  const batchNumber = `SEC-${Date.now()}-${claimShort}`;
  const now = new Date().toISOString();

  // Archive any prior active secondary batch link for this claim so the
  // per-(claim, kind) unique index admits the new one.
  await (supabase as any)
    .from("claim_837p_batch_claims")
    .update({ archived_at: now })
    .eq("organization_id", organizationId)
    .eq("professional_claim_id", claimId)
    .eq("submission_kind", "secondary")
    .is("archived_at", null);

  const { data: batchInsert, error: batchErr } = await (supabase as any)
    .from("claim_837p_batches")
    .insert({
      organization_id: organizationId,
      batch_number: batchNumber,
      batch_status: "generated",
      submission_kind: "secondary",
      claim_count: 1,
      total_charge_amount: Number(claim.total_charge ?? 0),
      generated_file_name: generated.fileName,
      generated_file_content: generated.fileContent,
      created_at: now,
      updated_at: now,
    })
    .select("id, batch_number")
    .single();
  if (batchErr || !batchInsert) {
    return { ok: false, error: batchErr?.message ?? "Failed to persist secondary batch" };
  }
  const batchId = asString((batchInsert as Row).id);

  const { error: linkErr } = await (supabase as any).from("claim_837p_batch_claims").insert({
    organization_id: organizationId,
    batch_id: batchId,
    professional_claim_id: claimId,
    submission_kind: "secondary",
    created_at: now,
  });
  if (linkErr) return { ok: false, error: linkErr.message };

  return {
    ok: true,
    batchId,
    batchNumber: asString((batchInsert as Row).batch_number),
    fileName: generated.fileName,
  };
}
