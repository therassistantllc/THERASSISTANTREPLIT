import { annotateBenefits } from "./categorizeBenefits";
import type {
  Parsed271Dependent,
  Parsed271OtherPayer,
  Parsed271Response,
  Parsed271Subscriber,
  ParsedAAAError,
  ParsedEB271,
} from "./types";

// ---------------------------------------------------------------------------
// Availity X12 005010X279A1 (271) parser.
//
// Pragmatic walk-the-segments parser: splits on the actual ISA-declared
// element & segment separators when present, otherwise falls back to "~" and
// "*". Extracts: envelope identifiers, AAA errors (with human-readable code
// meanings), payer/subscriber identity, plan effective/termination dates,
// EB benefit segments, MSG free-text messages. Derives a coarse status code
// from AAA + EB01.
//
// Detailed per-EB downstream extraction (copay vs. deductible vs. OOP, with
// time-period qualifiers, in/out-of-network, telemedicine, auth/cert) is
// captured here as raw EB fields and lifted into typed financial-
// responsibility fields in Phase 5 (CAQH CORE Data Content Rule §1.3.2.5+).
// ---------------------------------------------------------------------------

// EB01 — Eligibility or Benefit Information code meanings (X12 271 §2110C/D).
// Trimmed to the codes therassistant cares about; unknowns fall back to the
// raw code value in eligibilityCodeMeaning.
const EB01_MEANINGS: Record<string, string> = {
  "1": "Active Coverage",
  "2": "Active - Full Risk Capitation",
  "3": "Active - Services Capitated",
  "4": "Active - Services Capitated to Primary Care Physician",
  "5": "Active - Pending Investigation",
  "6": "Inactive",
  "7": "Inactive - Pending Eligibility Update",
  "8": "Inactive - Pending Investigation",
  A: "Co-Insurance",
  B: "Co-Payment",
  C: "Deductible",
  CB: "Coverage Basis",
  D: "Benefit Description",
  E: "Exclusions",
  F: "Limitations",
  G: "Out of Pocket (Stop Loss)",
  H: "Unlimited",
  I: "Non-Covered",
  J: "Cost Containment",
  K: "Reserve",
  L: "Primary Care Provider",
  M: "Pre-existing Condition",
  MC: "Managed Care Coordinator",
  N: "Services Restricted to Following Provider",
  O: "Not Deemed a Medical Necessity",
  P: "Benefit Disclaimer",
  Q: "Second Surgical Opinion Required",
  R: "Other or Additional Payor",
  S: "Prior Year(s) History",
  T: "Card(s) Reported Lost/Stolen",
  U: "Contact Following Entity for Eligibility or Benefit Information",
  V: "Cannot Process",
  W: "Other Source of Data",
  X: "Health Care Facility",
  Y: "Spend Down",
};

const EB02_MEANINGS: Record<string, string> = {
  CHD: "Children Only",
  DEP: "Dependents Only",
  ECH: "Employee and Children",
  EMP: "Employee Only",
  ESP: "Employee and Spouse",
  FAM: "Family",
  IND: "Individual",
  SPC: "Spouse and Children",
  SPO: "Spouse Only",
};

// AAA03 — Reject Reason Code (subscriber-level subset most commonly seen).
const AAA03_MEANINGS: Record<string, string> = {
  "15": "Required application data missing",
  "33": "Input errors",
  "41": "Authorization/Access restrictions",
  "42": "Unable to respond at current time",
  "43": "Invalid/Missing Provider Identification",
  "45": "Invalid/Missing Provider Specialty",
  "50": "Provider Ineligible for inquiries",
  "51": "Provider not on file",
  "52": "Service dates not within provider plan enrollment",
  "56": "Inappropriate date",
  "57": "Invalid/Missing Date(s) of service",
  "58": "Invalid/Missing Date-of-Birth",
  "60": "Date of Birth follows Date(s) of service",
  "61": "Date of Death precedes Date(s) of service",
  "62": "Date of service not within allowable inquiry period",
  "63": "Date of service in future",
  "67": "Client birth date does not match that for the client on the database",
  "68": "Inconsistent with client's age",
  "69": "Inconsistent with client's gender",
  "71": "Client birth date does not match",
  "72": "Invalid/Missing Subscriber/Insured ID",
  "73": "Invalid/Missing Subscriber/Insured Name",
  "74": "Invalid/Missing Subscriber/Insured Gender Code",
  "75": "Subscriber/Insured not found",
  "76": "Duplicate Subscriber/Insured ID Number",
  "77": "Subscriber found, client not found",
  "78": "Subscriber/Insured not in group/plan identified",
  "79": "Client not eligible",
  "80": "No response received - transaction terminated",
};

