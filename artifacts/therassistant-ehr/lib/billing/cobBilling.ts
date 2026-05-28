/**
 * Coordination-of-Benefits billing helpers used by the COB Issues
 * queue's "Bill primary" / "Bill secondary" actions.
 *
 * `cloneClaimForSecondary` clones a primary-billed `professional_claims`
 * row into a child claim payable to the secondary policy's payer. The
 * child is stamped with the prior-payer (primary) paid / adjustment /
 * client-responsibility amounts pulled from the most recent ERA on the
 * original claim (or the manually-attached EOB reference if no ERA is
 * on file). The 837P assembler reads `prior_payer_*` off the child when
 * it is later batched, so Loop 2320 (SBR*S / AMT / CAS) can be filled
 * without re-deriving values at assembly time.
 *
 * `repointClaimToPrimary` re-targets an existing claim that was sent to
 * the wrong (secondary) payer back at the chosen primary policy's
 * payer, flipping it back to `ready_for_batch` so the next batch run
 * picks it up. Used when the COB order was simply wrong.
 *
 * Both helpers also persist the biller's chosen policy order onto
 * `insurance_policies.priority` so other queues see the same truth.
 */

type AnyClient = any;

const PRIORITY_FOR_INDEX = ["primary", "secondary", "tertiary"] as const;

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

export interface CobActionResult {
  ok: true;
  childClaimId?: string;
  childClaimNumber?: string | null;
  appliedPriorities?: Array<{ policyId: string; priority: string }>;
}

export interface CobActionError {
  ok: false;
  status: number;
  error: string;
}

interface ReorderArgs {
  supabase: AnyClient;
  organizationId: string;
  clientId: string;
  orderedPolicyIds: string[];
}

async function reorderPolicies({
  supabase,
  organizationId,
  clientId,
  orderedPolicyIds,
}: ReorderArgs): Promise<Array<{ policyId: string; priority: string }>> {
  const nowIso = new Date().toISOString();
  const applied: Array<{ policyId: string; priority: string }> = [];
  const ids = orderedPolicyIds.map((x) => String(x)).filter(Boolean);
  for (let i = 0; i < Math.min(ids.length, PRIORITY_FOR_INDEX.length); i += 1) {
    const policyId = ids[i];
    const priority = PRIORITY_FOR_INDEX[i];
    const { error } = await supabase
      .from("insurance_policies")
      .update({ priority, updated_at: nowIso })
      .eq("id", policyId)
      .eq("organization_id", organizationId)
      .eq("client_id", clientId);
    if (error) throw error;
    applied.push({ policyId, priority });
  }
  return applied;
}

async function cloneServiceLines(
  supabase: AnyClient,
  fromClaimId: string,
  toClaimId: string,
) {
  const { data: lines, error } = await supabase
    .from("professional_claim_service_lines")
    .select(
      "line_number, service_date_from, service_date_to, procedure_code, modifiers, charge_amount, units, diagnosis_pointers, place_of_service, rendering_provider_npi, authorization_number",
    )
    .eq("claim_id", fromClaimId)
    .order("line_number", { ascending: true });
  if (error) throw error;
  const rows = ((lines as any[]) ?? []).map((l) => ({
    claim_id: toClaimId,
    line_number: l.line_number,
    service_date_from: l.service_date_from,
    service_date_to: l.service_date_to,
    procedure_code: l.procedure_code,
    modifiers: l.modifiers ?? [],
    charge_amount: l.charge_amount,
    units: l.units,
    diagnosis_pointers: l.diagnosis_pointers ?? ["1"],
    place_of_service: l.place_of_service,
    rendering_provider_npi: l.rendering_provider_npi,
    authorization_number: l.authorization_number,
  }));
  if (rows.length === 0) return;
  const { error: insErr } = await supabase
    .from("professional_claim_service_lines")
    .insert(rows);
  if (insErr) throw insErr;
}

