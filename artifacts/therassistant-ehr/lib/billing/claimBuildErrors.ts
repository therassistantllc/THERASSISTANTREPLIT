/**
 * Shared mapping for the Claim Build Errors workqueue.
 *
 * Translates Claim Content Validation rule findings into the seven tabs
 * defined by the workqueue spec (Missing Provider Data, Missing Payer ID,
 * Missing Diagnosis, Invalid Modifier, Invalid POS, Missing NPI/Taxonomy,
 * Invalid Client Data), and into the human-readable "Missing field" and
 * "Field location" (837P loop/segment) shown in the row table.
 *
 * The same validation engine that powers the per-claim readiness panel
 * (lib/validation/claim/runClaimContentValidation.ts) is the source of
 * truth — so a finding that blocks build is identically classified here
 * and on the panel.
 */

export type BuildErrorTabId =
  | "missing_provider_data"
  | "missing_payer_id"
  | "missing_diagnosis"
  | "invalid_modifier"
  | "invalid_pos"
  | "missing_npi_taxonomy"
  | "invalid_client_data";

export const BUILD_ERROR_TABS: Array<{ id: BuildErrorTabId; label: string }> = [
  { id: "missing_provider_data", label: "Missing Provider Data" },
  { id: "missing_payer_id", label: "Missing Payer ID" },
  { id: "missing_diagnosis", label: "Missing Diagnosis" },
  { id: "invalid_modifier", label: "Invalid Modifier" },
  { id: "invalid_pos", label: "Invalid POS" },
  { id: "missing_npi_taxonomy", label: "Missing NPI/Taxonomy" },
  { id: "invalid_client_data", label: "Invalid Client Data" },
];

export interface RuleMeta {
  tab: BuildErrorTabId;
  errorType: string;
  missingField: string;
  fieldLocation: string;
}

/**
 * Mapping table: ruleId → tab + display strings. Any finding whose
 * ruleId is not in this map falls through to "invalid_client_data" with
 * generic strings so a new rule doesn't silently disappear.
 */
const RULE_META: Record<string, RuleMeta> = {
  "claim.missing_diagnosis": {
    tab: "missing_diagnosis",
    errorType: "Missing diagnosis",
    missingField: "Diagnosis codes",
    fieldLocation: "Loop 2300 / HI",
  },
  "claim.missing_service_line": {
    tab: "invalid_client_data",
    errorType: "No service lines",
    missingField: "Service lines",
    fieldLocation: "Loop 2400 / SV1",
  },
  "claim.service_line_missing_cpt": {
    tab: "invalid_client_data",
    errorType: "Missing procedure code",
    missingField: "Procedure code (CPT/HCPCS)",
    fieldLocation: "Loop 2400 / SV101-2",
  },
  "claim.future_dos": {
    tab: "invalid_client_data",
    errorType: "Future date of service",
    missingField: "Service date",
    fieldLocation: "Loop 2400 / DTP*472",
  },
  "claim.missing_rendering_provider": {
    tab: "missing_npi_taxonomy",
    errorType: "Missing rendering provider NPI",
    missingField: "Rendering provider NPI",
    fieldLocation: "Loop 2310B / NM109",
  },
  "claim.missing_subscriber_member_id": {
    tab: "missing_payer_id",
    errorType: "Missing subscriber member ID",
    missingField: "Subscriber / member ID",
    fieldLocation: "Loop 2010BA / NM109",
  },
  "claim.missing_payer": {
    tab: "missing_payer_id",
    errorType: "Missing payer profile",
    missingField: "Payer profile",
    fieldLocation: "Loop 2010BB / NM103",
  },
  "claim.missing_service_location": {
    tab: "missing_provider_data",
    errorType: "Missing service facility",
    missingField: "Service location",
    fieldLocation: "Loop 2310C / N3",
  },
  "claim.missing_place_of_service": {
    tab: "invalid_pos",
    errorType: "Missing place of service",
    missingField: "Place of service",
    fieldLocation: "Loop 2300 / CLM05-1",
  },
  "claim.telehealth_missing_modifier": {
    tab: "invalid_modifier",
    errorType: "Missing telehealth modifier",
    missingField: "Telehealth modifier (95/GT/GQ/FQ)",
    fieldLocation: "Loop 2400 / SV1-2",
  },
  "claim.payer_requires_authorization_missing": {
    tab: "invalid_client_data",
    errorType: "Missing prior authorization",
    missingField: "Authorization number",
    fieldLocation: "Loop 2300 / REF*G1",
  },
  "claim.payer_disallowed_pos": {
    tab: "invalid_pos",
    errorType: "Disallowed place of service",
    missingField: "Place of service",
    fieldLocation: "Loop 2300 / CLM05-1",
  },
  "claim.payer_denied_cpt": {
    tab: "invalid_modifier",
    errorType: "Payer-denied procedure code",
    missingField: "Procedure code (CPT/HCPCS)",
    fieldLocation: "Loop 2400 / SV101-2",
  },
  "claim.payer_disallowed_cpt": {
    tab: "invalid_modifier",
    errorType: "Procedure not in payer allow-list",
    missingField: "Procedure code (CPT/HCPCS)",
    fieldLocation: "Loop 2400 / SV101-2",
  },
  "claim.payer_timely_filing_exceeded": {
    tab: "invalid_client_data",
    errorType: "Timely filing exceeded",
    missingField: "Service date",
    fieldLocation: "Loop 2400 / DTP*472",
  },
  "claim.payer_subscriber_relationship_missing": {
    tab: "invalid_client_data",
    errorType: "Subscriber relationship missing",
    missingField: "Client identity (last name / DOB)",
    fieldLocation: "Loop 2010CA / NM103",
  },
  "claim.payer_rendering_taxonomy_missing": {
    tab: "missing_npi_taxonomy",
    errorType: "Missing rendering provider taxonomy",
    missingField: "Rendering provider taxonomy",
    fieldLocation: "Loop 2310B / PRV*PXC",
  },
};

export function describeRule(ruleId: string): RuleMeta {
  return (
    RULE_META[ruleId] ?? {
      tab: "invalid_client_data",
      errorType: "Validation error",
      missingField: "—",
      fieldLocation: "—",
    }
  );
}

export function tabLabel(id: BuildErrorTabId): string {
  return BUILD_ERROR_TABS.find((t) => t.id === id)?.label ?? id;
}

/** Sentinel value written to defer_until when a claim is held by a biller. */
export const BUILD_HOLD_DEFER_UNTIL = "9999-12-31";

export const DEFERRED_REASON_HOLD = "claim_build_hold";
export const DEFERRED_REASON_ROUTED = "routed_to_admin";
