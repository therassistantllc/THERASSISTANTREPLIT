import type {
  CanonicalEhrState,
  Claim,
  ClaimServiceLine,
  ClaimStatusEvent,
  ClaimSubmission,
  ClinicalNote,
  Encounter,
  EncounterServiceLine,
  EligibilityCheck,
  EraClaimPayment,
  EraFile,
  EraLinePayment,
  ID,
  SupportTicket,
  TicketMessage,
  WorkqueueItem,
} from "./types";
import { BILLER_USER_ID, CURRENT_USER_ID, ORG_ID } from "./seed";

export function makeId(prefix: string): ID {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function dateOnly(value: string): string {
  return value.slice(0, 10);
}

export function patientName(state: CanonicalEhrState, patientId: ID | null): string {
  if (!patientId) return "No patient";
  const patient = state.patients.find((item) => item.id === patientId);
  return patient ? `${patient.preferred_name || patient.first_name} ${patient.last_name}` : "Unknown patient";
}

export function userName(state: CanonicalEhrState, userId: ID | null): string {
  if (!userId) return "Unassigned";
  const user = state.users.find((item) => item.id === userId);
  return user ? `${user.full_name}${user.credentials ? `, ${user.credentials}` : ""}` : "Unknown user";
}

export function payerName(state: CanonicalEhrState, payerId: ID | null): string {
  if (!payerId) return "No payer";
  return state.payers.find((item) => item.id === payerId)?.payer_name ?? "Unknown payer";
}

export function getPrimaryPolicy(state: CanonicalEhrState, patientId: ID) {
  return state.insurance_policies.find((item) => item.patient_id === patientId && item.priority === 1) ?? null;
}

export function latestEligibility(state: CanonicalEhrState, patientId: ID): EligibilityCheck | null {
  const checks = state.eligibility_checks
    .filter((item) => item.patient_id === patientId)
    .sort((a, b) => b.checked_at.localeCompare(a.checked_at));
  return checks[0] ?? null;
}

export function getEncounterReadiness(state: CanonicalEhrState, encounterId: ID) {
  const encounter = state.encounters.find((item) => item.id === encounterId) ?? null;
  const note = state.clinical_notes.find((item) => item.encounter_id === encounterId) ?? null;
  const diagnoses = state.encounter_diagnoses.filter((item) => item.encounter_id === encounterId);
  const serviceLines = state.encounter_service_lines.filter((item) => item.encounter_id === encounterId);
  const patientId = encounter?.patient_id ?? "";
  const policy = patientId ? getPrimaryPolicy(state, patientId) : null;
  const eligibility = patientId ? latestEligibility(state, patientId) : null;
  const treatmentLink = state.encounter_treatment_plan_links.find((item) => item.encounter_id === encounterId) ?? null;
  const checks = [
    {
      key: "encounter",
      label: "Encounter exists",
      passed: Boolean(encounter),
      detail: "Encounter is the locked clinical and billing source of truth.",
    },
    {
      key: "note",
      label: "Clinical note signed",
      passed: Boolean(note?.locked && note.signed_at),
      detail: "Signed notes are locked; changes must be addendums.",
    },
    {
      key: "diagnosis",
      label: "Diagnosis pointer present",
      passed: diagnoses.length > 0 && diagnoses.some((item) => item.is_primary),
      detail: "Do not store diagnosis only inside note text.",
    },
    {
      key: "service_line",
      label: "Billable service line present",
      passed: serviceLines.length > 0 && serviceLines.every((item) => item.charge_amount > 0 && item.minutes > 0),
      detail: "Encounter service lines are the bridge from documentation to claim.",
    },
    {
      key: "policy",
      label: "Insurance policy attached",
      passed: Boolean(policy),
      detail: "Claim should not be created without primary coverage or an intentional self-pay path.",
    },
    {
      key: "eligibility",
      label: "Eligibility check active",
      passed: Boolean(eligibility?.eligibility_status === "active"),
      detail: "270/271 result must be stored in eligibility_checks and visible across scheduling, chart, and billing.",
    },
    {
      key: "treatment_plan",
      label: "Treatment goal linked",
      passed: Boolean(treatmentLink),
      detail: "Each psychotherapy encounter should show which goal was addressed.",
    },
    {
      key: "documentation_support",
      label: "Code supported by documentation",
      passed: serviceLines.length > 0 && serviceLines.every((item) => item.documentation_support_status === "supported"),
      detail: "CPT support should read from encounter_service_lines, not separate coding screens.",
    },
  ];
  return {
    encounter,
    note,
    diagnoses,
    serviceLines,
    policy,
    eligibility,
    treatmentLink,
    checks,
    passed: checks.every((item) => item.passed),
  };
}

export function addAudit(state: CanonicalEhrState, entityType: string, entityId: ID, action: "view" | "create" | "update" | "delete" | "sign" | "submit" | "export", afterData: Record<string, unknown>): CanonicalEhrState {
  return {
    ...state,
    audit_logs: [
      {
        id: makeId("audit"),
        organization_id: ORG_ID,
        user_id: CURRENT_USER_ID,
        entity_type: entityType,
        entity_id: entityId,
        action,
        before_data: null,
        after_data: afterData,
        ip_address: "127.0.0.1",
        user_agent: "Therassistant canonical UI",
        created_at: isoNow(),
      },
      ...state.audit_logs,
    ],
  };
}

function closeWorkqueueItemsForEncounter(state: CanonicalEhrState, encounterId: ID, queueType?: string): WorkqueueItem[] {
  return state.workqueue_items.map((item) => {
    const matchesEncounter = item.encounter_id === encounterId;
    const matchesType = queueType ? item.queue_type === queueType : true;
    if (!matchesEncounter || !matchesType || item.status === "resolved" || item.status === "closed") return item;
    return {
      ...item,
      status: "resolved",
      resolution_note: "Resolved automatically by canonical workflow.",
      updated_at: isoNow(),
    };
  });
}

export function checkEligibilityForAppointment(state: CanonicalEhrState, appointmentId: ID): CanonicalEhrState {
  const appointment = state.appointments.find((item) => item.id === appointmentId);
  if (!appointment) return state;
  const policy = state.insurance_policies.find((item) => item.id === appointment.insurance_policy_id);
  if (!policy) return state;
  const eligibility: EligibilityCheck = {
    id: makeId("elig"),
    patient_id: appointment.patient_id,
    insurance_policy_id: policy.id,
    payer_id: policy.payer_id,
    service_type_code: "98",
    request_control_number: `270-${Date.now()}`,
    response_control_number: `271-${Date.now()}`,
    eligibility_status: "active",
    copay_amount: 0,
    deductible_amount: 0,
    deductible_remaining: 0,
    coinsurance_percent: 0,
    effective_date: policy.effective_date,
    termination_date: policy.termination_date,
    raw_270: { transaction: "270", policy_id: policy.id },
    raw_271: { transaction: "271", eligibility_status: "active" },
    checked_at: isoNow(),
    checked_by: CURRENT_USER_ID,
  };
  const nextState: CanonicalEhrState = {
    ...state,
    eligibility_checks: [eligibility, ...state.eligibility_checks],
    appointments: state.appointments.map((item) =>
      item.id === appointment.id ? { ...item, eligibility_check_id: eligibility.id, updated_at: isoNow() } : item
    ),
  };
  return addAudit(nextState, "eligibility_check", eligibility.id, "create", { appointment_id: appointment.id, transaction: "270/271" });
}

export function startEncounterFromAppointment(state: CanonicalEhrState, appointmentId: ID): CanonicalEhrState {
  const appointment = state.appointments.find((item) => item.id === appointmentId);
  if (!appointment) return state;
  const existing = state.encounters.find((item) => item.appointment_id === appointmentId);
  if (existing) return state;

  const encounterId = makeId("enc");
  const noteId = makeId("note");
  const serviceLineId = makeId("esl");
  const encounter: Encounter = {
    id: encounterId,
    organization_id: appointment.organization_id,
    patient_id: appointment.patient_id,
    appointment_id: appointment.id,
    clinician_id: appointment.clinician_id,
    supervisor_id: null,
    date_of_service: dateOnly(appointment.scheduled_start),
    start_time: appointment.scheduled_start,
    end_time: appointment.scheduled_end,
    duration_minutes: Math.max(1, Math.round((new Date(appointment.scheduled_end).getTime() - new Date(appointment.scheduled_start).getTime()) / 60000)),
    place_of_service_code: "10",
    service_location: "Telehealth; client located in Colorado",
    encounter_status: "draft",
    documentation_status: "in_progress",
    billing_status: "hold",
    primary_diagnosis_code: appointment.patient_id === "pat-sofia" ? "F43.23" : "F41.1",
    medical_necessity_summary: "Clinical documentation should support medical necessity, functional impairment, intervention, response, risk, and next steps.",
    created_at: isoNow(),
    updated_at: isoNow(),
  };
  const note: ClinicalNote = {
    id: noteId,
    encounter_id: encounterId,
    note_type: "progress",
    note_format: "dap",
    subjective: "Client presentation and subjective report documented during session.",
    objective: "Mental status, engagement, modality, and service location documented.",
    assessment: "Clinical assessment and medical necessity documented.",
    plan: "Plan and follow-up documented.",
    interventions: "Psychotherapy interventions documented.",
    client_response: "Client response documented.",
    risk_assessment: "Risk screen completed. No imminent risk documented in this seed workflow.",
    progress_toward_goals: "Progress toward active treatment plan goals documented.",
    next_steps: "Continue plan and review next appointment.",
    signed_by: null,
    signed_at: null,
    locked: false,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
  const dx = {
    id: makeId("dx"),
    encounter_id: encounterId,
    diagnosis_code: encounter.primary_diagnosis_code,
    diagnosis_description: appointment.patient_id === "pat-sofia" ? "Adjustment disorder with mixed anxiety and depressed mood" : "Generalized anxiety disorder",
    diagnosis_order: 1,
    is_primary: true,
  };
  const serviceLine: EncounterServiceLine = {
    id: serviceLineId,
    encounter_id: encounterId,
    code_type: "CPT",
    procedure_code: appointment.appointment_type.includes("90837") ? "90837" : "90834",
    modifier_1: "95",
    modifier_2: "",
    modifier_3: "",
    modifier_4: "",
    units: 1,
    minutes: encounter.duration_minutes,
    charge_amount: appointment.appointment_type.includes("90837") ? 165 : 125,
    diagnosis_pointer: "A",
    documentation_support_status: "needs_review",
    billing_status: "hold",
    created_at: isoNow(),
    updated_at: isoNow(),
  };
  const wq: WorkqueueItem = {
    id: makeId("wq"),
    organization_id: appointment.organization_id,
    patient_id: appointment.patient_id,
    encounter_id: encounterId,
    claim_id: null,
    professional_claim_id: null,
    payer_id: state.insurance_policies.find((item) => item.id === appointment.insurance_policy_id)?.payer_id ?? null,
    queue_type: "documentation_hold",
    priority: "normal",
    status: "open",
    title: "Documentation hold",
    description: "Encounter created from appointment. Clinical note must be signed before billing.",
    assigned_to: appointment.clinician_id,
    due_date: dateOnly(appointment.scheduled_start),
    defer_until: null,
    resolution_note: null,
    created_at: isoNow(),
    updated_at: isoNow(),
  };

  const nextState: CanonicalEhrState = {
    ...state,
    appointments: state.appointments.map((item) => (item.id === appointment.id ? { ...item, status: "completed", updated_at: isoNow() } : item)),
    encounters: [encounter, ...state.encounters],
    clinical_notes: [note, ...state.clinical_notes],
    encounter_diagnoses: [dx, ...state.encounter_diagnoses],
    encounter_service_lines: [serviceLine, ...state.encounter_service_lines],
    workqueue_items: [wq, ...state.workqueue_items],
    workqueue_events: [
      {
        id: makeId("wqe"),
        workqueue_item_id: wq.id,
        event_type: "created",
        note: "Encounter started from appointment.",
        created_by: CURRENT_USER_ID,
        created_at: isoNow(),
      },
      ...state.workqueue_events,
    ],
  };
  return addAudit(nextState, "encounter", encounterId, "create", { appointment_id: appointment.id });
}

export function signClinicalNote(state: CanonicalEhrState, encounterId: ID): CanonicalEhrState {
  const now = isoNow();
  const serviceLines = state.encounter_service_lines.map((item) =>
    item.encounter_id === encounterId
      ? { ...item, documentation_support_status: "supported" as const, billing_status: "ready" as const, updated_at: now }
      : item
  );
  let nextState: CanonicalEhrState = {
    ...state,
    clinical_notes: state.clinical_notes.map((item) =>
      item.encounter_id === encounterId
        ? { ...item, signed_by: CURRENT_USER_ID, signed_at: now, locked: true, updated_at: now }
        : item
    ),
    encounter_service_lines: serviceLines,
    encounters: state.encounters.map((item) =>
      item.id === encounterId
        ? { ...item, encounter_status: "signed", documentation_status: "signed", billing_status: "hold", updated_at: now }
        : item
    ),
    workqueue_items: closeWorkqueueItemsForEncounter(state, encounterId, "documentation_hold"),
  };
  nextState = addAudit(nextState, "clinical_note", encounterId, "sign", { locked: true });
  return autoRouteReadyEncounter(nextState, encounterId);
}

export function addAddendum(state: CanonicalEhrState, encounterId: ID, message: string): CanonicalEhrState {
  const note: ClinicalNote = {
    id: makeId("note-addendum"),
    encounter_id: encounterId,
    note_type: "addendum",
    note_format: "narrative",
    subjective: "",
    objective: "",
    assessment: message,
    plan: "",
    interventions: "",
    client_response: "",
    risk_assessment: "",
    progress_toward_goals: "",
    next_steps: "",
    signed_by: CURRENT_USER_ID,
    signed_at: isoNow(),
    locked: true,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
  return addAudit({ ...state, clinical_notes: [note, ...state.clinical_notes] }, "clinical_note", note.id, "create", { type: "addendum" });
}

export function autoRouteReadyEncounter(state: CanonicalEhrState, encounterId: ID): CanonicalEhrState {
  const readiness = getEncounterReadiness(state, encounterId);
  const encounter = readiness.encounter;
  if (!encounter) return state;
  if (!readiness.passed) {
    const hold: WorkqueueItem = {
      id: makeId("wq"),
      organization_id: encounter.organization_id,
      patient_id: encounter.patient_id,
      encounter_id: encounter.id,
      claim_id: null,
      professional_claim_id: null,
      payer_id: readiness.policy?.payer_id ?? null,
      queue_type: "documentation_hold",
      priority: "high",
      status: "open",
      title: "Documentation audit failed",
      description: readiness.checks.filter((item) => !item.passed).map((item) => item.label).join(", "),
      assigned_to: encounter.clinician_id,
      due_date: encounter.date_of_service,
      defer_until: null,
      resolution_note: null,
      created_at: isoNow(),
      updated_at: isoNow(),
    };
    return {
      ...state,
      encounters: state.encounters.map((item) => (item.id === encounter.id ? { ...item, billing_status: "hold", updated_at: isoNow() } : item)),
      workqueue_items: [hold, ...state.workqueue_items],
    };
  }
  const existingReady = state.workqueue_items.some(
    (item) => item.encounter_id === encounter.id && item.queue_type === "ready_to_bill" && item.status !== "closed" && item.status !== "resolved"
  );
  const readyItem: WorkqueueItem = {
    id: makeId("wq"),
    organization_id: encounter.organization_id,
    patient_id: encounter.patient_id,
    encounter_id: encounter.id,
    claim_id: null,
    professional_claim_id: null,
    payer_id: readiness.policy?.payer_id ?? null,
    queue_type: "ready_to_bill",
    priority: "normal",
    status: "open",
    title: "Encounter ready for billing scrub",
    description: "Signed note, active eligibility, diagnosis, service line, and treatment goal are present. Biller must scrub before claim creation.",
    assigned_to: BILLER_USER_ID,
    due_date: encounter.date_of_service,
    defer_until: null,
    resolution_note: null,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
  const nextState: CanonicalEhrState = {
    ...state,
    encounters: state.encounters.map((item) =>
      item.id === encounter.id ? { ...item, encounter_status: "ready_to_bill", billing_status: "ready", updated_at: isoNow() } : item
    ),
    workqueue_items: existingReady ? state.workqueue_items : [readyItem, ...state.workqueue_items],
    workqueue_events: existingReady
      ? state.workqueue_events
      : [
          {
            id: makeId("wqe"),
            workqueue_item_id: readyItem.id,
            event_type: "created",
            note: "Automatically routed to billing workqueue after signed documentation passed readiness audit.",
            created_by: CURRENT_USER_ID,
            created_at: isoNow(),
          },
          ...state.workqueue_events,
        ],
  };
  return addAudit(nextState, "workqueue_item", readyItem.id, "create", { queue_type: "ready_to_bill" });
}

export function routeToBiller(state: CanonicalEhrState, encounterId: ID, category: SupportTicket["category"], priority: SupportTicket["priority"], message: string): CanonicalEhrState {
  const encounter = state.encounters.find((item) => item.id === encounterId);
  if (!encounter) return state;
  const ticket: SupportTicket = {
    id: makeId("ticket"),
    organization_id: encounter.organization_id,
    patient_id: encounter.patient_id,
    encounter_id: encounter.id,
    claim_id: null,
    category,
    subject: "Clinician routed encounter to biller",
    description: message,
    status: "open",
    priority,
    created_by: CURRENT_USER_ID,
    assigned_to: BILLER_USER_ID,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
  const ticketMessage: TicketMessage = {
    id: makeId("ticket-message"),
    ticket_id: ticket.id,
    sender_id: CURRENT_USER_ID,
    message_body: message,
    internal_only: true,
    created_at: isoNow(),
  };
  const wq: WorkqueueItem = {
    id: makeId("wq"),
    organization_id: encounter.organization_id,
    patient_id: encounter.patient_id,
    encounter_id: encounter.id,
    claim_id: null,
    professional_claim_id: null,
    payer_id: getPrimaryPolicy(state, encounter.patient_id)?.payer_id ?? null,
    queue_type: "biller_review",
    priority,
    status: "open",
    title: `Biller review requested: ${category}`,
    description: message,
    assigned_to: BILLER_USER_ID,
    due_date: encounter.date_of_service,
    defer_until: null,
    resolution_note: null,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
  return addAudit(
    {
      ...state,
      support_tickets: [ticket, ...state.support_tickets],
      ticket_messages: [ticketMessage, ...state.ticket_messages],
      workqueue_items: [wq, ...state.workqueue_items],
    },
    "support_ticket",
    ticket.id,
    "create",
    { category, priority }
  );
}

export function scrubWorkqueueItem(state: CanonicalEhrState, workqueueItemId: ID): CanonicalEhrState {
  return addAudit(
    {
      ...state,
      workqueue_items: state.workqueue_items.map((item) =>
        item.id === workqueueItemId
          ? { ...item, status: "in_progress", description: `${item.description}\n\nScrub passed: demographics, payer, CPT, diagnosis pointer, POS, charge, and documentation support reviewed.`, updated_at: isoNow() }
          : item
      ),
      workqueue_events: [
        {
          id: makeId("wqe"),
          workqueue_item_id: workqueueItemId,
          event_type: "status_changed",
          note: "Billing scrub passed. Claim creation is allowed.",
          created_by: BILLER_USER_ID,
          created_at: isoNow(),
        },
        ...state.workqueue_events,
      ],
    },
    "workqueue_item",
    workqueueItemId,
    "update",
    { scrub: "passed" }
  );
}

export function createClaimFromEncounter(state: CanonicalEhrState, encounterId: ID): CanonicalEhrState {
  const encounter = state.encounters.find((item) => item.id === encounterId);
  if (!encounter) return state;
  const existing = state.claims.find((item) => item.encounter_id === encounterId);
  if (existing) return state;
  const policy = getPrimaryPolicy(state, encounter.patient_id);
  if (!policy) return state;
  const serviceLines = state.encounter_service_lines.filter((item) => item.encounter_id === encounterId);
  const claimId = makeId("claim");
  const total = serviceLines.reduce((sum, item) => sum + item.charge_amount, 0);
  const claim: Claim = {
    id: claimId,
    organization_id: encounter.organization_id,
    patient_id: encounter.patient_id,
    encounter_id: encounter.id,
    payer_id: policy.payer_id,
    insurance_policy_id: policy.id,
    claim_number: `CLM-${Date.now()}`,
    clearinghouse_trace_id: null,
    payer_claim_control_number: null,
    claim_type: "837P",
    claim_status: "draft",
    total_charge_amount: total,
    total_paid_amount: 0,
    total_adjustment_amount: 0,
    patient_responsibility_amount: 0,
    submission_date: null,
    accepted_date: null,
    adjudicated_date: null,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
  const claimServiceLines: ClaimServiceLine[] = serviceLines.map((line, index) => ({
    id: makeId("csl"),
    claim_id: claimId,
    encounter_service_line_id: line.id,
    line_number: index + 1,
    procedure_code: line.procedure_code,
    modifiers: [line.modifier_1, line.modifier_2, line.modifier_3, line.modifier_4].filter(Boolean),
    units: line.units,
    charge_amount: line.charge_amount,
    allowed_amount: 0,
    paid_amount: 0,
    adjustment_amount: 0,
    patient_responsibility_amount: 0,
    service_date: encounter.date_of_service,
    place_of_service_code: encounter.place_of_service_code,
    line_status: "submitted",
  }));
  const nextState: CanonicalEhrState = {
    ...state,
    claims: [claim, ...state.claims],
    claim_service_lines: [...claimServiceLines, ...state.claim_service_lines],
    encounters: state.encounters.map((item) =>
      item.id === encounter.id ? { ...item, encounter_status: "billed", billing_status: "claim_created", updated_at: isoNow() } : item
    ),
    workqueue_items: state.workqueue_items.map((item) =>
      item.encounter_id === encounter.id && ["ready_to_bill", "biller_review"].includes(item.queue_type)
        ? { ...item, claim_id: claimId, status: "resolved", resolution_note: "Claim created from encounter.", updated_at: isoNow() }
        : item
    ),
  };
  return addAudit(nextState, "claim", claim.id, "create", { source: "encounter", transaction: "837P draft" });
}

export function submitClaim(state: CanonicalEhrState, claimId: ID): CanonicalEhrState {
  const claim = state.claims.find((item) => item.id === claimId);
  if (!claim) return state;
  const submission: ClaimSubmission = {
    id: makeId("sub"),
    claim_id: claim.id,
    transaction_type: "837P",
    submission_method: "office_ally",
    batch_id: null,
    control_number: `837P-${Date.now()}`,
    raw_837: { claim_id: claim.id, transaction: "837P" },
    edi_payload: `ISA*00*          *00*          *ZZ*THERASSISTANT   *ZZ*CLEARINGHOUSE  *260428*1200*^*00501*000000001*0*T*:~ST*837*0001*005010X222A1~BHT*0019*00*${claim.claim_number}*20260428*1200*CH~SE*3*0001~`,
    response_status: "submitted",
    submitted_at: isoNow(),
    submitted_by: BILLER_USER_ID,
  };
  const status: ClaimStatusEvent = {
    id: makeId("cse"),
    claim_id: claim.id,
    source: "clearinghouse",
    transaction_type: "999",
    status_code: "A",
    status_text: "999 acknowledgment accepted",
    event_at: isoNow(),
    raw_event: { transaction: "999", accepted: true },
  };
  return addAudit(
    {
      ...state,
      claims: state.claims.map((item) =>
        item.id === claim.id ? { ...item, claim_status: "submitted", submission_date: isoNow(), clearinghouse_trace_id: submission.control_number, updated_at: isoNow() } : item
      ),
      encounters: state.encounters.map((item) => (item.id === claim.encounter_id ? { ...item, billing_status: "submitted", updated_at: isoNow() } : item)),
      claim_submissions: [submission, ...state.claim_submissions],
      claim_status_events: [status, ...state.claim_status_events],
    },
    "claim_submission",
    submission.id,
    "submit",
    { transaction: "837P" }
  );
}

export function setClaimStatus(state: CanonicalEhrState, claimId: ID, status: Claim["claim_status"]): CanonicalEhrState {
  const claim = state.claims.find((item) => item.id === claimId);
  if (!claim) return state;
  const event: ClaimStatusEvent = {
    id: makeId("cse"),
    claim_id: claimId,
    source: "clearinghouse",
    transaction_type: status === "accepted" ? "277CA" : "277",
    status_code: status.toUpperCase(),
    status_text: `Claim ${status}`,
    event_at: isoNow(),
    raw_event: { status },
  };
  const createQueue = ["rejected", "denied"].includes(status);
  const queue: WorkqueueItem | null = createQueue
    ? {
        id: makeId("wq"),
        organization_id: claim.organization_id,
        patient_id: claim.patient_id,
        encounter_id: claim.encounter_id,
        claim_id: claim.id,
        professional_claim_id: null,
        payer_id: claim.payer_id,
        queue_type: status === "rejected" ? "rejection" : "denial",
        priority: "high",
        status: "open",
        title: status === "rejected" ? "Claim rejected" : "Claim denied",
        description: `Claim moved to ${status}. Review status events, service lines, and payer response.`,
        assigned_to: BILLER_USER_ID,
        due_date: dateOnly(isoNow()),
        defer_until: null,
        resolution_note: null,
        created_at: isoNow(),
        updated_at: isoNow(),
      }
    : null;
  return addAudit(
    {
      ...state,
      claims: state.claims.map((item) => (item.id === claimId ? { ...item, claim_status: status, updated_at: isoNow() } : item)),
      encounters: state.encounters.map((item) =>
        item.id === claim.encounter_id ? { ...item, billing_status: status === "paid" ? "paid" : status === "denied" ? "denied" : item.billing_status, updated_at: isoNow() } : item
      ),
      claim_status_events: [event, ...state.claim_status_events],
      workqueue_items: queue ? [queue, ...state.workqueue_items] : state.workqueue_items,
    },
    "claim",
    claimId,
    "update",
    { claim_status: status }
  );
}

export function importEraAndPostPayment(state: CanonicalEhrState, claimId: ID): CanonicalEhrState {
  const claim = state.claims.find((item) => item.id === claimId);
  if (!claim) return state;
  const claimLines = state.claim_service_lines.filter((item) => item.claim_id === claimId);
  const paid = Math.round(claim.total_charge_amount * 0.78 * 100) / 100;
  const adjustment = Math.round((claim.total_charge_amount - paid) * 100) / 100;
  const eraFile: EraFile = {
    id: makeId("era"),
    organization_id: claim.organization_id,
    payer_id: claim.payer_id,
    file_name: `835-${claim.claim_number}.edi`,
    trace_number: `TRN-${Date.now()}`,
    raw_835: { transaction: "835", claim_id: claim.id },
    imported_at: isoNow(),
    imported_by: BILLER_USER_ID,
  };
  const eraClaim: EraClaimPayment = {
    id: makeId("ecp"),
    era_file_id: eraFile.id,
    claim_id: claim.id,
    payer_claim_control_number: `PCCN-${Date.now()}`,
    billed_amount: claim.total_charge_amount,
    paid_amount: paid,
    patient_responsibility_amount: 0,
    claim_status_code: "1",
    posted: true,
    posted_at: isoNow(),
  };
  const linePayments: EraLinePayment[] = claimLines.map((line) => ({
    id: makeId("elp"),
    era_claim_payment_id: eraClaim.id,
    claim_service_line_id: line.id,
    procedure_code: line.procedure_code,
    billed_amount: line.charge_amount,
    allowed_amount: line.charge_amount,
    paid_amount: Math.round(line.charge_amount * 0.78 * 100) / 100,
    adjustment_amount: Math.round(line.charge_amount * 0.22 * 100) / 100,
    patient_responsibility_amount: 0,
  }));
  return addAudit(
    {
      ...state,
      claims: state.claims.map((item) =>
        item.id === claim.id
          ? {
              ...item,
              claim_status: "paid",
              total_paid_amount: paid,
              total_adjustment_amount: adjustment,
              patient_responsibility_amount: 0,
              adjudicated_date: isoNow(),
              updated_at: isoNow(),
            }
          : item
      ),
      encounters: state.encounters.map((item) => (item.id === claim.encounter_id ? { ...item, billing_status: "paid", updated_at: isoNow() } : item)),
      era_files: [eraFile, ...state.era_files],
      era_claim_payments: [eraClaim, ...state.era_claim_payments],
      era_line_payments: [...linePayments, ...state.era_line_payments],
      claim_service_lines: state.claim_service_lines.map((item) =>
        item.claim_id === claim.id
          ? {
              ...item,
              line_status: "paid",
              allowed_amount: item.charge_amount,
              paid_amount: Math.round(item.charge_amount * 0.78 * 100) / 100,
              adjustment_amount: Math.round(item.charge_amount * 0.22 * 100) / 100,
            }
          : item
      ),
    },
    "era_file",
    eraFile.id,
    "create",
    { transaction: "835", posted: true }
  );
}
