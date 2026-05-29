/**
 * GET /api/admin/security/members
 *
 * Admin-only: list active staff members in the org with their current roles,
 * plus the list of available roles for the role dropdown.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireRoleInRoute } from "@/lib/rbac/middleware";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { STAFF_ROLES } from "@/lib/rbac/constants";

const SUPERVISION_KEY = "security.supervision.rules";

type RoleAssignmentJoin = {
  staff_id: string;
  staff_roles: { id: string; role_code: string; role_name: string } | null;
};

export async function GET(_request: NextRequest) {
  const authOrError = await requireRoleInRoute(STAFF_ROLES.ADMIN);
  if (authOrError instanceof NextResponse) return authOrError;

  const { organizationId } = authOrError;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  const { data: staffRows, error: staffError } = await supabase
    .from("staff_profiles")
    .select("id, first_name, last_name, email, job_title, is_active, auth_user_id")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("first_name", { ascending: true });

  if (staffError) {
    return NextResponse.json(
      { error: `Failed to load staff: ${staffError.message}` },
      { status: 500 },
    );
  }

  const staffIds = (staffRows ?? []).map((s) => s.id);
  const authUserIds = (staffRows ?? [])
    .map((s) => s.auth_user_id)
    .filter((v): v is string => Boolean(v));

  const assignmentsByStaff = new Map<
    string,
    Array<{ id: string; code: string; name: string }>
  >();
  if (staffIds.length > 0) {
    const { data: assignments } = await supabase
      .from("staff_role_assignments")
      .select("staff_id, staff_roles!inner(id, role_code, role_name)")
      .in("staff_id", staffIds)
      .eq("organization_id", organizationId)
      .is("archived_at", null);
    for (const row of (assignments ?? []) as unknown as RoleAssignmentJoin[]) {
      if (!row.staff_roles) continue;
      const list = assignmentsByStaff.get(row.staff_id) ?? [];
      list.push({
        id: row.staff_roles.id,
        code: row.staff_roles.role_code,
        name: row.staff_roles.role_name,
      });
      assignmentsByStaff.set(row.staff_id, list);
    }
  }

  const { data: roleRows } = await supabase
    .from("staff_roles")
    .select("id, role_code, role_name")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("display_order", { ascending: true })
    .order("role_name", { ascending: true });

  const roles = (roleRows ?? []).map((r) => ({
    id: r.id,
    code: r.role_code,
    name: r.role_name,
  }));

  // Provider roster (for supervisor assignment), plus a map auth_user_id -> provider
  const { data: providerRows } = await supabase
    .from("providers")
    .select("id, user_id, first_name, last_name, display_name, npi, credential, is_active")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .eq("is_active", true)
    .order("display_name", { ascending: true });

  const providers = (providerRows ?? []).map((p) => {
    const first = String(p.first_name ?? "").trim();
    const last = String(p.last_name ?? "").trim();
    const display = String(p.display_name ?? "").trim() || [first, last].filter(Boolean).join(" ");
    return {
      id: String(p.id),
      userId: p.user_id ? String(p.user_id) : null,
      npi: p.npi ? String(p.npi) : null,
      name: display || "Unnamed provider",
      credential: p.credential ? String(p.credential) : null,
    };
  });

  const providerByAuthUserId = new Map<string, { id: string; npi: string | null; name: string }>();
  for (const p of providers) {
    if (p.userId) providerByAuthUserId.set(p.userId, { id: p.id, npi: p.npi, name: p.name });
  }

  const { data: payerRows } = await supabase
    .from("payer_profiles")
    .select("id, payer_name")
    .eq("organization_id", organizationId)
    .is("is_active", true)
    .order("payer_name", { ascending: true });

  const payerProfiles = (payerRows ?? []).map((p) => ({
    id: String(p.id),
    payerName: String(p.payer_name ?? "").trim() || "Unnamed payer",
  }));

  // Load per-staff supervision rules from organization_settings JSON.
  // Shape:
  // {
  //   [staffId]: {
  //     enabled: boolean,
  //     supervisorProviderId: string | null,
  //     applyToAllPayers: boolean,
  //     payerProfileIds: string[]
  //   }
  // }
  let supervisionRules: Record<
    string,
    {
      enabled: boolean;
      supervisorProviderId: string | null;
      applyToAllPayers: boolean;
      payerProfileIds: string[];
    }
  > = {};
  try {
    const { data: settingsRow } = await (supabase as unknown as { from: (table: string) => any })
      .from("organization_settings")
      .select("setting_value")
      .eq("organization_id", organizationId)
      .eq("setting_key", SUPERVISION_KEY)
      .maybeSingle();
    const raw = (settingsRow?.setting_value ?? null) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const parsed = raw as Record<string, unknown>;
      for (const [staffId, v] of Object.entries(parsed)) {
        const row = (v ?? {}) as Record<string, unknown>;
        supervisionRules[staffId] = {
          enabled: Boolean(row.enabled),
          supervisorProviderId:
            typeof row.supervisorProviderId === "string" && row.supervisorProviderId.trim()
              ? row.supervisorProviderId.trim()
              : null,
          applyToAllPayers: row.applyToAllPayers !== false,
          payerProfileIds: Array.isArray(row.payerProfileIds)
            ? row.payerProfileIds.map((x) => String(x)).filter(Boolean)
            : [],
        };
      }
    }
  } catch {
    supervisionRules = {};
  }

  const members = (staffRows ?? []).map((s) => {
    const memberRoles = assignmentsByStaff.get(s.id) ?? [];
    const authUserId = s.auth_user_id ? String(s.auth_user_id) : null;
    const provider = authUserId ? providerByAuthUserId.get(authUserId) ?? null : null;
    const supervision = supervisionRules[s.id] ?? {
      enabled: false,
      supervisorProviderId: null,
      applyToAllPayers: true,
      payerProfileIds: [] as string[],
    };
    return {
      id: s.id,
      authUserId,
      firstName: s.first_name,
      lastName: s.last_name,
      email: s.email,
      jobTitle: s.job_title,
      isActive: s.is_active,
      roles: memberRoles,
      primaryRoleId: memberRoles[0]?.id ?? null,
      providerId: provider?.id ?? null,
      providerNpi: provider?.npi ?? null,
      providerName: provider?.name ?? null,
      supervision,
    };
  });

  return NextResponse.json({ success: true, organizationId, members, roles, providers, payerProfiles });
}
