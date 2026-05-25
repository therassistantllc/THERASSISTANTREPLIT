/**
 * Shared detection of payer "send us documentation" signals across the
 * 277CA acknowledgement and 835/ERA ingest paths.
 *
 * The Medical Review queue (`lib/medical-review/medicalReviewService.ts`)
 * reads `audit_logs` rows where `action = 'medical_review_requested'`. Up
 * until now those rows only existed when a biller wrote one by hand, so
 * the queue under-represented real payer requests carried in 277CA STC
 * segments and 835 remark / necessity CARC codes. This module centralizes
 * the code mappings used by both ingest paths so we can write the audit
 * rows automatically and consistently.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type DocumentationRequestType =
  | "records"
  | "treatment_plan"
  | "notes"
  | "medical_necessity";

export interface DetectedDocumentationRequest {
  requestType: DocumentationRequestType;
  requestedDocuments: string[];
  requestSource: string;
  notes: string | null;
  /** Free-form list of codes that drove the classification (for audit). */
  triggerCodes: string[];
}

/**
 * 277CA STC status codes (STC01-2) that indicate the payer is asking for
 * additional documentation. Pulled from the WPC X12 Health Care Claim
 * Status Code list; we keep the set narrow on purpose so non-doc
 * acknowledgements (e.g. "claim accepted") don't get misclassified.
 *
 * - 226: Information requested from billing/rendering provider not provided
 * - 287: Information requested has not been provided
 * - 324: Need additional documentation
 * - 354: Medical records / clinical documentation requested
 * - 459: Need medical notes
 */
export const DOC_REQUEST_277CA_STATUS_CODES = new Set<string>([
  "226",
  "287",
  "324",
  "354",
  "459",
]);

/**
 * 277CA STC category codes that, on their own, indicate a documentation
 * shortfall. A6 = "Acknowledgement / Rejected for Missing Information" —
 * when paired with any of the status codes above we treat it as records
 * requested.
 */
export const DOC_REQUEST_277CA_CATEGORY_CODES = new Set<string>(["A6"]);

/**
 * 835 remittance remark codes (carried in LQ / MIA / MOA segments) that
 * tell the biller "we need documentation before we can pay". Sourced from
 * the WPC Remittance Advice Remark Codes list; kept conservative.
 *
 * - N4    : Missing/Incomplete/Invalid prior treatment documentation
 * - N26   : Missing itemized bill/statement
 * - N29   : Missing documentation/orders/notes/summary/report/chart
 * - N30   : Patient ineligible — need eligibility docs
 * - N350  : Missing/incomplete/invalid description of service for unlisted procedure
 * - N479  : Missing Explanation of Benefits (COB)
 * - N569  : Not covered when performed without a qualifying medical record
 * - N657  : Diagnosis code requires supporting documentation
 * - N702  : Decision based on review of previously adjudicated claims/records
 * - N705  : Documentation does not support that the services rendered were medically necessary
 * - N706  : Missing documentation
 * - MA01  : Alert: appeal rights / submit records to appeal
 * - MA04  : Secondary payment cannot be considered without primary EOB / records
 * - MA27  : Missing/incomplete/invalid entitlement number or name on the claim
 * - MA130 : Claim contains incomplete and/or invalid information — resubmit with documentation
 */
export const DOC_REQUEST_REMARK_CODES = new Set<string>([
  "N4",
  "N26",
  "N29",
  "N30",
  "N350",
  "N479",
  "N569",
  "N657",
  "N702",
  "N705",
  "N706",
  "MA01",
  "MA04",
  "MA27",
  "MA130",
]);

/**
 * Necessity-driven CARCs. These mirror the set the Medical Review
 * service's denial-fallback classifier (`NECESSITY_CARC`) already uses,
 * so seeded audit rows and the legacy fallback agree.
 */
export const DOC_REQUEST_NECESSITY_CARCS = new Set<string>(["50", "55", "167"]);

