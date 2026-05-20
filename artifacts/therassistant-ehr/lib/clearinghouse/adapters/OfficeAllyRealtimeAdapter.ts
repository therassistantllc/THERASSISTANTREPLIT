// File: lib/clearinghouse/adapters/OfficeAllyRealtimeAdapter.ts
// Office Ally Real Time EDI adapter for 270/271 and 276/277.
// Based on Office Ally Real Time EDI Companion Guide v20250529.

import type {
  ClaimStatusRequestInput,
  ClaimStatusResponseNormalized,
  EligibilityRequestInput,
  EligibilityResponseNormalized,
} from "@/types/clearinghouse";

type RealtimeTransaction = "270" | "276";

type RealtimeConfig = {
  username: string;
  password: string;
  senderId: string;
  receiverId: string;
  endpoint: string;
  mode: "soap" | "mime";
};

const SOAP_ENDPOINT = "https://wsd.officeally.com/TransactionService/rtx.svc";
const MIME_ENDPOINT = "https://wsd.officeally.com/TransactionSite/realtime-request/MIME";
const RECEIVER_ID = "OFFALLY";
const CORE_RULE_VERSION = "2.2.0";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Office Ally realtime EDI.`);
  return value;
}

function getConfig(): RealtimeConfig {
  const mode = (process.env.OFFICE_ALLY_REALTIME_MODE ?? "soap").toLowerCase();
  if (mode !== "soap" && mode !== "mime") {
    throw new Error("OFFICE_ALLY_REALTIME_MODE must be soap or mime.");
  }

  return {
    username: requireEnv("OFFICE_ALLY_REALTIME_USERNAME"),
    password: requireEnv("OFFICE_ALLY_REALTIME_PASSWORD"),
    senderId: requireEnv("OFFICE_ALLY_REALTIME_SENDER_ID"),
    receiverId: process.env.OFFICE_ALLY_REALTIME_RECEIVER_ID ?? RECEIVER_ID,
    endpoint: process.env.OFFICE_ALLY_REALTIME_ENDPOINT ?? (mode === "soap" ? SOAP_ENDPOINT : MIME_ENDPOINT),
    mode,
  };
}

function nowParts() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return {
    isaDate: `${yy}${mm}${dd}`,
    gsDate: `${yyyy}${mm}${dd}`,
    time: `${hh}${min}`,
    iso: d.toISOString(),
  };
}

function controlNumber(length = 9) {
  return String(Math.floor(Math.random() * Number("9".repeat(length)))).padStart(length, "0");
}

function uuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function pad15(value: string) {
  return value.padEnd(15, " ").slice(0, 15);
}

function clean(value: unknown, maxLength?: number) {
  const v = String(value ?? "")
    .replace(/[~*:\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return maxLength ? v.slice(0, maxLength) : v;
}

function segment(id: string, ...elements: Array<string | number | null | undefined>) {
  return [id, ...elements.map((e) => String(e ?? ""))].join("*") + "~";
}

function buildIsaGs(transaction: RealtimeTransaction, senderId: string, control: string) {
  const { isaDate, gsDate, time } = nowParts();
  const gs01 = transaction === "270" ? "HS" : "HR";
  const gs08 = transaction === "270" ? "005010X279A1" : "005010X212";

  const isa = [
    "ISA",
    "00",
    "          ",
    "00",
    "          ",
    "ZZ",
    pad15(senderId),
    "01",
    pad15(RECEIVER_ID),
    isaDate,
    time,
    "^",
    "00501",
    control,
    "0",
    "P",
    ":",
  ].join("*") + "~";

  const gs = segment("GS", gs01, senderId, RECEIVER_ID, gsDate, time, String(Number(control)), "X", gs08);
  return { isa, gs, gs08, gsDate, time };
}

function build270(input: EligibilityRequestInput, senderId: string) {
  const control = controlNumber();
  const { isa, gs } = buildIsaGs("270", senderId, control);
  const st = "0001";
  const serviceType = input.serviceTypeCode ?? "98";
  const payerName = clean(input.payerName ?? "PAYER", 35);
  const payerId = clean(input.payerId ?? "", 80);
  const subscriberName = clean(input.subscriberName ?? input.clientName ?? "SUBSCRIBER", 35);
  const memberId = clean(input.memberId ?? "", 80);

  const segments = [
    isa,
    gs,
    segment("ST", "270", st, "005010X279A1"),
    segment("BHT", "0022", "13", control, nowParts().gsDate, nowParts().time),
    segment("HL", "1", "", "20", "1"),
    segment("NM1", "PR", "2", payerName, "", "", "", "", "PI", payerId),
    segment("HL", "2", "1", "21", "1"),
    segment("NM1", "1P", "2", "PROVIDER"),
    segment("HL", "3", "2", "22", "0"),
    segment("TRN", "1", control),
    segment("NM1", "IL", "1", subscriberName, "", "", "", "", "MI", memberId),
    segment("EQ", serviceType),
  ];

  const seCount = segments.length - 2 + 1;
  segments.push(segment("SE", String(seCount), st));
  segments.push(segment("GE", "1", String(Number(control))));
  segments.push(segment("IEA", "1", control));
  return { x12: segments.join(""), control };
}

function build276(input: ClaimStatusRequestInput, senderId: string) {
  const control = controlNumber();
  const { isa, gs } = buildIsaGs("276", senderId, control);
  const st = "0001";
  const payerName = clean(input.payerName ?? "PAYER", 35);
  const payerId = clean(input.payerId ?? "", 80);
  const memberId = clean(input.memberId ?? input.clientId ?? "", 80);

  const segments = [
    isa,
    gs,
    segment("ST", "276", st, "005010X212"),
    segment("BHT", "0010", "13", control, nowParts().gsDate, nowParts().time),
    segment("HL", "1", "", "20", "1"),
    segment("NM1", "PR", "2", payerName, "", "", "", "", "PI", payerId),
    segment("HL", "2", "1", "21", "1"),
    segment("NM1", "1P", "2", "PROVIDER"),
    segment("HL", "3", "2", "22", "0"),
    segment("NM1", "IL", "1", "CLIENT", "", "", "", "", "MI", memberId),
    segment("TRN", "1", clean(input.claimId, 50)),
  ];

  if (input.claimAmount != null) segments.push(segment("AMT", "T3", input.claimAmount));
  if (input.dateOfService) segments.push(segment("DTP", "472", "D8", input.dateOfService.replace(/-/g, "").slice(0, 8)));

  const seCount = segments.length - 2 + 1;
  segments.push(segment("SE", String(seCount), st));
  segments.push(segment("GE", "1", String(Number(control))));
  segments.push(segment("IEA", "1", control));
  return { x12: segments.join(""), control };
}

function payloadType(transaction: RealtimeTransaction) {
  return transaction === "270" ? "X12_270_Request_005010X279A1" : "X12_276_Request_005010X212";
}

function buildSoapEnvelope(config: RealtimeConfig, transaction: RealtimeTransaction, payload: string, payloadId: string) {
  return `<soapenv:Envelope xmlns:soapenv="http://www.w3.org/2003/05/soap-envelope">
  <soapenv:Header>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>${config.username}</wsse:Username>
        <wsse:Password>${config.password}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </soapenv:Header>
  <soapenv:Body>
    <ns1:COREEnvelopeRealTimeRequest xmlns:ns1="http://www.caqh.org/SOAP/WSDL/CORERule2.2.0.xsd">
      <PayloadType>${payloadType(transaction)}</PayloadType>
      <ProcessingMode>RealTime</ProcessingMode>
      <PayloadID>${payloadId}</PayloadID>
      <TimeStamp>${new Date().toISOString()}</TimeStamp>
      <SenderID>${config.senderId}</SenderID>
      <ReceiverID>${config.receiverId}</ReceiverID>
      <CORERuleVersion>${CORE_RULE_VERSION}</CORERuleVersion>
      <Payload><![CDATA[${payload}]]></Payload>
    </ns1:COREEnvelopeRealTimeRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function postSoap(config: RealtimeConfig, transaction: RealtimeTransaction, x12: string, payloadId: string) {
  const body = buildSoapEnvelope(config, transaction, x12, payloadId);
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/soap+xml; charset=utf-8;action=RealTimeTransaction;",
      Action: "RealTimeTransaction",
    },
    body,
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Office Ally realtime SOAP failed ${response.status}: ${raw.slice(0, 500)}`);
  return raw;
}

async function postMime(config: RealtimeConfig, transaction: RealtimeTransaction, x12: string, payloadId: string) {
  const form = new FormData();
  form.set("PayloadType", payloadType(transaction));
  form.set("PayloadId", payloadId);
  form.set("ReceiverId", config.receiverId);
  form.set("Payload", x12);
  form.set("SenderId", config.senderId);
  form.set("TimeStamp", new Date().toISOString());
  form.set("UserName", config.username);
  form.set("ProcessingMode", "RealTime");
  form.set("Password", config.password);
  form.set("CoreRuleVersion", CORE_RULE_VERSION);

  const response = await fetch(config.endpoint, { method: "POST", body: form });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Office Ally realtime MIME failed ${response.status}: ${raw.slice(0, 500)}`);
  return raw;
}

