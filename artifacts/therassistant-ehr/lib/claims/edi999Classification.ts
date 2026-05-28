/**
 * 999 Implementation Acknowledgement error classifier.
 *
 * Parses IK3 loop identifiers and IK4 element references out of the
 * `errorSegments` we persist on the acknowledgement (and on the
 * downstream workqueue item's `context_payload.parsed_content`) and
 * produces a typed `errorCategory`, plus human-readable reason text
 * pulled from a lookup table instead of the raw `IK3*NM1*8*1000A*8`
 * segment string.
 *
 * Tab buckets surfaced in the 999 Rejections workqueue:
 *   - file_rejected      → envelope-level reject with no IK3/IK4 detail
 *   - claim_syntax       → IK3/IK4 inside a claim loop (2000/2010/2300/2400…)
 *   - invalid_submitter  → IK3/IK4 inside Loop 1000A (submitter) or NM1*41
 *   - edi_format         → AK3/AK4 (functional-group structural) OR
 *                          IK3/IK4 inside the envelope/receiver loops
 *                          (1000B, 2000 header-only without a claim id)
 */

export type Edi999ErrorCategory =
  | "file_rejected"
  | "claim_syntax"
  | "invalid_submitter"
  | "edi_format";

export interface Edi999ErrorDetail {
  /** Raw segment as received (e.g. "IK3*NM1*8*1000A*8"). */
  raw: string;
  /** Segment tag — IK3/IK4/AK3/AK4. */
  kind: "IK3" | "IK4" | "AK3" | "AK4";
  /** For *3 segments: the X12 segment id flagged (e.g. "NM1"). */
  segmentId?: string;
  /** For *3 segments: segment position inside the transaction set. */
  segmentPosition?: string;
  /** For *3 segments: loop identifier code (e.g. "1000A"). */
  loopId?: string;
  /** For *4 segments: element position (or composite "n:m"). */
  elementPosition?: string;
  /** For *4 segments: data element reference number (e.g. "66"). */
  elementReference?: string;
  /** Syntax error reason code (IK304/AK304 for *3, IK403/AK403 for *4). */
  syntaxErrorCode?: string;
  /** For *4 segments: the bad element value echoed back, when present. */
  badValue?: string;
  /** Tab bucket this individual segment contributes to. */
  category: Edi999ErrorCategory;
  /** Human-readable message — looked up from the code tables. */
  humanMessage: string;
  /** Short location label, e.g. "Loop 1000A · NM1 (pos 8)". */
  location: string;
}

export interface Edi999Classification {
  /** Tab bucket the row should sit in. */
  errorCategory: Edi999ErrorCategory;
  /** Primary reason code (first IK3/IK4/AK3/AK4 code we find), or "999". */
  primaryReasonCode: string;
  /** Human-readable message for the primary error. */
  primaryMessage: string;
  /** Human-readable location string for the primary error. */
  primaryLocation: string;
  /** Per-segment breakdown so the detail panel can render rich rows. */
  errorDetails: Edi999ErrorDetail[];
}

// ─── Lookup tables ──────────────────────────────────────────────────────────

/**
 * X12 005010 IK304 / AK304 — segment syntax error codes. Source:
 * ASC X12 999 Implementation Acknowledgement, table 720.
 */
export const SEGMENT_SYNTAX_ERROR_CODES: Record<string, string> = {
  "1": "Unrecognized segment ID",
  "2": "Unexpected segment",
  "3": "Required segment missing",
  "4": "Loop occurs over maximum times",
  "5": "Segment exceeds maximum use",
  "6": "Segment not in defined transaction set",
  "7": "Segment not in proper sequence",
  "8": "Segment has data element errors",
  I6: "Implementation dependent segment missing",
  I7: "Implementation loop occurs under minimum times",
  I8: "Implementation segment below minimum use",
  I9: "Implementation dependent 'Not Used' segment present",
};

/**
 * X12 005010 IK403 / AK403 — data element syntax error codes. Source:
 * ASC X12 999 Implementation Acknowledgement, table 723.
 */
export const ELEMENT_SYNTAX_ERROR_CODES: Record<string, string> = {
  "1": "Mandatory data element missing",
  "2": "Conditional required data element missing",
  "3": "Too many data elements",
  "4": "Data element too short",
  "5": "Data element too long",
  "6": "Invalid character in data element",
  "7": "Invalid code value",
  "8": "Invalid date",
  "9": "Invalid time",
  "10": "Exclusion condition violated",
  "12": "Too many repetitions",
  "13": "Too many components",
  I6: "Code value not used in implementation",
  I9: "Implementation 'Not Used' data element present",
  I10: "Implementation too few repetitions",
  I11: "Implementation pattern match failure",
  I12: "Implementation dependent data element missing",
  I13: "Implementation dependent 'Not Used' data element present",
};

/**
 * X12 005010 AK905 / IK501 functional-group acknowledgement reason
 * codes. Used when a 999 rejects at the AK9 level with no IK3/IK4
 * detail (the file was bounced before the receiver could inspect any
 * claim). Source: ASC X12 999, table 716.
 */
