import type { SupabaseClient } from "@supabase/supabase-js";
import type { FactContext, FactLoader } from "../types";

/**
 * Canonical per-claim facts.
 *
 * This is the single source of truth for "what does the system know about
 * this claim?" Both Phase 2 (Claim Content Validation, see ./rules.json)
 * and Phase 3 (real-time eligibility 270/271) consume these facts, so the
 * rule engine, the submission gate, the readiness panel, and the eligibility
 * builder all see the same payer / subscriber / provider / DOS / CPT /
 * telehealth / authorization state.
 *
 * Do not introduce parallel claim loaders — extend this file instead.
 */
export interface CanonicalClaimFacts {
  claim: {
    id: string;
    organization_id: string;
    patient_id: string | null;
    payer_profile_id: string | null;
    place_of_service: string | null;
    diagnosis_codes: string[];
    prior_authorization_number: string | null;
    appointment_id: string | null;
    encounter_id: string | null;
    claim_status: string;
  };
  serviceLines: Array<{
    id: string;
    line_number: number | null;
    service_date_from: string | null;
    procedure_code: string | null;
    charge_amount: number | null;
    units: number | null;
    diagnosis_pointers: string | null;
    place_of_service: string | null;
    rendering_provider_npi: string | null;
    authorization_number: string | null;
    modifiers: string[];
    /** True iff this line's effective POS is a telehealth code (line POS, falling back to claim header POS). */
    isTelehealth: boolean;
    /** True iff this line carries a recognized telehealth modifier. */
    hasTelehealthModifier: boolean;
  }>;
  parties: Record<string, unknown> | null;
  payerProfile: {
    id: string;
    payer_name: string | null;
    availity_payer_id: string | null;
    payer_type: string | null;
    is_active: boolean;
    requires_authorization: boolean;
    billing_rules: PayerBillingRules;
  } | null;
  derived: {
    /** True iff the claim header POS or any service line POS is a telehealth code. */
    isTelehealth: boolean;
    telehealthPosCode: string | null;
    /** Number of telehealth lines (effective POS = 02/10) that DO NOT carry a recognized telehealth modifier. */
    telehealthLinesMissingModifier: number;
    todayIso: string;
    /** Number of service lines whose DOS (date-only, UTC) is strictly after today. */
    futureDosCount: number;
  };
}

type SbClaimRow = {
  id: string;
  organization_id: string;
  patient_id: string | null;
  payer_profile_id: string | null;
  place_of_service: string | null;
  diagnosis_codes: string[] | null;
  prior_authorization_number: string | null;
  appointment_id: string | null;
  encounter_id: string | null;
  claim_status: string;
};

type SbServiceLineRow = {
  id: string;
  line_number: number | null;
  service_date_from: string | null;
  procedure_code: string | null;
  charge_amount: number | null;
  units: number | null;
  diagnosis_pointers: string | null;
  place_of_service: string | null;
  rendering_provider_npi: string | null;
  authorization_number?: string | null;
  procedure_modifier_1?: string | null;
  procedure_modifier_2?: string | null;
  procedure_modifier_3?: string | null;
  procedure_modifier_4?: string | null;
};

type SbPayerProfileRow = {
  id: string;
  payer_name: string | null;
  availity_payer_id: string | null;
  payer_type: string | null;
  is_active: boolean;
  requires_authorization?: boolean | null;
  billing_rules?: Record<string, unknown> | null;
};

/**
 * Payer-specific billing rule shape. Mirrors the jsonb column on
 * `payer_profiles.billing_rules` (see migration 20260520080000). Every field
 * is optional — an absent / null value means "rule off".
 */
