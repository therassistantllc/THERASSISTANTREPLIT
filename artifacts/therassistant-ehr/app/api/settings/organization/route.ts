import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

const BILLING_PROFILE_KEY = "organization.billing_profile";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStringField(
  profile: Record<string, unknown>,
  key: string,
  label: string,
  check: (trimmed: string) => string | null,
): string | null {
  if (!(key in profile)) return null;
  const raw = profile[key];
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    return `${label} must be a string.`;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return check(trimmed);
}

function validateBillingProfile(profile: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};

  const npiErr = validateStringField(profile, "billing_provider_npi", "NPI", (v) => {
    const digits = v.replace(/\D/g, "");
    return digits.length === 10 ? null : "NPI must be exactly 10 digits.";
  });
  if (npiErr) errors.billing_provider_npi = npiErr;

  const taxErr = validateStringField(profile, "billing_tax_id", "Tax ID / EIN", (v) => {
    const digits = v.replace(/\D/g, "");
    return digits.length === 9 ? null : "Tax ID / EIN must be exactly 9 digits.";
  });
  if (taxErr) errors.billing_tax_id = taxErr;

  const zipErr = validateStringField(profile, "billing_zip", "ZIP", (v) =>
    /^\d{5}(-\d{4})?$|^\d{9}$/.test(v)
      ? null
      : "ZIP must be 5 digits, 9 digits, or ZIP+4 (e.g. 80202, 802021234, or 80202-1234).",
  );
  if (zipErr) errors.billing_zip = zipErr;

  const phoneErr = validateStringField(profile, "billing_phone", "Phone", (v) => {
    const digits = v.replace(/\D/g, "");
    return digits.length === 10 ? null : "Phone must be a 10-digit US number.";
  });
  if (phoneErr) errors.billing_phone = phoneErr;

  // Authorized representative (Office Ally trading-partner agreement).
  // Name is free text — no format check. Email and phone are validated when present.
  const repEmailErr = validateStringField(profile, "authorized_rep_email", "Authorized rep email", (v) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Authorized rep email is not a valid address.",
  );
  if (repEmailErr) errors.authorized_rep_email = repEmailErr;

  const repPhoneErr = validateStringField(profile, "authorized_rep_phone", "Authorized rep phone", (v) => {
    const digits = v.replace(/\D/g, "");
    return digits.length === 10 ? null : "Authorized rep phone must be a 10-digit US number.";
  });
  if (repPhoneErr) errors.authorized_rep_phone = repPhoneErr;

  return errors;
}

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

  const supabase = createServerSupabaseAdminClient();
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
      return NextResponse.json({
        organization: null,
        billing_profile: {},
        _notice: "No organization record found. Save to create one.",
      });
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

  const hasBillingProfile = "billing_profile" in body && body.billing_profile !== undefined && body.billing_profile !== null;
  if (hasBillingProfile && !isPlainObject(body.billing_profile)) {
    return NextResponse.json(
      {
        error: "billing_profile must be a JSON object.",
        fields: { billing_profile: "billing_profile must be a JSON object." },
      },
      { status: 422 },
    );
  }
  if (hasBillingProfile && isPlainObject(body.billing_profile)) {
    const fieldErrors = validateBillingProfile(body.billing_profile);
    if (Object.keys(fieldErrors).length > 0) {
      return NextResponse.json(
        {
          error: "Validation failed for one or more billing profile fields.",
          fields: fieldErrors,
        },
        { status: 422 },
      );
    }
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

  if (hasBillingProfile && isPlainObject(body.billing_profile)) {
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
