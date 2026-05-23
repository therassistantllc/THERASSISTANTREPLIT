/**
 * Payment Posting Engine — role guard.
 *
 * Spec §10: "Clinicians MUST NOT have access to payment posting unless
 * the org grants the POST_PAYMENTS permission explicitly." This is already
 * the case in lib/rbac/constants.ts (DEFAULT_ROLE_PERMISSIONS for
 * 'clinician' does NOT include POST_PAYMENTS), so this module is a thin,
 * shared chokepoint that every API route / server action can call.
 */

import {
  PERMISSIONS,
  enforcePermission,
  getStaffContext,
  type StaffContextData,
} from "@/lib/rbac";
import { requireAuthenticatedStaff } from "@/lib/rbac/auth";
import type { PostingActor } from "./types";

export class PaymentPostingForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message = "You do not have permission to post payments.") {
    super(message);
    this.name = "PaymentPostingForbiddenError";
  }
}

export class PaymentPostingUnauthenticatedError extends Error {
  readonly statusCode = 401;
  constructor(message = "Authentication required to post payments.") {
    super(message);
    this.name = "PaymentPostingUnauthenticatedError";
  }
}

/**
 * Throws if the given staff member does not have the POST_PAYMENTS
 * permission. Returns the loaded staff context on success.
 *
 * Use this inside services / server actions when you already have a
 * resolved staffId + organizationId.
 */
async function assertCanPostPayments(
  organizationId: string,
  staffId: string,
): Promise<StaffContextData> {
  try {
    const ctx = await enforcePermission(
      organizationId,
      staffId,
      PERMISSIONS.POST_PAYMENTS,
      "You do not have permission to post payments. Ask an admin to grant the POST_PAYMENTS permission.",
    );
    return ctx;
  } catch (err) {
    throw new PaymentPostingForbiddenError(
      err instanceof Error ? err.message : undefined,
    );
  }
}

/**
 * Entry-point for API routes. Resolves the authenticated staff member from
 * the Supabase auth cookie, checks POST_PAYMENTS, verifies the request's
 * target organization matches the staff member's organization (tenant
 * isolation), and returns a `PostingActor` ready to be threaded into
 * `commitPosting`.
 *
 * @param requestOrganizationId - The organization_id the API call intends
 *   to act on. MUST be supplied — passing `null` makes the cross-tenant
 *   IDOR check impossible. Omitting it is allowed only for internal
 *   callers via `resolveOptionalPostingActor`.
 *
 * Behaviour:
 *   - Production (NODE_ENV='production'): unauthenticated → 401, missing
 *     permission → 403, org mismatch → 403.
 *   - Non-production: when no auth session is present (common for local
 *     dev / curl), returns a `system_dev` actor and skips both the
 *     permission and org-binding checks so the existing developer
 *     workflow keeps working. When an auth session IS present, both
 *     checks are enforced even in dev — so a logged-in clinician without
 *     POST_PAYMENTS, or a logged-in biller targeting a different org,
 *     still gets a 403 in dev, matching prod behaviour.
 */
export async function requireAuthenticatedPaymentPoster(
  requestOrganizationId: string,
): Promise<PostingActor> {
  const ctx = await requireAuthenticatedStaff();

  if (!ctx) {
    if (process.env.NODE_ENV === "production") {
      throw new PaymentPostingUnauthenticatedError();
    }
    return {
      staffId: null,
      userId: null,
      role: "system_dev",
      source: "api:no_auth_session_dev",
    };
  }

  if (!ctx.permissions.includes(PERMISSIONS.POST_PAYMENTS)) {
    throw new PaymentPostingForbiddenError();
  }

  // Tenant isolation: the staff member may only post payments for their
  // own organization. Without this check, a biller in org A could post a
  // payment against org B's ERA by passing org B's id in the request body.
  if (
    !requestOrganizationId ||
    requestOrganizationId !== ctx.organizationId
  ) {
    throw new PaymentPostingForbiddenError(
      "You cannot post payments for a different organization.",
    );
  }

  return {
    staffId: ctx.staffId,
    userId: ctx.userId || null,
    role: ctx.roles[0] ?? null,
    source: "api:authenticated_staff",
  };
}

/**
 * Soft variant: never throws. Used by background/internal callers that
 * want to know which staff (if any) triggered an action but should not be
 * blocked by missing perms.
 */
async function resolveOptionalPostingActor(
  organizationId: string,
  staffId: string | null,
): Promise<PostingActor | null> {
  if (!staffId) return null;
  const ctx = await getStaffContext(organizationId, staffId);
  if (!ctx) return null;
  return {
    staffId: ctx.staffId,
    userId: ctx.authUserId,
    role: ctx.roles[0] ?? null,
    source: "service:resolved",
  };
}
