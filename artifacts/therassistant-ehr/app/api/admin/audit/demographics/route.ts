import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";
import { requireAuthenticatedStaff, hasPermission } from "@/lib/rbac/auth";
import { PERMISSIONS } from "@/lib/rbac/constants";

function extractMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Failed to load audit log.";
}

type Resolution =
  | { ok: true; organizationId: string; staffId: string | null }
  | { ok: false; status: number; error: string };

async function resolveStaff(): Promise<Resolution> {
  const staff = await requireAuthenticatedStaff();
  if (staff) {
    const allowed = await hasPermission(
      staff.staffId,
      staff.organizationId,
      PERMISSIONS.VIEW_AUDIT_LOGS,
    );
    if (!allowed) {
      return { ok: false, status: 403, error: "You do not have permission to view audit logs." };
    }
    return { ok: true, organizationId: staff.organizationId, staffId: staff.staffId };
  }
  if (process.env.NODE_ENV === "production") {
    return { ok: false, status: 401, error: "Authentication required" };
  }
  return { ok: true, organizationId: DEFAULT_ORG_ID, staffId: null };
}

type AuditRow = {
  id: string;
  created_at: string;
  user_id: string | null;
  user_role: string | null;
  object_id: string | null;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
  event_metadata: Record<string, unknown> | null;
};

function pickFieldValue(payload: Record<string, unknown> | null): {
  field: string | null;
  value: string | null;
} {
  if (!payload) return { field: null, value: null };
  const entries = Object.entries(payload);
  if (entries.length === 0) return { field: null, value: null };
  const [field, raw] = entries[0];
  return { field, value: raw == null ? null : String(raw) };
}

