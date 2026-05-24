import type {
  Availity837PValidationResult,
  AvailityConnection,
  ClaimPartiesSnapshot,
  Generated837PBatch,
  ProfessionalClaim,
  ProfessionalClaimServiceLine,
} from "./types";
import { validateAvaility837PClaim } from "./validate837p";
import {
  X12,
  buildSegment,
  countSegments,
  formatDateYYYYMMDD,
  formatMoney,
  generateControlNumber,
  sanitizeX12,
} from "./x12";
import {
  deriveCobFromClaim,
  emitClaimCobLoops,
  emitServiceLineCobLoops,
} from "./cobSegments";

export interface MultiClaimBatchClaimInput {
  claim: ProfessionalClaim;
  serviceLines: ProfessionalClaimServiceLine[];
  parties: ClaimPartiesSnapshot;
  payerProfile: {
    id: string;
    organization_id: string;
    payer_name: string;
    availity_payer_id: string;
    payer_type?: string | null;
    is_active?: boolean | null;
    notes?: string | null;
  };
}

export interface MultiClaimBatchInput {
  connection: AvailityConnection;
  submitterName: string;
  claims: MultiClaimBatchClaimInput[];
  fileNameOverride?: string | null;
  now?: Date;
}

function formatTimeHHmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDateYYMMDD(date: Date): string {
  return formatDateYYYYMMDD(date).slice(2);
}

function padIsaId(value: string): string {
  return value.padEnd(15, " ").slice(0, 15);
}

function formatZip(zip: string | null | undefined): string {
  return sanitizeX12(zip).replace(/\s+/g, "");
}

function toPointerList(line: ProfessionalClaimServiceLine): string {
  const pointers = (line.diagnosis_pointers ?? ["1"]).slice(0, 4).map((p) => sanitizeX12(p));
  return pointers.join(X12.componentSeparator);
}

function toProcedureComposite(line: ProfessionalClaimServiceLine): string {
  const modifiers = (line.modifiers ?? []).filter(Boolean).slice(0, 4).map((m) => sanitizeX12(m));
  return ["HC", sanitizeX12(line.procedure_code), ...modifiers].join(X12.componentSeparator);
}

function makeFileName(timestamp: Date): string {
  const yyyyMMdd = formatDateYYYYMMDD(timestamp);
  const hhmmss =
    `${String(timestamp.getHours()).padStart(2, "0")}` +
    `${String(timestamp.getMinutes()).padStart(2, "0")}` +
    `${String(timestamp.getSeconds()).padStart(2, "0")}`;
  return `THERASSISTANT_837P_${yyyyMMdd}_${hhmmss}.837`;
}

function mergeValidation(results: Availity837PValidationResult[]): Availity837PValidationResult {
  const errors = results.flatMap((r) => r.errors);
  const warnings = results.flatMap((r) => r.warnings);
  return { isValid: errors.length === 0, errors, warnings };
}

interface BuildClaimContext {
  claim: ProfessionalClaim;
  serviceLines: ProfessionalClaimServiceLine[];
  parties: ClaimPartiesSnapshot;
  payerProfile: MultiClaimBatchClaimInput["payerProfile"];
  hlCounter: { value: number };
}

