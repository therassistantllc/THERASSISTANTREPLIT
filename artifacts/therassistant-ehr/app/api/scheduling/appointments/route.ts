import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";
import { requireAuthenticatedStaff } from "@/lib/rbac/auth";

type Row = Record<string, unknown>;

/**
 * Resolve the organization for a scheduling read. In production an
 * authenticated staff context is required and the resolved org always
 * comes from auth — any caller-supplied orgId that disagrees is
 * rejected. A non-production dev fallback to DEFAULT_ORG_ID exists
 * solely so the local seed environment (which has no Supabase auth
 * session) can still render the calendar; production builds NEVER hit
 * that path.
 */
async function resolveOrgForRead(
  requestedOrgId: string | null,
): Promise<
  | { ok: true; organizationId: string }
  | { ok: false; status: number; error: string }
> {
  const staff = await requireAuthenticatedStaff();
  if (staff) {
    const orgId = staff.organizationId;
    if (requestedOrgId && requestedOrgId !== orgId) {
      return { ok: false, status: 403, error: "Organization mismatch" };
    }
    return { ok: true, organizationId: orgId };
  }
  if (process.env.NODE_ENV === "production") {
    return { ok: false, status: 401, error: "Authentication required" };
  }
  const fallback = DEFAULT_ORG_ID;
  if (requestedOrgId && requestedOrgId !== fallback) {
    return { ok: false, status: 401, error: "Authentication required" };
  }
  return { ok: true, organizationId: fallback };
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(request.url);
    const orgResolution = await resolveOrgForRead(
      searchParams.get("organizationId"),
    );
    if (!orgResolution.ok) {
      return NextResponse.json(
        { success: false, error: orgResolution.error },
        { status: orgResolution.status },
      );
    }
    const organizationId = orgResolution.organizationId;
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    if (!from || !to) {
      return NextResponse.json(
        { success: false, error: "from and to (ISO timestamps) are required" },
        { status: 400 },
      );
    }

    const { data: appts, error } = await supabase
      .from("appointments")
      .select(
        "id, client_id, provider_id, scheduled_start_at, scheduled_end_at, appointment_status, appointment_type, reason",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .gte("scheduled_start_at", from)
      .lt("scheduled_start_at", to)
      .order("scheduled_start_at", { ascending: true });

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 422 },
      );
    }

    const rows = (appts ?? []) as Row[];
    const clientIds = Array.from(
      new Set(rows.map((r) => String(r.client_id ?? "")).filter(Boolean)),
    );
    const providerIds = Array.from(
      new Set(rows.map((r) => String(r.provider_id ?? "")).filter(Boolean)),
    );

    const [clientsRes, providersRes] = await Promise.all([
      clientIds.length
        ? supabase
            .from("clients")
            .select("id, first_name, last_name, preferred_name")
            .eq("organization_id", organizationId)
            .in("id", clientIds)
        : Promise.resolve({ data: [] as Row[] }),
      providerIds.length
        ? supabase
            .from("providers")
            .select("id, first_name, last_name, display_name, credential")
            .eq("organization_id", organizationId)
            .in("id", providerIds)
        : Promise.resolve({ data: [] as Row[] }),
    ]);

    const clientMap = new Map<string, Row>();
    for (const c of (clientsRes.data ?? []) as Row[]) {
      clientMap.set(String(c.id), c);
    }
    const providerMap = new Map<string, Row>();
    for (const p of (providersRes.data ?? []) as Row[]) {
      providerMap.set(String(p.id), p);
    }

    const appointments = rows.map((r) => {
      const client = clientMap.get(String(r.client_id ?? ""));
      const provider = providerMap.get(String(r.provider_id ?? ""));
      const clientName = client
        ? [client.first_name, client.last_name].filter(Boolean).join(" ") ||
          "Unknown client"
        : "Unknown client";
      const providerName = provider
        ? String(provider.display_name ?? "").trim() ||
          [provider.first_name, provider.last_name]
            .filter(Boolean)
            .join(" ") ||
          "Unassigned"
        : "Unassigned";

      // CPT is stored in appointment_type when it looks like a CPT code.
      const apptType =
        typeof r.appointment_type === "string" ? r.appointment_type : "";
      const cptCode = /^9\d{4}$/.test(apptType) ? apptType : null;

      return {
        id: String(r.id),
        clientId: r.client_id ? String(r.client_id) : null,
        clientName,
        providerId: r.provider_id ? String(r.provider_id) : null,
        providerName,
        scheduledStartAt: r.scheduled_start_at,
        scheduledEndAt: r.scheduled_end_at,
        status: r.appointment_status,
        appointmentType: r.appointment_type,
        cptCode,
      };
    });

    return NextResponse.json({
      success: true,
      organizationId,
      from,
      to,
      appointments,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Failed to load appointments",
      },
      { status: 500 },
    );
  }
}
