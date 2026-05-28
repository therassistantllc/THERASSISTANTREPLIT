import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidNpi } from "./npi";
import { runConfigValidation } from "./runValidation";
import type { ValidationReport } from "./types";

/**
 * Validation-only "test claim simulation".
 *
 * Walks the same configuration the 837P generator would use, picks the first
 * viable row of each entity, and verifies they can be linked into a coherent
 * test claim. Uses a SYNTHETIC client/payload — no real PHI is read or
 * transmitted, no DB rows are written, and the clearinghouse adapter is never
 * invoked. The output is a report only.
 */

type SimulationStatus = "pass" | "fail" | "skipped";

interface SimulationCheck {
  id: string;
  label: string;
  status: SimulationStatus;
  detail: string;
}

export interface SimulationReport {
  organizationId: string;
  generatedAt: string;
  transmitted: false;
  containsPhi: false;
  configReady: boolean;
  configBlocking: number;
  simulationReady: boolean;
  checks: SimulationCheck[];
  chosenEntities: {
    providerId: string | null;
    providerName: string | null;
    locationId: string | null;
    locationName: string | null;
    payerId: string | null;
    payerName: string | null;
    feeScheduleRowId: string | null;
    feeScheduleCpt: string | null;
    clearinghouseId: string | null;
    clearinghouseVendor: string | null;
  };
  syntheticClaim: {
    patientName: "TEST, CLIENT";
    patientDob: "2000-01-01";
    memberId: "TEST-MEMBER-0001";
    serviceDate: string;
    cpt: string | null;
    chargeAmount: number | null;
    diagnosisCode: "Z00.00";
  };
  configReport: ValidationReport;
}

