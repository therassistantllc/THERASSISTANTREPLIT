import type { CanonicalEhrState, ID } from "@/lib/canonical-ehr/types";
import { getEncounterReadiness } from "@/lib/canonical-ehr/model";

export function deriveEncounterStatus(state: CanonicalEhrState, encounterId: ID) {
  const readiness = getEncounterReadiness(state, encounterId);
  if (!readiness.encounter) return "draft";
  if (readiness.encounter.billing_status === "paid") return "paid";
  if (readiness.encounter.billing_status === "submitted") return "submitted";
  if (readiness.passed) return "ready_to_bill";
  if (readiness.note?.locked) return "signed";
  return readiness.encounter.encounter_status;
}
