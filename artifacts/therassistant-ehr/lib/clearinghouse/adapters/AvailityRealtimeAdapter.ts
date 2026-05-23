// File: lib/clearinghouse/adapters/AvailityRealtimeAdapter.ts
//
// Availity real-time 270/271 adapter — CAQH CORE Phase II SOAP+WSDL transport
// against https://gateway.availity.com:2021/core.
//
// The X12 270 payload is produced by `lib/edi/availity270/generate270.ts`
// (Companion Guide v.20260429 envelope) and wrapped in a CORE SOAP envelope
// per `lib/edi/availity270/soapEnvelope.ts`. The response payload is parsed
// back through `lib/edi/availity270/parse271.ts`.
//
// 276/277 still uses the legacy inline builder until Phase 2b lands the
// claim-status foundation; do not depend on its envelope details.

import { buildAvaility270 } from "@/lib/edi/availity270/generate270";
import { parseAvaility271 } from "@/lib/edi/availity270/parse271";
import { parsed271ToLegacyNormalized } from "@/lib/edi/availity270/parsedToLegacy";
import {
  AVAILITY_CORE_RECEIVER_ID,
  AVAILITY_CORE_SOAP_ENDPOINT,
  buildCoreSoapRequest,
  extractX12FromSoap,
  parseCoreSoapResponse,
  type CorePayloadType,
} from "@/lib/edi/availity270/soapEnvelope";
import type { Eligibility270Input, Parsed271Response } from "@/lib/edi/availity270/types";
import {
  EligibilityTimeoutError,
  resolveRealtimeDeadlineMs,
} from "@/lib/clearinghouse/eligibilityErrors";
import { parse999, type Parsed999Result } from "@/lib/edi/availity999/parse999";
import type {
  ClaimStatusRequestInput,
  ClaimStatusResponseNormalized,
  EligibilityRequestInput,
  EligibilityResponseNormalized,
} from "@/types/clearinghouse";
import type {
  CoreEligibilityAdapter,
  CoreEligibilityRunResult,
} from "@/lib/clearinghouse/pickEligibilityAdapter";

