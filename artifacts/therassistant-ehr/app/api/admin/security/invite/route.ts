/**
 * POST /api/admin/security/invite
 *
 * Admin-only: invite a brand-new staff member into the organization.
 *
 *   1. Send a Supabase Auth invitation email (`auth.admin.inviteUserByEmail`)
 *   2. Create the matching `staff_profiles` row linked to the new auth user
 *   3. Create the initial `staff_role_assignments` row for the chosen role
 *   4. Record the invitation in `audit_logs`
 *
 * Supabase JS has no real transactions, so if step (2) or (3) fails we attempt
 * to roll back what was created (delete the staff row, delete the auth user)
 * so a half-created invite doesn't get stuck.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requireRoleInRoute,
  parseRequestBody,
  isValidUuid,
} from "@/lib/rbac/middleware";
import {
  createServerSupabaseAdminClient,
  createServerSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { STAFF_ROLES } from "@/lib/rbac/constants";
import { isValidEmail, isEmailUniqueInOrg } from "@/lib/rbac/validators";

interface InviteStaffPayload {
  first_name: string;
  last_name: string;
  email: string;
  role_id: string;
}

export async function POST(request: NextRequest) {
  const authOrError = await requireRoleInRoute(STAFF_ROLES.ADMIN);
  if (authOrError instanceof NextResponse) return authOrError;
  const {
    staffId: actorStaffId,
    organizationId,
    email: actorEmail,
    firstName: actorFirst,
    lastName: actorLast,
  } = authOrError;

  const bodyOrError = await parseRequestBody<InviteStaffPayload>(request);
  if (bodyOrError instanceof NextResponse) return bodyOrError;
  const payload = bodyOrError;

  const firstName = payload.first_name?.trim() ?? "";
  const lastName = payload.last_name?.trim() ?? "";
  const email = payload.email?.trim().toLowerCase() ?? "";
  const roleId = payload.role_id?.trim() ?? "";

  if (!firstName) {
    return NextResponse.json({ error: "First name is required" }, { status: 400 });
  }
  if (!lastName) {
    return NextResponse.json({ error: "Last name is required" }, { status: 400 });
  }
  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
  }
  if (!roleId) {
    return NextResponse.json(
      { error: "A valid starting role is required" },
      { status: 400 },
    );
  }

  const supabase = createServerSupabaseAdminClient();
  const serviceRole = createServerSupabaseServiceRoleClient();
  if (!supabase || !serviceRole) {
    return NextResponse.json(
      { error: "Service role key is required to invite a staff member." },
      { status: 503 },
    );
  }

  // Resolve role by UUID or role_code within the org.
  let roleQuery = supabase
    .from("staff_roles")
    .select("id, role_code, role_name, organization_id, archived_at")
    .eq("organization_id", organizationId)
    .is("archived_at", null);
  if (isValidUuid(roleId)) roleQuery = roleQuery.eq("id", roleId);
  else roleQuery = roleQuery.eq("role_code", roleId.toLowerCase());
  const { data: role, error: roleError } = await roleQuery.maybeSingle();
  if (roleError || !role) {
    return NextResponse.json({ error: "Role not found" }, { status: 404 });
  }
  if (role.organization_id !== organizationId || role.archived_at) {
    return NextResponse.json(
      { error: "Role not available in organization" },
      { status: 400 },
    );
  }

  // Email must be unique within the organization (matches existing create flow).
  const emailUnique = await isEmailUniqueInOrg(email, organizationId);
  if (!emailUnique) {
    return NextResponse.json(
      { error: "A staff member with that email already exists in this organization" },
      { status: 409 },
    );
  }

  // 1. Send the Supabase Auth invitation. This both creates an auth user and
  //    emails them an invitation link (when Supabase SMTP is configured).
  const redirectBase = (
    process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim() || ""
  ).replace(/\/$/, "");
  const redirectTo = redirectBase ? `${redirectBase}/auth/reset-password` : undefined;

  const { data: inviteResult, error: inviteError } =
    await serviceRole.auth.admin.inviteUserByEmail(email, {
      data: {
        first_name: firstName,
        last_name: lastName,
        organization_id: organizationId,
      },
      ...(redirectTo ? { redirectTo } : {}),
    });

  if (inviteError || !inviteResult?.user) {
    return NextResponse.json(
      {
        error: `Failed to send invitation: ${inviteError?.message ?? "unknown error"}`,
      },
      { status: 502 },
    );
  }

  const newAuthUserId = inviteResult.user.id;

  // 2. Create the staff profile linked to the new auth user.
  const { data: newStaff, error: staffInsertError } = await supabase
    .from("staff_profiles")
    .insert({
      organization_id: organizationId,
      first_name: firstName,
      last_name: lastName,
      email,
      is_active: true,
      staff_status: "active",
      auth_user_id: newAuthUserId,
    })
    .select("id, first_name, last_name, email")
    .single();

  if (staffInsertError || !newStaff) {
    // Roll back the auth user so the admin can retry cleanly.
    await serviceRole.auth.admin.deleteUser(newAuthUserId).catch(() => {});
    return NextResponse.json(
      {
        error: `Failed to create staff profile: ${
          staffInsertError?.message ?? "unknown error"
        }`,
      },
      { status: 500 },
    );
  }

  // 3. Assign the starting role.
  const { error: assignError } = await supabase
    .from("staff_role_assignments")
    .insert({
      staff_id: newStaff.id,
      staff_role_id: role.id,
      organization_id: organizationId,
      assigned_at: new Date().toISOString(),
    });

  if (assignError) {
    // Best-effort rollback: remove the staff profile and auth user.
    await supabase.from("staff_profiles").delete().eq("id", newStaff.id);
    await serviceRole.auth.admin.deleteUser(newAuthUserId).catch(() => {});
    return NextResponse.json(
      { error: `Failed to assign starting role: ${assignError.message}` },
      { status: 500 },
    );
  }

  // 4. Audit log.
  const actorName = [actorFirst, actorLast].filter(Boolean).join(" ") || null;
  const targetName = [firstName, lastName].filter(Boolean).join(" ") || null;
  await supabase.from("audit_logs").insert({
    organization_id: organizationId,
    user_role: STAFF_ROLES.ADMIN,
    action: "staff_invited",
    object_type: "staff_profile",
    object_id: newStaff.id,
    event_type: "staff_invited",
    event_summary: `Invited ${targetName ?? email} as ${role.role_name}`,
    event_metadata: {
      actor_staff_id: actorStaffId,
      actor_name: actorName,
      actor_email: actorEmail,
      target_staff_id: newStaff.id,
      target_email: email,
      target_name: targetName,
      target_auth_user_id: newAuthUserId,
      starting_role_id: role.id,
      starting_role_code: role.role_code,
      starting_role_name: role.role_name,
    },
  });

  return NextResponse.json(
    {
      success: true,
      message: `Invitation sent to ${email}.`,
      staff: {
        id: newStaff.id,
        firstName: newStaff.first_name,
        lastName: newStaff.last_name,
        email: newStaff.email,
        authUserId: newAuthUserId,
        role: { id: role.id, code: role.role_code, name: role.role_name },
      },
    },
    { status: 201 },
  );
}
