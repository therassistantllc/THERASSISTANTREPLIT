export type CalendarView = "day" | "week" | "month";
export type AppointmentStatus = "scheduled" | "checked_in" | "completed" | "cancelled" | "no_show";
export type AppointmentType = "Intake" | "90834" | "90837" | "Treatment Plan" | "Family Therapy" | "Care Coordination";
export type LocationType = "Office" | "Telehealth";

export type Provider = {
  id: string;
  name: string;
  credentials: string;
  color: string;
  location: string;
};

export type Appointment = {
  id: string;
  patientId: string;
  patientName: string;
  providerId: string;
  type: AppointmentType;
  status: AppointmentStatus;
  start: string;
  end: string;
  durationMinutes: number;
  location: LocationType;
  telehealthUrl?: string;
  notes: string;
  reminderStatus: "not_sent" | "scheduled" | "sent" | "failed";
  encounterId?: string;
  flags: string[];
  defaultCpt: string;
};

export type CalendarBlock = {
  id: string;
  providerId: string;
  title: string;
  start: string;
  end: string;
  kind: "Lunch" | "Admin" | "Meeting" | "Time Off";
};

export type WorkScheduleWindow = {
  id: string;
  providerId: string;
  day: "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";
  start: string;
  end: string;
  location: LocationType | "Office + Telehealth";
  enabled: boolean;
};

export type AppointmentFormState = {
  patientName: string;
  providerId: string;
  type: AppointmentType;
  date: string;
  startTime: string;
  durationMinutes: number;
  location: LocationType;
  recurrence: "none" | "weekly" | "biweekly" | "monthly";
  recurrenceCount: number;
  notes: string;
  sendReminder: boolean;
};

export const providers: Provider[] = [
  { id: "prov-lena", name: "Lena Ortiz", credentials: "LPC", color: "#2563eb", location: "Denver" },
  { id: "prov-noah", name: "Noah Kim", credentials: "LCSW", color: "#7c3aed", location: "Aurora" },
  { id: "prov-priya", name: "Priya Shah", credentials: "PsyD", color: "#059669", location: "Lakewood" },
];

export const appointmentTypes: AppointmentType[] = ["Intake", "90834", "90837", "Treatment Plan", "Family Therapy", "Care Coordination"];

export const appointmentTypeDefaults: Record<AppointmentType, { duration: number; cpt: string; label: string }> = {
  Intake: { duration: 60, cpt: "90791", label: "Psychiatric diagnostic evaluation" },
  "90834": { duration: 45, cpt: "90834", label: "Psychotherapy, 45 minutes" },
  "90837": { duration: 60, cpt: "90837", label: "Psychotherapy, 60 minutes" },
  "Treatment Plan": { duration: 45, cpt: "H0032", label: "Treatment planning" },
  "Family Therapy": { duration: 50, cpt: "90847", label: "Family psychotherapy with patient" },
  "Care Coordination": { duration: 30, cpt: "T1017", label: "Targeted case management" },
};

export const initialAppointments: Appointment[] = [
  {
    id: "appt-1001",
    patientId: "pat-avery",
    patientName: "Avery Morgan",
    providerId: "prov-lena",
    type: "90837",
    status: "scheduled",
    start: "2026-04-28T09:00:00",
    end: "2026-04-28T09:53:00",
    durationMinutes: 53,
    location: "Telehealth",
    telehealthUrl: "https://telehealth.example.com/session/appt-1001",
    reminderStatus: "sent",
    notes: "Client prefers telehealth. Verify they are physically located in Colorado.",
    flags: ["telehealth", "eligibility active"],
    defaultCpt: "90837",
  },
  {
    id: "appt-1002",
    patientId: "pat-sofia",
    patientName: "Sofia Martinez",
    providerId: "prov-noah",
    type: "90837",
    status: "checked_in",
    start: "2026-04-28T10:30:00",
    end: "2026-04-28T11:23:00",
    durationMinutes: 53,
    location: "Office",
    reminderStatus: "sent",
    notes: "Guardian in waiting room. School ROI pending.",
    flags: ["minor", "guardian present"],
    defaultCpt: "90837",
  },
  {
    id: "appt-1003",
    patientId: "pat-marcus",
    patientName: "Marcus Thompson",
    providerId: "prov-priya",
    type: "Intake",
    status: "completed",
    start: "2026-04-28T13:00:00",
    end: "2026-04-28T14:00:00",
    durationMinutes: 60,
    location: "Telehealth",
    telehealthUrl: "https://telehealth.example.com/session/appt-1003",
    reminderStatus: "sent",
    encounterId: "enc-1003",
    notes: "Intake completed. Encounter opened for documentation.",
    flags: ["encounter created", "documentation needed"],
    defaultCpt: "90791",
  },
];