function extractX12(rawResponse: string) {
  const cdata = rawResponse.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i)?.[1];
  const candidate = cdata ?? rawResponse;
  const x12 = candidate.match(/ISA\*[\s\S]*?IEA\*\d+\*\d+~/)?.[0];
  return x12 ?? candidate.trim();
}

/** Decode an X12 271 EB02 coverage-level code into a human-readable string. */
function decodeCoverageLevel(code: string | null | undefined): string | null {
  if (!code) return null;
  const map: Record<string, string> = {
    CHD: "children only",
    DEP: "dependents only",
    ECH: "employee and children",
    ESP: "employee and spouse",
    FAM: "family",
    IND: "individual",
    SPC: "spouse and children",
    SPO: "spouse only",
  };
  return map[code.toUpperCase()] ?? code;
}

/** Pull the coverage-level code from the first EB segment (EB02). */
function extractCoverageLevel(rawX12: string): string | null {
  // Segments are tilde-delimited per X12; elements are asterisk-delimited.
  const segments = rawX12.split(/~\s*/);
  for (const seg of segments) {
    if (!seg.startsWith("EB")) continue;
    const elements = seg.split("*");
    // EB01 = eligibility/benefit code, EB02 = coverage level code.
    const eb02 = elements[2]?.trim();
    if (eb02) return decodeCoverageLevel(eb02);
  }
  return null;
}