export interface PayerBillingRules {
  requires_telehealth_modifier: boolean;
  allowed_pos_codes: string[];
  requires_rendering_provider_taxonomy: boolean;
  requires_subscriber_relationship: boolean;
  timely_filing_days: number | null;
  appeal_deadline_days: number | null;
  corrected_claim_days: number | null;
  allowed_cpt_codes: string[];
  denied_cpt_codes: string[];
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

export function normalizePayerBillingRules(raw: unknown): PayerBillingRules {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const positiveInt = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  return {
    requires_telehealth_modifier: obj.requires_telehealth_modifier === true,
    allowed_pos_codes: toStringArray(obj.allowed_pos_codes),
    requires_rendering_provider_taxonomy:
      obj.requires_rendering_provider_taxonomy === true,
    requires_subscriber_relationship: obj.requires_subscriber_relationship === true,
    timely_filing_days: positiveInt(obj.timely_filing_days),
    appeal_deadline_days: positiveInt(obj.appeal_deadline_days),
    corrected_claim_days: positiveInt(obj.corrected_claim_days),
    allowed_cpt_codes: toStringArray(obj.allowed_cpt_codes),
    denied_cpt_codes: toStringArray(obj.denied_cpt_codes),
  };
}

const TELEHEALTH_POS_CODES = new Set(["02", "10"]);
const TELEHEALTH_MODIFIERS = new Set(["95", "GT", "GQ", "FQ"]);

function collectModifiers(line: SbServiceLineRow): string[] {
  return [
    line.procedure_modifier_1,
    line.procedure_modifier_2,
    line.procedure_modifier_3,
    line.procedure_modifier_4,
  ]
    .filter((m): m is string => Boolean(m && m.trim().length > 0))
    .map((m) => m.trim().toUpperCase());
}

export async function loadCanonicalClaimFacts(
  supabase: SupabaseClient,
  organizationId: string,
  claimId: string,
): Promise<CanonicalClaimFacts | null> {
  const { data: claim } = await supabase
    .from("professional_claims")
    .select(
      "id, organization_id, patient_id, payer_profile_id, place_of_service, diagnosis_codes, prior_authorization_number, appointment_id, encounter_id, claim_status",
    )
    .eq("id", claimId)
    .eq("organization_id", organizationId)
    .maybeSingle<SbClaimRow>();

  if (!claim) return null;

  const [serviceLinesRes, partiesRes, payerProfileRes] = await Promise.all([
    supabase
      .from("professional_claim_service_lines")
      .select(
        "id, line_number, service_date_from, procedure_code, charge_amount, units, diagnosis_pointers, place_of_service, rendering_provider_npi, authorization_number, procedure_modifier_1, procedure_modifier_2, procedure_modifier_3, procedure_modifier_4",
      )
      .eq("claim_id", claimId)
      .order("line_number", { ascending: true }),
    supabase
      .from("claim_parties_snapshot")
      .select("*")
      .eq("claim_id", claimId)
      .maybeSingle<Record<string, unknown>>(),
    claim.payer_profile_id
      ? supabase
          .from("payer_profiles")
          .select("id, payer_name, availity_payer_id, payer_type, is_active, requires_authorization, billing_rules")
          .eq("id", claim.payer_profile_id)
          .maybeSingle<SbPayerProfileRow>()
      : Promise.resolve({ data: null }),
  ]);

  const headerPos = claim.place_of_service ?? null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayIso = today.toISOString().slice(0, 10);
  const todayUtcMs = today.getTime();

  const serviceLines = ((serviceLinesRes.data ?? []) as SbServiceLineRow[]).map((row) => {
    const modifiers = collectModifiers(row);
    const effectivePos = row.place_of_service ?? headerPos;
    const isLineTelehealth = !!(effectivePos && TELEHEALTH_POS_CODES.has(effectivePos));
    const hasModifier = modifiers.some((m) => TELEHEALTH_MODIFIERS.has(m));
    return {
      id: row.id,
      line_number: row.line_number,
      service_date_from: row.service_date_from,
      procedure_code: row.procedure_code,
      charge_amount: row.charge_amount,
      units: row.units,
      diagnosis_pointers: row.diagnosis_pointers,
      place_of_service: row.place_of_service,
      rendering_provider_npi: row.rendering_provider_npi,
      authorization_number: row.authorization_number ?? null,
      modifiers,
      isTelehealth: isLineTelehealth,
      hasTelehealthModifier: hasModifier,
    };
  });

  // Future-DOS detection: parse to a UTC date-only Date so a same-day
  // timestamp (e.g. "2026-05-20T15:00:00Z") does not lexically sort after
  // today's date-only string "2026-05-20".
  const futureDosCount = serviceLines.filter((l) => {
    if (!l.service_date_from) return false;
    const dateOnly = l.service_date_from.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return false;
    const t = Date.parse(`${dateOnly}T00:00:00Z`);
    return Number.isFinite(t) && t > todayUtcMs;
  }).length;

  const headerIsTelehealth = !!(headerPos && TELEHEALTH_POS_CODES.has(headerPos));
  const anyLineTelehealth = serviceLines.some((l) => l.isTelehealth);
  const isTelehealth = headerIsTelehealth || anyLineTelehealth;
  // Per-line compliance: every telehealth line must have its OWN modifier.
  const telehealthLinesMissingModifier = serviceLines.filter(
    (l) => l.isTelehealth && !l.hasTelehealthModifier,
  ).length;

  return {
    claim: {
      id: claim.id,
      organization_id: claim.organization_id,
      patient_id: claim.patient_id,
      payer_profile_id: claim.payer_profile_id,
      place_of_service: claim.place_of_service,
      diagnosis_codes: claim.diagnosis_codes ?? [],
      prior_authorization_number: claim.prior_authorization_number,
      appointment_id: claim.appointment_id,
      encounter_id: claim.encounter_id,
      claim_status: claim.claim_status,
    },
    serviceLines,
    parties: partiesRes.data ?? null,
    payerProfile: payerProfileRes.data
      ? {
          id: payerProfileRes.data.id,
          payer_name: payerProfileRes.data.payer_name ?? null,
          availity_payer_id: payerProfileRes.data.availity_payer_id ?? null,
          payer_type: payerProfileRes.data.payer_type ?? null,
          is_active: payerProfileRes.data.is_active,
          requires_authorization: payerProfileRes.data.requires_authorization === true,
          billing_rules: normalizePayerBillingRules(payerProfileRes.data.billing_rules),
        }
      : null,
    derived: {
      isTelehealth,
      telehealthPosCode: headerIsTelehealth ? headerPos : null,
      telehealthLinesMissingModifier,
      todayIso,
      futureDosCount,
    },
  };
}

/**
 * Project canonical claim facts into the flat shape the json-rules-engine
 * consumes. Each top-level key becomes a fact name. Field paths used by
 * `rules.json` reference these keys via `$.foo.bar`.
 */
function projectFactsForEngine(facts: CanonicalClaimFacts) {
  const partyStr = (key: string): string => {
    if (!facts.parties) return "";
    const v = facts.parties[key];
    return typeof v === "string" ? v.trim() : "";
  };
  const partyBool = (key: string, fallback = false): boolean => {
    if (!facts.parties) return fallback;
    const v = facts.parties[key];
    return typeof v === "boolean" ? v : fallback;
  };

  // Service facility is satisfied if (a) the snapshot says it is the same as
  // the billing provider — a valid in-clinic case — or (b) explicit facility
  // identity fields are present.
  const facilitySameAsBilling = partyBool("service_facility_same_as_billing", false);
  const hasServiceFacility =
    facilitySameAsBilling ||
    partyStr("service_facility_name").length > 0 ||
    partyStr("service_facility_address1").length > 0;

  // Prior auth may be carried at claim header OR at any service line.
  const claimHeaderAuth = !!(
    facts.claim.prior_authorization_number && facts.claim.prior_authorization_number.trim()
  );
  const anyLineAuth = facts.serviceLines.some(
    (l) => !!(l.authorization_number && l.authorization_number.trim()),
  );
  const claimHasAuth = claimHeaderAuth || anyLineAuth;

  // ── Payer-specific billing rules ───────────────────────────────────────────
  // Only evaluate payer rules when an ACTIVE payer profile is attached. An
  // inactive / missing payer is already flagged by `claim.missing_payer`;
  // emitting additional payer-rule blockers on top would be misleading
  // double-counting.
  const hasActivePayer = facts.payerProfile?.is_active === true;
  const billingRules: PayerBillingRules = hasActivePayer
    ? facts.payerProfile?.billing_rules ?? normalizePayerBillingRules(null)
    : normalizePayerBillingRules(null);

  // Effective POS for each line = line POS || header POS.
  const effectivePosCodes = facts.serviceLines
    .map((l) => (l.place_of_service ?? facts.claim.place_of_service ?? "").trim().toUpperCase())
    .filter((p) => p.length > 0);
  const headerPosUpper = (facts.claim.place_of_service ?? "").trim().toUpperCase();
  const allPosOnClaim = new Set<string>(effectivePosCodes);
  if (headerPosUpper) allPosOnClaim.add(headerPosUpper);

  // POS allow-list: if list non-empty, every POS on the claim must be in it.
  const allowedPos = new Set(billingRules.allowed_pos_codes);
  const disallowedPos = allowedPos.size === 0
    ? []
    : Array.from(allPosOnClaim).filter((p) => !allowedPos.has(p));

  // CPT allow / deny.
  const cptCodes = facts.serviceLines
    .map((l) => (l.procedure_code ?? "").trim().toUpperCase())
    .filter((c) => c.length > 0);
  const denied = new Set(billingRules.denied_cpt_codes);
  const allowed = new Set(billingRules.allowed_cpt_codes);
  const deniedCptHits = cptCodes.filter((c) => denied.has(c));
  const disallowedCptHits = allowed.size === 0
    ? []
    : cptCodes.filter((c) => !allowed.has(c));

  // Timely filing: oldest line DOS must be within N days of today.
  let timelyFilingExceededDays = 0;
  let timelyFilingOldestDos: string | null = null;
  if (billingRules.timely_filing_days != null && facts.serviceLines.length > 0) {
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    const projTodayUtcMs = todayUtc.getTime();
    const dosDays = facts.serviceLines
      .map((l) => l.service_date_from?.slice(0, 10))
      .filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (dosDays.length > 0) {
      const oldest = dosDays.sort()[0];
      const oldestMs = Date.parse(`${oldest}T00:00:00Z`);
      if (Number.isFinite(oldestMs)) {
        const ageDays = Math.floor((projTodayUtcMs - oldestMs) / (1000 * 60 * 60 * 24));
        if (ageDays > billingRules.timely_filing_days) {
          timelyFilingExceededDays = ageDays;
          timelyFilingOldestDos = oldest;
        }
      }
    }
  }

  // Subscriber relationship: when payer requires it, the snapshot must define
  // who the client is relative to the subscriber. We treat the rule as
  // satisfied when either patient_is_subscriber === true OR the client
  // identity fields (last_name + dob) are populated so the relationship is
  // unambiguous downstream.
  const partiesObj = facts.parties ?? {};
  const patientIsSubscriber = partiesObj["patient_is_subscriber"] === true;
  const patientLastName = typeof partiesObj["patient_last_name"] === "string"
    ? (partiesObj["patient_last_name"] as string).trim()
    : "";
  const patientDob = typeof partiesObj["patient_dob"] === "string"
    ? (partiesObj["patient_dob"] as string).trim()
    : "";
  const subscriberRelationshipKnown =
    patientIsSubscriber || (patientLastName.length > 0 && patientDob.length > 0);

  // Rendering provider taxonomy: snapshot field added in 20260514000000.
  const renderingTaxonomy =
    typeof partiesObj["rendering_provider_taxonomy"] === "string"
      ? (partiesObj["rendering_provider_taxonomy"] as string).trim()
      : "";

  // Note: telehealth modifier enforcement is intentionally handled by the
  // universal `claim.telehealth_missing_modifier` rule (category
  // claimTelehealth), which always fires whenever POS is 02/10 and the
  // line lacks a recognized modifier — this is a fundamental 837P/payer
  // requirement, not payer-specific. The `requires_telehealth_modifier`
  // flag on `billing_rules` is therefore informational only (used as
  // payer-setup documentation) and does NOT generate a separate finding,
  // to avoid double-blocking on the same condition.

  return {
    claim: {
      hasPayerProfile: facts.claim.payer_profile_id != null && facts.payerProfile?.is_active === true,
      hasPlaceOfService: !!(facts.claim.place_of_service && facts.claim.place_of_service.trim()),
      diagnosisCount: facts.claim.diagnosis_codes.length,
      hasPriorAuth: claimHasAuth,
    },
    serviceLines: {
      count: facts.serviceLines.length,
      missingProcedureCount: facts.serviceLines.filter((l) => !l.procedure_code || !l.procedure_code.trim()).length,
      missingPosCount: facts.serviceLines.filter((l) => !l.place_of_service || !l.place_of_service.trim()).length,
    },
    claimDates: {
      futureDosCount: facts.derived.futureDosCount,
    },
    parties: {
      hasRenderingProviderNpi: partyStr("rendering_provider_npi").length === 10,
      hasSubscriberMemberId:
        partyStr("subscriber_member_id").length > 0 || partyStr("subscriber_id").length > 0,
      hasPayerName: partyStr("payer_name").length > 0,
      hasServiceFacility,
      snapshotPresent: facts.parties != null,
    },
    telehealth: {
      isTelehealth: facts.derived.isTelehealth,
      linesMissingModifier: facts.derived.telehealthLinesMissingModifier,
      requiresModifier: facts.derived.telehealthLinesMissingModifier > 0,
    },
    authorization: {
      payerRequiresAuth: facts.payerProfile?.requires_authorization === true,
      claimHasAuth,
      missing: facts.payerProfile?.requires_authorization === true && !claimHasAuth,
    },
    payerRules: {
      hasPayer: hasActivePayer,
      // POS allow-list violation
      disallowedPosCount: disallowedPos.length,
      disallowedPosCodes: disallowedPos.join(", "),
      // CPT lists
      deniedCptCount: deniedCptHits.length,
      deniedCptCodes: deniedCptHits.join(", "),
      disallowedCptCount: disallowedCptHits.length,
      disallowedCptCodes: disallowedCptHits.join(", "),
      // Timely filing
      timelyFilingDays: billingRules.timely_filing_days,
      timelyFilingExceeded: timelyFilingExceededDays > 0,
      timelyFilingAgeDays: timelyFilingExceededDays,
      timelyFilingOldestDos: timelyFilingOldestDos,
      // Subscriber relationship
      requiresSubscriberRelationship: billingRules.requires_subscriber_relationship,
      subscriberRelationshipKnown,
      subscriberRelationshipMissing:
        billingRules.requires_subscriber_relationship && !subscriberRelationshipKnown,
      // Rendering provider taxonomy
      requiresRenderingTaxonomy: billingRules.requires_rendering_provider_taxonomy,
      hasRenderingTaxonomy: renderingTaxonomy.length > 0,
      renderingTaxonomyMissing:
        billingRules.requires_rendering_provider_taxonomy && renderingTaxonomy.length === 0,
    },
  };
}

/** Fact loaders for the claim-content engine pass.
 *  Loader names match the top-level `fact` references in rules.json. */
export function buildClaimContentLoaders(facts: CanonicalClaimFacts): FactLoader[] {
  const projection = projectFactsForEngine(facts);
  const make = (name: keyof typeof projection): FactLoader => ({
    name,
    load: async (_ctx: FactContext) => projection[name] as Record<string, unknown>,
  });
  return [
    make("claim"),
    make("serviceLines"),
    make("claimDates"),
    make("parties"),
    make("telehealth"),
    make("authorization"),
    make("payerRules"),
  ];
}
