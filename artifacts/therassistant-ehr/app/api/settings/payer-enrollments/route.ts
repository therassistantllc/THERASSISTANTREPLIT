import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * Per-payer trading-partner enrollment tracker (Office Ally Phase 1, T003).
 *
 * One row per (org, payer_profile_id, transaction_type, environment) — with terminated rows
 * preserved for history. The unique partial index on (...) WHERE status <> 'terminated' is what
 * guarantees at most one active row per tuple, so POST does upsert-with-validation here.
 */

const TRANSACTION_TYPES = ["837P", "837I", "835", "270", "276", "999"] as const;
const ENVIRONMENTS = ["sandbox", "production"] as const;
const STATUSES = ["pending", "submitted", "approved", "rejected", "terminated"] as const;

type TransactionType = (typeof TRANSACTION_TYPES)[number];
type Environment = (typeof ENVIRONMENTS)[number];
type Status = (typeof STATUSES)[number];

function getOrgId(req: NextRequest) {
  return (
    req.nextUrl.searchParams.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    ""
  );
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function parseBody(body: Record<string, unknown>) {
  const errors: Record<string, string> = {};

  const payerProfileId = typeof body.payer_profile_id === "string" ? body.payer_profile_id : "";
  if (!payerProfileId) errors.payer_profile_id = "payer_profile_id is required.";

  if ("transaction_type" in body && !isOneOf(body.transaction_type, TRANSACTION_TYPES)) {
    errors.transaction_type = `transaction_type must be one of: ${TRANSACTION_TYPES.join(", ")}.`;
  }
  if ("environment" in body && !isOneOf(body.environment, ENVIRONMENTS)) {
    errors.environment = `environment must be one of: ${ENVIRONMENTS.join(", ")}.`;
  }
  if ("status" in body && !isOneOf(body.status, STATUSES)) {
    errors.status = `status must be one of: ${STATUSES.join(", ")}.`;
  }

  function parseDate(field: string): string | null | undefined {
    if (!(field in body)) return undefined;
    const v = body[field];
    if (v === null || v === "") return null;
    if (typeof v !== "string") {
      errors[field] = `${field} must be an ISO date string or null.`;
      return undefined;
    }
    const t = new Date(v);
    if (Number.isNaN(t.getTime())) {
      errors[field] = `${field} is not a valid date.`;
      return undefined;
    }
    return t.toISOString();
  }

  const approved_at = parseDate("approved_at");
  const expires_at = parseDate("expires_at");

  return {
    errors,
    update: {
      payer_profile_id: payerProfileId,
      transaction_type: body.transaction_type as TransactionType | undefined,
      environment: body.environment as Environment | undefined,
      status: body.status as Status | undefined,
      oa_enrollment_reference:
        "oa_enrollment_reference" in body
          ? (body.oa_enrollment_reference as string | null)
          : undefined,
      approved_at,
      expires_at,
      notes: "notes" in body ? (body.notes as string | null) : undefined,
    },
  };
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

  const [enrollmentsRes, payersRes] = await Promise.all([
    supabase
      .from("payer_enrollments")
      .select(
        "id, payer_profile_id, transaction_type, environment, status, oa_enrollment_reference, approved_at, expires_at, notes, created_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false }),
    supabase
      .from("payer_profiles")
      .select("id, payer_name, office_ally_payer_id, is_active")
      .eq("organization_id", organizationId)
      .order("payer_name"),
  ]);

  if (enrollmentsRes.error) {
    console.error("[GET /api/settings/payer-enrollments]", enrollmentsRes.error);
    return NextResponse.json({ error: enrollmentsRes.error.message }, { status: 500 });
  }
  if (payersRes.error) {
    return NextResponse.json({ error: payersRes.error.message }, { status: 500 });
  }

  return NextResponse.json({
    enrollments: enrollmentsRes.data ?? [],
    payers: payersRes.data ?? [],
    transactionTypes: TRANSACTION_TYPES,
    environments: ENVIRONMENTS,
    statuses: STATUSES,
  });
}

export async function POST(req: NextRequest) {
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

  const { errors, update } = parseBody(body);
  if (!update.transaction_type) errors.transaction_type = "transaction_type is required.";
  if (!update.environment) errors.environment = "environment is required.";
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed.", fields: errors }, { status: 422 });
  }

  // If there's an existing non-terminated row for this tuple, update it; otherwise insert.
  // (Two-step rather than upsert because supabase-js cannot drive a partial-index ON CONFLICT,
  // and we want to surface a clean validation message for the unique-violation edge cases.)
  const { data: existing, error: lookupErr } = await supabase
    .from("payer_enrollments")
    .select("id, status")
    .eq("organization_id", organizationId)
    .eq("payer_profile_id", update.payer_profile_id)
    .eq("transaction_type", update.transaction_type!)
    .eq("environment", update.environment!)
    .neq("status", "terminated")
    .maybeSingle();

  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  }

  const now = new Date().toISOString();

  if (existing) {
    const { data, error } = await supabase
      .from("payer_enrollments")
      .update({
        status: update.status ?? "pending",
        oa_enrollment_reference: update.oa_enrollment_reference ?? null,
        approved_at: update.approved_at ?? null,
        expires_at: update.expires_at ?? null,
        notes: update.notes ?? null,
        updated_at: now,
      })
      .eq("id", existing.id)
      .eq("organization_id", organizationId)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, enrollment: data, action: "updated" });
  }

  const { data, error } = await supabase
    .from("payer_enrollments")
    .insert({
      organization_id: organizationId,
      payer_profile_id: update.payer_profile_id,
      transaction_type: update.transaction_type,
      environment: update.environment,
      status: update.status ?? "pending",
      oa_enrollment_reference: update.oa_enrollment_reference ?? null,
      approved_at: update.approved_at ?? null,
      expires_at: update.expires_at ?? null,
      notes: update.notes ?? null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, enrollment: data, action: "created" });
}

export async function PATCH(req: NextRequest) {
  const organizationId = getOrgId(req);
  const enrollmentId = req.nextUrl.searchParams.get("id");
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }
  if (!enrollmentId) {
    return NextResponse.json({ error: "?id=<enrollmentId> is required" }, { status: 400 });
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

  const errors: Record<string, string> = {};
  const patch: Record<string, unknown> = {};

  if ("status" in body) {
    if (!isOneOf(body.status, STATUSES)) {
      errors.status = `status must be one of: ${STATUSES.join(", ")}.`;
    } else {
      patch.status = body.status;
    }
  }
  if ("oa_enrollment_reference" in body) patch.oa_enrollment_reference = body.oa_enrollment_reference ?? null;
  if ("notes" in body) patch.notes = body.notes ?? null;

  for (const field of ["approved_at", "expires_at"] as const) {
    if (field in body) {
      const v = body[field];
      if (v === null || v === "") {
        patch[field] = null;
      } else if (typeof v === "string") {
        const t = new Date(v);
        if (Number.isNaN(t.getTime())) errors[field] = `${field} is not a valid date.`;
        else patch[field] = t.toISOString();
      } else {
        errors[field] = `${field} must be an ISO date string or null.`;
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed.", fields: errors }, { status: 422 });
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No updatable fields provided." }, { status: 400 });
  }

  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("payer_enrollments")
    .update(patch)
    .eq("id", enrollmentId)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, enrollment: data });
}
