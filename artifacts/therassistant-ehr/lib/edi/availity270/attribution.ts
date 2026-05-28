// CAQH CORE Single Client Attribution Data Content Rule vEB.1.0
// §4.2–§4.3.
//
// A 271 may carry benefit content for the subscriber (Loop 2100C) OR
// for a dependent (Loop 2100D / NM1*03) beneath the same subscriber.
// The receiving system MUST route that content to the matching client
// chart — never cross-attribute. This helper compares the 271's
// attribution rollup against the client identity the inquirer expected
// the response for.

import type { Parsed271Attribution, Parsed271Dependent, Parsed271Subscriber } from "./types";

export interface RequestedPatientIdentity {
  firstName: string | null;
  lastName: string | null;
  dob: string | null; // YYYY-MM-DD
  memberId?: string | null;
}

type AttributionMismatchReason =
  | "name_mismatch"
  | "dob_mismatch"
  | "member_id_mismatch"
  | "missing_response_identity";

export interface AttributionDecision {
  /** Which 271 loop the benefit content belongs to. */
  target: "subscriber" | "dependent";
  /** Display name of the attributed party (for UI banners). */
  attributedName: string | null;
  /** True when the response identity matches the requested client. */
  matchesRequestedClient: boolean;
  /** Populated when matchesRequestedClient = false. */
  mismatchReasons: AttributionMismatchReason[];
}

function joinName(first: string | null, last: string | null): string | null {
  const parts = [first, last].filter((s): s is string => !!s && s.trim().length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeDob(value: string | null | undefined): string {
  if (!value) return "";
  // Accept YYYY-MM-DD or YYYYMMDD; compare normalized to YYYY-MM-DD.
  const trimmed = value.trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(trimmed);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : trimmed;
}

function compareIdentity(
  responseFirst: string | null,
  responseLast: string | null,
  responseDob: string | null,
  responseMemberId: string | null,
  expected: RequestedPatientIdentity,
): AttributionMismatchReason[] {
  const reasons: AttributionMismatchReason[] = [];

  const hasAnyResponseIdentity = Boolean(responseFirst || responseLast || responseDob);
  if (!hasAnyResponseIdentity) {
    reasons.push("missing_response_identity");
    return reasons;
  }

  const expFirst = normalizeName(expected.firstName);
  const expLast = normalizeName(expected.lastName);
  const respFirst = normalizeName(responseFirst);
  const respLast = normalizeName(responseLast);

  // Last name is the strongest signal payers consistently echo back.
  if (expLast && respLast && expLast !== respLast) {
    reasons.push("name_mismatch");
  } else if (expFirst && respFirst && expFirst !== respFirst) {
    reasons.push("name_mismatch");
  }

  if (expected.dob && responseDob) {
    if (normalizeDob(expected.dob) !== normalizeDob(responseDob)) {
      reasons.push("dob_mismatch");
    }
  }

  if (expected.memberId && responseMemberId) {
    if (expected.memberId.trim() !== responseMemberId.trim()) {
      reasons.push("member_id_mismatch");
    }
  }

  return reasons;
}

/**
 * Resolve which 271 loop the response belongs to and confirm that
 * loop's identity matches the client the EHR asked about.
 */
export function attributeResponseToClient(
  attribution: Parsed271Attribution | undefined,
  expected: RequestedPatientIdentity,
): AttributionDecision {
  if (!attribution) {
    return {
      target: "subscriber",
      attributedName: null,
      matchesRequestedClient: false,
      mismatchReasons: ["missing_response_identity"],
    };
  }

  const target = attribution.target;
  const sub: Parsed271Subscriber = attribution.subscriber;
  const dep: Parsed271Dependent | null = attribution.dependent;

  if (target === "dependent" && dep) {
    return {
      target: "dependent",
      attributedName: joinName(dep.firstName, dep.lastName),
      matchesRequestedClient: compareIdentity(
        dep.firstName,
        dep.lastName,
        dep.dob,
        null, // dependents don't echo subscriber member id
        expected,
      ).length === 0,
      mismatchReasons: compareIdentity(dep.firstName, dep.lastName, dep.dob, null, expected),
    };
  }

  const reasons = compareIdentity(
    sub.firstName,
    sub.lastName,
    sub.dob,
    sub.memberId,
    expected,
  );
  return {
    target: "subscriber",
    attributedName: joinName(sub.firstName, sub.lastName),
    matchesRequestedClient: reasons.length === 0,
    mismatchReasons: reasons,
  };
}
