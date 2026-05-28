/**
 * lib/edi/availity837p/map837p.ts
 *
 * HIPAA X12 837P 005010X222A1 — canonical single-claim segment mapper.
 *
 * Covers every loop and segment required by the TherAssistant EHR 837P spec:
 *
 *   ISA / GS / ST / BHT
 *   Loop 1000A  — Submitter (NM1*41, PER)
 *   Loop 1000B  — Receiver  (NM1*40)
 *   Loop 2000A  — Billing Provider HL (HL, PRV[taxonomy])
 *   Loop 2010AA — Billing Provider (NM1*85, N3, N4, REF*EI/SY, PER[contact])
 *   Loop 2000B  — Subscriber HL (HL, SBR)
 *   Loop 2010BA — Subscriber (NM1*IL, N3, N4, DMG)
 *   Loop 2010BB — Payer (NM1*PR, N3[cond], N4[cond])
 *   Loop 2000C  — Patient HL (HL, PAT)   [only when patient ≠ subscriber]
 *   Loop 2010CA — Patient (NM1*QC, N3, N4, DMG)   [only when patient ≠ subscriber]
 *   Loop 2300   — Claim (CLM, DTP*431/454/304/453/439, REF*D9/G1/F8, HI, PWK, NTE)
 *   Loop 2310A  — Referring Provider (NM1*DN)   [conditional]
 *   Loop 2310B  — Rendering Provider (NM1*82, PRV)   [conditional]
 *   Loop 2310D  — Service Facility (NM1*77, N3, N4)   [conditional]
 *   Loop 2400   — Service Lines (LX, SV1, DTP*472, REF*6R, NTE)
 *   Loop 2420A  — Line Rendering Provider (NM1*82, PRV)   [conditional]
 *   SE / GE / IEA
 *
 * Rules enforced:
 *   - Loop 2000C/2010CA only when patient_is_subscriber = false.
 *   - Loop 2310A only when a referring provider is supplied.
 *   - Loop 2310B only when a claim-level rendering provider is supplied.
 *   - Loop 2310D only when a service facility is supplied.
 *   - Loop 2420A only when a service-line rendering provider is supplied
 *     AND its NPI differs from the claim-level rendering provider NPI.
 *   - REF*D9 only for corrected/replacement/void claims (frequency 7 or 8).
 *   - REF*F8 whenever original_reference_number is present.
 *   - All required fields validated before segment emission.
 *   - PHI is never written to logs or error messages — field paths only.
 */

import {
  X12,
  buildSegment,
  countSegments,
  formatDateYYYYMMDD,
  formatMoney,
  generateControlNumber,
  sanitizeX12,
} from "./x12";

// ─── Input types ─────────────────────────────────────────────────────────────

/** ISA/GS envelope + Loop 1000A/1000B clearinghouse configuration. */
export interface Map837PEnvelope {
  /** ISA05 qualifier for the sender (ZZ = mutually defined, 30 = federal taxpayer ID). */
  sender_qualifier?: string;
  /** ISA06 / GS02 / Loop 1000A NM1*41 NM109 — submitter EDI ID. */
  submitter_id: string;
  /** ISA07 qualifier for the receiver (30 = D&B number, ZZ = mutually defined). */
  receiver_qualifier?: string;
  /** ISA08 / GS03 / Loop 1000B NM1*40 NM109 — receiver EDI ID (Availity: "030240928"). */
  receiver_id: string;
  /** GS03 when different from receiver_id (Availity typically reuses receiver_id). */
  gs_receiver_code?: string;
  /** ISA15: "T" for test submissions, "P" for production. CRITICAL — "P" routes to the payer. */
  usage_indicator: "T" | "P";
  /** Loop 1000A NM1*41 NM103 — submitter organisation name. */
  submitter_name: string;
  /** Loop 1000A PER02 — contact name (required when phone or email present). */
  submitter_contact_name?: string;
  /** Loop 1000A PER TE — contact phone digits only (at least one of phone/email required). */
  submitter_contact_phone?: string;
  /** Loop 1000A PER EM — contact email (at least one of phone/email required). */
  submitter_contact_email?: string;
  /** Loop 1000B NM1*40 NM103 — receiver name (Availity: "Availity"). */
  receiver_name: string;
}

/** Loop 2000A / Loop 2010AA — Billing Provider. */
export interface Map837PBillingProvider {
  /** NM1*85 NM102: "1" = person, "2" = organisation. */
  entity_type: "1" | "2";
  /** NM1*85 NM103 — last name or organisation name. */
  last_name_or_org: string;
  /** NM1*85 NM104 — first name; required when entity_type = "1". */
  first_name?: string;
  /** NM1*85 NM109 — 10-digit NPI. */
  npi: string;
  /** REF qualifier: "EI" (EIN) or "SY" (SSN). Defaults to "EI". */
  tax_id_type?: "EI" | "SY";
  /** REF value — provider tax ID (EIN/TIN). */
  tax_id: string;
  /** N3 — street address line 1. Must be a physical address, not a PO Box. */
  address1: string;
  /** N4 NM101 — city. */
  city: string;
  /** N4 NM102 — two-letter state code. */
  state: string;
  /** N4 NM103 — ZIP (5 or 9 digit). */
  zip: string;
  /**
   * Loop 2000A PRV03 — taxonomy code. When present a PRV*BI*PXC*{code} segment
   * is emitted in Loop 2000A immediately after the HL segment.
   */
  taxonomy?: string;
  /** 2010AA PER02 — billing provider contact name. Emits PER when present. */
  contact_name?: string;
  /** 2010AA PER TE — billing provider contact phone (digits only). */
  contact_phone?: string;
}

/** Loop 2010BB — Payer. */
export interface Map837PPayer {
  /** NM1*PR NM103 — payer name. */
  name: string;
  /** NM1*PR NM109 — payer ID (Availity payer ID). */
  payer_id: string;
  /** N3 — payer address (emitted when present). */
  address1?: string;
  /** N4 — payer city (emitted when address1 present). */
  city?: string;
  /** N4 — payer state (emitted when address1 present). */
  state?: string;
  /** N4 — payer ZIP (emitted when address1 present). */
  zip?: string;
}

