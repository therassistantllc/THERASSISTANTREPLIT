/**
 * THERASSISTANT EHR — Claim Routing Normalization Layer
 *
 * This module is the single source of truth for claim table routing.
 * It does NOT modify or delete any database tables. It provides constants
 * and helpers so application code can reference the preferred table names
 * through one import instead of hardcoding strings.
 *
 * Canonical path  → professional_claims + professional_claim_service_lines
 * Legacy path     → claims + claim_service_lines (preserved, read-only for most new code)
 */

// ─── Table name constants ─────────────────────────────────────────────────────

/** Preferred table for all new claim creation and EDI 837P workflows. */
export const CANONICAL_CLAIM_TABLE = "professional_claims" as const;

/** Preferred table for new service-line records linked to professional_claims. */
export const CANONICAL_CLAIM_SERVICE_LINES_TABLE =
  "professional_claim_service_lines" as const;

/** Legacy claims table. Preserved for backward compatibility. Do not remove. */
export const LEGACY_CLAIM_TABLE = "claims" as const;

/** Legacy service-lines table paired with the legacy claims table. */
export const LEGACY_CLAIM_SERVICE_LINES_TABLE = "claim_service_lines" as const;

// ─── Routing mode enum ────────────────────────────────────────────────────────

/**
 * CLAIM_ROUTE_MODE describes how a given piece of code or route should
 * interact with the dual claim paths.
 *
 * canonical        – Uses professional_claims only. Correct for all new code.
 * legacy_readonly  – Reads from claims only (e.g., payment_posting_allocations
 *                    FK target). Must not write new claim rows there.
 * compatibility    – Reads both tables (e.g., ERA matching that must cover
 *                    claims generated before migration). Transition state.
 * manual_review    – Unclear routing. Requires a developer to classify and
 *                    decide the correct path before the next refactor cycle.
 */
export const CLAIM_ROUTE_MODE = {
  canonical: "canonical",
  legacy_readonly: "legacy_readonly",
  compatibility: "compatibility",
  manual_review: "manual_review",
} as const;

export type ClaimRouteMode =
  (typeof CLAIM_ROUTE_MODE)[keyof typeof CLAIM_ROUTE_MODE];

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Returns true when `tableName` is one of the canonical claim tables
 * (professional_claims or professional_claim_service_lines).
 */
export function isCanonicalClaimTable(tableName: string): boolean {
  return (
    tableName === CANONICAL_CLAIM_TABLE ||
    tableName === CANONICAL_CLAIM_SERVICE_LINES_TABLE
  );
}

/**
 * Returns true when `tableName` is one of the legacy claim tables
 * (claims or claim_service_lines).
 */
export function isLegacyClaimTable(tableName: string): boolean {
  return (
    tableName === LEGACY_CLAIM_TABLE ||
    tableName === LEGACY_CLAIM_SERVICE_LINES_TABLE
  );
}

/**
 * Returns the preferred claim table for new claim creation.
 * Always "professional_claims".
 */
export function getPreferredClaimTable(): typeof CANONICAL_CLAIM_TABLE {
  return CANONICAL_CLAIM_TABLE;
}

/**
 * Returns the preferred service-line table for new claim workflows.
 * Always "professional_claim_service_lines".
 */
export function getPreferredClaimServiceLineTable(): typeof CANONICAL_CLAIM_SERVICE_LINES_TABLE {
  return CANONICAL_CLAIM_SERVICE_LINES_TABLE;
}
