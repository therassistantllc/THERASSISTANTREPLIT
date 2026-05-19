import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

const BILLING_DEFAULTS_KEY = "billing.defaults";

function getOrgId(req: NextRequest) {
  return (
    req.nextUrl.searchParams.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    ""
  );
}

const DEFAULTS = {
  claim_frequency_code: "1",
  default_pos: "11",
  default_diagnosis_behavior: "first_encounter",
  default_procedure_charge_behavior: "manual",
  eligibility_recheck_days: 30,
  claim_hold_days: 3,
  aging_bucket_rules: "30/60/90/120",
  auto_route_missing_info: true,
};

export async function GET(req: NextRequest) {
  const organizationId = getOrgId(req);
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("system_settings")
    .select("setting_value")
    .eq("organization_id", organizationId)
    .eq("setting_key", BILLING_DEFAULTS_KEY)
    .maybeSingle();

  if (error) {
    console.error("[GET /api/settings/billing-defaults]", error);
    return NextResponse.json({ error: "Failed to load billing defaults" }, { status: 500 });
  }

  const stored =
    data?.setting_value && typeof data.setting_value === "object" && !Array.isArray(data.setting_value)
      ? (data.setting_value as Record<string, unknown>)
      : {};

  return NextResponse.json({ billing_defaults: { ...DEFAULTS, ...stored } });
}

export async function PUT(req: NextRequest) {
  const organizationId = getOrgId(req);
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const allowedKeys = Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[];
  const updates: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key in body) updates[key] = body[key];
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("system_settings")
    .upsert(
      {
        organization_id: organizationId,
        setting_key: BILLING_DEFAULTS_KEY,
        setting_value: updates,
        updated_at: now,
        created_at: now,
      },
      { onConflict: "organization_id,setting_key" },
    );

  if (error) {
    console.error("[PUT /api/settings/billing-defaults]", error);
    return NextResponse.json({ error: "Failed to save billing defaults" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
