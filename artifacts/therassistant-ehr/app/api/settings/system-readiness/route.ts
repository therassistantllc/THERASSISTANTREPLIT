import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";

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

  const supabase = createServerSupabaseAdminClientTyped();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  const [
    orgRes,
    providersRes,
    serviceLocsRes,
    payerProfilesRes,
    clearinghouseRes,
    billingDefaultsRes,
    feeScheduleRes,
  ] = await Promise.all([
    supabase
      .from("organizations")
      .select("id, name, legal_name, is_active")
      .eq("id", organizationId)
      .maybeSingle(),
    supabase
      .from("providers")
      .select("id, first_name, last_name, npi, taxonomy_code, is_active")
      .eq("organization_id", organizationId)
      .is("archived_at", null),
    supabase
      .from("service_locations")
      .select("id, name, is_active")
      .eq("organization_id", organizationId)
      .is("archived_at", null),
    supabase
      .from("payer_profiles")
      .select("id, payer_name, is_active")
      .eq("organization_id", organizationId)
      .eq("is_active", true),
    supabase
      .from("clearinghouse_connections")
      .select("id, submitter_id, receiver_id, eligibility_service_type_code, is_active, encrypted_credentials")
      .eq("organization_id", organizationId),
    supabase
      .from("system_settings")
      .select("setting_value")
      .eq("organization_id", organizationId)
      .eq("setting_key", "organization.billing_profile")
      .maybeSingle(),
    supabase
      .from("fee_schedules")
      .select("id")
      .eq("organization_id", organizationId)
      .limit(1),
  ]);

  const org = orgRes.data;
  const providers = providersRes.data ?? [];
  const serviceLocations = serviceLocsRes.data ?? [];
  const payerProfiles = payerProfilesRes.data ?? [];
  const clearinghouseConnections = clearinghouseRes.data ?? [];
  const billingProfile =
    billingDefaultsRes.data?.setting_value &&
    typeof billingDefaultsRes.data.setting_value === "object" &&
    !Array.isArray(billingDefaultsRes.data.setting_value)
      ? (billingDefaultsRes.data.setting_value as Record<string, unknown>)
      : {};
  const hasFeeSchedule = (feeScheduleRes.data ?? []).length > 0;

  const activeProviders = providers.filter((p) => p.is_active);
  const providersWithNpi = providers.filter((p) => p.npi && p.taxonomy_code);
  const activeServiceLocs = serviceLocations.filter((l) => l.is_active);
  const activeConnection = clearinghouseConnections.find((c) => c.is_active);

  const checks = [
    {
      key: "org_billing_profile",
      label: "Organization billing profile configured",
      pass:
        !!(org?.name) &&
        !!(billingProfile.billing_provider_npi || (billingProfile as Record<string, unknown>).billing_tax_id),
      detail: org?.name ? "Organization exists" : "No organization found",
    },
    {
      key: "active_provider",
      label: "At least one active provider",
      pass: activeProviders.length > 0,
      detail: `${activeProviders.length} active provider(s)`,
    },
    {
      key: "provider_npi_taxonomy",
      label: "Provider has NPI and taxonomy code",
      pass: providersWithNpi.length > 0,
      detail: `${providersWithNpi.length} provider(s) with NPI + taxonomy`,
    },
    {
      key: "service_location",
      label: "At least one active service location",
      pass: activeServiceLocs.length > 0,
      detail: `${activeServiceLocs.length} active service location(s)`,
    },
    {
      key: "payer_profile",
      label: "At least one active payer profile",
      pass: payerProfiles.length > 0,
      detail: `${payerProfiles.length} active payer profile(s)`,
    },
    {
      key: "clearinghouse_connection",
      label: "Clearinghouse connection exists",
      pass: clearinghouseConnections.length > 0,
      detail: `${clearinghouseConnections.length} connection(s) configured`,
    },
    {
      key: "submitter_id",
      label: "Clearinghouse submitter ID configured",
      pass: clearinghouseConnections.some((c) => !!c.submitter_id),
      detail: activeConnection?.submitter_id ? `Submitter ID: ${activeConnection.submitter_id}` : "Submitter ID missing",
    },
    {
      key: "receiver_id",
      label: "Clearinghouse receiver ID configured",
      pass: clearinghouseConnections.some((c) => !!c.receiver_id),
      detail: activeConnection?.receiver_id ? `Receiver ID: ${activeConnection.receiver_id}` : "Receiver ID missing",
    },
    {
      key: "eligibility_service_type",
      label: "Eligibility service type code defaults to 98",
      pass: clearinghouseConnections.some((c) => c.eligibility_service_type_code === "98"),
      detail: activeConnection
        ? `Service type code: ${activeConnection.eligibility_service_type_code}`
        : "No active connection",
    },
    {
      key: "fee_schedule_or_billing_defaults",
      label: "Fee schedule or billing defaults configured",
      pass: hasFeeSchedule,
      detail: hasFeeSchedule ? "Fee schedule found" : "No fee schedules configured",
    },
  ];

  const warnings = [
    {
      key: "duplicate_claims_tables",
      label: "Duplicate claims tables: claims and professional_claims both exist",
      type: "info" as const,
      detail: "Use claims for standard billing; professional_claims for EDI 837P. Ensure claim generation targets the correct table.",
    },
    {
      key: "duplicate_checkin_tables",
      label: "Duplicate check-in tables: patient_checkins and patient_check_ins both exist",
      type: "info" as const,
      detail: "Verify that your check-in workflow writes to the canonical table. The other may be a legacy OpenMRS migration artifact.",
    },
    {
      key: "duplicate_encounter_note_tables",
      label: "Duplicate encounter note tables: encounter_notes, encounter_clinical_notes, custom_client_note all exist",
      type: "info" as const,
      detail: "Standardize encounter note creation to one canonical table. Custom tables may remain for legacy workflows.",
    },
    {
      key: "mailroom_dual_status",
      label: "Mailroom: both status and mail_status columns exist",
      type: "info" as const,
      detail: "New writes should use mail_status as the canonical value. Configure mailroom settings to clarify routing.",
    },
  ];

  const passCount = checks.filter((c) => c.pass).length;

  return NextResponse.json({
    organization_id: organizationId,
    org_name: org?.name ?? null,
    checks,
    warnings,
    summary: {
      total: checks.length,
      passed: passCount,
      failed: checks.length - passCount,
      ready: passCount === checks.length,
    },
  });
}