type RealtimeConfig = {
  username: string;
  password: string;
  senderId: string;
  receiverId: string;
  endpoint: string;
};

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Availity realtime EDI.`);
  return value;
}

function getConfig(): RealtimeConfig {
  return {
    username: requireEnv("AVAILITY_REALTIME_USERNAME"),
    password: requireEnv("AVAILITY_REALTIME_PASSWORD"),
    senderId: requireEnv("AVAILITY_REALTIME_SENDER_ID"),
    receiverId: process.env.AVAILITY_REALTIME_RECEIVER_ID ?? AVAILITY_CORE_RECEIVER_ID,
    endpoint: process.env.AVAILITY_REALTIME_ENDPOINT ?? AVAILITY_CORE_SOAP_ENDPOINT,
  };
}

function uuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
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
  };
}

function controlNumber(length = 9) {
  return String(Math.floor(Math.random() * Number("9".repeat(length)))).padStart(length, "0");
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

// ---------------------------------------------------------------------------
// 276 builder (LEGACY — claim-status foundation not yet implemented).
// ---------------------------------------------------------------------------
function build276(input: ClaimStatusRequestInput, config: RealtimeConfig) {
  const control = controlNumber();
  const { isaDate, gsDate, time } = nowParts();
  const st = "0001";
  const payerName = clean(input.payerName ?? "PAYER", 35);
  const payerId = clean(input.payerId ?? "", 80);
  const memberId = clean(input.memberId ?? input.clientId ?? "", 80);
  const isa =
    [
      "ISA",
      "00",
      "          ",
      "00",
      "          ",
      "ZZ",
      pad15(config.senderId),
      "01",
      pad15(config.receiverId),
      isaDate,
      time,
      "^",
      "00501",
      control,
      "0",
      "P",
      ":",
    ].join("*") + "~";
  const gs = segment("GS", "HR", config.senderId, config.receiverId, gsDate, time, String(Number(control)), "X", "005010X212");

  const segments: string[] = [
    isa,
    gs,
    segment("ST", "276", st, "005010X212"),
    segment("BHT", "0010", "13", control, gsDate, time),
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

function normalize277(rawX12: string): ClaimStatusResponseNormalized {
  if (rawX12.includes("STC*A1")) return { status: "accepted", payerMessage: "Claim acknowledged/accepted.", rawStatus: { rawX12 } };
  if (rawX12.includes("STC*A2") || rawX12.includes("STC*A3")) return { status: "pending", payerMessage: "Claim pending/in process.", rawStatus: { rawX12 } };
  if (rawX12.includes("STC*F2") || rawX12.includes("DENIED")) return { status: "denied", payerMessage: "Claim denied.", rawStatus: { rawX12 } };
  if (rawX12.includes("REJECT")) return { status: "rejected", payerMessage: "Claim rejected.", rawStatus: { rawX12 } };
  if (rawX12.includes("PAID")) return { status: "paid", payerMessage: "Claim paid.", rawStatus: { rawX12 } };
  return { status: "unknown", payerMessage: "277 received; detailed parser pending.", rawStatus: { rawX12 } };
}

async function postSoapEnvelope(
  config: RealtimeConfig,
  envelope: string,
  opts?: { deadlineMs?: number; correlationId?: string | null },
): Promise<string> {
  // CAQH CORE Eligibility Infrastructure Rule vEB.2.0 §4: real-time
  // submitters must observe a 20 second wall-clock deadline. We enforce
  // it here with an AbortController so the underlying socket is torn
  // down — leaving the connection open would let a slow payer hold a
  // request handler past its own deadline.
  const deadlineMs = opts?.deadlineMs ?? resolveRealtimeDeadlineMs();
  const controller = new AbortController();
  const start = Date.now();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8; action=RealTimeTransaction;",
        Action: "RealTimeTransaction",
        Accept: "application/soap+xml",
      },
      body: envelope,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const elapsedMs = Date.now() - start;
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new EligibilityTimeoutError({
        deadlineMs,
        elapsedMs,
        correlationId: opts?.correlationId ?? null,
      });
    }
    throw err;
  }
  let raw: string;
  try {
    raw = await response.text();
  } catch (err) {
    const elapsedMs = Date.now() - start;
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new EligibilityTimeoutError({
        deadlineMs,
        elapsedMs,
        correlationId: opts?.correlationId ?? null,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`Availity realtime SOAP failed ${response.status}: ${raw.slice(0, 500)}`);
  }
  return raw;
}

export interface AvailityRealtimeEligibilityResult {
  controlNumber: string;
  correlationId: string;
  payloadId: string;
  envelopeTimestamp: string;
  rawRequest: string;
  rawResponse: string;
  rawSoapRequest: string;
  rawSoapResponse: string;
  parsed: Parsed271Response;
  normalized: EligibilityResponseNormalized;
}

interface AvailityRealtimeAck {
  status: "accepted" | "accepted_with_errors" | "partially_accepted" | "rejected";
  hasErrors: boolean;
  rawPayload: string;
  parsed: Parsed999Result;
}

/**
 * Thrown when Availity answers a 270 with a 999 functional
 * acknowledgement instead of a 271. Callers should persist
 * `ack.status` / `ack.rawPayload` on the originating edi_transactions
 * row and surface the rejection to the user — there is no
 * eligibility data to display.
 */
class EligibilityAcknowledgementError extends Error {
  readonly code = "ELIGIBILITY_ACK_999" as const;
  readonly ack: AvailityRealtimeAck;
  readonly controlNumber: string;
  readonly correlationId: string;
  readonly rawSoapRequest: string;
  readonly rawSoapResponse: string;

  constructor(opts: {
    ack: AvailityRealtimeAck;
    controlNumber: string;
    correlationId: string;
    rawSoapRequest: string;
    rawSoapResponse: string;
  }) {
    super(`Availity returned a 999 functional acknowledgement (${opts.ack.status}): ${opts.ack.parsed.message}`);
    this.name = "EligibilityAcknowledgementError";
    this.ack = opts.ack;
    this.controlNumber = opts.controlNumber;
    this.correlationId = opts.correlationId;
    this.rawSoapRequest = opts.rawSoapRequest;
    this.rawSoapResponse = opts.rawSoapResponse;
  }
}

export class AvailityRealtimeAdapter implements CoreEligibilityAdapter {
  readonly vendor = "availity" as const;

  /**
   * Phase 2 CORE entrypoint exposed to `ClearinghouseService` via the
   * `pickEligibilityAdapter` factory. Thin alias around
   * `runEligibility(Eligibility270Input)` that narrows the return shape
   * to the subset the service persists.
   */
  async runEligibilityCORE(input: Eligibility270Input): Promise<CoreEligibilityRunResult> {
    const result = await this.runEligibility(input);
    return {
      rawRequest: result.rawRequest,
      rawResponse: result.rawResponse,
      normalized: result.normalized,
      controlNumber: result.controlNumber,
      correlationId: result.correlationId,
      parsed: result.parsed,
      payloadId: result.payloadId,
    };
  }

  /**
   * Primary entrypoint — accepts the rich `Eligibility270Input` shape and
   * runs a CAQH CORE-compliant 270 round-trip. Use this for any new
   * caller; the legacy `runEligibility270` is preserved only for the
   * `ClearinghouseAdapter` interface and degrades gracefully.
   */
  async runEligibility(input: Eligibility270Input): Promise<AvailityRealtimeEligibilityResult> {
    const config = getConfig();
    const generated = buildAvaility270(input);
    if (!generated.validation.isValid) {
      const reasons = generated.validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
      throw new Error(`270 validation failed before send: ${reasons}`);
    }

    const payloadType: CorePayloadType = "X12_270_Request_005010X279A1";
    const built = buildCoreSoapRequest({
      payload: generated.fileContent,
      payloadType,
      processingMode: "RealTime",
      payloadId: generated.payloadId,
      senderId: config.senderId,
      receiverId: config.receiverId,
      username: config.username,
      password: config.password,
    });

    const rawSoapResponse = await postSoapEnvelope(config, built.envelope, {
      correlationId: generated.payloadId,
    });
    // Redact WS-Security credentials before returning the envelope to
    // callers — the returned object often ends up in audit logs and DB rows.
    const redactedSoapRequest = built.envelope
      .replace(/<wsse:Username>[\s\S]*?<\/wsse:Username>/g, "<wsse:Username>***REDACTED***</wsse:Username>")
      .replace(/<wsse:Password[^>]*>[\s\S]*?<\/wsse:Password>/g, "<wsse:Password>***REDACTED***</wsse:Password>");
    const parsedSoap = parseCoreSoapResponse(rawSoapResponse);
    if (parsedSoap.soapFaultMessage) {
      throw new Error(`Availity SOAP fault: ${parsedSoap.soapFaultMessage}`);
    }
    if (parsedSoap.errorCode || parsedSoap.errorMessage) {
      throw new Error(
        `Availity CORE error ${parsedSoap.errorCode ?? "?"}: ${parsedSoap.errorMessage ?? "unknown"}`,
      );
    }

    const x12Response = extractX12FromSoap(rawSoapResponse);
    if (!x12Response) {
      throw new Error("Availity SOAP response did not contain an X12 271 or 999 payload.");
    }

    // The payer is permitted by CAQH CORE Infrastructure Rule vEB.2.0
    // §2 to return a 999 in place of a 271 when the 270 is structurally
    // invalid. When that happens, the payload is NOT a 271 — we must
    // refuse to parse it as one (which would otherwise downgrade a
    // structural rejection into a silent "unknown" eligibility) and
    // surface the ack as a typed error so callers persist the right
    // ack_status on the originating transaction.
    const looksLike999 =
      parsedSoap.payloadType === "X12_999_Response_005010X231A1" ||
      /\b(?:AK|IK)9\*/.test(x12Response) ||
      /\bST\*999\*/.test(x12Response);
    if (looksLike999) {
      const parsed999 = parse999(x12Response);
      throw new EligibilityAcknowledgementError({
        ack: {
          status: parsed999.summary,
          hasErrors: parsed999.hasErrors,
          rawPayload: x12Response,
          parsed: parsed999,
        },
        controlNumber: generated.isaControlNumber,
        correlationId: generated.payloadId,
        rawSoapRequest: redactedSoapRequest,
        rawSoapResponse,
      });
    }

    const fallbackStc = input.serviceTypeCodes?.[0] ?? "98";
    const parsed = parseAvaility271(x12Response);
    const normalized = parsed271ToLegacyNormalized(parsed, fallbackStc);

    return {
      controlNumber: generated.isaControlNumber,
      correlationId: generated.payloadId,
      payloadId: generated.payloadId,
      envelopeTimestamp: built.timestamp,
      rawRequest: generated.fileContent,
      rawResponse: x12Response,
      rawSoapRequest: redactedSoapRequest,
      rawSoapResponse,
      parsed,
      normalized,
    };
  }

  /**
   * Legacy entrypoint kept for the `ClearinghouseAdapter` interface. The
   * EligibilityRequestInput shape lacks subscriber DOB and provider NPI,
   * both required by CAQH CORE Data Content Rule. Callers MUST migrate to
   * `runEligibility(Eligibility270Input)`; this shim will reject any input
   * that cannot be promoted into a valid 270.
   */
  async runEligibility270(input: EligibilityRequestInput) {
    throw new Error(
      "AvailityRealtimeAdapter.runEligibility270 (legacy EligibilityRequestInput) is no longer " +
        "supported — call runEligibility(Eligibility270Input) with subscriber DOB and provider NPI.",
    );
    // unreachable — preserves the abstract interface signature
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = input;
  }

  // 276/277 left on legacy builder until claim-status foundation lands.
  async runClaimStatus276(input: ClaimStatusRequestInput) {
    const config = getConfig();
    const { x12, control } = build276(input, config);
    const payloadId = uuid();
    const built = buildCoreSoapRequest({
      payload: x12,
      payloadType: "X12_276_Request_005010X212",
      processingMode: "RealTime",
      payloadId,
      senderId: config.senderId,
      receiverId: config.receiverId,
      username: config.username,
      password: config.password,
    });
    const rawSoapResponse = await postSoapEnvelope(config, built.envelope);
    const x12Response = extractX12FromSoap(rawSoapResponse) ?? "";
    return {
      controlNumber: control,
      correlationId: payloadId,
      rawRequest: x12,
      rawResponse: x12Response,
      normalized: normalize277(x12Response),
    };
  }
}
