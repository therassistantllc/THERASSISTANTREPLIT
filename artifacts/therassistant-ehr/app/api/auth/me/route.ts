/**
 * GET /api/auth/me
 * Returns the current authenticated user's context
 * (staffId, organizationId, roles, permissions)
 *
 * Example: Call from client to load user context on app startup
 */

import { NextResponse } from "next/server";
import { requireAuthentication } from "@/lib/rbac/middleware";
import { getAuthenticatedUser, getProviderIdForUser } from "@/lib/rbac/auth";

export async function GET() {
  const contextOrError = await requireAuthentication();

  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }

  const { staffId, organizationId, email, firstName, lastName, roles, permissions } = contextOrError;

  const authUser = await getAuthenticatedUser();
  const providerId = authUser
    ? await getProviderIdForUser(authUser.userId, organizationId)
    : null;

  return NextResponse.json({
    staffId,
    organizationId,
    email,
    firstName,
    lastName,
    roles,
    permissions,
    providerId,
  });
}
