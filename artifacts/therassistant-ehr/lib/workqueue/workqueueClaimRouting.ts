/**
 * THERASSISTANT EHR — Workqueue Claim Routing Utilities
 *
 * workqueue_items carries two claim reference columns:
 *
 *   professional_claim_id  (FK → professional_claims)   ← CANONICAL, preferred
 *   claim_id               (FK → claims)                ← LEGACY, backward-compat only
 *
 * All NEW workqueue inserts must populate `professional_claim_id`.
 * `claim_id` is preserved for existing rows and for items routed through
 * legacy payment/VCC/document FK chains that still point to `claims`.
 *
 * Use these helpers everywhere UI, API routes, and services resolve
 * which claim a workqueue item refers to — do NOT read raw DB column
 * names spread throughout call sites.
 */

// ─── Shared types ─────────────────────────────────────────────────────────────

/**
 * Minimal shape covering both claim-reference columns on workqueue_items.
 * Works with DB rows, DTO objects, and camelCase frontend types.
 */
export interface WorkqueueClaimRef {
  /** Canonical reference → professional_claims (preferred). */
  professional_claim_id?: string | null;
  /** Legacy reference → claims (backward-compat only). */
  claim_id?: string | null;
}

/**
 * camelCase variant used by frontend DTO objects returned from
 * /api/workqueue/items and /api/clients/[clientId]/workqueue.
 */
export interface WorkqueueClaimRefCamel {
  /** Canonical reference → professional_claims (preferred). */
  professionalClaimId?: string | null;
  /** Legacy reference → claims (backward-compat only). */
  claimId?: string | null;
}

/** Which Supabase table to query when resolving a workqueue claim. */
export type WorkqueueClaimTable = "professional_claims" | "claims";

/** Result of resolving the canonical claim target for a workqueue item. */
export interface WorkqueueClaimTarget {
  /** The resolved table name, or null if no claim is linked. */
  table: WorkqueueClaimTable | null;
  /** The resolved claim ID, or null if no claim is linked. */
  claimId: string | null;
  /** Whether the target was resolved via the canonical column. */
  isCanonical: boolean;
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the best available claim ID for a workqueue item.
 *
 * Resolution order:
 *   1. `professional_claim_id`  (canonical)
 *   2. `claim_id`               (legacy fallback)
 *   3. null                     (no claim linked)
 *
 * Use this when you only need the ID string and not the table name
 * (e.g., logging, display, context payloads).
 */
export function getCanonicalClaimReference(
  item: WorkqueueClaimRef | WorkqueueClaimRefCamel,
): string | null {
  // Handle both snake_case DB rows and camelCase DTO objects
  const canonical =
    (item as WorkqueueClaimRef).professional_claim_id ??
    (item as WorkqueueClaimRefCamel).professionalClaimId ??
    null;

  if (canonical) return canonical;

  const legacy =
    (item as WorkqueueClaimRef).claim_id ??
    (item as WorkqueueClaimRefCamel).claimId ??
    null;

  return legacy ?? null;
}

/**
 * Returns the table name AND claim ID to use when querying claim detail
 * for a given workqueue item.
 *
 * Always prefer `professional_claims` when `professional_claim_id` is set.
 * Fall back to `claims` only when `claim_id` is set and
 * `professional_claim_id` is absent.
 *
 * ```ts
 * const { table, claimId } = resolveWorkqueueClaimTarget(item);
 * if (table && claimId) {
 *   const claim = await supabase.from(table).select("*").eq("id", claimId).single();
 * }
 * ```
 */
export function resolveWorkqueueClaimTarget(
  item: WorkqueueClaimRef | WorkqueueClaimRefCamel,
): WorkqueueClaimTarget {
  const professionalClaimId =
    (item as WorkqueueClaimRef).professional_claim_id ??
    (item as WorkqueueClaimRefCamel).professionalClaimId ??
    null;

  if (professionalClaimId) {
    return {
      table: "professional_claims",
      claimId: professionalClaimId,
      isCanonical: true,
    };
  }

  const legacyClaimId =
    (item as WorkqueueClaimRef).claim_id ??
    (item as WorkqueueClaimRefCamel).claimId ??
    null;

  if (legacyClaimId) {
    return {
      table: "claims",
      claimId: legacyClaimId,
      isCanonical: false,
    };
  }

  return { table: null, claimId: null, isCanonical: false };
}

/**
 * Returns true when the workqueue item has a canonical
 * `professional_claim_id` reference.
 *
 * Use this as a guard before rendering canonical claim detail links
 * or calling services that expect professional_claims rows.
 */
export function hasProfessionalClaimReference(
  item: WorkqueueClaimRef | WorkqueueClaimRefCamel,
): boolean {
  return Boolean(
    (item as WorkqueueClaimRef).professional_claim_id ??
    (item as WorkqueueClaimRefCamel).professionalClaimId,
  );
}

/**
 * Returns true when the workqueue item has a `claim_id` reference to the
 * legacy `claims` table but NO `professional_claim_id` reference.
 *
 * Use this to identify workqueue items that are still on the legacy path
 * and may need migration or compatibility handling.
 */
export function hasLegacyClaimReference(
  item: WorkqueueClaimRef | WorkqueueClaimRefCamel,
): boolean {
  const hasProfessional = hasProfessionalClaimReference(item);
  const hasLegacy = Boolean(
    (item as WorkqueueClaimRef).claim_id ??
    (item as WorkqueueClaimRefCamel).claimId,
  );
  return hasLegacy && !hasProfessional;
}

// ─── Insert helpers ───────────────────────────────────────────────────────────

/**
 * Returns the correct claim columns to include when inserting a new
 * workqueue item linked to a `professional_claims` row.
 *
 * Always populates `professional_claim_id`. Sets `claim_id` to null
 * explicitly so it does not accidentally pick up a stale value.
 *
 * ```ts
 * const claimCols = canonicalClaimColumns(claim.id);
 * await supabase.from("workqueue_items").insert({ ...rest, ...claimCols });
 * ```
 */
export function canonicalClaimColumns(professionalClaimId: string): {
  professional_claim_id: string;
  claim_id: null;
} {
  return { professional_claim_id: professionalClaimId, claim_id: null };
}

/**
 * Returns the legacy claim columns for workqueue items that are still
 * sourced from the `claims` table (VCC payments, payment_import_items,
 * legacy denial/no-response syncs).
 *
 * Sets `professional_claim_id` to null explicitly.
 * Migrate to `canonicalClaimColumns` once the source table migrates.
 *
 * ```ts
 * const claimCols = legacyClaimColumns(claim.id);
 * await supabase.from("workqueue_items").insert({ ...rest, ...claimCols });
 * ```
 */
export function legacyClaimColumns(claimId: string): {
  professional_claim_id: null;
  claim_id: string;
} {
  return { professional_claim_id: null, claim_id: claimId };
}
