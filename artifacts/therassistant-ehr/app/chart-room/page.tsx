import Link from "next/link";
import { startAppointmentEncounter } from "@/lib/appointments/startEncounter";
import {
  createClaimFromEncounter,
  evaluateEncounterReadiness,
  routeEncounterToBiller,
  scrubEncounterForClaim,
  signClinicalNote,
  startEncounterFromAppointment,
  submitClaim,
} from "@/lib/ehr/pipeline";
import { executeCompleteWorkflow } from "@/lib/workflow/workflowActions";
import {
  createClaim,
  createEncounter,
  createNote,
  postPayment,
  submitClaim as workflowSubmitClaim,
} from "@/lib/workflow/workflowFunctions";

const clinicalPipelineFunctions = [
  startEncounterFromAppointment,
  signClinicalNote,
  evaluateEncounterReadiness,
  routeEncounterToBiller,
  scrubEncounterForClaim,
  createClaimFromEncounter,
  submitClaim,
];

const workflowAutomationFunctions = [
  executeCompleteWorkflow,
  createEncounter,
  createNote,
  createClaim,
  workflowSubmitClaim,
  postPayment,
];

export default function ChartRoomPage() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Clinical</p>
          <h1>Chart Room</h1>
          <p className="hero-copy">Open charts, complete encounter notes, and hand off to billing without leaving the clinical workflow.</p>
        </div>
        <div className="hero-actions">
          <Link className="button" href="/encounters/new">New Encounter</Link>
          <Link className="button button-secondary" href="/clinician/agenda">Open Agenda</Link>
          <Link className="button button-secondary" href="/billing/charge-capture">Charge Capture</Link>
        </div>
      </section>

      <section className="panel">
        <p style={{ color: "var(--text-secondary)" }}>
          Chart Room is your encounter hub. Open an existing encounter from the agenda, start a new note,
          then transition directly to billing details when documentation is complete.
        </p>
      </section>

      <section className="chart-grid">
        <article className="panel">
          <h2>Encounter Pipeline Engine</h2>
          <p className="muted">Surfaced from lib/ehr/pipeline.ts and appointment launcher helpers.</p>
          <div className="detail-list">
            <p><strong>Appointment launcher:</strong> {startAppointmentEncounter.name}</p>
            {clinicalPipelineFunctions.map((fn) => (
              <p key={fn.name}><strong>{fn.name}</strong> available for orchestration</p>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href="/clinician/agenda">Start From Appointment</Link>
            <Link className="button button-secondary" href="/encounters/new">Open Encounter Workspace</Link>
          </div>
        </article>
        <article className="panel">
          <h2>Workflow Automation Surface</h2>
          <p className="muted">Existing workflow action/functions are surfaced as orchestrated steps in the UI.</p>
          <div className="detail-list">
            {workflowAutomationFunctions.map((fn) => (
              <p key={fn.name}><strong>{fn.name}</strong> integrated as a workflow progression stage</p>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href="/billing/claim-submission">View Claim Submission Stages</Link>
          </div>
        </article>
      </section>
    </main>
  );
}
