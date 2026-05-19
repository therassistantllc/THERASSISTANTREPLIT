/**
 * GET /api/staff
 * POST /api/staff
 *
 * Staff list (with search/filter/pagination) and staff creation
 * Both require MANAGE_STAFF permission
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requirePermissionInRoute,
  parseRequestBody,
} from "@/lib/rbac/middleware";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import { PERMISSIONS } from "@/lib/rbac/constants";
import {
  validateCreateStaffPayload,
  type CreateStaffPayload,
} from "@/lib/rbac/validators";

/**
 * GET /api/staff
 * List all staff in the organization with optional search/filter/pagination
 * Query params:
 *   - search: search by name or email
 *   - role: filter by role_id or role_code
 *   - is_active: filter by active status (true/false)
 *   - provider_linked: filter by provider linkage (true/false)
 *   - page: pagination (default 1)
 *   - per_page: items per page (default 20, max 100)
 */
export async function GET(request: NextRequest) {
  // Require MANAGE_STAFF permission
  const authOrError = await requirePermissionInRoute(PERMISSIONS.MANAGE_STAFF);
  if (authOrError instanceof NextResponse) return authOrError;

  const { organizationId } = authOrError;

  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  // Parse query params
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim().toLowerCase() || "";
  const roleFilter = url.searchParams.get("role") || null;
  const isActiveFilter = url.searchParams.get("is_active") || null;
  const providerLinkedFilter = url.searchParams.get("provider_linked") || null;
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get("per_page") || "20")));
  const offset = (page - 1) * perPage;

  try {
    // Build base query for staff
    let query = supabase
      .from("staff_profiles")
      .select("*", { count: "exact" })
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("first_name", { ascending: true });

    // Apply search filter (name or email)
    if (search) {
      query = query.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`,
      );
    }

    // Apply is_active filter
    if (isActiveFilter !== null) {
      const isActive = isActiveFilter === "true";
      query = query.eq("is_active", isActive);
    }

    // Get total count before pagination
    const { count: totalCount } = await supabase
      .from("staff_profiles")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .or(
        search
          ? `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`
          : "true",
      )
      .then((result) => result);

    // Apply pagination
    query = query.range(offset, offset + perPage - 1);

    const { data: staffList, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: "Failed to retrieve staff list" },
        { status: 500 },
      );
    }

    // If role filter is provided, fetch roles and filter
    let filteredStaff = staffList || [];
    if (roleFilter) {
      const staffWithRoles = await Promise.all(
        filteredStaff.map(async (staff) => {
          const { data: roleAssignments } = await supabase
            .from("staff_role_assignments")
            .select("staff_roles!inner(id, role_code)")
            .eq("staff_id", staff.id)
            .eq("organization_id", organizationId)
            .is("archived_at", null);

          const roles = (roleAssignments || []).map(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (a: any) => a.staff_roles,
          );
          return {
            staff,
            roles,
          };
        }),
      );

      filteredStaff = staffWithRoles
        .filter(({ roles }) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          roles.some((r: any) => r.id === roleFilter || r.role_code === roleFilter),
        )
        .map(({ staff }) => staff);
    }

    // If provider_linked filter is provided, filter by provider profile existence
    if (providerLinkedFilter !== null) {
      const hasProvider = providerLinkedFilter === "true";
      const staffIds = filteredStaff.map((s) => s.id);

      if (staffIds.length > 0) {
        const { data: providerProfiles } = await supabase
          .from("provider_profiles")
          .select("staff_id")
          .in("staff_id", staffIds)
          .is("archived_at", null);

        const providerStaffIds = new Set(
          (providerProfiles || []).map((p) => p.staff_id),
        );

        filteredStaff = filteredStaff.filter((staff) =>
          hasProvider
            ? providerStaffIds.has(staff.id)
            : !providerStaffIds.has(staff.id),
        );
      } else if (hasProvider) {
        filteredStaff = [];
      }
    }

    // Fetch roles and permissions summary for each staff
    const staffWithRolesSummary = await Promise.all(
      filteredStaff.map(async (staff) => {
        const { data: roleAssignments } = await supabase
          .from("staff_role_assignments")
          .select("staff_roles!inner(id, role_code, role_name)")
          .eq("staff_id", staff.id)
          .eq("organization_id", organizationId)
          .is("archived_at", null);

        const roles = (roleAssignments || [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((a: any) => a.staff_roles)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((r: any) => !!r);

        return {
          id: staff.id,
          organization_id: staff.organization_id,
          first_name: staff.first_name,
          last_name: staff.last_name,
          email: staff.email,
          phone: staff.phone,
          job_title: staff.job_title,
          provider_npi: staff.provider_npi,
          is_active: staff.is_active,
          created_at: staff.created_at,
          updated_at: staff.updated_at,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          roles: roles.map((r: any) => ({
            id: r.id,
            code: r.role_code,
            name: r.role_name,
          })),
          role_count: roles.length,
        };
      }),
    );

    return NextResponse.json({
      data: staffWithRolesSummary,
      pagination: {
        page,
        per_page: perPage,
        total: totalCount || 0,
        total_pages: Math.ceil((totalCount || 0) / perPage),
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/staff
 * Create a new staff member (requires MANAGE_STAFF permission)
 */
export async function POST(request: NextRequest) {
  // Require MANAGE_STAFF permission
  const authOrError = await requirePermissionInRoute(PERMISSIONS.MANAGE_STAFF);
  if (authOrError instanceof NextResponse) return authOrError;

  const { organizationId } = authOrError;

  // Parse request body
  const bodyOrError = await parseRequestBody<CreateStaffPayload>(request);
  if (bodyOrError instanceof NextResponse) return bodyOrError;

  const payload = bodyOrError;

  // Validate payload
  const validation = await validateCreateStaffPayload(payload, organizationId);
  if (!validation.valid) {
    return NextResponse.json(
      { error: validation.error },
      { status: 400 },
    );
  }

  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  try {
    // Create staff profile
    const { data: newStaff, error: insertError } = await supabase
      .from("staff_profiles")
      .insert({
        organization_id: organizationId,
        first_name: payload.first_name.trim(),
        last_name: payload.last_name.trim(),
        email: payload.email.toLowerCase().trim(),
        phone: payload.phone?.trim() || null,
        job_title: payload.job_title?.trim() || null,
        provider_npi: payload.provider_npi?.trim() || null,
        is_active: payload.is_active !== false,
        staff_status: "active",
      })
      .select("*")
      .single();

    if (insertError || !newStaff) {
      return NextResponse.json(
        {
          error: "Failed to create staff member",
          details: insertError?.message || "Unknown error",
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        id: newStaff.id,
        organization_id: newStaff.organization_id,
        first_name: newStaff.first_name,
        last_name: newStaff.last_name,
        email: newStaff.email,
        phone: newStaff.phone,
        job_title: newStaff.job_title,
        provider_npi: newStaff.provider_npi,
        is_active: newStaff.is_active,
        created_at: newStaff.created_at,
        roles: [],
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
