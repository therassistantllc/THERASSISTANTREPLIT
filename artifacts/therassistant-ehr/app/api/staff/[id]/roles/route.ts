/**
 * GET /api/staff/[id]/roles
 * POST /api/staff/[id]/roles
 *
 * Get staff roles and assign new roles
 * Both require MANAGE_STAFF or MANAGE_ROLES permission
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requirePermissionInRoute,
  enforceOrganizationInRoute,
  parseRequestBody,
  isValidUuid,
} from "@/lib/rbac/middleware";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { PERMISSIONS } from "@/lib/rbac/constants";
import {
  roleExistsInOrg,
  staffHasRoleAssignment,
} from "@/lib/rbac/validators";

type StaffRoleAssignmentWithRole = {
  id: string;
  staff_role_id: string;
  assigned_at: string | null;
  effective_at: string | null;
  expires_at: string | null;
  staff_roles: {
    id: string;
    role_code: string;
    role_name: string;
    description: string | null;
  } | null;
};

/**
 * GET /api/staff/[id]/roles
 * Get all active role assignments for a staff member
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

  const supabase = createServerSupabaseAdminClient();
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

    // Fetch role assignments
    const { data: roleAssignments, error: rolesError } = await supabase
      .from("staff_role_assignments")
      .select(
        `
        id,
        staff_role_id,
        assigned_at,
        effective_at,
        expires_at,
        staff_roles!inner(
          id,
          role_code,
          role_name,
          description
        )
      `,
      )
      .eq("staff_id", id)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("assigned_at", { ascending: false });

    if (rolesError) {
      return NextResponse.json(
        { error: "Failed to retrieve roles" },
        { status: 500 },
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles = (roleAssignments || []).map((assignment: any) => ({
      assignment_id: assignment.id,
      role: {
        id: assignment.staff_roles.id,
        code: assignment.staff_roles.role_code,
        name: assignment.staff_roles.role_name,
        description: assignment.staff_roles.description,
      },
      assigned_at: assignment.assigned_at,
      effective_at: assignment.effective_at,
      expires_at: assignment.expires_at,
    }));

    return NextResponse.json({ staff_id: id, roles });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

interface AssignRolePayload {
  role_id: string;
  effective_at?: string;
  expires_at?: string;
}

async function resolveRoleIdInOrg(roleIdentifier: string, organizationId: string): Promise<string | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return null;
  let query = supabase
    .from("staff_roles")
    .select("id")
    .eq("organization_id", organizationId)
    .is("archived_at", null);
  if (isValidUuid(roleIdentifier)) query = query.eq("id", roleIdentifier);
  else query = query.eq("role_code", roleIdentifier.toLowerCase());
  const { data } = await query.maybeSingle();
  return data?.id ? String(data.id) : null;
}

/**
 * POST /api/staff/[id]/roles
 * Assign a role to a staff member
 * Prevents duplicate active role assignments
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Validate UUID format
  if (!isValidUuid(id)) {
    return NextResponse.json({ error: "Invalid staff ID" }, { status: 400 });
  }

  // Require MANAGE_STAFF or MANAGE_ROLES
  const authOrError = await requirePermissionInRoute(PERMISSIONS.MANAGE_STAFF);
  if (authOrError instanceof NextResponse) return authOrError;

  const { organizationId } = authOrError;

  // Parse request body
  const bodyOrError = await parseRequestBody<AssignRolePayload>(request);
  if (bodyOrError instanceof NextResponse) return bodyOrError;

  const payload = bodyOrError;

  // Validate/resolve role identifier (UUID or role code)
  if (!payload.role_id) {
    return NextResponse.json(
      { error: "Invalid or missing role_id" },
      { status: 400 },
    );
  }

  const resolvedRoleId = await resolveRoleIdInOrg(payload.role_id, organizationId);
  if (!resolvedRoleId) {
    return NextResponse.json({ error: "Role not found in organization" }, { status: 400 });
  }

  const supabase = createServerSupabaseAdminClient();
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

    // Verify role exists in org
    const roleExists = await roleExistsInOrg(resolvedRoleId, organizationId);
    if (!roleExists) {
      return NextResponse.json({ error: "Role not found in organization" }, { status: 400 });
    }

    // Check if staff already has this role assigned (active)
    const alreadyAssigned = await staffHasRoleAssignment(
      id,
      resolvedRoleId,
      organizationId,
    );
    if (alreadyAssigned) {
      return NextResponse.json(
        { error: "Staff member already has this role assigned" },
        { status: 400 },
      );
    }

    // Create role assignment
    const { data: newAssignment, error: insertError } = await supabase
      .from("staff_role_assignments")
      .insert({
        staff_id: id,
        staff_role_id: resolvedRoleId,
        organization_id: organizationId,
        assigned_at: new Date().toISOString(),
        effective_at: payload.effective_at || null,
        expires_at: payload.expires_at || null,
      })
      .select(
        `
        id,
        staff_role_id,
        assigned_at,
        effective_at,
        expires_at,
        staff_roles!inner(
          id,
          role_code,
          role_name,
          description
        )
      `,
      )
      .single();

    const assignment = newAssignment as unknown as StaffRoleAssignmentWithRole | null;

    if (insertError || !assignment) {
      return NextResponse.json(
        { error: "Failed to assign role" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        assignment_id: assignment.id,
        staff_id: id,
        role: {
          id: assignment.staff_roles!.id,
          code: assignment.staff_roles!.role_code,
          name: assignment.staff_roles!.role_name,
          description: assignment.staff_roles!.description,
        },
        assigned_at: assignment.assigned_at,
        effective_at: assignment.effective_at,
        expires_at: assignment.expires_at,
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
