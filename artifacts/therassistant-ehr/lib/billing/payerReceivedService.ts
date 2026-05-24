import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type PayerReceivedTab =
  | "received"
  | "in_process"
  | "pending_review"
  | "approaching_follow_up";

export const PAYER_RECEIVED_TABS: Array<{ id: PayerReceivedTab; label: string }> = [
  { id: "received", label: "Received" },
  { id: "in_process", label: "In Process" },
  { id: "pending_review", label: "Pending Review" },
  { id: "approaching_follow_up", label: "Approaching Follow-Up" },
];

export interface StatusHistoryEntry {
  source: string;
  status: string;
  message: string | null;
  payerReferenceId: string | null;
  at: string;
}

export interface PayerReceivedRow {
  id: string;
  claimId: string;
  claimNumber: string;
  clientId: string;
  clientName: string;
  payerName: string;
  payerProfileId: string | null;
  dateOfService: string | null;
  payerReceivedAt: string | null;
  payerStatus: string;
  payerStatusCode: string | null;
  payerStatusText: string | null;
  daysInProcess: number;
  chargeAmount: number;
  expectedAdjudicationAt: string | null;
  submittedAt: string | null;
  slaDays: number;
  overdue: boolean;
  daysOverdue: number;
  // Tab classification
  tab: PayerReceivedTab;
  // Detail panel
  payerClaimNumber: string | null;
  statusHistory: StatusHistoryEntry[];
  submissionTrace: {
    submittedAt: string | null;
    acknowledgedAt: string | null;
    clearinghouseReference: string | null;
    payerClaimReference: string | null;
    submissionSequence: number | null;
    submissionStatus: string | null;
  };
  followUpNotes: Array<{ id: string; at: string; summary: string; userId: string | null }>;
  // Filter fields
  providerId: string | null;
  practiceId: string | null;
  assignedBillerId: string | null;
  followUpDueAt: string | null;
  movedToAgingAt: string | null;
  billingNotes: string | null;
  denialCode: string | null;
}

export interface PayerReceivedFilters {
  practice?: string;
  clinician?: string;
  client?: string;
  payer?: string;
  dosFrom?: string;
  dosTo?: string;
  status?: string;
  priority?: string;
  minAmount?: string;
  maxAmount?: string;
  agingBucket?: string;
  assignedBiller?: string;
  carcRarc?: string;
  followUpDue?: string;
  overdue?: string;
}

type DbRow = Record<string, unknown>;

function text(v: unknown): string {
  return String(v ?? "").trim();
}
function money(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400_000));
}

function addDaysIso(iso: string | null, days: number): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + days * 86400_000).toISOString();
}

function carcRarcFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  const m = notes.match(/\b(?:CO|PR|OA|CR|PI)-?\d{1,3}\b|\bCARC\s*\d{1,3}\b|\bRARC\s*[A-Z]?\d{1,4}\b/i);
  return m ? m[0].toUpperCase() : null;
}

