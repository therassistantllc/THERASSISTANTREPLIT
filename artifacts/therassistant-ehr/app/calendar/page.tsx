import Link from "next/link";
import {
  appointmentCanCreateEncounter,
  countStatuses,
  createAppointmentFromForm,
  formatDisplayDate,
  formatDisplayTime,
  getTimeSlots,
  initialAppointments,
  providers,
  statusLabel,
  statusTone,
  type Appointment,
} from "@/lib/canonical-ehr/scheduling";

const sampleDraft = createAppointmentFromForm({
  patientName: "New Intake Patient",
  providerId: providers[0]?.id ?? "prov-lena",
  type: "Intake",
  date: new Date().toISOString().slice(0, 10),
  startTime: "15:00",
  durationMinutes: 60,
  location: "Telehealth",
  recurrence: "none",
  recurrenceCount: 1,
  notes: "Created from scheduling form engine preview.",
  sendReminder: true,
});

const statusCounts = countStatuses(initialAppointments);
const slotCount = getTimeSlots(8, 18).length;

function toneStyle(appointment: Appointment) {
  const tone = statusTone(appointment.status);
  if (tone === "green") return { borderColor: "#1d7f49", background: "#eef9f1" };
  if (tone === "amber") return { borderColor: "#b7791f", background: "#fff8e8" };
  if (tone === "red") return { borderColor: "#c53030", background: "#fff0f0" };
  if (tone === "blue") return { borderColor: "#2b6cb0", background: "#eef4ff" };
  return { borderColor: "#5c6e82", background: "#f5f7f9" };
}

export default function CalendarPage() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Calendar</p>
          <h1>Scheduling Workspace</h1>
          <p className="hero-copy">
            Manage today&apos;s schedule, check-in readiness, eligibility context, and visit handoffs from one calendar-first home screen.
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button" href="/clinician/agenda">Open Agenda View</Link>
          <Link className="button button-secondary" href="/clients">Schedule Appointment</Link>
          <Link className="button button-secondary" href="/chart-room">Chart Room</Link>
        </div>
      </section>

      <section className="metric-grid">
        <article className="metric-card"><span>Scheduled</span><strong>{statusCounts.scheduled}</strong></article>
        <article className="metric-card"><span>Checked In</span><strong>{statusCounts.checkedIn}</strong></article>
        <article className="metric-card"><span>Completed</span><strong>{statusCounts.completed}</strong></article>
        <article className="metric-card"><span>Slots (8a-6p)</span><strong>{slotCount}</strong></article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Today&apos;s Schedule Engine</h2>
            <p>Backed by canonical scheduling helpers in lib/canonical-ehr/scheduling.ts.</p>
          </div>
          <Link className="button button-secondary" href="/clinician/agenda">Open Full Agenda</Link>
        </div>
        <div className="stack-list">
          {initialAppointments.map((appointment) => (
            <article className="stack-item" key={appointment.id} style={toneStyle(appointment)}>
              <div className="stack-row">
                <div>
                  <strong>{appointment.patientName}</strong>
                  <span>{formatDisplayDate(appointment.start)} · {formatDisplayTime(appointment.start)}-{formatDisplayTime(appointment.end)}</span>
                  <span>{appointment.type} · {appointment.location} · {statusLabel(appointment.status)}</span>
                </div>
                <div className="section-actions">
                  <Link className="button button-secondary" href="/clinician/agenda">Open Appointment</Link>
                  {appointmentCanCreateEncounter(appointment) ? <Link className="button" href="/chart-room">Start Encounter</Link> : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="chart-grid">
        <article className="panel">
          <h2>Provider Capacity</h2>
          <div className="detail-list">
            {providers.map((provider) => (
              <p key={provider.id}><strong>{provider.name}</strong> ({provider.credentials}) · {provider.location}</p>
            ))}
          </div>
        </article>
        <article className="panel">
          <h2>New Appointment Draft Preview</h2>
          <div className="detail-list">
            <p><strong>Patient:</strong> {sampleDraft.patientName}</p>
            <p><strong>Provider:</strong> {providers.find((provider) => provider.id === sampleDraft.providerId)?.name ?? sampleDraft.providerId}</p>
            <p><strong>Time:</strong> {formatDisplayDate(sampleDraft.start)} {formatDisplayTime(sampleDraft.start)}</p>
            <p><strong>CPT Default:</strong> {sampleDraft.defaultCpt}</p>
          </div>
        </article>
      </section>
    </main>
  );
}