/**
 * CARCs that indicate the payer specifically wants medical records (vs a
 * necessity review). Mirrors the Medical Review service's records-related
 * CARC set so both paths classify the same way.
 */
export const DOC_REQUEST_RECORDS_CARCS = new Set<string>([
  "227",
  "252",
]);

function normalizeCode(code: string | null | undefined): string {
  if (!code) return "";
  return String(code).trim().toUpperCase().replace(/^(CO|PR|OA|CR|PI)-?/, "");
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export interface Detect277CAInput {
  /**
   * Parsed STC entries from a 277CA file. Each entry carries the
   * category, status, and entity codes split out of STC01.
   */
  stcStatuses: Array<{
    category?: string | null;
    status?: string | null;
    entity?: string | null;
    raw?: string | null;
  }>;
}

/**
 * Inspect parsed 277CA STC segments and decide whether the payer is
 * asking for additional documentation. Returns null when nothing in the
 * file looks like a doc request.
 */
export function detect277CADocumentationRequest(
  input: Detect277CAInput,
): DetectedDocumentationRequest | null {
  const triggers: string[] = [];
  let categorySeen = "";
  let statusSeen = "";

  for (const entry of input.stcStatuses) {
    const category = normalizeCode(entry.category);
    const status = normalizeCode(entry.status);
    const isDocStatus = status && DOC_REQUEST_277CA_STATUS_CODES.has(status);
    const isDocCategory = category && DOC_REQUEST_277CA_CATEGORY_CODES.has(category);
    if (isDocStatus || isDocCategory) {
      if (category) categorySeen ||= category;
      if (status) statusSeen ||= status;
      const code = [category, status].filter(Boolean).join(":");
      if (code) triggers.push(code);
    }
  }

  if (triggers.length === 0) return null;

  const sourceLabel = `277CA STC ${categorySeen || "?"}${statusSeen ? `:${statusSeen}` : ""}`;
  return {
    requestType: "records",
    requestedDocuments: ["Medical records"],
    requestSource: sourceLabel,
    notes: `Payer 277CA acknowledgement requested additional documentation (${triggers.join(", ")}).`,
    triggerCodes: dedupe(triggers),
  };
}

export interface DetectEraInput {
  /** CAS adjustment reason codes from the claim (CARCs). */
  carcCodes: Array<string | null | undefined>;
  /** Remittance remark codes (LQ/MIA/MOA) parsed from the 835. */
  remarkCodes: Array<string | null | undefined>;
}

/**
 * Inspect parsed 835 CARC and remark codes for a single claim and decide
 * whether the payer is asking for documentation. Necessity CARCs win
 * over plain "send records" remarks so the audit row lands in the right
 * Medical Review tab.
 */
export function detectEraDocumentationRequest(
  input: DetectEraInput,
): DetectedDocumentationRequest | null {
  const carcs = dedupe(input.carcCodes.map((c) => normalizeCode(c)));
  const remarks = dedupe(input.remarkCodes.map((c) => normalizeCode(c)));

  const necessityHits = carcs.filter((c) => DOC_REQUEST_NECESSITY_CARCS.has(c));
  const recordsCarcHits = carcs.filter((c) => DOC_REQUEST_RECORDS_CARCS.has(c));
  const remarkHits = remarks.filter((c) => DOC_REQUEST_REMARK_CODES.has(c));

  if (necessityHits.length === 0 && recordsCarcHits.length === 0 && remarkHits.length === 0) {
    return null;
  }

  if (necessityHits.length > 0) {
    const triggers = dedupe([...necessityHits, ...recordsCarcHits, ...remarkHits]);
    return {
      requestType: "medical_necessity",
      requestedDocuments: ["Clinical note", "Treatment plan", "Assessment"],
      requestSource: `ERA CARC ${necessityHits.join(", ")}`,
      notes: `Payer ERA flagged medical necessity review (CARC ${necessityHits.join(", ")}${remarkHits.length ? `; RARC ${remarkHits.join(", ")}` : ""}).`,
      triggerCodes: triggers,
    };
  }

  const triggers = dedupe([...recordsCarcHits, ...remarkHits]);
  const sourceParts: string[] = [];
  if (recordsCarcHits.length > 0) sourceParts.push(`CARC ${recordsCarcHits.join(", ")}`);
  if (remarkHits.length > 0) sourceParts.push(`RARC ${remarkHits.join(", ")}`);
  return {
    requestType: "records",
    requestedDocuments: ["Medical records"],
    requestSource: `ERA ${sourceParts.join("; ")}`,
    notes: `Payer ERA requested additional documentation (${triggers.join(", ")}).`,
    triggerCodes: triggers,
  };
}

export interface WriteMedicalReviewRequestAuditInput {
  organizationId: string;
  claimId: string;
  clientId?: string | null;
  appointmentId?: string | null;
  detected: DetectedDocumentationRequest;
  /** Origin of the request — e.g. "277CA" or "ERA". */
  origin: "277CA" | "ERA";
  /** Optional reference back to the source row (acknowledgement / era payment id). */
  sourceObjectId?: string | null;
  /**
   * Optional 2200D TRN02 from the 277CA — echoes the original 837P CLM01 the
   * payer is asking documentation for. Persisted in event_metadata so the
   * Medical Review queue can show billers exactly which submitted claim
   * control number the payer cited.
   */
  claimRefTrn?: string | null;
  /** Optional ISO date the request was received (defaults to now). */
  requestDate?: string | null;
  /** Optional payer-set due date if available. */
  dueDate?: string | null;
}

/**
 * Human-readable descriptions for the codes we use to classify
 * documentation requests. Used by the Medical Review queue UI to expand
 * each trigger code into something a biller can act on without looking
 * up the X12 spec.
 */
export const DOCUMENTATION_CODE_DESCRIPTIONS: Record<string, string> = {
  // 277CA STC status codes
  "226": "Information requested from the billing/rendering provider was not provided",
  "287": "Information requested has not been provided",
  "324": "Need additional documentation",
  "354": "Medical records / clinical documentation requested",
  "459": "Need medical notes",
  // 277CA STC category codes
  "A6": "Acknowledgement / rejected for missing information",
  // Necessity CARCs
  "50": "Non-covered: not deemed medically necessary by payer",
  "55": "Procedure/treatment deemed experimental/investigational",
  "167": "Diagnosis not covered — supporting documentation required",
  // Records-related CARCs
  "227": "Information requested from patient/insured/responsible party not provided",
  "252": "An attachment/other documentation is required to adjudicate",
  // Remittance remark codes
  "N4": "Missing/incomplete/invalid prior treatment documentation",
  "N26": "Missing itemized bill/statement",
  "N29": "Missing documentation/orders/notes/summary/report/chart",
  "N30": "Patient ineligible — eligibility documentation needed",
  "N350": "Missing/invalid description of service for unlisted procedure",
  "N479": "Missing Explanation of Benefits (COB)",
  "N569": "Not covered without a qualifying medical record",
  "N657": "Diagnosis code requires supporting documentation",
  "N702": "Decision based on review of previously adjudicated claims/records",
  "N705": "Documentation does not support medical necessity of services",
  "N706": "Missing documentation",
  "MA01": "Appeal rights — submit records to appeal",
  "MA04": "Secondary payment requires primary EOB / records",
  "MA27": "Missing/incomplete/invalid entitlement number or name",
  "MA130": "Claim contains incomplete/invalid information — resubmit with documentation",
};

/**
 * Look up a human-readable description for a trigger code emitted by
 * `detect277CADocumentationRequest` / `detectEraDocumentationRequest`.
 * Handles bare codes ("287", "N706", "50") as well as the
 * `category:status` form 277CA detection emits ("A6:287").
 */
export function describeDocumentationCode(code: string): string | null {
  if (!code) return null;
  const trimmed = code.trim().toUpperCase().replace(/^(CO|PR|OA|CR|PI)-?/, "");
  if (DOCUMENTATION_CODE_DESCRIPTIONS[trimmed]) {
    return DOCUMENTATION_CODE_DESCRIPTIONS[trimmed];
  }
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":").filter(Boolean);
    const named = parts
      .map((p) => DOCUMENTATION_CODE_DESCRIPTIONS[p] ? `${p} — ${DOCUMENTATION_CODE_DESCRIPTIONS[p]}` : null)
      .filter((s): s is string => Boolean(s));
    if (named.length > 0) return named.join("; ");
  }
  return null;
}

