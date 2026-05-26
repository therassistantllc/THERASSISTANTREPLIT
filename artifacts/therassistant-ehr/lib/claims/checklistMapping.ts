/**
 * Shared mapping between the Availity 837P validator's structured error
 * pointer and the "837P field checklist" rows rendered by the
 * Ready-to-Generate detail panel. Lifted out of ReadyToGenerateClient so
 * the Batches detail page can highlight the same row when a rebuild
 * fails on /api/claims/837p/batch/[id]/rebuild.
 */

export type ChecklistRowId =
  | "ref"
  | "amt"
  | "pos"
  | "dx"
  | "lines"
  | "billing"
  | "rendering"
  | "payer";

/** Mirrors Rebuild837PBatchErrorDetail so client code can stay loose-typed. */
export type GenerationErrorFieldDetail = {
  code: "validation_failed" | "infrastructure_error";
  message: string;
  claimId?: string;
  loop?: string;
  segment?: string;
  field?: string;
};

/** Human-readable label for each checklist row. Mirrors the labels rendered
 * by the Ready-to-Generate "837P field checklist" tab so other pages can
 * surface the same wording without re-rendering the whole checklist. */
export const CHECKLIST_ROW_LABEL: Record<ChecklistRowId, string> = {
  ref: "CLM01 — Patient account / claim ref",
  amt: "CLM02 — Total charge > 0",
  pos: "CLM05 — Place of service",
  dx: "HI — At least one ICD-10 diagnosis",
  lines: "LX/SV1 — At least one service line with a procedure code",
  billing: "2010AA NM1*85 — Billing provider NPI",
  rendering: "2310B NM1*82 — Rendering provider NPI",
  payer: "2010BB NM1*PR — Payer ID",
};

/**
 * Map a validator `field` path (e.g. "parties.billing_provider_npi",
 * "serviceLines[0].procedure_code") onto the checklist row that displays
 * the same constraint. Falls back to a loop/segment-based match so newer
 * validator fields still light up the closest row instead of nothing.
 */
export function checklistRowFor(
  detail: GenerationErrorFieldDetail | undefined,
): ChecklistRowId | null {
  if (!detail) return null;
  const field = detail.field ?? "";
  if (field.startsWith("parties.billing_provider")) return "billing";
  if (
    field.startsWith("parties.rendering_provider") ||
    field.includes("rendering_provider_npi")
  ) {
    return "rendering";
  }
  if (field.startsWith("payerProfile.") || field.startsWith("parties.payer_")) return "payer";
  if (field === "claim.diagnosis_codes" || field.includes("diagnosis_pointers")) return "dx";
  if (field === "claim.place_of_service") return "pos";
  if (field === "claim.total_charge" || field.includes(".charge_amount")) return "amt";
  if (field === "claim.patient_account_number" || field === "claim.claim_number") return "ref";
  if (field === "serviceLines" || field.includes(".procedure_code") || field.includes(".units")) {
    return "lines";
  }
  // Loop-based fallback so we still focus *something* useful.
  const loop = detail.loop ?? "";
  if (loop.startsWith("2010AA")) return "billing";
  if (loop.startsWith("2010BB")) return "payer";
  if (loop.startsWith("2310B")) return "rendering";
  if (loop.startsWith("2400")) return "lines";
  return null;
}
