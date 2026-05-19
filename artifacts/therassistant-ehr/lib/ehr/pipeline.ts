import { SupabaseClient } from "@supabase/supabase-js";
import { PipelineResult } from "./types";
import { mapLegacyClaimInputToProfessionalClaim } from "../claims/createProfessionalClaimFromLegacyInput";

function nowIso(): string {
  return new Date().toISOString();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function minutesBetween(start?: string | null, end?: string | null): number {
  if (!start || !end) return 0;
  const diff = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(diff) || diff <= 0) return 0;
  return Math.round(diff / 60000);
}

export async function startEncounterFromAppointment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  appointmentId: string
): Promise<PipelineResult> {
  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .select("*")
    .eq("id", appointmentId)
    .single();

  if (appointmentError || !appointment) {
    return { ok: false, appointmentId, message: "Appointment not found." };
  }

  const { data: existing } = await supabase
    .from("encounters")
    .select("*")
    .eq("appointment_id", appointmentId)
    .maybeSingle();

  if (existing) {
    return {
      ok: true,
      appointmentId,
      encounterId: existing.id,
      message: "Existing encounter opened for this appointment.",
    };
  }

  const start = appointment.scheduled_start_at ?? nowIso();
  const end = appointment.scheduled_end_at ?? null;
  const duration = minutesBetween(start, end) || 53;

  const { data: encounter, error: encounterError } = await supabase
    .from("encounters")
    .insert({
      organization_id: appointment.organization_id,
      client_id: appointment.client_id,
      appointment_id: appointment.id,
      provider_id: appointment.provider_id,
      service_date: start.slice(0, 10),
      started_at: start,
      ended_at: end,
      encounter_status: "draft",
      required_billing_fields_complete: duration >= 16,
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    .select("*")
    .single();

  if (encounterError || !encounter) {
    return { ok: false, appointmentId, message: encounterError?.message ?? "Could not create encounter." };
  }

  await supabase
    .from("appointments")
    .update({ appointment_status: "completed", updated_at: nowIso() })
    .eq("id", appointmentId);

  await supabase.from("encounter_notes").insert({
    organization_id: encounter.organization_id,
    encounter_id: encounter.id,
    status: "draft",
    provider_id: encounter.provider_id,
    client_id: encounter.client_id,
    created_at: nowIso(),
  });

  await supabase.from("encounter_diagnoses").insert({
    encounter_id: encounter.id,
    diagnosis_code: appointment.default_diagnosis_code ?? "F41.1",
    diagnosis_description: appointment.default_diagnosis_description ?? "Generalized anxiety disorder",
    diagnosis_order: 1,
    is_primary: true,
  });

  await supabase.from("encounter_service_lines").insert({
    organization_id: encounter.organization_id,
    encounter_id: encounter.id,
    service_date: start.slice(0, 10),
    sequence_number: 1,
    cpt_hcpcs_code: appointment.default_procedure_code ?? "90837",
    units: 1,
    charge_amount: appointment.default_charge_amount ?? 165,
    place_of_service_code: "11",
    rendering_provider_id: encounter.provider_id,
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  await supabase.from("audit_logs").insert({
    organization_id: appointment.organization_id,
    patient_id: appointment.client_id,
    appointment_id: appointment.id,
    encounter_id: encounter.id,
    event_type: "encounter_created_from_appointment",
    event_summary: "Encounter created from completed appointment.",
    created_at: nowIso(),
  });

  return {
    ok: true,
    appointmentId,
    encounterId: encounter.id,
    message: "Encounter created from appointment.",
  };
}

export async function signClinicalNote(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  encounterId: string,
  signedBy: string,
  _noteFields: Record<string, string>
): Promise<PipelineResult> {
  const { data: encounter, error: encounterError } = await supabase
    .from("encounters")
    .select("*")
    .eq("id", encounterId)
    .single();

  if (encounterError || !encounter) {
    return { ok: false, encounterId, message: "Encounter not found." };
  }

  const { data: note, error: noteError } = await supabase
    .from("encounter_notes")
    .select("*")
    .eq("encounter_id", encounterId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (noteError) {
    return { ok: false, encounterId, message: noteError.message };
  }

  const payload = {
    status: "signed",
    signed_at: nowIso(),
    provider_id: signedBy,
    client_id: encounter.client_id,
  };

  let noteId = note?.id as string | undefined;

  if (noteId) {
    const { error } = await supabase.from("encounter_notes").update(payload).eq("id", noteId);
    if (error) return { ok: false, encounterId, noteId, message: error.message };
  } else {
    const { data: inserted, error } = await supabase
      .from("encounter_notes")
      .insert({
        organization_id: encounter.organization_id,
        encounter_id: encounterId,
        ...payload,
        created_at: nowIso(),
      })
      .select("*")
      .single();
    if (error || !inserted) return { ok: false, encounterId, message: error?.message ?? "Could not create note." };
    noteId = inserted.id;
  }

  const readiness = await evaluateEncounterReadiness(supabase, encounterId);

  const encounterUpdate =
    readiness.missing.length === 0
      ? { encounter_status: "ready_to_bill", documentation_status: "signed", billing_status: "ready", updated_at: nowIso() }
      : { encounter_status: "in_review", documentation_status: "addendum_needed", billing_status: "hold", updated_at: nowIso() };

  await supabase.from("encounters").update(encounterUpdate).eq("id", encounterId);

  const queueType = readiness.missing.length === 0 ? "ready_to_bill" : "documentation_hold";
  const priority = readiness.missing.length === 0 ? "medium" : "high";

  const { data: queueItem } = await supabase
    .from("workqueue_items")
    .upsert(
      {
        organization_id: encounter.organization_id,
        client_id: encounter.client_id,
        appointment_id: encounter.appointment_id,
        encounter_id: encounterId,
        queue_type: queueType,
        ticket_type: queueType,
        priority,
        status: "open",
        title: readiness.missing.length === 0 ? "Encounter ready for billing scrub" : "Documentation hold",
        description:
          readiness.missing.length === 0
            ? "Signed documentation, diagnosis, service line, eligibility, and payer data passed readiness checks."
            : `Missing: ${readiness.missing.join(", ")}`,
        source: "system",
        updated_at: nowIso(),
      },
      { onConflict: "encounter_id,queue_type" }
    )
    .select("*")
    .maybeSingle();

  await supabase.from("audit_logs").insert({
    organization_id: encounter.organization_id,
    patient_id: encounter.client_id,
    appointment_id: encounter.appointment_id,
    encounter_id: encounterId,
    clinical_note_id: noteId,
    workqueue_item_id: queueItem?.id,
    event_type: "clinical_note_signed",
    event_summary: readiness.missing.length === 0 ? "Note signed and routed to billing workqueue." : "Note signed but readiness failed.",
    event_metadata: { missing: readiness.missing },
    created_at: nowIso(),
  });

  return {
    ok: readiness.missing.length === 0,
    encounterId,
    noteId,
    workqueueItemId: queueItem?.id,
    missing: readiness.missing,
    message:
      readiness.missing.length === 0
        ? "Note signed and encounter routed to billing workqueue."
        : "Note signed, but encounter is on documentation hold.",
  };
}

export async function evaluateEncounterReadiness(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  encounterId: string
): Promise<{ missing: string[] }> {
  const missing: string[] = [];

  const { data: encounter } = await supabase.from("encounters").select("*").eq("id", encounterId).single();
  const { data: note } = await supabase
    .from("encounter_notes")
    .select("*")
    .eq("encounter_id", encounterId)
    .eq("status", "signed")
    .maybeSingle();
  const { data: diagnoses } = await supabase.from("encounter_diagnoses").select("*").eq("encounter_id", encounterId);
  const { data: serviceLines } = await supabase.from("encounter_service_lines").select("*").eq("encounter_id", encounterId);
  const { data: policies } = encounter?.client_id
    ? await supabase.from("insurance_policies").select("*").eq("client_id", encounter.client_id).eq("priority", 1).limit(1)
    : { data: [] as Record<string, unknown>[] };

  if (!encounter) missing.push("encounter");
  if (!note) missing.push("signed clinical note");
  if (!diagnoses || diagnoses.length === 0) missing.push("diagnosis");
  if (!serviceLines || serviceLines.length === 0) missing.push("service line");
  if (!policies || policies.length === 0) missing.push("primary insurance policy");
  const encounterDuration = minutesBetween(encounter?.started_at, encounter?.ended_at);
  if (!encounterDuration || encounterDuration < 16) missing.push("billable duration");

  return { missing };
}

export async function routeEncounterToBiller(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  encounterId: string,
  message: string,
  ticketType: string,
  priority: string,
  createdBy: string
): Promise<PipelineResult> {
  const { data: encounter } = await supabase.from("encounters").select("*").eq("id", encounterId).single();

  if (!encounter) {
    return { ok: false, encounterId, message: "Encounter not found." };
  }

  const { data: item, error } = await supabase
    .from("workqueue_items")
    .insert({
      organization_id: encounter.organization_id,
      client_id: encounter.client_id,
      appointment_id: encounter.appointment_id,
      encounter_id: encounterId,
      queue_type: "billing_review",
      ticket_type: ticketType || "billing_question",
      priority: priority || "medium",
      status: "open",
      title: "Clinician routed encounter to billing",
      description: message || "Please review this encounter before billing.",
      source: "clinician",
      assigned_role: "biller",
      created_by: createdBy,
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    .select("*")
    .single();

  if (error || !item) {
    return { ok: false, encounterId, message: error?.message ?? "Could not create workqueue ticket." };
  }

  await supabase.from("audit_logs").insert({
    organization_id: encounter.organization_id,
    patient_id: encounter.client_id,
    appointment_id: encounter.appointment_id,
    encounter_id: encounterId,
    workqueue_item_id: item.id,
    event_type: "clinician_routed_to_biller",
    event_summary: message,
    created_at: nowIso(),
  });

  return { ok: true, encounterId, workqueueItemId: item.id, message: "Billing ticket created." };
}

export async function scrubEncounterForClaim(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  encounterId: string,
  scrubbedBy: string
): Promise<PipelineResult> {
  const readiness = await evaluateEncounterReadiness(supabase, encounterId);
  if (readiness.missing.length > 0) {
    return {
      ok: false,
      encounterId,
      missing: readiness.missing,
      message: `Cannot scrub. Missing: ${readiness.missing.join(", ")}`,
    };
  }

  const { data: encounter } = await supabase.from("encounters").select("*").eq("id", encounterId).single();
  if (!encounter) return { ok: false, encounterId, message: "Encounter not found." };

  await supabase
    .from("encounters")
    .update({ billing_status: "scrubbed", updated_at: nowIso() })
    .eq("id", encounterId);

  await supabase
    .from("encounter_service_lines")
    .update({ documentation_support_status: "supported", billing_status: "ready", updated_at: nowIso() })
    .eq("encounter_id", encounterId);

  await supabase
    .from("workqueue_items")
    .update({ status: "resolved", resolved_at: nowIso(), resolved_by: scrubbedBy, updated_at: nowIso() })
    .eq("encounter_id", encounterId)
    .eq("queue_type", "ready_to_bill");

  await supabase.from("audit_logs").insert({
    organization_id: encounter.organization_id,
    patient_id: encounter.client_id,
    appointment_id: encounter.appointment_id,
    encounter_id: encounterId,
    event_type: "billing_scrub_passed",
    event_summary: "Billing scrub passed. Claim may be created.",
    created_at: nowIso(),
  });

  return { ok: true, encounterId, message: "Billing scrub passed." };
}

export async function createClaimFromEncounter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  encounterId: string
): Promise<PipelineResult> {
  const { data: encounter } = await supabase.from("encounters").select("*").eq("id", encounterId).single();
  if (!encounter) return { ok: false, encounterId, message: "Encounter not found." };

  if (encounter.billing_status !== "scrubbed" && encounter.billing_status !== "ready") {
    return { ok: false, encounterId, message: "Encounter must be scrubbed or ready before claim creation." };
  }

  const { data: existing } = await supabase.from("professional_claims").select("*").eq("encounter_id", encounterId).maybeSingle();
  if (existing) {
    return { ok: true, encounterId, claimId: existing.id, message: "Existing claim opened." };
  }

  const { data: lines } = await supabase.from("encounter_service_lines").select("*").eq("encounter_id", encounterId);
  const total = (lines ?? []).reduce((sum, line) => sum + Number(line.charge_amount ?? 0), 0);

  const claimNumber = `CLM-${Date.now().toString().slice(-8)}`;

  const mappedClaim = mapLegacyClaimInputToProfessionalClaim({
    organization_id: encounter.organization_id,
    client_id: encounter.client_id,
    encounter_id: encounterId,
    claim_number: claimNumber,
    claim_status: "draft",
    total_charge_amount: total,
  });

  const { data: claim, error } = await supabase
    .from("professional_claims")
    .insert(mappedClaim)
    .select("*")
    .single();

  if (error || !claim) return { ok: false, encounterId, message: error?.message ?? "Could not create claim." };

  let lineNumber = 1;
  for (const line of lines ?? []) {
    const sequenceNumber = lineNumber;

    await supabase.from("claim_service_lines").insert({
      claim_id: claim.id,
      encounter_service_line_id: line.id,
      sequence_number: sequenceNumber,
      cpt_hcpcs_code: line.cpt_hcpcs_code,
      units: line.units,
      charge_amount: line.charge_amount,
      service_date: encounter.service_date ?? todayIso(),
      place_of_service_code: line.place_of_service_code ?? "11",
    });

    lineNumber += 1;
  }

  await supabase.from("encounters").update({ billing_status: "claim_created", updated_at: nowIso() }).eq("id", encounterId);

  await supabase.from("audit_logs").insert({
    organization_id: encounter.organization_id,
    patient_id: encounter.client_id,
    appointment_id: encounter.appointment_id,
    encounter_id: encounterId,
    claim_id: claim.id,
    event_type: "claim_created_from_encounter",
    event_summary: `Claim ${claimNumber} created from encounter.`,
    created_at: nowIso(),
  });

  return { ok: true, encounterId, claimId: claim.id, message: "Claim created from encounter." };
}

export async function submitClaim(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  claimId: string,
  submittedBy: string
): Promise<PipelineResult> {
  const { data: claim } = await supabase.from("professional_claims").select("*").eq("id", claimId).single();
  if (!claim) return { ok: false, claimId, message: "Claim not found." } as PipelineResult;

  await supabase
    .from("professional_claims")
    .update({
      claim_status: "submitted",
      updated_at: nowIso(),
    })
    .eq("id", claimId);

  await supabase.from("claim_submissions").insert({
    claim_id: claimId,
    submission_status: "submitted",
    clearinghouse_reference: `TRACE-${Date.now()}`,
    submission_sequence: 1,
    response_summary: `Submitted by ${submittedBy}`,
    submitted_at: nowIso(),
    acknowledged_at: null,
  });

  await supabase.from("claim_status_events").insert({
    claim_id: claimId,
    source: "clearinghouse",
    transaction_type: "837P",
    status_code: "SUBMITTED",
    status_description: "Claim submitted to clearinghouse.",
    event_at: nowIso(),
    raw_event: { mock: true },
  });

  return { ok: true, claimId, message: "Claim submitted." } as PipelineResult;
}