function emitClaimSegments(ctx: BuildClaimContext): string[] {
  const segments: string[] = [];
  const { claim, serviceLines, parties, payerProfile, hlCounter } = ctx;

  // Loop 2000A — Billing Provider HL
  const billingHl = hlCounter.value;
  hlCounter.value += 1;
  segments.push(buildSegment(["HL", billingHl, "", "20", "1"]));

  segments.push(
    buildSegment([
      "NM1",
      "85",
      sanitizeX12(parties.billing_provider_entity_type),
      sanitizeX12(parties.billing_provider_name),
      parties.billing_provider_entity_type === "1" ? sanitizeX12(parties.billing_provider_first_name) : "",
      "",
      "",
      "",
      "XX",
      sanitizeX12(parties.billing_provider_npi),
    ]),
  );
  segments.push(buildSegment(["N3", sanitizeX12(parties.billing_provider_address1)]));
  segments.push(
    buildSegment([
      "N4",
      sanitizeX12(parties.billing_provider_city),
      sanitizeX12(parties.billing_provider_state),
      formatZip(parties.billing_provider_zip),
    ]),
  );
  segments.push(
    buildSegment([
      "REF",
      sanitizeX12(parties.billing_provider_tax_id_type),
      sanitizeX12(parties.billing_provider_tax_id),
    ]),
  );

  // Loop 2000B — Subscriber HL
  const hasPatientLoop = !parties.patient_is_subscriber;
  const subscriberHl = hlCounter.value;
  hlCounter.value += 1;
  segments.push(buildSegment(["HL", subscriberHl, billingHl, "22", hasPatientLoop ? "1" : "0"]));
  // SBR01 responsibility code: 'S' when this claim is destined for the
  // SECONDARY payer (child cloned from a primary-paid claim), otherwise 'P'.
  const destinationResponsibility = claim.cob_billing_role === "secondary" ? "S" : "P";
  segments.push(
    buildSegment(["SBR", destinationResponsibility, "18", "", "", "", "", "", "", "CI"]),
  );

  segments.push(
    buildSegment([
      "NM1",
      "IL",
      "1",
      sanitizeX12(parties.subscriber_last_name),
      sanitizeX12(parties.subscriber_first_name),
      "",
      "",
      "",
      "MI",
      sanitizeX12(parties.subscriber_member_id),
    ]),
  );
  segments.push(buildSegment(["N3", sanitizeX12(parties.subscriber_address1)]));
  segments.push(
    buildSegment([
      "N4",
      sanitizeX12(parties.subscriber_city),
      sanitizeX12(parties.subscriber_state),
      formatZip(parties.subscriber_zip),
    ]),
  );
  segments.push(
    buildSegment([
      "DMG",
      "D8",
      formatDateYYYYMMDD(parties.subscriber_dob),
      parties.subscriber_gender ? sanitizeX12(parties.subscriber_gender) : "",
    ]),
  );

  segments.push(
    buildSegment([
      "NM1",
      "PR",
      "2",
      sanitizeX12(parties.payer_name || payerProfile.payer_name),
      "",
      "",
      "",
      "",
      "PI",
      sanitizeX12(parties.payer_id || payerProfile.availity_payer_id),
    ]),
  );

  // Loop 2000C — Patient HL (optional)
  if (hasPatientLoop) {
    const patientHl = hlCounter.value;
    hlCounter.value += 1;
    segments.push(buildSegment(["HL", patientHl, subscriberHl, "23", "0"]));
    segments.push(buildSegment(["PAT", "19"]));
    segments.push(
      buildSegment([
        "NM1",
        "QC",
        "1",
        sanitizeX12(parties.patient_last_name),
        sanitizeX12(parties.patient_first_name),
      ]),
    );
    segments.push(buildSegment(["N3", sanitizeX12(parties.patient_address1)]));
    segments.push(
      buildSegment([
        "N4",
        sanitizeX12(parties.patient_city),
        sanitizeX12(parties.patient_state),
        formatZip(parties.patient_zip),
      ]),
    );
    segments.push(
      buildSegment([
        "DMG",
        "D8",
        formatDateYYYYMMDD(parties.patient_dob || ""),
        sanitizeX12(parties.patient_gender),
      ]),
    );
  }

  // 2300 CLM
  const totalCharge = formatMoney(Number(claim.total_charge ?? 0));
  const claimPos = sanitizeX12(claim.place_of_service || serviceLines[0]?.place_of_service || "");
  // CLM05-3 Claim Frequency Code: '1' original, '7' replacement, '8' void.
  // Defaults to '1' when missing. Corrected children produced by the
  // /api/billing/corrected-claims action persist '7' or '8' here.
  const claimFrequency = sanitizeX12(claim.claim_frequency_code || "1") || "1";
  segments.push(
    buildSegment([
      "CLM",
      sanitizeX12(claim.patient_account_number),
      totalCharge,
      "",
      "",
      `${claimPos}${X12.componentSeparator}B${X12.componentSeparator}${claimFrequency}`,
      claim.accept_assignment === false ? "N" : "Y",
      "A",
      claim.release_of_information === false ? "N" : "Y",
      claim.signature_on_file === false ? "N" : "Y",
    ]),
  );

  // 2300 REF*F8 — Payer Claim Control Number (original claim ICN). Required
  // on corrected/void resubmissions (frequency 7/8) so the payer can tie the
  // replacement to the original claim instead of rejecting it as a duplicate.
  if (claimFrequency === "7" || claimFrequency === "8") {
    const originalIcn = sanitizeX12(claim.original_payer_claim_control_number ?? "");
    if (originalIcn) {
      segments.push(buildSegment(["REF", "F8", originalIcn]));
    }
  }

  if (claim.prior_authorization_number) {
    segments.push(buildSegment(["REF", "G1", sanitizeX12(claim.prior_authorization_number)]));
  }

  const diagnosisCodes = (claim.diagnosis_codes ?? []).filter(Boolean).slice(0, 12);
  diagnosisCodes.forEach((code, index) => {
    const qualifier = index === 0 ? "ABK" : "ABF";
    segments.push(
      buildSegment(["HI", `${qualifier}${X12.componentSeparator}${sanitizeX12(code).replace(/\./g, "")}`]),
    );
  });

  if (parties.rendering_same_as_billing === false) {
    segments.push(
      buildSegment([
        "NM1",
        "82",
        sanitizeX12(parties.rendering_provider_entity_type || "1"),
        sanitizeX12(parties.rendering_provider_last_name_or_org),
        parties.rendering_provider_entity_type === "1" ? sanitizeX12(parties.rendering_provider_first_name) : "",
        "",
        "",
        "",
        "XX",
        sanitizeX12(parties.rendering_provider_npi),
      ]),
    );
  }

  if (parties.service_facility_same_as_billing === false) {
    segments.push(
      buildSegment([
        "NM1",
        "77",
        "2",
        sanitizeX12(parties.service_facility_name),
        "",
        "",
        "",
        "",
        parties.service_facility_npi ? "XX" : "",
        sanitizeX12(parties.service_facility_npi),
      ]),
    );
    segments.push(buildSegment(["N3", sanitizeX12(parties.service_facility_address1)]));
    segments.push(
      buildSegment([
        "N4",
        sanitizeX12(parties.service_facility_city),
        sanitizeX12(parties.service_facility_state),
        formatZip(parties.service_facility_zip),
      ]),
    );
  }

  // Loop 2320/2330A/2330B — primary payer adjudication summary.
  // Emitted only for child claims with `cob_billing_role='secondary'` whose
  // billSecondary stamping populated prior_payer_eob_data with the primary
  // subscriber/payer identifying fields. Without these loops the secondary
  // payer rejects the claim as "missing other payer information."
  const cobPrimary = deriveCobFromClaim(claim);
  if (cobPrimary) {
    for (const seg of emitClaimCobLoops(cobPrimary)) segments.push(seg);
  }

  serviceLines.forEach((line, index) => {
    segments.push(buildSegment(["LX", index + 1]));
    segments.push(
      buildSegment([
        "SV1",
        toProcedureComposite(line),
        formatMoney(Number(line.charge_amount)),
        "UN",
        Number(line.units),
        sanitizeX12(line.place_of_service || claim.place_of_service),
        "",
        toPointerList(line),
      ]),
    );
    segments.push(buildSegment(["DTP", "472", "D8", formatDateYYYYMMDD(line.service_date_from)]));
    // Loop 2430 — per-line ERA breakdown (SVD/CAS/DTP*573). Emits only
    // when the stored ERA service_lines array has a matching row.
    if (cobPrimary) {
      for (const seg of emitServiceLineCobLoops(line, cobPrimary)) segments.push(seg);
    }
  });

  return segments;
}