interface PartiesCloneOverrides {
  // Secondary subscriber/payer values that should replace the primary
  // values copied off the original parties snapshot. When set, the cloned
  // parties for the child claim point at the SECONDARY policy so the 837P
  // 2010BA/2010BB segments route to the secondary payer.
  secondarySubscriber?: {
    last_name?: string | null;
    first_name?: string | null;
    member_id?: string | null;
    dob?: string | null;
    address1?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  } | null;
  secondaryPayer?: { name?: string | null; id?: string | null } | null;
}

interface ClonedPrimaryRefs {
  // Primary subscriber/payer identifiers copied off the original parties
  // snapshot — folded into prior_payer_eob_data so the 837P generator can
  // emit 2330A/2330B without re-querying.
  subscriber_last_name: string;
  subscriber_first_name: string | null;
  subscriber_member_id: string;
  payer_name: string;
  payer_id: string;
}

async function cloneClaimParties(
  supabase: AnyClient,
  fromClaimId: string,
  toClaimId: string,
  overrides: PartiesCloneOverrides = {},
): Promise<ClonedPrimaryRefs | null> {
  const { data: parties } = await supabase
    .from("claim_parties_snapshot")
    .select("*")
    .eq("claim_id", fromClaimId)
    .maybeSingle();
  if (!parties) return null;
  const {
    id: _id,
    claim_id: _cid,
    created_at: _ca,
    updated_at: _ua,
    ...rest
  } = parties as any;

  const primaryRefs: ClonedPrimaryRefs = {
    subscriber_last_name: text(rest.subscriber_last_name),
    subscriber_first_name: rest.subscriber_first_name
      ? text(rest.subscriber_first_name)
      : null,
    subscriber_member_id: text(rest.subscriber_member_id),
    payer_name: text(rest.payer_name),
    payer_id: text(rest.payer_id),
  };

  const sub = overrides.secondarySubscriber;
  const payer = overrides.secondaryPayer;
  const rewritten = { ...rest };
  if (sub) {
    if (sub.last_name) rewritten.subscriber_last_name = sub.last_name;
    if (sub.first_name !== undefined && sub.first_name !== null) {
      rewritten.subscriber_first_name = sub.first_name;
    }
    if (sub.member_id) rewritten.subscriber_member_id = sub.member_id;
    if (sub.dob) rewritten.subscriber_dob = sub.dob;
    if (sub.address1) rewritten.subscriber_address1 = sub.address1;
    if (sub.city) rewritten.subscriber_city = sub.city;
    if (sub.state) rewritten.subscriber_state = sub.state;
    if (sub.zip) rewritten.subscriber_zip = sub.zip;
  }
  if (payer) {
    if (payer.name) rewritten.payer_name = payer.name;
    if (payer.id) rewritten.payer_id = payer.id;
  }

  await supabase
    .from("claim_parties_snapshot")
    .insert({ ...rewritten, claim_id: toClaimId });
  return primaryRefs;
}

interface SecondaryPartiesContext {
  overrides: PartiesCloneOverrides;
  primarySubscriber: {
    last_name: string;
    first_name: string;
    member_id: string;
  } | null;
  primaryPayer: { name: string; id: string } | null;
}

/**
 * Load the secondary subscriber + payer from insurance_subscribers /
 * payer_profiles so we can both (a) rewrite the child's parties snapshot
 * to point at the secondary policy and (b) stash the *primary* subscriber
 * + payer identifying fields onto prior_payer_eob_data for the COB loops.
 *
 * Tolerant of missing rows / missing tables in test fixtures — callers
 * fall back to whatever the parties snapshot already carries.
 */
