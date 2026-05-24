import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { MEDICAL_REVIEW_TABS, type MedicalReviewTab } from "./tabs";
import type {
  MedicalReviewFilters,
  MedicalReviewRequestType,
  MedicalReviewRow,
} from "./types";

export { MEDICAL_REVIEW_TABS };
export type {
  MedicalReviewTab,
  MedicalReviewFilters,
  MedicalReviewRequestType,
  MedicalReviewRow,
};

type DbRow = Record<string, unknown>;

function text(v: unknown): string {
  return String(v ?? "").trim();
}
function money(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
function todayMs(): number {
  return Date.now();
}
function daysBetweenMs(iso: string | null, now = todayMs()): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - now) / 86_400_000);
}

const REQ_LABEL: Record<MedicalReviewRequestType, string> = {
  records: "Records Requested",
  treatment_plan: "Treatment Plan Requested",
  notes: "Notes Requested",
  medical_necessity: "Medical Necessity Review",
};

const REQ_TO_TAB: Record<MedicalReviewRequestType, MedicalReviewTab> = {
  records: "records_requested",
  treatment_plan: "treatment_plan_requested",
  notes: "notes_requested",
  medical_necessity: "medical_necessity_review",
};

const RECORDS_CARC = new Set(["227", "252", "MA01", "N706", "N705"]);
const NECESSITY_CARC = new Set(["50", "55", "167"]);

function classifyFromDenial(code: string | null): MedicalReviewRequestType | null {
  if (!code) return null;
  const up = code.toUpperCase().replace(/^(CO|PR|OA|CR|PI)-?/, "");
  if (NECESSITY_CARC.has(up)) return "medical_necessity";
  if (RECORDS_CARC.has(up)) return "records";
  return null;
}

function carcRarcFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  const m = notes.match(/\b(?:CO|PR|OA|CR|PI)-?\d{1,3}\b|\bCARC\s*\d{1,3}\b|\bRARC\s*[A-Z]?\d{1,4}\b/i);
  return m ? m[0].toUpperCase() : null;
}

export interface LoadMedicalReviewInput {
  supabase: SupabaseClient;
  organizationId: string;
  filters?: MedicalReviewFilters;
  limit?: number;
}

interface RawRequest {
  requestId: string;
  claimId: string;
  requestType: MedicalReviewRequestType;
  requestedDocuments: string[];
  requestSource: string | null;
  requestNotes: string | null;
  requestDate: string | null;
  dueDate: string | null;
  source: "audit" | "denial";
}

function applyFilters(
  rows: MedicalReviewRow[],
  f: MedicalReviewFilters | undefined,
  nowMs: number,
): MedicalReviewRow[] {
  if (!f) return rows;
  let out = rows;
  if (f.practice) out = out.filter((r) => r.practiceId === f.practice);
  if (f.clinician) out = out.filter((r) => r.providerId === f.clinician);
  if (f.client) {
    const q = f.client.toLowerCase();
    out = out.filter((r) => r.clientName.toLowerCase().includes(q));
  }
  if (f.payer) out = out.filter((r) => r.payerName === f.payer);
  if (f.dosFrom) out = out.filter((r) => (r.dateOfService ?? "") >= f.dosFrom!);
  if (f.dosTo) out = out.filter((r) => (r.dateOfService ?? "") <= f.dosTo! + "T23:59:59");
  if (f.status) out = out.filter((r) => (r.claimStatus ?? "").toLowerCase() === f.status);
  if (f.priority === "urgent") out = out.filter((r) => r.isUrgent || r.isOverdue);
  if (f.minAmount) {
    const min = Number(f.minAmount);
    if (Number.isFinite(min)) out = out.filter((r) => r.chargeAmount >= min);
  }
  if (f.maxAmount) {
    const max = Number(f.maxAmount);
    if (Number.isFinite(max)) out = out.filter((r) => r.chargeAmount <= max);
  }
  if (f.agingBucket) {
    out = out.filter((r) => {
      if (!r.requestDate) return f.agingBucket === "never";
      const days = Math.floor((nowMs - new Date(r.requestDate).getTime()) / 86_400_000);
      switch (f.agingBucket) {
        case "0-30": return days <= 30;
        case "31-60": return days > 30 && days <= 60;
        case "61-90": return days > 60 && days <= 90;
        case "90+": return days > 90;
        case "never": return false;
        default: return true;
      }
    });
  }
  if (f.assignedBiller) {
    const q = f.assignedBiller.toLowerCase();
    out = out.filter((r) => (r.assignedBillerId ?? "").toLowerCase().includes(q));
  }
  if (f.carcRarc) {
    const q = f.carcRarc.toUpperCase();
    out = out.filter((r) => (r.denialCode ?? "").toUpperCase().includes(q));
  }
  if (f.followUpDue) {
    const cutoff = f.followUpDue + "T23:59:59";
    out = out.filter((r) => r.followUpDueAt != null && r.followUpDueAt <= cutoff);
  }
  return out;
}

