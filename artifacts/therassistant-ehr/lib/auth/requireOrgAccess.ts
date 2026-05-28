/**
 * Generic API tenant-isolation gate (Task #166).
 *
 * Sister helper to `lib/billing/requireBillingAccess` — the latter is
 * pinned to billing-capable users (VIEW_BILLING by default). This one
 * is for every OTHER `app/api/**` route that accepts an
 * `organizationId` from the request: settings, clients/clients,
 * scheduling, mailroom, workqueue, chat, eligibility, etc.
 *
 * It does three things:
 *
 *   1. Resolves the authenticated staff member from the Supabase auth
 *      cookie via `requireAuthenticatedStaff`.
 *   2. If a permission is required, verifies they hold it. (Default
 *      behaviour is "any authenticated staff member is fine" — pass
 *      `permission` to tighten that.)
 *   3. Enforces tenant isolation: if the request carried an
 *      `organizationId` (query string or body), it MUST match the
 *      session's organizationId. The returned `organizationId` is the
 *      session's, never the client's.
 *
 * Behaviour by env (mirrors `requireBillingAccess`):
 *   - production / test: no session → 401, missing perm → 403,
 *     mismatched org → 403.
 *   - development: missing session is allowed (returns a
 *     `isDevPassthrough: true` context) so local-without-login keeps
 *     working. A logged-in dev session still has its perm + org
 *     checks enforced.
 *
 * Routes that authenticate via a different mechanism (Stripe
 * webhooks, FHIR API-key, public intake-token forms, cron secret
 * routes) MUST NOT call this helper — they have no user session.
 */
import { NextResponse } from "next/server";
import { requireAuthenticatedStaff, type StaffAuthContext } from "@/lib/rbac/auth";
import type { PermissionCode, StaffRoleCode } from "@/lib/rbac/constants";
import { DEFAULT_ORG_ID } from "@/lib/config";

export interface OrgAuthContext {
  organizationId: string;
  staffId: string | null;
  userId: string | null;
  roles: StaffRoleCode[];
  permissions: PermissionCode[];
  isDevPassthrough: boolean;
}

export interface OrgAccessOptions {
  /**
   * Org id pulled off the request (query/body). Used only to verify
   * it matches the session — never trusted as the source of truth.
   * Pass `null`/`undefined` if the route doesn't accept one.
   */
  requestedOrganizationId?: string | null;
  /**
   * Optional permission required. Leave undefined / null to require
   * only an authenticated staff member (the common case for routes
   * that previously relied on RLS or no auth at all).
   */
  permission?: PermissionCode | null;
}

export type EvaluateOrgAccessResult =
  | { ok: true; context: OrgAuthContext }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Pure evaluation — exported so it can be unit-tested without
 * spinning up Supabase.
 */
export function evaluateOrgAccess(
  staffCtx: StaffAuthContext | null,
  options: OrgAccessOptions = {},
  env: string | undefined = process.env.NODE_ENV,
): EvaluateOrgAccessResult {
  const requestedOrg = options.requestedOrganizationId
    ? String(options.requestedOrganizationId).trim() || null
    : null;
  const permission = options.permission ?? null;

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
      error: "Cannot access data for a different organization",
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
 * Route helper. Returns the verified `OrgAuthContext` on success or
 * a `NextResponse` error to be returned directly:
 *
 *   const guard = await requireOrgAccess({
 *     requestedOrganizationId: searchParams.get("organizationId"),
 *   });
 *   if (guard instanceof NextResponse) return guard;
 *   const { organizationId } = guard; // session-derived, safe to use
 */
export async function requireOrgAccess(
  options: OrgAccessOptions = {},
): Promise<OrgAuthContext | NextResponse> {
  const staffCtx = await requireAuthenticatedStaff();
  const result = evaluateOrgAccess(staffCtx, options);
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: result.status },
    );
  }
  return result.context;
}