async function loadSecondaryPartiesContext(
  supabase: AnyClient,
  organizationId: string,
  primaryPolicy: any,
  secondaryPolicy: any,
): Promise<SecondaryPartiesContext> {
  const subIds = [
    text(secondaryPolicy?.subscriber_id),
    text(primaryPolicy?.subscriber_id),
  ].filter(Boolean);
  const payerIds = Array.from(
    new Set(
      [text(secondaryPolicy?.payer_id), text(primaryPolicy?.payer_id)].filter(
        Boolean,
      ),
    ),
  );

  let subs: any[] = [];
  let payers: any[] = [];
  try {
    if (subIds.length) {
      const { data } = await supabase
        .from("insurance_subscribers")
        .select(
          "id, first_name, last_name, date_of_birth, member_id, address_line_1, city, state, postal_code",
        )
        .in("id", subIds);
      subs = (data as any[]) ?? [];
    }
  } catch {
    subs = [];
  }
  try {
    if (payerIds.length) {
      const { data } = await supabase
        .from("payer_profiles")
        .select("id, organization_id, payer_name, availity_payer_id")
        .in("id", payerIds);
      payers = (data as any[]) ?? [];
    }
  } catch {
    payers = [];
  }

  const subById = new Map<string, any>(subs.map((s) => [text(s.id), s]));
  const payerById = new Map<string, any>(payers.map((p) => [text(p.id), p]));

  const secSub = subById.get(text(secondaryPolicy?.subscriber_id));
  const secPayer = payerById.get(text(secondaryPolicy?.payer_id));
  const priSub = primaryPolicy
    ? subById.get(text(primaryPolicy?.subscriber_id))
    : undefined;
  const priPayer = primaryPolicy
    ? payerById.get(text(primaryPolicy?.payer_id))
    : undefined;

  const overrides: PartiesCloneOverrides = {
    secondarySubscriber: secSub
      ? {
          last_name: text(secSub.last_name) || null,
          first_name: text(secSub.first_name) || null,
          member_id:
            text(secSub.member_id) || text(secondaryPolicy?.policy_number) || null,
          dob: text(secSub.date_of_birth) || null,
          address1: text(secSub.address_line_1) || null,
          city: text(secSub.city) || null,
          state: text(secSub.state) || null,
          zip: text(secSub.postal_code) || null,
        }
      : null,
    secondaryPayer: secPayer
      ? {
          name: text(secPayer.payer_name) || null,
          id: text(secPayer.availity_payer_id) || null,
        }
      : null,
  };

  return {
    overrides,
    primarySubscriber: priSub
      ? {
          last_name: text(priSub.last_name),
          first_name: text(priSub.first_name),
          member_id:
            text(priSub.member_id) || text(primaryPolicy?.policy_number) || "",
        }
      : null,
    primaryPayer: priPayer
      ? {
          name: text(priPayer.payer_name),
          id: text(priPayer.availity_payer_id),
        }
      : null,
  };
}

interface PriorPayerSnapshot {
  paid_amount: number;
  adjustment_amount: number;
  patient_responsibility: number;
  payer_profile_id: string | null;
  eob_data: Record<string, unknown>;
}

/**
 * Pulls the most recent ERA on `claimId` (or falls back to the manual
 * `secondary_billing_eob_reference`) into the prior-payer snapshot
 * stamped onto the child claim.
 */
