/**
 * RBAC Seed Data Generator
 * Initializes roles and permissions in the database
 *
 * Usage:
 * - Run this function on app startup or as a migration
 * - Safe to run multiple times (checks for existence before creating)
 */

import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_LABELS,
  PERMISSION_TO_CATEGORY,
  PERMISSIONS,
  STAFF_ROLE_LABELS,
  STAFF_ROLES,
} from "./constants";
import { PermissionCode, StaffRoleCode } from "./constants";

/**
 * Seed all permissions into the database (global, not org-specific)
 * Should be called once during initial setup
 */
export async function seedPermissions() {
  const supabase = createServerSupabaseAdminClientTyped();

  if (!supabase) {
    throw new Error("Failed to initialize Supabase client for seed");
  }

  // Get all permission codes
  const permissionCodes = Object.values(PERMISSIONS);

  // Check existing permissions
  const { data: existing } = await supabase
    .from("staff_permissions")
    .select("permission_code")
    .in("permission_code", permissionCodes);

  const existingCodes = new Set(existing?.map((p) => p.permission_code) ?? []);

  // Insert missing permissions
  const toInsert = permissionCodes
    .filter((code) => !existingCodes.has(code))
    .map((code) => ({
      permission_code: code,
      permission_label: PERMISSION_LABELS[code as PermissionCode],
      category: PERMISSION_TO_CATEGORY[code as PermissionCode],
      description: `Permission: ${code}`,
      created_at: new Date().toISOString(),
    }));

  if (toInsert.length > 0) {
    const { error } = await supabase.from("staff_permissions").insert(toInsert);
    if (error) {
      console.error("Error seeding permissions:", error);
      return { success: false, error };
    }
  }

  return { success: true, inserted: toInsert.length };
}

/**
 * Seed default roles for an organization
 */
export async function seedRoles(organizationId: string) {
  const supabase = createServerSupabaseAdminClientTyped();

  if (!supabase) {
    throw new Error("Failed to initialize Supabase client for seed");
  }

  // Check existing roles for this org
  const { data: existing } = await supabase
    .from("staff_roles")
    .select("role_code")
    .eq("organization_id", organizationId);

  const existingCodes = new Set(existing?.map((r) => r.role_code) ?? []);

  // Insert missing roles
  const roleCodes = Object.values(STAFF_ROLES);
  const toInsert = roleCodes
    .filter((code) => !existingCodes.has(code))
    .map((code, index) => ({
      organization_id: organizationId,
      role_code: code,
      role_name: STAFF_ROLE_LABELS[code as StaffRoleCode],
      description: `${STAFF_ROLE_LABELS[code as StaffRoleCode]} role`,
      is_default: code === "read_only",
      display_order: index,
      created_at: new Date().toISOString(),
    }));

  if (toInsert.length > 0) {
    const { error } = await supabase.from("staff_roles").insert(toInsert);
    if (error) {
      console.error("Error seeding roles:", error);
      return { success: false, error };
    }
  }

  return { success: true, inserted: toInsert.length };
}

/**
 * Link permissions to roles for an organization
 * Sets up the default permission mappings per role
 */
export async function seedRolePermissions(organizationId: string) {
  const supabase = createServerSupabaseAdminClientTyped();

  if (!supabase) {
    throw new Error("Failed to initialize Supabase client for seed");
  }

  // Get all role IDs for this org
  const { data: rolesData } = await supabase
    .from("staff_roles")
    .select("id, role_code")
    .eq("organization_id", organizationId);

  const roleMap = new Map(rolesData?.map((r) => [r.role_code, r.id]) ?? []);

  // Get all permission IDs
  const { data: permsData } = await supabase
    .from("staff_permissions")
    .select("id, permission_code");

  const permMap = new Map(permsData?.map((p) => [p.permission_code, p.id]) ?? []);

  // Check existing role-permission links
  const { data: existing } = await supabase
    .from("staff_role_permissions")
    .select("staff_role_id, permission_id")
    .eq("organization_id", organizationId);

  const existingLinks = new Set(
    existing?.map((e) => `${e.staff_role_id}:${e.permission_id}`) ?? [],
  );

  // Build new links from DEFAULT_ROLE_PERMISSIONS
  const toInsert: Array<{
    organization_id: string;
    staff_role_id: string;
    permission_id: string;
    created_at: string;
  }> = [];

  for (const [roleCode, permissionCodes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const roleId = roleMap.get(roleCode);
    if (!roleId) continue;

    for (const permissionCode of permissionCodes) {
      const permId = permMap.get(permissionCode);
      if (!permId) continue;

      const linkKey = `${roleId}:${permId}`;
      if (!existingLinks.has(linkKey)) {
        toInsert.push({
          organization_id: organizationId,
          staff_role_id: roleId,
          permission_id: permId,
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("staff_role_permissions").insert(toInsert);
    if (error) {
      console.error("Error seeding role permissions:", error);
      return { success: false, error };
    }
  }

  return { success: true, inserted: toInsert.length };
}

/**
 * Complete RBAC initialization for system and organization
 * Call this once per organization during onboarding
 */
export async function initializeRBAC(organizationId: string) {
  console.log("Initializing RBAC...");

  // Step 1: Seed global permissions (one-time)
  console.log("Seeding permissions...");
  const permResult = await seedPermissions();
  if (!permResult.success) {
    console.error("Failed to seed permissions", permResult.error);
    return { success: false, error: "Failed to seed permissions" };
  }
  console.log(`Inserted ${permResult.inserted} new permissions`);

  // Step 2: Seed org roles
  console.log(`Seeding roles for org ${organizationId}...`);
  const roleResult = await seedRoles(organizationId);
  if (!roleResult.success) {
    console.error("Failed to seed roles", roleResult.error);
    return { success: false, error: "Failed to seed roles" };
  }
  console.log(`Inserted ${roleResult.inserted} new roles`);

  // Step 3: Link permissions to roles
  console.log("Seeding role permissions...");
  const linkResult = await seedRolePermissions(organizationId);
  if (!linkResult.success) {
    console.error("Failed to seed role permissions", linkResult.error);
    return { success: false, error: "Failed to seed role permissions" };
  }
  console.log(`Inserted ${linkResult.inserted} new role-permission links`);

  console.log("RBAC initialization complete!");
  return { success: true };
}
