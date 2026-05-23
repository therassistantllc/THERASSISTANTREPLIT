import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";
import { requireAuthenticatedStaff } from "@/lib/rbac/auth";

function extractMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Patient update failed";
}

async function resolveOrgForMutation(): Promise<
  | { ok: true; organizationId: string }
  | { ok: false; status: number; error: string }
> {
  const staff = await requireAuthenticatedStaff();
  if (staff) return { ok: true, organizationId: staff.organizationId };
  if (process.env.NODE_ENV === "production") {
    return { ok: false, status: 401, error: "Authentication required" };
  }
  return { ok: true, organizationId: DEFAULT_ORG_ID };
}

type IncomingUpdates = {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
  mrn?: string | null;
  dateOfBirth?: string | null;
  sexAtBirth?: string | null;
  genderIdentity?: string | null;
  pronouns?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string | null;
  preferredLanguage?: string | null;
};

const FIELD_MAP: Record<keyof IncomingUpdates, string> = {
  firstName: "first_name",
  middleName: "middle_name",
  lastName: "last_name",
  preferredName: "preferred_name",
  mrn: "mrn",
  dateOfBirth: "date_of_birth",
  sexAtBirth: "sex_at_birth",
  genderIdentity: "gender_identity",
  pronouns: "pronouns",
  addressLine1: "address_line_1",
  addressLine2: "address_line_2",
  city: "city",
  state: "state",
  postalCode: "postal_code",
  phone: "phone",
  email: "email",
  preferredLanguage: "preferred_language",
};

function normalizeString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validate(updates: Record<string, string | null>): string | null {
  if ("first_name" in updates && (updates.first_name === null || updates.first_name === "")) {
    return "First name is required.";
  }
  if ("last_name" in updates && (updates.last_name === null || updates.last_name === "")) {
    return "Last name is required.";
  }
  if (updates.email) {
    const email = updates.email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return "Email address is not valid.";
    }
  }
  if (updates.date_of_birth) {
    const dob = updates.date_of_birth;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(new Date(dob).getTime())) {
      return "Date of birth must be a valid date (YYYY-MM-DD).";
    }
  }
  if (updates.postal_code && !/^[A-Za-z0-9 \-]{3,12}$/.test(updates.postal_code)) {
    return "Postal code is not valid.";
  }
  return null;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ clientId: string }> | { clientId: string } },
) {
  try {
    const { clientId: rawClientId } = await Promise.resolve(context.params);
    const clientId = String(rawClientId ?? "").trim();
    if (!clientId) {
      return NextResponse.json({ success: false, error: "clientId is required." }, { status: 400 });
    }

    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Service role key is required for patient updates." },
        { status: 503 },
      );
    }

    const orgResolution = await resolveOrgForMutation();
    if (!orgResolution.ok) {
      return NextResponse.json(
        { success: false, error: orgResolution.error },
        { status: orgResolution.status },
      );
    }
    const organizationId = orgResolution.organizationId;

    const body = (await request.json().catch(() => ({}))) as {
      updates?: IncomingUpdates;
    };
    const incoming = body.updates ?? {};
    const allowed: Record<string, string | null> = {};

    for (const [key, column] of Object.entries(FIELD_MAP) as Array<
      [keyof IncomingUpdates, string]
    >) {
      if (!(key in incoming)) continue;
      const normalized = normalizeString(incoming[key]);
      if (normalized === undefined) continue;
      allowed[column] = normalized;
    }

    if (Object.keys(allowed).length === 0) {
      return NextResponse.json(
        { success: false, error: "No updates supplied." },
        { status: 400 },
      );
    }

    const validationError = validate(allowed);
    if (validationError) {
      return NextResponse.json({ success: false, error: validationError }, { status: 400 });
    }

    const { data: existing, error: existingError } = await supabase
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) {
      return NextResponse.json({ success: false, error: "Patient not found." }, { status: 404 });
    }

    const updatePayload: Record<string, unknown> = {
      ...allowed,
      updated_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
      .from("clients")
      .update(updatePayload)
      .eq("id", clientId)
      .eq("organization_id", organizationId)
      .is("archived_at", null);
    if (updateError) throw updateError;

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: extractMessage(error) },
      { status: 500 },
    );
  }
}
