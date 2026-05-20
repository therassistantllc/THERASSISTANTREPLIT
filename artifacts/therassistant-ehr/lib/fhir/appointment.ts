import type { FhirReference } from "./common";
import { s } from "./common";

export interface FhirAppointment {
  resourceType: "Appointment";
  id: string;
  meta?: { lastUpdated?: string };
  status:
    | "proposed" | "pending" | "booked" | "arrived" | "fulfilled"
    | "cancelled" | "noshow" | "entered-in-error" | "checked-in" | "waitlist";
  serviceType?: { text?: string }[];
  description?: string;
  start?: string;
  end?: string;
  participant: Array<{
    actor: FhirReference;
    status: "accepted" | "declined" | "tentative" | "needs-action";
    required?: "required" | "optional" | "information-only";
  }>;
  cancelationReason?: { text?: string };
}

export type AppointmentRow = {
  id: string;
  organization_id?: string | null;
  client_id: string;
  provider_id: string | null;
  scheduled_start_at?: string | null;
  scheduled_end_at?: string | null;
  appointment_status?: string | null;
  appointment_type?: string | null;
  reason?: string | null;
  cancellation_reason?: string | null;
  archived_at?: string | null;
  updated_at?: string | null;
};

export const APPOINTMENT_DB_COLUMNS =
  "id, organization_id, client_id, provider_id, scheduled_start_at, scheduled_end_at, appointment_status, appointment_type, reason, cancellation_reason, archived_at, updated_at";

function mapAppointmentStatus(status: string | null | undefined): FhirAppointment["status"] {
  switch ((status ?? "").toLowerCase()) {
    case "scheduled":
    case "confirmed": return "booked";
    case "checked_in": return "checked-in";
    case "in_progress": return "arrived";
    case "completed": return "fulfilled";
    case "cancelled":
    case "canceled": return "cancelled";
    case "no_show": return "noshow";
    case "pending": return "pending";
    case "waitlist": return "waitlist";
    default: return "booked";
  }
}

export function appointmentRowToFhir(row: AppointmentRow, baseUrl: string): FhirAppointment {
  const participants: FhirAppointment["participant"] = [
    {
      actor: { reference: `${baseUrl}/Patient/${row.client_id}`, type: "Patient" },
      status: "accepted",
      required: "required",
    },
  ];
  if (row.provider_id) {
    participants.push({
      actor: { reference: `${baseUrl}/Practitioner/${row.provider_id}`, type: "Practitioner" },
      status: "accepted",
      required: "required",
    });
  }
  const apptType = s(row.appointment_type);
  const cancellation = s(row.cancellation_reason);

  return {
    resourceType: "Appointment",
    id: String(row.id),
    meta: { lastUpdated: s(row.updated_at) },
    status: mapAppointmentStatus(row.appointment_status),
    serviceType: apptType ? [{ text: apptType }] : undefined,
    description: s(row.reason),
    start: s(row.scheduled_start_at),
    end: s(row.scheduled_end_at),
    participant: participants,
    cancelationReason: cancellation ? { text: cancellation } : undefined,
  };
}
