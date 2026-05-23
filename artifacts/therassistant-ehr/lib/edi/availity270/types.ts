type Availity270Mode = "test" | "production";

export interface Availity270Connection {
  id?: string;
  organization_id: string;
  clearinghouse_name?: string;
  mode: Availity270Mode;
  submitter_id: string;
  submitter_name?: string | null;
  sender_qualifier: "30" | "ZZ";
  receiver_qualifier: "30" | "ZZ";
  receiver_id: string;
  receiver_name: string;
  gs_receiver_code: string;
  x12_version: string;
  isa_usage_indicator: "T" | "P";
  submitter_contact_phone?: string | null;
  submitter_contact_email?: string | null;
}

interface Availity270InformationSource {
  payerName: string;
  payerId: string;
}

interface Availity270InformationReceiver {
  entityType: "1" | "2";
  lastNameOrOrg: string;
  firstName?: string | null;
  npi: string;
}

interface Availity270Subscriber {
  lastName: string;
  firstName: string;
  middleName?: string | null;
  memberId: string;
  dob: string;
  gender?: "M" | "F" | "U" | null;
  /**
   * Payer-issued Group #. When set, the generator emits a Loop 2100C
   * `REF*1L*<group>~` (Group or Policy Number) per X12 005010X279A1.
   */
  groupNumber?: string | null;
}

export interface Eligibility270Input {
  connection: Availity270Connection;
  submitterName: string;
  informationSource: Availity270InformationSource;
  informationReceiver: Availity270InformationReceiver;
  subscriber: Availity270Subscriber;
  serviceTypeCodes: string[];
  serviceDate?: string | null;
  traceId?: string;
}

export interface Availity270ValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
  loop?: string;
  segment?: string;
}

export interface Availity270ValidationResult {
  isValid: boolean;
  errors: Availity270ValidationError[];
  warnings: Availity270ValidationError[];
}

export interface Generated270Request {
  transactionType: "270";
  notes: string;
  mode: Availity270Mode;
  payloadId: string;
  fileContent: string;
  isaControlNumber: string;
  gsControlNumber: string;
  stControlNumber: string;
  validation: Availity270ValidationResult;
}

export interface ParsedAAAError {
  code: string;
  description: string;
  followUpAction?: string | null;
  loop?: string | null;
  rejectReason?: string | null;
}

/**
 * High-level financial-responsibility category that an EB segment falls
 * into per CAQH CORE Data Content Rule vEB.2.1 §1.3.2.5–§1.3.2.13.
 * This is the "what is this benefit telling me" answer the UI needs.
 */
export type ParsedEB271Category =
  | "active_coverage"
  | "inactive_coverage"
  | "copay"
  | "coinsurance"
  | "deductible"
  | "out_of_pocket"
  | "limitation"
  | "exclusion"
  | "non_covered"
  | "max_coverage"
  | "remaining_coverage"
  | "telemedicine"
  | "authorization"
  | "benefit_description"
  | "other";

export interface ParsedEB271 {
  eligibilityCode: string;
  eligibilityCodeMeaning: string;
  coverageLevelCode?: string | null;
  coverageLevelMeaning?: string | null;
  serviceTypeCode?: string | null;
  insuranceTypeCode?: string | null;
  planDescription?: string | null;
  timePeriodQualifier?: string | null;
  /** Human-readable label for the time period qualifier (EB06). */
  timePeriodQualifierMeaning?: string | null;
  monetaryAmount?: number | null;
  percent?: number | null;
  quantityQualifier?: string | null;
  quantity?: number | null;
  /** EB11 — Authorization or Certification Indicator (Y/N/U). */
  authorizationRequiredCode?: "Y" | "N" | "U" | null;
  inPlanNetwork?: "Y" | "N" | "W" | "U" | null;
  followingSegments?: string[][];

