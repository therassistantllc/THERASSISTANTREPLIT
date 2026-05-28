// File: lib/clearinghouse/buildEligibility270InputFromContext.ts
//
// Builds the rich `Eligibility270Input` (the shape consumed by
// `lib/edi/availity270/generate270.ts` and by
// `AvailityRealtimeAdapter.runEligibility`) from the database rows the
// `ClearinghouseService` already has on hand: the client (`clients`
// row), their `insurance_policies` row, and the active
// `clearinghouse_connections` row.
//
// The DB schema captured before Phase 2 only stores a small subset of
// the X12 270 envelope (`submitter_id`, `receiver_id`, `mode`) on
// `clearinghouse_connections`. The remaining envelope constants
// (sender/receiver qualifiers, GS receiver code, X12 version, Availity
// receiver id/name) are mandated by the Availity Companion Guide
// v.20260429 and so are filled from documented constants — not invented
// per-deployment. Submitter contact phone/email come from columns added
// in `20260521001100_clearinghouse_submitter_contact.sql`.
//
// Information receiver (Loop 2100B) NPI/name come from env overrides
// when set (`AVAILITY_DEFAULT_PROVIDER_NPI`,
// `AVAILITY_DEFAULT_PROVIDER_LAST_NAME`,
// `AVAILITY_DEFAULT_PROVIDER_FIRST_NAME`); otherwise the function
// returns the input as-is and lets `validate270` flag the missing NPI
// at emission time so the failure is loud and traceable.

import type {
  Availity270Connection,
  Eligibility270Input,
} from "@/lib/edi/availity270/types";

export interface BuilderClient {
  first_name?: string | null;
  last_name?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
}

export interface BuilderPolicy {
  payer_id?: string | null;
  plan_name?: string | null;
  subscriber_id?: string | null;
  policy_number?: string | null;
  /**
   * Payer-issued Group #. When present, the 270 generator emits a
   * Loop 2100C `REF*1L*<group>~` (Group or Policy Number) so the
   * payer can disambiguate the member's plan.
   */
  group_number?: string | null;
  /**
   * If the subscriber differs from the client, the caller is
   * responsible for passing the subscriber identity here. When omitted,
   * we assume self-coverage and project the client identity into the
   * subscriber loop — by far the dominant case for psych practices.
   */
  subscriber_first_name?: string | null;
  subscriber_last_name?: string | null;
  subscriber_dob?: string | null;
  subscriber_gender?: string | null;
}

export interface BuilderConnectionLike {
  id?: string;
  organization_id: string;
  mode?: "test" | "live" | string | null;
  submitter_id?: string | null;
  submitter_name?: string | null;
  submitter_contact_phone?: string | null;
  submitter_contact_email?: string | null;
}

export interface BuilderProvider {
  npi?: string | null;
  lastNameOrOrg?: string | null;
  firstName?: string | null;
}

const AVAILITY_RECEIVER_ID = "030240928";
const AVAILITY_RECEIVER_NAME = "Availity";

function normalizeGender(value: string | null | undefined): "M" | "F" | "U" | null {
  if (!value) return null;
  const v = String(value).trim().toUpperCase();
  if (v === "M" || v === "MALE") return "M";
  if (v === "F" || v === "FEMALE") return "F";
  if (v === "U" || v === "UNKNOWN") return "U";
  return null;
}

/**
 * Maps a free-form DB `mode` value (`"test"` / `"live"` / `"production"`)
 * to the Availity270 mode (`"test"` / `"production"`). Defaults to
 * `"test"` whenever the value is missing or unrecognized — fail-safe
 * so a misconfigured connection cannot accidentally hit production.
 */
function resolveAvailityMode(mode: string | null | undefined): "test" | "production" {
  const v = String(mode ?? "").trim().toLowerCase();
  if (v === "live" || v === "production" || v === "prod") return "production";
  return "test";
}

export function buildEligibility270InputFromContext(args: {
  connection: BuilderConnectionLike;
  client: BuilderClient;
  policy: BuilderPolicy;
  /** Optional explicit provider override (e.g. from Settings UI). */
  provider?: BuilderProvider;
  serviceTypeCodes: string[];
  serviceDate?: string | null;
  traceId?: string;
}): Eligibility270Input {
  const { connection, client, policy, provider, serviceTypeCodes, serviceDate, traceId } = args;

  const mode = resolveAvailityMode(connection.mode ?? null);

  const submitterId =
    connection.submitter_id?.trim() ||
    process.env.AVAILITY_DEFAULT_SUBMITTER_ID ||
    "";
  const submitterName =
    connection.submitter_name?.trim() ||
    process.env.AVAILITY_DEFAULT_SUBMITTER_NAME ||
    "Therassistant EHR";

  const availityConnection: Availity270Connection = {
    id: connection.id,
    organization_id: connection.organization_id,
    clearinghouse_name: "Availity",
    mode,
    submitter_id: submitterId,
    submitter_name: submitterName,
    sender_qualifier: "ZZ",
    receiver_qualifier: "ZZ",
    receiver_id: AVAILITY_RECEIVER_ID,
    receiver_name: AVAILITY_RECEIVER_NAME,
    gs_receiver_code: AVAILITY_RECEIVER_ID,
    x12_version: "005010X279A1",
    isa_usage_indicator: mode === "production" ? "P" : "T",
    submitter_contact_phone: connection.submitter_contact_phone ?? null,
    submitter_contact_email: connection.submitter_contact_email ?? null,
  };

  const providerNpi =
    provider?.npi?.trim() ||
    process.env.AVAILITY_DEFAULT_PROVIDER_NPI ||
    "";
  const providerLast =
    provider?.lastNameOrOrg?.trim() ||
    process.env.AVAILITY_DEFAULT_PROVIDER_LAST_NAME ||
    submitterName;
  const providerFirst =
    provider?.firstName?.trim() ||
    process.env.AVAILITY_DEFAULT_PROVIDER_FIRST_NAME ||
    null;

  const memberId =
    (policy.subscriber_id?.trim() || policy.policy_number?.trim() || "").trim();

  const subscriberLast =
    policy.subscriber_last_name?.trim() || client.last_name?.trim() || "";
  const subscriberFirst =
    policy.subscriber_first_name?.trim() || client.first_name?.trim() || "";
  const subscriberDob =
    policy.subscriber_dob?.trim() || client.date_of_birth?.trim() || "";
  const subscriberGender =
    normalizeGender(policy.subscriber_gender ?? null) ?? normalizeGender(client.gender ?? null);

  return {
    connection: availityConnection,
    submitterName,
    informationSource: {
      payerName: policy.plan_name?.trim() || "Payer",
      payerId: (policy.payer_id ?? "").trim(),
    },
    informationReceiver: {
      entityType: providerFirst ? "1" : "2",
      lastNameOrOrg: providerLast,
      firstName: providerFirst,
      npi: providerNpi,
    },
    subscriber: {
      lastName: subscriberLast,
      firstName: subscriberFirst,
      memberId,
      dob: subscriberDob,
      gender: subscriberGender,
      groupNumber: policy.group_number?.trim() || null,
    },
    serviceTypeCodes: serviceTypeCodes.length ? serviceTypeCodes : ["98"],
    serviceDate: serviceDate ?? null,
    traceId,
  };
}
