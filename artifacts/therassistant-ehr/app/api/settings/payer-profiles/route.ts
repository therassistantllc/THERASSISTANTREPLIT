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
    .from("payer_profiles")
    .select("id, payer_name, office_ally_payer_id, payer_type, is_active, notes, created_at, updated_at")
    .eq("organization_id", organizationId)
    .order("payer_name", { ascending: true });

  if (error) {
    console.error("[GET /api/settings/payer-profiles]", error);
    return NextResponse.json({ error: "Failed to load payer profiles" }, { status: 500 });
  }

  return NextResponse.json({ payers: data ?? [] });
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

  if (!body.payer_name || !body.office_ally_payer_id) {
    return NextResponse.json({ error: "payer_name and office_ally_payer_id are required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("payer_profiles")
    .insert({
      organization_id: organizationId,
      payer_name: String(body.payer_name),
      office_ally_payer_id: String(body.office_ally_payer_id),
      payer_type: body.payer_type ? String(body.payer_type) : null,
      is_active: Boolean(body.is_active ?? true),
      notes: body.notes ? String(body.notes) : null,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[POST /api/settings/payer-profiles]", error);
    return NextResponse.json({ error: "Failed to create payer profile" }, { status: 500 });
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

  const allowedFields = ["payer_name", "office_ally_payer_id", "payer_type", "is_active", "notes"] as const;
  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (field in body) updates[field] = body[field];
  }
  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from("payer_profiles")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    console.error("[PATCH /api/settings/payer-profiles]", error);
    return NextResponse.json({ error: "Failed to update payer profile" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
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

  // Soft-delete via is_active = false rather than hard delete
  const { error } = await supabase
    .from("payer_profiles")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    console.error("[DELETE /api/settings/payer-profiles]", error);
    return NextResponse.json({ error: "Failed to deactivate payer profile" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