export async function loadMedicalReview({
  supabase,
  organizationId,
  filters,
  limit = 500,
}: LoadMedicalReviewInput): Promise<MedicalReviewRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };

  // 1) Pull all "medical_review_requested" audit entries (active requests).
  const { data: requestRows } = await sb
    .from("audit_logs")
    .select("id, claim_id, patient_id, appointment_id, event_summary, event_metadata, created_at")
    .eq("organization_id", organizationId)
    .eq("action", "medical_review_requested")
    .order("created_at", { ascending: false })
    .limit(limit);

  const requests: RawRequest[] = [];
  const requestedClaimIds = new Set<string>();
  for (const r of ((requestRows as DbRow[]) ?? [])) {
    const claimId = text(r.claim_id);
    if (!claimId) continue;
    const meta = (r.event_metadata as Record<string, unknown> | null) ?? {};
    const reqType = text(meta.requestType).toLowerCase() as MedicalReviewRequestType;
    const allowed: MedicalReviewRequestType[] = ["records", "treatment_plan", "notes", "medical_necessity"];
    if (!allowed.includes(reqType)) continue;
    const docs = Array.isArray(meta.requestedDocuments)
      ? (meta.requestedDocuments as unknown[]).map((d) => text(d)).filter(Boolean)
      : text(meta.requestedDocuments)
        ? text(meta.requestedDocuments).split(/[,;]\s*/).filter(Boolean)
        : [];
    requests.push({
      requestId: text(r.id),
      claimId,
      requestType: reqType,
      requestedDocuments: docs,
      requestSource: text(meta.requestSource) || "Payer request",
      requestNotes: text(meta.notes) || text(r.event_summary) || null,
      requestDate: text(meta.requestDate) || text(r.created_at) || null,
      dueDate: text(meta.dueDate) || null,
      source: "audit",
    });
    requestedClaimIds.add(claimId);
  }

  // 2) Augment with denied claims whose CARC indicates documentation/necessity
  //    and that don't already have an explicit request audit row.
  const { data: deniedRows } = await sb
    .from("professional_claims")
    .select(
      "id, organization_id, claim_number, claim_status, denial_reason_code, denial_reason_description, total_charge, appointment_id, patient_id, payer_profile_id, billing_notes, submitted_at, updated_at, encounter_id, first_billed_date",
    )
    .eq("organization_id", organizationId)
    .in("claim_status", ["denied", "rejected_payer", "accepted_payer"])
    .limit(limit);
  for (const c of ((deniedRows as DbRow[]) ?? [])) {
    const claimId = text(c.id);
    if (requestedClaimIds.has(claimId)) continue;
    const code = text(c.denial_reason_code) || carcRarcFromNotes(text(c.billing_notes));
    const reqType = classifyFromDenial(code);
    if (!reqType) continue;
    requests.push({
      requestId: `denial:${claimId}`,
      claimId,
      requestType: reqType,
      requestedDocuments: reqType === "medical_necessity"
        ? ["Clinical note", "Treatment plan", "Assessment"]
        : ["Medical records"],
      requestSource: "Payer denial (CARC " + (code ?? "—") + ")",
      requestNotes: text(c.denial_reason_description) || null,
      requestDate: text(c.updated_at) || text(c.first_billed_date) || null,
      dueDate: null,
      source: "denial",
    });
    requestedClaimIds.add(claimId);
  }

  if (requests.length === 0) return [];

  // 3) Hydrate claim + related rows.
  const claimIds = Array.from(requestedClaimIds);
  const [
    { data: claims },
    { data: actionAudit },
  ] = await Promise.all([
    sb.from("professional_claims")
      .select(
        "id, claim_number, claim_status, appointment_id, patient_id, payer_profile_id, total_charge, denial_reason_code, billing_notes, submitted_at, encounter_id, first_billed_date",
      )
      .eq("organization_id", organizationId)
      .in("id", claimIds),
    sb.from("audit_logs")
      .select("claim_id, action, event_summary, event_metadata, user_id, created_at")
      .eq("organization_id", organizationId)
      .in("claim_id", claimIds)
      .in("action", [
        "medical_review_records_attached",
        "medical_review_documentation_sent",
        "medical_review_cover_letter_created",
        "medical_review_routed_clinician",
        "medical_review_routed_admin",
        "medical_review_assigned_biller",
        "medical_review_follow_up_set",
        "medical_review_submitted",
      ])
      .order("created_at", { ascending: false }),
  ]);

  const claimById = new Map<string, DbRow>(
    ((claims as DbRow[]) ?? []).map((c) => [text(c.id), c]),
  );

  // Collect appt / patient / payer ids for fan-out.
  const apptIds = new Set<string>();
  const patientIds = new Set<string>();
  const payerProfileIds = new Set<string>();
  const encounterIds = new Set<string>();
  for (const c of claimById.values()) {
    if (text(c.appointment_id)) apptIds.add(text(c.appointment_id));
    if (text(c.patient_id)) patientIds.add(text(c.patient_id));
    if (text(c.payer_profile_id)) payerProfileIds.add(text(c.payer_profile_id));
    if (text(c.encounter_id)) encounterIds.add(text(c.encounter_id));
  }

  const [
    { data: appts },
    { data: clients },
    { data: payers },
  ] = await Promise.all([
    apptIds.size
      ? sb.from("appointments")
          .select("id, client_id, provider_id, provider_location_id, scheduled_start_at")
          .in("id", Array.from(apptIds))
      : { data: [] as DbRow[] },
    patientIds.size
      ? sb.from("clients").select("id, first_name, last_name").in("id", Array.from(patientIds))
      : { data: [] as DbRow[] },
    payerProfileIds.size
      ? sb.from("payer_profiles")
          .select("id, payer_name, availity_payer_id")
          .in("id", Array.from(payerProfileIds))
      : { data: [] as DbRow[] },
  ]);

  const apptById = new Map<string, DbRow>(((appts as DbRow[]) ?? []).map((a) => [text(a.id), a]));
  const clientById = new Map<string, DbRow>(((clients as DbRow[]) ?? []).map((c) => [text(c.id), c]));
  const payerById = new Map<string, DbRow>(((payers as DbRow[]) ?? []).map((p) => [text(p.id), p]));

  // 4) Roll up per-claim action state (latest-wins, except submitted which
  //    is a terminal flag).
  type Assignment = { kind: "clinician" | "admin" | "biller"; display: string; userId: string | null };
  const assignedMap = new Map<string, Assignment>();
  const assignedBillerMap = new Map<string, string>();
  const followUpMap = new Map<string, string>();
  const submittedMap = new Map<string, string>();
  const lastActionMap = new Map<string, string>();
  for (const r of ((actionAudit as DbRow[]) ?? [])) {
    const cid = text(r.claim_id);
    if (!cid) continue;
    const action = text(r.action);
    const meta = (r.event_metadata as Record<string, unknown> | null) ?? {};
    if (!lastActionMap.has(cid)) lastActionMap.set(cid, text(r.created_at));
    if (action === "medical_review_submitted" && !submittedMap.has(cid)) {
      submittedMap.set(cid, text(r.created_at));
    }
    if (action === "medical_review_routed_clinician" && !assignedMap.has(cid)) {
      const providerId = text(meta.providerId);
      assignedMap.set(cid, {
        kind: "clinician",
        display: providerId ? `Clinician ${providerId.slice(0, 8)}` : "Clinician",
        userId: providerId || null,
      });
    }
    if (action === "medical_review_routed_admin" && !assignedMap.has(cid)) {
      assignedMap.set(cid, { kind: "admin", display: "Admin pool", userId: null });
    }
    if (action === "medical_review_assigned_biller" && !assignedBillerMap.has(cid)) {
      const billerId = text(meta.billerId) || text(r.user_id);
      if (billerId) assignedBillerMap.set(cid, billerId);
    }
    if (action === "medical_review_follow_up_set" && !followUpMap.has(cid)) {
      const due = text(meta.dueAt);
      if (due) followUpMap.set(cid, due);
    }
  }

  const nowMs = todayMs();
  const rows: MedicalReviewRow[] = [];
  for (const req of requests) {
    const claim = claimById.get(req.claimId);
    if (!claim) continue;
    // Drop fully-submitted requests so the queue stays actionable.
    // Applies to both audit-derived and denial-derived rows so a
    // `mark_submitted` action persists across refreshes.
    if (submittedMap.has(req.claimId)) continue;
    const appt = text(claim.appointment_id) ? apptById.get(text(claim.appointment_id)) : undefined;
    const cli = text(claim.patient_id) ? clientById.get(text(claim.patient_id)) : undefined;
    const payer = text(claim.payer_profile_id) ? payerById.get(text(claim.payer_profile_id)) : undefined;

    const firstName = text(cli?.first_name);
    const lastName = text(cli?.last_name);
    const clientName = `${lastName}, ${firstName}`.replace(/^,\s*$/, "") || "Unknown client";

    const daysUntilDue = daysBetweenMs(req.dueDate, nowMs);
    const isOverdue = daysUntilDue !== null && daysUntilDue < 0;
    const isUrgent = daysUntilDue !== null && daysUntilDue >= 0 && daysUntilDue <= 7;
    const primaryTab = REQ_TO_TAB[req.requestType];
    const tabs: MedicalReviewTab[] = [primaryTab];
    if (isUrgent || isOverdue) tabs.push("deadline_approaching");

    const assignment = assignedMap.get(req.claimId) ?? null;
    rows.push({
      id: req.requestId,
      requestType: req.requestType,
      requestTypeLabel: REQ_LABEL[req.requestType],
      primaryTab,
      tabs,
      claimId: req.claimId,
      claimNumber: text(claim.claim_number) || null,
      clientId: text(claim.patient_id) || null,
      clientName,
      payerProfileId: text(claim.payer_profile_id) || null,
      payerName: text(payer?.payer_name) || "—",
      appointmentId: text(claim.appointment_id) || null,
      encounterId: text(claim.encounter_id) || null,
      dateOfService: text(appt?.scheduled_start_at) || null,
      requestedDocuments: req.requestedDocuments,
      requestSource: req.requestSource,
      requestNotes: req.requestNotes,
      requestDate: req.requestDate,
      dueDate: req.dueDate,
      daysUntilDue,
      isUrgent,
      isOverdue,
      chargeAmount: money(claim.total_charge),
      denialCode: text(claim.denial_reason_code) || carcRarcFromNotes(text(claim.billing_notes)),
      claimStatus: text(claim.claim_status) || null,
      providerId: text(appt?.provider_id) || null,
      practiceId: text(appt?.provider_location_id) || null,
      assignedTo: assignment ? assignment.display : null,
      assignedToKind: assignment ? assignment.kind : null,
      assignedBillerId: assignedBillerMap.get(req.claimId) ?? null,
      followUpDueAt: followUpMap.get(req.claimId) ?? null,
      submittedAt: submittedMap.get(req.claimId) ?? null,
      lastActionAt: lastActionMap.get(req.claimId) ?? null,
    });
  }

  return applyFilters(rows, filters, nowMs);
}

