/**
 * THERASSISTANT EHR — Claim Detail Routing Utilities
 *
 * Claim detail navigation is split across two paths that mirror the
 * underlying database tables:
 *
 *   Canonical path  → /billing/claims/[id]  backed by professional_claims
 *   Legacy path     → /claims/[id]          backed by claims
 *
 * The canonical detail page at /billing/claims/[id] does not yet exist as
 * a Next.js page file. Until it does, canonical links fall back to the
 * /billing/claim-readiness workspace (which already reads professional_claims).
 * When the per-claim detail page is implemented, only these helpers need to
 * change — call sites stay the same.
 *
 * Use these helpers everywhere a claim detail link, href, or table lookup is
 * needed so the routing strategy is controlled from one place.
 */

// ─── Route constants ──────────────────────────────────────────────────────────

/** Canonical claim workspace (implemented). Links here when no per-claim ID available. */
export const CANONICAL_CLAIM_WORKSPACE_ROUTE = "/billing/claim-readiness" as const;

/**
 * Canonical per-claim detail route pattern (declared in RBAC protected-routes,
 * page not yet implemented). When the page is built, canonical links will deep-
 * link here instead of the workspace.
 */
export const CANONICAL_CLAIM_DETAIL_ROUTE_PATTERN = "/billing/claims" as const;

/**
 * Legacy per-claim detail route pattern (declared in RBAC protected-routes,
 * page not yet implemented). Treat as a compatibility route.
 */
export const LEGACY_CLAIM_DETAIL_ROUTE_PATTERN = "/claims" as const;

// ─── Shared types ─────────────────────────────────────────────────────────────

/**
 * Minimal claim reference shape. Covers both DB rows (snake_case) and frontend
 * DTO objects (camelCase). All fields are optional — supply what you have.
 */
export interface ClaimDetailRef {
  /** ID from the `professional_claims` table — canonical. */
  professionalClaimId?: string | null;
  /** ID from the `claims` table — legacy, backward-compat only. */
  legacyClaimId?: string | null;
  /** Organization ID to append as a query param. */
  organizationId?: string | null;
}

/** Which Supabase table backs the claim detail being resolved. */
export type ClaimDetailTable = "professional_claims" | "claims";

/** Result of resolving the best available claim detail reference. */
export interface ClaimDetailTarget {
  /** Table to query for the claim row. Null when no ID is present. */
  table: ClaimDetailTable | null;
  /** Claim ID to query. Null when no ID is present. */
  claimId: string | null;
  /** True when resolution used `professional_claims`. */
  isCanonical: boolean;
}

// ─── Resolution helpers ───────────────────────────────────────────────────────

/**
 * Resolves which table and ID to use when loading the detail view for a claim.
 *
 * Lookup order:
 *   1. `professionalClaimId` → professional_claims  (canonical)
 *   2. `legacyClaimId`       → claims               (legacy fallback)
 *   3. null                  → no claim reference available
 *
 * ```ts
 * const { table, claimId } = resolveClaimDetailTarget({ professionalClaimId: claim.id });
 * if (table && claimId) {
 *   const { data } = await supabase.from(table).select("*").eq("id", claimId).single();
 * }
 * ```
 */
export function resolveClaimDetailTarget(ref: ClaimDetailRef): ClaimDetailTarget {
  if (ref.professionalClaimId) {
    return {
      table: "professional_claims",
      claimId: ref.professionalClaimId,
      isCanonical: true,
    };
  }
  if (ref.legacyClaimId) {
    return {
      table: "claims",
      claimId: ref.legacyClaimId,
      isCanonical: false,
    };
  }
  return { table: null, claimId: null, isCanonical: false };
}

/**
 * Returns true when the ref points to the canonical `professional_claims` table.
 *
 * Use this to gate canonical-only actions (e.g., re-submit 837P, apply ERA
 * adjustment) that require a `professional_claims` row.
 */
export function isCanonicalClaimDetail(ref: ClaimDetailRef): boolean {
  return Boolean(ref.professionalClaimId);
}

// ─── Navigation / href helpers ────────────────────────────────────────────────

function appendOrgId(base: string, organizationId?: string | null): string {
  if (!organizationId) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}organizationId=${encodeURIComponent(organizationId)}`;
}

/**
 * Returns the canonical claim detail href for a given `professional_claims` ID.
 *
 * - When `claimId` is provided: returns `/billing/claims/${claimId}`.
 *   (This route is declared in protected-routes but the page is not yet
 *   implemented. Once the page exists this will deep-link directly.)
 * - When `claimId` is absent: falls back to `/billing/claim-readiness`
 *   (the canonical claim workspace, which is fully implemented).
 *
 * ```ts
 * const href = getCanonicalClaimDetailRoute(claim.id, orgId);
 * // "/billing/claims/abc-123?organizationId=org-456"
 * ```
 */
export function getCanonicalClaimDetailRoute(
  claimId?: string | null,
  organizationId?: string | null,
): string {
  const base = claimId
    ? `${CANONICAL_CLAIM_DETAIL_ROUTE_PATTERN}/${claimId}`
    : CANONICAL_CLAIM_WORKSPACE_ROUTE;
  return appendOrgId(base, organizationId);
}

/**
 * Returns the legacy claim detail href for a given `claims` ID.
 *
 * - When `claimId` is provided: returns `/claims/${claimId}`.
 *   (Declared in protected-routes; treat as compatibility page.)
 * - When `claimId` is absent: returns `/claims`.
 *
 * Do not use this for new canonical claim links. Prefer
 * `getCanonicalClaimDetailRoute` or `buildClaimDetailHref`.
 *
 * ```ts
 * const href = getLegacyClaimDetailRoute(claim.id, orgId);
 * // "/claims/old-abc-123?organizationId=org-456"
 * ```
 */
export function getLegacyClaimDetailRoute(
  claimId?: string | null,
  organizationId?: string | null,
): string {
  const base = claimId
    ? `${LEGACY_CLAIM_DETAIL_ROUTE_PATTERN}/${claimId}`
    : LEGACY_CLAIM_DETAIL_ROUTE_PATTERN;
  return appendOrgId(base, organizationId);
}

/**
 * Builds the best available claim detail href given a `ClaimDetailRef`.
 *
 * - Has `professionalClaimId` → canonical route: `/billing/claims/[id]`
 * - Has only `legacyClaimId`  → legacy route:    `/claims/[id]`
 * - Has neither               → canonical workspace fallback: `/billing/claim-readiness`
 *
 * This is the **primary helper for UI components**. Use it instead of
 * hardcoding `/billing/claim-readiness` or `/claims/[id]` directly.
 *
 * ```tsx
 * <Link href={buildClaimDetailHref({ professionalClaimId: claim.id, organizationId })}>
 *   View Claim
 * </Link>
 * ```
 */
export function buildClaimDetailHref(ref: ClaimDetailRef): string {
  if (ref.professionalClaimId) {
    return getCanonicalClaimDetailRoute(ref.professionalClaimId, ref.organizationId);
  }
  if (ref.legacyClaimId) {
    return getLegacyClaimDetailRoute(ref.legacyClaimId, ref.organizationId);
  }
  // No claim ID available — fall back to canonical workspace
  return appendOrgId(CANONICAL_CLAIM_WORKSPACE_ROUTE, ref.organizationId);
}
