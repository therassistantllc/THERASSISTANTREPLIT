// CAQH CORE Single Patient Attribution Rule vEB.1.0 §4.2–§4.3 —
// routing layer.
//
// When a 271 is attributed to a dependent (not the subscriber the user
// requested the check for), we try to route persistence to the matching
// dependent patient record so benefits aren't cross-attributed. If no
// unique match exists in the org, we keep persistence on the requested
// patient and record an "unresolved" routing state so the UI can flag it.

import type { AttributionDecision } from "@/lib/edi/availity270/attribution";

type AttributionRoutingUnresolvedReason =
  | "no_dependent_match"
  | "ambiguous_dependent_match"
  | "missing_dependent_identity";

export interface AttributionRoutingDecision {
  /** Patient row id the eligibility_check should be stored against. */
  routedClientId: string;
  /** True when routedClientId === requested patient id (no rerouting). */
  routedToRequestedPatient: boolean;
  /** True when target was dependent but we could not safely route. */
  unresolved: boolean;
  unresolvedReason: AttributionRoutingUnresolvedReason | null;
  /** Candidate ids returned by the lookup, for diagnostics. */
  candidateIds: string[];
}

interface DependentLookupInput {
  organizationId: string;
  firstName: string | null;
  lastName: string | null;
  dob: string | null;
}

export type DependentLookupFn = (input: DependentLookupInput) => Promise<string[]>;

/**
 * Decide which client_id eligibility persistence should be attached to.
 *
 * Routing rules:
 *  - If attribution.target is "subscriber" → always store against the
 *    requested patient (the subscriber's own chart).
 *  - If attribution.target is "dependent" and the decision matches the
 *    requested patient → the requested patient IS the dependent. Store
 *    against the requested patient.
 *  - If attribution.target is "dependent" and decision does NOT match,
 *    look up the dependent by org + name + dob. Exactly one match →
 *    reroute. Zero or multiple matches → keep on requested patient and
 *    mark unresolved so the UI surfaces a warning.
 */
export async function resolveAttributionRouting(args: {
  requestedClientId: string;
  organizationId: string;
  decision: AttributionDecision | null;
  parsedDependent: { firstName: string | null; lastName: string | null; dob: string | null } | null;
  lookup: DependentLookupFn;
}): Promise<AttributionRoutingDecision> {
  const { requestedClientId, organizationId, decision, parsedDependent, lookup } = args;

  // No decision yet (no attribution data) → no routing change.
  if (!decision) {
    return {
      routedClientId: requestedClientId,
      routedToRequestedPatient: true,
      unresolved: false,
      unresolvedReason: null,
      candidateIds: [],
    };
  }

  if (decision.target !== "dependent") {
    return {
      routedClientId: requestedClientId,
      routedToRequestedPatient: true,
      unresolved: false,
      unresolvedReason: null,
      candidateIds: [],
    };
  }

  // Dependent-target with identity that matches the requested patient
  // (the user already opened the dependent's chart) — no rerouting.
  if (decision.matchesRequestedPatient) {
    return {
      routedClientId: requestedClientId,
      routedToRequestedPatient: true,
      unresolved: false,
      unresolvedReason: null,
      candidateIds: [],
    };
  }

  // Dependent target, identity does NOT match → try to find dependent's
  // own chart in this org.
  if (!parsedDependent || (!parsedDependent.lastName && !parsedDependent.dob)) {
    return {
      routedClientId: requestedClientId,
      routedToRequestedPatient: true,
      unresolved: true,
      unresolvedReason: "missing_dependent_identity",
      candidateIds: [],
    };
  }

  const candidates = await lookup({
    organizationId,
    firstName: parsedDependent.firstName,
    lastName: parsedDependent.lastName,
    dob: parsedDependent.dob,
  });

  if (candidates.length === 1) {
    return {
      routedClientId: candidates[0],
      routedToRequestedPatient: candidates[0] === requestedClientId,
      unresolved: false,
      unresolvedReason: null,
      candidateIds: candidates,
    };
  }

  return {
    routedClientId: requestedClientId,
    routedToRequestedPatient: true,
    unresolved: true,
    unresolvedReason: candidates.length === 0 ? "no_dependent_match" : "ambiguous_dependent_match",
    candidateIds: candidates,
  };
}
