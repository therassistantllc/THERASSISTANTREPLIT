import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { requireRoleInRoute } from "@/lib/rbac/middleware";
import { STAFF_ROLES } from "@/lib/rbac/constants";

const DEMO_ORG_ID = "11111111-1111-1111-1111-111111111111";

export async function POST() {
  // Require admin role — this endpoint performs privileged service-role writes
  const authOrError = await requireRoleInRoute(STAFF_ROLES.ADMIN);
  if (authOrError instanceof NextResponse) return authOrError;

  // Enforce tenant isolation: only seed the authenticated user's own org
  const { organizationId } = authOrError;
  if (organizationId !== DEMO_ORG_ID) {
    return NextResponse.json(
      { success: false, error: "This seed endpoint is only available for the demo organization." },
      { status: 403 },
    );
  }

  const supabase = createServerSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json(
      {
        success: false,
        error:
          "SUPABASE_SERVICE_ROLE_KEY is required. Add it to Replit Secrets and restart the dev server.",
      },
      { status: 503 },
    );
  }

  const results: Record<string, string> = {};
  const errors: Record<string, string> = {};

  // ── 1. Organization ──────────────────────────────────────────────────────────
  {
    const now = new Date().toISOString();
    const { error } = await supabase.from("organizations").upsert(
      {
        id: DEMO_ORG_ID,
        name: "Sunrise Behavioral Health",
        legal_name: "Sunrise Behavioral Health LLC",
        slug: "sunrise-behavioral-health",
        default_state: "CO",
        timezone: "America/Denver",
        tax_id_last4: "4832",
        is_active: true,
        created_at: now,
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (error) errors.organization = error.message;
    else results.organization = "upserted";
  }

  // ── 2. Billing profile (system_settings) ────────────────────────────────────
  {
    const now = new Date().toISOString();
    const { error } = await supabase.from("system_settings").upsert(
      {
        organization_id: DEMO_ORG_ID,
        setting_key: "organization.billing_profile",
        setting_value: {
          billing_provider_name: "Sunrise Behavioral Health LLC",
          billing_provider_npi: "1234567890",
          billing_tax_id: "823456789",
          billing_tax_id_type: "EIN",
          billing_phone: "(303) 555-0100",
          default_pos: "11",
          billing_address_line1: "4501 E Colfax Ave",
          billing_address_line2: "Suite 200",
          billing_city: "Denver",
          billing_state: "CO",
          billing_zip: "80220",
        },
        updated_at: now,
        created_at: now,
      },
      { onConflict: "organization_id,setting_key" },
    );
    if (error) errors.billing_profile = error.message;
    else results.billing_profile = "upserted";
  }

  // ── 3. Billing defaults (system_settings) ───────────────────────────────────
  {
    const now = new Date().toISOString();
    const { error } = await supabase.from("system_settings").upsert(
      {
        organization_id: DEMO_ORG_ID,
        setting_key: "billing.defaults",
        setting_value: {
          claim_frequency_code: "1",
          default_pos: "11",
          default_diagnosis_behavior: "first_encounter",
          default_procedure_charge_behavior: "manual",
          eligibility_recheck_days: 30,
          claim_hold_days: 3,
          aging_bucket_rules: "30/60/90/120",
          auto_route_missing_info: true,
        },
        updated_at: now,
        created_at: now,
      },
      { onConflict: "organization_id,setting_key" },
    );
    if (error) errors.billing_defaults = error.message;
    else results.billing_defaults = "upserted";
  }

  // ── 4. Service locations ─────────────────────────────────────────────────────
  {
    const now = new Date().toISOString();
    const locations = [
      {
        organization_id: DEMO_ORG_ID,
        name: "Main Office – Denver",
        location_type: "office",
        place_of_service_code: "11",
        npi: "1234567890",
        address_line1: "4501 E Colfax Ave",
        address_city: "Denver",
        address_state: "CO",
        address_zip: "80220",
        phone: "(303) 555-0100",
        fax: "(303) 555-0199",
        is_default: true,
        is_active: true,
        created_at: now,
        updated_at: now,
      },
      {
        organization_id: DEMO_ORG_ID,
        name: "Telehealth – Colorado",
        location_type: "telehealth",
        place_of_service_code: "02",
        npi: "1234567890",
        address_line1: null,
        address_city: "Denver",
        address_state: "CO",
        address_zip: null,
        phone: "(303) 555-0100",
        fax: null,
        is_default: false,
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    ];

    const { data: existing } = await supabase
      .from("service_locations")
      .select("id")
      .eq("organization_id", DEMO_ORG_ID)
      .is("archived_at", null)
      .limit(1);

    if (!existing || existing.length === 0) {
      const { error } = await supabase.from("service_locations").insert(locations);
      if (error) errors.service_locations = error.message;
      else results.service_locations = `inserted ${locations.length}`;
    } else {
      results.service_locations = "already exists";
    }
  }

  // ── 5. Payer configurations ──────────────────────────────────────────────────
  {
    const now = new Date().toISOString();
    const payers = [
      {
        organization_id: DEMO_ORG_ID,
        payer_id: "BCBSCO",
        payer_name: "Blue Cross Blue Shield of Colorado",
        payer_aliases: ["BCBS Colorado", "Anthem BCBS CO"],
        supported_transactions: ["270", "271", "276", "277", "837P", "835"],
        states: ["CO"],
        source: "manual",
        environment: "demo",
        is_active: true,
        notes: "Primary commercial payer – Colorado",
        created_at: now,
        updated_at: now,
      },
      {
        organization_id: DEMO_ORG_ID,
        payer_id: "AETNA",
        payer_name: "Aetna",
        payer_aliases: ["Aetna Inc.", "Aetna Health"],
        supported_transactions: ["270", "271", "837P", "835"],
        states: ["CO", "WY"],
        source: "manual",
        environment: "demo",
        is_active: true,
        notes: null,
        created_at: now,
        updated_at: now,
      },
      {
        organization_id: DEMO_ORG_ID,
        payer_id: "COMDCD",
        payer_name: "Colorado Medicaid (HCPF)",
        payer_aliases: ["CO Medicaid", "HCPF"],
        supported_transactions: ["270", "271", "837P", "835"],
        states: ["CO"],
        source: "manual",
        environment: "demo",
        is_active: true,
        notes: "State Medicaid – mental health carve-in",
        created_at: now,
        updated_at: now,
      },
    ];

    let inserted = 0;
    for (const payer of payers) {
      const { data: existingPayer } = await supabase
        .from("payer_configurations")
        .select("id")
        .eq("organization_id", DEMO_ORG_ID)
        .eq("payer_id", payer.payer_id)
        .maybeSingle();

      if (existingPayer) { inserted++; continue; }

      const { error } = await supabase.from("payer_configurations").insert(payer);
      if (error && !errors.payer_configurations) {
        errors.payer_configurations = error.message;
      } else {
        inserted++;
      }
    }
    if (!errors.payer_configurations) {
      results.payer_configurations = `seeded ${inserted}`;
    }
  }

  // ── 6. Clearinghouse connection ──────────────────────────────────────────────
  {
    const now = new Date().toISOString();

    const { data: existing } = await supabase
      .from("clearinghouse_connections")
      .select("id")
      .eq("organization_id", DEMO_ORG_ID)
      .limit(1);

    if (!existing || existing.length === 0) {
      const { error } = await supabase.from("clearinghouse_connections").insert({
        organization_id: DEMO_ORG_ID,
        vendor: "office_ally",
        connection_name: "Office Ally – Production",
        mode: "test",
        submitter_id: "SBH2024",
        sender_qualifier: "ZZ",
        receiver_qualifier: "ZZ",
        receiver_id: "330897513",
        receiver_name: "OFFICEALLY",
        gs_receiver_code: "OA",
        x12_version: "005010X222A1",
        isa_usage_indicator: "P",
        sftp_host: "sftp.officeally.com",
        sftp_port: 22,
        sftp_username: "sunrise_bh",
        inbound_folder: "inbound",
        outbound_folder: "outbound",
        api_base_url: "https://api.officeally.com",
        auth_type: "sftp_key",
        eligibility_service_type_code: "MH",
        eligibility_transaction_set: "270",
        is_active: true,
        encrypted_credentials: {},
        created_at: now,
        updated_at: now,
      });
      if (error) errors.clearinghouse = error.message;
      else results.clearinghouse = "inserted";
    } else {
      results.clearinghouse = "already exists";
    }
  }

  const hasErrors = Object.keys(errors).length > 0;

  return NextResponse.json(
    {
      success: !hasErrors,
      seeded_by: authOrError.staffId,
      seeded_at: new Date().toISOString(),
      results,
      ...(hasErrors ? { errors } : {}),
    },
    { status: hasErrors ? 207 : 200 },
  );
}
