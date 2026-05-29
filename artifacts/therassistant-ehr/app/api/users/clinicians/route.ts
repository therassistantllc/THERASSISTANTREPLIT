import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

type DbRow = Record<string, unknown>;

function text(value: unknown) {
  return String(value ?? "").trim();
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const guard = await requireOrgAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { data: rolesData, error: rolesError } = await supabase
      .from("staff_roles")
      .select("id, role_code")
      .eq("organization_id", organizationId)
      .in("role_code", ["clinician", "practice_owner"])
      .is("archived_at", null);
    if (rolesError) throw rolesError;

    const roleIds = ((rolesData ?? []) as DbRow[]).map((r) => text(r.id)).filter(Boolean);
    if (roleIds.length === 0) {
      return NextResponse.json({ success: true, organizationId, clinicians: [] as unknown[] });
    }

    const { data: assignmentsData, error: assignmentsError } = await supabase
      .from("staff_role_assignments")
      .select("staff_id")
      .eq("organization_id", organizationId)
      .in("staff_role_id", roleIds)
      .is("archived_at", null);
    if (assignmentsError) throw assignmentsError;

    const staffIds = [...new Set(((assignmentsData ?? []) as DbRow[]).map((r) => text(r.staff_id)).filter(Boolean))];
    if (staffIds.length === 0) {
      return NextResponse.json({ success: true, organizationId, clinicians: [] as unknown[] });
    }

    const { data: staffData, error: staffError } = await supabase
      .from("staff_profiles")
      .select("id, auth_user_id, first_name, last_name, email")
      .eq("organization_id", organizationId)
      .in("id", staffIds)
      .eq("is_active", true)
      .is("archived_at", null)
      .order("first_name", { ascending: true });
    if (staffError) throw staffError;

    const authUserIds = ((staffData ?? []) as DbRow[])
      .map((row) => text(row.auth_user_id))
      .filter(Boolean);

    if (authUserIds.length === 0) {
      return NextResponse.json({ success: true, organizationId, clinicians: [] as unknown[] });
    }

    const { data: providerData, error: providerError } = await supabase
      .from("providers")
      .select("id, user_id, first_name, last_name, display_name, email")
      .eq("organization_id", organizationId)
      .in("user_id", authUserIds)
      .eq("is_active", true)
      .is("archived_at", null);
    if (providerError) throw providerError;

    const providerByUserId = new Map<string, DbRow>();
    for (const row of (providerData ?? []) as DbRow[]) {
      const userId = text(row.user_id);
      if (userId) providerByUserId.set(userId, row);
    }

    const clinicians = ((staffData ?? []) as DbRow[])
      .map((row) => {
        const userId = text(row.auth_user_id);
        if (!userId) return null;
        const provider = providerByUserId.get(userId) ?? null;
        if (!provider) return null;
        const providerId = text(provider.id);
        if (!providerId) return null;
        const displayName =
          text(provider.display_name) ||
          [text(provider.first_name), text(provider.last_name)].filter(Boolean).join(" ") ||
          [text(row.first_name), text(row.last_name)].filter(Boolean).join(" ") ||
          text(provider.email) ||
          text(row.email) ||
          userId;
        return {
          providerId,
          staffId: text(row.id),
          userId,
          displayName,
          email: text(row.email) || null,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return NextResponse.json({ success: true, organizationId, clinicians });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load clinicians" },
      { status: 500 },
    );
  }
}