export function generateAvaility837PMultiClaimBatch(input: MultiClaimBatchInput): Generated837PBatch {
  if (!input.claims.length) {
    throw new Error("Availity 837P batch requires at least one claim");
  }

  const perClaimValidations = input.claims.map((entry) =>
    validateAvaility837PClaim({
      connection: input.connection,
      submitterName: input.submitterName,
      claim: entry.claim,
      serviceLines: entry.serviceLines,
      parties: entry.parties,
      payerProfile: entry.payerProfile,
    }),
  );
  const validation = mergeValidation(perClaimValidations);
  if (!validation.isValid) {
    const message = validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    throw new Error(`Availity 837P validation failed: ${message}`);
  }

  const { connection } = input;
  const now = input.now ?? new Date();

  const isaControlNumber = generateControlNumber(9);
  const gsControlNumber = String(Number(isaControlNumber));
  const stControlNumber = generateControlNumber(4);
  const batchControl = generateControlNumber(8);

  const receiverId = sanitizeX12(connection.receiver_id || "030240928") || "030240928";
  const receiverName = sanitizeX12(connection.receiver_name || "Availity") || "Availity";
  const gsReceiverCode = sanitizeX12(connection.gs_receiver_code || "030240928") || "030240928";
  const usageIndicator = connection.mode === "test" ? "T" : "P";

  const isaDate = formatDateYYMMDD(now);
  const gsDate = formatDateYYYYMMDD(now);
  const time = formatTimeHHmm(now);

  const segments: string[] = [];

  segments.push(
    [
      "ISA",
      "00",
      "          ",
      "00",
      "          ",
      sanitizeX12(connection.sender_qualifier || "ZZ"),
      padIsaId(sanitizeX12(connection.submitter_id)),
      sanitizeX12(connection.receiver_qualifier || "30"),
      padIsaId(receiverId),
      isaDate,
      time,
      X12.repetitionSeparator,
      "00501",
      isaControlNumber,
      "0",
      usageIndicator,
      X12.componentSeparator,
    ].join(X12.elementSeparator) + X12.segmentTerminator,
  );

  segments.push(
    buildSegment([
      "GS",
      "HC",
      sanitizeX12(connection.submitter_id),
      gsReceiverCode,
      gsDate,
      time,
      gsControlNumber,
      "X",
      "005010X222A1",
    ]),
  );

  segments.push(buildSegment(["ST", "837", stControlNumber, "005010X222A1"]));
  segments.push(buildSegment(["BHT", "0019", "00", batchControl, gsDate, time, "CH"]));

  segments.push(
    buildSegment([
      "NM1",
      "41",
      "2",
      sanitizeX12(input.submitterName),
      "",
      "",
      "",
      "",
      "46",
      sanitizeX12(connection.submitter_id),
    ]),
  );

  const perPhone = (connection.submitter_contact_phone ?? "").replace(/\D/g, "").slice(0, 20);
  const perEmail = sanitizeX12(connection.submitter_contact_email ?? "").slice(0, 80);
  const perEls: string[] = ["PER", "IC", sanitizeX12(input.submitterName)];
  if (perPhone) perEls.push("TE", perPhone);
  if (perEmail) perEls.push("EM", perEmail);
  segments.push(buildSegment(perEls));

  segments.push(buildSegment(["NM1", "40", "2", receiverName, "", "", "", "", "46", receiverId]));

  const hlCounter = { value: 1 };
  for (const entry of input.claims) {
    segments.push(
      ...emitClaimSegments({
        claim: entry.claim,
        serviceLines: entry.serviceLines,
        parties: entry.parties,
        payerProfile: entry.payerProfile,
        hlCounter,
      }),
    );
  }

  const messageWithoutTrailer = segments.join("");
  const segmentCount = countSegments(messageWithoutTrailer, true) + 1;
  segments.push(buildSegment(["SE", segmentCount, stControlNumber]));
  segments.push(buildSegment(["GE", 1, gsControlNumber]));
  segments.push(buildSegment(["IEA", 1, isaControlNumber]));

  const fileContent = segments.join("");
  const fileName = input.fileNameOverride?.trim() || makeFileName(now);

  return {
    batchType: "837P",
    notes: "Availity Batch EDI Companion Guide v.20260429 envelope (ISA08=030240928, 1000B NM103=Availity).",
    mode: connection.mode,
    fileName,
    fileContent,
    claimCount: input.claims.length,
    isaControlNumber,
    gsControlNumber,
    stControlNumber,
    validation,
  };
}
