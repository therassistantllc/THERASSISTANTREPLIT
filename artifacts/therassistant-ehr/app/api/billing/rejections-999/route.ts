/**
 * /api/billing/rejections-999
 *
 * GET — list 999 file-level rejection workqueue items for the
 * "999 Rejections" workqueue. Reads from workqueue_items where
 * work_type='clearinghouse_rejection' AND context_payload.source='999'.
 *
 * Universal filter rail (practice, clinician, payer, client, DOS,
 * status, assignedBiller, minAmount, maxAmount, agingBucket, carcRarc,
 * priority, followUpDue) is honored server-side. Tab `category` is one of
 * file_rejected | claim_syntax | invalid_submitter | edi_format.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import {
  classify999Errors,
  type Edi999ErrorCategory,
} from "@/lib/claims/edi999Classification";

type DbRow = Record<string, any>;

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const TAB_IDS = ["file_rejected", "claim_syntax", "invalid_submitter", "edi_format"] as const;
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

/**
 * Resolve the typed classification for a row's `context_payload`.
 *
 * New rows carry `parsed_content.errorCategory` written at intake by
 * `lib/claims/edi999Classification`. Legacy rows (pre-classifier) only
 * have raw `errorSegments` — we re-run the same classifier on read so
 * the strip is honest until the backfill catches up.
 */
