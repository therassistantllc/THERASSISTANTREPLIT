/**
 * GET /api/billing/aging
 *
 * Time-based claim follow-up workqueue. Returns every open claim
 * (submitted but not paid/voided), bucketed by age in days since
 * submission (or, for never-submitted open claims, since creation).
 *
 * Tabs (computed server-side, used as filters):
 *   - "0-30"   : age <= 30
 *   - "31-60"  : 31..60
 *   - "61-90"  : 61..90
 *   - "91-120" : 91..120
 *   - "120+"   : > 120
 *
 * Filter params honored (universal filter rail):
 *   tab, practice, clinician, payer, client, dosFrom, dosTo, status,
 *   assignedBiller, minAmount, maxAmount, agingBucket, carcRarc,
 *   priority, followUpDue
 *
 * Response shape:
 *   { success, organizationId, items, tabCounts, practices, clinicians, assignees }
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;

export type AgingTab = "0-30" | "31-60" | "61-90" | "91-120" | "120+";

const TAB_IDS: AgingTab[] = ["0-30", "31-60", "61-90", "91-120", "120+"];

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function bucketFor(age: number | null): AgingTab {
  const d = age ?? 0;
  if (d <= 30) return "0-30";
  if (d <= 60) return "31-60";
  if (d <= 90) return "61-90";
  if (d <= 120) return "91-120";
  return "120+";
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

    // Every open claim — submitted, accepted, partially-adjudicated, denied
    // (denied stays in aging until written off / appealed / resolved).
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
          "defer_until",
          "hold_follow_up_date",
          "hold_assigned_to_user_id",
          "hold_assigned_to_display_name",
          "hold_priority",
          "created_at",
        ].join(", "),
      )
      .eq("organization_id", organizationId)
      .in("claim_status", [
        "submitted",
        "accepted_oa",
        "accepted_payer",
        "denied",
        "rejected_payer",
      ])
      .is("archived_at", null);

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

    const [
      { data: clients },
      { data: payerProfiles },
      { data: serviceLines },
      { data: notes },
      { data: statusInquiries },
      { data: statusEvents },
      { data: eraPayments },
      { data: appointments },
      { data: workqueueRows },
    ] = await Promise.all([
      patientIds.length
        ? supabase
            .from("clients")
            .select("id, first_name, last_name")
            .in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerProfileIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name, office_ally_payer_id, notes")
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
            .from("claim_status_inquiries")
            .select("claim_id, status, status_code, received_at, created_at")
            .eq("organization_id", organizationId)
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_status_events")
            .select("claim_id, status, status_message, source, created_at")
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("era_claim_payments")
            .select(
              "professional_claim_id, clp04_payment_amount, clp02_claim_status_code, check_eft_number, check_issue_date, carc_codes, rarc_codes, created_at",
            )
            .eq("organization_id", organizationId)
            .in("professional_claim_id", claimIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as DbRow[] }),
      appointmentIds.length
        ? (supabase as any)
            .from("appointments")
            .select("id, provider_id, location_id")
            .in("id", appointmentIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_workqueue_items")
            .select(
              "claim_id, item_status, priority, group_code, action_taken, updated_at",
            )
            .eq("organization_id", organizationId)
            .in("claim_id", claimIds)
            .is("archived_at", null)
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
        from: prior.from && from ? (prior.from < from ? prior.from : from) : (prior.from ?? from),
        to: prior.to && to ? (prior.to > to ? prior.to : to) : (prior.to ?? to),
      });
    }

    const notesByClaim = new Map<string, DbRow[]>();
    for (const note of (notes ?? []) as DbRow[]) {
      const key = text(note.claim_id);
      if (!key) continue;
      const arr = notesByClaim.get(key) ?? [];
      arr.push(note);
      notesByClaim.set(key, arr);
    }

    const statusByClaim = new Map<string, DbRow>();
    for (const s of (statusInquiries ?? []) as DbRow[]) {
      const key = text(s.claim_id);
      if (!key || statusByClaim.has(key)) continue;
      statusByClaim.set(key, s);
    }

    // Track the most-recent biller-source claim_status_event per claim — we
    // use it for "last follow-up".
    const lastFollowupByClaim = new Map<string, DbRow>();
    for (const ev of (statusEvents ?? []) as DbRow[]) {
      const key = text(ev.claim_id);
      if (!key) continue;
      if (text(ev.source) !== "biller") continue;
      if (lastFollowupByClaim.has(key)) continue;
      lastFollowupByClaim.set(key, ev);
    }

    const erasByClaim = new Map<string, DbRow[]>();
    const carcByClaim = new Map<string, Set<string>>();
    const rarcByClaim = new Map<string, Set<string>>();
    for (const p of (eraPayments ?? []) as DbRow[]) {
      const key = text(p.professional_claim_id);
      if (!key) continue;
      const arr = erasByClaim.get(key) ?? [];
      arr.push(p);
      erasByClaim.set(key, arr);
      for (const c of (p.carc_codes as string[] | null) ?? []) {
        if (!c) continue;
        const s = carcByClaim.get(key) ?? new Set<string>();
        s.add(String(c));
        carcByClaim.set(key, s);
      }
      for (const r of (p.rarc_codes as string[] | null) ?? []) {
        if (!r) continue;
        const s = rarcByClaim.get(key) ?? new Set<string>();
        s.add(String(r));
        rarcByClaim.set(key, s);
      }
    }

    const wqByClaim = new Map<string, DbRow>();
    for (const w of (workqueueRows ?? []) as DbRow[]) {
      const key = text(w.claim_id);
      if (!key) continue;
      // prefer the most-recently-updated
      const prior = wqByClaim.get(key);
      if (!prior) {
        wqByClaim.set(key, w);
        continue;
      }
      const a = text(prior.updated_at);
      const b = text(w.updated_at);
      if (b > a) wqByClaim.set(key, w);
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
      service_date_from: string | null;
      service_date_to: string | null;
      submitted_at: string | null;
      age_days: number | null;
      total_charge: number;
      balance: number;
      defer_until: string | null;
      follow_up_due_date: string | null;
      assigned_to_user_id: string | null;
      assigned_to_display_name: string | null;
      priority: string | null;
      clinician_id: string | null;
      practice_location_id: string | null;
      last_status: string;
      last_status_at: string | null;
      last_followup_at: string | null;
      last_followup_message: string | null;
      next_action: string;
      bucket: AgingTab;
      carc_codes: string[];
      rarc_codes: string[];
      era_count: number;
      eras: Array<{
        paid: number;
        clp02: string | null;
        check_eft_number: string | null;
        check_issue_date: string | null;
        created_at: string;
      }>;
      wq_status: string | null;
    };

    const rows: Row[] = claims.map((claim) => {
      const id = text(claim.id);
      const client = patientById.get(text(claim.patient_id));
      const patientName = client
        ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") ||
          "Unknown client"
        : "Unknown client";
      const payer = payerById.get(text(claim.payer_profile_id));
      const dates = serviceLinesByClaim.get(id) ?? { from: null, to: null };
      const claimNotes = notesByClaim.get(id) ?? [];
      const submittedAt =
        (claim.submitted_at as string | null) ??
        (claim.first_billed_date as string | null) ??
        null;

      const lastStatus = statusByClaim.get(id);
      const lastEvent = lastFollowupByClaim.get(id);
      const eras = erasByClaim.get(id) ?? [];
      const paid = eras.reduce(
        (s, e) => s + Number((e.clp04_payment_amount as number | string | null) ?? 0),
        0,
      );
      const charge = money(claim.total_charge);
      const balance = Math.max(0, charge - paid);

      const followUpDue =
        (claim.hold_follow_up_date as string | null) ??
        (claim.defer_until as string | null) ??
        null;
      const status = text(claim.claim_status) || "submitted";
      const wq = wqByClaim.get(id);

      const lastKnownStatus = lastStatus
        ? `${text(lastStatus.status)}${
            lastStatus.status_code ? ` (${text(lastStatus.status_code)})` : ""
          }`
        : status;

      const age = daysSince(submittedAt);
      const bucket = bucketFor(age);

      // Suggest a next action based on current state.
      let nextAction: string;
      if (followUpDue && followUpDue < today) nextAction = "Follow-up overdue";
      else if (status === "denied" || status === "rejected_payer") nextAction = "Move to appeal";
      else if ((age ?? 0) > 60 && !lastStatus) nextAction = "Run claim status";
      else if ((age ?? 0) > 30) nextAction = "Call payer";
      else nextAction = "Monitor";

      const appt = apptById.get(text(claim.appointment_id));
      const clinicianFromAppt = appt ? text(appt.provider_id) || null : null;
      const practiceLocationId = appt ? text(appt.location_id) || null : null;

      void claimNotes;

      return {
        id,
        claim_number: text(claim.claim_number) || null,
        claim_status: status,
        patient_id: text(claim.patient_id) || null,
        patient_name: patientName,
        payer_profile_id: text(claim.payer_profile_id) || null,
        payer_name: payer ? text(payer.payer_name) || null : null,
        payer_id_external: payer ? text(payer.office_ally_payer_id) || null : null,
        payer_notes: payer ? text(payer.notes) || null : null,
        service_date_from: dates.from,
        service_date_to: dates.to,
        submitted_at: submittedAt,
        age_days: age,
        total_charge: charge,
        balance,
        defer_until: (claim.defer_until as string | null) ?? null,
        follow_up_due_date: followUpDue,
        assigned_to_user_id: text(claim.hold_assigned_to_user_id) || null,
        assigned_to_display_name: text(claim.hold_assigned_to_display_name) || null,
        priority: text(claim.hold_priority) || (wq ? text(wq.priority) || null : null),
        clinician_id: clinicianFromAppt,
        practice_location_id: practiceLocationId,
        last_status: lastKnownStatus,
        last_status_at: lastStatus
          ? text(lastStatus.received_at) || text(lastStatus.created_at) || null
          : null,
        last_followup_at: lastEvent ? text(lastEvent.created_at) || null : null,
        last_followup_message: lastEvent ? text(lastEvent.status_message) || null : null,
        next_action: nextAction,
        bucket,
        carc_codes: [...(carcByClaim.get(id) ?? [])],
        rarc_codes: [...(rarcByClaim.get(id) ?? [])],
        era_count: eras.length,
        eras: eras
          .map((e) => ({
            paid: Number((e.clp04_payment_amount as number | string | null) ?? 0),
            clp02: (e.clp02_claim_status_code as string | null) ?? null,
            check_eft_number: (e.check_eft_number as string | null) ?? null,
            check_issue_date: (e.check_issue_date as string | null) ?? null,
            created_at: text(e.created_at),
          }))
          .sort((a, b) => (b.created_at > a.created_at ? 1 : -1)),
        wq_status: wq ? text(wq.item_status) || null : null,
      };
    });

    // Drop rows already marked resolved.
    const open = rows.filter((r) => r.wq_status !== "resolved");

    // Tab counts before filtering.
    const tabCounts: Record<AgingTab, number> = {
      "0-30": 0,
      "31-60": 0,
      "61-90": 0,
      "91-120": 0,
      "120+": 0,
    };
    for (const r of open) tabCounts[r.bucket] += 1;

    // Filters
    const rawTab = searchParams.get("tab");
    const tab: AgingTab | null =
      rawTab && (TAB_IDS as string[]).includes(rawTab) ? (rawTab as AgingTab) : null;

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

    const inAgingBucket = (b: AgingTab): boolean => {
      if (!filterAging) return true;
      return b === (filterAging as AgingTab);
    };

    const inFollowUp = (d: string | null) => {
      if (!filterFollowUp) return true;
      if (!d) return false;
      if (filterFollowUp === "overdue") return d < today;
      if (filterFollowUp === "today") return d === today;
      if (filterFollowUp === "week") {
        const wk = new Date();
        wk.setDate(wk.getDate() + 7);
        return d >= today && d <= wk.toISOString().slice(0, 10);
      }
      return true;
    };

    const filtered = open.filter((r) => {
      if (tab && r.bucket !== tab) return false;
      if (filterClient && !r.patient_name.toLowerCase().includes(filterClient)) return false;
      if (filterPayer && r.payer_profile_id !== filterPayer) return false;
      if (filterClinician && r.clinician_id !== filterClinician) return false;
      if (filterPractice && r.practice_location_id !== filterPractice) return false;
      if (filterAssigned) {
        if (filterAssigned === "__unassigned__") {
          if (r.assigned_to_user_id) return false;
        } else if (r.assigned_to_user_id !== filterAssigned) return false;
      }
      const dosFrom = r.service_date_from ?? r.service_date_to;
      if (filterDosFrom && (!dosFrom || dosFrom < filterDosFrom)) return false;
      if (filterDosTo && (!dosFrom || dosFrom > filterDosTo)) return false;
      if (filterStatus && r.claim_status !== filterStatus) return false;
      if (Number.isFinite(filterMin) && filterMin > 0 && r.total_charge < filterMin) return false;
      if (Number.isFinite(filterMax) && filterMax > 0 && r.total_charge > filterMax) return false;
      if (!inAgingBucket(r.bucket)) return false;
      if (filterCarcRarc) {
        const all = [...r.carc_codes, ...r.rarc_codes].map((c) => c.toUpperCase());
        if (!all.some((c) => c.includes(filterCarcRarc))) return false;
      }
      if (filterPriority && r.priority !== filterPriority) return false;
      if (!inFollowUp(r.follow_up_due_date)) return false;
      return true;
    });

    // Filter options
    const practiceIds = [
      ...new Set(open.map((r) => r.practice_location_id).filter((v): v is string => !!v)),
    ];
    const clinicianIds = [
      ...new Set(open.map((r) => r.clinician_id).filter((v): v is string => !!v)),
    ];
    const assigneeIds = [
      ...new Set(
        open.map((r) => r.assigned_to_user_id).filter((v): v is string => !!v),
      ),
    ];

    const [{ data: practiceRows }, { data: clinicianRows }] = await Promise.all([
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
    const assignees = assigneeIds.map((id) => {
      const row = open.find((r) => r.assigned_to_user_id === id);
      return { id, displayName: row?.assigned_to_display_name || "Biller" };
    });

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
    console.error("Aging workqueue API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load aging worklist",
      },
      { status: 500 },
    );
  }
}
