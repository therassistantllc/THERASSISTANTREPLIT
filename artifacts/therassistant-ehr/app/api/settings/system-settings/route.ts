import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

function getOrgId(req: NextRequest) {
  return (
    req.nextUrl.searchParams.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    ""
  );
}

/** GET /api/settings/system-settings?organizationId=...&key=... */
export async function GET(req: NextRequest) {
  const organizationId = getOrgId(req);
  const key = req.nextUrl.searchParams.get("key");
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }
  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("system_settings")
    .select("setting_value")
    .eq("organization_id", organizationId)
    .eq("setting_key", key)
    .maybeSingle();

  if (error) {
    console.error("[GET /api/settings/system-settings]", error);
    return NextResponse.json({ error: "Failed to load setting" }, { status: 500 });
  }

  return NextResponse.json({
    key,
    value: data?.setting_value ?? null,
  });
}

/** PUT /api/settings/system-settings?organizationId=...  body: { key, value } */
export async function PUT(req: NextRequest) {
  const organizationId = getOrgId(req);
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  let body: { key?: string; value?: unknown };
  try {
    body = (await req.json()) as { key?: string; value?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.key || typeof body.key !== "string") {
    return NextResponse.json({ error: "key is required in body" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("system_settings")
    .upsert(
      {
        organization_id: organizationId,
        setting_key: body.key,
        setting_value: body.value as Record<string, unknown>,
        updated_at: now,
        created_at: now,
      },
      { onConflict: "organization_id,setting_key" },
    );

  if (error) {
    console.error("[PUT /api/settings/system-settings]", error);
    return NextResponse.json({ error: "Failed to save setting" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
