/**
 * Server-side RBAC utility functions
 * Used for permission checks in Server Components and API routes
 */

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { PermissionCode, StaffRoleCode } from "./constants";

export interface StaffContextData {
  staffId: string;
  organizationId: string;
  authUserId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  jobTitle: string | null;
  providerNpi: string | null;
  roles: StaffRoleCode[];
  permissions: PermissionCode[];
}

/**
 * Get the current staff member's context data including roles and permissions
 * Should be called from authenticated server contexts only
 */
export async function getStaffContext(
  organizationId: string,
  staffId: string,
): Promise<StaffContextData | null> {
  const supabase = createServerSupabaseAdminClient();

  if (!supabase) {
    return null;
  }

  // Get staff profile
  const { data: staffData, error: staffError } = await supabase
    .from("staff_profiles")
    .select("*")
    .eq("id", staffId)
    .eq("organization_id", organizationId)
    .single();

  if (staffError || !staffData) {
    return null;
  }

  // Get staff role assignments with role details
  const { data: assignmentsData, error: assignmentsError } = await supabase
    .from("staff_role_assignments")
    .select(
      `
      id,
      staff_role_id,
      staff_roles!inner(
        id,
        role_code
      )
    `,
    )
    .eq("staff_id", staffId)
    .eq("organization_id", organizationId)
    .is("archived_at", null);

  if (assignmentsError) {
    return null;
  }

  // Extract unique role codes
  const roleCodeSet = new Set<StaffRoleCode>();
  const assignmentList = assignmentsData as unknown as Array<{
    staff_role_id: string;
    staff_roles: { role_code: StaffRoleCode };
  }>;

  assignmentList.forEach((assignment) => {
    if (assignment.staff_roles?.role_code) {
      roleCodeSet.add(assignment.staff_roles.role_code);
    }
  });

  const roles = Array.from(roleCodeSet);

  // Get all permissions for these roles — skip if no roles assigned
  const permissionSet = new Set<PermissionCode>();

  if (assignmentList.length > 0) {
    const { data: permLinkData, error: permLinkError } = await supabase
      .from("staff_role_permissions")
      .select(
        `
        permission_id,
        staff_permissions!inner(
          permission_code
        )
      `,
      )
      .in("staff_role_id", assignmentList.map((a) => a.staff_role_id))
      .eq("organization_id", organizationId);

    if (permLinkError) {
      return null;
    }

    const permList = permLinkData as unknown as Array<{
      staff_permissions: { permission_code: PermissionCode };
    }>;

    permList.forEach((perm) => {
      if (perm.staff_permissions?.permission_code) {
        permissionSet.add(perm.staff_permissions.permission_code);
      }
    });
  }

  const permissions = Array.from(permissionSet);

  return {
    staffId,
    organizationId,
    authUserId: staffData.auth_user_id,
    firstName: staffData.first_name,
    lastName: staffData.last_name,
    email: staffData.email,
    jobTitle: staffData.job_title,
    providerNpi: staffData.provider_npi,
    roles,
    permissions,
  };
}

/**
 * Enforce permission check - throws error if permission denied
 * Use in API routes for middleware-style checks
 */
export async function enforcePermission(
  organizationId: string,
  staffId: string,
  requiredPermission: PermissionCode,
  errorMessage?: string,
): Promise<StaffContextData> {
  const context = await getStaffContext(organizationId, staffId);

  if (!context || !context.permissions.includes(requiredPermission)) {
    throw new Error(errorMessage || `Permission denied: ${requiredPermission}`);
  }

  return context;
}