export const FUNCTIONAL_GROUP_SYNTAX_ERROR_CODES: Record<string, string> = {
  "1": "Functional group not supported",
  "2": "Functional group version not supported",
  "3": "Functional group trailer missing",
  "4": "Group control number in header and trailer do not agree",
  "5": "Number of included transaction sets does not match actual count",
  "6": "Group control number violates syntax",
  "10": "Authentication key for trading partner not on file",
  "11": "Decryption failed",
  "12": "Functional group identifier value not recognized",
  "13": "Implementation not supported",
  "14": "Functional group rejected — security threat suspected",
  "15": "Functional group rejected — assurance failed",
  "16": "Functional group rejected — content decryption failed",
  "17": "Functional group rejected — version/release identifier not supported",
  "18": "Functional group rejected — encoding not supported",
  "19": "Functional group rejected — security originator not authorized",
  "20": "Functional group rejected — security recipient not authorized",
  "21": "Functional group rejected — algorithm not supported",
  "22": "Functional group rejected — control structure error",
  "23": "Functional group rejected — required envelope not supported",
};

const SUBMITTER_LOOPS = new Set(["1000A"]);
const RECEIVER_LOOPS = new Set(["1000B"]);
// Claim-level loops in an 837P. Anything inside 2000B/2000C/2010BA/2010CA/
// 2300/2310x/2320/2330x/2400/241x/243x is per-claim content.
const CLAIM_LOOP_PREFIXES = ["2000", "2010", "2300", "2310", "2320", "2330", "2400", "241", "243"];

function isClaimLoop(loopId: string | undefined): boolean {
  if (!loopId) return false;
  if (loopId === "2000A" || loopId === "2010AA" || loopId === "2010AB") {
    // Billing/Pay-To provider loops live above the client loop but are
    // still claim-content for the operator who has to fix the claim.
    return true;
  }
  return CLAIM_LOOP_PREFIXES.some((p) => loopId.startsWith(p));
}

function describeSegmentCode(code: string | undefined): string {
  if (!code) return "";
  return SEGMENT_SYNTAX_ERROR_CODES[code] ?? `Segment syntax error code ${code}`;
}

function describeElementCode(code: string | undefined): string {
  if (!code) return "";
  return ELEMENT_SYNTAX_ERROR_CODES[code] ?? `Element syntax error code ${code}`;
}

function describeFunctionalCode(code: string | undefined): string {
  if (!code) return "";
  return FUNCTIONAL_GROUP_SYNTAX_ERROR_CODES[code] ?? `Functional-group syntax error code ${code}`;
}

function categoryForSegment(detail: Omit<Edi999ErrorDetail, "category" | "humanMessage" | "location">): Edi999ErrorCategory {
  if (detail.kind === "AK3" || detail.kind === "AK4") {
    // 4010-style functional-group structural errors — envelope problem.
    return "edi_format";
  }
  const loop = detail.loopId ?? "";
  if (SUBMITTER_LOOPS.has(loop)) return "invalid_submitter";
  if (RECEIVER_LOOPS.has(loop)) return "edi_format";
  if (isClaimLoop(loop)) return "claim_syntax";
  if (!loop) {
    // Some clearinghouses (notably Availity) omit the loop id on the
    // IK3 they emit for submitter-name problems — the only NM1 that
    // can legitimately appear without a loop in an 837P is the
    // Loop 1000A Submitter Name segment, so a loopless IK3*NM1 is a
    // submitter problem, not a header/format one.
    if (detail.segmentId === "NM1") return "invalid_submitter";
    // Other loopless IK3 segments mean an ST/SE/BHT/header-level
    // problem, which is an envelope/format issue rather than a single
    // claim's syntax.
    return "edi_format";
  }
  return "claim_syntax";
}