function applyFilters(rows: PayerReceivedRow[], f: PayerReceivedFilters | undefined): PayerReceivedRow[] {
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
  if (f.status) out = out.filter((r) => r.payerStatus.toLowerCase() === f.status!.toLowerCase());
  if (f.priority === "urgent") {
    out = out.filter((r) => r.daysInProcess >= 30);
  }
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
      const a = r.daysInProcess;
      switch (f.agingBucket) {
        case "0-30": return a <= 30;
        case "31-60": return a > 30 && a <= 60;
        case "61-90": return a > 60 && a <= 90;
        case "90+": return a > 90;
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
  if (f.overdue === "true" || f.overdue === "1") {
    out = out.filter((r) => r.overdue);
  }
  return out;
}

export interface LoadPayerReceivedInput {
  supabase: SupabaseClient;
  organizationId: string;
  limit?: number;
  filters?: PayerReceivedFilters;
}

export async function loadPayerReceivedClaims({
  supabase,
  organizationId,
  limit = 500,
  filters,
}: LoadPayerReceivedInput): Promise<PayerReceivedRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };

  // Claims accepted by payer (or accepted by clearinghouse and awaiting payer)
  // that have not yet been paid/denied/voided.
  const { data: claims, error: claimsErr } = await sb
    .from("professional_claims")
    .select(
      "id, organization_id, patient_id, appointment_id, payer_profile_id, claim_number, claim_status, total_charge, submitted_at, billing_notes, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .eq("claim_status", "accepted_payer")
    .order("submitted_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (claimsErr) throw new Error(claimsErr.message ?? "Failed to load claims");
  const claimRows: DbRow[] = (claims as DbRow[]) ?? [];
  if (claimRows.length === 0) return [];

  const claimIds = claimRows.map((c) => text(c.id)).filter(Boolean);
  const clientIds = [...new Set(claimRows.map((c) => text(c.patient_id)).filter(Boolean))];
  const apptIds = [...new Set(claimRows.map((c) => text(c.appointment_id)).filter(Boolean))];
  const profileIds = [...new Set(claimRows.map((c) => text(c.payer_profile_id)).filter(Boolean))];

  const [
    { data: clients },
    { data: appts },
    { data: profiles },
    { data: statusEvents },
    { data: inquiries },
    { data: submissions },
    { data: auditRows },
  ] = await Promise.all([
    clientIds.length
      ? sb.from("clients").select("id, first_name, last_name").in("id", clientIds)
      : { data: [] as DbRow[] },
    apptIds.length
      ? sb.from("appointments")
          .select("id, scheduled_start_at, provider_id, provider_location_id")
          .in("id", apptIds)
      : { data: [] as DbRow[] },
    profileIds.length
      ? sb.from("payer_profiles").select("id, payer_name, availity_payer_id, adjudication_sla_days").in("id", profileIds)
      : { data: [] as DbRow[] },
    claimIds.length
      ? sb.from("claim_status_events")
          .select("id, claim_id, source, status, status_message, payer_reference_id, availity_claim_id, created_at")
          .in("claim_id", claimIds)
          .order("created_at", { ascending: false })
      : { data: [] as DbRow[] },
    claimIds.length
      ? sb.from("claim_status_inquiries")
          .select("id, claim_id, inquiry_status, payer_status_code, payer_status_text, requested_at, responded_at, response_summary")
          .eq("organization_id", organizationId)
          .in("claim_id", claimIds)
          .is("archived_at", null)
          .order("requested_at", { ascending: false })
      : { data: [] as DbRow[] },
    claimIds.length
      ? sb.from("claim_submissions")
          .select("id, claim_id, submission_status, submission_sequence, submitted_at, acknowledged_at, clearinghouse_reference, payer_claim_reference")
          .eq("organization_id", organizationId)
          .in("claim_id", claimIds)
          .order("submission_sequence", { ascending: false })
      : { data: [] as DbRow[] },
    claimIds.length
      ? sb.from("audit_logs")
          .select("id, claim_id, action, event_summary, event_metadata, user_id, created_at")
          .eq("organization_id", organizationId)
          .in("claim_id", claimIds)
          .in("action", [
            "payer_received_note_added",
            "payer_received_follow_up_set",
            "payer_received_status_checked",
            "payer_received_moved_to_aging",
          ])
          .order("created_at", { ascending: false })
      : { data: [] as DbRow[] },
  ]);

  const clientById = new Map<string, DbRow>(
    ((clients as DbRow[]) ?? []).map((c) => [text(c.id), c]),
  );
  const apptById = new Map<string, DbRow>(
    ((appts as DbRow[]) ?? []).map((a) => [text(a.id), a]),
  );
  const profileById = new Map<string, DbRow>(
    ((profiles as DbRow[]) ?? []).map((p) => [text(p.id), p]),
  );

  // Group history/inquiries/submissions per claim
  const eventsByClaim = new Map<string, DbRow[]>();
  for (const e of ((statusEvents as DbRow[]) ?? [])) {
    const k = text(e.claim_id);
    if (!eventsByClaim.has(k)) eventsByClaim.set(k, []);
    eventsByClaim.get(k)!.push(e);
  }
  const inquiriesByClaim = new Map<string, DbRow[]>();
  for (const i of ((inquiries as DbRow[]) ?? [])) {
    const k = text(i.claim_id);
    if (!inquiriesByClaim.has(k)) inquiriesByClaim.set(k, []);
    inquiriesByClaim.get(k)!.push(i);
  }
  const submissionsByClaim = new Map<string, DbRow[]>();
  for (const s of ((submissions as DbRow[]) ?? [])) {
    const k = text(s.claim_id);
    if (!submissionsByClaim.has(k)) submissionsByClaim.set(k, []);
    submissionsByClaim.get(k)!.push(s);
  }

  // Audit-derived state per claim
  const followUpByClaim = new Map<string, string>();
  const billerByClaim = new Map<string, string>();
  const movedToAgingByClaim = new Map<string, string>();
  const notesByClaim = new Map<string, Array<{ id: string; at: string; summary: string; userId: string | null }>>();
  for (const r of ((auditRows as DbRow[]) ?? [])) {
    const k = text(r.claim_id);
    if (!k) continue;
    const action = text(r.action);
    const meta = (r.event_metadata as Record<string, unknown> | null) ?? {};
    if (action === "payer_received_follow_up_set" && !followUpByClaim.has(k)) {
      const due = text(meta.dueAt);
      if (due) followUpByClaim.set(k, due);
      const biller = text(meta.billerId) || text(r.user_id);
      if (biller && !billerByClaim.has(k)) billerByClaim.set(k, biller);
    }
    if (action === "payer_received_moved_to_aging" && !movedToAgingByClaim.has(k)) {
      movedToAgingByClaim.set(k, text(r.created_at));
    }
    if (action === "payer_received_note_added") {
      if (!notesByClaim.has(k)) notesByClaim.set(k, []);
      notesByClaim.get(k)!.push({
        id: text(r.id),
        at: text(r.created_at),
        summary: text(r.event_summary),
        userId: text(r.user_id) || null,
      });
    }
  }

  const nowMs = Date.now();
  const rows: PayerReceivedRow[] = [];

  for (const c of claimRows) {
    const claimId = text(c.id);
    if (movedToAgingByClaim.has(claimId)) continue; // hidden from this queue once moved

    const client = clientById.get(text(c.patient_id));
    const appt = apptById.get(text(c.appointment_id));
    const profile = profileById.get(text(c.payer_profile_id));
    const claimEvents = eventsByClaim.get(claimId) ?? [];
    const claimInquiries = inquiriesByClaim.get(claimId) ?? [];
    const claimSubmissions = submissionsByClaim.get(claimId) ?? [];

    // "Payer received" anchor: latest claim_status_event with status implying
    // payer accepted/received, else submitted_at.
    const receivedEvent = claimEvents.find((e) => {
      const s = text(e.status).toLowerCase();
      return s.includes("accept") || s.includes("received") || s === "accepted_payer";
    });
    const payerReceivedAt = receivedEvent
      ? text(receivedEvent.created_at) || null
      : (text(c.submitted_at) || null);

    const latestInquiry = claimInquiries[0];
    const payerStatusCode = latestInquiry ? text(latestInquiry.payer_status_code) || null : null;
    const payerStatusText = latestInquiry ? text(latestInquiry.payer_status_text) || null : null;

    const submittedAt = text(c.submitted_at) || null;
    const daysInProcess = daysSince(payerReceivedAt ?? submittedAt);

    // Expected adjudication date — driven by the per-payer SLA configured on
    // payer_profiles.adjudication_sla_days. Falls back to 30 days when the
    // payer is unknown or the column is somehow null (older rows pre-migration).
    const slaRaw = profile ? Number(profile.adjudication_sla_days) : NaN;
    const slaDays = Number.isFinite(slaRaw) && slaRaw >= 1 ? Math.floor(slaRaw) : 30;
    const expectedAdjudicationAt = addDaysIso(payerReceivedAt ?? submittedAt, slaDays);
    const expectedMs = expectedAdjudicationAt ? new Date(expectedAdjudicationAt).getTime() : NaN;
    const overdue = Number.isFinite(expectedMs) && nowMs > expectedMs;
    const daysOverdue = overdue
      ? Math.floor((nowMs - expectedMs) / 86400_000)
      : 0;

    // Status history (276/277): combine inquiries + status events.
    const statusHistory: StatusHistoryEntry[] = [];
    for (const i of claimInquiries) {
      statusHistory.push({
        source: "276/277",
        status: text(i.inquiry_status) || "unknown",
        message: text(i.payer_status_text) || null,
        payerReferenceId: text(i.payer_status_code) || null,
        at: text(i.responded_at) || text(i.requested_at),
      });
    }
    for (const e of claimEvents) {
      statusHistory.push({
        source: text(e.source) || "system",
        status: text(e.status) || "unknown",
        message: text(e.status_message) || null,
        payerReferenceId: text(e.payer_reference_id) || text(e.availity_claim_id) || null,
        at: text(e.created_at),
      });
    }
    statusHistory.sort((a, b) => (b.at || "").localeCompare(a.at || ""));

    const payerClaimNumber = statusHistory.find((h) => h.payerReferenceId)?.payerReferenceId
      ?? (claimSubmissions[0] ? text(claimSubmissions[0].payer_claim_reference) || null : null);

    const latestSubmission = claimSubmissions[0];
    const submissionTrace = {
      submittedAt: latestSubmission ? text(latestSubmission.submitted_at) || null : submittedAt,
      acknowledgedAt: latestSubmission ? text(latestSubmission.acknowledged_at) || null : null,
      clearinghouseReference: latestSubmission ? text(latestSubmission.clearinghouse_reference) || null : null,
      payerClaimReference: latestSubmission ? text(latestSubmission.payer_claim_reference) || null : payerClaimNumber,
      submissionSequence: latestSubmission ? Number(latestSubmission.submission_sequence) || null : null,
      submissionStatus: latestSubmission ? text(latestSubmission.submission_status) || null : null,
    };

    const followUpDueAt = followUpByClaim.get(claimId) ?? null;
    const hasInquiry = claimInquiries.length > 0;
    const inquiryStatus = latestInquiry ? text(latestInquiry.inquiry_status).toLowerCase() : "";
    const statusTextLower = (payerStatusText || "").toLowerCase();
    const isPendingReview =
      statusTextLower.includes("pend") ||
      statusTextLower.includes("review") ||
      statusTextLower.includes("additional info") ||
      inquiryStatus === "pending";

    // Approaching-follow-up window is derived from the per-payer SLA so a
    // Medicare 14-day SLA flags claims earlier than a Medicaid 60-day SLA.
    // Use ~25% of the SLA window (floor of 2 days, cap of 14) so the cutoff
    // mirrors the same SLA that drives the Overdue flag.
    const approachingWindowDays = Math.min(14, Math.max(2, Math.ceil(slaDays * 0.25)));
    const approachingWindowMs = approachingWindowDays * 86400_000;
    const approachingByExpected =
      Number.isFinite(expectedMs) &&
      !overdue &&
      expectedMs - nowMs <= approachingWindowMs;
    const approachingByFollowUp =
      followUpDueAt != null &&
      new Date(followUpDueAt).getTime() - nowMs <= approachingWindowMs;

    let tab: PayerReceivedTab;
    if (approachingByFollowUp || approachingByExpected) {
      tab = "approaching_follow_up";
    } else if (isPendingReview) {
      tab = "pending_review";
    } else if (hasInquiry || daysInProcess >= 7) {
      tab = "in_process";
    } else {
      tab = "received";
    }

    const firstName = text(client?.first_name);
    const lastName = text(client?.last_name);
    const clientName = `${lastName}, ${firstName}`.replace(/^,\s*$/, "") || "Unknown client";

    rows.push({
      id: claimId,
      claimId,
      claimNumber: text(c.claim_number) || claimId.slice(0, 8),
      clientId: text(c.patient_id),
      clientName,
      payerName: profile ? text(profile.payer_name) || "—" : "—",
      payerProfileId: text(c.payer_profile_id) || null,
      dateOfService: appt ? text(appt.scheduled_start_at) || null : null,
      payerReceivedAt,
      payerStatus: payerStatusText || text(c.claim_status),
      payerStatusCode,
      payerStatusText,
      daysInProcess,
      chargeAmount: money(c.total_charge),
      expectedAdjudicationAt,
      submittedAt,
      slaDays,
      overdue,
      daysOverdue,
      tab,
      payerClaimNumber,
      statusHistory,
      submissionTrace,
      followUpNotes: notesByClaim.get(claimId) ?? [],
      providerId: appt ? text(appt.provider_id) || null : null,
      practiceId: appt ? text(appt.provider_location_id) || null : null,
      assignedBillerId: billerByClaim.get(claimId) ?? null,
      followUpDueAt,
      movedToAgingAt: null,
      billingNotes: text(c.billing_notes) || null,
      denialCode: carcRarcFromNotes(text(c.billing_notes) || null),
    });
  }

  // Default sort: overdue rows first (most overdue at the top), then by
  // days-in-process descending so the oldest non-overdue claims still surface.
  rows.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.overdue && b.overdue && a.daysOverdue !== b.daysOverdue) {
      return b.daysOverdue - a.daysOverdue;
    }
    return b.daysInProcess - a.daysInProcess;
  });

  return applyFilters(rows, filters);
}
