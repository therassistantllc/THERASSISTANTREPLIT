/**
 * Lightweight catalog of common RARC (Remittance Advice Remark Codes).
 * Each entry gives a human-readable message, the typical related CARC, the
 * recommended biller action, and a default priority. Used by the
 * "Denied Claims by RARC" workqueue to drive the explanation-first layout.
 *
 * When a code is missing, callers should fall back to {code, message: code,
 * relatedCarc: null, recommendedAction: "Review payer remittance",
 * priority: "normal"}.
 */

export type RarcPriority = "low" | "normal" | "high" | "urgent";

export interface RarcCatalogEntry {
  code: string;
  message: string;
  relatedCarc: string | null;
  recommendedAction: string;
  payerExplanation: string;
  suggestedCorrection: string;
  priority: RarcPriority;
}

export const RARC_CATALOG: Record<string, RarcCatalogEntry> = {
  M15: {
    code: "M15",
    message: "Separately billed services/tests have been bundled.",
    relatedCarc: "97",
    recommendedAction: "Verify bundling rules; appeal if services were distinct.",
    payerExplanation:
      "The payer considers the billed service to be included in another procedure paid on the same date.",
    suggestedCorrection:
      "Confirm with documentation whether the service is truly separate (modifier 59/XS/XU). If so, file an appeal with supporting notes.",
    priority: "normal",
  },
  M25: {
    code: "M25",
    message: "Information furnished does not substantiate the need for this service.",
    relatedCarc: "50",
    recommendedAction: "Gather supporting documentation and file an appeal.",
    payerExplanation:
      "The submitted information does not support medical necessity at the level billed.",
    suggestedCorrection:
      "Attach the clinical note, treatment plan, and any prior authorizations, then submit a corrected appeal.",
    priority: "high",
  },
  M86: {
    code: "M86",
    message: "Service denied because payment already made for same/similar service within set time frame.",
    relatedCarc: "18",
    recommendedAction: "Check for duplicate; void or correct frequency.",
    payerExplanation:
      "The payer believes this service overlaps a previously paid claim for the same client and date range.",
    suggestedCorrection:
      "Pull the prior remit; if truly distinct, resubmit with modifier 76/77 or adjusted DOS. Otherwise mark duplicate.",
    priority: "normal",
  },
  N4: {
    code: "N4",
    message: "Missing/incomplete/invalid prior insurance carrier EOB.",
    relatedCarc: "22",
    recommendedAction: "Attach primary EOB and rebill as secondary.",
    payerExplanation:
      "The payer is secondary and needs the primary insurer's EOB before it will adjudicate.",
    suggestedCorrection:
      "Obtain the primary EOB, populate the COB loop (2320/2330) and resubmit electronically or by paper with attachment.",
    priority: "high",
  },
  N30: {
    code: "N30",
    message: "Client ineligible for this service.",
    relatedCarc: "27",
    recommendedAction: "Re-run eligibility; bill correct payer or client.",
    payerExplanation:
      "Coverage was not active for the client on the date of service.",
    suggestedCorrection:
      "Run a fresh 270/271, confirm policy/effective dates with the client, and either rebill the correct payer or transfer to client responsibility.",
    priority: "urgent",
  },
  N130: {
    code: "N130",
    message: "Consult plan benefit documents/guidelines for information about restrictions.",
    relatedCarc: "96",
    recommendedAction: "Review benefit limits; consider appeal or client bill.",
    payerExplanation:
      "Plan-specific limits or exclusions apply to the billed service.",
    suggestedCorrection:
      "Review the plan summary, document the restriction, and either appeal with medical necessity or transfer to client responsibility.",
    priority: "normal",
  },
  N290: {
    code: "N290",
    message: "Missing/incomplete/invalid rendering provider primary identifier.",
    relatedCarc: "16",
    recommendedAction: "Correct rendering NPI on claim and resubmit.",
    payerExplanation:
      "The rendering provider NPI on the claim does not match payer records.",
    suggestedCorrection:
      "Verify provider NPI in payer enrollment; correct loop 2310B and resubmit as a corrected claim (frequency 7).",
    priority: "high",
  },
  N522: {
    code: "N522",
    message: "Duplicate of a claim processed, or to be processed, as a crossover claim.",
    relatedCarc: "18",
    recommendedAction: "Wait for crossover or void this claim.",
    payerExplanation:
      "The claim has already been forwarded between primary and secondary; a duplicate submission is unnecessary.",
    suggestedCorrection:
      "Check secondary payer status before resubmitting. If crossover failed, send corrected claim with prior EOB.",
    priority: "low",
  },
  N657: {
    code: "N657",
    message: "This should be billed with the appropriate code for these services.",
    relatedCarc: "181",
    recommendedAction: "Recode and resubmit corrected claim.",
    payerExplanation:
      "The procedure or diagnosis code submitted is not the correct code for the service rendered.",
    suggestedCorrection:
      "Review documentation, choose the correct CPT/HCPCS or ICD-10 code, and submit a corrected claim (frequency 7).",
    priority: "high",
  },
  MA04: {
    code: "MA04",
    message: "Secondary payment cannot be considered without identity of/payment from primary payer.",
    relatedCarc: "22",
    recommendedAction: "Attach primary EOB and rebill secondary.",
    payerExplanation:
      "Secondary payer cannot adjudicate until primary remittance details are received.",
    suggestedCorrection:
      "Populate COB loop with primary paid/adjustment amounts and resubmit, or send paper claim with EOB attached.",
    priority: "high",
  },
  MA130: {
    code: "MA130",
    message: "Claim contains incomplete and/or invalid information.",
    relatedCarc: "16",
    recommendedAction: "Identify missing field and submit corrected claim.",
    payerExplanation:
      "One or more required fields on the claim are missing or formatted incorrectly.",
    suggestedCorrection:
      "Review payer response details to identify the missing field (often a taxonomy, address, or referring provider), correct, and resubmit.",
    priority: "high",
  },
};

export function lookupRarc(code: string): RarcCatalogEntry {
  const normalized = (code || "").trim().toUpperCase();
  if (!normalized) {
    return {
      code: "",
      message: "Unspecified",
      relatedCarc: null,
      recommendedAction: "Review payer remittance",
      payerExplanation: "",
      suggestedCorrection: "",
      priority: "normal",
    };
  }
  return (
    RARC_CATALOG[normalized] ?? {
      code: normalized,
      message: normalized,
      relatedCarc: null,
      recommendedAction: "Review payer remittance and route to correct queue.",
      payerExplanation:
        "No catalog entry on file for this remark code. Refer to the payer's remittance advice for details.",
      suggestedCorrection:
        "Look up the code in the payer's remittance guide or X12 RARC list and document the correction here.",
      priority: "normal",
    }
  );
}
