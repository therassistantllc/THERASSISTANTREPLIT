/**
 * PATCH /api/admin/security/members/[staffId]/role
 *
 * Admin-only: replace a staff member's primary role with the given role.
 * Archives all currently-active role assignments and inserts the new one,
 * then records the change to audit_logs. Refuses to leave the org with no
 * active admin.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requireRoleInRoute,
  parseRequestBody,
  isValidUuid,
} from "@/lib/rbac/middleware";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { STAFF_ROLES } from "@/lib/rbac/constants";

interface UpdateRolePayload {
  role_id: string;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ staffId: string }> },
) {
  const { staffId } = await params;
  if (!isValidUuid(staffId)) {
    return NextResponse.json({ error: "Invalid staff ID" }, { status: 400 });
  }

  const authOrError = await requireRoleInRoute(STAFF_ROLES.ADMIN);
  if (authOrError instanceof NextResponse) return authOrError;
  const { staffId: actorStaffId, organizationId, email: actorEmail, firstName, lastName } =
    authOrError;

  const bodyOrError = await parseRequestBody<UpdateRolePayload>(request);
  if (bodyOrError instanceof NextResponse) return bodyOrError;
  const { role_id: newRoleIdentifier } = bodyOrError;
  if (!newRoleIdentifier || typeof newRoleIdentifier !== "string") {
    return NextResponse.json({ error: "Invalid or missing role_id" }, { status: 400 });
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  // Target staff
  const { data: staff, error: staffError } = await supabase
    .from("staff_profiles")
    .select("id, organization_id, first_name, last_name, email, archived_at")
    .eq("id", staffId)
    .single();
  if (staffError || !staff) {
    return NextResponse.json({ error: "Staff member not found" }, { status: 404 });
  }
  if (staff.organization_id !== organizationId) {
    return NextResponse.json({ error: "Access denied: organization mismatch" }, { status: 403 });
  }
  if (staff.archived_at) {
    return NextResponse.json(
      { error: "Cannot change role of an archived staff member" },
      { status: 400 },
    );
  }

  // New role
  let roleQuery = supabase
    .from("staff_roles")
    .select("id, role_code, role_name, organization_id, archived_at")
    .eq("organization_id", organizationId)
    .is("archived_at", null);
  if (isValidUuid(newRoleIdentifier)) roleQuery = roleQuery.eq("id", newRoleIdentifier);
  else roleQuery = roleQuery.eq("role_code", newRoleIdentifier.toLowerCase());
  const { data: newRole, error: roleError } = await roleQuery.maybeSingle();
  if (roleError || !newRole) {
    return NextResponse.json({ error: "Role not found" }, { status: 404 });
  }
  if (newRole.organization_id !== organizationId || newRole.archived_at) {
    return NextResponse.json({ error: "Role not available in organization" }, { status: 400 });
  }

  // Current active assignments
  const { data: currentAssignments } = await supabase
    .from("staff_role_assignments")
    .select("id, staff_role_id, staff_roles!inner(role_code, role_name)")
    .eq("staff_id", staffId)
    .eq("organization_id", organizationId)
    .is("archived_at", null);
  const current = (currentAssignments ?? []) as unknown as Array<{
    id: string;
    staff_role_id: string;
    staff_roles: { role_code: string; role_name: string } | null;
  }>;

  // No-op if already only this role assigned.
  if (current.length === 1 && current[0].staff_role_id === newRole.id) {
    return NextResponse.json({
      success: true,
      message: "Role unchanged",
      role: { id: newRole.id, code: newRole.role_code, name: newRole.role_name },
    });
  }

  // Last-admin guard: if this staff currently holds the only admin assignment
  // in the org and the new role is not admin, refuse.
  const wasAdmin = current.some((a) => a.staff_roles?.role_code === STAFF_ROLES.ADMIN);
  const willBeAdmin = newRole.role_code === STAFF_ROLES.ADMIN;
  if (wasAdmin && !willBeAdmin) {
    const { data: otherAdmins } = await supabase
      .from("staff_role_assignments")
      .select("staff_id, staff_roles!inner(role_code)")
      .eq("organization_id", organizationId)
      .eq("staff_roles.role_code", STAFF_ROLES.ADMIN)
      .neq("staff_id", staffId)
      .is("archived_at", null);
    if (!otherAdmins || otherAdmins.length === 0) {
      return NextResponse.json(
        {
          error:
            "Cannot remove the last admin from the organization. Assign another admin first.",
        },
        { status: 403 },
      );
    }
  }

  const previousRoles = current
    .map((a) => a.staff_roles?.role_code)
    .filter((code): code is string => !!code);

  // Archive existing assignments.
  if (current.length > 0) {
    const archiveIds = current.map((a) => a.id);
    const { error: archiveError } = await supabase
      .from("staff_role_assignments")
      .update({ archived_at: new Date().toISOString() })
      .in("id", archiveIds);
    if (archiveError) {
      return NextResponse.json(
        { error: `Failed to update role: ${archiveError.message}` },
        { status: 500 },
      );
    }
  }

  // Insert new assignment.
  const { error: insertError } = await supabase
    .from("staff_role_assignments")
    .insert({
      staff_id: staffId,
        staff_role_id: newRole.id,
      organization_id: organizationId,
      assigned_at: new Date().toISOString(),
    });
  if (insertError) {
    return NextResponse.json(
      { error: `Failed to assign new role: ${insertError.message}` },
      { status: 500 },
    );
  }

  // Audit log
  const actorName = [firstName, lastName].filter(Boolean).join(" ") || null;
  const targetName = [staff.first_name, staff.last_name].filter(Boolean).join(" ") || null;
  await supabase.from("audit_logs").insert({
    organization_id: organizationId,
    user_role: STAFF_ROLES.ADMIN,
    action: "staff_role_changed",
    object_type: "staff_profile",
    object_id: staffId,
    event_type: "staff_role_changed",
    event_summary: `Role for ${targetName ?? staff.email ?? staffId} changed to ${newRole.role_name}`,
    before_value: { roles: previousRoles },
    after_value: { roles: [newRole.role_code] },
    event_metadata: {
      actor_staff_id: actorStaffId,
      actor_name: actorName,
      actor_email: actorEmail,
      target_staff_id: staffId,
      target_email: staff.email,
      target_name: targetName,
      new_role_id: newRole.id,
      new_role_code: newRole.role_code,
      new_role_name: newRole.role_name,
      previous_role_codes: previousRoles,
    },
  });

  return NextResponse.json({
    success: true,
    role: { id: newRole.id, code: newRole.role_code, name: newRole.role_name },
  });
}
