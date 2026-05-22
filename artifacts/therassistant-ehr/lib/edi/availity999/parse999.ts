// File: lib/edi/availity999/parse999.ts
//
// X12 005010X231A1 — 999 Implementation Acknowledgement parser.
//
// CAQH CORE Eligibility & Benefits Infrastructure Rule vEB.2.0 §2 and
// §4 require that real-time 270 submitters receive either a 271 or a
// 999 within 20 seconds, and batch 270 submitters receive a 999 within
// 24 hours. This parser extracts the structural acknowledgement so we
// can:
//   * mark the originating edi_transactions / edi_batches row with a
//     definitive ack_status,
//   * surface AK3/AK4 segment/element errors for troubleshooting, and
//   * derive a single top-level summary the UI can show.
//
// We intentionally parse defensively: the file may use any of the
// standard delimiters (~ * :) and may omit the ISA/GS envelope when
// the caller hands us only the ST..SE transaction set.

export type Ak9AcknowledgementCode =
  | "A" // Accepted
  | "E" // Accepted, but errors were noted
  | "M" // Rejected, message authentication code (MAC) failed
  | "P" // Partially accepted, at least one transaction set was rejected
  | "R" // Rejected
  | "W" // Rejected, assurance failed validity tests
  | "X"; // Rejected, content after decryption could not be analyzed

export type Ak2AcknowledgementCode =
  | "A" // Accepted
  | "E" // Accepted but errors were noted
  | "M" // Rejected, message authentication code (MAC) failed
  | "R" // Rejected
  | "W" // Rejected, assurance failed validity tests
  | "X"; // Rejected, content after decryption could not be analyzed

export type AcknowledgementSummary =
  | "accepted"
  | "accepted_with_errors"
  | "partially_accepted"
  | "rejected";

export interface Ak3SegmentError {
  /** AK3-01 segment ID (e.g. "NM1"). */
  segmentId: string;
  /** AK3-02 segment position in the transaction set. */
  position: number | null;
  /** AK3-03 loop identifier code, when present. */
  loopId?: string | null;
  /** AK3-04 segment syntax error code (e.g. "8" = segment has data element errors). */
  syntaxErrorCode?: string | null;
  /** AK4 element-level errors nested under this segment, if any. */
  elementErrors: Ak4ElementError[];
}

export interface Ak4ElementError {
  /** AK4-01-01 element position in segment. */
  position: number | null;
  /** AK4-01-02 component position, when the element is composite. */
  componentPosition?: number | null;
  /** AK4-02 data element reference number. */
  referenceNumber?: string | null;
  /** AK4-03 data element syntax error code (e.g. "1" mandatory missing). */
  syntaxErrorCode?: string | null;
  /** AK4-04 copy of the bad element, when echoed back by the receiver. */
  badValue?: string | null;
}

export interface Ak2TransactionSetResponse {
  /** AK2-01 transaction set identifier (e.g. "270"). */
  transactionSetId: string;
  /** AK2-02 transaction set control number (matches the inbound ST02). */
  controlNumber: string;
  /** AK2-03 implementation guide reference (e.g. "005010X279A1"). */
  implementationConventionReference?: string | null;
  /** IK5/AK5 transaction set acknowledgement code. */
  acknowledgementCode?: Ak2AcknowledgementCode | null;
  /** IK5/AK5-02..05 syntax error codes (up to 5). */
  syntaxErrorCodes: string[];
  /** AK3 segment errors discovered for this transaction set. */
  segmentErrors: Ak3SegmentError[];
}

export interface Ak1FunctionalGroupResponse {
  /** AK1-01 functional ID code (e.g. "HS" for eligibility). */
  functionalIdCode: string;
  /** AK1-02 group control number (matches inbound GS06). */
  groupControlNumber: string;
  /** AK1-03 implementation guide reference, when present. */
  implementationConventionReference?: string | null;
}

export interface Ak9FunctionalGroupSummary {
  /** AK9-01 group acknowledgement code. */
  acknowledgementCode: Ak9AcknowledgementCode;
  /** AK9-02 number of transaction sets included. */
  transactionSetsIncluded: number | null;
  /** AK9-03 number of received transaction sets. */
  transactionSetsReceived: number | null;
  /** AK9-04 number of accepted transaction sets. */
  transactionSetsAccepted: number | null;
  /** AK9-05..09 functional group syntax error codes (up to 5). */
  syntaxErrorCodes: string[];
}

