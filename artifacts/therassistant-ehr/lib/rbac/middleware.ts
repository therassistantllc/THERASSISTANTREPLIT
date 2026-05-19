/**
 * Route & API Protection Middleware
 * Provides decorators and helpers for protecting routes and API endpoints
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthenticatedStaff,
  hasPermission,
  hasAnyPermission,
  hasRole,
  assertStaffActive,
  assertSameOrganization,
} from "./auth";
import type { PermissionCode, StaffRoleCode } from "./constants";

/**
 * API route context with authenticated staff
 */
export interface AuthenticatedRouteContext {
  staffId: string;
  organizationId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  roles: StaffRoleCode[];
  permissions: PermissionCode[];
}

/**
 * Check if user is authenticated and has required permission
 * Used in API routes
 */
export async function requirePermissionInRoute(
  permissionCode: PermissionCode,
): Promise<AuthenticatedRouteContext | NextResponse> {
  const context = await requireAuthenticatedStaff();

  if (!context) {
    return NextResponse.json(
      { error: "Not authenticated" },
      { status: 401 },
    );
  }

  try {
    await assertStaffActive(context.staffId);
  } catch {
    return NextResponse.json(
      { error: "Staff member is inactive" },
      { status: 403 },
    );
  }

  const hasAccess = await hasPermission(
    context.staffId,
    context.organizationId,
    permissionCode,
  );

  if (!hasAccess) {
    return NextResponse.json(
      { error: "Insufficient permissions" },
      { status: 403 },
    );
  }

  return context;
}

/**
 * Check if user is authenticated and has any of the required permissions
 * Used in API routes
 */
export async function requireAnyPermissionInRoute(
  permissionCodes: PermissionCode[],
): Promise<AuthenticatedRouteContext | NextResponse> {
  const context = await requireAuthenticatedStaff();

  if (!context) {
    return NextResponse.json(
      { error: "Not authenticated" },
      { status: 401 },
    );
  }

  try {
    await assertStaffActive(context.staffId);
  } catch {
    return NextResponse.json(
      { error: "Staff member is inactive" },
      { status: 403 },
    );
  }

  const hasAccess = await hasAnyPermission(
    context.staffId,
    context.organizationId,
    permissionCodes,
  );

  if (!hasAccess) {
    return NextResponse.json(
      { error: "Insufficient permissions" },
      { status: 403 },
    );
  }

  return context;
}

/**
 * Check if user is authenticated and has required role
 * Used in API routes
 */
export async function requireRoleInRoute(
  roleCode: StaffRoleCode,
): Promise<AuthenticatedRouteContext | NextResponse> {
  const context = await requireAuthenticatedStaff();

  if (!context) {
    return NextResponse.json(
      { error: "Not authenticated" },
      { status: 401 },
    );
  }

  try {
    await assertStaffActive(context.staffId);
  } catch {
    return NextResponse.json(
      { error: "Staff member is inactive" },
      { status: 403 },
    );
  }

  const hasAccess = await hasRole(
    context.staffId,
    context.organizationId,
    roleCode,
  );

  if (!hasAccess) {
    return NextResponse.json(
      { error: "Insufficient role" },
      { status: 403 },
    );
  }

  return context;
}

/**
 * Check if user is authenticated (minimal check)
 * Used in API routes that just need to verify user exists
 */
export async function requireAuthentication(): Promise<AuthenticatedRouteContext | NextResponse> {
  const context = await requireAuthenticatedStaff();

  if (!context) {
    return NextResponse.json(
      { error: "Not authenticated" },
      { status: 401 },
    );
  }

  try {
    await assertStaffActive(context.staffId);
  } catch {
    return NextResponse.json(
      { error: "Staff member is inactive" },
      { status: 403 },
    );
  }

  return context;
}

/**
 * Enforce tenant isolation: verify resource belongs to user's organization
 * Throws error if mismatch (returns 403 response)
 */
export function enforceOrganizationInRoute(
  resourceOrganizationId: string | null,
  userOrganizationId: string,
): NextResponse | null {
  try {
    assertSameOrganization(resourceOrganizationId, userOrganizationId);
    return null;
  } catch {
    return NextResponse.json(
      { error: "Access denied: organization mismatch" },
      { status: 403 },
    );
  }
}

/**
 * Example: Protected API route wrapper
 * Usage in route.ts:
 *
 *   export async function GET(request: NextRequest) {
 *     const authOrError = await requirePermissionInRoute("view_billing");
 *     if (authOrError instanceof NextResponse) return authOrError;
 *
 *     const { staffId, organizationId } = authOrError;
 *     // Safe to use authOrError properties now
 *   }
 */

/**
 * Decode and parse request body as JSON (with error handling)
 */
export async function parseRequestBody<T>(request: NextRequest): Promise<T | NextResponse> {
  try {
    return (await request.json()) as T;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body" },
      { status: 400 },
    );
  }
}

/**
 * Check if value is valid UUID
 */
export function isValidUuid(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}
