/**
 * GET /api/roles
 * POST /api/roles (optional - for creating new roles)
 *
 * List all roles in the organization
 * Requires MANAGE_ROLES or MANAGE_STAFF permission
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requirePermissionInRoute,
  parseRequestBody,
} from "@/lib/rbac/middleware";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import { PERMISSIONS } from "@/lib/rbac/constants";

/**
 * GET /api/roles
 * List all roles in the organization
 */
export async function GET(_request: NextRequest) {
  // Require MANAGE_STAFF permission (implies role management)
  const authOrError = await requirePermissionInRoute(PERMISSIONS.MANAGE_STAFF);
  if (authOrError instanceof NextResponse) return authOrError;

  const { organizationId } = authOrError;

  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  try {
    // Fetch all roles for the organization
    const { data: roles, error } = await supabase
      .from("staff_roles")
      .select("*")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("display_order", { ascending: true })
      .order("role_name", { ascending: true });

    if (error) {
      return NextResponse.json(
        { error: "Failed to retrieve roles" },
        { status: 500 },
      );
    }

    // Fetch permission counts for each role
    const rolesWithPermissionCounts = await Promise.all(
      (roles || []).map(async (role) => {
        const { count } = await supabase
          .from("staff_role_permissions")
          .select("*", { count: "exact", head: true })
          .eq("staff_role_id", role.id)
          .eq("organization_id", organizationId);

        // Count active staff with this role
        const { count: staffCount } = await supabase
          .from("staff_role_assignments")
          .select("*", { count: "exact", head: true })
          .eq("staff_role_id", role.id)
          .eq("organization_id", organizationId)
          .is("archived_at", null);

        return {
          id: role.id,
          organization_id: role.organization_id,
          role_code: role.role_code,
          role_name: role.role_name,
          description: role.description,
          is_default: role.is_default,
          display_order: role.display_order,
          permission_count: count || 0,
          staff_count: staffCount || 0,
          created_at: role.created_at,
          updated_at: role.updated_at,
        };
      }),
    );

    return NextResponse.json({
      organization_id: organizationId,
      roles: rolesWithPermissionCounts,
      total: rolesWithPermissionCounts.length,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

interface CreateRolePayload {
  role_code: string;
  role_name: string;
  description?: string;
  is_default?: boolean;
  display_order?: number;
}

/**
 * POST /api/roles (optional)
 * Create a new role in the organization
 * Note: This is optional and may require additional approval flow
 */
export async function POST(request: NextRequest) {
  // Require MANAGE_STAFF or MANAGE_ROLES
  const authOrError = await requirePermissionInRoute(PERMISSIONS.MANAGE_STAFF);
  if (authOrError instanceof NextResponse) return authOrError;

  const { organizationId } = authOrError;

  // Parse request body
  const bodyOrError = await parseRequestBody<CreateRolePayload>(request);
  if (bodyOrError instanceof NextResponse) return bodyOrError;

  const payload = bodyOrError;

  // Validate required fields
  if (!payload.role_code?.trim()) {
    return NextResponse.json(
      { error: "role_code is required" },
      { status: 400 },
    );
  }
  if (!payload.role_name?.trim()) {
    return NextResponse.json(
      { error: "role_name is required" },
      { status: 400 },
    );
  }

  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  try {
    // Check if role_code already exists in organization
    const { data: existing } = await supabase
      .from("staff_roles")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("role_code", payload.role_code)
      .is("archived_at", null)
      .single();

    if (existing) {
      return NextResponse.json(
        { error: "Role code already exists in this organization" },
        { status: 400 },
      );
    }

    // Create new role
    const { data: newRole, error: insertError } = await supabase
      .from("staff_roles")
      .insert({
        organization_id: organizationId,
        role_code: payload.role_code.toLowerCase().trim(),
        role_name: payload.role_name.trim(),
        description: payload.description?.trim() || null,
        is_default: payload.is_default || false,
        display_order: payload.display_order || null,
      })
      .select("*")
      .single();

    if (insertError || !newRole) {
      return NextResponse.json(
        { error: "Failed to create role" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        id: newRole.id,
        organization_id: newRole.organization_id,
        role_code: newRole.role_code,
        role_name: newRole.role_name,
        description: newRole.description,
        is_default: newRole.is_default,
        display_order: newRole.display_order,
        permission_count: 0,
        staff_count: 0,
        created_at: newRole.created_at,
      },
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
