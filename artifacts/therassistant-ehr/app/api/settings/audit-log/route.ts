/**
 * GET /api/settings/audit-log
 *
 * Admin-only paginated read of public.audit_logs, scoped to the caller's org
 * and pre-filtered to `object_type = 'system_setting'`. Powers the unified
 * "Recent settings changes" admin view so each settings page no longer needs
 * its own little widget.
 *
 * Filters: settingKey (matched against event_metadata->>setting_key OR action),
 * actorId, from, to (date strings, inclusive end-of-day on `to`).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireRoleInRoute } from "@/lib/rbac/middleware";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { STAFF_ROLES } from "@/lib/rbac/constants";

const SETTING_OBJECT_TYPE = "system_setting";

type AuditRow = {
  id: string;
  created_at: string;
  user_id: string | null;
  user_role: string | null;
  action: string | null;
  object_type: string | null;
  object_id: string | null;
  event_summary: string | null;
  event_metadata: Record<string, unknown> | null;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
};

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

export async function GET(request: NextRequest) {
  const authOrError = await requireRoleInRoute(STAFF_ROLES.ADMIN);
  if (authOrError instanceof NextResponse) return authOrError;

  const { organizationId } = authOrError;

  const supabase = createServerSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Service role key is required to read audit logs." },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(
    Math.max(Number(searchParams.get("limit") ?? "50") || 50, 1),
    200,
  );
  const offset = Math.max(Number(searchParams.get("offset") ?? "0") || 0, 0);
  const from = parseDateBound(searchParams.get("from"), false);
  const to = parseDateBound(searchParams.get("to"), true);
  const settingKey = (searchParams.get("settingKey") ?? "").trim();
  const actorId = (searchParams.get("actorId") ?? "").trim();

  let query = supabase
    .from("audit_logs")
    .select(
      "id, created_at, user_id, user_role, action, object_type, object_id, event_summary, event_metadata, before_value, after_value",
      { count: "exact" },
    )
    .eq("organization_id", organizationId)
    .eq("object_type", SETTING_OBJECT_TYPE)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);
  if (actorId) query = query.eq("user_id", actorId);
  if (settingKey) {
    // event_metadata.setting_key is the canonical home for the key (see the
    // 277CA writer in `app/api/settings/billing-defaults/route.ts`). Fall back
    // to matching the `action` column so older entries written before that
    // convention landed are still findable.
    query = query.or(
      `event_metadata->>setting_key.eq.${settingKey},action.eq.${settingKey}`,
    );
  }

  const { data, error, count } = await query;
  if (error) {
    return NextResponse.json(
      { error: `Failed to read settings audit log: ${error.message}` },
      { status: 500 },
    );
  }

  const rows = (data ?? []) as unknown as AuditRow[];
  const totalCount = typeof count === "number" ? count : null;

  // Actor resolution — same two-source pattern as the security audit endpoint.
  const authIds = Array.from(
    new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id)),
  );

  const nameByAuth = new Map<string, { name: string; email: string | null }>();
  if (authIds.length > 0) {
    const { data: staff } = await supabase
      .from("staff_profiles")
      .select("auth_user_id, first_name, last_name, email")
      .in("auth_user_id", authIds);
    for (const row of (staff ?? []) as Array<{
      auth_user_id: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>) {
      if (!row.auth_user_id) continue;
      const name =
        [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email || "Unknown";
      nameByAuth.set(row.auth_user_id, { name, email: row.email });
    }
  }

  const entries = rows.map((row) => {
    const meta = row.event_metadata ?? {};
    const settingKeyFromMeta =
      typeof meta.setting_key === "string" ? meta.setting_key : null;
    const field = typeof meta.field === "string" ? meta.field : null;
    const fieldLabel =
      typeof meta.field_label === "string" ? meta.field_label : field;
    const fromAuth = row.user_id ? nameByAuth.get(row.user_id) ?? null : null;

    const before = row.before_value ?? null;
    const after = row.after_value ?? null;
    const beforeAtField = field && before ? before[field] : null;
    const afterAtField = field && after ? after[field] : null;

    return {
      id: row.id,
      createdAt: row.created_at,
      action: row.action,
      settingKey: settingKeyFromMeta ?? row.action,
      field,
      fieldLabel,
      beforeValue: beforeAtField ?? before,
      afterValue: afterAtField ?? after,
      summary: row.event_summary,
      actorId: row.user_id,
      actorName: fromAuth?.name ?? null,
      actorEmail: fromAuth?.email ?? null,
      userRole: row.user_role,
      metadata: meta,
    };
  });

  // Distinct setting-key options pulled from existing entries (capped scan).
  const { data: keyRows } = await supabase
    .from("audit_logs")
    .select("action, event_metadata")
    .eq("organization_id", organizationId)
    .eq("object_type", SETTING_OBJECT_TYPE)
    .limit(2000);
  const settingKeySet = new Set<string>();
  for (const r of (keyRows ?? []) as Array<{
    action: string | null;
    event_metadata: Record<string, unknown> | null;
  }>) {
    const k = r.event_metadata?.setting_key;
    if (typeof k === "string" && k) settingKeySet.add(k);
    else if (r.action) settingKeySet.add(r.action);
  }
  const settingKeyOptions = Array.from(settingKeySet).sort();

  // Actor options drawn from organization staff (small set).
  const { data: staffRows } = await supabase
    .from("staff_profiles")
    .select("auth_user_id, first_name, last_name, email")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .not("auth_user_id", "is", null);
  const actorOptions = ((staffRows ?? []) as Array<{
    auth_user_id: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  }>)
    .filter((r) => !!r.auth_user_id)
    .map((r) => ({
      id: r.auth_user_id as string,
      name:
        [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || "Unknown",
      email: r.email,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    success: true,
    entries,
    pagination: {
      limit,
      offset,
      returned: entries.length,
      totalCount,
      hasMore:
        totalCount === null ? entries.length === limit : offset + entries.length < totalCount,
    },
    filterOptions: { settingKeys: settingKeyOptions, actors: actorOptions },
  });
}
