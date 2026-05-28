/**
 * /api/billing/claim-hold
 *
 * GET — list claims currently on hold for the Claim Hold workqueue.
 *
 * Accepts the universal workqueue filter rail as query params and
 * applies them server-side:
 *   organizationId, category (tab), practice, clinician, payer,
 *   client, dosFrom, dosTo, status, assignedBiller, minAmount,
 *   maxAmount, agingBucket, carcRarc, priority, followUpDue.
 *
 * Returns rows keyed by professional_claims.id with the spec's
 * columns (Client, Claim ID, Payer, DOS, Charge amount, Hold reason,
 * Held by, Hold date, Follow-up date, Assigned to, Days on hold)
 * plus the hold_category that drives the tab grouping.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, any>;

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const HOLD_CATEGORIES = new Set([
  "manual",
  "documentation",
  "eligibility",
  "auth",
  "compliance",
  "payer_rule",
]);

const HOLD_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
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

    const filter = {
      category: text(searchParams.get("category")),
      practice: text(searchParams.get("practice")),
      clinician: text(searchParams.get("clinician")),
      payer: text(searchParams.get("payer")),
      client: text(searchParams.get("client")),
      dosFrom: text(searchParams.get("dosFrom")),
      dosTo: text(searchParams.get("dosTo")),
      status: text(searchParams.get("status")), // matches hold_priority lane
      assignedBiller: text(searchParams.get("assignedBiller")),
      minAmount: text(searchParams.get("minAmount")),
      maxAmount: text(searchParams.get("maxAmount")),
      agingBucket: text(searchParams.get("agingBucket")),
      carcRarc: text(searchParams.get("carcRarc")),
      priority: text(searchParams.get("priority")),
      followUpDue: text(searchParams.get("followUpDue")),
    };

    // ── Build the base query, applying everything we can push down. ──
    let q: any = (supabase as any)
      .from("professional_claims")
      .select(
        [
          "id",
          "claim_number",
          "patient_id",
          "payer_profile_id",
          "appointment_id",
          "encounter_id",
          "total_charge",
          "hold_category",
          "hold_reason",
          "held_by_user_id",
          "held_by_display_name",
          "hold_started_at",
          "hold_follow_up_date",
          "hold_assigned_to_user_id",
          "hold_assigned_to_display_name",
          "hold_priority",
          "updated_at",
        ].join(", "),
      )
      .eq("organization_id", organizationId)
      .eq("claim_status", "on_hold")
      .is("archived_at", null);

    if (filter.category && HOLD_CATEGORIES.has(filter.category)) {
      q = q.eq("hold_category", filter.category);
    }
    if (filter.priority && HOLD_PRIORITIES.has(filter.priority)) {
      q = q.eq("hold_priority", filter.priority);
    }
    // "status" filter on the universal rail maps to hold_priority lane
    // (urgent / high / normal / low) — the claim_status itself is fixed
    // to 'on_hold' inside this queue.
    if (filter.status && HOLD_PRIORITIES.has(filter.status)) {
      q = q.eq("hold_priority", filter.status);
    }
    if (filter.assignedBiller) {
      if (filter.assignedBiller === "__unassigned__") {
        q = q.is("hold_assigned_to_user_id", null);
      } else {
        q = q.eq("hold_assigned_to_user_id", filter.assignedBiller);
      }
    }
    const minAmount = Number(filter.minAmount);
    if (filter.minAmount && Number.isFinite(minAmount)) {
      q = q.gte("total_charge", minAmount);
    }
    const maxAmount = Number(filter.maxAmount);
    if (filter.maxAmount && Number.isFinite(maxAmount)) {
      q = q.lte("total_charge", maxAmount);
    }
    if (filter.followUpDue === "overdue") {
      q = q.lt("hold_follow_up_date", todayIso());
    } else if (filter.followUpDue === "today") {
      q = q.eq("hold_follow_up_date", todayIso());
    } else if (filter.followUpDue === "week") {
      q = q.gte("hold_follow_up_date", todayIso()).lte("hold_follow_up_date", isoPlusDays(7));
    }
    // Aging bucket pushes a ceiling/floor on hold_started_at.
    if (filter.agingBucket) {
      const now = new Date();
      const cutoff = (days: number) => {
        const d = new Date(now);
        d.setDate(d.getDate() - days);
        return d.toISOString();
      };
      switch (filter.agingBucket) {
        case "0-7":
          q = q.gte("hold_started_at", cutoff(7));
          break;
        case "8-30":
          q = q.gte("hold_started_at", cutoff(30)).lt("hold_started_at", cutoff(7));
          break;
        case "31-60":
          q = q.gte("hold_started_at", cutoff(60)).lt("hold_started_at", cutoff(30));
          break;
        case "60+":
          q = q.lt("hold_started_at", cutoff(60));
          break;
      }
    }

    const { data: claims, error: claimsErr } = await q
      .order("hold_started_at", { ascending: true })
      .limit(500);

    if (claimsErr) throw claimsErr;

    const claimRows: DbRow[] = (claims as DbRow[]) ?? [];
    const claimIds = claimRows.map((c) => text(c.id)).filter(Boolean);
    const patientIds = [
      ...new Set(claimRows.map((c) => text(c.patient_id)).filter(Boolean)),
    ];
    const payerProfileIds = [
      ...new Set(claimRows.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];
    const appointmentIds = [
      ...new Set(claimRows.map((c) => text(c.appointment_id)).filter(Boolean)),
    ];
    const encounterIds = [
      ...new Set(claimRows.map((c) => text(c.encounter_id)).filter(Boolean)),
    ];

    const [
      { data: clients },
      { data: payerProfiles },
      { data: serviceLines },
      { data: parties },
      { data: noteCounts },
      { data: appointments },
      { data: encounters },
      { data: statusEvents },
    ] = await Promise.all([
      patientIds.length
        ? (supabase as any).from("clients").select("id, first_name, last_name").in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerProfileIds.length
        ? (supabase as any).from("payer_profiles").select("id, payer_name").in("id", payerProfileIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claim_service_lines")
            .select("claim_id, service_date_from, service_date_to, line_number")
            .in("claim_id", claimIds)
            .order("line_number", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_parties_snapshot")
            .select(
              "claim_id, subscriber_member_id, patient_first_name, patient_last_name",
            )
            .in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any).from("claim_notes").select("claim_id").in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      appointmentIds.length
        ? (supabase as any)
            .from("appointments")
            .select("id, location_id, provider_id")
            .in("id", appointmentIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      encounterIds.length
        ? (supabase as any)
            .from("encounters")
            .select("id, provider_id, location_id")
            .in("id", encounterIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_status_events")
            .select("claim_id, status_message, raw_payload, created_at")
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const patientById = new Map<string, DbRow>(
      ((clients as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payerProfiles as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const partiesByClaim = new Map<string, DbRow>(
      ((parties as DbRow[]) ?? []).map((p) => [text(p.claim_id), p]),
    );
    const linesByClaim = new Map<string, DbRow[]>();
    for (const sl of ((serviceLines as DbRow[]) ?? [])) {
      const cid = text(sl.claim_id);
      if (!linesByClaim.has(cid)) linesByClaim.set(cid, []);
      linesByClaim.get(cid)!.push(sl);
    }
    const noteCountByClaim = new Map<string, number>();
    for (const n of ((noteCounts as DbRow[]) ?? [])) {
      const cid = text(n.claim_id);
      noteCountByClaim.set(cid, (noteCountByClaim.get(cid) ?? 0) + 1);
    }
    const apptById = new Map<string, DbRow>(
      ((appointments as DbRow[]) ?? []).map((a) => [text(a.id), a]),
    );
    const encById = new Map<string, DbRow>(
      ((encounters as DbRow[]) ?? []).map((e) => [text(e.id), e]),
    );

    // Concatenate claim_status_events status_message + raw_payload for
    // CARC/RARC text search.
    const eventsTextByClaim = new Map<string, string>();
    for (const ev of ((statusEvents as DbRow[]) ?? [])) {
      const cid = text(ev.claim_id);
      const blob =
        text(ev.status_message) +
        " " +
        (ev.raw_payload ? JSON.stringify(ev.raw_payload) : "");
      eventsTextByClaim.set(cid, (eventsTextByClaim.get(cid) ?? "") + " " + blob);
    }

    // Lookup labels for practice + clinician filters by pulling
    // organizations/staff once we know which ids exist on the page.
    const providerIds = [
      ...new Set(
        [
          ...((appointments as DbRow[]) ?? []).map((a) => text(a.provider_id)),
          ...((encounters as DbRow[]) ?? []).map((e) => text(e.provider_id)),
        ].filter(Boolean),
      ),
    ];
    const locationIds = [
      ...new Set(
        [
          ...((appointments as DbRow[]) ?? []).map((a) => text(a.location_id)),
          ...((encounters as DbRow[]) ?? []).map((e) => text(e.location_id)),
        ].filter(Boolean),
      ),
    ];

    const [{ data: providers }, { data: locations }] = await Promise.all([
      providerIds.length
        ? (supabase as any)
            .from("staff_profiles")
            .select("id, first_name, last_name, email")
            .in("id", providerIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      locationIds.length
        ? (supabase as any).from("practice_locations").select("id, name").in("id", locationIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const providerById = new Map<string, DbRow>(
      ((providers as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const locationById = new Map<string, DbRow>(
      ((locations as DbRow[]) ?? []).map((l) => [text(l.id), l]),
    );

    const providerLabel = (id: string | null): string | null => {
      if (!id) return null;
      const p = providerById.get(id);
      if (!p) return null;
      const composed = [p.first_name, p.last_name].map(text).filter(Boolean).join(" ");
      return composed || text(p.email) || null;
    };

    const now = Date.now();
    let rows = claimRows.map((claim) => {
      const claimId = text(claim.id);
      const client = patientById.get(text(claim.patient_id));
      const payer = payerById.get(text(claim.payer_profile_id));
      const party = partiesByClaim.get(claimId);
      const lines = linesByClaim.get(claimId) ?? [];
      const dosFrom = lines[0] ? text(lines[0].service_date_from) || null : null;
      const dosTo =
        lines.length > 0
          ? text(lines[lines.length - 1].service_date_to) ||
            text(lines[lines.length - 1].service_date_from) ||
            null
          : null;

      const patientName = client
        ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ")
        : party
          ? [party.patient_first_name, party.patient_last_name]
              .map(text)
              .filter(Boolean)
              .join(" ")
          : "Unknown client";

      const holdStartedAt = claim.hold_started_at as string | null;
      const daysOnHold = holdStartedAt
        ? Math.max(0, Math.floor((now - new Date(holdStartedAt).getTime()) / 86_400_000))
        : 0;

      const appt = apptById.get(text(claim.appointment_id));
      const enc = encById.get(text(claim.encounter_id));
      const providerId = text(enc?.provider_id) || text(appt?.provider_id) || null;
      const practiceLocationId = text(enc?.location_id) || text(appt?.location_id) || null;

      return {
        id: claimId,
        claimNumber: text(claim.claim_number) || claimId.slice(0, 8),
        patientId: text(claim.patient_id),
        patientName: patientName || "Unknown client",
        memberId: text(party?.subscriber_member_id) || null,
        payerProfileId: text(claim.payer_profile_id),
        payerName: text(payer?.payer_name) || "—",
        serviceDateFrom: dosFrom,
        serviceDateTo: dosTo,
        totalChargeAmount: money(claim.total_charge),
        holdCategory: text(claim.hold_category) || "manual",
        holdReason: text(claim.hold_reason) || "",
        heldByDisplayName: text(claim.held_by_display_name) || null,
        heldByUserId: text(claim.held_by_user_id) || null,
        holdStartedAt,
        holdFollowUpDate: (claim.hold_follow_up_date as string | null) ?? null,
        assignedToDisplayName: text(claim.hold_assigned_to_display_name) || null,
        assignedToUserId: text(claim.hold_assigned_to_user_id) || null,
        holdPriority: text(claim.hold_priority) || "normal",
        daysOnHold,
        noteCount: noteCountByClaim.get(claimId) ?? 0,
        clinicianId: providerId,
        clinicianName: providerLabel(providerId),
        practiceLocationId,
        practiceLocationName: practiceLocationId
          ? text(locationById.get(practiceLocationId)?.name) || null
          : null,
        updatedAt: claim.updated_at ?? null,
      };
    });

    // ── Remaining filters that need joined data (server-side). ──────
    if (filter.client) {
      const q2 = filter.client.toLowerCase();
      rows = rows.filter((r) => r.patientName.toLowerCase().includes(q2));
    }
    if (filter.payer) rows = rows.filter((r) => r.payerName === filter.payer);
    if (filter.dosFrom) rows = rows.filter((r) => (r.serviceDateFrom ?? "") >= filter.dosFrom);
    if (filter.dosTo) rows = rows.filter((r) => (r.serviceDateFrom ?? "") <= filter.dosTo);
    if (filter.practice) {
      rows = rows.filter((r) => r.practiceLocationId === filter.practice);
    }
    if (filter.clinician) {
      rows = rows.filter((r) => r.clinicianId === filter.clinician);
    }
    if (filter.carcRarc) {
      const needle = filter.carcRarc.toLowerCase();
      rows = rows.filter((r) => {
        if ((r.holdReason ?? "").toLowerCase().includes(needle)) return true;
        const evText = eventsTextByClaim.get(r.id) ?? "";
        return evText.toLowerCase().includes(needle);
      });
    }

    // ── Filter-rail option lists (so the UI doesn't need extra calls).
    const { data: billers } = await (supabase as any)
      .from("staff_profiles")
      .select("id, first_name, last_name, email")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .limit(200);

    const assignees = ((billers as DbRow[]) ?? []).map((s) => {
      const name =
        [s.first_name, s.last_name].map(text).filter(Boolean).join(" ") ||
        text(s.email) ||
        "Unknown";
      return { id: text(s.id), displayName: name };
    });

    const { data: practiceLocations } = await (supabase as any)
      .from("practice_locations")
      .select("id, name")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("name", { ascending: true });

    const practices = ((practiceLocations as DbRow[]) ?? []).map((p) => ({
      id: text(p.id),
      name: text(p.name) || "Unnamed practice",
    }));

    const clinicians = assignees; // staff list doubles as clinician picker

    // Per-tab counts (computed pre-tab-filter so the strip can show
    // the totals for every category). This is a second small query
    // grouped client-side.
    const { data: catCounts } = await (supabase as any)
      .from("professional_claims")
      .select("hold_category")
      .eq("organization_id", organizationId)
      .eq("claim_status", "on_hold")
      .is("archived_at", null)
      .limit(5000);
    const tabCounts: Record<string, number> = {
      manual: 0,
      documentation: 0,
      eligibility: 0,
      auth: 0,
      compliance: 0,
      payer_rule: 0,
    };
    for (const c of ((catCounts as DbRow[]) ?? [])) {
      const cat = text(c.hold_category) || "manual";
      if (cat in tabCounts) tabCounts[cat] += 1;
    }

    return NextResponse.json({
      success: true,
      organizationId,
      rows,
      assignees,
      practices,
      clinicians,
      tabCounts,
    });
  } catch (error) {
    console.error("Claim Hold API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Claim Hold API failed",
      },
      { status: 500 },
    );
  }
}
