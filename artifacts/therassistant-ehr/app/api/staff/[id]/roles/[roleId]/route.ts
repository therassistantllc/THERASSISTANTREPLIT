/**
 * DELETE /api/staff/[id]/roles/[roleId]
 *
 * Remove/deactivate a role assignment from a staff member
 * Requires MANAGE_STAFF or MANAGE_ROLES permission
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requirePermissionInRoute,
  enforceOrganizationInRoute,
  isValidUuid,
} from "@/lib/rbac/middleware";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import { PERMISSIONS } from "@/lib/rbac/constants";
import { isLastActiveAdmin } from "@/lib/rbac/validators";

/**
 * DELETE /api/staff/[id]/roles/[roleId]
 * Remove a role assignment (soft delete by archiving)
 * Prevents removing the last admin role in an organization
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; roleId: string }> },
) {
  const { id, roleId } = await params;

  // Validate UUID formats
  if (!isValidUuid(id) || !isValidUuid(roleId)) {
    return NextResponse.json(
      { error: "Invalid staff ID or role ID" },
      { status: 400 },
    );
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

    // Fetch the role assignment to verify it exists
    const { data: assignment, error: assignmentError } = await supabase
      .from("staff_role_assignments")
      .select("id, staff_role_id, staff_roles!inner(role_code)")
      .eq("id", roleId)
      .eq("staff_id", id)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .single();

    if (assignmentError || !assignment) {
      return NextResponse.json(
        { error: "Role assignment not found" },
        { status: 404 },
      );
    }

    // Check if this is the last admin role - prevent removal
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roleCode = (assignment as any).staff_roles?.role_code;
    if (roleCode === "admin") {
      const isLast = await isLastActiveAdmin(id, organizationId);
      if (isLast) {
        return NextResponse.json(
          {
            error:
              "Cannot remove the last admin role from the organization. Assign another admin first.",
          },
          { status: 403 },
        );
      }
    }

    // Soft delete (archive) the role assignment
    const { error: deleteError } = await supabase
      .from("staff_role_assignments")
      .update({
        archived_at: new Date().toISOString(),
      })
      .eq("id", roleId)
      .eq("staff_id", id)
      .eq("organization_id", organizationId);

    if (deleteError) {
      return NextResponse.json(
        { error: "Failed to remove role assignment" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      message: "Role assignment removed successfully",
      assignment_id: roleId,
      staff_id: id,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
