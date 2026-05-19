/**
 * Validation Helpers for Staff/Role Management API
 * Provides reusable validation functions for email, roles, staffing constraints, etc.
 */

import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import type { Database } from "@/src/types/supabase";

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.toLowerCase());
}

/**
 * Validate UUID format
 */
export function isValidUuid(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Validate required fields in payload
 */
export function validateRequiredFields(
  payload: Record<string, unknown>,
  requiredFields: string[],
): string | null {
  for (const field of requiredFields) {
    if (!(field in payload) || (payload[field] === null || payload[field] === "")) {
      return `Missing required field: ${field}`;
    }
  }
  return null;
}

/**
 * Validate email uniqueness within organization
 */
export async function isEmailUniqueInOrg(
  email: string,
  organizationId: string,
  excludeStaffId?: string,
): Promise<boolean> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return false;

  let query = supabase
    .from("staff_profiles")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("email", email.toLowerCase())
    .is("archived_at", null);

  if (excludeStaffId) {
    query = query.neq("id", excludeStaffId);
  }

  const { data, error } = await query;

  if (error) return false;
  return !data || data.length === 0;
}

/**
 * Check if role exists in organization
 */
export async function roleExistsInOrg(
  roleId: string,
  organizationId: string,
): Promise<boolean> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return false;

  const { data, error } = await supabase
    .from("staff_roles")
    .select("id")
    .eq("id", roleId)
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .single();

  return !error && !!data;
}

/**
 * Validate staff role linkage (e.g., if assigning clinician/provider role)
 * Checks if staff has appropriate provider profile if needed
 */
export async function validateRoleStaffLinkage(
  roleCode: string,
  staffId: string,
): Promise<{ valid: boolean; reason?: string }> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return { valid: false, reason: "Database error" };

  // Clinician role may require provider profile
  if (roleCode === "clinician" || roleCode === "provider") {
    const { data: providerProfile, error } = await supabase
      .from("provider_profiles")
      .select("id")
      .eq("staff_id", staffId)
      .single();

    if (error || !providerProfile) {
      return {
        valid: false,
        reason: `${roleCode} role requires a provider profile with NPI. Create provider profile first.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Check if staff member is the last active admin in organization
 * If true, prevent deactivation to avoid locking out the org
 */
export async function isLastActiveAdmin(
  staffId: string,
  organizationId: string,
): Promise<boolean> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return false;

  // Get admin role ID for this org
  const { data: adminRole, error: roleError } = await supabase
    .from("staff_roles")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("role_code", "admin")
    .is("archived_at", null)
    .single();

  if (roleError || !adminRole) return false;

  // Count active admins in org (excluding this staff member)
  const { data: activeAdmins, error: countError } = await supabase
    .from("staff_role_assignments")
    .select("staff_id", { count: "exact" })
    .eq("organization_id", organizationId)
    .eq("staff_role_id", adminRole.id)
    .neq("staff_id", staffId)
    .is("archived_at", null);

  if (countError) return false;

  const activeAdminCount = activeAdmins?.length ?? 0;
  return activeAdminCount === 0;
}

/**
 * Check if staff member already has a specific role assignment (active)
 */
export async function staffHasRoleAssignment(
  staffId: string,
  roleId: string,
  organizationId: string,
): Promise<boolean> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return false;

  const { data, error } = await supabase
    .from("staff_role_assignments")
    .select("id")
    .eq("staff_id", staffId)
    .eq("staff_role_id", roleId)
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .single();

  return !error && !!data;
}

/**
 * Check if permission exists globally
 */
export async function permissionExists(permissionCode: string): Promise<boolean> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return false;

  const { data, error } = await supabase
    .from("staff_permissions")
    .select("id")
    .eq("permission_code", permissionCode)
    .single();

  return !error && !!data;
}

/**
 * Get organization details
 */
export async function getOrganizationDetails(
  organizationId: string,
): Promise<Database["public"]["Tables"]["organization_members"]["Row"] | null> {
  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("organization_members")
    .select("*")
    .eq("id", organizationId)
    .is("archived_at", null)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Validate create staff payload
 */
export interface CreateStaffPayload {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  job_title?: string;
  provider_npi?: string;
  is_active?: boolean;
}

export async function validateCreateStaffPayload(
  payload: CreateStaffPayload,
  organizationId: string,
): Promise<{ valid: boolean; error?: string }> {
  // Validate required fields
  if (!payload.first_name?.trim()) {
    return { valid: false, error: "First name is required" };
  }
  if (!payload.last_name?.trim()) {
    return { valid: false, error: "Last name is required" };
  }
  if (!payload.email?.trim()) {
    return { valid: false, error: "Email is required" };
  }

  // Validate email format
  if (!isValidEmail(payload.email)) {
    return { valid: false, error: "Invalid email format" };
  }

  // Check email uniqueness
  const emailUnique = await isEmailUniqueInOrg(payload.email, organizationId);
  if (!emailUnique) {
    return { valid: false, error: "Email already exists in organization" };
  }

  return { valid: true };
}

/**
 * Validate update staff payload
 */
export interface UpdateStaffPayload {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  job_title?: string;
  provider_npi?: string;
  is_active?: boolean;
}

export async function validateUpdateStaffPayload(
  payload: UpdateStaffPayload,
  organizationId: string,
  staffId: string,
): Promise<{ valid: boolean; error?: string }> {
  // Validate email format if provided
  if (payload.email && !isValidEmail(payload.email)) {
    return { valid: false, error: "Invalid email format" };
  }

  // Check email uniqueness if changed
  if (payload.email) {
    const emailUnique = await isEmailUniqueInOrg(payload.email, organizationId, staffId);
    if (!emailUnique) {
      return { valid: false, error: "Email already exists in organization" };
    }
  }

  // If deactivating, check if last active admin
  if (payload.is_active === false) {
    const isLast = await isLastActiveAdmin(staffId, organizationId);
    if (isLast) {
      return { valid: false, error: "Cannot deactivate the last active admin in the organization" };
    }
  }

  return { valid: true };
}