function pass(id: string, label: string, detail: string): SimulationCheck {
  return { id, label, status: "pass", detail };
}
function fail(id: string, label: string, detail: string): SimulationCheck {
  return { id, label, status: "fail", detail };
}
function skip(id: string, label: string, detail: string): SimulationCheck {
  return { id, label, status: "skipped", detail };
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function runTestClaimSimulation(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<SimulationReport> {
  const checks: SimulationCheck[] = [];
  const chosen: SimulationReport["chosenEntities"] = {
    providerId: null,
    providerName: null,
    locationId: null,
    locationName: null,
    payerId: null,
    payerName: null,
    feeScheduleRowId: null,
    feeScheduleCpt: null,
    clearinghouseId: null,
    clearinghouseVendor: null,
  };

  // 0. Run the configuration validation engine first.
  const configReport = await runConfigValidation(supabase, organizationId);
  const configBlocking = configReport.summary.blocking;
  const configReady = configBlocking === 0;

  if (configBlocking > 0) {
    checks.push(
      fail(
        "config.blocking",
        "Configuration validation",
        `${configBlocking} blocking finding${configBlocking === 1 ? "" : "s"} from the validation engine. ` +
          "Resolve every blocking item before a real claim could be generated.",
      ),
    );
  } else {
    checks.push(
      pass("config.blocking", "Configuration validation", "No blocking configuration findings."),
    );
  }

  // 1. Provider — NPI Luhn + taxonomy.
  const { data: providerRows, error: providerErr } = await supabase
    .from("providers")
    .select("id, first_name, last_name, npi, taxonomy_code, is_active, archived_at")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(50);
  if (providerErr) {
    checks.push(fail("provider", "Rendering provider", `providers query failed: ${providerErr.message}`));
  } else {
    const providers = providerRows ?? [];
    const provider = providers.find(
      (p) => isValidNpi(asStr(p.npi).replace(/\D/g, "")) && asStr(p.taxonomy_code).trim().length > 0,
    );
    if (!provider) {
      checks.push(
        fail(
          "provider",
          "Rendering provider",
          providers.length === 0
            ? "No active providers configured."
            : "No active provider has both a Luhn-valid NPI and a taxonomy code.",
        ),
      );
    } else {
      const name = `${asStr(provider.first_name)} ${asStr(provider.last_name)}`.trim() || "(unnamed)";
      chosen.providerId = asStr(provider.id);
      chosen.providerName = name;
      checks.push(
        pass(
          "provider",
          "Rendering provider",
          `Using "${name}" (NPI ${asStr(provider.npi)}, taxonomy ${asStr(provider.taxonomy_code)}).`,
        ),
      );
    }
  }

  // 2. Service location — address + POS.
  const { data: locationRows, error: locationErr } = await supabase
    .from("service_locations")
    .select(
      "id, name, address_line1, address_city, address_state, address_zip, place_of_service_code, is_active, archived_at",
    )
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(50);
  if (locationErr) {
    checks.push(fail("location", "Service location", `service_locations query failed: ${locationErr.message}`));
  } else {
    const locations = locationRows ?? [];
    const location = locations.find(
      (l) =>
        asStr(l.address_line1).trim() &&
        asStr(l.address_city).trim() &&
        /^[A-Z]{2}$/.test(asStr(l.address_state).trim()) &&
        /^\d{5}(-?\d{4})?$/.test(asStr(l.address_zip).trim()) &&
        /^\d{2}$/.test(asStr(l.place_of_service_code).trim()),
    );
    if (!location) {
      checks.push(
        fail(
          "location",
          "Service location",
          locations.length === 0
            ? "No active service locations configured."
            : "No active location has a complete address (street/city/state/ZIP) and a valid 2-digit POS code.",
        ),
      );
    } else {
      chosen.locationId = asStr(location.id);
      chosen.locationName = asStr(location.name);
      checks.push(
        pass(
          "location",
          "Service location",
          `Using "${chosen.locationName}" (POS ${asStr(location.place_of_service_code)}, ${asStr(location.address_city)}, ${asStr(location.address_state)}).`,
        ),
      );
    }
  }

  // 3. Payer.
  const { data: payerRows, error: payerErr } = await supabase
    .from("payer_profiles")
    .select("id, payer_name, availity_payer_id, payer_type, is_active")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("payer_name", { ascending: true })
    .order("id", { ascending: true })
    .limit(50);
  if (payerErr) {
    checks.push(fail("payer", "Payer profile", `payer_profiles query failed: ${payerErr.message}`));
  } else {
    const payers = payerRows ?? [];
    const payer = payers.find((p) => asStr(p.availity_payer_id).trim() && asStr(p.payer_type).trim());
    if (!payer) {
      checks.push(
        fail(
          "payer",
          "Payer profile",
          payers.length === 0
            ? "No active payer profiles configured."
            : "No active payer profile has both a payer_id and a payer_type.",
        ),
      );
    } else {
      chosen.payerId = asStr(payer.id);
      chosen.payerName = asStr(payer.payer_name);
      checks.push(
        pass(
          "payer",
          "Payer profile",
          `Using "${chosen.payerName}" (payer_id ${asStr(payer.availity_payer_id)}, type ${asStr(payer.payer_type)}).`,
        ),
      );
    }
  }

  // 4. Billing profile (system_settings row, key = organization.billing_profile).
  const { data: settingsRow, error: settingsErr } = await supabase
    .from("system_settings")
    .select("setting_value")
    .eq("organization_id", organizationId)
    .eq("setting_key", "organization.billing_profile")
    .maybeSingle();
  if (settingsErr) {
    checks.push(fail("billing_profile", "Billing profile", `system_settings query failed: ${settingsErr.message}`));
  } else {
    const profile =
      settingsRow?.setting_value && typeof settingsRow.setting_value === "object" && !Array.isArray(settingsRow.setting_value)
        ? (settingsRow.setting_value as Record<string, unknown>)
        : {};
    const npi = asStr(profile.billing_provider_npi).replace(/\D/g, "");
    const tax = asStr(profile.billing_tax_id).replace(/\D/g, "");
    const zip = asStr(profile.billing_zip).trim();
    const phone = asStr(profile.billing_phone).replace(/\D/g, "");
    const npiOk = npi.length === 10 && isValidNpi(npi);
    const taxOk = tax.length === 9;
    const zipOk = /^\d{5}(-?\d{4})?$/.test(zip);
    const phoneOk = phone.length === 10;
    if (!npiOk || !taxOk || !zipOk || !phoneOk) {
      const missing: string[] = [];
      if (!npiOk) missing.push("Luhn-valid NPI");
      if (!taxOk) missing.push("9-digit tax ID");
      if (!zipOk) missing.push("ZIP");
      if (!phoneOk) missing.push("10-digit phone");
      checks.push(
        fail(
          "billing_profile",
          "Billing profile",
          `Billing profile missing or invalid: ${missing.join(", ")}.`,
        ),
      );
    } else {
      checks.push(
        pass(
          "billing_profile",
          "Billing profile",
          `NPI, tax ID, ZIP, and phone present and well-formed.`,
        ),
      );
    }
  }

  // 5. Fee schedule — at least one row with allowed_amount > 0.
  const { data: feeRows, error: feeErr } = await supabase
    .from("fee_schedules")
    .select("id, procedure_code, allowed_amount, expiration_date, archived_at")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("procedure_code", { ascending: true })
    .order("id", { ascending: true })
    .limit(100);
  if (feeErr) {
    checks.push(fail("fee_schedule", "Fee schedule / CPT default fee", `fee_schedules query failed: ${feeErr.message}`));
  } else {
    const rows = feeRows ?? [];
    const today = new Date().toISOString().slice(0, 10);
    const row = rows.find(
      (r) =>
        Number(r.allowed_amount) > 0 &&
        asStr(r.procedure_code).trim() &&
        !(typeof r.expiration_date === "string" && r.expiration_date < today),
    );
    if (!row) {
      checks.push(
        fail(
          "fee_schedule",
          "Fee schedule / CPT default fee",
          rows.length === 0
            ? "No active fee schedule rows configured."
            : "No active fee schedule row has both a procedure code and a positive allowed amount.",
        ),
      );
    } else {
      chosen.feeScheduleRowId = asStr(row.id);
      chosen.feeScheduleCpt = asStr(row.procedure_code);
      checks.push(
        pass(
          "fee_schedule",
          "Fee schedule / CPT default fee",
          `Using CPT ${chosen.feeScheduleCpt} @ $${Number(row.allowed_amount).toFixed(2)}.`,
        ),
      );
    }
  }

  // 6. Clearinghouse — mirror the real 837P generator which only ships via
  //    the Availity adapter.
  const { data: chRows, error: chErr } = await supabase
    .from("clearinghouse_connections")
    .select("id, vendor, submitter_id, receiver_id, is_active")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .eq("vendor", "availity")
    .order("id", { ascending: true })
    .limit(20);
  if (chErr) {
    checks.push(fail("clearinghouse", "Clearinghouse", `clearinghouse_connections query failed: ${chErr.message}`));
  } else {
    const rows = chRows ?? [];
    const row = rows.find((r) => asStr(r.vendor).trim() && asStr(r.submitter_id).trim() && asStr(r.receiver_id).trim());
    if (!row) {
      checks.push(
        fail(
          "clearinghouse",
          "Clearinghouse",
          rows.length === 0
            ? "No active clearinghouse connection configured."
            : "Active clearinghouse connection is missing vendor / submitter_id / receiver_id.",
        ),
      );
    } else {
      chosen.clearinghouseId = asStr(row.id);
      chosen.clearinghouseVendor = asStr(row.vendor);
      checks.push(
        pass(
          "clearinghouse",
          "Clearinghouse",
          `Using ${chosen.clearinghouseVendor} (submitter ${asStr(row.submitter_id)} → receiver ${asStr(row.receiver_id)}).`,
        ),
      );
    }
  }

  // 7. Linkage check — every entity above must have resolved before we can
  //    say a hypothetical claim could be built end-to-end.
  const allResolved =
    chosen.providerId &&
    chosen.locationId &&
    chosen.payerId &&
    chosen.feeScheduleRowId &&
    chosen.clearinghouseId;
  if (allResolved && configReady) {
    checks.push(
      pass(
        "linkage",
        "End-to-end test-claim assembly",
        "All required entities resolved and linkable into a synthetic 837P. No transmission performed.",
      ),
    );
  } else {
    checks.push(
      skip(
        "linkage",
        "End-to-end test-claim assembly",
        "Skipped — one or more upstream checks failed. Resolve those first, then re-run the simulation.",
      ),
    );
  }

  const simulationReady = checks.every((c) => c.status === "pass");

  return {
    organizationId,
    generatedAt: new Date().toISOString(),
    transmitted: false,
    containsPhi: false,
    configReady,
    configBlocking,
    simulationReady,
    checks,
    chosenEntities: chosen,
    syntheticClaim: {
      patientName: "TEST, CLIENT",
      patientDob: "2000-01-01",
      memberId: "TEST-MEMBER-0001",
      serviceDate: new Date().toISOString().slice(0, 10),
      cpt: chosen.feeScheduleCpt,
      chargeAmount: null,
      diagnosisCode: "Z00.00",
    },
    configReport,
  };
}