  // Phase 5 additions — categorization + extracted hints.
  /** CORE Data Content Rule categorization for this benefit segment. */
  category?: ParsedEB271Category;
  /** True when QTY/MSG context says this is a remaining balance, not a base figure. */
  isRemaining?: boolean;
  /** True when EB11 = "Y" OR an attached III/MSG segment signals auth is required. */
  authorizationRequired?: boolean | null;
  /** Detected tier label (e.g. "Tier 1") parsed from EB05 plan description or attached MSG. */
  tier?: string | null;
  /** True when this benefit, an attached III, or an attached MSG identifies telemedicine. */
  telemedicineFlag?: boolean;
  /** Concatenated MSG free-text attached to this benefit. */
  messageText?: string | null;
  /**
   * Which HL loop this EB segment was returned under — drives Single
   * Patient Attribution Rule vEB.1.0 rollup of `attribution.target`.
   */
  owner?: "subscriber" | "dependent";
}

/**
 * Headline patient financial responsibility values rolled up from the
 * per-segment `benefits` list. Provided as a convenience for callers
 * that don't want to walk segments themselves; the full per-segment
 * detail remains on `Parsed271Response.benefits`.
 */
export interface Parsed271Financials {
  copayAmount: number | null;
  coinsurancePercent: number | null;
  deductibleTotal: number | null;
  deductibleRemaining: number | null;
  outOfPocketTotal: number | null;
  outOfPocketRemaining: number | null;
  maxCoverageAmount: number | null;
  maxCoveragePeriod: string | null;
  remainingCoverageAmount: number | null;
  remainingCoveragePeriod: string | null;
  /** True when any returned benefit requires authorization. */
  authorizationRequired: boolean | null;
  /** True when any returned benefit indicates telemedicine is covered. */
  telemedicineCovered: boolean | null;
  /** First detected tier label across returned benefits, if any. */
  benefitTier: string | null;
}

/**
 * Identity captured from the 271's subscriber loop (Loop 2100C / NM1*IL).
 * Always populated when the response carries any subscriber context.
 */
export interface Parsed271Subscriber {
  lastName: string | null;
  firstName: string | null;
  memberId: string | null;
  dob: string | null;
  gender: string | null;
}

/**
 * Identity captured from the 271's dependent loop (Loop 2100D / NM1*03)
 * per CAQH CORE Single Patient Attribution Data Content Rule vEB.1.0.
 * Present only when the 271 includes an HL*23 dependent hierarchy.
 */
export interface Parsed271Dependent {
  lastName: string | null;
  firstName: string | null;
  dob: string | null;
  gender: string | null;
}

/**
 * Attribution rollup per Single Patient Attribution Rule vEB.1.0
 * §4.2–§4.3. `target` says which loop the eligibility/benefit content
 * applies to; the caller is responsible for routing the response to the
 * matching patient chart.
 */
export interface Parsed271Attribution {
  target: "subscriber" | "dependent";
  subscriber: Parsed271Subscriber;
  dependent: Parsed271Dependent | null;
}

export interface Parsed271Response {
  status: "active" | "inactive" | "not_found" | "error" | "unknown";
  payerName?: string | null;
  payerId?: string | null;
  planName?: string | null;
  subscriberLastName?: string | null;
  subscriberFirstName?: string | null;
  memberId?: string | null;
  dob?: string | null;
  gender?: string | null;
  /** Full subscriber identity (also reflected in flat fields above). */
  subscriber?: Parsed271Subscriber;
  /** Dependent identity when an HL*23 dependent loop is present. */
  dependent?: Parsed271Dependent | null;
  /** Single Patient Attribution Rule rollup. */
  attribution?: Parsed271Attribution;
  effectiveDate?: string | null;
  terminationDate?: string | null;
  aaaErrors: ParsedAAAError[];
  benefits: ParsedEB271[];
  messages: string[];
  /**
   * Headline financial-responsibility rollup. Computed from `benefits`
   * per CORE Data Content Rule vEB.2.1 §1.3.2.5–§1.3.2.13.
   */
  financials?: Parsed271Financials;
  isaControlNumber?: string | null;
  gsControlNumber?: string | null;
  stControlNumber?: string | null;
  rawSegments: string[][];
}
