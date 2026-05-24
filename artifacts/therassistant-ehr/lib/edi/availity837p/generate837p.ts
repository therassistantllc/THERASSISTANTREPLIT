import type {
  Generated837PBatch,
  Availity837PGenerationInput,
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

function makeFileName(_mode: "test" | "production", timestamp: Date): string {
  // Availity Batch EDI Companion Guide: submitter chooses any filename;
  // Availity assigns its own internal Batch ID. Routing is determined by
  // ISA15 (T/P) — not by filename. CRITICAL: a usage indicator of "P" in
  // a QA/test environment WILL forward the transaction to the payer, the
  // OPPOSITE of Office Ally's filename-driven gating. Test mode is enforced
  // via ISA15="T" upstream.
  const yyyyMMdd = formatDateYYYYMMDD(timestamp);
  const hhmmss = `${String(timestamp.getHours()).padStart(2, "0")}${String(timestamp.getMinutes()).padStart(2, "0")}${String(timestamp.getSeconds()).padStart(2, "0")}`;
  return `THERASSISTANT_837P_${yyyyMMdd}_${hhmmss}.837`;
}

export function generateAvaility837PBatch(
  input: Availity837PGenerationInput,
): Generated837PBatch {
  const validation = validateAvaility837PClaim(input);

  if (!validation.isValid) {
    const message = validation.errors.map((error) => `${error.field}: ${error.message}`).join("; ");
    throw new Error(`Availity 837P validation failed: ${message}`);
  }

  const { connection, parties, claim, serviceLines, payerProfile } = input;
  const now = new Date();

  const isaControlNumber = generateControlNumber(9);
  const gsControlNumber = String(Number(isaControlNumber));
  const stControlNumber = generateControlNumber(4);
  const batchControl = generateControlNumber(8);

  const segments: string[] = [];

  // Availity Batch EDI Companion Guide: ISA08 = Availity D&B "030240928",
  // 1000B NM103 = "Availity", NM109 = "030240928". GS03 = Availity D&B.
  const receiverId = sanitizeX12(connection.receiver_id || "030240928") || "030240928";
  const receiverName = sanitizeX12(connection.receiver_name || "Availity") || "Availity";
  const gsReceiverCode = sanitizeX12(connection.gs_receiver_code || "030240928") || "030240928";
  const usageIndicator = connection.mode === "test" ? "T" : "P";

  const isaDate = formatDateYYMMDD(now);
  const gsDate = formatDateYYYYMMDD(now);
  const time = formatTimeHHmm(now);

  // ISA02 (Authorization Info) and ISA04 (Security Info) are fixed 10-char
  // fields per X12 005010 — an empty string is malformed and OA will reject
  // the envelope. Pad to exactly 10 spaces.
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

  // Loop 1000A PER — Submitter EDI Contact Information. TR3 005010X222A1
  // requires at least one of TE/EM/FX. Validation rejects the build upstream
  // when neither phone nor email is configured, so by the time we get here we
  // are guaranteed at least one.
  const perPhone = (connection.submitter_contact_phone ?? "").replace(/\D/g, "").slice(0, 20);
  const perEmail = sanitizeX12(connection.submitter_contact_email ?? "").slice(0, 80);
  const perEls: Array<string> = ["PER", "IC", sanitizeX12(input.submitterName)];
  if (perPhone) { perEls.push("TE", perPhone); }
  if (perEmail) { perEls.push("EM", perEmail); }
  segments.push(buildSegment(perEls));

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

  // CLM05-3 Claim Frequency Code: '1' original, '7' replacement, '8' void.
  // Default to '1' when persisted value is missing/blank so existing originals
  // keep their current behaviour. Corrected children written by the
  // /api/billing/corrected-claims action carry '7' or '8'.
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

  // Loop 2320/2330A/2330B — primary payer adjudication summary. Emits only
  // for child claims with `cob_billing_role='secondary'` whose billSecondary
  // stamping populated prior_payer_eob_data with the primary subscriber/payer
  // identifying fields. Without these loops the secondary payer rejects the
  // claim as "missing other payer information."
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

    segments.push(buildSegment(["DTP", "472", "D8", formatServiceDate(line.service_date_from)]));
    // Loop 2430 per-line ERA breakdown (SVD/CAS/DTP*573).
    if (cobPrimary) {
      for (const seg of emitServiceLineCobLoops(line, cobPrimary)) segments.push(seg);
    }
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
    notes: "Availity Batch EDI Companion Guide v.20260429 envelope (ISA08=030240928, 1000B NM103=Availity).",
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