function normalize271(rawX12: string): EligibilityResponseNormalized {
  const hasAaa42 = rawX12.includes("AAA*") && rawX12.includes("*42*");
  const hasAaa80 = rawX12.includes("AAA*") && rawX12.includes("*80*");
  const hasAaa15 = rawX12.includes("AAA*") && rawX12.includes("*15*");
  if (hasAaa42) return { status: "error", message: "Payer unable to respond at current time (AAA03=42).", rawBenefits: { rawX12 } };
  if (hasAaa80) return { status: "error", message: "No payer response received; transaction terminated (AAA03=80).", rawBenefits: { rawX12 } };
  if (hasAaa15) return { status: "not_found", message: "Required application data missing or member not matched (AAA03=15).", rawBenefits: { rawX12 } };
  if (rawX12.includes("EB*1") || rawX12.includes("EB**")) {
    return {
      status: "active",
      coverageLevel: extractCoverageLevel(rawX12),
      message: "Eligibility response received.",
      rawBenefits: { rawX12 },
    };
  }
  return { status: "unknown", message: "271 received; detailed parser pending.", rawBenefits: { rawX12 } };
}

function normalize277(rawX12: string): ClaimStatusResponseNormalized {
  if (rawX12.includes("STC*A1")) return { status: "accepted", payerMessage: "Claim acknowledged/accepted.", rawStatus: { rawX12 } };
  if (rawX12.includes("STC*A2") || rawX12.includes("STC*A3")) return { status: "pending", payerMessage: "Claim pending/in process.", rawStatus: { rawX12 } };
  if (rawX12.includes("STC*F2") || rawX12.includes("DENIED")) return { status: "denied", payerMessage: "Claim denied.", rawStatus: { rawX12 } };
  if (rawX12.includes("REJECT")) return { status: "rejected", payerMessage: "Claim rejected.", rawStatus: { rawX12 } };
  if (rawX12.includes("PAID")) return { status: "paid", payerMessage: "Claim paid.", rawStatus: { rawX12 } };
  return { status: "unknown", payerMessage: "277 received; detailed parser pending.", rawStatus: { rawX12 } };
}

export class OfficeAllyRealtimeAdapter {
  readonly vendor = "office_ally" as const;

  async runEligibility270(input: EligibilityRequestInput) {
    const config = getConfig();
    const { x12, control } = build270(input, config.senderId);
    const payloadId = uuid();
    const rawResponse = config.mode === "mime"
      ? await postMime(config, "270", x12, payloadId)
      : await postSoap(config, "270", x12, payloadId);
    const x12Response = extractX12(rawResponse);

    return {
      controlNumber: control,
      correlationId: payloadId,
      rawRequest: x12,
      rawResponse: x12Response,
      normalized: normalize271(x12Response),
    };
  }

  async runClaimStatus276(input: ClaimStatusRequestInput) {
    const config = getConfig();
    const { x12, control } = build276(input, config.senderId);
    const payloadId = uuid();
    const rawResponse = config.mode === "mime"
      ? await postMime(config, "276", x12, payloadId)
      : await postSoap(config, "276", x12, payloadId);
    const x12Response = extractX12(rawResponse);

    return {
      controlNumber: control,
      correlationId: payloadId,
      rawRequest: x12,
      rawResponse: x12Response,
      normalized: normalize277(x12Response),
    };
  }
}
