/**
 * Server-side RBAC Authentication & Authorization Helpers
 * Used in API routes, server actions, and route handlers
 */

import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import type { Database } from "@/src/types/supabase";
import { PermissionCode, StaffRoleCode } from "./constants";

/**
 * Authenticated user context loaded from Supabase auth
 */
export interface AuthenticatedUser {
  userId: string;
  email: string | null;
  organizationId: string | null;
}

/**
 * Complete staff context with permissions and roles
 */
export interface StaffAuthContext {
  userId: string;
  staffId: string;
  organizationId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  isActive: boolean;
  roles: StaffRoleCode[];
  permissions: PermissionCode[];
}

/**
 * Get the authenticated user from Supabase auth session
 * Returns null if not authenticated
 */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return null;

  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return null;
    }

    return {
      userId: user.id,
      email: user.email ?? null,
      organizationId: (user.user_metadata?.organization_id as string) || null,
    };
  } catch {
    return null;
  }
}

/**
 * Get the organization_id for an authenticated user
 * Looks up from auth metadata first, then falls back to staff_profiles table
 */
export async function getUserOrganization(userId: string): Promise<string | null> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return null;

  // First try user metadata (fast path — set at sign-up/invite)
  try {
    const { data: { user }, error } = await supabase.auth.admin.getUserById(userId);
    if (!error && user?.user_metadata?.organization_id) {
      return String(user.user_metadata.organization_id);
    }
  } catch {
    // Fall through to staff_profiles lookup
  }

  // Fallback: look up from staff_profiles
  const { data, error } = await supabase
    .from("staff_profiles")
    .select("organization_id")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (error || !data) return null;
  return data.organization_id ?? null;
}

/**
 * Get staff profile by auth user ID
 */
export async function getStaffProfileByAuthUser(
  userId: string,
): Promise<Database["public"]["Tables"]["staff_profiles"]["Row"] | null> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("staff_profiles")
    .select("*")
    .eq("auth_user_id", userId)
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}

/**
 * Get staff profile by ID
 */
export async function getStaffProfileById(
  staffId: string,
): Promise<Database["public"]["Tables"]["staff_profiles"]["Row"] | null> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("staff_profiles")
    .select("*")
    .eq("id", staffId)
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}

/**
 * Get all active roles for a staff member
 */
export async function getStaffRoles(
  staffId: string,
  organizationId: string,
): Promise<StaffRoleCode[]> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("staff_role_assignments")
    .select(`staff_role_id, staff_roles!inner(role_code)`)
    .eq("staff_id", staffId)
    .eq("organization_id", organizationId)
    .is("archived_at", null);

  if (error || !data) {
    return [];
  }

  const roles = (
    data as unknown as Array<{
      staff_roles: { role_code: StaffRoleCode };
    }>
  )
    .map((a) => a.staff_roles?.role_code)
    .filter((role): role is StaffRoleCode => !!role);

  return Array.from(new Set(roles));
}

/**
 * Get all effective permissions for a staff member
 * Combines permissions from all their assigned roles
 */
export async function getEffectivePermissions(
  staffId: string,
  organizationId: string,
): Promise<PermissionCode[]> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return [];

  // First get all role IDs for this staff member
  const { data: assignmentsData, error: assignmentsError } = await supabase
    .from("staff_role_assignments")
    .select(`staff_role_id`)
    .eq("staff_id", staffId)
    .eq("organization_id", organizationId)
    .is("archived_at", null);

  if (assignmentsError || !assignmentsData) {
    return [];
  }

  const roleIds = assignmentsData.map((a) => a.staff_role_id);

  if (roleIds.length === 0) {
    return [];
  }

  // Get all permissions linked to these roles
  const { data: permissionsData, error: permError } = await supabase
    .from("staff_role_permissions")
    .select(
      `
      staff_permissions!inner(
        permission_code
      )
    `,
    )
    .in("staff_role_id", roleIds)
    .eq("organization_id", organizationId);

  if (permError || !permissionsData) {
    return [];
  }

  const permissions = (
    permissionsData as unknown as Array<{
      staff_permissions: { permission_code: PermissionCode };
    }>
  )
    .map((p) => p.staff_permissions?.permission_code)
    .filter((perm): perm is PermissionCode => !!perm);

  return Array.from(new Set(permissions));
}

