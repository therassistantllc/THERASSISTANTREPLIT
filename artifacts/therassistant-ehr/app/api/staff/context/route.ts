/**
 * API route to get current staff's context (roles and permissions)
 * Called by client-side StaffContextProvider
 */

import { NextRequest, NextResponse } from "next/server";
import { getStaffContext } from "@/lib/rbac/server";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";

export async function GET(_request: NextRequest) {
  try {
    const supabase = createServerSupabaseAdminClientTyped();

    if (!supabase) {
      return NextResponse.json(
        { error: "Server misconfiguration" },
        { status: 500 },
      );
    }

    // Get auth session to extract org_id from JWT or request context
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // In a real implementation, org_id would come from:
    // 1. User's session/JWT claims
    // 2. Request headers
    // 3. Query parameters
    // For now, we'll try to get it from user metadata or a custom claims
    const organizationId = (user.user_metadata?.organization_id as string) || null;
    const staffId = (user.user_metadata?.staff_id as string) || null;

    if (!organizationId || !staffId) {
      return NextResponse.json(
        { error: "Organization or staff ID not found in session" },
        { status: 400 },
      );
    }

    // Get staff context
    const context = await getStaffContext(organizationId, staffId);

    if (!context) {
      return NextResponse.json({ error: "Staff context not found" }, { status: 404 });
    }

    return NextResponse.json({
      staffId: context.staffId,
      organizationId: context.organizationId,
      firstName: context.firstName,
      lastName: context.lastName,
      email: context.email,
      jobTitle: context.jobTitle,
      providerNpi: context.providerNpi,
      roles: context.roles,
      permissions: context.permissions,
    });
  } catch (error) {
    console.error("Error fetching staff context:", error);
    return NextResponse.json(
      { error: "Failed to fetch staff context" },
      { status: 500 },
    );
  }
}
