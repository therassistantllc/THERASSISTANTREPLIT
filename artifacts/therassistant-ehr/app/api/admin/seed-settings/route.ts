import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { requireRoleInRoute } from "@/lib/rbac/middleware";
import { STAFF_ROLES } from "@/lib/rbac/constants";
import { ORGANIZATION_ID as DEMO_ORG_ID } from "@/lib/config";

// Fixed UUID for the seeded chat "Test User" so re-seeding is idempotent and
// existing conversations / chat_participants rows keep referencing the same id.
const DEMO_TEST_USER_ID = "00000000-0000-4000-8000-000000000777";

export async function POST(request: NextRequest) {
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

  // Parse optional force flag from request body
  let force = false;
  try {
    const body = await request.json();
    force = !!body?.force;
  } catch {
    // No body or invalid JSON — treat as non-force seed
  }

  const results: Record<string, string> = {};
  const errors: Record<string, string> = {};

  // ── Force reset: delete existing demo records before re-inserting ──────────
  if (force) {
    const deleteResults = await Promise.all([
      supabase.from("service_locations").delete().eq("organization_id", DEMO_ORG_ID),
      supabase.from("payer_configurations").delete().eq("organization_id", DEMO_ORG_ID),
      supabase.from("clearinghouse_connections").delete().eq("organization_id", DEMO_ORG_ID),
    ]);

    const deleteErrors: string[] = [];
    if (deleteResults[0].error) deleteErrors.push(`service_locations: ${deleteResults[0].error.message}`);
    if (deleteResults[1].error) deleteErrors.push(`payer_configurations: ${deleteResults[1].error.message}`);
    if (deleteResults[2].error) deleteErrors.push(`clearinghouse_connections: ${deleteResults[2].error.message}`);

    if (deleteErrors.length > 0) {
      return NextResponse.json(
        { success: false, error: `Reset failed — could not clear existing data: ${deleteErrors.join("; ")}` },
        { status: 500 },
      );
    }

    // Clear ERA / payment demo data in FK-safe order so it can be re-seeded
    // alongside the existing billing data. Order matters: dependents first.
    const eraDeleteOrder = [
      "patient_invoice_payments",
      "patient_invoices",
      "era_posting_ledger_entries",
      "era_claim_payments",
      "era_import_batches",
    ] as const;
    const eraDeleteErrors: string[] = [];
    for (const table of eraDeleteOrder) {
      const { error } = await supabase.from(table).delete().eq("organization_id", DEMO_ORG_ID);
      if (error) eraDeleteErrors.push(`${table}: ${error.message}`);
    }
    if (eraDeleteErrors.length > 0) {
      return NextResponse.json(
        { success: false, error: `Reset failed — could not clear ERA/payment data: ${eraDeleteErrors.join("; ")}` },
        { status: 500 },
      );
    }
  }

  const actionLabel = force ? "re-seeded" : "inserted";

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

    if (force) {
      // Records already deleted above — always insert fresh
      const { error } = await supabase.from("service_locations").insert(locations);
      if (error) errors.service_locations = error.message;
      else results.service_locations = `${actionLabel} ${locations.length}`;
    } else {
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
        notes: "",
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

    if (force) {
      // Records already deleted above — insert all fresh
      const { error } = await supabase.from("payer_configurations").insert(payers);
      if (error) errors.payer_configurations = error.message;
      else results.payer_configurations = `${actionLabel} ${payers.length}`;
    } else {
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
  }

  // ── 6. Clearinghouse connection ──────────────────────────────────────────────
  {
    const now = new Date().toISOString();

    if (force) {
      // Records already deleted above — insert fresh
      const { error } = await supabase.from("clearinghouse_connections").insert({
        organization_id: DEMO_ORG_ID,
        vendor: "availity",
        connection_name: "Availity – Production",
        mode: "test",
        submitter_id: "SBH2024",
        sender_qualifier: "ZZ",
        receiver_qualifier: "ZZ",
        receiver_id: "030240928",
        receiver_name: "Availity",
        gs_receiver_code: "030240928",
        x12_version: "005010X222A1",
        isa_usage_indicator: "P",
        sftp_host: "files.availity.com",
        sftp_port: 22,
        sftp_username: "sunrise_bh",
        inbound_folder: "inbound",
        outbound_folder: "outbound",
        api_base_url: "https://api.availity.com",
        auth_type: "sftp_key",
        eligibility_service_type_code: "MH",
        eligibility_transaction_set: "270",
        is_active: true,
        encrypted_credentials: {},
        created_at: now,
        updated_at: now,
      });
      if (error) errors.clearinghouse = error.message;
      else results.clearinghouse = actionLabel;
    } else {
      const { data: existing } = await supabase
        .from("clearinghouse_connections")
        .select("id")
        .eq("organization_id", DEMO_ORG_ID)
        .limit(1);

      if (!existing || existing.length === 0) {
        const { error } = await supabase.from("clearinghouse_connections").insert({
          organization_id: DEMO_ORG_ID,
          vendor: "availity",
          connection_name: "Availity – Production",
          mode: "test",
          submitter_id: "SBH2024",
          sender_qualifier: "ZZ",
          receiver_qualifier: "ZZ",
          receiver_id: "330897513",
          receiver_name: "AVAILITY",
          gs_receiver_code: "OA",
          x12_version: "005010X222A1",
          isa_usage_indicator: "P",
          sftp_host: "files.availity.com",
          sftp_port: 22,
          sftp_username: "sunrise_bh",
          inbound_folder: "inbound",
          outbound_folder: "outbound",
          api_base_url: "https://api.availity.com",
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
  }

  // ── 6b. Chat demo "Test User" profile ───────────────────────────────────────
  // A seeded peer so a single-user demo account can exercise the Chat flow
  // (start conversation, send message, see presence). Idempotent: re-running
  // simply re-upserts the same fixed-UUID row.
  {
    const now = new Date().toISOString();
    const { error } = await supabase.from("profiles").upsert(
      {
        id: DEMO_TEST_USER_ID,
        organization_id: DEMO_ORG_ID,
        email: "test-user@demo.local",
        full_name: "Test User (Demo)",
        role: "clinician",
        credentials: "Demo Account",
        is_active: true,
        notification_email: false,
        notification_sms: false,
        created_at: now,
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (error) errors.chat_test_user = error.message;
    else results.chat_test_user = "upserted";
  }

  // ── 7. ERA / payment demo data (force mode only) ────────────────────────────
  // Only re-seed when the operator explicitly requested a reset. The data here
  // references demo claims/clients seeded by scripts/seed-billing-data.mjs; if
  // those don't exist yet we skip rather than fail.
  if (force) {
    const eraSeedResult = await reseedEraPaymentDemoData(supabase);
    Object.assign(results, eraSeedResult.results);
    Object.assign(errors, eraSeedResult.errors);
  }

  const hasErrors = Object.keys(errors).length > 0;

  return NextResponse.json(
    {
      success: !hasErrors,
      reset: force,
      seeded_by: authOrError.staffId,
      seeded_at: new Date().toISOString(),
      results,
      ...(hasErrors ? { errors } : {}),
    },
    { status: hasErrors ? 207 : 200 },
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// ERA / payment demo data re-seed
// ────────────────────────────────────────────────────────────────────────────────
// Fixed UUIDs — must match scripts/seed-billing-data.mjs so the data lines up
// with the existing professional_claims / clients seeded by that script.
const DEMO_IDS = {
  C1: "cc100001-0000-0000-0000-000000000001",
  C2: "cc100001-0000-0000-0000-000000000002",
  C4: "cc100001-0000-0000-0000-000000000004",
  C5: "cc100001-0000-0000-0000-000000000005",
  PC1: "ac400001-0000-0000-0000-000000000001",
  PC2: "ac400001-0000-0000-0000-000000000002",
  PC3: "ac400001-0000-0000-0000-000000000003",
  PC4: "ac400001-0000-0000-0000-000000000004",
  EB1: "eb700001-0000-0000-0000-000000000001",
  EB2: "eb700001-0000-0000-0000-000000000002",
  EB3: "eb700001-0000-0000-0000-000000000003",
  EB4: "eb700001-0000-0000-0000-000000000004",
  EB5: "eb700001-0000-0000-0000-000000000005",
  ECP1: "ec800001-0000-0000-0000-000000000001",
  ECP2: "ec800001-0000-0000-0000-000000000002",
  ECP3: "ec800001-0000-0000-0000-000000000003",
  ECP4: "ec800001-0000-0000-0000-000000000004",
  ECP5: "ec800001-0000-0000-0000-000000000005",
  PI1: "fa900001-0000-0000-0000-000000000001",
  PI2: "fa900001-0000-0000-0000-000000000002",
  PI3: "fa900001-0000-0000-0000-000000000003",
  PIP1: "fe000001-0000-0000-0000-000000000001",
  PIP2: "fe000001-0000-0000-0000-000000000002",
} as const;

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}
function dateAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reseedEraPaymentDemoData(supabase: any): Promise<{
  results: Record<string, string>;
  errors: Record<string, string>;
}> {
  const results: Record<string, string> = {};
  const errors: Record<string, string> = {};

  // Pre-flight: make sure the referenced demo claims exist. If not, we can't
  // build valid ERA rows (FKs would fail), so we surface a skip instead.
  const requiredClaimIds = [DEMO_IDS.PC1, DEMO_IDS.PC2, DEMO_IDS.PC3, DEMO_IDS.PC4];
  const { data: existingClaims, error: claimLookupError } = await supabase
    .from("professional_claims")
    .select("id")
    .eq("organization_id", DEMO_ORG_ID)
    .in("id", requiredClaimIds);

  if (claimLookupError) {
    errors.era_payment_data = `claim lookup failed: ${claimLookupError.message}`;
    return { results, errors };
  }
  if (!existingClaims || existingClaims.length < requiredClaimIds.length) {
    results.era_payment_data =
      "skipped — demo claims not found (run scripts/seed-billing-data.mjs first)";
    return { results, errors };
  }

  // 1. era_import_batches
  const importBatches = [
    {
      id: DEMO_IDS.EB1,
      organization_id: DEMO_ORG_ID,
      source: "clearinghouse",
      file_name: "835_BCBS_20260501_001.edi",
      raw_content: "ISA*00*...~CLP*CLM-2026-004*1*210.00*168.00*42.00*MC*BCBS-PC4-0001~",
      parsed_summary: { payer: "BlueCross BlueShield", payer_id: "BCBS", check_number: "ACH-20260501-001", payment_date: dateAgoStr(18), claim_count: 1 },
      import_status: "posted",
      total_claims: 1,
      total_payment_amount: 168.0,
      total_patient_responsibility: 42.0,
      imported_at: daysAgoIso(18),
    },
    {
      id: DEMO_IDS.EB2,
      organization_id: DEMO_ORG_ID,
      source: "clearinghouse",
      file_name: "835_UHC_20260504_001.edi",
      raw_content: "ISA*00*...~CLP*CLM-2026-002*1*175.00*140.00*35.00*MC*UHC-PC2-0001~",
      parsed_summary: { payer: "United Healthcare", payer_id: "UHC", check_number: "ACH-20260504-002", payment_date: dateAgoStr(15), claim_count: 1 },
      import_status: "posted",
      total_claims: 1,
      total_payment_amount: 140.0,
      total_patient_responsibility: 35.0,
      imported_at: daysAgoIso(15),
    },
    {
      id: DEMO_IDS.EB3,
      organization_id: DEMO_ORG_ID,
      source: "clearinghouse",
      file_name: "835_AETNA_20260502_001.edi",
      raw_content: "ISA*00*...~CLP*CLM-2026-003*4*145.00*0.00*0.00*MC*AETNA-PC3-0001~",
      parsed_summary: { payer: "Aetna", payer_id: "AETNA", check_number: "N/A-DENIAL", payment_date: dateAgoStr(17), claim_count: 1, denial_count: 1 },
      import_status: "posted",
      total_claims: 1,
      total_payment_amount: 0.0,
      total_patient_responsibility: 0.0,
      imported_at: daysAgoIso(17),
    },
    {
      id: DEMO_IDS.EB4,
      organization_id: DEMO_ORG_ID,
      source: "clearinghouse",
      file_name: "835_BCBS_20260509_002.edi",
      raw_content: "ISA*00*...~CLP*CLM-2026-001*1*145.00*116.00*29.00*MC*BCBS-PC1-0001~",
      parsed_summary: { payer: "BlueCross BlueShield", payer_id: "BCBS", check_number: "ACH-20260509-004", payment_date: dateAgoStr(10), claim_count: 1 },
      import_status: "matched",
      total_claims: 1,
      total_payment_amount: 116.0,
      total_patient_responsibility: 29.0,
      imported_at: daysAgoIso(10),
    },
    {
      id: DEMO_IDS.EB5,
      organization_id: DEMO_ORG_ID,
      source: "manual_upload",
      file_name: "835_CIGNA_20260514_001.edi",
      raw_content: "ISA*00*...~CLP*CLM-2026-CIGNA-001*1*195.00*156.00*39.00*MC*CIGNA-EXT-0001~",
      parsed_summary: { payer: "Cigna Behavioral Health", payer_id: "CIGNA", check_number: "ACH-20260514-005", payment_date: dateAgoStr(5), claim_count: 1, note: "External claim — no matching local claim found." },
      import_status: "blocked",
      total_claims: 1,
      total_payment_amount: 156.0,
      total_patient_responsibility: 39.0,
      imported_at: daysAgoIso(5),
    },
  ];
  {
    const { error } = await supabase.from("era_import_batches").insert(importBatches);
    if (error) errors.era_import_batches = error.message;
    else results.era_import_batches = `re-seeded ${importBatches.length}`;
  }

  // 2. era_claim_payments
  const claimPayments = [
    {
      id: DEMO_IDS.ECP1,
      organization_id: DEMO_ORG_ID,
      era_import_batch_id: DEMO_IDS.EB1,
      professional_claim_id: DEMO_IDS.PC4,
      client_id: DEMO_IDS.C1,
      clp01_claim_control_number: "CLM-2026-004",
      clp02_claim_status_code: "1",
      clp03_total_charge: 210.0,
      clp04_payment_amount: 168.0,
      clp05_patient_responsibility: 42.0,
      payer_claim_control_number: "BCBS-PC4-0001",
      claim_match_status: "matched",
      posting_status: "posted",
      cas_adjustments: [{ group_code: "CO", reason_code: "45", amount: 42.0, description: "Charges exceed fee schedule/maximum allowable" }],
      service_lines: [
        { procedure_code: "90837", charge: 175.0, allowed: 140.0, paid: 140.0, adjustment: 35.0, adjustment_code: "CO-45" },
        { procedure_code: "90785", charge: 35.0, allowed: 28.0, paid: 28.0, adjustment: 7.0, adjustment_code: "CO-45" },
      ],
      raw_segments: [],
    },
    {
      id: DEMO_IDS.ECP2,
      organization_id: DEMO_ORG_ID,
      era_import_batch_id: DEMO_IDS.EB2,
      professional_claim_id: DEMO_IDS.PC2,
      client_id: DEMO_IDS.C4,
      clp01_claim_control_number: "CLM-2026-002",
      clp02_claim_status_code: "1",
      clp03_total_charge: 175.0,
      clp04_payment_amount: 140.0,
      clp05_patient_responsibility: 35.0,
      payer_claim_control_number: "UHC-PC2-0001",
      claim_match_status: "matched",
      posting_status: "posted",
      cas_adjustments: [{ group_code: "CO", reason_code: "45", amount: 35.0, description: "Charges exceed fee schedule/maximum allowable" }],
      service_lines: [
        { procedure_code: "90837", charge: 175.0, allowed: 140.0, paid: 140.0, adjustment: 35.0, adjustment_code: "CO-45" },
      ],
      raw_segments: [],
    },
    {
      id: DEMO_IDS.ECP3,
      organization_id: DEMO_ORG_ID,
      era_import_batch_id: DEMO_IDS.EB3,
      professional_claim_id: DEMO_IDS.PC3,
      client_id: DEMO_IDS.C5,
      clp01_claim_control_number: "CLM-2026-003",
      clp02_claim_status_code: "4",
      clp03_total_charge: 145.0,
      clp04_payment_amount: 0.0,
      clp05_patient_responsibility: 0.0,
      payer_claim_control_number: "AETNA-PC3-0001",
      claim_match_status: "matched",
      posting_status: "posted",
      cas_adjustments: [{ group_code: "CO", reason_code: "97", amount: 145.0, description: "Payment is included in the allowance for another service/procedure" }],
      service_lines: [
        { procedure_code: "90834", charge: 145.0, allowed: 0.0, paid: 0.0, adjustment: 145.0, adjustment_code: "CO-97" },
      ],
      raw_segments: [],
    },
    {
      id: DEMO_IDS.ECP4,
      organization_id: DEMO_ORG_ID,
      era_import_batch_id: DEMO_IDS.EB4,
      professional_claim_id: DEMO_IDS.PC1,
      client_id: DEMO_IDS.C2,
      clp01_claim_control_number: "CLM-2026-001",
      clp02_claim_status_code: "1",
      clp03_total_charge: 145.0,
      clp04_payment_amount: 116.0,
      clp05_patient_responsibility: 29.0,
      payer_claim_control_number: "BCBS-PC1-0001",
      claim_match_status: "matched",
      posting_status: "ready",
      cas_adjustments: [{ group_code: "CO", reason_code: "45", amount: 29.0, description: "Charges exceed fee schedule/maximum allowable" }],
      service_lines: [
        { procedure_code: "90834", charge: 145.0, allowed: 116.0, paid: 116.0, adjustment: 29.0, adjustment_code: "CO-45" },
      ],
      raw_segments: [],
    },
    {
      id: DEMO_IDS.ECP5,
      organization_id: DEMO_ORG_ID,
      era_import_batch_id: DEMO_IDS.EB5,
      professional_claim_id: null,
      client_id: null,
      clp01_claim_control_number: "CLM-2026-CIGNA-001",
      clp02_claim_status_code: "1",
      clp03_total_charge: 195.0,
      clp04_payment_amount: 156.0,
      clp05_patient_responsibility: 39.0,
      payer_claim_control_number: "CIGNA-EXT-0001",
      claim_match_status: "unmatched",
      posting_status: "blocked",
      cas_adjustments: [{ group_code: "CO", reason_code: "45", amount: 39.0, description: "Charges exceed fee schedule/maximum allowable" }],
      service_lines: [
        { procedure_code: "90837", charge: 195.0, allowed: 156.0, paid: 156.0, adjustment: 39.0, adjustment_code: "CO-45" },
      ],
      raw_segments: [],
    },
  ];
  {
    const { error } = await supabase.from("era_claim_payments").insert(claimPayments);
    if (error) errors.era_claim_payments = error.message;
    else results.era_claim_payments = `re-seeded ${claimPayments.length}`;
  }

  // 3. era_posting_ledger_entries
  const ledgerRows = [
    { era_claim_payment_id: DEMO_IDS.ECP1, professional_claim_id: DEMO_IDS.PC4, client_id: DEMO_IDS.C1, entry_type: "insurance_payment",      amount: 168.0, group_code: null, reason_code: null, description: "BlueCross BlueShield payment — CLM-2026-004" },
    { era_claim_payment_id: DEMO_IDS.ECP1, professional_claim_id: DEMO_IDS.PC4, client_id: DEMO_IDS.C1, entry_type: "contractual_adjustment", amount: 42.0,  group_code: "CO", reason_code: "45", description: "Contractual write-off — charges exceed fee schedule" },
    { era_claim_payment_id: DEMO_IDS.ECP1, professional_claim_id: DEMO_IDS.PC4, client_id: DEMO_IDS.C1, entry_type: "patient_responsibility", amount: 42.0,  group_code: "PR", reason_code: "1",  description: "Client deductible/copay — billed via invoice INV-2026-001" },
    { era_claim_payment_id: DEMO_IDS.ECP2, professional_claim_id: DEMO_IDS.PC2, client_id: DEMO_IDS.C4, entry_type: "insurance_payment",      amount: 140.0, group_code: null, reason_code: null, description: "United Healthcare payment — CLM-2026-002" },
    { era_claim_payment_id: DEMO_IDS.ECP2, professional_claim_id: DEMO_IDS.PC2, client_id: DEMO_IDS.C4, entry_type: "contractual_adjustment", amount: 35.0,  group_code: "CO", reason_code: "45", description: "Contractual write-off — charges exceed fee schedule" },
    { era_claim_payment_id: DEMO_IDS.ECP2, professional_claim_id: DEMO_IDS.PC2, client_id: DEMO_IDS.C4, entry_type: "patient_responsibility", amount: 35.0,  group_code: "PR", reason_code: "3",  description: "Client deductible — billed via invoice INV-2026-002" },
    { era_claim_payment_id: DEMO_IDS.ECP3, professional_claim_id: DEMO_IDS.PC3, client_id: DEMO_IDS.C5, entry_type: "other_adjustment",       amount: 145.0, group_code: "CO", reason_code: "97", description: "Claim denied — CARC 97: service not covered" },
    { era_claim_payment_id: DEMO_IDS.ECP4, professional_claim_id: DEMO_IDS.PC1, client_id: DEMO_IDS.C2, entry_type: "insurance_payment",      amount: 116.0, group_code: null, reason_code: null, description: "BlueCross BlueShield payment — CLM-2026-001 (pending posting)" },
    { era_claim_payment_id: DEMO_IDS.ECP4, professional_claim_id: DEMO_IDS.PC1, client_id: DEMO_IDS.C2, entry_type: "contractual_adjustment", amount: 29.0,  group_code: "CO", reason_code: "45", description: "Contractual write-off — charges exceed fee schedule" },
    { era_claim_payment_id: DEMO_IDS.ECP4, professional_claim_id: DEMO_IDS.PC1, client_id: DEMO_IDS.C2, entry_type: "patient_responsibility", amount: 29.0,  group_code: "PR", reason_code: "3",  description: "Client deductible — invoice pending" },
  ].map((r) => ({ organization_id: DEMO_ORG_ID, ...r }));
  {
    const { error } = await supabase.from("era_posting_ledger_entries").insert(ledgerRows);
    if (error) errors.era_posting_ledger_entries = error.message;
    else results.era_posting_ledger_entries = `re-seeded ${ledgerRows.length}`;
  }

  // 4. patient_invoices
  const invoices = [
    { id: DEMO_IDS.PI1, organization_id: DEMO_ORG_ID, client_id: DEMO_IDS.C1, professional_claim_id: DEMO_IDS.PC4, era_claim_payment_id: DEMO_IDS.ECP1, invoice_status: "paid", invoice_number: "INV-2026-001", patient_responsibility_amount: 42.0, paid_amount: 42.0, balance_amount: 0.0,  source: "era_pr" },
    { id: DEMO_IDS.PI2, organization_id: DEMO_ORG_ID, client_id: DEMO_IDS.C4, professional_claim_id: DEMO_IDS.PC2, era_claim_payment_id: DEMO_IDS.ECP2, invoice_status: "sent", invoice_number: "INV-2026-002", patient_responsibility_amount: 35.0, paid_amount: 0.0,  balance_amount: 35.0, source: "era_pr" },
    { id: DEMO_IDS.PI3, organization_id: DEMO_ORG_ID, client_id: DEMO_IDS.C2, professional_claim_id: DEMO_IDS.PC1, era_claim_payment_id: DEMO_IDS.ECP4, invoice_status: "open", invoice_number: "INV-2026-003", patient_responsibility_amount: 29.0, paid_amount: 0.0,  balance_amount: 29.0, source: "era_pr" },
  ];
  {
    const { error } = await supabase.from("patient_invoices").insert(invoices);
    if (error) errors.patient_invoices = error.message;
    else results.patient_invoices = `re-seeded ${invoices.length}`;
  }

  // 5. patient_invoice_payments
  const invoicePayments = [
    { id: DEMO_IDS.PIP1, organization_id: DEMO_ORG_ID, patient_invoice_id: DEMO_IDS.PI1, client_id: DEMO_IDS.C1, payment_status: "posted", payment_method: "card",  amount: 42.0, memo: "Client copay — Sarah Johnson — CLM-2026-004 — card on file",            paid_at: daysAgoIso(8) },
    { id: DEMO_IDS.PIP2, organization_id: DEMO_ORG_ID, patient_invoice_id: DEMO_IDS.PI2, client_id: DEMO_IDS.C4, payment_status: "posted", payment_method: "check", amount: 20.0, memo: "Partial deductible payment — James Rivera — CLM-2026-002 — check #4421", paid_at: daysAgoIso(3) },
  ];
  {
    const { error } = await supabase.from("patient_invoice_payments").insert(invoicePayments);
    if (error) errors.patient_invoice_payments = error.message;
    else results.patient_invoice_payments = `re-seeded ${invoicePayments.length}`;
  }

  return { results, errors };
}