/** Loop 2000B / Loop 2010BA — Subscriber (the insured). */
export interface Map837PSubscriber {
  /** NM1*IL NM103 — subscriber last name. */
  last_name: string;
  /** NM1*IL NM104 — subscriber first name. */
  first_name: string;
  /** NM1*IL NM109 — member/insurance ID. */
  member_id: string;
  /** DMG02 — subscriber date of birth (YYYY-MM-DD or YYYYMMDD). */
  dob: string;
  /** DMG03 — subscriber gender: "F", "M", or "U". */
  sex?: "F" | "M" | "U";
  /** N3 — subscriber address line 1. */
  address1?: string;
  /** N4 — subscriber city. */
  city?: string;
  /** N4 — subscriber state. */
  state?: string;
  /** N4 — subscriber ZIP. */
  zip?: string;
  /**
   * SBR01 payer responsibility sequence: "P" primary, "S" secondary, "T" tertiary.
   * Defaults to "P".
   */
  responsibility_code?: "P" | "S" | "T";
  /**
   * Whether this subscriber is also the patient. When true the
   * Loop 2000C / 2010CA patient loops are omitted.
   */
  is_patient: boolean;
}

/** Loop 2000C / Loop 2010CA — Patient (only when patient ≠ subscriber). */
export interface Map837PPatient {
  /** NM1*QC NM103 — patient last name. */
  last_name: string;
  /** NM1*QC NM104 — patient first name. */
  first_name: string;
  /** DMG02 — patient date of birth (YYYY-MM-DD or YYYYMMDD). */
  dob: string;
  /** DMG03 — patient gender: "F", "M", or "U". */
  sex?: "F" | "M" | "U";
  /** N3 — patient address line 1. */
  address1?: string;
  /** N4 — patient city. */
  city?: string;
  /** N4 — patient state. */
  state?: string;
  /** N4 — patient ZIP. */
  zip?: string;
  /**
   * PAT01 — patient relationship to subscriber.
   * Common codes: "01" spouse, "19" child, "20" employee, "G8" other.
   * Defaults to "19" when omitted.
   */
  relationship_code?: string;
}

/** Loop 2310A — Referring Provider (emitted only when present). */
export interface Map837PReferringProvider {
  /** NM1*DN NM103 — referring provider last name. */
  last_name: string;
  /** NM1*DN NM104 — referring provider first name. */
  first_name?: string;
  /** NM1*DN NM109 — 10-digit NPI. */
  npi: string;
}

/** Loop 2310B — Claim-level Rendering Provider (emitted only when present). */
export interface Map837PRenderingProvider {
  /** NM1*82 NM102: "1" person (default), "2" organisation. */
  entity_type?: "1" | "2";
  /** NM1*82 NM103 — last name or organisation name. */
  last_name_or_org: string;
  /** NM1*82 NM104 — first name; used when entity_type = "1". */
  first_name?: string;
  /** NM1*82 NM109 — 10-digit NPI. */
  npi: string;
  /** PRV03 — taxonomy code. Emits PRV*PE*PXC*{code} when present. */
  taxonomy?: string;
}

/** Loop 2310D — Service Facility (emitted only when different from billing provider). */
export interface Map837PServiceFacility {
  /** NM1*77 NM103 — facility name. */
  name: string;
  /** NM1*77 NM109 — facility NPI (10 digits; optional per spec). */
  npi?: string;
  /** N3 — facility address line 1. */
  address1: string;
  /** N4 — facility city. */
  city: string;
  /** N4 — facility state. */
  state: string;
  /** N4 — facility ZIP. */
  zip: string;
}

/** Loop 2420A — Service-line Rendering Provider. */
export interface Map837PLineRenderingProvider {
  /** NM1*82 NM102: "1" person (default), "2" organisation. */
  entity_type?: "1" | "2";
  /** NM1*82 NM103 — last name or organisation name. */
  last_name_or_org: string;
  /** NM1*82 NM104 — first name; used when entity_type = "1". */
  first_name?: string;
  /** NM1*82 NM109 — 10-digit NPI. */
  npi: string;
  /** PRV03 — taxonomy code. Emits PRV*PE*PXC*{code} when present. */
  taxonomy?: string;
}

/** Loop 2400 — Service Line. */
export interface Map837PServiceLine {
  /** LX01 — line number (1-based). */
  line_number: number;
  /** SV101-2 — CPT or HCPCS procedure code. */
  procedure_code: string;
  /** SV101-3 through SV101-6 — up to 4 two-character modifiers. */
  modifiers?: string[];
  /** SV102 — line charge amount. */
  charge_amount: number | string;
  /** SV104 — units rendered. */
  units: number | string;
  /** SV105 — place of service code (falls back to claim-level POS when absent). */
  place_of_service?: string;
  /**
   * SV107 — diagnosis code pointers (A–L corresponding to HI position).
   * At least one pointer is required.
   */
  diagnosis_pointers: string[];
  /** DTP*472 — date of service (YYYY-MM-DD or YYYYMMDD). */
  date_of_service: string;
  /** REF*6R — line item control number. Emitted when present. */
  line_control_number?: string;
  /** NTE02 — free-text line note. Emitted when present. */
  note?: string;
  /**
   * Loop 2420A — line-level rendering provider.
   * Only emitted when this NPI differs from the claim-level rendering provider NPI
   * (or when there is no claim-level rendering provider).
   */
  rendering_provider?: Map837PLineRenderingProvider;
}

