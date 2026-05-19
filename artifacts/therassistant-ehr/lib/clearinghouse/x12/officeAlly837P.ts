// File: lib/clearinghouse/x12/officeAlly837P.ts
// Office Ally Professional Claim (837P) generator.
// Built against Office Ally OA Companion Guide Professional (837P) Claims, 005010X222A1.

export type OfficeAlly837PConfig = {
  submitterId: string;
  submitterName: string;
  senderQualifier?: "30" | "ZZ";
  receiverQualifier?: "30" | "ZZ";
  receiverId?: string;
  receiverName?: string;
  gsReceiverCode?: string;
  usageIndicator?: "T" | "P";
  productionTestFileNameKeyword?: "OATEST" | null;
};

export type OfficeAllyBillingProvider = {
  entityType: "1" | "2";
  organizationName: string;
  firstName?: string | null;
  npi: string;
  taxId: string;
  taxIdQualifier?: "EI" | "SY";
  address1: string;
  city: string;
  state: string;
  zip: string;
  taxonomyCode?: string | null;
};

export type OfficeAllySubscriber = {
  firstName: string;
  lastName: string;
  memberId: string;
  dateOfBirth: string;
  gender?: "F" | "M" | "U" | null;
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

export type OfficeAllyPayer = {
  name: string;
  payerId: string;
};

export type OfficeAllyRenderingProvider = {
  entityType: "1" | "2";
  lastNameOrOrganization: string;
  firstName?: string | null;
  npi: string;
};

export type OfficeAllyServiceLine = {
  cptHcpcsCode: string;
  modifiers?: string[];
  chargeAmount: number | string;
  units: number | string;
  diagnosisPointers?: string[];
  serviceDate: string;
  placeOfServiceCode?: string | null;
};

export type OfficeAlly837PClaimInput = {
  claimId: string;
  claimNumber: string;
  organizationId: string;
  clientId: string;
  totalChargeAmount: number | string;
  placeOfServiceCode: string;
  dateOfServiceFrom: string;
  dateOfServiceTo?: string | null;
  diagnosisCodes: string[];
  billingProvider: OfficeAllyBillingProvider;
  subscriber: OfficeAllySubscriber;
  payer: OfficeAllyPayer;
  renderingProvider?: OfficeAllyRenderingProvider | null;
  serviceLines: OfficeAllyServiceLine[];
};

export type OfficeAlly837PBuildResult = {
  x12: string;
  fileName: string;
  controlNumber: string;
  interchangeControlNumber: string;
  groupControlNumber: string;
  transactionSetControlNumber: string;
  validationErrors: string[];
};

const ELEMENT_SEPARATOR = "*";
const SEGMENT_TERMINATOR = "~";
const COMPONENT_SEPARATOR = ":";
const REPETITION_SEPARATOR = "^";

function nowParts() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return { isaDate: `${yy}${mm}${dd}`, gsDate: `${yyyy}${mm}${dd}`, time: `${hh}${min}` };
}

function controlNumber(length = 9) {
  return String(Math.floor(Math.random() * Number("9".repeat(length)))).padStart(length, "0");
}

