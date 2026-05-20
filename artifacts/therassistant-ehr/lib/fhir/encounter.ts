import type { FhirCodeableConcept, FhirCoding, FhirPeriod, FhirReference } from "./common";
import { s } from "./common";

export interface FhirEncounter {
  resourceType: "Encounter";
  id: string;
  meta?: { lastUpdated?: string };
  status:
    | "planned" | "arrived" | "triaged" | "in-progress" | "onleave"
    | "finished" | "cancelled" | "entered-in-error" | "unknown";
  class: FhirCoding;
  subject: FhirReference;
  participant?: Array<{ individual: FhirReference }>;
  period?: FhirPeriod;
  appointment?: FhirReference[];
  reasonCode?: FhirCodeableConcept[];
}

export type EncounterRow = {
  id: string;
  organization_id?: string | null;
  client_id: string;
  provider_id: string | null;
  appointment_id: string | null;
  encounter_status?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  service_date?: string | null;
  session_summary?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
};

export const ENCOUNTER_DB_COLUMNS =
  "id, organization_id, client_id, provider_id, appointment_id, encounter_status, started_at, ended_at, service_date, session_summary, updated_at, archived_at";

function mapEncounterStatus(status: string | null | undefined): FhirEncounter["status"] {
  switch ((status ?? "").toLowerCase()) {
    case "scheduled": return "planned";
    case "checked_in":
    case "arrived": return "arrived";
    case "in_progress": return "in-progress";
    case "completed":
    case "signed":
    case "finished": return "finished";
    case "cancelled":
    case "canceled":
    case "no_show": return "cancelled";
    default: return "unknown";
  }
}

export function encounterRowToFhir(row: EncounterRow, baseUrl: string): FhirEncounter {
  const period: FhirPeriod = {};
  const start = s(row.started_at);
  const end = s(row.ended_at);
  if (start) period.start = start;
  if (end) period.end = end;

  const participant = row.provider_id
    ? [{
        individual: {
          reference: `${baseUrl}/Practitioner/${row.provider_id}`,
          type: "Practitioner",
        },
      }]
    : undefined;

  const summary = s(row.session_summary);

  return {
    resourceType: "Encounter",
    id: String(row.id),
    meta: { lastUpdated: s(row.updated_at) },
    status: mapEncounterStatus(row.encounter_status),
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "AMB",
      display: "ambulatory",
    },
    subject: { reference: `${baseUrl}/Patient/${row.client_id}`, type: "Patient" },
    participant,
    period: start || end ? period : undefined,
    appointment: row.appointment_id
      ? [{ reference: `${baseUrl}/Appointment/${row.appointment_id}`, type: "Appointment" }]
      : undefined,
    reasonCode: summary ? [{ text: summary.slice(0, 500) }] : undefined,
  };
}
