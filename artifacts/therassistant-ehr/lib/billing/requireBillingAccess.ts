/**
 * Billing API auth gate (Task #145).
 *
 * Every route under `app/api/billing/**` should run through
 * `requireBillingAccess` before touching the database. It does three
 * things:
 *
 *   1. Resolves the authenticated staff member from the Supabase auth
 *      cookie via `requireAuthenticatedStaff`.
 *   2. Verifies they hold at least the requested permission (defaults
 *      to `VIEW_BILLING` — i.e. "is billing-capable").
 *   3. Enforces tenant isolation: if the request carried an
 *      `organizationId` (query string or body), it MUST match the
 *      session's organizationId. The returned `organizationId` is the
 *      session's, never the client's.
 *
 * Behaviour by env:
 *   - production / test: no session → 401, missing perm → 403,
 *     mismatched org → 403.
 *   - development: missing session is allowed (returns a
 *     `isDevPassthrough: true` context) so local-without-login keeps
 *     working. A logged-in dev session still has its perm + org
 *     checks enforced.
 *
 * Webhook routes (e.g. Stripe) and cron routes that authenticate via
 * shared secrets MUST NOT call this helper — they don't have a user
 * session.
 */
import { NextResponse } from "next/server";
import { requireAuthenticatedStaff, type StaffAuthContext } from "@/lib/rbac/auth";
import { PERMISSIONS, type PermissionCode, type StaffRoleCode } from "@/lib/rbac/constants";
import { DEFAULT_ORG_ID } from "@/lib/config";

export interface BillingAuthContext {
  organizationId: string;
  staffId: string | null;
  userId: string | null;
  roles: StaffRoleCode[];
  permissions: PermissionCode[];
  isDevPassthrough: boolean;
}

export interface BillingAccessOptions {
  /**
   * Org id pulled off the request (query/body). Used only to verify
   * it matches the session — never trusted as the source of truth.
   * Pass `null`/`undefined` if the route doesn't accept one.
   */
  requestedOrganizationId?: string | null;
  /**
   * Minimum permission required. Defaults to `VIEW_BILLING`. Pass
   * `null` to require an authenticated staff member with no specific
   * permission (e.g. for global reference data like ICD/CPT lookups).
   */
  permission?: PermissionCode | null;
}

export type EvaluateBillingAccessResult =
  | { ok: true; context: BillingAuthContext }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Pure evaluation — exported so it can be unit-tested without
 * spinning up Supabase.
 */
export function evaluateBillingAccess(
  staffCtx: StaffAuthContext | null,
  options: BillingAccessOptions = {},
  env: string | undefined = process.env.NODE_ENV,
): EvaluateBillingAccessResult {
  const requestedOrg = options.requestedOrganizationId
    ? String(options.requestedOrganizationId).trim() || null
    : null;
  const permission =
    options.permission === undefined ? PERMISSIONS.VIEW_BILLING : options.permission;

  if (!staffCtx) {
    if (env !== "development") {
      return { ok: false, status: 401, error: "Authentication required" };
    }
    return {
      ok: true,
      context: {
        organizationId: requestedOrg || DEFAULT_ORG_ID,
        staffId: null,
        userId: null,
        roles: [],
        permissions: [],
        isDevPassthrough: true,
      },
    };
  }

  if (requestedOrg && requestedOrg !== staffCtx.organizationId) {
    return {
      ok: false,
      status: 403,
      error: "Cannot access billing data for a different organization",
    };
  }

  if (permission && !staffCtx.permissions.includes(permission)) {
    return { ok: false, status: 403, error: "Insufficient permissions" };
  }

  return {
    ok: true,
    context: {
      organizationId: staffCtx.organizationId,
      staffId: staffCtx.staffId,
      userId: staffCtx.userId || null,
      roles: staffCtx.roles,
      permissions: staffCtx.permissions,
      isDevPassthrough: false,
    },
  };
}

/**
 * Route helper. Returns the verified `BillingAuthContext` on success
 * or a `NextResponse` error to be returned directly:
 *
 *   const guard = await requireBillingAccess({
 *     requestedOrganizationId: searchParams.get("organizationId"),
 *   });
 *   if (guard instanceof NextResponse) return guard;
 *   const { organizationId } = guard; // session-derived, safe to use
 */
export async function requireBillingAccess(
  options: BillingAccessOptions = {},
): Promise<BillingAuthContext | NextResponse> {
  const staffCtx = await requireAuthenticatedStaff();
  const result = evaluateBillingAccess(staffCtx, options);
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: result.status },
    );
  }
  return result.context;
}
