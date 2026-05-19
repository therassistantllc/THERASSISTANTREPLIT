import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient, createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";

const BILLING_PROFILE_KEY = "organization.billing_profile";

function getOrgId(req: NextRequest) {
  return (
    req.nextUrl.searchParams.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    ""
  );
}

export async function GET(req: NextRequest) {
  const organizationId = getOrgId(req);
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  const [orgResult, settingsResult] = await Promise.all([
    supabase
      .from("organizations")
      .select("id, name, legal_name, slug, default_state, timezone, tax_id_last4, is_active, created_at, updated_at")
      .eq("id", organizationId)
      .single(),
    supabase
      .from("system_settings")
      .select("setting_value")
      .eq("organization_id", organizationId)
      .eq("setting_key", BILLING_PROFILE_KEY)
      .maybeSingle(),
  ]);

  if (orgResult.error) {
    if (orgResult.error.code === "PGRST116") {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }
    console.error("[GET /api/settings/organization]", orgResult.error);
    return NextResponse.json({ error: "Failed to load organization" }, { status: 500 });
  }

  const billingProfile =
    settingsResult.data?.setting_value &&
    typeof settingsResult.data.setting_value === "object" &&
    !Array.isArray(settingsResult.data.setting_value)
      ? (settingsResult.data.setting_value as Record<string, unknown>)
      : {};

  return NextResponse.json({
    organization: orgResult.data,
    billing_profile: billingProfile,
  });
}

export async function PATCH(req: NextRequest) {
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

  const orgFields = ["name", "legal_name", "slug", "default_state", "timezone", "tax_id_last4", "is_active"] as const;
  const orgUpdates: Record<string, unknown> = {};
  for (const field of orgFields) {
    if (field in body) orgUpdates[field] = body[field];
  }

  const ops: Promise<unknown>[] = [];

  if (Object.keys(orgUpdates).length > 0) {
    orgUpdates.updated_at = new Date().toISOString();
    ops.push(
      Promise.resolve(
        supabase
          .from("organizations")
          .update(orgUpdates)
          .eq("id", organizationId)
          .then(({ error }) => {
            if (error) throw new Error(`Organization update failed: ${error.message}`);
          }),
      ),
    );
  }

  if (body.billing_profile && typeof body.billing_profile === "object") {
    const now = new Date().toISOString();
    ops.push(
      Promise.resolve(
        supabase
          .from("system_settings")
          .upsert(
            {
              organization_id: organizationId,
              setting_key: BILLING_PROFILE_KEY,
              setting_value: body.billing_profile as Record<string, unknown>,
              updated_at: now,
              created_at: now,
            },
            { onConflict: "organization_id,setting_key" },
          )
          .then(({ error }) => {
            if (error) throw new Error(`Billing profile update failed: ${error.message}`);
          }),
      ),
    );
  }

  try {
    await Promise.all(ops);
  } catch (err) {
    console.error("[PATCH /api/settings/organization]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
