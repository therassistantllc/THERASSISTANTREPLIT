/**
 * GET /api/roles/[id]/permissions
 *
 * Get all permissions assigned to a specific role
 * Requires MANAGE_STAFF permission
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requirePermissionInRoute,
  enforceOrganizationInRoute,
  isValidUuid,
} from "@/lib/rbac/middleware";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import { PERMISSIONS } from "@/lib/rbac/constants";

/**
 * GET /api/roles/[id]/permissions
 * Get all permissions assigned to a specific role
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
    // Verify role exists and is in user's org
    const { data: role, error: roleError } = await supabase
      .from("staff_roles")
      .select("id, organization_id")
      .eq("id", id)
      .is("archived_at", null)
      .single();

    if (roleError || !role) {
      return NextResponse.json(
        { error: "Role not found" },
        { status: 404 },
      );
    }

    // Enforce org isolation
    const orgError = enforceOrganizationInRoute(
      role.organization_id,
      organizationId,
    );
    if (orgError) return orgError;

    // Fetch permissions linked to this role
    const { data: rolePermissions, error: permError } = await supabase
      .from("staff_role_permissions")
      .select(
        `
        id,
        staff_permissions!inner(
          permission_code,
          permission_label,
          category,
          description
        )
      `,
      )
      .eq("staff_role_id", id)
      .eq("organization_id", organizationId)
      .order("staff_permissions(permission_label)", { ascending: true });

    if (permError) {
      return NextResponse.json(
        { error: "Failed to retrieve permissions" },
        { status: 500 },
      );
    }

    // Extract and format permissions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const permissions = (rolePermissions || []).map((rp: any) => ({
      role_permission_id: rp.id,
      code: rp.staff_permissions?.permission_code,
      label: rp.staff_permissions?.permission_label,
      category: rp.staff_permissions?.category || "General",
      description: rp.staff_permissions?.description,
    }));

    // Group by category
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byCategory: Record<string, any[]> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    permissions.forEach((perm: any) => {
      const category = perm.category;
      if (!byCategory[category]) {
        byCategory[category] = [];
      }
      byCategory[category].push(perm);
    });

    return NextResponse.json({
      role_id: id,
      organization_id: organizationId,
      permission_count: permissions.length,
      permissions,
      permissions_by_category: byCategory,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