async function loadPriorPayerSnapshot(
  supabase: AnyClient,
  organizationId: string,
  claim: any,
): Promise<PriorPayerSnapshot | null> {
  const { data: eraRows, error } = await supabase
    .from("era_claim_payments")
    .select(
      "id, era_import_batch_id, professional_claim_id, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, payer_claim_control_number, cas_adjustments, service_lines, created_at, archived_at",
    )
    .eq("organization_id", organizationId)
    .eq("professional_claim_id", text(claim.id))
    .is("archived_at", null);
  if (error) throw error;

  const eras = ((eraRows as any[]) ?? []).filter(Boolean);
  eras.sort((a, b) => text(b.created_at).localeCompare(text(a.created_at)));
  const era = eras[0] ?? null;

  if (era) {
    const totalCharge = money(era.clp03_total_charge ?? claim.total_charge);
    const paid = money(era.clp04_payment_amount);
    const patientResp = money(era.clp05_patient_responsibility);
    const adjustment = Math.max(
      0,
      Math.round((totalCharge - paid - patientResp) * 100) / 100,
    );
    return {
      paid_amount: paid,
      adjustment_amount: adjustment,
      patient_responsibility: patientResp,
      payer_profile_id: text(claim.payer_profile_id) || null,
      eob_data: {
        source: "era",
        era_payment_id: text(era.id) || null,
        era_batch_id: text(era.era_import_batch_id) || null,
        payer_claim_control_number:
          text(era.payer_claim_control_number) || null,
        clp03_total_charge: totalCharge,
        clp04_payment_amount: paid,
        clp05_patient_responsibility: patientResp,
        cas_adjustments: Array.isArray(era.cas_adjustments)
          ? era.cas_adjustments
          : [],
        service_lines: Array.isArray(era.service_lines) ? era.service_lines : [],
        posted_at: text(era.created_at) || null,
      },
    };
  }

  // Fallback: manual EOB reference on the original claim.
  if (claim.secondary_billing_eob_attached_at) {
    return {
      paid_amount: money(claim.payer_responsibility_amount),
      adjustment_amount: 0,
      patient_responsibility: money(claim.patient_responsibility_amount),
      payer_profile_id: text(claim.payer_profile_id) || null,
      eob_data: {
        source: "manual",
        reference: text(claim.secondary_billing_eob_reference) || null,
        attached_at: text(claim.secondary_billing_eob_attached_at) || null,
      },
    };
  }

  return null;
}

export interface BillSecondaryArgs {
  supabase: AnyClient;
  organizationId: string;
  claimId: string;
  orderedPolicyIds?: string[] | null;
}

/**
 * Clone the original claim into a child secondary-payer claim and mark
 * the original `secondary_billing_state='generated'`. Returns the new
 * child claim id.
 */