function clean(value: unknown, maxLength?: number) {
  const v = String(value ?? "")
    .replace(/[~*:\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return maxLength ? v.slice(0, maxLength) : v;
}

function money(value: number | string) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(2).replace(/\.00$/, "");
}

function date8(value: string) {
  return value.replace(/-/g, "").slice(0, 8);
}

function padIsa(value: string) {
  return value.padEnd(15, " ").slice(0, 15);
}

function segment(id: string, ...elements: Array<string | number | null | undefined>) {
  return [id, ...elements.map((e) => String(e ?? ""))].join(ELEMENT_SEPARATOR) + SEGMENT_TERMINATOR;
}

function validateConfig(config: OfficeAlly837PConfig) {
  const errors: string[] = [];
  if (!config.submitterId) errors.push("Office Ally submitterId is required.");
  if (!config.submitterName) errors.push("Office Ally submitterName is required.");
  return errors;
}

export function validateOfficeAlly837P(input: OfficeAlly837PClaimInput, config: OfficeAlly837PConfig) {
  const errors = validateConfig(config);

  if (!input.claimId) errors.push("claimId is required.");
  if (!input.claimNumber) errors.push("claimNumber is required.");
  if (!input.clientId) errors.push("clientId is required.");
  if (!input.placeOfServiceCode) errors.push("placeOfServiceCode is required.");
  if (!input.diagnosisCodes?.length) errors.push("At least one diagnosis code is required.");
  if (!input.serviceLines?.length) errors.push("At least one service line is required.");

  const bp = input.billingProvider;
  if (!bp?.organizationName) errors.push("Billing provider name is required.");
  if (!bp?.npi || !/^\d{10}$/.test(bp.npi)) errors.push("Billing provider 10-digit NPI is required.");
  if (!bp?.taxId) errors.push("Billing provider tax ID is required.");
  if (!bp?.address1) errors.push("Billing provider physical address is required.");
  if (bp?.address1 && /P\.?\s*O\.?\s*BOX/i.test(bp.address1)) errors.push("Office Ally requires a physical billing provider address; PO Box is not allowed.");
  if (!bp?.city || !bp?.state || !bp?.zip) errors.push("Billing provider city, state, and ZIP are required.");

  const sub = input.subscriber;
  if (!sub?.firstName) errors.push("Subscriber first name is required.");
  if (!sub?.lastName) errors.push("Subscriber last name is required.");
  if (!sub?.memberId) errors.push("Subscriber member ID is required.");
  if (!sub?.dateOfBirth) errors.push("Subscriber date of birth is required.");

  if (!input.payer?.name) errors.push("Payer name is required.");
  if (!input.payer?.payerId) errors.push("Office Ally payer ID is required.");

  input.serviceLines?.forEach((line, index) => {
    const row = index + 1;
    if (!line.cptHcpcsCode) errors.push(`Service line ${row}: CPT/HCPCS is required.`);
    if (!line.chargeAmount) errors.push(`Service line ${row}: chargeAmount is required.`);
    if (!line.units) errors.push(`Service line ${row}: units are required.`);
    if (!line.serviceDate) errors.push(`Service line ${row}: serviceDate is required.`);
  });

  return errors;
}

export function buildOfficeAlly837P(input: OfficeAlly837PClaimInput, config: OfficeAlly837PConfig): OfficeAlly837PBuildResult {
  const validationErrors = validateOfficeAlly837P(input, config);
  const { isaDate, gsDate, time } = nowParts();
  const interchangeControlNumber = controlNumber(9);
  const groupControlNumber = String(Number(interchangeControlNumber));
  const transactionSetControlNumber = "0001";
  const receiverId = config.receiverId ?? "330897513";
  const receiverName = config.receiverName ?? "OFFICEALLY";
  const gsReceiverCode = config.gsReceiverCode ?? "OA";
  const senderQualifier = config.senderQualifier ?? "ZZ";
  const receiverQualifier = config.receiverQualifier ?? "ZZ";
  const usageIndicator = config.usageIndicator ?? "P";
  const submitterId = clean(config.submitterId);

  const segments: string[] = [];

  segments.push(
    [
      "ISA",
      "00",
      "          ",
      "00",
      "          ",
      senderQualifier,
      padIsa(submitterId),
      receiverQualifier,
      padIsa(receiverId),
      isaDate,
      time,
      REPETITION_SEPARATOR,
      "00501",
      interchangeControlNumber,
      "0",
      usageIndicator,
      COMPONENT_SEPARATOR,
    ].join(ELEMENT_SEPARATOR) + SEGMENT_TERMINATOR,
  );

  segments.push(segment("GS", "HC", submitterId, gsReceiverCode, gsDate, time, groupControlNumber, "X", "005010X222A1"));
  segments.push(segment("ST", "837", transactionSetControlNumber, "005010X222A1"));
  segments.push(segment("BHT", "0019", "00", input.claimNumber, gsDate, time, "CH"));

  // 1000A Submitter
  segments.push(segment("NM1", "41", "2", clean(config.submitterName, 35), "", "", "", "", "46", submitterId));
  segments.push(segment("PER", "IC", clean(config.submitterName, 35)));

  // 1000B Receiver
  segments.push(segment("NM1", "40", "2", clean(receiverName, 35), "", "", "", "", "46", receiverId));

  // 2000A Billing provider hierarchical loop
  segments.push(segment("HL", "1", "", "20", "1"));
  if (input.billingProvider.taxonomyCode) {
    segments.push(segment("PRV", "BI", "PXC", clean(input.billingProvider.taxonomyCode)));
  }

  // 2010AA Billing Provider
  segments.push(
    segment(
      "NM1",
      "85",
      input.billingProvider.entityType,
      clean(input.billingProvider.organizationName, 60),
      input.billingProvider.entityType === "1" ? clean(input.billingProvider.firstName, 35) : "",
      "",
      "",
      "",
      "XX",
      clean(input.billingProvider.npi),
    ),
  );
  segments.push(segment("N3", clean(input.billingProvider.address1, 55)));
  segments.push(segment("N4", clean(input.billingProvider.city, 30), clean(input.billingProvider.state, 2), clean(input.billingProvider.zip, 15)));
  segments.push(segment("REF", input.billingProvider.taxIdQualifier ?? "EI", clean(input.billingProvider.taxId)));

  // 2000B Subscriber loop
  segments.push(segment("HL", "2", "1", "22", "0"));
  segments.push(segment("SBR", "P", "18", "", "", "", "", "", "", "CI"));

  // 2010BA Subscriber
  segments.push(segment("NM1", "IL", "1", clean(input.subscriber.lastName, 60), clean(input.subscriber.firstName, 35), "", "", "", "MI", clean(input.subscriber.memberId)));
  if (input.subscriber.address1 || input.subscriber.city || input.subscriber.state || input.subscriber.zip) {
    segments.push(segment("N3", clean(input.subscriber.address1, 55)));
    segments.push(segment("N4", clean(input.subscriber.city, 30), clean(input.subscriber.state, 2), clean(input.subscriber.zip, 15)));
  }
  segments.push(segment("DMG", "D8", date8(input.subscriber.dateOfBirth), input.subscriber.gender ?? "U"));

  // 2010BB Payer
  segments.push(segment("NM1", "PR", "2", clean(input.payer.name, 35), "", "", "", "", "PI", clean(input.payer.payerId)));

  // 2300 Claim
  segments.push(segment("CLM", clean(input.claimNumber, 20), money(input.totalChargeAmount), "", "", `${input.placeOfServiceCode}${COMPONENT_SEPARATOR}B${COMPONENT_SEPARATOR}1`, "Y", "A", "Y", "Y"));
  segments.push(segment("DTP", "431", "D8", date8(input.dateOfServiceFrom)));

  input.diagnosisCodes.slice(0, 12).forEach((diagnosisCode, index) => {
    segments.push(segment("HI", `${index === 0 ? "ABK" : "ABF"}${COMPONENT_SEPARATOR}${clean(diagnosisCode).replace(".", "")}`));
  });

  if (input.renderingProvider) {
    segments.push(
      segment(
        "NM1",
        "82",
        input.renderingProvider.entityType,
        clean(input.renderingProvider.lastNameOrOrganization, 60),
        input.renderingProvider.entityType === "1" ? clean(input.renderingProvider.firstName, 35) : "",
        "",
        "",
        "",
        "XX",
        clean(input.renderingProvider.npi),
      ),
    );
  }

  // 2400 service lines
  input.serviceLines.forEach((line, index) => {
    const lineNumber = String(index + 1);
    const modifiers = (line.modifiers ?? []).filter(Boolean).slice(0, 4).map((m) => clean(m, 2));
    const procedureComposite = ["HC", clean(line.cptHcpcsCode), ...modifiers].join(COMPONENT_SEPARATOR);
    const dxPointers = (line.diagnosisPointers?.length ? line.diagnosisPointers : ["1"]).slice(0, 4).join(COMPONENT_SEPARATOR);

    segments.push(segment("LX", lineNumber));
    segments.push(segment("SV1", procedureComposite, money(line.chargeAmount), "UN", line.units, line.placeOfServiceCode ?? input.placeOfServiceCode, "", dxPointers));
    segments.push(segment("DTP", "472", "D8", date8(line.serviceDate)));
  });

  const seSegmentCount = segments.length - 2 + 1; // ST through SE inclusive, excluding ISA/GS, including SE.
  segments.push(segment("SE", String(seSegmentCount), transactionSetControlNumber));
  segments.push(segment("GE", "1", groupControlNumber));
  segments.push(segment("IEA", "1", interchangeControlNumber));

  const claimKeyword = "837P";
  const testKeyword = config.productionTestFileNameKeyword === "OATEST" ? "OATEST_" : "";
  const fileName = `${clean(config.submitterId)}_${testKeyword}${claimKeyword}_${input.claimNumber}_${gsDate}.837`;

  return {
    x12: segments.join(""),
    fileName,
    controlNumber: interchangeControlNumber,
    interchangeControlNumber,
    groupControlNumber,
    transactionSetControlNumber,
    validationErrors,
  };
}
