/**
 * GET /api/staff/[id]/permissions
 *
 * Get all effective permissions for a staff member
 * Combines permissions from all assigned roles
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
import { getEffectivePermissions } from "@/lib/rbac/auth";

/**
 * GET /api/staff/[id]/permissions
 * Get all effective permissions for a staff member across all roles
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Validate UUID format
  if (!isValidUuid(id)) {
    return NextResponse.json({ error: "Invalid staff ID" }, { status: 400 });
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
    // Verify staff exists and is in same org
    const { data: staff, error: staffError } = await supabase
      .from("staff_profiles")
      .select("organization_id")
      .eq("id", id)
      .single();

    if (staffError || !staff) {
      return NextResponse.json(
        { error: "Staff member not found" },
        { status: 404 },
      );
    }

    // Enforce org isolation
    const orgError = enforceOrganizationInRoute(
      staff.organization_id,
      organizationId,
    );
    if (orgError) return orgError;

    // Get effective permissions using auth helper
    const permissions = await getEffectivePermissions(id, organizationId);

    // Fetch permission details (labels, categories)
    const { data: permissionDetails, error: permError } = await supabase
      .from("staff_permissions")
      .select("permission_code, permission_label, category, description")
      .in("permission_code", permissions);

    if (permError) {
      return NextResponse.json(
        { error: "Failed to retrieve permission details" },
        { status: 500 },
      );
    }

    // Group permissions by category
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byCategory: Record<string, any[]> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (permissionDetails || []).forEach((perm: any) => {
      const category = perm.category || "General";
      if (!byCategory[category]) {
        byCategory[category] = [];
      }
      byCategory[category].push({
        code: perm.permission_code,
        label: perm.permission_label,
        description: perm.description,
      });
    });

    return NextResponse.json({
      staff_id: id,
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