function locationFor(detail: Omit<Edi999ErrorDetail, "category" | "humanMessage" | "location">): string {
  if (detail.kind === "IK4" || detail.kind === "AK4") {
    const parts = [
      detail.elementReference ? `Element ref ${detail.elementReference}` : null,
      detail.elementPosition ? `pos ${detail.elementPosition}` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : detail.kind;
  }
  const parts = [
    detail.loopId ? `Loop ${detail.loopId}` : null,
    detail.segmentId ? detail.segmentId : null,
    detail.segmentPosition ? `pos ${detail.segmentPosition}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "File envelope";
}

function humanMessageFor(detail: Omit<Edi999ErrorDetail, "category" | "humanMessage" | "location">): string {
  if (detail.kind === "IK4" || detail.kind === "AK4") {
    const desc = describeElementCode(detail.syntaxErrorCode);
    const ref = detail.elementReference ? ` (element ref ${detail.elementReference})` : "";
    const bad = detail.badValue ? ` — received "${detail.badValue}"` : "";
    return desc ? `${desc}${ref}${bad}` : `Element-level error${ref}${bad}`;
  }
  const desc = describeSegmentCode(detail.syntaxErrorCode);
  const seg = detail.segmentId ? `${detail.segmentId} segment` : "Segment";
  const loop = detail.loopId ? ` in loop ${detail.loopId}` : "";
  return desc ? `${seg}${loop}: ${desc.toLowerCase()}` : `${seg}${loop} flagged by clearinghouse`;
}

function parseSegment(raw: string): Edi999ErrorDetail | null {
  const parts = raw.split("*").map((p) => p.trim());
  const head = (parts[0] ?? "").toUpperCase();
  if (head !== "IK3" && head !== "IK4" && head !== "AK3" && head !== "AK4") return null;

  if (head === "IK3" || head === "AK3") {
    // IK3*<segId>*<segPos>*<loopId>*<syntaxErrorCode>
    const base: Omit<Edi999ErrorDetail, "category" | "humanMessage" | "location"> = {
      raw,
      kind: head,
      segmentId: parts[1] || undefined,
      segmentPosition: parts[2] || undefined,
      loopId: parts[3] || undefined,
      syntaxErrorCode: parts[4] || undefined,
    };
    return {
      ...base,
      category: categoryForSegment(base),
      humanMessage: humanMessageFor(base),
      location: locationFor(base),
    };
  }

  // IK4*<elementPos[:componentPos]>*<elementRef>*<syntaxErrorCode>*<badValue>
  const base: Omit<Edi999ErrorDetail, "category" | "humanMessage" | "location"> = {
    raw,
    kind: head,
    elementPosition: parts[1] || undefined,
    elementReference: parts[2] || undefined,
    syntaxErrorCode: parts[3] || undefined,
    badValue: parts[4] || undefined,
  };
  return {
    ...base,
    category: categoryForSegment(base),
    humanMessage: humanMessageFor(base),
    location: locationFor(base),
  };
}

/**
 * Pick the strongest category from a set of details — submitter beats
 * claim_syntax beats edi_format beats file_rejected. The submitter case
 * is the loudest because a bad submitter ID prevents *every* claim in
 * the batch from going out, so it must be the surfaced bucket even when
 * the same 999 also flagged claim-level errors.
 */
function rollupCategory(details: Edi999ErrorDetail[]): Edi999ErrorCategory {
  if (details.some((d) => d.category === "invalid_submitter")) return "invalid_submitter";
  if (details.some((d) => d.category === "claim_syntax")) return "claim_syntax";
  if (details.some((d) => d.category === "edi_format")) return "edi_format";
  return "file_rejected";
}

/**
 * Classify a `parsed_content` blob (the one we persist on
 * `edi_acknowledgements.parsed_content` / `workqueue_items.context_payload.parsed_content`).
 *
 * Safe to call on legacy rows that only have the raw `errorSegments` —
 * the route uses this to re-categorise existing rows on read until the
 * backfill is run.
 */
export function classify999Errors(parsedContent: unknown): Edi999Classification {
  const parsed = (parsedContent ?? {}) as Record<string, unknown>;
  const rawSegments: string[] = Array.isArray(parsed.errorSegments)
    ? (parsed.errorSegments as unknown[]).map((s) => String(s ?? "")).filter(Boolean)
    : [];

  const details = rawSegments
    .map(parseSegment)
    .filter((d): d is Edi999ErrorDetail => d !== null);

  let errorCategory: Edi999ErrorCategory;
  let primaryReasonCode = "";
  let primaryMessage = "";
  let primaryLocation = "";

  if (details.length === 0) {
    // AK9-only rejection — envelope bounced before any IK3/IK4 emitted.
    errorCategory = "file_rejected";
    const ak9 = String(parsed.ak9Code ?? "").toUpperCase();
    primaryReasonCode = ak9 || "999";
    primaryMessage =
      ak9 === "R"
        ? "Functional group rejected by the clearinghouse before any claim was inspected."
        : ak9 === "M"
          ? "Functional group rejected: message authentication failed."
          : ak9 === "W"
            ? "Functional group rejected: assurance failed validity tests."
            : ak9 === "X"
              ? "Functional group rejected: encrypted content could not be analyzed."
              : "Rejected by the clearinghouse 999 acknowledgement.";
    // If we have a functional-group syntax code on the parsed payload
    // (some upstream parsers stash one in `groupSyntaxErrorCode`), use it.
    const groupCode = String(
      (parsed as { groupSyntaxErrorCode?: unknown }).groupSyntaxErrorCode ?? "",
    ).trim();
    if (groupCode) {
      primaryMessage = describeFunctionalCode(groupCode);
      primaryReasonCode = groupCode;
    }
    primaryLocation = "File envelope";
  } else {
    errorCategory = rollupCategory(details);
    // Prefer the first detail matching the rolled-up category so the
    // surfaced code/message lines up with the bucket the row sits in.
    const primary = details.find((d) => d.category === errorCategory) ?? details[0];
    primaryReasonCode = primary.syntaxErrorCode || primary.kind;
    primaryMessage = primary.humanMessage;
    primaryLocation = primary.location;
  }

  return {
    errorCategory,
    primaryReasonCode,
    primaryMessage,
    primaryLocation,
    errorDetails: details,
  };
}
