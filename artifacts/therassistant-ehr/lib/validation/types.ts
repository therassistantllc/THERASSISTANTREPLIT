import type { SupabaseClient } from "@supabase/supabase-js";

type Severity = "blocking" | "warning" | "info";

export const CATEGORIES = [
  // ---- System / configuration readiness ----
  "organization",
  "providers",
  "locations",
  "payers",
  "clearinghouse",
  "feeSchedules",
  "billingDefaults",
  // ---- Per-claim content (Phase 2) ----
  "claimDiagnoses",
  "claimServiceLines",
  "claimParties",
  "claimDates",
  "claimTelehealth",
  "claimAuthorization",
  "claimPayerRules",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Categories that belong to system / configuration readiness. */
const SYSTEM_READINESS_CATEGORIES: Category[] = [
  "organization",
  "providers",
  "locations",
  "payers",
  "clearinghouse",
  "feeSchedules",
  "billingDefaults",
];

/** Categories that belong to per-claim content validation. */
export const CLAIM_CONTENT_CATEGORIES: Category[] = [
  "claimDiagnoses",
  "claimServiceLines",
  "claimParties",
  "claimDates",
  "claimTelehealth",
  "claimAuthorization",
  "claimPayerRules",
];

export interface ValidationFinding {
  ruleId: string;
  category: Category;
  severity: Severity;
  message: string;
  fixRoute: string;
  whyItMatters: string;
  resolution: string;
  evidence?: Record<string, unknown>;
}

export interface ValidationSummary {
  total: number;
  blocking: number;
  warning: number;
  info: number;
  ready: boolean;
}

export type FindingsByCategory = Record<Category, ValidationFinding[]>;

export interface ValidationReport {
  organizationId: string;
  organizationName: string | null;
  generatedAt: string;
  summary: ValidationSummary;
  findings: ValidationFinding[];
  findingsByCategory: FindingsByCategory;
}

export interface FactContext {
  organizationId: string;
  supabase: SupabaseClient;
  /**
   * Optional claim-scoped context. Required by claim-content fact loaders
   * (lib/validation/claim/facts.ts); ignored by system-readiness loaders.
   * Eligibility (Phase 3) reuses the same canonical claim facts via this id.
   */
  claimId?: string | null;
}

export interface FactLoader {
  /** Top-level fact name used by rule conditions (e.g. "organization"). */
  name: string;
  /** Loads the aggregated fact object for this domain. */
  load: (ctx: FactContext) => Promise<Record<string, unknown>>;
}

/** A serializable rule definition driven from JSON. */
export interface RuleSpec {
  id: string;
  category: Category;
  severity: Severity;
  message: string;
  fixRoute: string;
  whyItMatters: string;
  resolution: string;
  /** json-rules-engine conditions object. Rule fires when the condition is TRUE — i.e. it describes the violation. */
  conditions: Record<string, unknown>;
}