export const initialBlocks: CalendarBlock[] = [
  { id: "block-1", providerId: "prov-lena", title: "Lunch", start: "2026-04-28T12:00:00", end: "2026-04-28T12:45:00", kind: "Lunch" },
  { id: "block-2", providerId: "prov-noah", title: "Case consultation", start: "2026-04-28T14:00:00", end: "2026-04-28T15:00:00", kind: "Meeting" },
  { id: "block-3", providerId: "prov-priya", title: "Admin time", start: "2026-04-28T10:00:00", end: "2026-04-28T11:00:00", kind: "Admin" },
];

export const initialWorkSchedule: WorkScheduleWindow[] = [
  { id: "ws-1", providerId: "prov-lena", day: "Monday", start: "09:00", end: "17:00", location: "Office + Telehealth", enabled: true },
  { id: "ws-2", providerId: "prov-lena", day: "Tuesday", start: "09:00", end: "17:00", location: "Office + Telehealth", enabled: true },
  { id: "ws-3", providerId: "prov-noah", day: "Tuesday", start: "08:30", end: "16:30", location: "Office", enabled: true },
  { id: "ws-4", providerId: "prov-priya", day: "Tuesday", start: "10:00", end: "18:00", location: "Telehealth", enabled: true },
];

export function formatDisplayTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function formatDisplayDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
}

export function sameDate(iso: string, selectedDate: string): boolean {
  return iso.slice(0, 10) === selectedDate;
}

export function getTimeSlots(startHour = 7, endHour = 20): string[] {
  const slots: string[] = [];
  for (let hour = startHour; hour <= endHour; hour += 1) {
    for (const minute of [0, 15, 30, 45]) {
      if (hour === endHour && minute > 0) continue;
      slots.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  }
  return slots;
}

export function minutesFromStartOfDay(iso: string): number {
  const date = new Date(iso);
  return date.getHours() * 60 + date.getMinutes();
}

export function appointmentTopPx(iso: string, startHour = 7, pxPerMinute = 1.05): number {
  return Math.max(0, (minutesFromStartOfDay(iso) - startHour * 60) * pxPerMinute);
}

export function appointmentHeightPx(durationMinutes: number, pxPerMinute = 1.05): number {
  return Math.max(40, durationMinutes * pxPerMinute);
}

export function createEncounterId(appointmentId: string): string {
  return `enc-${appointmentId.replace("appt-", "")}`;
}

export function nextAppointmentStatus(status: AppointmentStatus): AppointmentStatus | null {
  if (status === "scheduled") return "checked_in";
  if (status === "checked_in") return "completed";
  return null;
}

export function appointmentCanCreateEncounter(appointment: Appointment): boolean {
  return appointment.status === "completed" && !appointment.encounterId;
}

export function statusLabel(status: AppointmentStatus): string {
  return {
    scheduled: "Scheduled",
    checked_in: "Checked In",
    completed: "Completed",
    cancelled: "Cancelled",
    no_show: "No Show",
  }[status];
}

export function statusTone(status: AppointmentStatus): "blue" | "green" | "amber" | "red" | "slate" {
  if (status === "scheduled") return "blue";
  if (status === "checked_in") return "amber";
  if (status === "completed") return "green";
  if (status === "cancelled") return "red";
  return "slate";
}

export function createAppointmentFromForm(form: AppointmentFormState, index = 0): Appointment {
  const date = new Date(`${form.date}T00:00:00`);
  if (form.recurrence === "weekly") date.setDate(date.getDate() + index * 7);
  if (form.recurrence === "biweekly") date.setDate(date.getDate() + index * 14);
  if (form.recurrence === "monthly") date.setMonth(date.getMonth() + index);

  const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const start = new Date(`${dateKey}T${form.startTime}:00`);
  const end = new Date(start.getTime() + form.durationMinutes * 60000);
  const defaults = appointmentTypeDefaults[form.type];

  return {
    id: `appt-${Date.now()}-${index}`,
    patientId: `pat-${form.patientName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    patientName: form.patientName,
    providerId: form.providerId,
    type: form.type,
    status: "scheduled",
    start: start.toISOString().slice(0, 19),
    end: end.toISOString().slice(0, 19),
    durationMinutes: form.durationMinutes,
    location: form.location,
    telehealthUrl: form.location === "Telehealth" ? `https://telehealth.example.com/session/appt-${Date.now()}-${index}` : undefined,
    reminderStatus: form.sendReminder ? "scheduled" : "not_sent",
    notes: form.notes,
    flags: [
      ...(form.location === "Telehealth" ? ["telehealth"] : []),
      ...(form.recurrence !== "none" ? ["recurring"] : []),
    ],
    defaultCpt: defaults.cpt,
  };
}

export function countStatuses(appointments: Appointment[]) {
  return {
    scheduled: appointments.filter((a) => a.status === "scheduled").length,
    checkedIn: appointments.filter((a) => a.status === "checked_in").length,
    completed: appointments.filter((a) => a.status === "completed").length,
    cancelledOrNoShow: appointments.filter((a) => a.status === "cancelled" || a.status === "no_show").length,
  };
}
