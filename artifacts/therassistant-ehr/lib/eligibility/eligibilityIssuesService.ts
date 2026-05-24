import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ELIGIBILITY_ISSUE_TABS,
  type EligibilityIssueType,
  type EligibilityIssueRow,
  type EligibilityIssueFilters,
} from "./eligibilityIssuesTypes";

export {
  ELIGIBILITY_ISSUE_TABS,
  type EligibilityIssueType,
  type EligibilityIssueRow,
  type EligibilityIssueFilters,
};

type DbRow = Record<string, unknown>;

function text(value: unknown): string {
  return String(value ?? "").trim();
}
function money(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function daysBetween(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000)));
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function classify(args: {
  checkStatus: string | null;
  checkedAt: string | null;
  coverageEnd: string | null;
  policyTermination: string | null;
  memberId: string;
  subscriberDob: string | null;
  policyCount: number;
  // payer mismatch signals (any one of these triggers the tab):
  checkPolicyId: string | null;     // policy the 271 was run against
  apptPolicyId: string | null;      // policy on the appointment
  claimPayerAvailityId: string | null;  // availity_payer_id of the claim's payer_profile
  policyPayerAvailityId: string | null; // payer_id (text/availity code) on the policy's insurance_payers
  responseSummary: unknown;
}): { type: EligibilityIssueType; label: string } | null {
  const {
    checkStatus, checkedAt, coverageEnd, policyTermination,
    memberId, subscriberDob, policyCount,
    checkPolicyId, apptPolicyId,
    claimPayerAvailityId, policyPayerAvailityId,
    responseSummary,
  } = args;

  const today = todayYmd();
  // Terminated plan
  if (
    (coverageEnd && coverageEnd < today) ||
    (policyTermination && policyTermination < today)
  ) {
    return { type: "terminated_plan", label: "Coverage end date is in the past" };
  }
  // Inactive coverage (latest 271 says inactive)
  if (checkStatus && checkStatus.toLowerCase() === "inactive") {
    return { type: "inactive_coverage", label: "Payer returned coverage inactive" };
  }
  // Missing subscriber info
  if (!memberId || !subscriberDob) {
    return {
      type: "missing_subscriber_info",
      label: !memberId ? "Missing member ID" : "Missing subscriber DOB",
    };
  }
  // Payer mismatch — true any time the policy used somewhere downstream
  // doesn't agree with what's on the appointment / on file.
  if (
    (claimPayerAvailityId && policyPayerAvailityId &&
      claimPayerAvailityId.toUpperCase() !== policyPayerAvailityId.toUpperCase()) ||
    (checkPolicyId && apptPolicyId && checkPolicyId !== apptPolicyId)
  ) {
    return { type: "payer_mismatch", label: "Claim/check payer differs from policy on file" };
  }
  // COB issue — multiple active policies, or response_summary flags COB
  const summary = (responseSummary as Record<string, unknown>) ?? {};
  if (policyCount > 1 || summary?.cob === true || text(summary?.cob_indicator)) {
    return { type: "cob_issue", label: "Multiple active policies / COB on file" };
  }
  // Stale eligibility — never checked or > 30 days old
  if (!checkedAt) {
    return { type: "stale_eligibility", label: "Eligibility never checked" };
  }
  const days = daysBetween(checkedAt);
  if (days !== null && days > 30) {
    return { type: "stale_eligibility", label: `Last check ${days} days ago` };
  }
  return null;
}

export interface LoadEligibilityIssuesInput {
  supabase: SupabaseClient;
  organizationId: string;
  limit?: number;
  filters?: EligibilityIssueFilters;
}

function carcRarcFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  // Match CO-45 / PR-204 / CARC 197 / RARC N130-style tokens.
  const m = notes.match(/\b(?:CO|PR|OA|CR|PI)-?\d{1,3}\b|\bCARC\s*\d{1,3}\b|\bRARC\s*[A-Z]?\d{1,4}\b/i);
  return m ? m[0].toUpperCase() : null;
}

