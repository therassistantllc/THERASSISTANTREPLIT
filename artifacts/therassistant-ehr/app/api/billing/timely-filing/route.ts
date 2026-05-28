/**
 * GET /api/billing/timely-filing
 *
 * "Timely Filing Risk" workqueue: claims whose filing/appeal/corrected
 * deadlines are approaching or expired.
 *
 * Tabs (server-classified):
 *   - remaining_0_15   : unfiled, 0–15 days until filing deadline
 *   - remaining_16_30  : unfiled, 16–30 days until filing deadline
 *   - expired          : unfiled, filing deadline already passed
 *   - appeal_risk      : denied claims with appeal_deadline_date in next 30d
 *   - corrected_risk   : denied claims whose corrected-claim window closes soon
 *
 * Filter params (universal rail):
 *   tab, practice, clinician, payer, client, dosFrom, dosTo, status,
 *   assignedBiller, minAmount, maxAmount, agingBucket, carcRarc, priority,
 *   followUpDue
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import {
  addDaysISO,
  daysBetweenISO,
  DEFAULT_APPEAL_DEADLINE_DAYS,
  DEFAULT_CORRECTED_CLAIM_DAYS,
  DEFAULT_TIMELY_FILING_DAYS,
  reasonNotFiled,
  readAppealDeadlineDays,
  readCorrectedClaimDays,
  readTimelyFilingDays,
  TIMELY_FILING_TABS,
  UNFILED_STATUSES,
  type TimelyFilingTab,
} from "@/lib/billing/timelyFiling";

type DbRow = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const money = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const TAB_IDS = TIMELY_FILING_TABS.map((t) => t.id) as TimelyFilingTab[];

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function classifyPriority(daysRemaining: number | null, isExpired: boolean): string {
  if (isExpired) return "urgent";
  if (daysRemaining == null) return "normal";
  if (daysRemaining <= 7) return "urgent";
  if (daysRemaining <= 15) return "high";
  if (daysRemaining <= 30) return "normal";
  return "low";
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const today = new Date().toISOString().slice(0, 10);

    // 1) Pull claims that could possibly be at risk: anything not finalized.
    const { data: claimRows, error: claimsError } = await (supabase as any)
      .from("professional_claims")
      .select(
        [
          "id",
          "claim_number",
          "claim_status",
          "patient_id",
          "payer_profile_id",
          "appointment_id",
          "total_charge",
          "submitted_at",
          "first_billed_date",
          "last_billed_date",
          "appeal_deadline_date",
          "appeal_submitted_at",
          "denial_reason_code",
          "denial_reason_description",
          "created_at",
          "updated_at",
        ].join(", "),
      )
      .eq("organization_id", organizationId)
      .in("claim_status", [
        "draft",
        "validation_errors",
        "validation_failed",
        "ready_for_batch",
        "on_hold",
        "claim_hold",
        "documentation_pending",
        "needs_authorization",
        "rejected_oa",
        "rejected_payer",
        "denied",
      ])
      .is("archived_at", null)
      .order("created_at", { ascending: true });

    if (claimsError) throw claimsError;

    const claims = (claimRows ?? []) as DbRow[];
    const claimIds = claims.map((c) => text(c.id)).filter(Boolean);
    const patientIds = [
      ...new Set(claims.map((c) => text(c.patient_id)).filter(Boolean)),
    ];
    const payerProfileIds = [
      ...new Set(claims.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];
    const appointmentIds = [
      ...new Set(claims.map((c) => text(c.appointment_id)).filter(Boolean)),
    ];

    // 2) Joins
    const [
      { data: clients },
      { data: payerProfiles },
      { data: serviceLines },
      { data: notes },
      { data: workqueueItems },
      { data: appointments },
    ] = await Promise.all([
      patientIds.length
        ? (supabase as any)
            .from("clients")
            .select("id, first_name, last_name")
            .in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerProfileIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select(
              "id, payer_name, availity_payer_id, billing_rules, notes",
            )
            .in("id", payerProfileIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claim_service_lines")
            .select("claim_id, service_date_from, service_date_to")
            .in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_notes")
            .select("claim_id, body, created_at, author_display_name")
            .eq("organization_id", organizationId)
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_workqueue_items")
            .select(
              "claim_id, item_status, priority, assigned_to_user_id, defer_until, carc_code, rarc_code, denial_reason",
            )
            .eq("organization_id", organizationId)
            .in("claim_id", claimIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as DbRow[] }),
      appointmentIds.length
        ? (supabase as any)
            .from("appointments")
            .select("id, provider_id, location_id")
            .in("id", appointmentIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const patientById = new Map<string, DbRow>(
      ((clients ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payerProfiles ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const apptById = new Map<string, DbRow>(
      ((appointments ?? []) as DbRow[]).map((a) => [text(a.id), a]),
    );

    const serviceLinesByClaim = new Map<
      string,
      { from: string | null; to: string | null }
    >();
    for (const line of (serviceLines ?? []) as DbRow[]) {
      const key = text(line.claim_id);
      if (!key) continue;
      const from = (line.service_date_from as string | null) ?? null;
      const to = (line.service_date_to as string | null) ?? null;
      const prior = serviceLinesByClaim.get(key);
      if (!prior) {
        serviceLinesByClaim.set(key, { from, to });
        continue;
      }
      serviceLinesByClaim.set(key, {
        from:
          prior.from && from
            ? prior.from < from
              ? prior.from
              : from
            : (prior.from ?? from),
        to:
          prior.to && to
            ? prior.to > to
              ? prior.to
              : to
            : (prior.to ?? to),
      });
    }

    const notesByClaim = new Map<string, DbRow[]>();
    for (const n of (notes ?? []) as DbRow[]) {
      const key = text(n.claim_id);
      if (!key) continue;
      const arr = notesByClaim.get(key) ?? [];
      arr.push(n);
      notesByClaim.set(key, arr);
    }

    const wqByClaim = new Map<string, DbRow>();
    for (const w of (workqueueItems ?? []) as DbRow[]) {
      const key = text(w.claim_id);
      if (!key || wqByClaim.has(key)) continue;
      wqByClaim.set(key, w);
    }

    type Row = {
      id: string;
      claim_number: string | null;
      claim_status: string | null;
      patient_id: string | null;
      patient_name: string;
      payer_profile_id: string | null;
      payer_name: string | null;
      payer_id_external: string | null;
      payer_notes: string | null;
      payer_timely_filing_days: number | null;
      payer_appeal_deadline_days: number | null;
      payer_corrected_claim_days: number | null;
      service_date_from: string | null;
      service_date_to: string | null;
      filing_deadline: string | null;
      days_remaining: number | null;
      expired: boolean;
      appeal_deadline_date: string | null;
      appeal_days_remaining: number | null;
      corrected_deadline: string | null;
      corrected_days_remaining: number | null;
      total_charge: number;
      reason_not_filed: string;
      denial_reason_code: string | null;
      denial_reason_description: string | null;
      first_billed_date: string | null;
      submitted_at: string | null;
      assigned_to_user_id: string | null;
      assigned_to_display_name: string | null;
      priority: string;
      clinician_id: string | null;
      practice_location_id: string | null;
      note_count: number;
      latest_note_excerpt: string | null;
      latest_note_at: string | null;
      tab: TimelyFilingTab;
      carc_code: string | null;
      rarc_code: string | null;
      days_outstanding: number | null;
      follow_up_due_date: string | null;
    };

    const rows: Row[] = [];

    for (const claim of claims) {
      const id = text(claim.id);
      const status = text(claim.claim_status).toLowerCase();
      const client = patientById.get(text(claim.patient_id));
      const patientName = client
        ? [client.first_name, client.last_name]
            .map(text)
            .filter(Boolean)
            .join(" ") || "Unknown client"
        : "Unknown client";
      const payer = payerById.get(text(claim.payer_profile_id));
      const dates = serviceLinesByClaim.get(id) ?? { from: null, to: null };
      const oldestDos = dates.from ?? dates.to ?? null;

      const payerTfd =
        readTimelyFilingDays(payer?.billing_rules) ?? DEFAULT_TIMELY_FILING_DAYS;
      const payerAppealDays =
        readAppealDeadlineDays(payer?.billing_rules) ?? DEFAULT_APPEAL_DEADLINE_DAYS;
      const payerCorrectedDays =
        readCorrectedClaimDays(payer?.billing_rules) ?? DEFAULT_CORRECTED_CLAIM_DAYS;
      const filingDeadline = oldestDos ? addDaysISO(oldestDos, payerTfd) : null;
      const daysRemaining = filingDeadline
        ? daysBetweenISO(today, filingDeadline)
        : null;
      const expired = daysRemaining != null && daysRemaining < 0;

      const appealDeadline = (claim.appeal_deadline_date as string | null) ?? null;
      const appealDaysRemaining = appealDeadline
        ? daysBetweenISO(today, appealDeadline)
        : null;

      // Corrected-claim window = first_billed_date + payer's corrected_claim_days
      // (falls back to org default when the payer hasn't configured one).
      const firstBilled = (claim.first_billed_date as string | null) ?? null;
      const correctedDeadline = firstBilled
        ? addDaysISO(firstBilled, payerCorrectedDays)
        : null;
      const correctedDaysRemaining = correctedDeadline
        ? daysBetweenISO(today, correctedDeadline)
        : null;

      const claimNotes = notesByClaim.get(id) ?? [];
      const latest = claimNotes[0];
      const latestBody = latest ? text(latest.body) : "";
      const excerpt =
        latestBody.length > 120 ? `${latestBody.slice(0, 117)}…` : latestBody || null;

      const wq = wqByClaim.get(id);
      const appt = apptById.get(text(claim.appointment_id));

      // Classification: assign to the most urgent applicable tab.
      let tab: TimelyFilingTab | null = null;
      const isUnfiled = UNFILED_STATUSES.has(status);
      const isDenied = status === "denied";

      if (isUnfiled && filingDeadline) {
        if (expired) tab = "expired";
        else if (daysRemaining! <= 15) tab = "remaining_0_15";
        else if (daysRemaining! <= 30) tab = "remaining_16_30";
      }

      if (
        !tab &&
        isDenied &&
        appealDeadline &&
        appealDaysRemaining != null &&
        appealDaysRemaining <= 30
      ) {
        tab = "appeal_risk";
      }

      if (
        !tab &&
        isDenied &&
        correctedDeadline &&
        correctedDaysRemaining != null &&
        correctedDaysRemaining <= 30
      ) {
        tab = "corrected_risk";
      }

      // Also surface denied claims with a synthesized appeal deadline so the
      // queue isn't empty when payer hasn't populated appeal_deadline_date.
      if (!tab && isDenied && firstBilled) {
        const synthAppealDeadline = addDaysISO(firstBilled, payerAppealDays);
        const synthAppealDays = daysBetweenISO(today, synthAppealDeadline);
        if (synthAppealDays <= 30) {
          tab = "appeal_risk";
        }
      }

      if (!tab) continue; // claim isn't at risk yet

      rows.push({
        id,
        claim_number: text(claim.claim_number) || null,
        claim_status: text(claim.claim_status) || null,
        patient_id: text(claim.patient_id) || null,
        patient_name: patientName,
        payer_profile_id: text(claim.payer_profile_id) || null,
        payer_name: payer ? text(payer.payer_name) || null : null,
        payer_id_external: payer
          ? text(payer.availity_payer_id) || null
          : null,
        payer_notes: payer ? text(payer.notes) || null : null,
        payer_timely_filing_days: payerTfd,
        payer_appeal_deadline_days: payerAppealDays,
        payer_corrected_claim_days: payerCorrectedDays,
        service_date_from: dates.from,
        service_date_to: dates.to,
        filing_deadline: filingDeadline,
        days_remaining: daysRemaining,
        expired,
        appeal_deadline_date: appealDeadline,
        appeal_days_remaining: appealDaysRemaining,
        corrected_deadline: correctedDeadline,
        corrected_days_remaining: correctedDaysRemaining,
        total_charge: money(claim.total_charge),
        reason_not_filed: reasonNotFiled(text(claim.claim_status)),
        denial_reason_code: text(claim.denial_reason_code) || null,
        denial_reason_description:
          text(claim.denial_reason_description) || null,
        first_billed_date: firstBilled,
        submitted_at: (claim.submitted_at as string | null) ?? null,
        assigned_to_user_id: wq ? text(wq.assigned_to_user_id) || null : null,
        assigned_to_display_name: null,
        priority:
          wq && text(wq.priority)
            ? text(wq.priority)
            : classifyPriority(daysRemaining, expired),
        clinician_id: appt ? text(appt.provider_id) || null : null,
        practice_location_id: appt ? text(appt.location_id) || null : null,
        note_count: claimNotes.length,
        latest_note_excerpt: excerpt,
        latest_note_at: latest ? text(latest.created_at) || null : null,
        tab,
        carc_code: wq ? text(wq.carc_code) || null : null,
        rarc_code: wq ? text(wq.rarc_code) || null : null,
        days_outstanding: daysSince(
          (claim.submitted_at as string | null) ??
            (claim.first_billed_date as string | null) ??
            (claim.created_at as string | null),
        ),
        follow_up_due_date: wq ? (wq.defer_until as string | null) ?? null : null,
      });
    }

    // Tab counts before filtering
    const tabCounts: Record<TimelyFilingTab, number> = {
      remaining_0_15: 0,
      remaining_16_30: 0,
      expired: 0,
      appeal_risk: 0,
      corrected_risk: 0,
    };
    for (const r of rows) tabCounts[r.tab] += 1;

    // 4) Apply filters
    const rawTab = searchParams.get("tab");
    const tab: TimelyFilingTab | null =
      rawTab && (TAB_IDS as string[]).includes(rawTab)
        ? (rawTab as TimelyFilingTab)
        : null;

    const filterClient = (searchParams.get("client") ?? "").toLowerCase().trim();
    const filterPayer = (searchParams.get("payer") ?? "").trim();
    const filterClinician = (searchParams.get("clinician") ?? "").trim();
    const filterPractice = (searchParams.get("practice") ?? "").trim();
    const filterAssigned = (searchParams.get("assignedBiller") ?? "").trim();
    const filterDosFrom = (searchParams.get("dosFrom") ?? "").trim();
    const filterDosTo = (searchParams.get("dosTo") ?? "").trim();
    const filterStatus = (searchParams.get("status") ?? "").trim();
    const filterMin = Number(searchParams.get("minAmount") ?? "");
    const filterMax = Number(searchParams.get("maxAmount") ?? "");
    const filterAging = (searchParams.get("agingBucket") ?? "").trim();
    const filterCarcRarc = (searchParams.get("carcRarc") ?? "").trim().toUpperCase();
    const filterPriority = (searchParams.get("priority") ?? "").trim();
    const filterFollowUp = (searchParams.get("followUpDue") ?? "").trim();

    const inAgingBucket = (d: number | null) => {
      if (d == null) return false;
      switch (filterAging) {
        case "0-30":
          return d <= 30;
        case "31-60":
          return d > 30 && d <= 60;
        case "61-90":
          return d > 60 && d <= 90;
        case "91-120":
          return d > 90 && d <= 120;
        case "120+":
          return d > 120;
        default:
          return true;
      }
    };

    const inFollowUpBucket = (d: string | null) => {
      if (!d) return !filterFollowUp;
      if (filterFollowUp === "overdue") return d < today;
      if (filterFollowUp === "today") return d === today;
      if (filterFollowUp === "week") {
        const wk = new Date();
        wk.setDate(wk.getDate() + 7);
        return d >= today && d <= wk.toISOString().slice(0, 10);
      }
      return true;
    };

    const filtered = rows.filter((r) => {
      if (tab && r.tab !== tab) return false;
      if (filterClient && !r.patient_name.toLowerCase().includes(filterClient))
        return false;
      if (
        filterPayer &&
        r.payer_profile_id !== filterPayer &&
        r.payer_name !== filterPayer
      )
        return false;
      if (filterClinician && r.clinician_id !== filterClinician) return false;
      if (filterPractice && r.practice_location_id !== filterPractice)
        return false;
      if (filterAssigned) {
        if (filterAssigned === "__unassigned__") {
          if (r.assigned_to_user_id) return false;
        } else if (r.assigned_to_user_id !== filterAssigned) return false;
      }
      const dosFrom = r.service_date_from ?? r.service_date_to;
      if (filterDosFrom && (!dosFrom || dosFrom < filterDosFrom)) return false;
      if (filterDosTo && (!dosFrom || dosFrom > filterDosTo)) return false;
      if (filterStatus && r.claim_status !== filterStatus) return false;
      if (Number.isFinite(filterMin) && filterMin > 0 && r.total_charge < filterMin)
        return false;
      if (Number.isFinite(filterMax) && filterMax > 0 && r.total_charge > filterMax)
        return false;
      if (filterAging && !inAgingBucket(r.days_outstanding)) return false;
      if (filterCarcRarc) {
        const carc = (r.carc_code ?? "").toUpperCase();
        const rarc = (r.rarc_code ?? "").toUpperCase();
        if (!carc.includes(filterCarcRarc) && !rarc.includes(filterCarcRarc))
          return false;
      }
      if (filterPriority && r.priority !== filterPriority) return false;
      if (filterFollowUp && !inFollowUpBucket(r.follow_up_due_date)) return false;
      return true;
    });

    // Sort: most urgent first within the requested view
    filtered.sort((a, b) => {
      const ad = a.days_remaining ?? Number.MAX_SAFE_INTEGER;
      const bd = b.days_remaining ?? Number.MAX_SAFE_INTEGER;
      return ad - bd;
    });

    // 5) Filter-rail option data
    const practiceIds = [
      ...new Set(
        rows.map((r) => r.practice_location_id).filter((v): v is string => !!v),
      ),
    ];
    const clinicianIds = [
      ...new Set(rows.map((r) => r.clinician_id).filter((v): v is string => !!v)),
    ];
    const assigneeIds = [
      ...new Set(
        rows.map((r) => r.assigned_to_user_id).filter((v): v is string => !!v),
      ),
    ];

    const [
      { data: practiceRows },
      { data: clinicianRows },
      { data: assigneeRows },
    ] = await Promise.all([
      practiceIds.length
        ? (supabase as any)
            .from("practice_locations")
            .select("id, name")
            .in("id", practiceIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      clinicianIds.length
        ? (supabase as any)
            .from("staff_profiles")
            .select("id, first_name, last_name, email")
            .in("id", clinicianIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      assigneeIds.length
        ? (supabase as any)
            .from("staff_profiles")
            .select("id, first_name, last_name, email")
            .in("id", assigneeIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const practices = ((practiceRows ?? []) as DbRow[]).map((p) => ({
      id: text(p.id),
      name: text(p.name) || "Unnamed practice",
    }));
    const clinicians = ((clinicianRows ?? []) as DbRow[]).map((c) => ({
      id: text(c.id),
      displayName:
        [c.first_name, c.last_name].map(text).filter(Boolean).join(" ") ||
        text(c.email) ||
        "Unnamed clinician",
    }));
    const assigneeMap = new Map(
      ((assigneeRows ?? []) as DbRow[]).map((s) => [
        text(s.id),
        [s.first_name, s.last_name].map(text).filter(Boolean).join(" ") ||
          text(s.email) ||
          "Biller",
      ]),
    );
    const assignees = assigneeIds.map((id) => ({
      id,
      displayName: assigneeMap.get(id) ?? "Biller",
    }));

    // Hydrate assigned_to_display_name on filtered rows
    for (const r of filtered) {
      if (r.assigned_to_user_id) {
        r.assigned_to_display_name = assigneeMap.get(r.assigned_to_user_id) ?? null;
      }
    }

    return NextResponse.json({
      success: true,
      organizationId,
      items: filtered,
      tabCounts,
      practices,
      clinicians,
      assignees,
    });
  } catch (error) {
    console.error("Timely Filing API error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load timely filing worklist",
      },
      { status: 500 },
    );
  }
}
