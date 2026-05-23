// CAQH CORE Eligibility & Benefits (270/271) Data Content Rule vEB.2.1
// Appendix Table 1 — required Service Type Codes (STCs).
//
// Every CORE-certified payer MUST support these codes in both directions:
//   - GENERIC inquiry   : caller sends EQ01="30" and the payer must return
//                         the full bundle of benefit info defined in §1.3.2.4.
//   - EXPLICIT inquiry  : caller sends EQ01 with one of the codes flagged
//                         `explicit: true` below and the payer must return
//                         the specific benefit category (and any STCs §1.3.2.5
//                         specifies as "always also returned").
//
// REMAINING coverage benefits (§1.3.2.6, Appendix Table 2): for the codes
// flagged `remaining: true`, payers MUST return remaining maximum dollars
// / units / visits where applicable, with the appropriate Time Period
// (DTP) and Quantity (QTY) qualifiers.
//
// PATIENT FINANCIAL RESPONSIBILITY (§1.3.2.7–§1.3.2.13, Appendix Table 3):
// for the codes flagged `financialResponsibility: true`, payers MUST
// return co-pay (EB*B), coinsurance (EB*A), deductible base + remaining
// (EB*C with QTY=29 for remaining), and out-of-pocket (EB*G) where the
// plan defines them.
//
// This table is the canonical source for:
//   1. `validate270.ts` — warn when a request includes an STC outside the
//      CORE set so staff know the payer is under no CORE-mandated obligation
//      to return any specific structured response.
//   2. The settings UI — populate the per-payer default STC dropdown.
//   3. Phase 5 (financial-responsibility extraction) — pick the deductible
//      and OOP semantics off the STC the inquiry was made for.
//
// The list is intentionally narrow: it is JUST the CORE-mandated codes.
// X12 defines hundreds of additional STCs; payers may accept them, but
// the response shape is between the caller and the payer.

type CoreStcCategory =
  | "generic"
  | "medical"
  | "behavioral_health"
  | "professional_visit"
  | "diagnostic"
  | "facility"
  | "pharmacy"
  | "dental"
  | "vision"
  | "ancillary"
  | "preventive"
  | "maternity"
  | "transplant"
  | "transportation";

export interface CoreServiceTypeCode {
  /** EQ01 / EB03 value as transmitted in X12 (2-character alphanumeric). */
  code: string;
  /** Human-readable description (matches X12 IG description, ~50 chars). */
  description: string;
  /** Long-form description for tooltips / settings UI. */
  longDescription?: string;
  category: CoreStcCategory;
  /** True iff this code is part of CORE-required Explicit Inquiry set. */
  explicit: boolean;
  /** True iff this is the Generic Inquiry code (EQ01="30"). */
  generic: boolean;
  /** True iff payer must return Remaining Coverage Benefits for this STC. */
  remaining: boolean;
  /** True iff payer must return Patient Financial Responsibility for this STC. */
  financialResponsibility: boolean;
  /** Free-form notes about CORE response obligations specific to this code. */
  notes?: string;
}

