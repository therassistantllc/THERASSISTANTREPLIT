import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

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

  const { data, error } = await supabase
    .from("service_locations")
    .select(
      "id, name, location_type, place_of_service_code, address_line1, address_city, " +
      "address_state, address_zip, phone, fax, npi, is_default, is_active, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("name", { ascending: true });

  if (error) {
    console.error("[GET /api/settings/service-locations]", error);
    return NextResponse.json({ error: "Failed to load service locations" }, { status: 500 });
  }

  return NextResponse.json({ service_locations: data ?? [] });
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

  if (!body.name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("service_locations")
    .insert({
      organization_id: organizationId,
      name: String(body.name),
      location_type: String(body.location_type ?? "office"),
      place_of_service_code: String(body.place_of_service_code ?? "11"),
      address_line1: body.address_line1 ? String(body.address_line1) : null,
      address_city: body.address_city ? String(body.address_city) : null,
      address_state: body.address_state ? String(body.address_state) : null,
      address_zip: body.address_zip ? String(body.address_zip) : null,
      phone: body.phone ? String(body.phone) : null,
      fax: body.fax ? String(body.fax) : null,
      npi: body.npi ? String(body.npi) : null,
      is_default: Boolean(body.is_default ?? false),
      is_active: Boolean(body.is_active ?? true),
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[POST /api/settings/service-locations]", error);
    return NextResponse.json({ error: "Failed to create service location" }, { status: 500 });
  }

  return NextResponse.json({ success: true, id: data.id }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const organizationId = getOrgId(req);
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id query parameter required" }, { status: 400 });
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

  const allowedFields = [
    "name", "location_type", "place_of_service_code", "address_line1",
    "address_city", "address_state", "address_zip", "phone", "fax",
    "npi", "is_default", "is_active",
  ] as const;

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (field in body) updates[field] = body[field];
  }
  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from("service_locations")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    console.error("[PATCH /api/settings/service-locations]", error);
    return NextResponse.json({ error: "Failed to update service location" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
