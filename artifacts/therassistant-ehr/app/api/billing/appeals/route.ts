/**
 * /api/billing/appeals
 *
 * GET — list rows for the Appeals Needed workqueue.
 *
 * Source of truth:
 *   - public.professional_claims  (claim_status='denied')
 *   - public.claim_appeals        (latest row per claim drives state)
 *
 * Tabs (computed):
 *   draft_needed   → denied claim with no claim_appeals row
 *   draft_ready    → latest appeal.status = 'draft_ready'
 *   sent           → latest appeal.status = 'sent'
 *   pending        → latest appeal.status = 'pending'
 *   overdue        → status in (draft_needed,draft_ready,sent,pending) AND deadline < today
 *   decided        → status in ('won','lost','escalated_doi')
 *
 * Universal filter rail (practice, clinician, payer, client, DOS,
 * status, assignedBiller, minAmount, maxAmount, agingBucket, carcRarc,
 * priority, followUpDue) is honored server-side where it applies.
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

const TAB_IDS = [
  "draft_needed",
  "draft_ready",
  "sent",
  "pending",
  "overdue",
  "decided",
] as const;
type TabId = (typeof TAB_IDS)[number];

const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const STATUSES = new Set(["open", "in_progress", "blocked", "resolved", "closed"]);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function extractDenialReason(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as DbRow;
  return text(
    p.denial_reason ||
      p.reason ||
      p.status_message ||
      p.status_description ||
      p.message ||
      "",
  );
}

function pickTab(row: { status: string; deadline: string | null }): TabId {
  const today = todayIso();
  if (row.status === "won" || row.status === "lost" || row.status === "escalated_doi") {
    return "decided";
  }
  const inFlight = ["draft_needed", "draft_ready", "sent", "pending"];
  if (inFlight.includes(row.status) && row.deadline && row.deadline < today) {
    return "overdue";
  }
  if (inFlight.includes(row.status)) return row.status as TabId;
  return "draft_needed";
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

    const rawTab = text(searchParams.get("tab")) as TabId;
    const tab: TabId = (TAB_IDS as readonly string[]).includes(rawTab)
      ? rawTab
      : "draft_needed";

    const f = {
      practice: text(searchParams.get("practice")),
      clinician: text(searchParams.get("clinician")),
      payer: text(searchParams.get("payer")),
      client: text(searchParams.get("client")),
      dosFrom: text(searchParams.get("dosFrom")),
      dosTo: text(searchParams.get("dosTo")),
      status: text(searchParams.get("status")),
      assignedBiller: text(searchParams.get("assignedBiller")),
      minAmount: text(searchParams.get("minAmount")),
      maxAmount: text(searchParams.get("maxAmount")),
      agingBucket: text(searchParams.get("agingBucket")),
      carcRarc: text(searchParams.get("carcRarc")),
      priority: text(searchParams.get("priority")),
      followUpDue: text(searchParams.get("followUpDue")),
    };

    // ── Pull denied claims for this org. We always include denied claims
    //    (even if they have no claim_appeals row yet) so the "Appeal Draft
    //    Needed" tab can surface them.
    const { data: claims, error: claimsErr } = await (supabase as any)
      .from("professional_claims")
      .select(
        [
          "id",
          "claim_number",
          "patient_id",
          "payer_profile_id",
          "claim_status",
          "total_charge",
          "patient_responsibility_amount",
          "payer_responsibility_amount",
          "write_off_amount",
          "updated_at",
          "created_at",
        ].join(", "),
      )
      .eq("organization_id", organizationId)
      .eq("claim_status", "denied")
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(1000);
    if (claimsErr) throw claimsErr;

    const claimRows = ((claims as DbRow[]) ?? []);
    const claimIds = claimRows.map((c) => text(c.id)).filter(Boolean);

    // ── Also include any claim_appeals rows whose claim is NOT in the
    //    denied set (decided / won / lost can outlive the 'denied'
    //    claim_status if the appeal won and the claim moved to 'paid').
    const { data: appealRows, error: appealsErr } = await (supabase as any)
      .from("claim_appeals")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (appealsErr) throw appealsErr;

    const allAppeals = ((appealRows as DbRow[]) ?? []);
    const extraClaimIds = [
      ...new Set(
        allAppeals
          .map((a) => text(a.claim_id))
          .filter((id) => id && !claimIds.includes(id)),
      ),
    ];
    const extraClaimsResp = extraClaimIds.length
      ? await (supabase as any)
          .from("professional_claims")
          .select(
            [
              "id",
              "claim_number",
              "patient_id",
              "payer_profile_id",
              "claim_status",
              "total_charge",
              "write_off_amount",
              "updated_at",
              "created_at",
            ].join(", "),
          )
          .eq("organization_id", organizationId)
          .in("id", extraClaimIds)
      : { data: [] as DbRow[] };
    const extraClaims = ((extraClaimsResp.data as DbRow[]) ?? []);
    const mergedClaims = [...claimRows, ...extraClaims];
    const mergedClaimIds = [
      ...new Set(mergedClaims.map((c) => text(c.id)).filter(Boolean)),
    ];

    // ── Fan-out lookups in parallel ────────────────────────────────────────
    const patientIds = [...new Set(mergedClaims.map((c) => text(c.patient_id)).filter(Boolean))];
    const payerProfileIds = [
      ...new Set(mergedClaims.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];

    const [
      { data: patients },
      { data: payerProfiles },
      { data: serviceLines },
      { data: parties },
      { data: statusEvents },
      { data: noteCounts },
      { data: templates },
      { data: orgStaff },
    ] = await Promise.all([
      patientIds.length
        ? (supabase as any).from("clients").select("id, first_name, last_name").in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerProfileIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name, office_ally_payer_id, fax_number")
            .in("id", payerProfileIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      mergedClaimIds.length
        ? (supabase as any)
            .from("professional_claim_service_lines")
            .select("claim_id, service_date_from, service_date_to, line_number")
            .in("claim_id", mergedClaimIds)
            .order("line_number", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
      mergedClaimIds.length
        ? (supabase as any)
            .from("claim_parties_snapshot")
            .select(
              "claim_id, subscriber_member_id, patient_first_name, patient_last_name, subscriber_first_name, subscriber_last_name",
            )
            .in("claim_id", mergedClaimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      mergedClaimIds.length
        ? (supabase as any)
            .from("claim_status_events")
            .select("claim_id, status, status_message, raw_payload, created_at")
            .in("claim_id", mergedClaimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      mergedClaimIds.length
        ? (supabase as any)
            .from("claim_notes")
            .select("id, claim_id, body, author_display_name, created_at")
            .in("claim_id", mergedClaimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      (supabase as any)
        .from("claim_appeal_templates")
        .select("id, name, body, is_system, organization_id")
        .is("archived_at", null)
        .or(`is_system.eq.true,organization_id.eq.${organizationId}`)
        .order("is_system", { ascending: false })
        .order("name", { ascending: true }),
      (supabase as any)
        .from("staff_profiles")
        .select("id, first_name, last_name, email")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .limit(500),
    ]);

    const patientById = new Map<string, DbRow>(
      ((patients as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const payerProfileById = new Map<string, DbRow>(
      ((payerProfiles as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const partiesByClaim = new Map<string, DbRow>(
      ((parties as DbRow[]) ?? []).map((p) => [text(p.claim_id), p]),
    );
    const linesByClaim = new Map<string, DbRow[]>();
    for (const l of ((serviceLines as DbRow[]) ?? [])) {
      const cid = text(l.claim_id);
      if (!linesByClaim.has(cid)) linesByClaim.set(cid, []);
      linesByClaim.get(cid)!.push(l);
    }
    const latestEventByClaim = new Map<string, DbRow>();
    for (const ev of ((statusEvents as DbRow[]) ?? [])) {
      const cid = text(ev.claim_id);
      if (!latestEventByClaim.has(cid)) latestEventByClaim.set(cid, ev);
    }
    const notesByClaim = new Map<string, DbRow[]>();
    for (const n of ((noteCounts as DbRow[]) ?? [])) {
      const cid = text(n.claim_id);
      if (!notesByClaim.has(cid)) notesByClaim.set(cid, []);
      notesByClaim.get(cid)!.push(n);
    }

    // Latest appeal per claim (already ordered desc by created_at)
    const latestAppealByClaim = new Map<string, DbRow>();
    const appealsByClaim = new Map<string, DbRow[]>();
    for (const a of allAppeals) {
      const cid = text(a.claim_id);
      if (!appealsByClaim.has(cid)) appealsByClaim.set(cid, []);
      appealsByClaim.get(cid)!.push(a);
      if (!latestAppealByClaim.has(cid)) latestAppealByClaim.set(cid, a);
    }

    const staffById = new Map<string, DbRow>(
      ((orgStaff as DbRow[]) ?? []).map((s) => [text(s.id), s]),
    );
    const assignees = ((orgStaff as DbRow[]) ?? []).map((s) => {
      const name =
        [s.first_name, s.last_name].map(text).filter(Boolean).join(" ") ||
        text(s.email) ||
        "Unknown";
      return { id: text(s.id), displayName: name };
    });

    // ── Materialise rows ────────────────────────────────────────────────────
    type Row = {
      id: string;
      claimId: string;
      claimNumber: string;
      clientId: string | null;
      clientName: string;
      memberId: string;
      payerName: string;
      payerProfileId: string | null;
      payerFaxNumber: string | null;
      serviceDateFrom: string | null;
      serviceDateTo: string | null;
      deniedAmount: number;
      denialReason: string;
      appealId: string | null;
      appealLevel: number;
      appealDeadline: string | null;
      appealStatus: string; // draft_needed | draft_ready | sent | pending | won | lost | escalated_doi
      appealStatusLabel: string;
      appealSubmittedAt: string | null;
      appealDecision: string | null;
      appealDecisionAt: string | null;
      assignedToUserId: string | null;
      assignedToDisplayName: string | null;
      letterBody: string;
      templateId: string | null;
      attachmentsCount: number;
      noteCount: number;
      claimStatus: string;
      claimUpdatedAt: string | null;
      claimCreatedAt: string | null;
      ageDays: number;
      tab: TabId;
      priority: string; // synthesized from urgency
    };

    const now = Date.now();
    const STATUS_LABEL: Record<string, string> = {
      draft_needed: "Draft needed",
      draft_ready: "Draft ready",
      sent: "Sent",
      pending: "Pending decision",
      won: "Won",
      lost: "Lost",
      escalated_doi: "Escalated (DOI)",
    };

    let rows: Row[] = mergedClaims.map((claim) => {
      const claimId = text(claim.id);
      const patient = patientById.get(text(claim.patient_id));
      const payerProfile = payerProfileById.get(text(claim.payer_profile_id));
      const party = partiesByClaim.get(claimId);
      const lines = linesByClaim.get(claimId) ?? [];
      const dosFrom = lines[0] ? text(lines[0].service_date_from) || null : null;
      const dosTo =
        lines.length > 0
          ? text(lines[lines.length - 1].service_date_to) ||
            text(lines[lines.length - 1].service_date_from) ||
            null
          : null;

      const event = latestEventByClaim.get(claimId);
      const denialReasonText = event
        ? extractDenialReason(event.raw_payload) ||
          text(event.status_message) ||
          text(event.status)
        : "";

      const totalCharge = money(claim.total_charge);
      const writeOff = money(claim.write_off_amount);
      const denied = Math.max(0, Math.round((totalCharge - writeOff) * 100) / 100);

      const patientName = patient
        ? [patient.first_name, patient.last_name].map(text).filter(Boolean).join(" ")
        : party
          ? [
              party.patient_first_name || party.subscriber_first_name,
              party.patient_last_name || party.subscriber_last_name,
            ]
              .map(text)
              .filter(Boolean)
              .join(" ")
          : "Unknown patient";

      const appeal = latestAppealByClaim.get(claimId);
      const status: string = appeal ? text(appeal.status) : "draft_needed";
      const deadline = appeal ? (text(appeal.deadline) || null) : null;
      const assignee = appeal && appeal.assigned_to_user_id
        ? staffById.get(text(appeal.assigned_to_user_id))
        : undefined;
      const assigneeName = assignee
        ? [assignee.first_name, assignee.last_name].map(text).filter(Boolean).join(" ") ||
          text(assignee.email) ||
          "Unknown"
        : null;

      const claimUpdated = text(claim.updated_at) || null;
      const ageBasis = claimUpdated || text(claim.created_at) || null;
      const ageDays = ageBasis
        ? Math.max(0, Math.floor((now - new Date(ageBasis).getTime()) / 86_400_000))
        : 0;

      // Urgency heuristic for the priority filter / urgent metric
      let priority = "normal";
      if (deadline) {
        const daysToDeadline = Math.floor(
          (new Date(deadline).getTime() - now) / 86_400_000,
        );
        if (daysToDeadline < 0) priority = "urgent";
        else if (daysToDeadline <= 7) priority = "high";
      } else if (status === "draft_needed" && ageDays > 30) {
        priority = "high";
      }

      const tabId = pickTab({
        status,
        deadline,
      });

      return {
        id: appeal ? text(appeal.id) : `claim:${claimId}`,
        claimId,
        claimNumber: text(claim.claim_number) || claimId.slice(0, 8),
        clientId: text(claim.patient_id) || null,
        clientName: patientName,
        memberId: text(party?.subscriber_member_id),
        payerName: text(payerProfile?.payer_name) || "—",
        payerProfileId: text(claim.payer_profile_id) || null,
        payerFaxNumber: text(payerProfile?.fax_number) || null,
        serviceDateFrom: dosFrom,
        serviceDateTo: dosTo,
        deniedAmount: denied,
        denialReason:
          (appeal && text(appeal.denial_reason)) || denialReasonText || "",
        appealId: appeal ? text(appeal.id) : null,
        appealLevel: appeal ? Number(appeal.level ?? 1) : 1,
        appealDeadline: deadline,
        appealStatus: status,
        appealStatusLabel: STATUS_LABEL[status] ?? status,
        appealSubmittedAt: appeal ? (text(appeal.submitted_at) || null) : null,
        appealDecision: appeal ? (text(appeal.decision) || null) : null,
        appealDecisionAt: appeal ? (text(appeal.decision_at) || null) : null,
        assignedToUserId: appeal ? (text(appeal.assigned_to_user_id) || null) : null,
        assignedToDisplayName: assigneeName,
        letterBody: appeal ? (text(appeal.letter_body) || "") : "",
        templateId: appeal ? (text(appeal.template_id) || null) : null,
        attachmentsCount: appeal ? Number(appeal.attachments_count ?? 0) : 0,
        noteCount: (notesByClaim.get(claimId) ?? []).length,
        claimStatus: text(claim.claim_status),
        claimUpdatedAt: claimUpdated,
        claimCreatedAt: text(claim.created_at) || null,
        ageDays,
        tab: tabId,
        priority,
      };
    });

    // ── Tab counts BEFORE per-tab filter ───────────────────────────────────
    const tabCounts: Record<TabId, number> = {
      draft_needed: 0,
      draft_ready: 0,
      sent: 0,
      pending: 0,
      overdue: 0,
      decided: 0,
    };
    for (const r of rows) tabCounts[r.tab] += 1;

    // ── Universal filter rail ──────────────────────────────────────────────
    if (f.client) {
      const needle = f.client.toLowerCase();
      rows = rows.filter((r) => r.clientName.toLowerCase().includes(needle));
    }
    if (f.payer) rows = rows.filter((r) => r.payerName === f.payer);
    if (f.dosFrom) rows = rows.filter((r) => (r.serviceDateFrom ?? "") >= f.dosFrom);
    if (f.dosTo) rows = rows.filter((r) => (r.serviceDateFrom ?? "") <= f.dosTo);
    const minAmount = Number(f.minAmount);
    if (f.minAmount && Number.isFinite(minAmount)) {
      rows = rows.filter((r) => r.deniedAmount >= minAmount);
    }
    const maxAmount = Number(f.maxAmount);
    if (f.maxAmount && Number.isFinite(maxAmount)) {
      rows = rows.filter((r) => r.deniedAmount <= maxAmount);
    }
    if (f.carcRarc) {
      const needle = f.carcRarc.toUpperCase();
      rows = rows.filter((r) => r.denialReason.toUpperCase().includes(needle));
    }
    if (f.practice) {
      const needle = f.practice.toLowerCase();
      rows = rows.filter((r) =>
        `${r.clientName} ${r.payerName}`.toLowerCase().includes(needle),
      );
    }
    if (f.clinician) {
      const needle = f.clinician.toLowerCase();
      rows = rows.filter((r) =>
        (r.assignedToDisplayName ?? "").toLowerCase().includes(needle),
      );
    }
    if (f.priority && PRIORITIES.has(f.priority)) {
      rows = rows.filter((r) => r.priority === f.priority);
    }
    if (f.assignedBiller) {
      if (f.assignedBiller === "__unassigned__") {
        rows = rows.filter((r) => !r.assignedToUserId);
      } else {
        rows = rows.filter((r) => r.assignedToUserId === f.assignedBiller);
      }
    }
    if (f.status && STATUSES.has(f.status)) {
      // Universal "status" filter — map our appeal status onto the
      // generic open/in_progress/resolved/closed buckets so the rail
      // still does something sensible.
      const wantsOpen = f.status === "open";
      const wantsInProgress = f.status === "in_progress";
      const wantsResolved = f.status === "resolved" || f.status === "closed";
      rows = rows.filter((r) => {
        if (wantsOpen) return r.appealStatus === "draft_needed";
        if (wantsInProgress)
          return ["draft_ready", "sent", "pending", "escalated_doi"].includes(
            r.appealStatus,
          );
        if (wantsResolved) return ["won", "lost"].includes(r.appealStatus);
        return true;
      });
    }
    if (f.agingBucket) {
      const buckets: Record<string, [number, number]> = {
        "0-7": [0, 7],
        "8-30": [8, 30],
        "31-60": [31, 60],
        "60+": [61, 100000],
      };
      const range = buckets[f.agingBucket];
      if (range) {
        rows = rows.filter((r) => r.ageDays >= range[0] && r.ageDays <= range[1]);
      }
    }
    if (f.followUpDue) {
      const today = todayIso();
      const weekOut = isoPlusDays(7);
      rows = rows.filter((r) => {
        if (!r.appealDeadline) return false;
        if (f.followUpDue === "overdue") return r.appealDeadline < today;
        if (f.followUpDue === "today") return r.appealDeadline === today;
        if (f.followUpDue === "week")
          return r.appealDeadline >= today && r.appealDeadline <= weekOut;
        return true;
      });
    }

    // ── Per-tab cut ────────────────────────────────────────────────────────
    const tabRows = rows.filter((r) => r.tab === tab);

    // ── Header summary on the active tab ───────────────────────────────────
    const totalDollars = tabRows.reduce((s, r) => s + r.deniedAmount, 0);
    const oldestAge = tabRows.reduce((m, r) => Math.max(m, r.ageDays), 0);
    const urgentCount = tabRows.filter(
      (r) => r.priority === "urgent" || r.priority === "high",
    ).length;

    // Filter dropdown options
    const payerSet = new Set<string>();
    for (const r of rows) if (r.payerName && r.payerName !== "—") payerSet.add(r.payerName);

    // Per-row history (last few notes + prior appeals) gets included in the
    // payload so the detail panel does not need a second roundtrip.
    const claimHistoryByClaim: Record<string, Array<{ kind: string; at: string | null; body: string }>> = {};
    for (const cid of mergedClaimIds) {
      const notes = (notesByClaim.get(cid) ?? []).map((n) => ({
        kind: "note",
        at: text(n.created_at) || null,
        body: `${text(n.author_display_name) || "Biller"}: ${text(n.body)}`,
      }));
      const prior = (appealsByClaim.get(cid) ?? []).slice().reverse().map((a) => ({
        kind: `appeal_${text(a.status)}`,
        at: text(a.updated_at) || text(a.created_at) || null,
        body:
          `Level ${Number(a.level ?? 1)} appeal — status ${text(a.status)}` +
          (a.submitted_at ? ` · submitted ${text(a.submitted_at).slice(0, 10)}` : "") +
          (a.decision ? ` · ${text(a.decision)}` : ""),
      }));
      const event = latestEventByClaim.get(cid);
      const evt = event
        ? [
            {
              kind: "denial",
              at: text(event.created_at) || null,
              body:
                `Denied — ${extractDenialReason(event.raw_payload) || text(event.status_message) || text(event.status) || "no reason"}`,
            },
          ]
        : [];
      claimHistoryByClaim[cid] = [...prior, ...notes, ...evt].slice(0, 25);
    }

    return NextResponse.json({
      success: true,
      organizationId,
      tab,
      rows: tabRows,
      tabCounts,
      assignees,
      metrics: {
        totalCount: tabRows.length,
        totalDollars: Math.round(totalDollars * 100) / 100,
        oldestAgeDays: oldestAge,
        urgentCount,
      },
      templates: ((templates as DbRow[]) ?? []).map((t) => ({
        id: text(t.id),
        name: text(t.name),
        body: text(t.body),
        isSystem: Boolean(t.is_system),
      })),
      claimHistory: claimHistoryByClaim,
      filterOptions: {
        payers: [...payerSet].sort().map((v) => ({ value: v, label: v })),
        assignees: assignees.map((a) => ({ value: a.id, label: a.displayName })),
      },
    });
  } catch (error) {
    console.error("Appeals API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Appeals API failed",
      },
      { status: 500 },
    );
  }
}
