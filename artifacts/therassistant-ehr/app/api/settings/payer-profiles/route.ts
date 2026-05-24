import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { normalizePayerBillingRules } from "@/lib/validation/claim/facts";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
/**
 * Coerce arbitrary client input into the canonical billing-rules shape so we
 * never persist unexpected keys / types into the jsonb column. Re-uses the
 * same normalizer the validation engine consumes, guaranteeing the rules
 * surface in the engine exactly as written here.
 */
/**
 * Coerce caller input for the per-payer adjudication SLA. Returns:
 *   - a finite integer in [1, 365] when valid
 *   - null when the field is absent / blank (caller wants the default)
 *   - "invalid" when present but unparseable / out of range
 */
function coerceAdjudicationSlaDays(raw: unknown): number | null | "invalid" {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return "invalid";
  const i = Math.floor(n);
  if (i < 1 || i > 365) return "invalid";
  return i;
}

function sanitizeBillingRules(raw: unknown): Record<string, unknown> {
  const r = normalizePayerBillingRules(raw);
  return {
    requires_telehealth_modifier: r.requires_telehealth_modifier,
    allowed_pos_codes: r.allowed_pos_codes,
    requires_rendering_provider_taxonomy: r.requires_rendering_provider_taxonomy,
    requires_subscriber_relationship: r.requires_subscriber_relationship,
    timely_filing_days: r.timely_filing_days,
    allowed_cpt_codes: r.allowed_cpt_codes,
    denied_cpt_codes: r.denied_cpt_codes,
  };
}


export async function GET(req: NextRequest) {
  const guard = await requireOrgAccess({
    requestedOrganizationId: req.nextUrl.searchParams.get("organizationId"),
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("payer_profiles")
    .select(
      "id, payer_name, availity_payer_id, payer_type, is_active, notes, requires_authorization, billing_rules, fax_number, claims_phone, claims_fax, provider_services_phone, adjudication_sla_days, created_at, updated_at" as any,
    )
    .eq("organization_id", organizationId)
    .order("payer_name", { ascending: true });

  if (error) {
    console.error("[GET /api/settings/payer-profiles]", error);
    return NextResponse.json({ error: "Failed to load payer profiles" }, { status: 500 });
  }

  return NextResponse.json({ payers: data ?? [] });
}

export async function POST(req: NextRequest) {
  const guard = await requireOrgAccess({
    requestedOrganizationId: req.nextUrl.searchParams.get("organizationId"),
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

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

  if (!body.payer_name || !body.availity_payer_id) {
    return NextResponse.json({ error: "payer_name and availity_payer_id are required" }, { status: 400 });
  }

  const slaParsed = coerceAdjudicationSlaDays(body.adjudication_sla_days);
  if (slaParsed === "invalid") {
    return NextResponse.json(
      { error: "adjudication_sla_days must be an integer between 1 and 365" },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("payer_profiles")
    .insert({
      organization_id: organizationId,
      payer_name: String(body.payer_name),
      availity_payer_id: String(body.availity_payer_id),
      payer_type: body.payer_type ? String(body.payer_type) : null,
      is_active: Boolean(body.is_active ?? true),
      notes: body.notes ? String(body.notes) : null,
      requires_authorization: Boolean(body.requires_authorization ?? false),
      fax_number: body.fax_number ? String(body.fax_number) : null,
      claims_phone: body.claims_phone ? String(body.claims_phone) : null,
      claims_fax: body.claims_fax ? String(body.claims_fax) : null,
      provider_services_phone: body.provider_services_phone
        ? String(body.provider_services_phone)
        : null,
      billing_rules: sanitizeBillingRules(body.billing_rules),
      ...(slaParsed != null ? { adjudication_sla_days: slaParsed } : {}),
      created_at: now,
      updated_at: now,
    } as any)
    .select("id")
    .single();

  if (error) {
    console.error("[POST /api/settings/payer-profiles]", error);
    return NextResponse.json({ error: "Failed to create payer profile" }, { status: 500 });
  }

  return NextResponse.json({ success: true, id: data.id }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const guard = await requireOrgAccess({
    requestedOrganizationId: req.nextUrl.searchParams.get("organizationId"),
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

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
    "payer_name",
    "availity_payer_id",
    "payer_type",
    "is_active",
    "notes",
    "requires_authorization",
    "fax_number",
    "claims_phone",
    "claims_fax",
    "provider_services_phone",
  ] as const;
  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (field in body) updates[field] = body[field];
  }
  if ("billing_rules" in body) {
    updates.billing_rules = sanitizeBillingRules(body.billing_rules);
  }
  if ("adjudication_sla_days" in body) {
    const sla = coerceAdjudicationSlaDays(body.adjudication_sla_days);
    if (sla === "invalid") {
      return NextResponse.json(
        { error: "adjudication_sla_days must be an integer between 1 and 365" },
        { status: 400 },
      );
    }
    if (sla != null) updates.adjudication_sla_days = sla;
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
  const guard = await requireOrgAccess({
    requestedOrganizationId: req.nextUrl.searchParams.get("organizationId"),
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

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
