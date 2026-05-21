import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";

type DbRow = Record<string, unknown>;

function getString(v: unknown) {
  return typeof v === "string" ? v : "";
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }
    const url = new URL(request.url);
    const organizationId =
      url.searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;

    const { data, error } = await supabase
      .from("integration_connections")
      .select("id, integration_type, connection_status, display_name, external_account_email, last_sync_at, sync_error")
      .eq("organization_id", organizationId)
      .in("integration_type", ["gmail", "outlook", "microsoft365"])
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 422 });
    }

    return NextResponse.json({
      success: true,
      connections: ((data ?? []) as DbRow[]).map((r) => ({
        id: getString(r.id),
        integrationType: getString(r.integration_type),
        connectionStatus: getString(r.connection_status),
        displayName: getString(r.display_name),
        externalAccountEmail: getString(r.external_account_email),
        lastSyncAt: getString(r.last_sync_at),
        syncError: getString(r.sync_error),
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Connections list failed" },
      { status: 500 },
    );
  }
}