export interface Parsed999Result {
  /** Sender — ISA06 / GS02, when the envelope was provided. */
  senderId: string | null;
  /** Receiver — ISA08 / GS03, when the envelope was provided. */
  receiverId: string | null;
  /** ISA13 interchange control number, when present. */
  interchangeControlNumber: string | null;
  /** Functional group AK1 context. */
  functionalGroup: Ak1FunctionalGroupResponse | null;
  /** One entry per AK2 transaction set in the 999. */
  transactionSets: Ak2TransactionSetResponse[];
  /** AK9 group-level summary. */
  groupSummary: Ak9FunctionalGroupSummary | null;
  /** Convenience rollup mapped to edi_transactions.ack_status. */
  summary: AcknowledgementSummary;
  /** True when at least one AK3 or AK4 was present. */
  hasErrors: boolean;
  /** Human-readable one-line description suitable for logs/UI tooltip. */
  message: string;
}

const SEGMENT_DELIMITERS = ["~", "\n", "\r"];

function detectElementDelimiter(raw: string): string {
  // The 4th character of an ISA segment is the element delimiter, but
  // many test fixtures hand us only the ST..SE region. Fall back to '*'.
  const isaIndex = raw.indexOf("ISA");
  if (isaIndex >= 0 && raw.length > isaIndex + 3) return raw[isaIndex + 3];
  return "*";
}

