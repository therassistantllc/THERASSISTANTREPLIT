import Link from "next/link";
import ClinicianAgendaClient from "./ClinicianAgendaClient";

export default function ClinicianAgendaPage() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Calendar</p>
          <h1>Today’s Agenda</h1>
          <p className="hero-copy">
            A clean visit-focused view for clinicians: schedule, check-in, eligibility, balance, and routing support.
            Billing logic stays behind the scenes.
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button" href="/clients">Schedule Appointment</Link>
          <Link className="button button-secondary" href="/calendar">Calendar Home</Link>
          <Link className="button button-secondary" href="/clinician/agenda">Refresh</Link>
        </div>
      </section>

      <ClinicianAgendaClient />
    </main>
  );
}
