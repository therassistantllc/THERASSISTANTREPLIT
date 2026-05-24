/**
 * GET /api/billing/paper-checks
 *
 * Paper Check workqueue list endpoint. Returns paper checks bucketed by
 * posting status into 5 tabs, plus tab counts and filter option lists.
 *
 * Tabs:
 *   - "new"        → posting_status = 'new'         (just received)
 *   - "deposited"  → posting_status = 'deposited'   (at the bank)
 *   - "posted"     → posting_status = 'posted'      (applied to claims)
 *   - "unmatched"  → posting_status = 'unmatched'   (cannot find claims)
 *   - "returned"   → posting_status in ('returned','void')
 *
 * Universal filter rail honored:
 *   practice, clinician, payer, client, dosFrom, dosTo, status,
 *   assignedBiller, minAmount, maxAmount, agingBucket, carcRarc,
 *   priority, followUpDue
 *
 * Returns { success, organizationId, items, tabCounts, payers, assignees, summary }.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;

export type PaperCheckTab = "new" | "deposited" | "posted" | "unmatched" | "returned";

const TAB_TO_STATUSES: Record<PaperCheckTab, string[]> = {
  new: ["new"],
  deposited: ["deposited"],
  posted: ["posted"],
  unmatched: ["unmatched"],
  returned: ["returned", "void"],
};

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

function bucketFor(age: number | null): "0-30" | "31-60" | "61-90" | "91-120" | "120+" {
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

    const { data: checkRows, error: checksError } = await (supabase as any)
      .from("paper_checks")
      .select(
        [
          "id",
          "payer_profile_id",
          "payer_name_snapshot",
          "check_number",
          "check_date",
          "amount",
          "received_date",
          "deposit_date",
          "posting_status",
          "scanned_check_url",
          "paper_eob_url",
          "deposit_notes",
          "assigned_to_user_id",
          "assigned_to_display_name",
          "priority",
          "follow_up_due_date",
          "created_at",
          "updated_at",
        ].join(", "),
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("received_date", { ascending: false });

    if (checksError) throw checksError;
    const checks = (checkRows ?? []) as DbRow[];
    const checkIds = checks.map((c) => text(c.id)).filter(Boolean);
    const payerIds = [
      ...new Set(checks.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];

    const [{ data: payerRows }, { data: matchRows }] = await Promise.all([
      payerIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name, office_ally_payer_id")
            .in("id", payerIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      checkIds.length
        ? (supabase as any)
            .from("paper_check_claim_matches")
            .select("paper_check_id, claim_id, applied_amount")
            .eq("organization_id", organizationId)
            .in("paper_check_id", checkIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const payerById = new Map<string, DbRow>(
      ((payerRows ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );

    const matchesByCheck = new Map<string, DbRow[]>();
    for (const m of (matchRows ?? []) as DbRow[]) {
      const key = text(m.paper_check_id);
      if (!key) continue;
      const arr = matchesByCheck.get(key) ?? [];
      arr.push(m);
      matchesByCheck.set(key, arr);
    }

    // Pull claim metadata for the matched claims (one batch).
    const matchedClaimIds = [
      ...new Set((matchRows ?? []).map((m: any) => text(m.claim_id)).filter(Boolean)),
    ];
    const { data: claimRows } = matchedClaimIds.length
      ? await (supabase as any)
          .from("professional_claims")
          .select(
            "id, claim_number, patient_id, total_charge, claim_status, rendering_provider_npi, rendering_provider_last_name_or_org, service_facility_name, denial_reason_code, appointment_id, first_billed_date, created_at",
          )
          .eq("organization_id", organizationId)
          .in("id", matchedClaimIds)
      : { data: [] as DbRow[] };
    const claimById = new Map<string, DbRow>(
      ((claimRows ?? []) as DbRow[]).map((c) => [text(c.id), c]),
    );

    // Patient names for matched claims (best-effort, single batch).
    const patientIds = [
      ...new Set(((claimRows ?? []) as DbRow[]).map((c) => text(c.patient_id)).filter(Boolean)),
    ];
    const { data: patientRows } = patientIds.length
      ? await supabase
          .from("clients")
          .select("id, first_name, last_name")
          .in("id", patientIds)
      : { data: [] as DbRow[] };
    const patientById = new Map<string, DbRow>(
      ((patientRows ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );

    type MatchOut = {
      claim_id: string;
      claim_number: string | null;
      patient_name: string | null;
      claim_status: string | null;
      total_charge: number;
      applied_amount: number;
      rendering_provider_npi: string | null;
      rendering_provider_name: string | null;
      service_facility_name: string | null;
      denial_reason_code: string | null;
      claim_age_days: number | null;
    };

    type Row = {
      id: string;
      payer_profile_id: string | null;
      payer_name: string | null;
      payer_id_external: string | null;
      check_number: string | null;
      check_date: string | null;
      amount: number;
      received_date: string | null;
      deposit_date: string | null;
      posting_status: string;
      scanned_check_url: string | null;
      paper_eob_url: string | null;
      deposit_notes: string | null;
      assigned_to_user_id: string | null;
      assigned_to_display_name: string | null;
      priority: string | null;
      follow_up_due_date: string | null;
      age_days: number | null;
      aging_bucket: string;
      matched_claims: MatchOut[];
      matched_total: number;
      created_at: string | null;
      updated_at: string | null;
    };

    const rowsAll: Row[] = checks.map((c) => {
      const id = text(c.id);
      const payerProfileId = text(c.payer_profile_id) || null;
      const payer = payerProfileId ? payerById.get(payerProfileId) : null;
      const matches = matchesByCheck.get(id) ?? [];
      const matchedClaims: MatchOut[] = matches.map((m) => {
        const claim = claimById.get(text(m.claim_id));
        const patient = claim ? patientById.get(text(claim.patient_id)) : null;
        const claimAgeBaseline =
          (claim?.first_billed_date as string | null) ??
          (claim?.created_at as string | null) ??
          null;
        return {
          claim_id: text(m.claim_id),
          claim_number: claim ? text(claim.claim_number) || null : null,
          patient_name: patient
            ? [patient.first_name, patient.last_name].map(text).filter(Boolean).join(" ") || null
            : null,
          claim_status: claim ? text(claim.claim_status) || null : null,
          total_charge: claim ? money(claim.total_charge) : 0,
          applied_amount: money(m.applied_amount),
          rendering_provider_npi: claim ? text(claim.rendering_provider_npi) || null : null,
          rendering_provider_name: claim
            ? text(claim.rendering_provider_last_name_or_org) || null
            : null,
          service_facility_name: claim ? text(claim.service_facility_name) || null : null,
          denial_reason_code: claim ? text(claim.denial_reason_code) || null : null,
          claim_age_days: daysSince(claimAgeBaseline),
        };
      });
      const age = daysSince((c.received_date as string | null) ?? null);
      return {
        id,
        payer_profile_id: payerProfileId,
        payer_name:
          (payer ? text(payer.payer_name) || null : null) ??
          (text(c.payer_name_snapshot) || null),
        payer_id_external: payer ? text(payer.office_ally_payer_id) || null : null,
        check_number: text(c.check_number) || null,
        check_date: (c.check_date as string | null) ?? null,
        amount: money(c.amount),
        received_date: (c.received_date as string | null) ?? null,
        deposit_date: (c.deposit_date as string | null) ?? null,
        posting_status: text(c.posting_status) || "new",
        scanned_check_url: text(c.scanned_check_url) || null,
        paper_eob_url: text(c.paper_eob_url) || null,
        deposit_notes: text(c.deposit_notes) || null,
        assigned_to_user_id: text(c.assigned_to_user_id) || null,
        assigned_to_display_name: text(c.assigned_to_display_name) || null,
        priority: text(c.priority) || null,
        follow_up_due_date: (c.follow_up_due_date as string | null) ?? null,
        age_days: age,
        aging_bucket: bucketFor(age),
        matched_claims: matchedClaims,
        matched_total: matchedClaims.reduce((s, m) => s + m.applied_amount, 0),
        created_at: (c.created_at as string | null) ?? null,
        updated_at: (c.updated_at as string | null) ?? null,
      };
    });

    // Tab counts (pre-filter).
    const tabCounts: Record<PaperCheckTab, number> = {
      new: 0,
      deposited: 0,
      posted: 0,
      unmatched: 0,
      returned: 0,
    };
    for (const r of rowsAll) {
      for (const tab of Object.keys(TAB_TO_STATUSES) as PaperCheckTab[]) {
        if (TAB_TO_STATUSES[tab].includes(r.posting_status)) tabCounts[tab] += 1;
      }
    }

    // ── Filters ─────────────────────────────────────────────────────────────
    const rawTab = searchParams.get("tab");
    const tab: PaperCheckTab | null =
      rawTab && rawTab in TAB_TO_STATUSES ? (rawTab as PaperCheckTab) : null;

    // Universal filter rail. practice / clinician / carcRarc don't exist on
    // a paper check directly, so they're matched against the check's matched
    // claims' metadata (service_facility_name, rendering provider NPI/name,
    // denial_reason_code). A check with no matches will not satisfy these.
    const filterClient = (searchParams.get("client") ?? "").toLowerCase().trim();
    const filterPayer = (searchParams.get("payer") ?? "").trim();
    const filterClinician = (searchParams.get("clinician") ?? "").toLowerCase().trim();
    const filterPractice = (searchParams.get("practice") ?? "").toLowerCase().trim();
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
      return d <= filterFollowUp;
    };

    const filtered = rowsAll.filter((r) => {
      if (tab && !TAB_TO_STATUSES[tab].includes(r.posting_status)) return false;
      if (filterPayer && r.payer_profile_id !== filterPayer) return false;
      if (filterAssigned) {
        if (filterAssigned === "__unassigned__") {
          if (r.assigned_to_user_id) return false;
        } else if (r.assigned_to_user_id !== filterAssigned) return false;
      }
      if (filterClient) {
        const hit = r.matched_claims.some(
          (m) => (m.patient_name ?? "").toLowerCase().includes(filterClient),
        );
        if (!hit) return false;
      }
      if (filterClinician) {
        const hit = r.matched_claims.some(
          (m) =>
            (m.rendering_provider_npi ?? "").toLowerCase().includes(filterClinician) ||
            (m.rendering_provider_name ?? "").toLowerCase().includes(filterClinician),
        );
        if (!hit) return false;
      }
      if (filterPractice) {
        const hit = r.matched_claims.some((m) =>
          (m.service_facility_name ?? "").toLowerCase().includes(filterPractice),
        );
        if (!hit) return false;
      }
      if (filterCarcRarc) {
        const hit = r.matched_claims.some((m) =>
          (m.denial_reason_code ?? "").toUpperCase().includes(filterCarcRarc),
        );
        if (!hit) return false;
      }
      if (filterStatus && r.posting_status !== filterStatus) return false;
      if (Number.isFinite(filterMin) && filterMin > 0 && r.amount < filterMin) return false;
      if (Number.isFinite(filterMax) && filterMax > 0 && r.amount > filterMax) return false;
      if (filterAging && r.aging_bucket !== filterAging) return false;
      if (filterPriority && r.priority !== filterPriority) return false;
      if (!inFollowUp(r.follow_up_due_date)) return false;
      // DOS filters apply against the check_date as a best-effort signal.
      if (filterDosFrom && (!r.check_date || r.check_date < filterDosFrom)) return false;
      if (filterDosTo && (!r.check_date || r.check_date > filterDosTo)) return false;
      return true;
    });

    // ── Summary metrics (apply to the active tab when set, else all-open) ─
    const summaryScope = tab
      ? rowsAll.filter((r) => TAB_TO_STATUSES[tab].includes(r.posting_status))
      : rowsAll.filter((r) => !TAB_TO_STATUSES.returned.includes(r.posting_status));

    const totalDollars = summaryScope.reduce((s, r) => s + r.amount, 0);
    // "Oldest age" = oldest claim age among matched claims, falling back to
    // check receipt age when a check has no matched claim yet. This lines up
    // with how billers think about queue urgency (an old claim still
    // unpaid).
    const oldestAge = summaryScope.reduce((m, r) => {
      const claimMax = r.matched_claims.reduce(
        (mm: number, c: any) =>
          c.claim_age_days != null && c.claim_age_days > mm ? c.claim_age_days : mm,
        0,
      );
      const ageForRow = claimMax > 0 ? claimMax : r.age_days ?? 0;
      return ageForRow > m ? ageForRow : m;
    }, 0);
    const urgentCount = summaryScope.filter(
      (r) =>
        r.priority === "urgent" ||
        (r.follow_up_due_date && r.follow_up_due_date < today) ||
        r.posting_status === "unmatched",
    ).length;

    const summary = {
      total_count: summaryScope.length,
      total_dollars: totalDollars,
      oldest_age_days: oldestAge,
      urgent_count: urgentCount,
    };

    // ── Filter option lists ────────────────────────────────────────────────
    const payersOpt = [...payerById.values()].map((p) => ({
      id: text(p.id),
      name: text(p.payer_name) || "Unnamed payer",
    }));

    const assigneeIds = [
      ...new Set(rowsAll.map((r) => r.assigned_to_user_id).filter((v): v is string => !!v)),
    ];
    const assignees = assigneeIds.map((id) => {
      const r = rowsAll.find((x) => x.assigned_to_user_id === id);
      return { id, displayName: r?.assigned_to_display_name || "Biller" };
    });

    return NextResponse.json({
      success: true,
      organizationId,
      items: filtered,
      tabCounts,
      summary,
      payers: payersOpt,
      assignees,
    });
  } catch (error) {
    console.error("Paper checks workqueue API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load paper checks",
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/billing/paper-checks
 *
 * Create a new paper check row (used by the "Add check" header action).
 */