export async function billSecondary(
  args: BillSecondaryArgs,
): Promise<CobActionResult | CobActionError> {
  const { supabase, organizationId, claimId } = args;
  const orderedPolicyIds = (args.orderedPolicyIds ?? []).filter(Boolean);

  // 1. Load original claim.
  const { data: claim, error: claimErr } = await supabase
    .from("professional_claims")
    .select(
      "id, organization_id, patient_id, appointment_id, payer_profile_id, claim_status, claim_frequency_code, total_charge, place_of_service, diagnosis_codes, prior_authorization_number, accept_assignment, benefits_assignment, release_of_information, signature_on_file, patient_responsibility_amount, payer_responsibility_amount, secondary_billing_state, secondary_billing_eob_attached_at, secondary_billing_eob_reference",
    )
    .eq("id", claimId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claim) {
    return { ok: false, status: 404, error: "Claim not found" };
  }

  const clientId = text((claim as any).patient_id);
  if (!clientId) {
    return {
      ok: false,
      status: 422,
      error: "Original claim has no client — cannot bill secondary",
    };
  }

  // 2. Optionally reorder policies first, then resolve secondary.
  let appliedPriorities: Array<{ policyId: string; priority: string }> = [];
  if (orderedPolicyIds.length) {
    appliedPriorities = await reorderPolicies({
      supabase,
      organizationId,
      clientId,
      orderedPolicyIds,
    });
  }

  const { data: policies, error: polErr } = await supabase
    .from("insurance_policies")
    .select(
      "id, payer_id, priority, active_flag, archived_at, subscriber_id, policy_number",
    )
    .eq("organization_id", organizationId)
    .eq("client_id", clientId)
    .is("archived_at", null);
  if (polErr) throw polErr;

  const activePolicies = ((policies as any[]) ?? []).filter(
    (p) => p.active_flag !== false,
  );
  const primaryPolicy =
    activePolicies.find((p) => text(p.priority) === "primary") ?? null;
  const secondaryPolicy =
    activePolicies.find((p) => text(p.priority) === "secondary") ?? null;
  if (!secondaryPolicy) {
    return {
      ok: false,
      status: 422,
      error:
        "No active secondary policy on file. Reorder the client's insurance first.",
    };
  }
  const secondaryPayerId = text(secondaryPolicy.payer_id) || null;
  if (!secondaryPayerId) {
    return {
      ok: false,
      status: 422,
      error: "Secondary policy has no payer linked",
    };
  }

  // 3. Pull prior-payer EOB snapshot.
  const priorPayer = await loadPriorPayerSnapshot(
    supabase,
    organizationId,
    claim,
  );
  if (!priorPayer) {
    return {
      ok: false,
      status: 422,
      error:
        "Primary payer EOB not on file yet. Attach the prior EOB before billing secondary.",
    };
  }

  // 3b. Load secondary subscriber + secondary payer (to rewrite the child's
  // parties snapshot to point at the secondary policy) and primary
  // subscriber + primary payer identifying fields (so the 837P generator
  // can emit Loop 2330A/2330B without re-querying). All lookups are
  // tolerant of missing rows / missing tables in test fixtures.
  const secondaryCtx = await loadSecondaryPartiesContext(
    supabase,
    organizationId,
    primaryPolicy,
    secondaryPolicy,
  );

  // Fold the primary subscriber + payer identifiers into prior_payer_eob_data
  // so cobSegments.deriveCobFromClaim can build the 2330A/2330B segments.
  const primarySubFromCtx = secondaryCtx.primarySubscriber;
  const primaryPayerFromCtx = secondaryCtx.primaryPayer;
  const enrichedEobData: Record<string, unknown> = { ...priorPayer.eob_data };
  if (primarySubFromCtx) {
    enrichedEobData.primary_subscriber_last_name = primarySubFromCtx.last_name;
    enrichedEobData.primary_subscriber_first_name = primarySubFromCtx.first_name;
    enrichedEobData.primary_subscriber_member_id = primarySubFromCtx.member_id;
  }
  if (primaryPayerFromCtx) {
    enrichedEobData.primary_payer_name = primaryPayerFromCtx.name;
    enrichedEobData.primary_payer_id = primaryPayerFromCtx.id;
  }

  // 4. Insert child claim.
  const nowIso = new Date().toISOString();
  const insertPayload: Record<string, unknown> = {
    organization_id: organizationId,
    patient_id: (claim as any).patient_id ?? null,
    payer_profile_id: secondaryPayerId,
    appointment_id: (claim as any).appointment_id ?? null,
    claim_status: "ready_for_batch",
    claim_frequency_code: (claim as any).claim_frequency_code ?? "1",
    total_charge: (claim as any).total_charge ?? 0,
    place_of_service: (claim as any).place_of_service ?? null,
    diagnosis_codes: (claim as any).diagnosis_codes ?? [],
    prior_authorization_number:
      (claim as any).prior_authorization_number ?? null,
    accept_assignment: (claim as any).accept_assignment ?? true,
    benefits_assignment: (claim as any).benefits_assignment ?? true,
    release_of_information: (claim as any).release_of_information ?? true,
    signature_on_file: (claim as any).signature_on_file ?? true,
    original_claim_id: claimId,
    cob_billing_role: "secondary",
    prior_payer_paid_amount: priorPayer.paid_amount,
    prior_payer_adjustment_amount: priorPayer.adjustment_amount,
    prior_payer_patient_responsibility_amount: priorPayer.patient_responsibility,
    prior_payer_profile_id: priorPayer.payer_profile_id,
    prior_payer_eob_data: enrichedEobData,
  };

  const { data: created, error: insErr } = await supabase
    .from("professional_claims")
    .insert(insertPayload)
    .select("id, claim_number")
    .single();
  if (insErr) {
    return { ok: false, status: 422, error: insErr.message };
  }
  const childId = text((created as any).id);
  const childNumber = text((created as any).claim_number) || null;

  // 5. Clone parties (rewritten to point at the SECONDARY subscriber/payer)
  // + service lines.
  await cloneClaimParties(supabase, claimId, childId, secondaryCtx.overrides);
  await cloneServiceLines(supabase, claimId, childId);

  // 6. Mark original as having generated its secondary claim.
  await supabase
    .from("professional_claims")
    .update({
      secondary_billing_state: "generated",
      secondary_billing_generated_at: nowIso,
      secondary_billing_last_error: null,
      updated_at: nowIso,
    })
    .eq("id", claimId)
    .eq("organization_id", organizationId);

  return {
    ok: true,
    childClaimId: childId,
    childClaimNumber: childNumber,
    appliedPriorities,
  };
}