export interface MedicalReviewClaimContext {
  clinicalNote: {
    id: string;
    status: string;
    subjective: string | null;
    objective: string | null;
    assessment: string | null;
    plan: string | null;
    signedAt: string | null;
  } | null;
  treatmentPlan: {
    id: string;
    status: string;
    startDate: string | null;
    endDate: string | null;
    presentingProblem: string | null;
    longTermGoals: string | null;
    frequency: string | null;
    modality: string | null;
  } | null;
  documents: Array<{
    id: string;
    title: string;
    fileName: string;
    documentType: string | null;
    mimeType: string | null;
    uploadedAt: string | null;
    notes: string | null;
  }>;
  history: Array<{
    id: string;
    action: string;
    summary: string | null;
    createdAt: string;
    userId: string | null;
  }>;
}

export async function loadMedicalReviewClaimContext(
  supabase: SupabaseClient,
  organizationId: string,
  claimId: string,
): Promise<MedicalReviewClaimContext> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };
  const { data: claim } = await sb
    .from("professional_claims")
    .select("id, encounter_id, patient_id")
    .eq("id", claimId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const encounterId = claim ? text((claim as DbRow).encounter_id) : "";
  const clientId = claim ? text((claim as DbRow).patient_id) : "";

  const [{ data: note }, { data: plan }, { data: docs }, { data: hist }] = await Promise.all([
    encounterId
      ? sb.from("encounter_clinical_notes")
          .select("id, note_status, subjective, objective, assessment, plan, signed_at")
          .eq("encounter_id", encounterId)
          .eq("organization_id", organizationId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null },
    clientId
      ? sb.from("treatment_plans")
          .select("id, plan_status, start_date, end_date, presenting_problem, long_term_goals, frequency, modality")
          .eq("client_id", clientId)
          .eq("organization_id", organizationId)
          .is("archived_at", null)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null },
    sb.from("documents")
      .select("id, title, file_name, document_type, mime_type, filed_at, created_at, notes")
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
    sb.from("audit_logs")
      .select("id, action, event_summary, created_at, user_id")
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .like("action", "medical_review_%")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const n = (note as DbRow | null) ?? null;
  const p = (plan as DbRow | null) ?? null;

  return {
    clinicalNote: n
      ? {
          id: text(n.id),
          status: text(n.note_status) || "draft",
          subjective: text(n.subjective) || null,
          objective: text(n.objective) || null,
          assessment: text(n.assessment) || null,
          plan: text(n.plan) || null,
          signedAt: text(n.signed_at) || null,
        }
      : null,
    treatmentPlan: p
      ? {
          id: text(p.id),
          status: text(p.plan_status) || "active",
          startDate: text(p.start_date) || null,
          endDate: text(p.end_date) || null,
          presentingProblem: text(p.presenting_problem) || null,
          longTermGoals: text(p.long_term_goals) || null,
          frequency: text(p.frequency) || null,
          modality: text(p.modality) || null,
        }
      : null,
    documents: ((docs as DbRow[]) ?? []).map((d) => ({
      id: text(d.id),
      title: text(d.title),
      fileName: text(d.file_name),
      documentType: text(d.document_type) || null,
      mimeType: text(d.mime_type) || null,
      uploadedAt: text(d.filed_at) || text(d.created_at) || null,
      notes: text(d.notes) || null,
    })),
    history: ((hist as DbRow[]) ?? []).map((h) => ({
      id: text(h.id),
      action: text(h.action),
      summary: text(h.event_summary) || null,
      createdAt: text(h.created_at),
      userId: text(h.user_id) || null,
    })),
  };
}