export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const guard = await requireBillingAccess({
      requestedOrganizationId: typeof body.organizationId === "string" ? body.organizationId : null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const insertRow: Record<string, unknown> = {
      organization_id: organizationId,
      payer_profile_id:
        typeof body.payer_profile_id === "string" && body.payer_profile_id
          ? body.payer_profile_id
          : null,
      payer_name_snapshot:
        typeof body.payer_name === "string" ? body.payer_name.trim() || null : null,
      check_number: typeof body.check_number === "string" ? body.check_number.trim() : null,
      check_date: typeof body.check_date === "string" && body.check_date ? body.check_date : null,
      amount: money(body.amount),
      received_date:
        typeof body.received_date === "string" && body.received_date
          ? body.received_date
          : new Date().toISOString().slice(0, 10),
      posting_status: "new",
      created_by_user_id: guard.userId,
    };

    const { data, error } = await (supabase as any)
      .from("paper_checks")
      .insert(insertRow)
      .select("id")
      .single();
    if (error) throw error;

    await (supabase as any).from("paper_check_events").insert({
      organization_id: organizationId,
      paper_check_id: data.id,
      event_type: "created",
      message: "Paper check recorded",
      actor_user_id: guard.userId,
    });

    return NextResponse.json({ success: true, id: data.id });
  } catch (error) {
    console.error("Paper checks create error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create paper check",
      },
      { status: 500 },
    );
  }
}