/** Loop 2300 — Claim. */
export interface Map837PClaim {
  /**
   * CLM01 — claim submitter identifier. Typically the patient account number
   * or claim control number. Must be unique per submission.
   */
  claim_identifier: string;
  /** CLM02 — total charge amount for the claim. */
  total_charge: number | string;
  /** CLM05-1 — place of service code (e.g. "11" = office, "02" = telehealth). */
  place_of_service: string;
  /**
   * CLM05-3 — claim frequency / type of bill code.
   * "1" = original (default), "7" = replacement, "8" = void/cancel.
   */
  claim_frequency_code?: string;
  /** CLM07 — accept assignment: true → "Y" (default), false → "N". */
  accept_assignment?: boolean;
  /** CLM08 — benefits assignment certification: true → "Y" (default), false → "N". */
  benefits_assignment?: boolean;
  /** CLM09 — release of information: true → "A" (default), false → "N". */
  release_of_information?: boolean;
  /** DTP*431 — illness/condition onset date (YYYY-MM-DD). Emitted when present. */
  onset_date?: string;
  /** DTP*454 — initial treatment date (YYYY-MM-DD). Emitted when present. */
  initial_treatment_date?: string;
  /** DTP*304 — latest visit / last seen date (YYYY-MM-DD). Emitted when present. */
  latest_visit_date?: string;
  /** DTP*453 — acute manifestation of a chronic condition date (YYYY-MM-DD). */
  acute_manifestation_date?: string;
  /** DTP*439 — accident date (YYYY-MM-DD). Emitted when present. */
  accident_date?: string;
  /**
   * REF*D9 — clearinghouse claim control number assigned by the prior payer.
   * Emitted ONLY for corrected/replacement/void claims (frequency code 7 or 8).
   */
  payer_claim_control_number?: string;
  /** REF*G1 — prior authorisation number. Emitted when present. */
  prior_authorization_number?: string;
  /**
   * REF*F8 — original reference number (payer's ICN/DCN for the prior claim).
   * Emitted whenever present — typically carried on corrected/void resubmissions
   * so the payer can tie the replacement to the original transaction.
   */
  original_reference_number?: string;
  /**
   * HI — ICD-10 diagnosis codes, principal code first. Up to 12 accepted.
   * Periods are stripped before emission (per X12 companion guide).
   */
  diagnosis_codes: string[];
  /**
   * PWK01 — attachment report type code (e.g. "OZ" = support data, "B2" = prescription).
   * Emits the PWK segment when both attachment_indicator and attachment_control_number
   * are present.
   */
  attachment_indicator?: string;
  /**
   * PWK05/06 — attachment control number (AC qualifier).
   * Required alongside attachment_indicator for the PWK segment to emit.
   */
  attachment_control_number?: string;
  /** NTE02 — claim-level free-text note (NTE*ADD). Emitted when present. */
  note?: string;
}