export interface BillPrimaryArgs {
  supabase: AnyClient;
  organizationId: string;
  claimId: string;
  orderedPolicyIds?: string[] | null;
}

/**
 * Re-point an existing claim at the (newly chosen) primary payer and
 * push it back into the ready-for-batch queue. Used when the COB order
 * was wrong and the original was billed to the secondary payer.
 */
export async function billPrimary(
  args: BillPrimaryArgs,
): Promise<CobActionResult | CobActionError> {
  const { supabase, organizationId, claimId } = args;
  const orderedPolicyIds = (args.orderedPolicyIds ?? []).filter(Boolean);

  const { data: claim, error: claimErr } = await supabase
    .from("professional_claims")
    .select(
      "id, organization_id, patient_id, payer_profile_id, claim_status",
    )
    .eq("id", claimId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claim) {
    return { ok: false, status: 404, error: "Claim not found" };
  }

  const clientId = text((claim as any).patient_id);
  if (!clientId) {
    return {
      ok: false,
      status: 422,
      error: "Original claim has no client — cannot bill primary",
    };
  }

  // Reorder first if the biller picked a new primary.
  let appliedPriorities: Array<{ policyId: string; priority: string }> = [];
  if (orderedPolicyIds.length) {
    appliedPriorities = await reorderPolicies({
      supabase,
      organizationId,
      clientId,
      orderedPolicyIds,
    });
  }

  const { data: policies, error: polErr } = await supabase
    .from("insurance_policies")
    .select("id, payer_id, priority, active_flag, archived_at")
    .eq("organization_id", organizationId)
    .eq("client_id", clientId)
    .is("archived_at", null);
  if (polErr) throw polErr;

  const activePolicies = ((policies as any[]) ?? []).filter(
    (p) => p.active_flag !== false,
  );
  const primaryPolicy =
    activePolicies.find((p) => text(p.priority) === "primary") ?? null;
  if (!primaryPolicy) {
    return {
      ok: false,
      status: 422,
      error:
        "No active primary policy on file. Reorder the client's insurance first.",
    };
  }
  const primaryPayerId = text(primaryPolicy.payer_id) || null;
  if (!primaryPayerId) {
    return {
      ok: false,
      status: 422,
      error: "Primary policy has no payer linked",
    };
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("professional_claims")
    .update({
      payer_profile_id: primaryPayerId,
      claim_status: "ready_for_batch",
      cob_billing_role: "primary",
      updated_at: nowIso,
    })
    .eq("id", claimId)
    .eq("organization_id", organizationId);
  if (updErr) {
    return { ok: false, status: 422, error: updErr.message };
  }

  return { ok: true, appliedPriorities };
}

/**
 * Set of claim_status values that count as "transmitted" for the
 * purposes of auto-resolving a COB queue row.
 */
export const TRANSMITTED_STATUSES = new Set([
  "submitted",
  "accepted_oa",
  "rejected_oa",
  "accepted_payer",
  "rejected_payer",
  "paid",
  "denied",
]);