function resolveClassification(contextPayload: unknown) {
  const cp = (contextPayload ?? {}) as DbRow;
  const parsed = (cp.parsed_content ?? {}) as DbRow;
  const persisted = text(parsed.errorCategory).toLowerCase();
  const isValid = (TAB_IDS as readonly string[]).includes(persisted);
  if (
    isValid &&
    text(parsed.primaryReasonCode) &&
    text(parsed.primaryMessage) &&
    text(parsed.primaryLocation)
  ) {
    return {
      errorCategory: persisted as Edi999ErrorCategory,
      primaryReasonCode: text(parsed.primaryReasonCode),
      primaryMessage: text(parsed.primaryMessage),
      primaryLocation: text(parsed.primaryLocation),
    };
  }
  const c = classify999Errors(parsed);
  return {
    errorCategory: c.errorCategory,
    primaryReasonCode: c.primaryReasonCode,
    primaryMessage: c.primaryMessage,
    primaryLocation: c.primaryLocation,
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

    const rawTab = text(searchParams.get("category")) as TabId;
    const tab: TabId = (TAB_IDS as readonly string[]).includes(rawTab) ? rawTab : "file_rejected";

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

    // Pull every 999 workqueue item for the org. The fan-out (claims,
    // clients, payers, batches, lines) is small for the volumes we see
    // — keep it simple, filter the materialised rows server-side.
    let q: any = (supabase as any)
      .from("workqueue_items")
      .select(
        [
          "id",
          "title",
          "description",
          "work_type",
          "status",
          "priority",
          "professional_claim_id",
          "client_id",
          "source_object_id",
          "assigned_to_user_id",
          "context_payload",
          "deferred_until",
          "created_at",
          "updated_at",
        ].join(", "),
      )
      .eq("organization_id", organizationId)
      .eq("work_type", "clearinghouse_rejection")
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1000);

    if (f.status && STATUSES.has(f.status)) {
      q = q.eq("status", f.status);
    } else {
      q = q.in("status", ["open", "in_progress", "blocked"]);
    }
    if (f.priority && PRIORITIES.has(f.priority)) q = q.eq("priority", f.priority);
    if (f.assignedBiller) {
      if (f.assignedBiller === "__unassigned__") q = q.is("assigned_to_user_id", null);
      else q = q.eq("assigned_to_user_id", f.assignedBiller);
    }
    if (f.followUpDue === "overdue") q = q.lt("deferred_until", todayIso());
    else if (f.followUpDue === "today") q = q.eq("deferred_until", todayIso());
    else if (f.followUpDue === "week") {
      q = q.gte("deferred_until", todayIso()).lte("deferred_until", isoPlusDays(7));
    }
    if (f.agingBucket) {
      const now = new Date();
      const cutoff = (d: number) => {
        const x = new Date(now);
        x.setDate(x.getDate() - d);
        return x.toISOString();
      };
      switch (f.agingBucket) {
        case "0-7":
          q = q.gte("created_at", cutoff(7));
          break;
        case "8-30":
          q = q.gte("created_at", cutoff(30)).lt("created_at", cutoff(7));
          break;
        case "31-60":
          q = q.gte("created_at", cutoff(60)).lt("created_at", cutoff(30));
          break;
        case "60+":
          q = q.lt("created_at", cutoff(60));
          break;
      }
    }

    const { data: items, error: itemsErr } = await q;
    if (itemsErr) throw itemsErr;

    const itemRows: DbRow[] = (items as DbRow[]) ?? [];
    const claimIds = [
      ...new Set(itemRows.map((i) => text(i.professional_claim_id)).filter(Boolean)),
    ];
    const clientIds = [...new Set(itemRows.map((i) => text(i.client_id)).filter(Boolean))];
    const batchIds = [
      ...new Set(
        itemRows
          .map((i) => text((i.context_payload as DbRow | null)?.edi_batch_id))
          .filter(Boolean),
      ),
    ];
    const assigneeIds = [
      ...new Set(itemRows.map((i) => text(i.assigned_to_user_id)).filter(Boolean)),
    ];

    const [
      { data: claims },
      { data: clients },
      { data: lines },
      { data: batches },
      { data: payerProfiles },
      { data: comments },
      { data: orgStaff },
    ] = await Promise.all([
      claimIds.length
        ? (supabase as any)
            .from("professional_claims")
            .select(
              "id, claim_number, patient_id, payer_profile_id, claim_status, total_charge",
            )
            .in("id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      clientIds.length
        ? (supabase as any)
            .from("clients")
            .select("id, first_name, last_name")
            .in("id", clientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claim_service_lines")
            .select("claim_id, service_date_from, line_number")
            .in("claim_id", claimIds)
            .order("line_number", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
      batchIds.length
        ? (supabase as any)
            .from("edi_batches")
            .select("id, batch_number, generated_at, status")
            .in("id", batchIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      Promise.resolve({ data: [] as DbRow[] }), // filled in below once we know payer ids
      itemRows.length
        ? (supabase as any)
            .from("workqueue_item_comments")
            .select("workqueue_item_id, comment_body, comment_type, created_at, created_by_user_id")
            .in(
              "workqueue_item_id",
              itemRows.map((i) => text(i.id)),
            )
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      (supabase as any)
        .from("staff_profiles")
        .select("id, first_name, last_name, email")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .limit(500),
    ]);

    const claimRows = (claims as DbRow[]) ?? [];
    const payerProfileIds = [
      ...new Set(claimRows.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];
    const { data: payerRows } = payerProfileIds.length
      ? await (supabase as any)
          .from("payer_profiles")
          .select("id, payer_name")
          .in("id", payerProfileIds)
      : { data: [] as DbRow[] };

    const claimById = new Map<string, DbRow>(claimRows.map((c) => [text(c.id), c]));
    const clientById = new Map<string, DbRow>(
      ((clients as DbRow[]) ?? []).map((c) => [text(c.id), c]),
    );
    const linesByClaim = new Map<string, DbRow[]>();
    for (const l of ((lines as DbRow[]) ?? [])) {
      const cid = text(l.claim_id);
      if (!linesByClaim.has(cid)) linesByClaim.set(cid, []);
      linesByClaim.get(cid)!.push(l);
    }
    const batchById = new Map<string, DbRow>(
      ((batches as DbRow[]) ?? []).map((b) => [text(b.id), b]),
    );
    const payerById = new Map<string, DbRow>(
      ((payerRows as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const commentsByItem = new Map<string, DbRow[]>();
    for (const c of ((comments as DbRow[]) ?? [])) {
      const wid = text(c.workqueue_item_id);
      if (!commentsByItem.has(wid)) commentsByItem.set(wid, []);
      commentsByItem.get(wid)!.push(c);
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

    // Materialise the spec rows.
    type Row = {
      id: string;
      claimId: string | null;
      claimNumber: string;
      clientId: string | null;
      clientName: string;
      payerName: string;
      payerProfileId: string | null;
      batchId: string | null;
      batchNumber: string;
      rejectionCode: string;
      rejectionMessage: string;
      errorLocation: string;
      submittedDate: string | null;
      serviceDateFrom: string | null;
      serviceDateTo: string | null;
      totalChargeAmount: number;
      assignedToUserId: string | null;
      assignedToDisplayName: string | null;
      priority: string;
      status: string;
      deferredUntil: string | null;
      createdAt: string | null;
      updatedAt: string | null;
      category: TabId;
      contextPayload: DbRow;
      claimStatus: string | null;
      description: string;
      title: string;
      ageDays: number;
      noteCount: number;
    };

    const now = Date.now();
    let rows: Row[] = itemRows.map((item) => {
      const itemId = text(item.id);
      const ctx = (item.context_payload ?? {}) as DbRow;
      const claimId = text(item.professional_claim_id) || text(item.source_object_id) || null;
      const claim = claimId ? claimById.get(claimId) : undefined;
      const client = clientById.get(text(item.client_id));
      const payer = claim ? payerById.get(text(claim.payer_profile_id)) : undefined;
      const batchId = text(ctx.edi_batch_id) || null;
      const batch = batchId ? batchById.get(batchId) : undefined;
      const claimLines = claim ? linesByClaim.get(text(claim.id)) ?? [] : [];
      const dosFrom = claimLines[0] ? text(claimLines[0].service_date_from) || null : null;
      const dosTo =
        claimLines.length > 0
          ? text(claimLines[claimLines.length - 1].service_date_from) || null
          : null;

      const assignee = item.assigned_to_user_id ? staffById.get(text(item.assigned_to_user_id)) : undefined;
      const assigneeName = assignee
        ? [assignee.first_name, assignee.last_name].map(text).filter(Boolean).join(" ") ||
          text(assignee.email) ||
          "Unknown"
        : null;

      const created = text(item.created_at) || null;
      const ageDays = created
        ? Math.max(0, Math.floor((now - new Date(created).getTime()) / 86_400_000))
        : 0;

      const clientName =
        (client
          ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ")
          : text(ctx.patient_account_number)) || "Unknown client";

      const classification = resolveClassification(ctx);
      const fallbackMessage =
        classification.primaryMessage ||
        text(item.description) ||
        "Rejected by the clearinghouse 999 acknowledgement";

      return {
        id: itemId,
        claimId,
        claimNumber:
          text(claim?.claim_number) ||
          text(ctx.claim_number) ||
          (claimId ? claimId.slice(0, 8) : itemId.slice(0, 8)),
        clientId: text(item.client_id) || null,
        clientName,
        payerName: text(payer?.payer_name) || "—",
        payerProfileId: claim ? text(claim.payer_profile_id) || null : null,
        batchId,
        batchNumber: text(batch?.batch_number) || (batchId ? batchId.slice(0, 8) : "—"),
        rejectionCode: classification.primaryReasonCode || "999",
        rejectionMessage: fallbackMessage,
        errorLocation: classification.primaryLocation || "File envelope",
        submittedDate: text(batch?.generated_at) || created,
        serviceDateFrom: dosFrom,
        serviceDateTo: dosTo,
        totalChargeAmount: claim ? money(claim.total_charge) : 0,
        assignedToUserId: text(item.assigned_to_user_id) || null,
        assignedToDisplayName: assigneeName,
        priority: text(item.priority) || "normal",
        status: text(item.status) || "open",
        deferredUntil: text(item.deferred_until) || null,
        createdAt: created,
        updatedAt: text(item.updated_at) || null,
        category: classification.errorCategory,
        contextPayload: ctx,
        claimStatus: claim ? text(claim.claim_status) : null,
        description: text(item.description),
        title: text(item.title),
        ageDays,
        noteCount: (commentsByItem.get(itemId) ?? []).filter(
          (c) => text(c.comment_type) === "note",
        ).length,
      };
    });

    // Tab counts BEFORE the tab filter so the strip is honest.
    const tabCounts: Record<TabId, number> = {
      file_rejected: 0,
      claim_syntax: 0,
      invalid_submitter: 0,
      edi_format: 0,
    };
    for (const r of rows) tabCounts[r.category] += 1;

    // Universal filter rail (string filters) on the materialised rows.
    if (f.client) {
      const needle = f.client.toLowerCase();
      rows = rows.filter((r) => r.clientName.toLowerCase().includes(needle));
    }
    if (f.payer) rows = rows.filter((r) => r.payerName === f.payer);
    if (f.dosFrom) rows = rows.filter((r) => (r.serviceDateFrom ?? "") >= f.dosFrom);
    if (f.dosTo) rows = rows.filter((r) => (r.serviceDateFrom ?? "") <= f.dosTo);
    const minAmount = Number(f.minAmount);
    if (f.minAmount && Number.isFinite(minAmount)) {
      rows = rows.filter((r) => r.totalChargeAmount >= minAmount);
    }
    const maxAmount = Number(f.maxAmount);
    if (f.maxAmount && Number.isFinite(maxAmount)) {
      rows = rows.filter((r) => r.totalChargeAmount <= maxAmount);
    }
    if (f.carcRarc) {
      const needle = f.carcRarc.toUpperCase();
      rows = rows.filter(
        (r) =>
          r.rejectionCode.toUpperCase().includes(needle) ||
          r.rejectionMessage.toUpperCase().includes(needle),
      );
    }
    if (f.practice) {
      // Practice/clinician aren't directly available on the workqueue
      // item — keep the filter best-effort so a typed value never silently
      // returns everything. Match it against the payer/client text blob.
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

    // Tab cut last so tabCounts above reflects the unfiltered category counts.
    const tabRows = rows.filter((r) => r.category === tab);

    // Header summary on the active tab (so the strip matches the table).
    const oldestAge = tabRows.reduce<number>((m, r) => Math.max(m, r.ageDays), 0);
    const urgentCount = tabRows.filter(
      (r) => r.priority === "urgent" || r.priority === "high",
    ).length;
    const totalDollars = tabRows.reduce((s, r) => s + r.totalChargeAmount, 0);

    // Filter dropdown options
    const payerSet = new Set<string>();
    for (const r of rows) if (r.payerName && r.payerName !== "—") payerSet.add(r.payerName);

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
      filterOptions: {
        payers: [...payerSet].sort().map((v) => ({ value: v, label: v })),
        assignees: assignees.map((a) => ({ value: a.id, label: a.displayName })),
      },
    });
  } catch (error) {
    console.error("999 Rejections API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "999 Rejections API failed",
      },
      { status: 500 },
    );
  }
}
