/**
 * Secondary 837P emitter (X222A1 COB).
 *
 * Builds a single-claim 837P intended for the SECONDARY payer, with the
 * coordination-of-benefits loops payers require to process a downstream
 * claim after the primary has adjudicated:
 *
 *   - 2000B SBR*S (the destination payer is secondary)
 *   - 2010BA / 2010BB carry the SECONDARY subscriber + payer
 *   - 2320 SBR*P + CAS + AMT*D / AMT*F2 + OI (primary adjudication summary)
 *   - 2330A NM1*IL (primary subscriber name + member id)
 *   - 2330B NM1*PR (primary payer name + id)
 *   - 2400 SVD per line (other-payer paid amount per service)
 *           + line-level CAS
 *           + DTP*573 adjudication date
 *
 * The COB data must come from the matched primary ERA (era_claim_payments)
 * when available, otherwise from the manual EOB summary persisted on the
 * claim. Without these loops the payer either rejects the claim outright
 * or pays as primary (incorrectly), causing downstream takebacks.
 */
import type {
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

function formatTimeHHmm(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}${mm}`;
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
  const p = (line.diagnosis_pointers ?? ["1"]).slice(0, 4).map(sanitizeX12);
  return p.join(X12.componentSeparator);
}
function toProcedureComposite(line: ProfessionalClaimServiceLine): string {
  const modifiers = (line.modifiers ?? []).filter(Boolean).slice(0, 4).map(sanitizeX12);
  return ["HC", sanitizeX12(line.procedure_code), ...modifiers].join(X12.componentSeparator);
}

/**
 * Other payer (primary) snapshot for a secondary submission. All fields are
 * required when an ERA is present; when only a manual EOB exists, the
 * cas_adjustments[] / service_lines[] arrays may be empty but the payer name,
 * member id, and AMT*D / AMT*F2 totals must still be supplied.
 */
export interface SecondaryCobPrimaryPayer {
  payer_name: string;
  payer_id: string;
  subscriber_last_name: string;
  subscriber_first_name?: string | null;
  subscriber_member_id: string;
  // Date the primary payer adjudicated the claim (DTP*573, YYYYMMDD or ISO).
  adjudication_date: string;
  // CLP04 — total amount the primary payer paid on the claim.
  payer_paid_amount: number;
  // CLP05 — total client responsibility recorded on the ERA / EOB.
  patient_responsibility_amount: number;
  // Claim-level CAS adjustments (group/reason/amount tuples).
  cas_adjustments: Array<{
    group_code: string;
    reason_code: string;
    amount: number | string;
    quantity?: number | string | null;
  }>;
  // Per-line adjudication from the ERA. Keyed by service line id so the
  // generator can stitch SVD/CAS onto the matching 2400 loop.
  service_lines: Array<{
    service_line_id?: string | null;
    procedure_code?: string | null;
    paid_amount: number | string;
    original_units?: number | string | null;
    cas_adjustments?: Array<{
      group_code: string;
      reason_code: string;
      amount: number | string;
      quantity?: number | string | null;
    }>;
  }>;
}

export interface SecondaryGenerationInput {
  connection: AvailityConnection;
  submitterName: string;
  claim: ProfessionalClaim;
  serviceLines: ProfessionalClaimServiceLine[];
  // Parties snapshot built for the SECONDARY submission:
  //   - subscriber_* fields reflect the SECONDARY subscriber
  //   - payer_name / payer_id reflect the SECONDARY payer
  parties: ClaimPartiesSnapshot;
  payerProfile: {
    id: string;
    organization_id: string;
    payer_name: string;
    availity_payer_id: string;
  };
  primary: SecondaryCobPrimaryPayer;
}

function makeFileName(_mode: "test" | "production", timestamp: Date): string {
  const ymd = formatDateYYYYMMDD(timestamp);
  const hms =
    `${String(timestamp.getHours()).padStart(2, "0")}` +
    `${String(timestamp.getMinutes()).padStart(2, "0")}` +
    `${String(timestamp.getSeconds()).padStart(2, "0")}`;
  return `THERASSISTANT_837P_SEC_${ymd}_${hms}.837`;
}

function emitCas(
  adjustments: Array<{
    group_code: string;
    reason_code: string;
    amount: number | string;
    quantity?: number | string | null;
  }>,
): string[] {
  const out: string[] = [];
  // Group adjustments by group_code per 5010 (CAS01 = group code, then up
  // to 6 reason/amount/quantity triplets). For simplicity emit one CAS per
  // (group, reason) tuple — payers accept either form.
  for (const adj of adjustments ?? []) {
    if (!adj || !adj.group_code || !adj.reason_code) continue;
    const els: Array<string | number> = [
      "CAS",
      sanitizeX12(adj.group_code),
      sanitizeX12(adj.reason_code),
      formatMoney(Number(adj.amount ?? 0)),
    ];
    if (adj.quantity !== null && adj.quantity !== undefined && adj.quantity !== "") {
      els.push(Number(adj.quantity));
    }
    out.push(buildSegment(els));
  }
  return out;
}

export function generateAvaility837PSecondaryBatch(
  input: SecondaryGenerationInput,
): Generated837PBatch {
  // Reuse the primary validator for the envelope / 2010AA / 2010BA / 2300
  // / 2400 invariants. COB-specific invariants are checked inline below.
  const validation = validateAvaility837PClaim({
    connection: input.connection,
    submitterName: input.submitterName,
    claim: input.claim,
    serviceLines: input.serviceLines,
    parties: input.parties,
    payerProfile: input.payerProfile,
  });
  if (!validation.isValid) {
    const msg = validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    throw new Error(`Availity 837P secondary validation failed: ${msg}`);
  }

  const primary = input.primary;
  if (!primary || !primary.payer_name || !primary.payer_id || !primary.subscriber_member_id) {
    throw new Error(
      "Availity 837P secondary validation failed: primary payer name, id, and subscriber member id are required (Loops 2320/2330A/2330B).",
    );
  }

  const { connection, parties, claim, serviceLines, payerProfile } = input;
  const now = new Date();

  const isaControlNumber = generateControlNumber(9);
  const gsControlNumber = String(Number(isaControlNumber));
  const stControlNumber = generateControlNumber(4);
  const batchControl = generateControlNumber(8);

  const segments: string[] = [];

  const receiverId = sanitizeX12(connection.receiver_id || "030240928") || "030240928";
  const receiverName = sanitizeX12(connection.receiver_name || "Availity") || "Availity";
  const gsReceiverCode = sanitizeX12(connection.gs_receiver_code || "030240928") || "030240928";
  const usageIndicator = connection.mode === "test" ? "T" : "P";

  const isaDate = formatDateYYMMDD(now);
  const gsDate = formatDateYYYYMMDD(now);
  const time = formatTimeHHmm(now);

  // ISA / GS / ST / BHT — identical envelope to the primary emitter.
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

  // 1000A submitter
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
  const perEls: Array<string> = ["PER", "IC", sanitizeX12(input.submitterName)];
  if (perPhone) perEls.push("TE", perPhone);
  if (perEmail) perEls.push("EM", perEmail);
  segments.push(buildSegment(perEls));

  // 1000B receiver
  segments.push(buildSegment(["NM1", "40", "2", receiverName, "", "", "", "", "46", receiverId]));

  // 2000A billing provider HL
  segments.push(buildSegment(["HL", "1", "", "20", "1"]));
  segments.push(
    buildSegment([
      "NM1",
      "85",
      sanitizeX12(parties.billing_provider_entity_type),
      sanitizeX12(parties.billing_provider_name),
      parties.billing_provider_entity_type === "1"
        ? sanitizeX12(parties.billing_provider_first_name)
        : "",
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

  // 2000B subscriber HL — destination payer (SECONDARY).
  const hasPatientLoop = !parties.patient_is_subscriber;
  segments.push(buildSegment(["HL", "2", "1", "22", hasPatientLoop ? "1" : "0"]));
  // SBR*S → this is the secondary payer's view of the claim.
  segments.push(buildSegment(["SBR", "S", "18", "", "", "", "", "", "", "CI"]));

  // 2010BA SECONDARY subscriber
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

  // 2010BB SECONDARY payer
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

  // 2000C client HL (only when client != subscriber)
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

  // 2300 CLM
  const totalCharge = formatMoney(Number(claim.total_charge ?? 0));
  const claimPos = sanitizeX12(claim.place_of_service || serviceLines[0]?.place_of_service || "");
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

  if (claimFrequency === "7" || claimFrequency === "8") {
    const originalIcn = sanitizeX12(claim.original_payer_claim_control_number ?? "");
    if (originalIcn) segments.push(buildSegment(["REF", "F8", originalIcn]));
  }

  if (claim.prior_authorization_number) {
    segments.push(buildSegment(["REF", "G1", sanitizeX12(claim.prior_authorization_number)]));
  }

  const diagnosisCodes = (claim.diagnosis_codes ?? []).filter(Boolean).slice(0, 12);
  diagnosisCodes.forEach((code, index) => {
    const qualifier = index === 0 ? "ABK" : "ABF";
    segments.push(
      buildSegment([
        "HI",
        `${qualifier}${X12.componentSeparator}${sanitizeX12(code).replace(/\./g, "")}`,
      ]),
    );
  });

  if (parties.rendering_same_as_billing === false) {
    segments.push(
      buildSegment([
        "NM1",
        "82",
        sanitizeX12(parties.rendering_provider_entity_type || "1"),
        sanitizeX12(parties.rendering_provider_last_name_or_org),
        parties.rendering_provider_entity_type === "1"
          ? sanitizeX12(parties.rendering_provider_first_name)
          : "",
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

  // ── 2320 Other Subscriber Information (PRIMARY payer adjudication summary)
  segments.push(
    buildSegment([
      "SBR",
      "P", // this OTHER payer paid as primary
      "18", // client is the insured
      "",
      "",
      "",
      "",
      "",
      "",
      "CI",
    ]),
  );

  // Claim-level CAS adjustments from the primary ERA.
  for (const seg of emitCas(primary.cas_adjustments ?? [])) segments.push(seg);

  // AMT*D — primary payer paid amount (CLP04 on the 835).
  segments.push(buildSegment(["AMT", "D", formatMoney(primary.payer_paid_amount)]));
  // AMT*F2 — client responsibility amount (CLP05 on the 835).
  segments.push(
    buildSegment(["AMT", "F2", formatMoney(primary.patient_responsibility_amount)]),
  );

  // OI***Y***Y — release of info / benefits assignment for the OTHER payer.
  segments.push(buildSegment(["OI", "", "", "Y", "", "", "Y"]));

  // ── 2330A Other Subscriber Name (PRIMARY subscriber)
  segments.push(
    buildSegment([
      "NM1",
      "IL",
      "1",
      sanitizeX12(primary.subscriber_last_name),
      sanitizeX12(primary.subscriber_first_name ?? ""),
      "",
      "",
      "",
      "MI",
      sanitizeX12(primary.subscriber_member_id),
    ]),
  );

  // ── 2330B Other Payer Name (PRIMARY payer)
  segments.push(
    buildSegment([
      "NM1",
      "PR",
      "2",
      sanitizeX12(primary.payer_name),
      "",
      "",
      "",
      "",
      "PI",
      sanitizeX12(primary.payer_id),
    ]),
  );

  // ── 2400 service lines + SVD / CAS / DTP*573 ─────────────────────
  const linesById = new Map<string, SecondaryCobPrimaryPayer["service_lines"][number]>();
  const linesByProc = new Map<string, SecondaryCobPrimaryPayer["service_lines"][number]>();
  for (const sl of primary.service_lines ?? []) {
    if (sl.service_line_id) linesById.set(String(sl.service_line_id), sl);
    if (sl.procedure_code) linesByProc.set(String(sl.procedure_code).toUpperCase(), sl);
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
    segments.push(
      buildSegment(["DTP", "472", "D8", formatDateYYYYMMDD(line.service_date_from)]),
    );

    // SVD per line — required at the line level when a primary ERA is
    // available. Without it the secondary payer can't tie the COB summary
    // to the specific service.
    const eraLine =
      (line.id && linesById.get(String(line.id))) ||
      (line.procedure_code && linesByProc.get(String(line.procedure_code).toUpperCase())) ||
      null;

    if (eraLine) {
      segments.push(
        buildSegment([
          "SVD",
          sanitizeX12(primary.payer_id),
          formatMoney(Number(eraLine.paid_amount ?? 0)),
          toProcedureComposite(line),
          "",
          eraLine.original_units !== null && eraLine.original_units !== undefined
            ? Number(eraLine.original_units)
            : Number(line.units),
        ]),
      );
      for (const seg of emitCas(eraLine.cas_adjustments ?? [])) segments.push(seg);
      if (primary.adjudication_date) {
        segments.push(
          buildSegment(["DTP", "573", "D8", formatDateYYYYMMDD(primary.adjudication_date)]),
        );
      }
    }
  });

  const messageWithoutTrailer = segments.join("");
  const segmentCount = countSegments(messageWithoutTrailer, true) + 1;
  segments.push(buildSegment(["SE", segmentCount, stControlNumber]));
  segments.push(buildSegment(["GE", 1, gsControlNumber]));
  segments.push(buildSegment(["IEA", 1, isaControlNumber]));

  const fileContent = segments.join("");
  return {
    batchType: "837P",
    notes:
      "Availity Batch EDI 837P with COB loops (2320/2330A/2330B + line-level SVD/CAS/DTP*573).",
    mode: connection.mode,
    fileName: makeFileName(connection.mode, now),
    fileContent,
    claimCount: 1,
    isaControlNumber,
    gsControlNumber,
    stControlNumber,
    validation,
  };
}
