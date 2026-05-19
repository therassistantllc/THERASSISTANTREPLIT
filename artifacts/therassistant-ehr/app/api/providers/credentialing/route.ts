import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

const CREDENTIALING_SELECT =
  "id, provider_name, credential_display, individual_npi, email, practice_name, practice_address, practice_tax_id, group_npi, group_medicaid_id, phone, taxonomy_code, individual_medicaid_id, caqh_id, other_payer_id, primary_license_number, primary_license_effective_date, payer_effective_date, payer_revalidation_date, secondary_license_number, secondary_license_effective_date, is_active, updated_at";

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("provider_credentialing_profiles")
      .select(CREDENTIALING_SELECT)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("practice_name", { ascending: true })
      .order("provider_name", { ascending: true });

    if (error) throw error;

    return NextResponse.json({ success: true, organizationId, providers: data ?? [] });
  } catch (error) {
    console.error("Provider credentialing API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Provider credentialing API failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const organizationId =
      searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    if (!body.provider_name) {
      return NextResponse.json({ success: false, error: "provider_name is required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("provider_credentialing_profiles")
      .insert({
        organization_id: organizationId,
        source: String(body.source ?? "manual"),
        provider_name: String(body.provider_name),
        credential_display: body.credential_display ? String(body.credential_display) : null,
        individual_npi: body.individual_npi ? String(body.individual_npi) : null,
        email: body.email ? String(body.email) : null,
        practice_name: body.practice_name ? String(body.practice_name) : null,
        practice_address: body.practice_address ? String(body.practice_address) : null,
        practice_tax_id: body.practice_tax_id ? String(body.practice_tax_id) : null,
        group_npi: body.group_npi ? String(body.group_npi) : null,
        group_medicaid_id: body.group_medicaid_id ? String(body.group_medicaid_id) : null,
        individual_medicaid_id: body.individual_medicaid_id ? String(body.individual_medicaid_id) : null,
        phone: body.phone ? String(body.phone) : null,
        taxonomy_code: body.taxonomy_code ? String(body.taxonomy_code) : null,
        caqh_id: body.caqh_id ? String(body.caqh_id) : null,
        other_payer_id: body.other_payer_id ? String(body.other_payer_id) : null,
        primary_license_number: body.primary_license_number ? String(body.primary_license_number) : null,
        primary_license_effective_date: body.primary_license_effective_date
          ? String(body.primary_license_effective_date) : null,
        secondary_license_number: body.secondary_license_number ? String(body.secondary_license_number) : null,
        secondary_license_effective_date: body.secondary_license_effective_date
          ? String(body.secondary_license_effective_date) : null,
        payer_effective_date: body.payer_effective_date ? String(body.payer_effective_date) : null,
        payer_revalidation_date: body.payer_revalidation_date ? String(body.payer_revalidation_date) : null,
        is_active: Boolean(body.is_active ?? true),
        created_at: now,
        updated_at: now,
      })
      .select(CREDENTIALING_SELECT)
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, provider: data }, { status: 201 });
  } catch (error) {
    console.error("Provider credentialing POST error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create credentialing profile" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const organizationId =
      searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
    const id = searchParams.get("id");

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }
    if (!id) {
      return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
    }

    const body = (await request.json()) as Record<string, unknown>;

    const allowedFields = [
      "provider_name", "credential_display", "individual_npi", "email",
      "practice_name", "practice_address", "practice_tax_id", "group_npi",
      "group_medicaid_id", "individual_medicaid_id", "phone", "taxonomy_code",
      "caqh_id", "other_payer_id", "primary_license_number",
      "primary_license_effective_date", "secondary_license_number",
      "secondary_license_effective_date", "payer_effective_date",
      "payer_revalidation_date", "is_active",
    ] as const;

    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in body) updates[field] = body[field];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("provider_credentialing_profiles")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select(CREDENTIALING_SELECT)
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, provider: data });
  } catch (error) {
    console.error("Provider credentialing PATCH error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to update credentialing profile" },
      { status: 500 },
    );
  }
}