function splitSegments(raw: string): string[] {
  let working = raw;
  for (const delim of SEGMENT_DELIMITERS) {
    working = working.split(delim).join("\u0001");
  }
  return working
    .split("\u0001")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function num(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function summaryFromAk9(code: Ak9AcknowledgementCode | null | undefined): AcknowledgementSummary {
  switch (code) {
    case "A":
      return "accepted";
    case "E":
      return "accepted_with_errors";
    case "P":
      return "partially_accepted";
    case "M":
    case "R":
    case "W":
    case "X":
    default:
      return "rejected";
  }
}

const SYNTAX_ERROR_DESCRIPTIONS: Record<string, string> = {
  "1": "Unrecognized transaction set identifier",
  "2": "Transaction set trailing control number does not match",
  "3": "Number of included segments does not match actual count",
  "4": "One or more segments in error",
  "5": "Missing or invalid transaction set identifier",
  "6": "Missing or invalid transaction set control number",
  "7": "Authentication key for trading partner not on file",
  "8": "Decryption / authentication failed",
  "9": "Transaction set acknowledgement code not recognized",
};

function describeAcknowledgement(
  groupSummary: Ak9FunctionalGroupSummary | null,
  transactionSets: Ak2TransactionSetResponse[],
): string {
  if (!groupSummary) {
    return "999 received without a parseable AK9/IK9 group summary.";
  }
  const errorCount = transactionSets.reduce(
    (acc, ts) => acc + ts.segmentErrors.length + ts.syntaxErrorCodes.length,
    0,
  );
  const accepted = groupSummary.transactionSetsAccepted ?? 0;
  const received = groupSummary.transactionSetsReceived ?? transactionSets.length;
  switch (groupSummary.acknowledgementCode) {
    case "A":
      return `Functional group accepted (${accepted}/${received} transaction sets, no errors).`;
    case "E":
      return `Functional group accepted with errors (${errorCount} segment/element issue${
        errorCount === 1 ? "" : "s"
      }).`;
    case "P":
      return `Functional group partially accepted (${accepted}/${received} transaction sets, ${errorCount} issue${
        errorCount === 1 ? "" : "s"
      }).`;
    case "R":
      return `Functional group rejected (${errorCount} issue${errorCount === 1 ? "" : "s"}).`;
    case "M":
      return "Functional group rejected: message authentication failed.";
    case "W":
      return "Functional group rejected: assurance failed validity tests.";
    case "X":
      return "Functional group rejected: encrypted content could not be analyzed.";
    default:
      return "Functional group acknowledgement code not recognized.";
  }
}

/**
 * Parse a raw X12 999 (Implementation Acknowledgement) payload.
 *
 * Tolerates inputs that contain just the ST..SE transaction set, or the
 * full ISA..IEA envelope, or multiple acknowledgements concatenated
 * together. When multiple AK1 groups are present, the first group wins
 * (Availity returns one 999 per inbound functional group).
 */
export function parse999(raw: string): Parsed999Result {
  if (!raw || typeof raw !== "string") {
    return {
      senderId: null,
      receiverId: null,
      interchangeControlNumber: null,
      functionalGroup: null,
      transactionSets: [],
      groupSummary: null,
      summary: "rejected",
      hasErrors: false,
      message: "Empty 999 payload.",
    };
  }

  const elementDelim = detectElementDelimiter(raw);
  const segments = splitSegments(raw).map((seg) => seg.split(elementDelim));

  let senderId: string | null = null;
  let receiverId: string | null = null;
  let interchangeControlNumber: string | null = null;
  let functionalGroup: Ak1FunctionalGroupResponse | null = null;
  let groupSummary: Ak9FunctionalGroupSummary | null = null;
  const transactionSets: Ak2TransactionSetResponse[] = [];
  let currentTxnSet: Ak2TransactionSetResponse | null = null;
  let currentSegmentError: Ak3SegmentError | null = null;

  for (const els of segments) {
    const id = els[0];
    switch (id) {
      case "ISA":
        senderId = senderId ?? (els[6]?.trim() || null);
        receiverId = receiverId ?? (els[8]?.trim() || null);
        interchangeControlNumber = interchangeControlNumber ?? (els[13]?.trim() || null);
        break;
      case "GS":
        senderId = senderId ?? (els[2]?.trim() || null);
        receiverId = receiverId ?? (els[3]?.trim() || null);
        break;
      case "AK1":
        if (!functionalGroup) {
          functionalGroup = {
            functionalIdCode: els[1]?.trim() || "",
            groupControlNumber: els[2]?.trim() || "",
            implementationConventionReference: els[3]?.trim() || null,
          };
        }
        break;
      case "AK2":
      case "IK2": {
        if (currentTxnSet) transactionSets.push(currentTxnSet);
        currentSegmentError = null;
        currentTxnSet = {
          transactionSetId: els[1]?.trim() || "",
          controlNumber: els[2]?.trim() || "",
          implementationConventionReference: els[3]?.trim() || null,
          acknowledgementCode: null,
          syntaxErrorCodes: [],
          segmentErrors: [],
        };
        break;
      }
      case "AK3":
      case "IK3": {
        if (!currentTxnSet) break;
        currentSegmentError = {
          segmentId: els[1]?.trim() || "",
          position: num(els[2]),
          loopId: els[3]?.trim() || null,
          syntaxErrorCode: els[4]?.trim() || null,
          elementErrors: [],
        };
        currentTxnSet.segmentErrors.push(currentSegmentError);
        break;
      }
      case "AK4":
      case "IK4": {
        if (!currentSegmentError) break;
        // AK4-01 may be a composite: "elementPos:componentPos".
        const positionComposite = (els[1] ?? "").split(":");
        currentSegmentError.elementErrors.push({
          position: num(positionComposite[0]),
          componentPosition: num(positionComposite[1]),
          referenceNumber: els[2]?.trim() || null,
          syntaxErrorCode: els[3]?.trim() || null,
          badValue: els[4]?.trim() || null,
        });
        break;
      }
      case "AK5":
      case "IK5": {
        if (!currentTxnSet) break;
        const code = (els[1]?.trim() || null) as Ak2AcknowledgementCode | null;
        currentTxnSet.acknowledgementCode = code;
        currentTxnSet.syntaxErrorCodes = [els[2], els[3], els[4], els[5], els[6]]
          .map((e) => e?.trim())
          .filter((e): e is string => Boolean(e));
        break;
      }
      case "AK9":
      case "IK9": {
        const code = (els[1]?.trim() || "R") as Ak9AcknowledgementCode;
        groupSummary = {
          acknowledgementCode: code,
          transactionSetsIncluded: num(els[2]),
          transactionSetsReceived: num(els[3]),
          transactionSetsAccepted: num(els[4]),
          syntaxErrorCodes: [els[5], els[6], els[7], els[8], els[9]]
            .map((e) => e?.trim())
            .filter((e): e is string => Boolean(e)),
        };
        break;
      }
      default:
        break;
    }
  }
  if (currentTxnSet) transactionSets.push(currentTxnSet);

  const hasErrors = transactionSets.some(
    (ts) => ts.segmentErrors.length > 0 || ts.syntaxErrorCodes.length > 0,
  );
  const summary = summaryFromAk9(groupSummary?.acknowledgementCode);
  const message = describeAcknowledgement(groupSummary, transactionSets);

  return {
    senderId,
    receiverId,
    interchangeControlNumber,
    functionalGroup,
    transactionSets,
    groupSummary,
    summary,
    hasErrors,
    message,
  };
}

/**
 * Return a human-readable description for an X12 syntax error code as
 * used in AK3-04 / AK4-03 / AK5-02..06 / AK9-05..09. Returns the raw
 * code when it isn't one of the standard values.
 */
export function describeSyntaxErrorCode(code: string | null | undefined): string {
  if (!code) return "";
  return SYNTAX_ERROR_DESCRIPTIONS[code] ?? `Syntax error code ${code}`;
}
