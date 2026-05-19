/**
 * GET /api/staff/[id]
 * PUT /api/staff/[id]
 *
 * Example protected staff CRUD endpoints
 * Demonstrates permission enforcement and tenant isolation
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requirePermissionInRoute,
  enforceOrganizationInRoute,
  parseRequestBody,
  isValidUuid,
} from "@/lib/rbac/middleware";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import { PERMISSIONS } from "@/lib/rbac/constants";

interface StaffUpdatePayload {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  job_title?: string;
  is_active?: boolean;
}

/**
 * GET /api/staff/[id]
 * Retrieve staff profile (requires MANAGE_STAFF permission)
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

  // Fetch staff profile with tenant isolation check
  const { data: staff, error } = await supabase
    .from("staff_profiles")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (error || !staff) {
    return NextResponse.json(
      { error: "Staff member not found or access denied" },
      { status: 404 },
    );
  }

  return NextResponse.json(staff);
}

/**
 * PUT /api/staff/[id]
 * Update staff profile (requires MANAGE_STAFF permission)
 */
export async function PUT(
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

  // Parse request body
  const bodyOrError = await parseRequestBody<StaffUpdatePayload>(request);
  if (bodyOrError instanceof NextResponse) return bodyOrError;

  const updates = bodyOrError;

  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  // Verify staff exists and belongs to organization (tenant isolation)
  const { data: existingStaff, error: fetchError } = await supabase
    .from("staff_profiles")
    .select("organization_id")
    .eq("id", id)
    .single();

  if (fetchError || !existingStaff) {
    return NextResponse.json(
      { error: "Staff member not found" },
      { status: 404 },
    );
  }

  // Enforce tenant isolation
  const orgError = enforceOrganizationInRoute(existingStaff.organization_id, organizationId);
  if (orgError) return orgError;

  // Perform update with timestamp
  const { data: updated, error: updateError } = await supabase
    .from("staff_profiles")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: "Failed to update staff member" },
      { status: 500 },
    );
  }

  return NextResponse.json(updated);
}

/**
 * DELETE /api/staff/[id]
 * Soft-delete staff profile (archive, requires MANAGE_STAFF permission)
 */
export async function DELETE(
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

  // Verify staff exists and belongs to organization
  const { data: existingStaff, error: fetchError } = await supabase
    .from("staff_profiles")
    .select("organization_id")
    .eq("id", id)
    .single();

  if (fetchError || !existingStaff) {
    return NextResponse.json(
      { error: "Staff member not found" },
      { status: 404 },
    );
  }

  // Enforce tenant isolation
  const orgError = enforceOrganizationInRoute(existingStaff.organization_id, organizationId);
  if (orgError) return orgError;

  // Soft-delete (archive)
  const { data: updated, error: updateError } = await supabase
    .from("staff_profiles")
    .update({
      archived_at: new Date().toISOString(),
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: "Failed to archive staff member" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    message: "Staff member archived successfully",
    archived_at: updated.archived_at,
  });
}
