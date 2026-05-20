import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requirePermissionInRoute } from "@/lib/rbac/middleware";
import { PERMISSIONS } from "@/lib/rbac/constants";

type Row = Record<string, unknown>;

function value(input: unknown) {
  return String(input ?? "").trim();
}

function generateToken() {
  return randomBytes(24).toString("base64url");
}

export async function POST(request: Request) {
  try {
    const auth = await requirePermissionInRoute(PERMISSIONS.EDIT_PATIENT_DEMOGRAPHICS);
    if (auth instanceof NextResponse) return auth;
    const { organizationId, staffId } = auth;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const payload = (await request.json().catch(() => null)) as Row | null;
    const clientId = value(payload?.clientId);
    if (!clientId) return NextResponse.json({ success: false, error: "clientId is required" }, { status: 400 });

    const { data: clientRow, error: clientErr } = await supabase
      .from("clients")
      .select("id, organization_id")
      .eq("id", clientId)
      .single();
    if (clientErr || !clientRow) {
      return NextResponse.json({ success: false, error: "Client not found" }, { status: 404 });
    }
    if (value((clientRow as Row).organization_id) !== organizationId) {
      return NextResponse.json({ success: false, error: "Client is not in your organization" }, { status: 403 });
    }

    // Revoke any prior pending links for this client (one active link at a time)
    await supabase
      .from("intake_links")
      .update({ status: "revoked" })
      .eq("client_id", clientId)
      .eq("status", "pending");

    const token = generateToken();
    const { data: inserted, error: insertErr } = await supabase
      .from("intake_links")
      .insert({
        organization_id: organizationId,
        client_id: clientId,
        token,
        created_by_user_id: staffId,
      })
      .select("id, token, expires_at, status")
      .single();

    if (insertErr || !inserted) throw insertErr ?? new Error("Failed to create intake link");

    await supabase.from("clients").update({ intake_status: "pending" }).eq("id", clientId);

    const row = inserted as Row;
    return NextResponse.json({
      success: true,
      link: {
        id: value(row.id),
        token: value(row.token),
        url: `/intake/${value(row.token)}`,
        expiresAt: row.expires_at ?? null,
        status: value(row.status),
      },
    });
  } catch (error) {
    console.error("Intake link create error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create intake link" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    const auth = await requirePermissionInRoute(PERMISSIONS.VIEW_PATIENT_CHART);
    if (auth instanceof NextResponse) return auth;
    const { organizationId } = auth;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const clientId = value(searchParams.get("clientId"));
    if (!clientId) return NextResponse.json({ success: false, error: "clientId is required" }, { status: 400 });

    const { data, error } = await supabase
      .from("intake_links")
      .select("id, token, status, expires_at, created_at, used_at, submission_id")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    return NextResponse.json({
      success: true,
      links: ((data ?? []) as Row[]).map((row) => ({
        id: value(row.id),
        token: value(row.token),
        url: `/intake/${value(row.token)}`,
        status: value(row.status),
        expiresAt: row.expires_at ?? null,
        createdAt: row.created_at ?? null,
        usedAt: row.used_at ?? null,
        submissionId: row.submission_id ?? null,
      })),
    });
  } catch (error) {
    console.error("Intake link list error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to list intake links" },
      { status: 500 },
    );
  }
}
