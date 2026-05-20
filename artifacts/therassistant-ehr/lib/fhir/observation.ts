import type { FhirCodeableConcept, FhirReference } from "./common";
import { s } from "./common";

export interface FhirObservationComponent {
  code: FhirCodeableConcept;
  valueString?: string;
}

export interface FhirObservation {
  resourceType: "Observation";
  id: string;
  meta?: { lastUpdated?: string };
  status: "registered" | "preliminary" | "final" | "amended" | "cancelled" | "entered-in-error";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  component?: FhirObservationComponent[];
  note?: { text: string }[];
}

export type CheckInRow = {
  id: string;
  organization_id?: string | null;
  client_id: string;
  encounter_id?: string | null;
  status?: string | null;
  current_mood?: string | null;
  current_stressors?: string | null;
  safety_concerns?: string | null;
  psychosocial_updates?: string | null;
  patient_statement?: string | null;
  submitted_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
};

export const OBSERVATION_DB_COLUMNS =
  "id, organization_id, client_id, encounter_id, status, current_mood, current_stressors, safety_concerns, psychosocial_updates, patient_statement, submitted_at, created_at, updated_at, archived_at";

function mapObservationStatus(status: string | null | undefined): FhirObservation["status"] {
  switch ((status ?? "").toLowerCase()) {
    case "draft": return "registered";
    case "submitted": return "preliminary";
    case "reviewed": return "final";
    case "archived": return "cancelled";
    default: return "preliminary";
  }
}

const CHECK_IN_SYSTEM = "urn:ehr:check-in";

export function checkInRowToObservation(row: CheckInRow, baseUrl: string): FhirObservation {
  const components: FhirObservationComponent[] = [];
  const push = (code: string, display: string, value?: string | null) => {
    const v = s(value);
    if (v) {
      components.push({
        code: {
          text: display,
          coding: [{ system: CHECK_IN_SYSTEM, code, display }],
        },
        valueString: v,
      });
    }
  };
  push("mood", "Current mood", row.current_mood);
  push("stressors", "Current stressors", row.current_stressors);
  push("safety", "Safety concerns", row.safety_concerns);
  push("psychosocial", "Psychosocial updates", row.psychosocial_updates);

  const statement = s(row.patient_statement);
  const effective = s(row.submitted_at) ?? s(row.created_at);

  return {
    resourceType: "Observation",
    id: String(row.id),
    meta: { lastUpdated: s(row.updated_at) },
    status: mapObservationStatus(row.status),
    category: [{
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/observation-category",
        code: "survey",
        display: "Survey",
      }],
      text: "Patient check-in",
    }],
    code: {
      text: "Patient check-in",
      coding: [{ system: CHECK_IN_SYSTEM, code: "patient-check-in", display: "Patient check-in" }],
    },
    subject: { reference: `${baseUrl}/Patient/${row.client_id}`, type: "Patient" },
    encounter: row.encounter_id
      ? { reference: `${baseUrl}/Encounter/${row.encounter_id}`, type: "Encounter" }
      : undefined,
    effectiveDateTime: effective,
    issued: effective,
    component: components.length ? components : undefined,
    note: statement ? [{ text: statement }] : undefined,
  };
}