// AAA04 — Follow-up Action Code.
const AAA04_MEANINGS: Record<string, string> = {
  C: "Please correct and resubmit",
  N: "Resubmission not allowed",
  P: "Please resubmit original transaction",
  R: "Resubmission allowed",
  S: "Do not resubmit; we will hold your request and respond again shortly",
  W: "Please wait 30 days and resubmit",
  X: "Please wait 10 days and resubmit",
  Y: "Do not resubmit; inquiry initiated to a third party",
};

function detectSeparators(raw: string): {
  element: string;
  segment: string;
} {
  // The ISA segment is 106 chars in standard layout; element separator is
  // char 4 (offset 3), segment terminator is char 106 (offset 105). If we
  // see "ISA" at start, trust those positions. Otherwise default to *, ~.
  if (raw.startsWith("ISA") && raw.length > 106) {
    return { element: raw[3], segment: raw[105] };
  }
  return { element: "*", segment: "~" };
}

function splitSegments(raw: string): string[][] {
  const cleaned = raw.replace(/\r/g, "").trim();
  if (!cleaned) return [];
  const { element, segment } = detectSeparators(cleaned);
  return cleaned
    .split(segment)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.split(element));
}

function toNumberOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatDateFromX12(dateRaw: string): string | null {
  // CCYYMMDD or CCYYMMDD-CCYYMMDD; we just normalize CCYYMMDD → YYYY-MM-DD.
  if (!dateRaw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(dateRaw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return dateRaw;
}

export function parseAvaility271(raw: string): Parsed271Response {
  const result: Parsed271Response = {
    status: "unknown",
    payerName: null,
    payerId: null,
    planName: null,
    subscriberLastName: null,
    subscriberFirstName: null,
    memberId: null,
    dob: null,
    gender: null,
    effectiveDate: null,
    terminationDate: null,
    aaaErrors: [],
    benefits: [],
    messages: [],
    otherPayers: [],
    isaControlNumber: null,
    gsControlNumber: null,
    stControlNumber: null,
    rawSegments: [],
  };

  const segments = splitSegments(raw);
  result.rawSegments = segments;
  if (segments.length === 0) {
    result.status = "error";
    return result;
  }

  let currentEB: ParsedEB271 | null = null;
  // Loop context tracking — used so we know when EB-adjacent DTP/MSG/REF
  // segments belong to the in-flight benefit vs. a higher loop. We also
  // track which HL we are inside for Single Client Attribution routing.
  let lastLoopKind: "source" | "receiver" | "subscriber" | "dependent" | "benefit" | "envelope" =
    "envelope";
  // Tracks the most recent non-benefit loop so EB segments following an
  // HL*23 (dependent) attribute to the dependent rather than the
  // subscriber (Single Client Attribution Rule vEB.1.0 §4.2).
  let benefitOwnerLoop: "subscriber" | "dependent" = "subscriber";
  let subscriber: Parsed271Subscriber = {
    lastName: null,
    firstName: null,
    memberId: null,
    dob: null,
    gender: null,
  };
  let dependent: Parsed271Dependent | null = null;

  // Task #457 — track an in-flight "other payer" entry whenever we see an
  // EB*R (Other or Additional Payor) segment. Following NM1*PR + DTP
  // (356 / 357) segments populate the other-payer name, id, and
  // eligibility dates per X12 271 Loop 2120C/2120D.
  let currentOtherPayer: Parsed271OtherPayer | null = null;
  const flushOtherPayer = () => {
    if (currentOtherPayer && (currentOtherPayer.name || currentOtherPayer.payerId)) {
      result.otherPayers = result.otherPayers ?? [];
      result.otherPayers.push(currentOtherPayer);
    }
    currentOtherPayer = null;
  };

  const flushBenefit = () => {
    if (currentEB) {
      result.benefits.push(currentEB);
      currentEB = null;
    }
  };

  for (const seg of segments) {
    const tag = seg[0];
    switch (tag) {
      case "ISA":
        result.isaControlNumber = seg[13] ?? null;
        break;
      case "GS":
        result.gsControlNumber = seg[6] ?? null;
        break;
      case "ST":
        result.stControlNumber = seg[2] ?? null;
        break;
      case "HL": {
        flushBenefit();
        flushOtherPayer();
        const levelCode = seg[3];
        if (levelCode === "20") {
          lastLoopKind = "source";
        } else if (levelCode === "21") {
          lastLoopKind = "receiver";
        } else if (levelCode === "22") {
          lastLoopKind = "subscriber";
          benefitOwnerLoop = "subscriber";
        } else if (levelCode === "23") {
          lastLoopKind = "dependent";
          benefitOwnerLoop = "dependent";
          if (!dependent) {
            dependent = { lastName: null, firstName: null, dob: null, gender: null };
          }
        }
        break;
      }
      case "NM1": {
        flushBenefit();
        const entityIdCode = seg[1];
        if (entityIdCode === "PR") {
          // If we're inside an EB*R subloop, this NM1*PR identifies the
          // *other* payer (Loop 2120C/D), not the responding payer.
          if (currentOtherPayer) {
            currentOtherPayer.name = seg[3] ?? null;
            currentOtherPayer.payerId = seg[9] ?? null;
          } else {
            result.payerName = seg[3] ?? null;
            result.payerId = seg[9] ?? null;
          }
        } else if (entityIdCode === "IL") {
          // Subscriber (Loop 2100C). Always populates subscriber identity.
          subscriber.lastName = seg[3] ?? null;
          subscriber.firstName = seg[4] ?? null;
          if (seg[8] === "MI") {
            subscriber.memberId = seg[9] ?? null;
          }
          // Back-compat: keep flat top-level fields populated.
          result.subscriberLastName = subscriber.lastName;
          result.subscriberFirstName = subscriber.firstName;
          if (subscriber.memberId) result.memberId = subscriber.memberId;
        } else if (entityIdCode === "03" && lastLoopKind === "dependent") {
          // Dependent (Loop 2100D / NM1*03) — Single Client Attribution
          // Rule vEB.1.0: benefit content under this HL belongs to the
          // dependent, NOT the subscriber.
          if (!dependent) {
            dependent = { lastName: null, firstName: null, dob: null, gender: null };
          }
          dependent.lastName = seg[3] ?? null;
          dependent.firstName = seg[4] ?? null;
        }
        break;
      }
      case "DMG":
        if (lastLoopKind === "subscriber") {
          subscriber.dob = formatDateFromX12(seg[2] ?? "");
          subscriber.gender = seg[3] ?? null;
          result.dob = subscriber.dob;
          result.gender = subscriber.gender;
        } else if (lastLoopKind === "dependent") {
          if (!dependent) {
            dependent = { lastName: null, firstName: null, dob: null, gender: null };
          }
          dependent.dob = formatDateFromX12(seg[2] ?? "");
          dependent.gender = seg[3] ?? null;
        }
        break;
      case "DTP": {
        const qual = seg[1];
        const dateRaw = seg[3] ?? "";
        if (currentEB && lastLoopKind === "benefit") {
          // DTP attached to the in-flight EB benefit — surface in followingSegments
          currentEB.followingSegments = currentEB.followingSegments ?? [];
          currentEB.followingSegments.push(seg);
        }
        // Other-payer eligibility dates (Loop 2120C/D DTP 356/357).
        if (currentOtherPayer) {
          const formatted = formatDateFromX12(dateRaw);
          if (qual === "356" || qual === "346" || qual === "291") {
            currentOtherPayer.effectiveDate = formatted;
          } else if (qual === "357" || qual === "347") {
            currentOtherPayer.terminationDate = formatted;
          }
        }
        // Plan-level dates surface to the response root
        if (qual === "346" || qual === "356" || qual === "291" || qual === "348") {
          // 346=plan begin, 356=eligibility begin, 291=eligibility, 348=plan begin
          if (!result.effectiveDate) result.effectiveDate = formatDateFromX12(dateRaw);
        } else if (qual === "347" || qual === "357" || qual === "349") {
          // 347=plan end, 357=eligibility end, 349=plan end
          if (!result.terminationDate) result.terminationDate = formatDateFromX12(dateRaw);
        }
        break;
      }
      case "EB": {
        flushBenefit();
        // A new EB closes any in-flight other-payer entry (one entry per
        // EB*R subloop; subsequent EB segments belong to other benefits).
        flushOtherPayer();
        const ebCode = (seg[1] ?? "").toUpperCase();
        // EB*R (Other or Additional Payor) opens a new other-payer loop.
        if (ebCode === "R") {
          currentOtherPayer = {
            name: null,
            payerId: null,
            effectiveDate: null,
            terminationDate: null,
          };
        }
        currentEB = {
          owner: benefitOwnerLoop,
          eligibilityCode: ebCode,
          eligibilityCodeMeaning: EB01_MEANINGS[ebCode] ?? (ebCode || "Unknown"),
          coverageLevelCode: seg[2] || null,
          coverageLevelMeaning: seg[2] ? (EB02_MEANINGS[seg[2]] ?? null) : null,
          serviceTypeCode: seg[3] || null,
          insuranceTypeCode: seg[4] || null,
          planDescription: seg[5] || null,
          timePeriodQualifier: seg[6] || null,
          monetaryAmount: toNumberOrNull(seg[7]),
          percent: toNumberOrNull(seg[8]),
          quantityQualifier: seg[9] || null,
          quantity: toNumberOrNull(seg[10]),
          authorizationRequiredCode: ((): "Y" | "N" | "U" | null => {
            // EB11 — Authorization or Certification Indicator.
            const v = seg[11];
            if (v === "Y" || v === "N" || v === "U") return v;
            return null;
          })(),
          inPlanNetwork: ((): "Y" | "N" | "W" | "U" | null => {
            // EB12 — In Plan Network Indicator.
            const v = seg[12];
            if (v === "Y" || v === "N" || v === "W" || v === "U") return v;
            return null;
          })(),
          followingSegments: [],
        };
        if (currentEB.planDescription && !result.planName) {
          result.planName = currentEB.planDescription;
        }
        lastLoopKind = "benefit";
        break;
      }
      case "MSG": {
        const msg = seg[1] ?? "";
        if (msg) result.messages.push(msg);
        if (currentEB) {
          currentEB.followingSegments = currentEB.followingSegments ?? [];
          currentEB.followingSegments.push(seg);
        }
        break;
      }
      case "REF":
      case "III":
      case "HSD":
      case "LS":
      case "LE":
        // III (Healthcare Information Codes), HSD (Health Services
        // Delivery), and REF (Reference Information) all qualify an
        // in-flight EB and feed downstream categorization (telemedicine
        // detection, prior-auth signal, tiered benefit context).
        if (currentEB) {
          currentEB.followingSegments = currentEB.followingSegments ?? [];
          currentEB.followingSegments.push(seg);
        }
        break;
      case "AAA": {
        flushBenefit();
        const rejectCode = seg[3] ?? "";
        const followUp = seg[4] ?? "";
        const err: ParsedAAAError = {
          code: rejectCode,
          description: AAA03_MEANINGS[rejectCode] ?? `Reject reason code ${rejectCode}`,
          followUpAction: followUp ? AAA04_MEANINGS[followUp] ?? followUp : null,
          loop:
            lastLoopKind === "source"
              ? "2000A"
              : lastLoopKind === "receiver"
                ? "2000B"
                : lastLoopKind === "subscriber"
                  ? "2000C"
                  : lastLoopKind === "dependent"
                    ? "2000D"
                    : null,
          rejectReason: AAA03_MEANINGS[rejectCode] ?? null,
        };
        result.aaaErrors.push(err);
        break;
      }
      default:
        break;
    }
  }
  flushBenefit();
  flushOtherPayer();

  // Phase 5: categorize each EB segment and produce a headline
  // financial-responsibility rollup per CORE Data Content Rule
  // §1.3.2.5–§1.3.2.13. Mutates each benefit in place.
  result.financials = annotateBenefits(result.benefits);

  // Phase 6 — Single Client Attribution Rule vEB.1.0 §4.2–§4.3.
  // Compute target from where benefit content actually appears, not just
  // from dependent-loop presence: many payers echo an empty HL*23 even
  // when all returned benefits live under the subscriber loop.
  result.subscriber = subscriber;
  result.dependent = dependent;
  const dependentBenefitCount = result.benefits.filter((b) => b.owner === "dependent").length;
  const subscriberBenefitCount = result.benefits.filter((b) => b.owner !== "dependent").length;
  let attributionTarget: "subscriber" | "dependent";
  if (dependentBenefitCount > 0 && dependentBenefitCount >= subscriberBenefitCount) {
    attributionTarget = "dependent";
  } else if (subscriberBenefitCount > 0) {
    attributionTarget = "subscriber";
  } else {
    // No EB segments returned at all (AAA-only response): fall back to
    // whichever party was identified furthest down the HL chain.
    attributionTarget = dependent ? "dependent" : "subscriber";
  }
  result.attribution = {
    target: attributionTarget,
    subscriber,
    dependent,
  };

  // Derive coarse status
  if (result.aaaErrors.length > 0) {
    const hasNotFound = result.aaaErrors.some((e) => e.code === "75" || e.code === "77" || e.code === "78");
    result.status = hasNotFound ? "not_found" : "error";
  } else if (result.benefits.some((b) => ["1", "2", "3", "4", "5"].includes(b.eligibilityCode))) {
    result.status = "active";
  } else if (result.benefits.some((b) => ["6", "7", "8"].includes(b.eligibilityCode))) {
    result.status = "inactive";
  } else {
    result.status = "unknown";
  }

  return result;
}
