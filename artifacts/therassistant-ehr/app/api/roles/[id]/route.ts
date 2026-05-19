/**
 * GET /api/roles/[id]
 *
 * Get a specific role with details
 * Requires MANAGE_STAFF permission
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requirePermissionInRoute,
  isValidUuid,
} from "@/lib/rbac/middleware";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import { PERMISSIONS } from "@/lib/rbac/constants";

/**
 * GET /api/roles/[id]
 * Get a specific role with permission and staff assignment counts
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Validate UUID format
  if (!isValidUuid(id)) {
    return NextResponse.json({ error: "Invalid role ID" }, { status: 400 });
  }

  // Require MANAGE_STAFF permission
  const authOrError = await requirePermissionInRoute(PERMISSIONS.MANAGE_STAFF);
  if (authOrError instanceof NextResponse) return authOrError;

  const { organizationId } = authOrError;

  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  try {
    // Fetch role
    const { data: role, error: roleError } = await supabase
      .from("staff_roles")
      .select("*")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .single();

    if (roleError || !role) {
      return NextResponse.json(
        { error: "Role not found or access denied" },
        { status: 404 },
      );
    }

    // Count permissions
    const { count: permissionCount } = await supabase
      .from("staff_role_permissions")
      .select("*", { count: "exact", head: true })
      .eq("staff_role_id", id)
      .eq("organization_id", organizationId);

    // Count staff with this role
    const { count: staffCount } = await supabase
      .from("staff_role_assignments")
      .select("*", { count: "exact", head: true })
      .eq("staff_role_id", id)
      .eq("organization_id", organizationId)
      .is("archived_at", null);

    return NextResponse.json({
      id: role.id,
      organization_id: role.organization_id,
      role_code: role.role_code,
      role_name: role.role_name,
      description: role.description,
      is_default: role.is_default,
      display_order: role.display_order,
      permission_count: permissionCount || 0,
      staff_count: staffCount || 0,
      created_at: role.created_at,
      updated_at: role.updated_at,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