function applyFilters(
  rows: EligibilityIssueRow[],
  f: EligibilityIssueFilters | undefined,
  nowMs: number,
): EligibilityIssueRow[] {
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
  if (f.status) out = out.filter((r) => r.eligibilityStatus.toLowerCase() === f.status);
  if (f.priority === "urgent") {
    out = out.filter((r) => {
      if (!r.dateOfService) return false;
      const delta = new Date(r.dateOfService).getTime() - nowMs;
      // Urgent = appointment is today or within the next 3 days.
      return delta >= 0 && delta <= 3 * 86400_000;
    });
  }
  if (f.minAmount) {
    const min = Number(f.minAmount);
    if (Number.isFinite(min)) out = out.filter((r) => r.totalCharge >= min);
  }
  if (f.maxAmount) {
    const max = Number(f.maxAmount);
    if (Number.isFinite(max)) out = out.filter((r) => r.totalCharge <= max);
  }
  if (f.agingBucket) {
    out = out.filter((r) => {
      const a = r.daysSinceCheck;
      if (f.agingBucket === "never") return a == null;
      if (a == null) return false;
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
  return out;
}

export async function loadEligibilityIssues({
  supabase,
  organizationId,
  limit = 500,
  filters,
}: LoadEligibilityIssuesInput): Promise<EligibilityIssueRow[]> {
  // Pull appointments in a wide window (past 30d to future 60d) that have an
  // insurance policy — those are the candidates that could block billing.
  const fromIso = new Date(Date.now() - 30 * 86400_000).toISOString();
  const toIso = new Date(Date.now() + 60 * 86400_000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAppts = supabase as unknown as { from: (t: string) => any };
  const { data: appts, error: apptsErr } = await sbAppts
    .from("appointments")
    .select(
      "id, organization_id, client_id, provider_id, provider_location_id, insurance_policy_id, scheduled_start_at, scheduled_end_at, appointment_status, archived_at"
    )
    .eq("organization_id", organizationId)
    .gte("scheduled_start_at", fromIso)
    .lte("scheduled_start_at", toIso)
    .is("archived_at", null)
    .order("scheduled_start_at", { ascending: false })
    .limit(limit);

  if (apptsErr) throw new Error(apptsErr.message ?? "Failed to load appointments");
  const apptRows: DbRow[] = (appts as DbRow[]) ?? [];
  if (apptRows.length === 0) return [];

  const apptIds = apptRows.map((a) => text(a.id)).filter(Boolean);
  const clientIds = [...new Set(apptRows.map((a) => text(a.client_id)).filter(Boolean))];
  const policyIds = [
    ...new Set(apptRows.map((a) => text(a.insurance_policy_id)).filter(Boolean)),
  ];

  // Supabase chainable query builder — we use `any` here so we can compose
  // arbitrary chains without re-deriving postgrest's generic types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };

  const [
    { data: checks },
    { data: clients },
    { data: policies },
    { data: subscribers },
    { data: payers },
    { data: claims },
    { data: allPoliciesForClients },
  ] = await Promise.all([
    apptIds.length
      ? sb.from("eligibility_checks")
          .select(
            "id, appointment_id, organization_id, client_id, insurance_policy_id, eligibility_status, checked_at, coverage_start_date, coverage_end_date, copay_amount, deductible_remaining, response_summary, raw_status_text"
          )
          .eq("organization_id", organizationId)
          .in("appointment_id", apptIds)
          .order("checked_at", { ascending: false, nullsFirst: false })
      : { data: [] as DbRow[] },
    clientIds.length
      ? sb.from("clients").select("id, first_name, last_name, mrn").in("id", clientIds)
      : { data: [] as DbRow[] },
    policyIds.length
      ? sb.from("insurance_policies")
          .select(
            "id, client_id, payer_id, subscriber_id, plan_name, policy_number, effective_date, termination_date, copay_amount, active_flag, archived_at"
          )
          .in("id", policyIds)
      : { data: [] as DbRow[] },
    Promise.resolve({ data: [] as DbRow[] }), // hydrated below once we know subscriber_ids
    sb.from("insurance_payers")
        .select("id, payer_id, payer_name")
        .eq("organization_id", organizationId),
    apptIds.length
      ? sb.from("professional_claims")
          .select(
            "id, appointment_id, claim_number, claim_status, total_charge, payer_profile_id, billing_notes"
          )
          .eq("organization_id", organizationId)
          .in("appointment_id", apptIds)
          .is("archived_at" as never, null as never)
      : { data: [] as DbRow[] },
    clientIds.length
      ? sb.from("insurance_policies")
          .select("id, client_id, active_flag, archived_at")
          .in("client_id", clientIds)
      : { data: [] as DbRow[] },
  ]);

  // Hydrate subscribers now that we have policy.subscriber_id list.
  const subscriberIds = [
    ...new Set(((policies as DbRow[]) ?? []).map((p) => text(p.subscriber_id)).filter(Boolean)),
  ];
  let subscriberRows: DbRow[] = [];
  if (subscriberIds.length) {
    const { data } = await sb.from("insurance_subscribers")
      .select("id, first_name, last_name, date_of_birth, member_id, relationship_to_client")
      .in("id", subscriberIds);
    subscriberRows = (data as DbRow[]) ?? [];
  } else {
    subscriberRows = ((subscribers as DbRow[]) ?? []);
  }

  // Latest check per appointment.
  const latestByAppt = new Map<string, DbRow>();
  for (const c of ((checks as DbRow[]) ?? [])) {
    const key = text(c.appointment_id);
    if (!key) continue;
    if (!latestByAppt.has(key)) latestByAppt.set(key, c);
  }

  const clientById = new Map<string, DbRow>(
    ((clients as DbRow[]) ?? []).map((c) => [text(c.id), c])
  );
  const policyById = new Map<string, DbRow>(
    ((policies as DbRow[]) ?? []).map((p) => [text(p.id), p])
  );
  const subscriberById = new Map<string, DbRow>(
    subscriberRows.map((s) => [text(s.id), s])
  );
  const payerById = new Map<string, DbRow>(
    ((payers as DbRow[]) ?? []).map((p) => [text(p.id), p])
  );
  const claimByAppt = new Map<string, DbRow>(
    ((claims as DbRow[]) ?? []).map((c) => [text(c.appointment_id), c])
  );

  // Crosswalk: claim.payer_profile_id -> payer_profiles.availity_payer_id, so
  // we can compare it against the policy's insurance_payers.payer_id (which
  // is the Availity payer code in text form). Without this crosswalk the
  // payer-mismatch tab is unreachable.
  const profileIds = [
    ...new Set(
      ((claims as DbRow[]) ?? [])
        .map((c) => text(c.payer_profile_id))
        .filter(Boolean)
    ),
  ];
  const payerProfileById = new Map<string, DbRow>();
  if (profileIds.length) {
    const { data: profiles } = await sb
      .from("payer_profiles")
      .select("id, availity_payer_id, payer_name")
      .in("id", profileIds);
    for (const p of ((profiles as DbRow[]) ?? [])) {
      payerProfileById.set(text(p.id), p);
    }
  }

  // Active policy counts per client (for COB detection).
  const policyCountByClient = new Map<string, number>();
  for (const p of ((allPoliciesForClients as DbRow[]) ?? [])) {
    if (p.archived_at) continue;
    if (p.active_flag === false) continue;
    const k = text(p.client_id);
    policyCountByClient.set(k, (policyCountByClient.get(k) ?? 0) + 1);
  }

  // Manually-verified flags + routing/assignment state, from audit_logs.
  // Latest-wins per (appointment, kind).
  const verifiedMap = new Map<string, string>();
  const holdMap = new Map<string, string>();
  type Assignment = {
    kind: "clinician" | "admin" | "biller";
    display: string;
    userId: string | null;
    email: string | null;
    routedByUserId: string | null;
    inboxItemId: string | null;
  };
  const assignedMap = new Map<string, Assignment>();
  const assignedBillerMap = new Map<string, string>();
  const followUpMap = new Map<string, string>();
  if (apptIds.length) {
    const { data: auditRows } = await sb
      .from("audit_logs")
      .select("appointment_id, action, event_summary, event_metadata, user_id, created_at")
      .eq("organization_id", organizationId)
      .in("appointment_id", apptIds)
      .in("action", [
        "eligibility_marked_verified",
        "claim_held_eligibility",
        "claim_released_eligibility",
        "eligibility_routed_clinician",
        "eligibility_routed_admin",
        "eligibility_assigned_biller",
        "eligibility_follow_up_set",
      ])
      .order("created_at", { ascending: false });
    for (const r of ((auditRows as DbRow[]) ?? [])) {
      const k = text(r.appointment_id);
      if (!k) continue;
      const action = text(r.action);
      const meta = (r.event_metadata as Record<string, unknown> | null) ?? {};
      if (action === "eligibility_marked_verified" && !verifiedMap.has(k)) {
        verifiedMap.set(k, text(r.created_at));
      }
      if (action === "claim_held_eligibility" && !holdMap.has(k)) {
        holdMap.set(k, text(r.event_summary));
      }
      if (action === "claim_released_eligibility" && holdMap.has(k)) {
        holdMap.delete(k);
      }
      if (action === "eligibility_routed_clinician" && !assignedMap.has(k)) {
        const staffId = text(meta.assignedToUserId);
        const providerId = text(meta.providerId);
        const display =
          text(meta.assignedToName) ||
          text(meta.assignedToDisplay) ||
          (providerId ? `Clinician ${providerId.slice(0, 8)}` : "Clinician");
        assignedMap.set(k, {
          kind: "clinician",
          display,
          userId: staffId || null,
          email: text(meta.assignedToEmail) || null,
          routedByUserId: text(meta.routedByUserId) || text(r.user_id) || null,
          inboxItemId: text(meta.inboxItemId) || null,
        });
      }
      if (action === "eligibility_routed_admin" && !assignedMap.has(k)) {
        const staffId = text(meta.assignedToUserId);
        const display =
          text(meta.assignedToName) || text(meta.assignedToDisplay) || "Admin pool";
        assignedMap.set(k, {
          kind: "admin",
          display,
          userId: staffId || null,
          email: text(meta.assignedToEmail) || null,
          routedByUserId: text(meta.routedByUserId) || text(r.user_id) || null,
          inboxItemId: text(meta.inboxItemId) || null,
        });
      }
      if (action === "eligibility_assigned_biller" && !assignedBillerMap.has(k)) {
        const billerId = text(meta.billerId) || text(r.user_id);
        if (billerId) assignedBillerMap.set(k, billerId);
      }
      if (action === "eligibility_follow_up_set" && !followUpMap.has(k)) {
        const due = text(meta.dueAt);
        if (due) followUpMap.set(k, due);
      }
    }
  }

  const rows: EligibilityIssueRow[] = [];
  for (const a of apptRows) {
    const apptId = text(a.id);
    const clientId = text(a.client_id);
    const policyId = text(a.insurance_policy_id);
    const client = clientById.get(clientId);
    const policy = policyId ? policyById.get(policyId) : undefined;
    const subscriber = policy ? subscriberById.get(text(policy.subscriber_id)) : undefined;
    const policyPayerId = policy ? text(policy.payer_id) : null;
    const payer = policyPayerId ? payerById.get(policyPayerId) : undefined;
    const check = latestByAppt.get(apptId);
    const claim = claimByAppt.get(apptId);

    // Skip if appt has been verified manually within last 7 days AND no
    // structural problem (terminated/missing subscriber).
    const verifiedAt = verifiedMap.get(apptId) ?? null;

    const claimProfile = claim ? payerProfileById.get(text(claim.payer_profile_id)) : undefined;
    const classification = classify({
      checkStatus: check ? text(check.eligibility_status) : null,
      checkedAt: check ? text(check.checked_at) || null : null,
      coverageEnd: check ? text(check.coverage_end_date) || null : (policy ? text(policy.termination_date) || null : null),
      policyTermination: policy ? text(policy.termination_date) || null : null,
      memberId: subscriber ? text(subscriber.member_id) : "",
      subscriberDob: subscriber ? text(subscriber.date_of_birth) || null : null,
      policyCount: policyCountByClient.get(clientId) ?? 0,
      checkPolicyId: check ? text(check.insurance_policy_id) || null : null,
      apptPolicyId: policyId || null,
      claimPayerAvailityId: claimProfile ? text(claimProfile.availity_payer_id) || null : null,
      policyPayerAvailityId: payer ? text(payer.payer_id) || null : null,
      responseSummary: check?.response_summary ?? null,
    });
    if (!classification) continue;

    // If verified within 7 days and not a hard structural issue, drop it.
    if (verifiedAt) {
      const verAge = daysBetween(verifiedAt) ?? 999;
      const hard = classification.type === "terminated_plan" || classification.type === "missing_subscriber_info";
      if (!hard && verAge <= 7) continue;
    }

    const firstName = text(client?.first_name);
    const lastName = text(client?.last_name);
    const clientName = `${lastName}, ${firstName}`.replace(/^,\s*$/, "") || "Unknown client";
    const checkedAt = check ? text(check.checked_at) || null : null;

    const assignment = assignedMap.get(apptId) ?? null;
    rows.push({
      id: apptId,
      appointmentId: apptId,
      eligibilityCheckId: check ? text(check.id) : null,
      insurancePolicyId: policyId || null,
      clientId,
      clientName,
      payerId: payer ? text(payer.payer_id) : null,
      payerName: payer ? text(payer.payer_name) : (policyPayerId ? "(unmapped payer)" : "—"),
      memberId: subscriber ? text(subscriber.member_id) : "",
      dateOfService: text(a.scheduled_start_at) || null,
      lastEligibilityCheck: checkedAt,
      eligibilityStatus: check ? text(check.eligibility_status) || "unknown" : "not_checked",
      issueType: classification.type,
      issueLabel: classification.label,
      copay: check ? num(check.copay_amount) : (policy ? num(policy.copay_amount) : null),
      deductible: check ? num(check.deductible_remaining) : null,
      effectiveDate: check ? text(check.coverage_start_date) || null : (policy ? text(policy.effective_date) || null : null),
      terminationDate: check ? text(check.coverage_end_date) || null : (policy ? text(policy.termination_date) || null : null),
      relatedClaimId: claim ? text(claim.id) : null,
      relatedClaimNumber: claim ? text(claim.claim_number) || null : null,
      relatedAppointmentStart: text(a.scheduled_start_at) || null,
      totalCharge: claim ? money(claim.total_charge) : 0,
      claimStatus: claim ? text(claim.claim_status) : null,
      daysSinceCheck: daysBetween(checkedAt),
      policyCount: policyCountByClient.get(clientId) ?? 0,
      manuallyVerifiedAt: verifiedAt,
      holdNote: holdMap.get(apptId) ?? null,
      providerId: text(a.provider_id) || null,
      practiceId: text(a.provider_location_id) || null,
      assignedTo: assignment ? assignment.display : null,
      assignedToKind: assignment ? assignment.kind : null,
      assignedToUserId: assignment ? assignment.userId : null,
      assignedToEmail: assignment ? assignment.email : null,
      routedByUserId: assignment ? assignment.routedByUserId : null,
      inboxItemId: assignment ? assignment.inboxItemId : null,
      assignedBillerId: assignedBillerMap.get(apptId) ?? null,
      followUpDueAt: followUpMap.get(apptId) ?? null,
      denialCode: claim ? carcRarcFromNotes(text(claim.billing_notes) || null) : null,
    });
  }

  return applyFilters(rows, filters, Date.now());
}