/**
 * Load complete staff auth context
 * Requires valid staffId and organizationId
 */
export async function loadStaffAuthContext(
  staffId: string,
  organizationId: string,
): Promise<StaffAuthContext | null> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return null;

  // Get staff profile
  const staffProfile = await getStaffProfileById(staffId);
  if (!staffProfile || staffProfile.organization_id !== organizationId) {
    return null;
  }

  // Verify staff is active
  if (!staffProfile.is_active || staffProfile.archived_at) {
    return null;
  }

  // Get roles and permissions
  const roles = await getStaffRoles(staffId, organizationId);
  const permissions = await getEffectivePermissions(staffId, organizationId);

  return {
    userId: staffProfile.auth_user_id || "",
    staffId,
    organizationId,
    email: staffProfile.email,
    firstName: staffProfile.first_name,
    lastName: staffProfile.last_name,
    jobTitle: staffProfile.job_title,
    isActive: staffProfile.is_active ?? true,
    roles,
    permissions,
  };
}

/**
 * Check if a staff member has a specific permission
 */
export async function hasPermission(
  staffId: string,
  organizationId: string,
  permissionCode: PermissionCode,
): Promise<boolean> {
  const permissions = await getEffectivePermissions(staffId, organizationId);
  return permissions.includes(permissionCode);
}

/**
 * Check if a staff member has any of the provided permissions
 */
export async function hasAnyPermission(
  staffId: string,
  organizationId: string,
  permissionCodes: PermissionCode[],
): Promise<boolean> {
  if (permissionCodes.length === 0) return false;

  const permissions = await getEffectivePermissions(staffId, organizationId);
  return permissionCodes.some((code) => permissions.includes(code));
}

/**
 * Check if a staff member has all of the provided permissions
 */
export async function hasAllPermissions(
  staffId: string,
  organizationId: string,
  permissionCodes: PermissionCode[],
): Promise<boolean> {
  if (permissionCodes.length === 0) return true;

  const permissions = await getEffectivePermissions(staffId, organizationId);
  return permissionCodes.every((code) => permissions.includes(code));
}

/**
 * Check if a staff member has a specific role
 */
export async function hasRole(
  staffId: string,
  organizationId: string,
  roleCode: StaffRoleCode,
): Promise<boolean> {
  const roles = await getStaffRoles(staffId, organizationId);
  return roles.includes(roleCode);
}

/**
 * Verify staff member is active (not archived, is_active=true)
 * Throws error if inactive
 */
export async function assertStaffActive(staffId: string): Promise<void> {
  const profile = await getStaffProfileById(staffId);

  if (!profile) {
    throw new Error("Staff profile not found");
  }

  if (!profile.is_active || profile.archived_at) {
    throw new Error("Staff member is inactive or archived");
  }
}

/**
 * Verify that resourceOrganizationId matches userOrganizationId
 * Enforces tenant isolation - users can only access records in their org
 * Throws error if mismatch
 */
export function assertSameOrganization(
  resourceOrganizationId: string | null,
  userOrganizationId: string,
): void {
  if (!resourceOrganizationId || resourceOrganizationId !== userOrganizationId) {
    throw new Error("Access denied: organization mismatch");
  }
}

/**
 * Verify user is authenticated and load their context
 * Used in API routes to enforce authentication
 * Returns null if not authenticated or validation fails
 */
export async function requireAuthenticatedStaff(): Promise<StaffAuthContext | null> {
  const user = await getAuthenticatedUser();
  if (!user || !user.organizationId) {
    return null;
  }

  const staffProfile = await getStaffProfileByAuthUser(user.userId);
  if (!staffProfile) {
    return null;
  }

  const context = await loadStaffAuthContext(staffProfile.id, user.organizationId);
  return context;
}