/** Full input to map837p(). */
export interface Map837PInput {
  /** ISA/GS/1000A/1000B envelope configuration. */
  envelope: Map837PEnvelope;
  /** Loop 2000A / 2010AA — Billing provider. */
  billing_provider: Map837PBillingProvider;
  /** Loop 2010BB — Payer. */
  payer: Map837PPayer;
  /** Loop 2000B / 2010BA — Subscriber. */
  subscriber: Map837PSubscriber;
  /**
   * Loop 2000C / 2010CA — Patient.
   * Required (and loops emitted) only when subscriber.is_patient = false.
   */
  patient?: Map837PPatient;
  /** Loop 2310A — Referring provider. Omit when not applicable. */
  referring_provider?: Map837PReferringProvider;
  /** Loop 2310B — Claim-level rendering provider. Omit when same as billing provider. */
  rendering_provider?: Map837PRenderingProvider;
  /** Loop 2310D — Service facility. Omit when same as billing provider. */
  service_facility?: Map837PServiceFacility;
  /** Loop 2300 — Claim details. */
  claim: Map837PClaim;
  /** Loop 2400 — Service lines (at least one required). */
  service_lines: Map837PServiceLine[];
  /** Override the generation timestamp (useful in tests). */
  now?: Date;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface Map837PValidationError {
  /** Dot-path to the input field that failed (no PHI values). */
  field: string;
  /** Human-readable reason for the failure. */
  message: string;
  /** X12 loop context (e.g. "2010AA", "2300"). */
  loop?: string;
  /** X12 segment context (e.g. "NM1", "CLM"). */
  segment?: string;
}

function err(
  errors: Map837PValidationError[],
  field: string,
  message: string,
  loop?: string,
  segment?: string,
): void {
  errors.push({ field, message, loop, segment });
}

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function is10DigitNpi(v: unknown): boolean {
  return typeof v === "string" && /^\d{10}$/.test(v.trim());
}

function isPositiveMoney(v: unknown): boolean {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0;
}

/**
 * Validate all required and conditionally required fields in a Map837PInput.
 * Returns an array of errors; an empty array means the input is valid.
 * PHI field values are never included in error messages.
 */
export function validate837pInput(input: Map837PInput): Map837PValidationError[] {
  const errors: Map837PValidationError[] = [];

  // ── Envelope ──────────────────────────────────────────────────────────────
  if (!nonEmpty(input.envelope.submitter_id)) {
    err(errors, "envelope.submitter_id", "submitter_id is required.", "ISA/GS", "ISA");
  }
  if (!nonEmpty(input.envelope.receiver_id)) {
    err(errors, "envelope.receiver_id", "receiver_id is required.", "ISA/GS", "ISA");
  }
  if (!nonEmpty(input.envelope.submitter_name)) {
    err(errors, "envelope.submitter_name", "submitter_name is required.", "1000A", "NM1");
  }
  if (!nonEmpty(input.envelope.receiver_name)) {
    err(errors, "envelope.receiver_name", "receiver_name is required.", "1000B", "NM1");
  }
  const contactPhone = String(input.envelope.submitter_contact_phone ?? "").replace(/\D/g, "");
  const contactEmail = String(input.envelope.submitter_contact_email ?? "").trim();
  if (!contactPhone && !contactEmail) {
    err(
      errors,
      "envelope.submitter_contact_phone",
      "At least one of submitter_contact_phone or submitter_contact_email is required (TR3 Loop 1000A PER).",
      "1000A",
      "PER",
    );
  }
  if (!["T", "P"].includes(input.envelope.usage_indicator)) {
    err(errors, "envelope.usage_indicator", "usage_indicator must be T or P.", "ISA", "ISA");
  }

  // ── Billing Provider ──────────────────────────────────────────────────────
  if (!nonEmpty(input.billing_provider.last_name_or_org)) {
    err(errors, "billing_provider.last_name_or_org", "Billing provider name is required.", "2010AA", "NM1");
  }
  if (!is10DigitNpi(input.billing_provider.npi)) {
    err(errors, "billing_provider.npi", "Billing provider NPI must be exactly 10 digits.", "2010AA", "NM1");
  }
  if (!nonEmpty(input.billing_provider.tax_id)) {
    err(errors, "billing_provider.tax_id", "Billing provider tax ID is required.", "2010AA", "REF");
  }
  if (!nonEmpty(input.billing_provider.address1)) {
    err(errors, "billing_provider.address1", "Billing provider address1 is required.", "2010AA", "N3");
  } else if (/\bP\.?\s*O\.?\s*BOX\b|\bPOST\s*OFFICE\b/i.test(input.billing_provider.address1)) {
    err(errors, "billing_provider.address1", "Billing provider must supply a physical address, not a PO Box.", "2010AA", "N3");
  }
  if (!nonEmpty(input.billing_provider.city)) {
    err(errors, "billing_provider.city", "Billing provider city is required.", "2010AA", "N4");
  }
  if (!nonEmpty(input.billing_provider.state) || input.billing_provider.state.trim().length !== 2) {
    err(errors, "billing_provider.state", "Billing provider state must be a 2-character code.", "2010AA", "N4");
  }
  if (!nonEmpty(input.billing_provider.zip)) {
    err(errors, "billing_provider.zip", "Billing provider ZIP is required.", "2010AA", "N4");
  }

  // ── Payer ─────────────────────────────────────────────────────────────────
  if (!nonEmpty(input.payer.name)) {
    err(errors, "payer.name", "Payer name is required.", "2010BB", "NM1");
  }
  if (!nonEmpty(input.payer.payer_id)) {
    err(errors, "payer.payer_id", "Payer ID is required.", "2010BB", "NM1");
  }

  // ── Subscriber ────────────────────────────────────────────────────────────
  if (!nonEmpty(input.subscriber.last_name)) {
    err(errors, "subscriber.last_name", "Subscriber last name is required.", "2010BA", "NM1");
  }
  if (!nonEmpty(input.subscriber.first_name)) {
    err(errors, "subscriber.first_name", "Subscriber first name is required.", "2010BA", "NM1");
  }
  if (!nonEmpty(input.subscriber.member_id)) {
    err(errors, "subscriber.member_id", "Subscriber member ID is required.", "2010BA", "NM1");
  }
  if (!nonEmpty(input.subscriber.dob)) {
    err(errors, "subscriber.dob", "Subscriber date of birth is required.", "2010BA", "DMG");
  }

  // ── Patient (when different from subscriber) ──────────────────────────────
  if (!input.subscriber.is_patient) {
    if (!input.patient) {
      err(
        errors,
        "patient",
        "patient object is required when subscriber.is_patient = false.",
        "2000C",
        "PAT",
      );
    } else {
      if (!nonEmpty(input.patient.last_name)) {
        err(errors, "patient.last_name", "Patient last name is required.", "2010CA", "NM1");
      }
      if (!nonEmpty(input.patient.first_name)) {
        err(errors, "patient.first_name", "Patient first name is required.", "2010CA", "NM1");
      }
      if (!nonEmpty(input.patient.dob)) {
        err(errors, "patient.dob", "Patient date of birth is required.", "2010CA", "DMG");
      }
    }
  }

  // ── Referring Provider (conditional) ─────────────────────────────────────
  if (input.referring_provider) {
    if (!nonEmpty(input.referring_provider.last_name)) {
      err(errors, "referring_provider.last_name", "Referring provider last name is required.", "2310A", "NM1");
    }
    if (!is10DigitNpi(input.referring_provider.npi)) {
      err(errors, "referring_provider.npi", "Referring provider NPI must be exactly 10 digits.", "2310A", "NM1");
    }
  }

  // ── Rendering Provider (conditional) ─────────────────────────────────────
  if (input.rendering_provider) {
    if (!nonEmpty(input.rendering_provider.last_name_or_org)) {
      err(errors, "rendering_provider.last_name_or_org", "Rendering provider name is required.", "2310B", "NM1");
    }
    if (!is10DigitNpi(input.rendering_provider.npi)) {
      err(errors, "rendering_provider.npi", "Rendering provider NPI must be exactly 10 digits.", "2310B", "NM1");
    }
  }

  // ── Service Facility (conditional) ───────────────────────────────────────
  if (input.service_facility) {
    if (!nonEmpty(input.service_facility.name)) {
      err(errors, "service_facility.name", "Service facility name is required.", "2310D", "NM1");
    }
    if (!nonEmpty(input.service_facility.address1)) {
      err(errors, "service_facility.address1", "Service facility address1 is required.", "2310D", "N3");
    }
    if (!nonEmpty(input.service_facility.city)) {
      err(errors, "service_facility.city", "Service facility city is required.", "2310D", "N4");
    }
    if (!nonEmpty(input.service_facility.state)) {
      err(errors, "service_facility.state", "Service facility state is required.", "2310D", "N4");
    }
    if (!nonEmpty(input.service_facility.zip)) {
      err(errors, "service_facility.zip", "Service facility ZIP is required.", "2310D", "N4");
    }
  }

  // ── Claim ─────────────────────────────────────────────────────────────────
  if (!nonEmpty(input.claim.claim_identifier)) {
    err(errors, "claim.claim_identifier", "Claim identifier (CLM01) is required.", "2300", "CLM");
  }
  if (!isPositiveMoney(input.claim.total_charge)) {
    err(errors, "claim.total_charge", "Claim total_charge must be a positive number.", "2300", "CLM");
  }
  if (!nonEmpty(input.claim.place_of_service)) {
    err(errors, "claim.place_of_service", "Claim place_of_service is required.", "2300", "CLM");
  }
  if (!Array.isArray(input.claim.diagnosis_codes) || input.claim.diagnosis_codes.filter(Boolean).length === 0) {
    err(errors, "claim.diagnosis_codes", "At least one diagnosis code is required.", "2300", "HI");
  }

  // ── Service Lines ─────────────────────────────────────────────────────────
  if (!Array.isArray(input.service_lines) || input.service_lines.length === 0) {
    err(errors, "service_lines", "At least one service line is required.", "2400", "LX");
  } else {
    input.service_lines.forEach((line, idx) => {
      const pfx = `service_lines[${idx}]`;
      if (!nonEmpty(line.procedure_code)) {
        err(errors, `${pfx}.procedure_code`, "Service line procedure_code is required.", "2400", "SV1");
      }
      if (!isPositiveMoney(line.charge_amount)) {
        err(errors, `${pfx}.charge_amount`, "Service line charge_amount must be a positive number.", "2400", "SV1");
      }
      if (!nonEmpty(line.date_of_service)) {
        err(errors, `${pfx}.date_of_service`, "Service line date_of_service is required.", "2400", "DTP");
      }
      if (!Array.isArray(line.diagnosis_pointers) || line.diagnosis_pointers.filter(Boolean).length === 0) {
        err(errors, `${pfx}.diagnosis_pointers`, "At least one diagnosis pointer is required.", "2400", "SV1");
      }
      // Validate line-level rendering provider when present
      if (line.rendering_provider) {
        if (!nonEmpty(line.rendering_provider.last_name_or_org)) {
          err(errors, `${pfx}.rendering_provider.last_name_or_org`, "Line rendering provider name is required.", "2420A", "NM1");
        }
        if (!is10DigitNpi(line.rendering_provider.npi)) {
          err(errors, `${pfx}.rendering_provider.npi`, "Line rendering provider NPI must be exactly 10 digits.", "2420A", "NM1");
        }
      }
    });
  }

  return errors;
}

// ─── Output ───────────────────────────────────────────────────────────────────

export interface Map837POutput {
  /** True when the file was built successfully without validation errors. */
  ok: boolean;
  /** Full X12 837P file content (ISA through IEA). Empty string when ok = false. */
  file_content: string;
  /** Generated filename following the TherAssistant naming convention. */
  file_name: string;
  /** ISA13 control number. */
  isa_control_number: string;
  /** GS06 control number. */
  gs_control_number: string;
  /** ST02 transaction set control number. */
  st_control_number: string;
  /** Total number of segments from ST through SE inclusive. */
  segment_count: number;
  /** Populated when ok = false. */
  validation_errors: Map837PValidationError[];
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function yyMMdd(date: Date): string {
  return formatDateYYYYMMDD(date).slice(2);
}

function yyyyMMdd(date: Date): string {
  return formatDateYYYYMMDD(date);
}

function HHmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
}

function padIsaId(value: string): string {
  return value.padEnd(15, " ").slice(0, 15);
}

function fmtZip(zip: string | null | undefined): string {
  return sanitizeX12(zip).replace(/\s+/g, "");
}

/** Build a compact SV1 procedure composite: HC:{code}[:{mod1}...{mod4}] */
function procedureComposite(code: string, modifiers?: string[]): string {
  const mods = (modifiers ?? []).filter(Boolean).slice(0, 4).map((m) => sanitizeX12(m));
  return ["HC", sanitizeX12(code), ...mods].join(X12.componentSeparator);
}

/** Build SV107 diagnosis pointer composite. */
function pointerList(pointers: string[]): string {
  return (pointers ?? [])
    .filter(Boolean)
    .slice(0, 4)
    .map((p) => sanitizeX12(p))
    .join(X12.componentSeparator);
}

/** Strip period from ICD-10 code and sanitize for X12. */
function fmtDx(code: string): string {
  return sanitizeX12(code).replace(/\./g, "");
}

/**
 * Build a segment WITHOUT running elements through sanitizeX12.
 * Required for any segment that contains pre-assembled X12 composite elements
 * (strings that include the component separator ":"). Callers must sanitize
 * each individual data element with sanitizeX12() before passing it here.
 */
function rawSeg(...elements: Array<string | number | null | undefined>): string {
  return elements
    .map((e) => (e == null ? "" : String(e)))
    .join(X12.elementSeparator) + X12.segmentTerminator;
}

function makeFileName(now: Date): string {
  const date = yyyyMMdd(now);
  const time =
    `${String(now.getHours()).padStart(2, "0")}` +
    `${String(now.getMinutes()).padStart(2, "0")}` +
    `${String(now.getSeconds()).padStart(2, "0")}`;
  return `THERASSISTANT_837P_${date}_${time}.837`;
}

// ─── Segment builders ─────────────────────────────────────────────────────────

function buildEnvelope(input: Map837PInput, controls: {
  isa: string;
  gs: string;
  st: string;
  batch: string;
  now: Date;
}): string[] {
  const { envelope } = input;
  const { isa, gs, st, batch, now } = controls;

  const receiverId = sanitizeX12(envelope.receiver_id || "030240928") || "030240928";
  const receiverName = sanitizeX12(envelope.receiver_name || "Availity") || "Availity";
  const gsReceiverCode = sanitizeX12(envelope.gs_receiver_code || receiverId);
  const senderQual = sanitizeX12(envelope.sender_qualifier || "ZZ");
  const receiverQual = sanitizeX12(envelope.receiver_qualifier || "30");
  const isaDate = yyMMdd(now);
  const gsDate = yyyyMMdd(now);
  const time = HHmm(now);

  const segs: string[] = [];

  // ISA — fixed-length fields (ISA02=10 spaces, ISA04=10 spaces per X12 005010)
  segs.push(
    [
      "ISA",
      "00",
      "          ",     // ISA02 — Authorization Information (10 chars)
      "00",
      "          ",     // ISA04 — Security Information (10 chars)
      senderQual,
      padIsaId(sanitizeX12(envelope.submitter_id)),
      receiverQual,
      padIsaId(receiverId),
      isaDate,
      time,
      X12.repetitionSeparator,
      "00501",
      isa,
      "0",
      envelope.usage_indicator,
      X12.componentSeparator,
    ].join(X12.elementSeparator) + X12.segmentTerminator,
  );

  // GS — Functional Group Header
  segs.push(
    buildSegment(["GS", "HC", sanitizeX12(envelope.submitter_id), gsReceiverCode, gsDate, time, gs, "X", "005010X222A1"]),
  );

  // ST — Transaction Set Header
  segs.push(buildSegment(["ST", "837", st, "005010X222A1"]));

  // BHT — Beginning of Hierarchical Transaction
  segs.push(buildSegment(["BHT", "0019", "00", batch, gsDate, time, "CH"]));

  // ── Loop 1000A — Submitter ────────────────────────────────────────────────
  segs.push(
    buildSegment([
      "NM1", "41", "2",
      sanitizeX12(envelope.submitter_name),
      "", "", "", "",
      "46",
      sanitizeX12(envelope.submitter_id),
    ]),
  );

  // PER — Submitter EDI Contact (TR3 requires at least TE or EM)
  const perPhone = String(envelope.submitter_contact_phone ?? "").replace(/\D/g, "").slice(0, 20);
  const perEmail = sanitizeX12(envelope.submitter_contact_email ?? "").slice(0, 80);
  const perContactName = sanitizeX12(envelope.submitter_contact_name || envelope.submitter_name);
  const perEls: Array<string> = ["PER", "IC", perContactName];
  if (perPhone) perEls.push("TE", perPhone);
  if (perEmail) perEls.push("EM", perEmail);
  segs.push(buildSegment(perEls));

  // ── Loop 1000B — Receiver ────────────────────────────────────────────────
  segs.push(
    buildSegment([
      "NM1", "40", "2",
      receiverName,
      "", "", "", "",
      "46",
      receiverId,
    ]),
  );

  return segs;
}

function buildBillingProviderLoop(bp: Map837PBillingProvider, hlNum: number): string[] {
  const segs: string[] = [];

  // ── Loop 2000A — Billing Provider HL ─────────────────────────────────────
  segs.push(buildSegment(["HL", hlNum, "", "20", "1"]));

  // PRV*BI — Billing Provider Specialty (emitted when taxonomy is present)
  if (nonEmpty(bp.taxonomy)) {
    segs.push(buildSegment(["PRV", "BI", "PXC", sanitizeX12(bp.taxonomy)]));
  }

  // ── Loop 2010AA — Billing Provider Name / Address ────────────────────────
  segs.push(
    buildSegment([
      "NM1", "85",
      sanitizeX12(bp.entity_type),
      sanitizeX12(bp.last_name_or_org),
      bp.entity_type === "1" ? sanitizeX12(bp.first_name) : "",
      "", "", "",
      "XX",
      sanitizeX12(bp.npi),
    ]),
  );
  segs.push(buildSegment(["N3", sanitizeX12(bp.address1)]));
  segs.push(buildSegment(["N4", sanitizeX12(bp.city), sanitizeX12(bp.state), fmtZip(bp.zip)]));
  segs.push(buildSegment(["REF", sanitizeX12(bp.tax_id_type || "EI"), sanitizeX12(bp.tax_id)]));

  // 2010AA PER — Billing Provider Contact (optional)
  if (nonEmpty(bp.contact_name) || nonEmpty(bp.contact_phone)) {
    const bpPhone = String(bp.contact_phone ?? "").replace(/\D/g, "").slice(0, 20);
    const bpPerEls: Array<string> = ["PER", "IC", sanitizeX12(bp.contact_name)];
    if (bpPhone) bpPerEls.push("TE", bpPhone);
    segs.push(buildSegment(bpPerEls));
  }

  return segs;
}

function buildSubscriberLoop(
  subscriber: Map837PSubscriber,
  payer: Map837PPayer,
  billingHl: number,
  subscriberHl: number,
  hasPatient: boolean,
): string[] {
  const segs: string[] = [];

  // ── Loop 2000B — Subscriber HL ───────────────────────────────────────────
  segs.push(buildSegment(["HL", subscriberHl, billingHl, "22", hasPatient ? "1" : "0"]));

  // SBR — Subscriber Information
  const responsibilityCode = sanitizeX12(subscriber.responsibility_code || "P") || "P";
  segs.push(buildSegment(["SBR", responsibilityCode, "18", "", "", "", "", "", "", "CI"]));

  // ── Loop 2010BA — Subscriber Name / Address ──────────────────────────────
  segs.push(
    buildSegment([
      "NM1", "IL", "1",
      sanitizeX12(subscriber.last_name),
      sanitizeX12(subscriber.first_name),
      "", "", "",
      "MI",
      sanitizeX12(subscriber.member_id),
    ]),
  );

  if (nonEmpty(subscriber.address1)) {
    segs.push(buildSegment(["N3", sanitizeX12(subscriber.address1)]));
    segs.push(
      buildSegment([
        "N4",
        sanitizeX12(subscriber.city),
        sanitizeX12(subscriber.state),
        fmtZip(subscriber.zip),
      ]),
    );
  }

  // DMG — Subscriber Date of Birth / Gender
  segs.push(
    buildSegment([
      "DMG", "D8",
      formatDateYYYYMMDD(subscriber.dob),
      subscriber.sex ? sanitizeX12(subscriber.sex) : "",
    ]),
  );

  // ── Loop 2010BB — Payer ──────────────────────────────────────────────────
  segs.push(
    buildSegment([
      "NM1", "PR", "2",
      sanitizeX12(payer.name),
      "", "", "", "",
      "PI",
      sanitizeX12(payer.payer_id),
    ]),
  );

  // Payer N3 / N4 (emitted when address is available)
  if (nonEmpty(payer.address1)) {
    segs.push(buildSegment(["N3", sanitizeX12(payer.address1)]));
    segs.push(
      buildSegment([
        "N4",
        sanitizeX12(payer.city),
        sanitizeX12(payer.state),
        fmtZip(payer.zip),
      ]),
    );
  }

  return segs;
}

function buildPatientLoop(
  patient: Map837PPatient,
  subscriberHl: number,
  patientHl: number,
): string[] {
  const segs: string[] = [];

  // ── Loop 2000C — Patient HL ──────────────────────────────────────────────
  segs.push(buildSegment(["HL", patientHl, subscriberHl, "23", "0"]));

  // PAT — Patient Information
  const relCode = sanitizeX12(patient.relationship_code || "19") || "19";
  segs.push(buildSegment(["PAT", relCode]));

  // ── Loop 2010CA — Patient Name / Address ─────────────────────────────────
  segs.push(
    buildSegment([
      "NM1", "QC", "1",
      sanitizeX12(patient.last_name),
      sanitizeX12(patient.first_name),
    ]),
  );

  if (nonEmpty(patient.address1)) {
    segs.push(buildSegment(["N3", sanitizeX12(patient.address1)]));
    segs.push(
      buildSegment([
        "N4",
        sanitizeX12(patient.city),
        sanitizeX12(patient.state),
        fmtZip(patient.zip),
      ]),
    );
  }

  // DMG — Patient Date of Birth / Gender
  segs.push(
    buildSegment([
      "DMG", "D8",
      formatDateYYYYMMDD(patient.dob),
      patient.sex ? sanitizeX12(patient.sex) : "",
    ]),
  );

  return segs;
}

function buildClaimLoop(claim: Map837PClaim): string[] {
  const segs: string[] = [];

  const totalCharge = formatMoney(Number(claim.total_charge ?? 0));
  const pos = sanitizeX12(claim.place_of_service);
  const frequency = sanitizeX12(claim.claim_frequency_code || "1") || "1";
  const acceptAssign = claim.accept_assignment === false ? "N" : "Y";
  // CLM08 benefits assignment certification indicator
  const benefitsAssign = claim.benefits_assignment === false ? "N" : "A";
  // CLM09 release of information code (A = Informed Consent, N = No)
  const releaseInfo = claim.release_of_information === false ? "N" : "A";

  // ── CLM ──────────────────────────────────────────────────────────────────
  // CLM05 is a composite element (pos:B:frequency); must not be passed
  // through buildSegment/sanitizeX12 which would replace ":" with spaces.
  const clm05 = `${pos}${X12.componentSeparator}B${X12.componentSeparator}${frequency}`;
  segs.push(
    rawSeg(
      "CLM",
      sanitizeX12(claim.claim_identifier),  // CLM01
      totalCharge,                           // CLM02
      "",                                    // CLM03 (not used)
      "",                                    // CLM04 (not used)
      clm05,                                 // CLM05 composite
      acceptAssign,                          // CLM07
      benefitsAssign,                        // CLM08
      releaseInfo,                           // CLM09
      "I",                                   // CLM10 patient signature source code
    ),
  );

  // ── DTPs (clinical dates) ─────────────────────────────────────────────────
  if (nonEmpty(claim.onset_date)) {
    segs.push(buildSegment(["DTP", "431", "D8", formatDateYYYYMMDD(claim.onset_date!)]));
  }
  if (nonEmpty(claim.initial_treatment_date)) {
    segs.push(buildSegment(["DTP", "454", "D8", formatDateYYYYMMDD(claim.initial_treatment_date!)]));
  }
  if (nonEmpty(claim.latest_visit_date)) {
    segs.push(buildSegment(["DTP", "304", "D8", formatDateYYYYMMDD(claim.latest_visit_date!)]));
  }
  if (nonEmpty(claim.acute_manifestation_date)) {
    segs.push(buildSegment(["DTP", "453", "D8", formatDateYYYYMMDD(claim.acute_manifestation_date!)]));
  }
  if (nonEmpty(claim.accident_date)) {
    segs.push(buildSegment(["DTP", "439", "D8", formatDateYYYYMMDD(claim.accident_date!)]));
  }

  // ── REFs ──────────────────────────────────────────────────────────────────
  // REF*D9 — Clearinghouse Claim Control Number for corrected/replacement/void
  if ((frequency === "7" || frequency === "8") && nonEmpty(claim.payer_claim_control_number)) {
    segs.push(buildSegment(["REF", "D9", sanitizeX12(claim.payer_claim_control_number)]));
  }
  // REF*G1 — Prior Authorisation Number
  if (nonEmpty(claim.prior_authorization_number)) {
    segs.push(buildSegment(["REF", "G1", sanitizeX12(claim.prior_authorization_number)]));
  }
  // REF*F8 — Original Reference Number (payer ICN/DCN for the prior claim)
  if (nonEmpty(claim.original_reference_number)) {
    segs.push(buildSegment(["REF", "F8", sanitizeX12(claim.original_reference_number)]));
  }

  // ── HI — Diagnosis Codes ─────────────────────────────────────────────────
  // All ICD-10 codes in a single HI segment: ABK for principal, ABF for additional.
  // Periods are stripped per the X12 companion guide.
  const dxCodes = (claim.diagnosis_codes ?? []).filter(Boolean).slice(0, 12);
  if (dxCodes.length > 0) {
    const hiElements: string[] = ["HI"];
    dxCodes.forEach((code, idx) => {
      const qualifier = idx === 0 ? "ABK" : "ABF";
      hiElements.push(`${qualifier}${X12.componentSeparator}${fmtDx(code)}`);
    });
    // HI composites contain ":" separators; use rawSeg to preserve them.
    segs.push(rawSeg(...hiElements));
  }

  // ── PWK — Claim Attachment ────────────────────────────────────────────────
  // Emitted only when both type code and control number are present.
  if (nonEmpty(claim.attachment_indicator) && nonEmpty(claim.attachment_control_number)) {
    segs.push(
      buildSegment([
        "PWK",
        sanitizeX12(claim.attachment_indicator),   // PWK01 — report type code
        "BM",                                       // PWK02 — transmission code (BM = by mail)
        "",                                         // PWK03 (not used)
        "",                                         // PWK04 (not used)
        "AC",                                       // PWK05 — identification code qualifier
        sanitizeX12(claim.attachment_control_number), // PWK06 — control number
      ]),
    );
  }

  // ── NTE — Claim Note ──────────────────────────────────────────────────────
  if (nonEmpty(claim.note)) {
    segs.push(buildSegment(["NTE", "ADD", sanitizeX12(claim.note).slice(0, 80)]));
  }

  return segs;
}

function buildReferringProviderLoop(rp: Map837PReferringProvider): string[] {
  // ── Loop 2310A — Referring Provider ──────────────────────────────────────
  return [
    buildSegment([
      "NM1", "DN", "1",
      sanitizeX12(rp.last_name),
      nonEmpty(rp.first_name) ? sanitizeX12(rp.first_name) : "",
      "", "", "",
      "XX",
      sanitizeX12(rp.npi),
    ]),
  ];
}

function buildRenderingProviderLoop(rp: Map837PRenderingProvider): string[] {
  const segs: string[] = [];

  // ── Loop 2310B — Rendering Provider ──────────────────────────────────────
  const entityType = sanitizeX12(rp.entity_type || "1");
  segs.push(
    buildSegment([
      "NM1", "82",
      entityType,
      sanitizeX12(rp.last_name_or_org),
      entityType === "1" && nonEmpty(rp.first_name) ? sanitizeX12(rp.first_name) : "",
      "", "", "",
      "XX",
      sanitizeX12(rp.npi),
    ]),
  );

  // PRV*PE — Rendering Provider Taxonomy (emitted when taxonomy is present)
  if (nonEmpty(rp.taxonomy)) {
    segs.push(buildSegment(["PRV", "PE", "PXC", sanitizeX12(rp.taxonomy)]));
  }

  return segs;
}

function buildServiceFacilityLoop(sf: Map837PServiceFacility): string[] {
  const segs: string[] = [];

  // ── Loop 2310D — Service Facility ────────────────────────────────────────
  segs.push(
    buildSegment([
      "NM1", "77", "2",
      sanitizeX12(sf.name),
      "", "", "", "",
      nonEmpty(sf.npi) ? "XX" : "",
      nonEmpty(sf.npi) ? sanitizeX12(sf.npi) : "",
    ]),
  );
  segs.push(buildSegment(["N3", sanitizeX12(sf.address1)]));
  segs.push(buildSegment(["N4", sanitizeX12(sf.city), sanitizeX12(sf.state), fmtZip(sf.zip)]));

  return segs;
}

function buildServiceLine(
  line: Map837PServiceLine,
  claimPos: string,
  claimRenderingNpi: string | undefined,
): string[] {
  const segs: string[] = [];

  // ── LX — Service Line Number ──────────────────────────────────────────────
  segs.push(buildSegment(["LX", line.line_number]));

  // ── SV1 — Professional Service ───────────────────────────────────────────
  // SV101 (procedure composite HC:code[:mod...]) and SV107 (diagnosis pointer
  // composite) both contain ":" separators; use rawSeg to preserve them.
  segs.push(
    rawSeg(
      "SV1",
      procedureComposite(line.procedure_code, line.modifiers),  // SV101 composite
      formatMoney(Number(line.charge_amount)),                   // SV102
      "UN",                                                      // SV103 unit of measure
      Number(line.units),                                        // SV104
      sanitizeX12(line.place_of_service || claimPos),           // SV105
      "",                                                        // SV106 (not used)
      pointerList(line.diagnosis_pointers),                      // SV107
    ),
  );

  // ── DTP*472 — Date of Service ────────────────────────────────────────────
  segs.push(buildSegment(["DTP", "472", "D8", formatDateYYYYMMDD(line.date_of_service)]));

  // ── REF*6R — Line Item Control Number ────────────────────────────────────
  if (nonEmpty(line.line_control_number)) {
    segs.push(buildSegment(["REF", "6R", sanitizeX12(line.line_control_number)]));
  }

  // ── NTE — Line Note ──────────────────────────────────────────────────────
  if (nonEmpty(line.note)) {
    segs.push(buildSegment(["NTE", "ADD", sanitizeX12(line.note).slice(0, 80)]));
  }

  // ── Loop 2420A — Line-Level Rendering Provider ────────────────────────────
  // Emitted only when a line-level rendering provider is present AND its NPI
  // differs from the claim-level rendering provider NPI (or there is no
  // claim-level rendering provider).
  if (
    line.rendering_provider &&
    nonEmpty(line.rendering_provider.npi) &&
    line.rendering_provider.npi.trim() !== (claimRenderingNpi ?? "").trim()
  ) {
    const lrp = line.rendering_provider;
    const entityType = sanitizeX12(lrp.entity_type || "1");
    segs.push(
      buildSegment([
        "NM1", "82",
        entityType,
        sanitizeX12(lrp.last_name_or_org),
        entityType === "1" && nonEmpty(lrp.first_name) ? sanitizeX12(lrp.first_name) : "",
        "", "", "",
        "XX",
        sanitizeX12(lrp.npi),
      ]),
    );
    if (nonEmpty(lrp.taxonomy)) {
      segs.push(buildSegment(["PRV", "PE", "PXC", sanitizeX12(lrp.taxonomy)]));
    }
  }

  return segs;
}

// ─── Main mapper ──────────────────────────────────────────────────────────────

/**
 * Map claim data into a complete HIPAA X12 837P 005010X222A1 transaction.
 *
 * Validates all required fields first. Returns `{ ok: false, validation_errors }`
 * when any required field is missing, without emitting any X12 content.
 *
 * On success returns `{ ok: true, file_content, file_name, ... }`.
 *
 * @example
 * ```ts
 * const result = map837p({ envelope, billing_provider, payer, subscriber, claim, service_lines });
 * if (!result.ok) {
 *   console.error("837P mapping errors:", result.validation_errors);
 * } else {
 *   await fs.writeFile(result.file_name, result.file_content);
 * }
 * ```
 */
export function map837p(input: Map837PInput): Map837POutput {
  // ── Step 1: validate ──────────────────────────────────────────────────────
  const validationErrors = validate837pInput(input);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      file_content: "",
      file_name: "",
      isa_control_number: "",
      gs_control_number: "",
      st_control_number: "",
      segment_count: 0,
      validation_errors: validationErrors,
    };
  }

  // ── Step 2: generate control numbers ────────────────────────────────────
  const now = input.now ?? new Date();
  const isaControlNumber = generateControlNumber(9);
  const gsControlNumber = String(Number(isaControlNumber) || isaControlNumber);
  const stControlNumber = generateControlNumber(4);
  const batchControl = generateControlNumber(8);

  const segments: string[] = [];

  // ── Step 3: ISA / GS / ST / BHT + Loops 1000A / 1000B ───────────────────
  segments.push(
    ...buildEnvelope(input, {
      isa: isaControlNumber,
      gs: gsControlNumber,
      st: stControlNumber,
      batch: batchControl,
      now,
    }),
  );

  // ── Step 4: HL counter ───────────────────────────────────────────────────
  let hlCounter = 1;

  // ── Step 5: Loop 2000A / 2010AA — Billing Provider ───────────────────────
  const billingHl = hlCounter++;
  segments.push(...buildBillingProviderLoop(input.billing_provider, billingHl));

  // ── Step 6: Loop 2000B / 2010BA / 2010BB — Subscriber + Payer ───────────
  const hasPatient = !input.subscriber.is_patient;
  const subscriberHl = hlCounter++;
  segments.push(
    ...buildSubscriberLoop(
      input.subscriber,
      input.payer,
      billingHl,
      subscriberHl,
      hasPatient,
    ),
  );

  // ── Step 7: Loop 2000C / 2010CA — Patient (conditional) ──────────────────
  if (hasPatient && input.patient) {
    const patientHl = hlCounter++;
    segments.push(...buildPatientLoop(input.patient, subscriberHl, patientHl));
  }

  // ── Step 8: Loop 2300 — Claim ─────────────────────────────────────────────
  segments.push(...buildClaimLoop(input.claim));

  // ── Step 9: Loop 2310A — Referring Provider (conditional) ────────────────
  if (input.referring_provider) {
    segments.push(...buildReferringProviderLoop(input.referring_provider));
  }

  // ── Step 10: Loop 2310B — Rendering Provider (conditional) ───────────────
  if (input.rendering_provider) {
    segments.push(...buildRenderingProviderLoop(input.rendering_provider));
  }

  // ── Step 11: Loop 2310D — Service Facility (conditional) ─────────────────
  if (input.service_facility) {
    segments.push(...buildServiceFacilityLoop(input.service_facility));
  }

  // ── Step 12: Loop 2400 + 2420A — Service Lines ───────────────────────────
  const claimPos = sanitizeX12(input.claim.place_of_service);
  const claimRenderingNpi = input.rendering_provider?.npi?.trim();
  for (const line of input.service_lines) {
    segments.push(...buildServiceLine(line, claimPos, claimRenderingNpi));
  }

  // ── Step 13: SE — count segments from ST through SE (inclusive) ───────────
  const bodyWithoutSE = segments.join("");
  const segmentCount = countSegments(bodyWithoutSE, true) + 1; // +1 for SE itself
  segments.push(buildSegment(["SE", segmentCount, stControlNumber]));
  segments.push(buildSegment(["GE", 1, gsControlNumber]));
  segments.push(buildSegment(["IEA", 1, isaControlNumber]));

  const file_content = segments.join("");
  const file_name = makeFileName(now);

  return {
    ok: true,
    file_content,
    file_name,
    isa_control_number: isaControlNumber,
    gs_control_number: gsControlNumber,
    st_control_number: stControlNumber,
    segment_count: segmentCount,
    validation_errors: [],
  };
}
