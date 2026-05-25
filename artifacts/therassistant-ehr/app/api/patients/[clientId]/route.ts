import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { requireAuthenticatedStaff, type StaffAuthContext } from "@/lib/rbac/auth";
import {
  isValidStateCode,
  isValidSexAtBirth,
  isValidGenderIdentity,
  isValidPreferredLanguage,
} from "@/lib/demographics/options";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

function extractMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Patient update failed";
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
  sourceClientId?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
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
  sourceClientId: "external_client_ref",
  emergencyContactName: "emergency_contact_name",
  emergencyContactPhone: "emergency_contact_phone",
};

const COLUMN_LABELS: Record<string, string> = {
  first_name: "First name",
  middle_name: "Middle name",
  last_name: "Last name",
  preferred_name: "Preferred name",
  mrn: "MRN",
  date_of_birth: "Date of birth",
  sex_at_birth: "Sex at birth",
  gender_identity: "Gender identity",
  pronouns: "Pronouns",
  address_line_1: "Address line 1",
  address_line_2: "Address line 2",
  city: "City",
  state: "State",
  postal_code: "Postal code",
  phone: "Phone",
  email: "Email",
  preferred_language: "Preferred language",
  external_client_ref: "Source client ID",
  emergency_contact_name: "Emergency contact name",
  emergency_contact_phone: "Emergency contact phone",
};

const AUDIT_COLUMNS = Object.values(FIELD_MAP);

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
  if (updates.state) {
    if (!isValidStateCode(updates.state)) {
      return "State must be a valid US state code (e.g. CA, NY).";
    }
  }
  if (updates.sex_at_birth && !isValidSexAtBirth(updates.sex_at_birth)) {
    return "Sex at birth must be one of the allowed values.";
  }
  if (updates.gender_identity && !isValidGenderIdentity(updates.gender_identity)) {
    return "Gender identity must be one of the allowed values (or other:<text>).";
  }
  if (updates.preferred_language && !isValidPreferredLanguage(updates.preferred_language)) {
    return "Preferred language must be one of the allowed values (or other:<text>).";
  }
  return null;
}

type AuditClient = ReturnType<typeof createServerSupabaseServiceRoleClient>;

async function writeDemographicsAuditLogs(params: {
  supabase: NonNullable<AuditClient>;
  organizationId: string;
  clientId: string;
  staff: StaffAuthContext | null;
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}): Promise<void> {
  const { supabase, organizationId, clientId, staff, before, after } = params;
  const rows: Array<Record<string, unknown>> = [];
  const userId = staff?.userId || null;
  const userRole = staff?.roles?.[0] ?? null;
  const actorEmail = staff?.email ?? null;
  const actorName = staff
    ? [staff.firstName, staff.lastName].filter(Boolean).join(" ") || null
    : null;

  for (const column of Object.keys(after)) {
    const priorValue = before[column] ?? null;
    const newValue = after[column] ?? null;
    if (priorValue === newValue) continue;

    const label = COLUMN_LABELS[column] ?? column;
    rows.push({
      organization_id: organizationId,
      patient_id: clientId,
      user_id: userId,
      user_role: userRole,
      action: "demographic_field_updated",
      object_type: "client",
      object_id: clientId,
      before_value: { [column]: priorValue },
      after_value: { [column]: newValue },
      event_type: "demographic_field_updated",
      event_summary: `${label} changed`,
      event_metadata: {
        field: column,
        field_label: label,
        actor_email: actorEmail,
        actor_name: actorName,
      },
    });
  }

  if (rows.length === 0) return;

  const { error } = await supabase.from("audit_logs").insert(rows as never);
  if (error) {
    console.error("[patients.PATCH] audit_logs insert failed", error.message);
    throw new Error(
      "Demographic change could not be recorded in the audit log. The update was not saved.",
    );
  }
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

    const guard = await requireOrgAccess();
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const staff: StaffAuthContext | null = await requireAuthenticatedStaff();

    const body = (await request.json().catch(() => ({}))) as {
      updates?: IncomingUpdates;
    };
    const incoming = body.updates ?? {};
    const allowed: Record<string, string | null> = {};

    for (const [key, column] of Object.entries(FIELD_MAP) as Array<
      [keyof IncomingUpdates, string]
    >) {
      if (!(key in incoming)) continue;
      let normalized = normalizeString(incoming[key]);
      if (normalized === undefined) continue;
      if (column === "state" && typeof normalized === "string") {
        normalized = normalized.toUpperCase();
      }
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
      .select(["id", ...AUDIT_COLUMNS].join(", "))
      .eq("id", clientId)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) {
      return NextResponse.json({ success: false, error: "Patient not found." }, { status: 404 });
    }

    const beforeSnapshot: Record<string, string | null> = {};
    for (const column of Object.keys(allowed)) {
      const raw = (existing as unknown as Record<string, unknown>)[column];
      beforeSnapshot[column] = raw == null ? null : String(raw);
    }

    // Write the audit trail FIRST. If audit persistence fails we refuse to
    // mutate the patient row — HIPAA requires every demographic change to be
    // recorded, so a silent un-audited update is unacceptable.
    await writeDemographicsAuditLogs({
      supabase,
      organizationId,
      clientId,
      staff,
      before: beforeSnapshot,
      after: allowed,
    });

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
    if (updateError) {
      // Audit rows were already written; record a compensating note so the
      // trail isn't misleading.
      console.error(
        "[patients.PATCH] update failed after audit write — audit rows describe an unapplied change",
        updateError.message,
      );
      throw updateError;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: extractMessage(error) },
      { status: 500 },
    );
  }
}
