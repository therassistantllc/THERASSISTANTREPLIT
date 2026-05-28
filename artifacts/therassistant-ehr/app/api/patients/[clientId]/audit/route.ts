import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";
import { requireAuthenticatedStaff } from "@/lib/rbac/auth";

function extractMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Failed to load audit log.";
}

async function resolveOrg(): Promise<
  { ok: true; organizationId: string } | { ok: false; status: number; error: string }
> {
  const staff = await requireAuthenticatedStaff();
  if (staff) return { ok: true, organizationId: staff.organizationId };
  if (process.env.NODE_ENV === "production") {
    return { ok: false, status: 401, error: "Authentication required" };
  }
  return { ok: true, organizationId: DEFAULT_ORG_ID };
}

type AuditRow = {
  id: string;
  created_at: string;
  user_id: string | null;
  user_role: string | null;
  action: string | null;
  object_type: string | null;
  object_id: string | null;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
  event_summary: string | null;
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

const SECTION_BY_OBJECT_TYPE: Record<string, string> = {
  client: "Demographics",
  insurance_policy: "Insurance policy",
  client_case: "Case",
};

const TRACKED_ACTIONS = [
  "demographic_field_updated",
  "insurance_policy_created",
  "insurance_policy_updated",
  "insurance_policy_archived",
  "client_case_created",
  "client_case_updated",
  "client_case_archived",
  "client_case_policy_attached",
  "client_case_policy_detached",
  "client_case_policy_reordered",
];

export async function GET(
  request: Request,
  context: { params: Promise<{ clientId: string }> | { clientId: string } },
) {
  try {
    const { clientId: rawClientId } = await Promise.resolve(context.params);
    const clientId = String(rawClientId ?? "").trim();
    if (!clientId) {
      return NextResponse.json({ success: false, error: "clientId is required." }, { status: 400 });
    }

    const orgResolution = await resolveOrg();
    if (!orgResolution.ok) {
      return NextResponse.json(
        { success: false, error: orgResolution.error },
        { status: orgResolution.status },
      );
    }
    const organizationId = orgResolution.organizationId;

    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Service role key is required to read audit logs." },
        { status: 503 },
      );
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? "50") || 50, 1), 200);

    // Pull every audit row tied to this client across the chart-tracked
    // object types (demographics, insurance policy, case). The route filters
    // by patient_id which is set on every row we write, so policy/case rows
    // surface here even though their object_type is not 'client'.
    const { data, error } = await supabase
      .from("audit_logs")
      .select(
        "id, created_at, user_id, user_role, action, object_type, object_id, before_value, after_value, event_summary, event_metadata",
      )
      .eq("organization_id", organizationId)
      .eq("patient_id", clientId)
      .in("action", TRACKED_ACTIONS)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    const rows = (data ?? []) as unknown as AuditRow[];

    const userIds = Array.from(
      new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id)),
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
      const objectType = row.object_type ?? "client";
      const objectLabel =
        (typeof metadata.object_label === "string" ? (metadata.object_label as string) : null) ??
        SECTION_BY_OBJECT_TYPE[objectType] ??
        objectType;
      const section = SECTION_BY_OBJECT_TYPE[objectType] ?? objectType;
      return {
        id: row.id,
        createdAt: row.created_at,
        field,
        fieldLabel,
        beforeValue: before.value,
        afterValue: after.value,
        actorName,
        actorEmail,
        userRole: row.user_role,
        objectType,
        objectId: row.object_id,
        objectLabel,
        section,
        action: row.action,
      };
    });

    return NextResponse.json({ success: true, entries });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: extractMessage(error) },
      { status: 500 },
    );
  }
}