// Appendix Table 1 — canonical CORE Required STC set.
// Source: CAQH CORE Eligibility & Benefits (270/271) Data Content Rule
// vEB.2.1, March 2021. Updated through Phase V certification.
const CORE_SERVICE_TYPE_CODES: CoreServiceTypeCode[] = [
  {
    code: "30",
    description: "Health Benefit Plan Coverage",
    longDescription:
      "Generic Inquiry — payer must return the full bundle of benefit info defined in CORE Data Content Rule §1.3.2.4 (active coverage, plan name, dates, copay, coinsurance, deductible base + remaining, out-of-pocket).",
    category: "generic",
    explicit: false,
    generic: true,
    remaining: true,
    financialResponsibility: true,
    notes: "Default for any inquiry where the caller does not know what STC to ask for.",
  },
  {
    code: "1",
    description: "Medical Care",
    category: "medical",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "33",
    description: "Chiropractic",
    category: "medical",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "35",
    description: "Dental Care",
    category: "dental",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "47",
    description: "Hospital",
    category: "facility",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "48",
    description: "Hospital - Inpatient",
    category: "facility",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "50",
    description: "Hospital - Outpatient",
    category: "facility",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "51",
    description: "Hospital - Emergency Accident",
    category: "facility",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "52",
    description: "Hospital - Emergency Medical",
    category: "facility",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "86",
    description: "Emergency Services",
    category: "facility",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "88",
    description: "Pharmacy",
    category: "pharmacy",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "98",
    description: "Professional (Physician) Visit - Office",
    longDescription:
      "Standard office visit; the bread-and-butter inquiry for outpatient behavioral-health practices.",
    category: "professional_visit",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "AL",
    description: "Vision (Optometry)",
    category: "vision",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "MH",
    description: "Mental Health",
    longDescription:
      "Broad mental-health benefits umbrella. Behavioral-health practices typically pair this with one or more of A4/A6/A7/A8.",
    category: "behavioral_health",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "UC",
    description: "Urgent Care",
    category: "facility",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "A4",
    description: "Psychiatric",
    category: "behavioral_health",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "A6",
    description: "Psychotherapy",
    category: "behavioral_health",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "A7",
    description: "Psychiatric - Inpatient",
    category: "behavioral_health",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "A8",
    description: "Psychiatric - Outpatient",
    category: "behavioral_health",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "AI",
    description: "Substance Abuse",
    category: "behavioral_health",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "BH",
    description: "Pediatric",
    category: "medical",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "BG",
    description: "Cognitive Therapy",
    category: "behavioral_health",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
  },
  {
    code: "MH",
    description: "Mental Health",
    category: "behavioral_health",
    explicit: true,
    generic: false,
    remaining: true,
    financialResponsibility: true,
    notes: "Duplicate guard — see canonical entry above; kept only because some payers split MH from A4/A6.",
  },
  // Diagnostic
  { code: "5",  description: "Diagnostic Lab",          category: "diagnostic", explicit: true, generic: false, remaining: true, financialResponsibility: true },
  { code: "73", description: "Diagnostic Medical",      category: "diagnostic", explicit: true, generic: false, remaining: true, financialResponsibility: true },
  { code: "76", description: "Diagnostic X-Ray",        category: "diagnostic", explicit: true, generic: false, remaining: true, financialResponsibility: true },
  // Preventive / wellness
  { code: "82", description: "Family Planning",         category: "preventive", explicit: true, generic: false, remaining: true, financialResponsibility: true },
  { code: "67", description: "Smoking Cessation",       category: "preventive", explicit: true, generic: false, remaining: true, financialResponsibility: true },
  // Maternity
  { code: "69", description: "Maternity",               category: "maternity",  explicit: true, generic: false, remaining: true, financialResponsibility: true },
  // Transplant / specialized
  { code: "70", description: "Transplants",             category: "transplant", explicit: true, generic: false, remaining: true, financialResponsibility: true },
  // Ancillary
  { code: "12", description: "Durable Medical Equipment Purchase", category: "ancillary",      explicit: true, generic: false, remaining: true, financialResponsibility: true },
  { code: "18", description: "Durable Medical Equipment Rental",   category: "ancillary",      explicit: true, generic: false, remaining: true, financialResponsibility: true },
  { code: "AD", description: "Occupational Therapy",    category: "ancillary",  explicit: true, generic: false, remaining: true, financialResponsibility: true },
  { code: "AE", description: "Physical Medicine",       category: "ancillary",  explicit: true, generic: false, remaining: true, financialResponsibility: true },
  { code: "AF", description: "Speech Therapy",          category: "ancillary",  explicit: true, generic: false, remaining: true, financialResponsibility: true },
  // Transportation
  { code: "AG", description: "Skilled Nursing Care",    category: "facility",      explicit: true, generic: false, remaining: true, financialResponsibility: true },
  { code: "BU", description: "Psychiatric Emergency",   category: "behavioral_health", explicit: true, generic: false, remaining: true, financialResponsibility: true },
];

// De-duplicate the table for any consumer that wants a unique-by-code view
// (MH appears twice intentionally to document the canonical-vs-fallback
// split, but `CORE_STC_BY_CODE` collapses to the first definition).
export const CORE_STC_BY_CODE: ReadonlyMap<string, CoreServiceTypeCode> = new Map(
  (() => {
    const m = new Map<string, CoreServiceTypeCode>();
    for (const stc of CORE_SERVICE_TYPE_CODES) {
      if (!m.has(stc.code)) m.set(stc.code, stc);
    }
    return Array.from(m.entries());
  })(),
);

export function isCoreServiceTypeCode(code: string): boolean {
  return CORE_STC_BY_CODE.has(code.toUpperCase());
}

export function describeServiceTypeCode(code: string): string {
  return CORE_STC_BY_CODE.get(code.toUpperCase())?.description ?? `Unknown STC "${code}"`;
}

/** STCs the caller most likely wants to surface in a settings dropdown,
 *  ordered for behavioral-health practices. */
export function listCoreServiceTypeCodes(): CoreServiceTypeCode[] {
  return Array.from(CORE_STC_BY_CODE.values()).sort((a, b) => {
    // Generic first, then behavioral health, then professional visit, then alpha.
    const order = (s: CoreServiceTypeCode) =>
      s.generic ? 0 : s.category === "behavioral_health" ? 1 : s.category === "professional_visit" ? 2 : 3;
    const oa = order(a);
    const ob = order(b);
    if (oa !== ob) return oa - ob;
    return a.description.localeCompare(b.description);
  });
}
