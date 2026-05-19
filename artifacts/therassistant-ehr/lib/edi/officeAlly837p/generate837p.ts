import type {
  Generated837PBatch,
  OfficeAlly837PGenerationInput,
  ProfessionalClaimServiceLine,
} from "./types";
import { validateOfficeAlly837PClaim } from "./validate837p";
import {
  X12,
  buildSegment,
  countSegments,
  formatDateYYYYMMDD,
  formatMoney,
  generateControlNumber,
  sanitizeX12,
} from "./x12";

function formatTimeHHmm(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}${mm}`;
}

function formatDateYYMMDD(date: Date): string {
  const yyyyMMdd = formatDateYYYYMMDD(date);
  return yyyyMMdd.slice(2);
}

function padIsaId(value: string): string {
  return value.padEnd(15, " ").slice(0, 15);
}

function formatZip(zip: string | null | undefined): string {
  return sanitizeX12(zip).replace(/\s+/g, "");
}

function toPointerList(line: ProfessionalClaimServiceLine): string {
  const pointers = (line.diagnosis_pointers ?? ["1"]).slice(0, 4).map((pointer) => sanitizeX12(pointer));
  return pointers.join(X12.componentSeparator);
}

function toProcedureComposite(line: ProfessionalClaimServiceLine): string {
  const modifiers = (line.modifiers ?? []).filter(Boolean).slice(0, 4).map((modifier) => sanitizeX12(modifier));
  return ["HC", sanitizeX12(line.procedure_code), ...modifiers].join(X12.componentSeparator);
}

function formatServiceDate(dateValue: string): string {
  return formatDateYYYYMMDD(dateValue);
}

function makeFileName(mode: "test" | "production", timestamp: Date): string {
  const yyyyMMdd = formatDateYYYYMMDD(timestamp);
  const hhmmss = `${String(timestamp.getHours()).padStart(2, "0")}${String(timestamp.getMinutes()).padStart(2, "0")}${String(timestamp.getSeconds()).padStart(2, "0")}`;

  if (mode === "test") {
    return `THERASSISTANT_OATEST_837P_${yyyyMMdd}_${hhmmss}.837`;
  }

  return `THERASSISTANT_837P_${yyyyMMdd}_${hhmmss}.837`;
}

export function generateOfficeAlly837PBatch(
  input: OfficeAlly837PGenerationInput,
): Generated837PBatch {
  const validation = validateOfficeAlly837PClaim(input);

  if (!validation.isValid) {
    const message = validation.errors.map((error) => `${error.field}: ${error.message}`).join("; ");
    throw new Error(`Office Ally 837P validation failed: ${message}`);
  }

  const { connection, parties, claim, serviceLines, payerProfile } = input;
  const now = new Date();

  const isaControlNumber = generateControlNumber(9);
  const gsControlNumber = String(Number(isaControlNumber));
  const stControlNumber = generateControlNumber(4);
  const batchControl = generateControlNumber(8);

  const segments: string[] = [];

  const receiverId = sanitizeX12(connection.receiver_id || "330897513") || "330897513";
  const receiverName = sanitizeX12(connection.receiver_name || "OFFICEALLY") || "OFFICEALLY";
  const gsReceiverCode = sanitizeX12(connection.gs_receiver_code || "OA") || "OA";
  const usageIndicator = connection.mode === "test" ? "T" : "P";

  const isaDate = formatDateYYMMDD(now);
  const gsDate = formatDateYYYYMMDD(now);
  const time = formatTimeHHmm(now);

  segments.push(
    [
      "ISA",
      "00",
      "",
      "00",
      "",
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

  segments.push(buildSegment(["NM1", "40", "2", receiverName, "", "", "", "", "46", receiverId]));

  segments.push(buildSegment(["HL", "1", "", "20", "1"]));

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

  const hasPatientLoop = !parties.patient_is_subscriber;

  segments.push(buildSegment(["HL", "2", "1", "22", hasPatientLoop ? "1" : "0"]));
  segments.push(buildSegment(["SBR", "P", "18", "", "", "", "", "", "", "CI"]));

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
      sanitizeX12(parties.payer_id || payerProfile.office_ally_payer_id),
    ]),
  );

  if (hasPatientLoop) {
    segments.push(buildSegment(["HL", "3", "2", "23", "0"]));
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

  const claimControlNumber = sanitizeX12(claim.claim_number || claim.id);
  const totalCharge = formatMoney(Number(claim.total_charge ?? 0));
  const claimPos = sanitizeX12(claim.place_of_service || serviceLines[0]?.place_of_service || "");

  segments.push(
    buildSegment([
      "CLM",
      sanitizeX12(claim.patient_account_number),
      totalCharge,
      "",
      "",
      `${claimPos}${X12.componentSeparator}B${X12.componentSeparator}1`,
      claim.accept_assignment === false ? "N" : "Y",
      "A",
      claim.release_of_information === false ? "N" : "Y",
      claim.signature_on_file === false ? "N" : "Y",
    ]),
  );

  if (claim.prior_authorization_number) {
    segments.push(buildSegment(["REF", "G1", sanitizeX12(claim.prior_authorization_number)]));
  }

  const diagnosisCodes = (claim.diagnosis_codes ?? []).filter(Boolean).slice(0, 12);
  diagnosisCodes.forEach((code, index) => {
    const qualifier = index === 0 ? "ABK" : "ABF";
    segments.push(buildSegment(["HI", `${qualifier}${X12.componentSeparator}${sanitizeX12(code).replace(/\./g, "")}`]));
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

    segments.push(buildSegment(["DTP", "472", "D8", formatServiceDate(line.service_date_from)]));
  });

  const messageWithoutTrailer = segments.join("");
  const segmentCount = countSegments(messageWithoutTrailer, true) + 1;
  segments.push(buildSegment(["SE", segmentCount, stControlNumber]));
  segments.push(buildSegment(["GE", 1, gsControlNumber]));
  segments.push(buildSegment(["IEA", 1, isaControlNumber]));

  const fileContent = segments.join("");
  const fileName = makeFileName(connection.mode, now);

  const batch: Generated837PBatch = {
    batchType: "837P",
    notes: "first-pass generator pending Office Ally test validation",
    mode: connection.mode,
    fileName,
    fileContent,
    claimCount: 1,
    isaControlNumber,
    gsControlNumber,
    stControlNumber,
    validation,
  };

  // Maintain explicit reference to claim control to preserve future multi-claim extension points.
  void claimControlNumber;

  return batch;
}
