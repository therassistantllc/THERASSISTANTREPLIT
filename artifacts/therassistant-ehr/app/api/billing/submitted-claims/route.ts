import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;

const SUBMITTED_STATUSES = [
  "batched",
  "submitted",
  "accepted_oa",
  "rejected_oa",
  "accepted_payer",
] as const;

const HARD_ROW_CEILING = 2000;
const DEFAULT_PAGE_SIZE = 200;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function money(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000));
}

function nextExpected(submittedAt: string | null, status: string): string | null {
  if (!submittedAt) return null;
  const base = new Date(submittedAt);
  if (Number.isNaN(base.getTime())) return null;
  const addDays = (days: number) =>
    new Date(base.getTime() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  switch (status) {
    case "batched":
    case "submitted":
      return addDays(1);
    case "accepted_oa":
      return addDays(3);
    case "accepted_payer":
      return addDays(30);
    default:
      return null;
  }
}

function clearinghouseStatusLabel(claimStatus: string, batchStatus: string | null): string {
  if (claimStatus === "rejected_oa") return "Rejected by clearinghouse";
  if (claimStatus === "accepted_payer") return "Accepted by payer";
  if (claimStatus === "accepted_oa") return "Accepted by clearinghouse";
  if (batchStatus === "submitted") return "Awaiting acknowledgement";
  if (batchStatus === "generated") return "Generated, awaiting transmission";
  if (batchStatus === "rejected") return "Batch rejected";
  return batchStatus ? `Batch ${batchStatus}` : "Awaiting acknowledgement";
}

function ageBucket(days: number | null): "0-30" | "31-60" | "61-90" | "90+" | null {
  if (days == null) return null;
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

type TabId =
  | "today"
  | "awaiting_999"
  | "awaiting_277ca"
  | "awaiting_payer"
  | "no_response_risk";

const VALID_TABS: ReadonlySet<TabId> = new Set([
  "today",
  "awaiting_999",
  "awaiting_277ca",
  "awaiting_payer",
  "no_response_risk",
]);

interface Filters {
  payer: string | null;
  client: string | null;
  status: string | null;
  dosFrom: string | null;
  dosTo: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  agingBucket: string | null;
  priorityUrgent: boolean;
  followUpDue: string | null;
  practice: string | null;
  clinician: string | null;
  assignedBiller: string | null;
  carcRarc: string | null;
}

function parseFilters(sp: URLSearchParams): Filters {
  const num = (k: string) => {
    const v = sp.get(k);
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    payer: sp.get("payer") || null,
    client: sp.get("client") || null,
    status: sp.get("status") || null,
    dosFrom: sp.get("dosFrom") || null,
    dosTo: sp.get("dosTo") || null,
    minAmount: num("minAmount"),
    maxAmount: num("maxAmount"),
    agingBucket: sp.get("agingBucket") || null,
    priorityUrgent: sp.get("priority") === "urgent",
    followUpDue: sp.get("followUpDue") || null,
    practice: sp.get("practice") || null,
    clinician: sp.get("clinician") || null,
    assignedBiller: sp.get("assignedBiller") || null,
    carcRarc: sp.get("carcRarc") || null,
  };
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

    const filters = parseFilters(searchParams);
    const activeTabParam = searchParams.get("tab") as TabId | null;
    const activeTab: TabId | null =
      activeTabParam && VALID_TABS.has(activeTabParam) ? activeTabParam : null;

    const pageSizeRaw = Number(searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
    const pageSize = Math.max(
      1,
      Math.min(HARD_ROW_CEILING, Number.isFinite(pageSizeRaw) ? pageSizeRaw : DEFAULT_PAGE_SIZE),
    );
    const offsetRaw = Number(searchParams.get("offset") ?? 0);
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

    // ── Server-side claim query ───────────────────────────────────────────
    let claimsQuery = supabase
      .from("professional_claims")
      .select(
        "id, organization_id, patient_id, encounter_id, payer_profile_id, claim_number, claim_status, total_charge, submitted_at, first_billed_date, last_billed_date, created_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .in("claim_status", SUBMITTED_STATUSES as unknown as string[]);

    // Filters pushable to SQL ───────────────────────────────────────────
    if (filters.status) {
      claimsQuery = claimsQuery.eq("claim_status", filters.status);
    }
    if (filters.minAmount != null) {
      claimsQuery = claimsQuery.gte("total_charge", filters.minAmount);
    }
    if (filters.maxAmount != null) {
      claimsQuery = claimsQuery.lte("total_charge", filters.maxAmount);
    }
    // Aging bucket is computed from submitted_at; push as a date filter.
    if (filters.agingBucket) {
      const now = Date.now();
      const dayMs = 24 * 3600 * 1000;
      const isoAtDaysAgo = (d: number) =>
        new Date(now - d * dayMs).toISOString();
      switch (filters.agingBucket) {
        case "0-30":
          claimsQuery = claimsQuery.gte("submitted_at", isoAtDaysAgo(30));
          break;
        case "31-60":
          claimsQuery = claimsQuery
            .gte("submitted_at", isoAtDaysAgo(60))
            .lt("submitted_at", isoAtDaysAgo(30));
          break;
        case "61-90":
          claimsQuery = claimsQuery
            .gte("submitted_at", isoAtDaysAgo(90))
            .lt("submitted_at", isoAtDaysAgo(60));
          break;
        case "90+":
          claimsQuery = claimsQuery.lt("submitted_at", isoAtDaysAgo(90));
          break;
      }
    }
    // Active tab — bucket every org-scoped claim into its tab once, in JS,
    // from a single org-bounded fetch + a single no_response_risk events
    // fetch. We then constrain the paged query with `.in("id", …)` so
    // pagination respects true tab membership (especially for the
    // `no_response_risk` partition, which mixes age math + a separate
    // events table and can't be reproduced as a single SQL predicate).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfToday = today.getTime();
    const startOfTomorrow = startOfToday + 24 * 3600 * 1000;

    const { data: orgClaimRows } = await supabase
      .from("professional_claims")
      .select("id, submitted_at, claim_status")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .in("claim_status", SUBMITTED_STATUSES as unknown as string[])
      .limit(HARD_ROW_CEILING);
    const orgClaimsAll = (orgClaimRows ?? []) as DbRow[];
    const orgClaimIdsAll = orgClaimsAll.map((c) => text(c.id));

    const { data: noRespEvts } = orgClaimIdsAll.length
      ? await supabase
          .from("claim_status_events")
          .select("claim_id")
          .in("claim_id", orgClaimIdsAll)
          .eq("status", "no_response_risk")
      : { data: [] as DbRow[] };
    const noRespFlagSet = new Set(
      ((noRespEvts ?? []) as DbRow[]).map((e) => text(e.claim_id)),
    );

    const tabBucketIds: Record<TabId, string[]> = {
      today: [],
      awaiting_999: [],
      awaiting_277ca: [],
      awaiting_payer: [],
      no_response_risk: [],
    };
    const urgentIdSet = new Set<string>();
    for (const c of orgClaimsAll) {
      const id = text(c.id);
      const submittedAt = c.submitted_at ? String(c.submitted_at) : null;
      const days = ageDays(submittedAt) ?? 0;
      const cs = text(c.claim_status);
      const flagged = noRespFlagSet.has(id);
      const isRisk = flagged || (days >= 14 && cs !== "accepted_payer");
      if (isRisk) {
        tabBucketIds.no_response_risk.push(id);
      } else if (
        submittedAt &&
        new Date(submittedAt).getTime() >= startOfToday &&
        new Date(submittedAt).getTime() < startOfTomorrow
      ) {
        tabBucketIds.today.push(id);
      } else if (cs === "submitted" || cs === "batched") {
        tabBucketIds.awaiting_999.push(id);
      } else if (cs === "accepted_oa") {
        tabBucketIds.awaiting_277ca.push(id);
      } else {
        tabBucketIds.awaiting_payer.push(id);
      }
      if (flagged || days >= 14) urgentIdSet.add(id);
    }

    // Pre-derived tab counts (cheap, all in-JS over orgClaimsAll).
    const tabCounts: Record<TabId, number> = {
      today: tabBucketIds.today.length,
      awaiting_999: tabBucketIds.awaiting_999.length,
      awaiting_277ca: tabBucketIds.awaiting_277ca.length,
      awaiting_payer: tabBucketIds.awaiting_payer.length,
      no_response_risk: tabBucketIds.no_response_risk.length,
    };

    // Pre-derived summary metrics (queue-wide, ignore the active tab).
    const totalAll = orgClaimsAll.length;
    let oldestAgeRaw = 0;
    for (const c of orgClaimsAll) {
      const d = ageDays(c.submitted_at ? String(c.submitted_at) : null) ?? 0;
      if (d > oldestAgeRaw) oldestAgeRaw = d;
    }
    const urgentCountAll = urgentIdSet.size;

    // Apply active-tab membership at SQL level. Empty bucket → empty
    // response with real tabCounts preserved so the strip still renders.
    if (activeTab) {
      const ids = tabBucketIds[activeTab];
      if (ids.length === 0) {
        return NextResponse.json({
          success: true,
          organizationId,
          summary: {
            total: totalAll,
            totalDollars: 0,
            oldestAge: oldestAgeRaw,
            urgentCount: urgentCountAll,
          },
          tabCounts,
          rows: [],
          pagination: { offset, limit: pageSize, hasMore: false, totalLoaded: 0 },
        });
      }
      claimsQuery = claimsQuery.in("id", ids);
    }

    // Priority=urgent is also a derived membership predicate; apply at
    // SQL level so pagination is honest.
    if (filters.priorityUrgent) {
      const ids = Array.from(urgentIdSet);
      if (ids.length === 0) {
        return NextResponse.json({
          success: true,
          organizationId,
          summary: {
            total: totalAll,
            totalDollars: 0,
            oldestAge: oldestAgeRaw,
            urgentCount: urgentCountAll,
          },
          tabCounts,
          rows: [],
          pagination: { offset, limit: pageSize, hasMore: false, totalLoaded: 0 },
        });
      }
      claimsQuery = claimsQuery.in("id", ids);
    }

    // CARC/RARC filter — denial_reason_code lives on professional_claims;
    // for submitted-but-not-yet-paid claims it stays empty until a 277CA
    // or ERA arrives, so we ILIKE-match whatever's there.
    if (filters.carcRarc) {
      claimsQuery = claimsQuery.ilike("denial_reason_code", `%${filters.carcRarc}%`);
    }

    // Practice / clinician filter — both live on the encounters table.
    // Resolve to a list of encounter_ids first, then constrain claims.
    if (filters.practice || filters.clinician) {
      let encQ = supabase
        .from("encounters")
        .select("id")
        .eq("organization_id", organizationId)
        .limit(2000);
      if (filters.practice) {
        encQ = encQ.eq("provider_location_id", filters.practice);
      }
      if (filters.clinician) {
        encQ = encQ.eq("provider_id", filters.clinician);
      }
      const { data: encMatches } = await encQ;
      const ids = ((encMatches ?? []) as DbRow[]).map((e) => text(e.id));
      if (ids.length === 0) {
        return NextResponse.json({
          success: true,
          organizationId,
          summary: { total: 0, totalDollars: 0, oldestAge: 0, urgentCount: 0 },
          tabCounts: emptyTabCounts(),
          rows: [],
          pagination: { offset, limit: pageSize, hasMore: false, totalLoaded: 0 },
        });
      }
      claimsQuery = claimsQuery.in("encounter_id", ids);
    }

    // Assigned biller filter — surface as "claims this user has acted on"
    // by joining through the audit-trail (claim_status_events.raw_payload
    // -> actor_user_id, which the action endpoint writes). Scoped to
    // org claim ids so we can't leak cross-tenant event rows.
    if (filters.assignedBiller) {
      const { data: actorEvents } = orgClaimIdsAll.length
        ? await supabase
            .from("claim_status_events")
            .select("claim_id, raw_payload")
            .eq("source", "biller")
            .in("claim_id", orgClaimIdsAll)
            .filter("raw_payload->>actor_user_id", "eq", filters.assignedBiller)
            .limit(2000)
        : { data: [] as DbRow[] };
      const ids = [
        ...new Set(((actorEvents ?? []) as DbRow[]).map((e) => text(e.claim_id))),
      ];
      if (ids.length === 0) {
        return NextResponse.json({
          success: true,
          organizationId,
          summary: { total: 0, totalDollars: 0, oldestAge: 0, urgentCount: 0 },
          tabCounts: emptyTabCounts(),
          rows: [],
          pagination: { offset, limit: pageSize, hasMore: false, totalLoaded: 0 },
        });
      }
      claimsQuery = claimsQuery.in("id", ids);
    }

    // Resolve payer filter (server-side join via id lookup).
    if (filters.payer) {
      const { data: payerMatches } = await supabase
        .from("insurance_payers")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("payer_name", filters.payer)
        .limit(20);
      const ids = ((payerMatches ?? []) as DbRow[]).map((p) => text(p.id));
      if (ids.length === 0) {
        return NextResponse.json({
          success: true,
          organizationId,
          summary: { total: 0, totalDollars: 0, oldestAge: 0, urgentCount: 0 },
          tabCounts: emptyTabCounts(),
          rows: [],
          pagination: { offset, limit: pageSize, hasMore: false, totalLoaded: 0 },
        });
      }
      claimsQuery = claimsQuery.in("payer_profile_id", ids);
    }

    // Resolve client (client-name) filter via id lookup.
    if (filters.client) {
      const term = filters.client.trim();
      const { data: clientMatches } = await supabase
        .from("clients")
        .select("id")
        .eq("organization_id", organizationId)
        .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%`)
        .limit(500);
      const ids = ((clientMatches ?? []) as DbRow[]).map((c) => text(c.id));
      if (ids.length === 0) {
        return NextResponse.json({
          success: true,
          organizationId,
          summary: { total: 0, totalDollars: 0, oldestAge: 0, urgentCount: 0 },
          tabCounts: emptyTabCounts(),
          rows: [],
          pagination: { offset, limit: pageSize, hasMore: false, totalLoaded: 0 },
        });
      }
      claimsQuery = claimsQuery.in("patient_id", ids);
    }

    // Order + paginate.
    claimsQuery = claimsQuery
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .range(offset, offset + pageSize - 1);

    const { data: claims, error: claimsErr } = await claimsQuery;
    if (claimsErr) throw claimsErr;
    const rawClaims = (claims ?? []) as DbRow[];

    const claimIds = rawClaims.map((c) => text(c.id)).filter(Boolean);
    const patientIds = [
      ...new Set(rawClaims.map((c) => text(c.patient_id)).filter(Boolean)),
    ];
    const encounterIds = [
      ...new Set(rawClaims.map((c) => text(c.encounter_id)).filter(Boolean)),
    ];
    const payerIds = [
      ...new Set(rawClaims.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];

    const [
      { data: clients },
      { data: encounters },
      { data: payers },
      { data: lines },
      { data: batchLinks },
      { data: noResponseEvents },
    ] = await Promise.all([
      patientIds.length
        ? supabase
            .from("clients")
            .select("id, first_name, last_name, date_of_birth")
            .in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      encounterIds.length
        ? supabase
            .from("encounters")
            .select("id, service_date, provider_id")
            .in("id", encounterIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerIds.length
        ? supabase
            .from("insurance_payers")
            .select("id, payer_name, payer_id")
            .in("id", payerIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? supabase
            .from("professional_claim_service_lines")
            .select("claim_id, service_date_from, service_date_to, procedure_code")
            .in("claim_id", claimIds)
            .order("line_number", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? supabase
            .from("claim_837p_batch_claims")
            .select("batch_id, professional_claim_id")
            .eq("organization_id", organizationId)
            .in("professional_claim_id", claimIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? supabase
            .from("claim_status_events")
            .select("claim_id, status, created_at")
            .in("claim_id", claimIds)
            .eq("status", "no_response_risk")
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const batchIds = [
      ...new Set(((batchLinks ?? []) as DbRow[]).map((r) => text(r.batch_id)).filter(Boolean)),
    ];
    const { data: batches } = batchIds.length
      ? await supabase
          .from("claim_837p_batches")
          .select("id, batch_number, batch_status, submitted_at")
          .eq("organization_id", organizationId)
          .in("id", batchIds)
      : { data: [] as DbRow[] };

    const clientById = new Map<string, DbRow>(
      (clients ?? []).map((c: DbRow) => [text(c.id), c]),
    );
    const encounterById = new Map<string, DbRow>(
      (encounters ?? []).map((e: DbRow) => [text(e.id), e]),
    );
    const payerById = new Map<string, DbRow>(
      (payers ?? []).map((p: DbRow) => [text(p.id), p]),
    );
    const batchById = new Map<string, DbRow>(
      (batches ?? []).map((b: DbRow) => [text(b.id), b]),
    );

    const linesByClaim = new Map<string, DbRow[]>();
    for (const line of (lines ?? []) as DbRow[]) {
      const cid = text(line.claim_id);
      const arr = linesByClaim.get(cid) ?? [];
      arr.push(line);
      linesByClaim.set(cid, arr);
    }

    const batchByClaim = new Map<string, string>();
    for (const link of (batchLinks ?? []) as DbRow[]) {
      batchByClaim.set(text(link.professional_claim_id), text(link.batch_id));
    }

    const noResponseClaimIds = new Set<string>(
      ((noResponseEvents ?? []) as DbRow[]).map((e) => text(e.claim_id)),
    );

    type Row = {
      id: string;
      claimNumber: string;
      patientId: string;
      patientName: string;
      payerProfileId: string;
      payerName: string;
      payerId: string;
      serviceDateFrom: string | null;
      serviceDateTo: string | null;
      submittedAt: string | null;
      batchId: string | null;
      batchNumber: string | null;
      batchStatus: string | null;
      clearinghouseStatus: string;
      claimStatus: string;
      daysSinceSubmission: number | null;
      chargeAmount: number;
      nextExpectedResponse: string | null;
      hasNoResponseFlag: boolean;
      tab: TabId;
      cptCodes: string[];
    };

    let rows: Row[] = rawClaims.map((claim) => {
      const id = text(claim.id);
      const client = clientById.get(text(claim.patient_id));
      const encounter = encounterById.get(text(claim.encounter_id));
      const payer = payerById.get(text(claim.payer_profile_id));
      const batchId = batchByClaim.get(id) ?? null;
      const batch = batchId ? batchById.get(batchId) : null;
      const claimLines = linesByClaim.get(id) ?? [];
      const firstLine = claimLines[0];
      const lastLine = claimLines[claimLines.length - 1];

      const submittedAt = claim.submitted_at ? String(claim.submitted_at) : null;
      const days = ageDays(submittedAt);
      const claimStatus = text(claim.claim_status);
      const batchStatus = batch ? text(batch.batch_status) : null;
      const hasNoResponseFlag = noResponseClaimIds.has(id);

      let tab: Row["tab"];
      const submittedToday =
        submittedAt && new Date(submittedAt).getTime() >= startOfToday;
      if (hasNoResponseFlag || (days !== null && days >= 14 && claimStatus !== "accepted_payer")) {
        tab = "no_response_risk";
      } else if (submittedToday) {
        tab = "today";
      } else if (claimStatus === "submitted" || claimStatus === "batched") {
        tab = "awaiting_999";
      } else if (claimStatus === "accepted_oa") {
        tab = "awaiting_277ca";
      } else {
        tab = "awaiting_payer";
      }

      const patientName = client
        ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") ||
          "Unknown client"
        : "Unknown client";

      const serviceFromEnc = encounter?.service_date ? String(encounter.service_date) : null;
      const serviceDateFrom = firstLine?.service_date_from
        ? String(firstLine.service_date_from)
        : serviceFromEnc;
      const serviceDateTo = lastLine?.service_date_to
        ? String(lastLine.service_date_to)
        : lastLine?.service_date_from
        ? String(lastLine.service_date_from)
        : serviceDateFrom;

      return {
        id,
        claimNumber: text(claim.claim_number) || id.slice(0, 8),
        patientId: text(claim.patient_id),
        patientName,
        payerProfileId: text(claim.payer_profile_id),
        payerName: payer ? text(payer.payer_name) : "Unknown payer",
        payerId: payer ? text(payer.payer_id) : "",
        serviceDateFrom,
        serviceDateTo,
        submittedAt,
        batchId,
        batchNumber: batch ? text(batch.batch_number) : null,
        batchStatus,
        clearinghouseStatus: clearinghouseStatusLabel(claimStatus, batchStatus),
        claimStatus,
        daysSinceSubmission: days,
        chargeAmount: money(claim.total_charge),
        nextExpectedResponse: nextExpected(submittedAt, claimStatus),
        hasNoResponseFlag,
        tab,
        cptCodes: [
          ...new Set(claimLines.map((l) => text(l.procedure_code)).filter(Boolean)),
        ],
      };
    });

    // Post-hoc filters that depend on derived data (DOS comes from service
    // lines; follow-up date is computed from submitted_at + status). Tab
    // membership and priority=urgent are already enforced at SQL level
    // above so pagination honors them.
    if (filters.dosFrom) {
      rows = rows.filter((r) => (r.serviceDateFrom ?? "") >= filters.dosFrom!);
    }
    if (filters.dosTo) {
      rows = rows.filter((r) => (r.serviceDateFrom ?? "") <= filters.dosTo!);
    }
    if (filters.followUpDue) {
      rows = rows.filter(
        (r) => !r.nextExpectedResponse || r.nextExpectedResponse <= filters.followUpDue!,
      );
    }
    if (filters.agingBucket) {
      rows = rows.filter((r) => ageBucket(r.daysSinceSubmission) === filters.agingBucket);
    }

    // ── Summary metrics ──────────────────────────────────────────────────
    // tabCounts + urgent + oldestAge already computed pre-page from
    // orgClaimsAll above; here we add the $ total via a single cheap
    // total_charge fetch over the same id set.
    const { data: chargeRows } = orgClaimIdsAll.length
      ? await supabase
          .from("professional_claims")
          .select("total_charge")
          .in("id", orgClaimIdsAll)
      : { data: [] as DbRow[] };
    const totalDollars = ((chargeRows ?? []) as DbRow[]).reduce(
      (s, r) => s + money(r.total_charge),
      0,
    );

    const total = totalAll;
    const oldestAge = oldestAgeRaw;
    const urgentCount = urgentCountAll;

    // ── Filter option pools (small lookups so the rail's selects render
    // real choices instead of needing pre-population on the client). ──
    const [
      { data: locationsList },
      { data: providersList },
      { data: billerEvents },
    ] = await Promise.all([
      supabase
        .from("provider_locations")
        .select("id, name")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .order("name", { ascending: true })
        .limit(200),
      supabase
        .from("providers")
        .select("id, first_name, last_name")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .order("last_name", { ascending: true })
        .limit(200),
      orgClaimIdsAll.length
        ? supabase
            .from("claim_status_events")
            .select("raw_payload")
            .eq("source", "biller")
            .in("claim_id", orgClaimIdsAll)
            .not("raw_payload->>actor_user_id", "is", null)
            .limit(500)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const billerIds = new Set<string>();
    for (const e of (billerEvents ?? []) as DbRow[]) {
      const payload = e.raw_payload as Record<string, unknown> | null;
      const actor =
        payload && typeof payload["actor_user_id"] === "string"
          ? (payload["actor_user_id"] as string)
          : null;
      if (actor) billerIds.add(actor);
    }
    const billerIdsArr = Array.from(billerIds);
    const { data: billerStaff } = billerIdsArr.length
      ? await supabase
          .from("staff_profiles")
          .select("id, first_name, last_name, email")
          .eq("organization_id", organizationId)
          .in("id", billerIdsArr)
      : { data: [] as DbRow[] };

    const filterOptions = {
      practices: ((locationsList ?? []) as DbRow[]).map((l) => ({
        value: text(l.id),
        label: text(l.name) || "Unnamed location",
      })),
      clinicians: ((providersList ?? []) as DbRow[]).map((p) => ({
        value: text(p.id),
        label:
          [p.first_name, p.last_name].map(text).filter(Boolean).join(" ") ||
          "Unnamed provider",
      })),
      billers: ((billerStaff ?? []) as DbRow[]).map((s) => ({
        value: text(s.id),
        label:
          [s.first_name, s.last_name].map(text).filter(Boolean).join(" ") ||
          text(s.email) ||
          "Biller",
      })),
    };

    return NextResponse.json({
      success: true,
      organizationId,
      summary: { total, totalDollars, oldestAge, urgentCount },
      tabCounts,
      filterOptions,
      rows,
      pagination: {
        offset,
        limit: pageSize,
        hasMore: rawClaims.length === pageSize,
        totalLoaded: rows.length,
      },
    });
  } catch (error) {
    console.error("submitted-claims API error", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "submitted-claims API failed",
      },
      { status: 500 },
    );
  }
}

function emptyTabCounts() {
  return {
    today: 0,
    awaiting_999: 0,
    awaiting_277ca: 0,
    awaiting_payer: 0,
    no_response_risk: 0,
  };
}