function parseDateBound(value: string | null, endOfDay: boolean): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return endOfDay ? `${trimmed}T23:59:59.999Z` : `${trimmed}T00:00:00.000Z`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export async function GET(request: Request) {
  try {
    const resolution = await resolveStaff();
    if (!resolution.ok) {
      return NextResponse.json(
        { success: false, error: resolution.error },
        { status: resolution.status },
      );
    }
    const organizationId = resolution.organizationId;

    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Service role key is required to read audit logs." },
        { status: 503 },
      );
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? "100") || 100, 1), 500);
    const offset = Math.max(Number(searchParams.get("offset") ?? "0") || 0, 0);
    const from = parseDateBound(searchParams.get("from"), false);
    const to = parseDateBound(searchParams.get("to"), true);
    const fieldFilter = (searchParams.get("field") ?? "").trim();
    const actorFilter = (searchParams.get("actorId") ?? "").trim();

    let query = supabase
      .from("audit_logs")
      .select(
        "id, created_at, user_id, user_role, object_id, before_value, after_value, event_metadata",
        { count: "exact" },
      )
      .eq("organization_id", organizationId)
      .eq("object_type", "client")
      .eq("action", "demographic_field_updated")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);
    if (actorFilter) query = query.eq("user_id", actorFilter);
    if (fieldFilter) query = query.eq("event_metadata->>field", fieldFilter);

    const { data, error, count } = await query;
    if (error) throw error;
    const totalCount = typeof count === "number" ? count : null;

    const rows = (data ?? []) as unknown as AuditRow[];

    const userIds = Array.from(
      new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id)),
    );
    const patientIds = Array.from(
      new Set(rows.map((r) => r.object_id).filter((id): id is string => !!id)),
    );

    const userById = new Map<string, { name: string | null; email: string | null }>();
    if (userIds.length > 0) {
      const { data: staffRows } = await supabase
        .from("staff_profiles")
        .select("auth_user_id, first_name, last_name, email")
        .in("auth_user_id", userIds);
      for (const row of (staffRows ?? []) as Array<{
        auth_user_id: string | null;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }>) {
        if (!row.auth_user_id) continue;
        const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || null;
        userById.set(row.auth_user_id, { name, email: row.email });
      }
    }

    const patientById = new Map<string, string>();
    if (patientIds.length > 0) {
      const { data: patientRows } = await supabase
        .from("clients")
        .select("id, first_name, last_name, preferred_name")
        .in("id", patientIds);
      for (const row of (patientRows ?? []) as Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        preferred_name: string | null;
      }>) {
        const name =
          [row.first_name, row.last_name].filter(Boolean).join(" ") ||
          row.preferred_name ||
          "Unnamed client";
        patientById.set(row.id, name);
      }
    }

    const entries = rows.map((row) => {
      const before = pickFieldValue(row.before_value);
      const after = pickFieldValue(row.after_value);
      const field = before.field ?? after.field;
      const metadata = (row.event_metadata ?? {}) as Record<string, unknown>;
      const fieldLabel = (metadata.field_label as string | undefined) ?? field ?? "Field";
      const staff = row.user_id ? userById.get(row.user_id) ?? null : null;
      const actorName =
        staff?.name ??
        (typeof metadata.actor_name === "string" ? (metadata.actor_name as string) : null);
      const actorEmail =
        staff?.email ??
        (typeof metadata.actor_email === "string" ? (metadata.actor_email as string) : null);
      return {
        id: row.id,
        createdAt: row.created_at,
        patientId: row.object_id,
        patientName: row.object_id ? patientById.get(row.object_id) ?? null : null,
        field,
        fieldLabel,
        beforeValue: before.value,
        afterValue: after.value,
        actorId: row.user_id,
        actorName,
        actorEmail,
        userRole: row.user_role,
      };
    });

    // Build filter option lists (distinct values, scoped to org).
    const { data: fieldRows } = await supabase
      .from("audit_logs")
      .select("event_metadata")
      .eq("organization_id", organizationId)
      .eq("object_type", "client")
      .eq("action", "demographic_field_updated")
      .limit(2000);

    const fieldOptionsMap = new Map<string, string>();
    for (const row of (fieldRows ?? []) as Array<{ event_metadata: Record<string, unknown> | null }>) {
      const meta = row.event_metadata ?? {};
      const field = typeof meta.field === "string" ? (meta.field as string) : null;
      if (!field) continue;
      const label = typeof meta.field_label === "string" ? (meta.field_label as string) : field;
      if (!fieldOptionsMap.has(field)) fieldOptionsMap.set(field, label);
    }
    const fieldOptions = Array.from(fieldOptionsMap.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const { data: actorRows } = await supabase
      .from("audit_logs")
      .select("user_id")
      .eq("organization_id", organizationId)
      .eq("object_type", "client")
      .eq("action", "demographic_field_updated")
      .not("user_id", "is", null)
      .limit(2000);
    const actorIds = Array.from(
      new Set(
        ((actorRows ?? []) as Array<{ user_id: string | null }>)
          .map((r) => r.user_id)
          .filter((id): id is string => !!id),
      ),
    );
    const actorOptionsMap = new Map<string, { name: string; email: string | null }>();
    if (actorIds.length > 0) {
      const { data: actorStaff } = await supabase
        .from("staff_profiles")
        .select("auth_user_id, first_name, last_name, email")
        .in("auth_user_id", actorIds);
      for (const row of (actorStaff ?? []) as Array<{
        auth_user_id: string | null;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }>) {
        if (!row.auth_user_id) continue;
        const name =
          [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email || "Unknown";
        actorOptionsMap.set(row.auth_user_id, { name, email: row.email });
      }
      for (const id of actorIds) {
        if (!actorOptionsMap.has(id)) {
          actorOptionsMap.set(id, { name: "Unknown user", email: null });
        }
      }
    }
    const actorOptions = Array.from(actorOptionsMap.entries())
      .map(([id, info]) => ({ id, name: info.name, email: info.email }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const hasMore =
      totalCount === null ? entries.length === limit : offset + entries.length < totalCount;

    return NextResponse.json({
      success: true,
      entries,
      pagination: {
        limit,
        offset,
        returned: entries.length,
        totalCount,
        hasMore,
      },
      filterOptions: { fields: fieldOptions, actors: actorOptions },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: extractMessage(error) },
      { status: 500 },
    );
  }
}
