import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * Business Associate Agreement tracker (T004).
 *
 * On first GET for an org, seed default rows for the four required counterparties
 * (office_ally, supabase, google_workspace, hosting) at status='not_started' so the
 * operator immediately sees what's outstanding instead of an empty table.
 */

const COUNTERPARTY_TYPES = ["office_ally", "supabase", "google_workspace", "hosting", "other"] as const;
const STATUSES = ["not_started", "draft", "executed", "expired", "terminated"] as const;

type CounterpartyType = (typeof COUNTERPARTY_TYPES)[number];
type Status = (typeof STATUSES)[number];

const DEFAULT_SEEDS: Array<{ counterparty_type: CounterpartyType; counterparty_name: string }> = [
  { counterparty_type: "office_ally", counterparty_name: "Office Ally, LLC" },
  { counterparty_type: "supabase", counterparty_name: "Supabase Inc." },
  { counterparty_type: "google_workspace", counterparty_name: "Google Workspace" },
  { counterparty_type: "hosting", counterparty_name: "Replit, Inc." },
];

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

function parseDateOrNull(value: unknown, field: string, errors: Record<string, string>): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    errors[field] = `${field} must be an ISO date string (YYYY-MM-DD) or null.`;
    return undefined;
  }
  // Use a YYYY-MM-DD pattern check; Postgres `date` round-trips this exactly.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors[field] = `${field} must be a date in YYYY-MM-DD format.`;
    return undefined;
  }
  return value;
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

  // 1. Fetch existing rows.
  const { data: rows, error } = await supabase
    .from("business_associate_agreements")
    .select("*")
    .eq("organization_id", organizationId)
    .order("counterparty_type");

  if (error) {
    console.error("[GET /api/settings/baa]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 2. First-load seeding: insert any missing default counterparties at 'not_started'.
  const existingTypes = new Set((rows ?? []).map((r) => r.counterparty_type));
  const missing = DEFAULT_SEEDS.filter((s) => !existingTypes.has(s.counterparty_type));
  if (missing.length > 0) {
    const { error: seedErr } = await supabase
      .from("business_associate_agreements")
      .insert(missing.map((m) => ({ organization_id: organizationId, ...m })));
    if (seedErr) {
      // Log but don't fail the GET — the partial-unique index might have raced with a
      // sibling request that already inserted these defaults.
      console.warn("[GET /api/settings/baa] seed insert failed (non-fatal):", seedErr.message);
    }
    // Re-read to include the seeded rows in this response.
    const { data: rowsAfterSeed } = await supabase
      .from("business_associate_agreements")
      .select("*")
      .eq("organization_id", organizationId)
      .order("counterparty_type");
    return NextResponse.json({
      agreements: rowsAfterSeed ?? rows ?? [],
      counterpartyTypes: COUNTERPARTY_TYPES,
      statuses: STATUSES,
    });
  }

  return NextResponse.json({
    agreements: rows ?? [],
    counterpartyTypes: COUNTERPARTY_TYPES,
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

  const errors: Record<string, string> = {};
  if (!isOneOf(body.counterparty_type, COUNTERPARTY_TYPES)) {
    errors.counterparty_type = `counterparty_type must be one of: ${COUNTERPARTY_TYPES.join(", ")}.`;
  }
  if (typeof body.counterparty_name !== "string" || body.counterparty_name.trim().length === 0) {
    errors.counterparty_name = "counterparty_name is required.";
  }
  if ("status" in body && !isOneOf(body.status, STATUSES)) {
    errors.status = `status must be one of: ${STATUSES.join(", ")}.`;
  }
  const signed_at = parseDateOrNull(body.signed_at, "signed_at", errors);
  const effective_at = parseDateOrNull(body.effective_at, "effective_at", errors);
  const expires_at = parseDateOrNull(body.expires_at, "expires_at", errors);

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed.", fields: errors }, { status: 422 });
  }

  const { data, error } = await supabase
    .from("business_associate_agreements")
    .insert({
      organization_id: organizationId,
      counterparty_type: body.counterparty_type,
      counterparty_name: (body.counterparty_name as string).trim(),
      status: (body.status as Status) ?? "not_started",
      signed_at: signed_at ?? null,
      effective_at: effective_at ?? null,
      expires_at: expires_at ?? null,
      contact_name: typeof body.contact_name === "string" ? body.contact_name : null,
      contact_email: typeof body.contact_email === "string" ? body.contact_email : null,
      document_url: typeof body.document_url === "string" ? body.document_url : null,
      notes: typeof body.notes === "string" ? body.notes : null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        {
          error:
            "An active BAA already exists for this counterparty. Edit the existing row, or terminate it before adding a new one.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, agreement: data });
}

export async function PATCH(req: NextRequest) {
  const organizationId = getOrgId(req);
  const id = req.nextUrl.searchParams.get("id");
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }
  if (!id) {
    return NextResponse.json({ error: "?id=<agreementId> is required" }, { status: 400 });
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

  if ("counterparty_name" in body) {
    if (typeof body.counterparty_name !== "string" || body.counterparty_name.trim().length === 0) {
      errors.counterparty_name = "counterparty_name must be a non-empty string.";
    } else {
      patch.counterparty_name = (body.counterparty_name as string).trim();
    }
  }
  if ("status" in body) {
    if (!isOneOf(body.status, STATUSES)) {
      errors.status = `status must be one of: ${STATUSES.join(", ")}.`;
    } else {
      patch.status = body.status;
    }
  }
  for (const f of ["signed_at", "effective_at", "expires_at"] as const) {
    if (f in body) {
      const parsed = parseDateOrNull(body[f], f, errors);
      if (!(f in errors)) patch[f] = parsed ?? null;
    }
  }
  for (const f of ["contact_name", "contact_email", "document_url", "notes"] as const) {
    if (f in body) patch[f] = body[f] === null ? null : typeof body[f] === "string" ? body[f] : null;
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed.", fields: errors }, { status: 422 });
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No updatable fields provided." }, { status: 400 });
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("business_associate_agreements")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, agreement: data });
}