/**
 * Idempotently insert a `medical_review_requested` audit_logs row. We
 * key idempotency off (claim_id, origin, sourceObjectId) so re-ingesting
 * the same 277CA / ERA batch does not flood the queue with duplicates.
 *
 * Returns:
 *   - "inserted" when a new row was written
 *   - "skipped"  when an equivalent row already existed
 *   - "error"    on database failure (with the message)
 */
export async function writeMedicalReviewRequestAudit(
  supabase: SupabaseClient,
  input: WriteMedicalReviewRequestAuditInput,
): Promise<{ status: "inserted" } | { status: "skipped" } | { status: "error"; error: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };
  const nowIso = new Date().toISOString();
  const metadata = {
    requestType: input.detected.requestType,
    requestedDocuments: input.detected.requestedDocuments,
    requestSource: input.detected.requestSource,
    requestDate: input.requestDate ?? nowIso,
    dueDate: input.dueDate ?? null,
    notes: input.detected.notes,
    triggerCodes: input.detected.triggerCodes,
    origin: input.origin,
    sourceObjectId: input.sourceObjectId ?? null,
    claimRefTrn: input.claimRefTrn ?? null,
  };

  // Dedupe: look for an existing row with the same origin + sourceObjectId
  // (or, when no source id is provided, the same trigger codes) on this
  // claim. We only need a single match to skip — re-ingestion of the same
  // ack/ERA must not create new queue entries.
  try {
    const dedupeQuery = sb
      .from("audit_logs")
      .select("id, event_metadata")
      .eq("organization_id", input.organizationId)
      .eq("action", "medical_review_requested")
      .eq("claim_id", input.claimId)
      .limit(50);
    const { data: existingRows, error: existingError } = await dedupeQuery;
    if (existingError) {
      return { status: "error", error: existingError.message ?? "audit_logs lookup failed" };
    }
    for (const row of (existingRows as Array<{ event_metadata?: Record<string, unknown> | null }> | null) ?? []) {
      const meta = (row.event_metadata ?? {}) as Record<string, unknown>;
      const sameOrigin = String(meta.origin ?? "") === input.origin;
      if (!sameOrigin) continue;
      if (input.sourceObjectId && String(meta.sourceObjectId ?? "") === input.sourceObjectId) {
        return { status: "skipped" };
      }
      if (!input.sourceObjectId) {
        const existingTriggers = Array.isArray(meta.triggerCodes)
          ? (meta.triggerCodes as unknown[]).map((c) => String(c))
          : [];
        const same = existingTriggers.length === input.detected.triggerCodes.length
          && existingTriggers.every((c) => input.detected.triggerCodes.includes(c));
        if (same) return { status: "skipped" };
      }
    }
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "audit_logs lookup failed" };
  }

  try {
    const { error } = await sb.from("audit_logs").insert({
      organization_id: input.organizationId,
      action: "medical_review_requested",
      event_type: "medical_review_ingest",
      event_summary: input.detected.notes ?? input.detected.requestSource,
      event_metadata: metadata,
      claim_id: input.claimId,
      patient_id: input.clientId ?? null,
      appointment_id: input.appointmentId ?? null,
      object_type: "professional_claim",
      object_id: input.claimId,
      created_at: nowIso,
    });
    if (error) return { status: "error", error: error.message ?? "audit_logs insert failed" };
    return { status: "inserted" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "audit_logs insert failed" };
  }
}
