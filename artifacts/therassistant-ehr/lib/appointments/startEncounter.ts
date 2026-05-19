import type { CanonicalEhrState, ID } from "@/lib/canonical-ehr/types";
import { startEncounterFromAppointment } from "@/lib/canonical-ehr/model";

export function startAppointmentEncounter(state: CanonicalEhrState, appointmentId: ID): CanonicalEhrState {
  return startEncounterFromAppointment(state, appointmentId);
}
