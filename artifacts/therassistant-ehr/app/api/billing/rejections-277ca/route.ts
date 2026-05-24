/**
 * GET /api/billing/rejections-277ca
 *
 * Powers the 277CA Rejections workqueue (/billing/rejections-277ca). Each
 * row represents an open `workqueue_items` row created by
 * `routeRejectedClaimsToWorkqueue` for a 277CA acknowledgement.
 *
 * Honors the universal filter rail server-side where the field is in the
 * underlying claim/workqueue row, and post-filters in-memory for fields
 * that come from joined dimensions.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import {
  classifyRejection277Ca,
  rejection277CaCategoryLabel,
  type Rejection277CaTabId,
} from "@/lib/billing/rejections277ca";

type DbRow = Record<string, unknown>;

interface RowOut {
  id: string;
  workqueueItemId: string;
  claimId: string;
  claimNumber: string | null;
  clientId: string | null;
  clientName: string;
  payerId: string | null;
  payerName: string | null;
  practiceName: string | null;
  clinicianName: string | null;
  dos: string | null;
  ca277Status: string;
  rejectionReason: string;
  category: string;
  categoryCode: string | null;
  statusCode: string | null;
  entityCode: string | null;
  tab: Rejection277CaTabId;
  totalCharge: number;
  dateRejected: string | null;
  assignedTo: string | null;
  status: string;
  priority: string | null;
  followUpDue: string | null;
  agingDays: number | null;
  correctionHistory: Array<{
    id: string;
    body: string;
    type: string;
    createdAt: string | null;
    createdBy: string | null;
  }>;
  contextPayload: Record<string, unknown>;
}

function text(v: unknown): string {
  return String(v ?? "").trim();
}

function fullName(first: unknown, last: unknown): string {
  const parts = [text(first), text(last)].filter(Boolean);
  return parts.join(" ") || "Unknown client";
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function bucketMatch(age: number | null, bucket: string | null): boolean {
  if (!bucket) return true;
  const a = age ?? 0;
  switch (bucket) {
    case "0-7": return a <= 7;
    case "8-30": return a >= 8 && a <= 30;
    case "31-60": return a >= 31 && a <= 60;
    case "60+": return a > 60;
    default: return true;
  }
}

function ciContains(haystack: string | null, needle: string | null): boolean {
  if (!needle) return true;
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function pickString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = payload[k];
    if (v == null) continue;
    const t = text(v);
    if (t) return t;
  }
  return null;
}

function extractFromContext(ctx: Record<string, unknown> | null) {
  if (!ctx) {
    return {
      message: "",
      categoryCode: null as string | null,
      statusCode: null as string | null,
      entityCode: null as string | null,
      ca277Status: "",
      source: null as string | null,
    };
  }
  const parsed = (ctx.parsed_content as Record<string, unknown> | undefined) ?? {};
  const message =
    pickString(parsed, [
      "rejection_reason",
      "status_message",
      "message",
      "free_form_message",
    ]) ||
    pickString(ctx, ["rejection_reason", "message"]) ||
    "Rejected — see acknowledgement";
  const categoryCode =
    pickString(parsed, ["category_code", "stc_category_code", "stc01_1"]) ?? null;
  const statusCode =
    pickString(parsed, ["status_code", "stc_status_code", "stc01_2"]) ?? null;
  const entityCode =
    pickString(parsed, ["entity_code", "stc_entity_code", "stc01_3"]) ?? null;
  const ca277Status =
    pickString(parsed, ["action_code", "stc_action_code", "ack_status"]) ??
    (categoryCode ? `${categoryCode}${statusCode ? `:${statusCode}` : ""}` : "Rejected");
  const source = pickString(ctx, ["source"]);
  return { message, categoryCode, statusCode, entityCode, ca277Status, source };
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
      payer: searchParams.get("payer"),
      client: searchParams.get("client"),
      status: searchParams.get("status"),
      dosFrom: searchParams.get("dosFrom"),
      dosTo: searchParams.get("dosTo"),
      minAmount: searchParams.get("minAmount"),
      maxAmount: searchParams.get("maxAmount"),
      agingBucket: searchParams.get("agingBucket"),
      practice: searchParams.get("practice"),
      clinician: searchParams.get("clinician"),
      assignedBiller: searchParams.get("assignedBiller"),
      carcRarc: searchParams.get("carcRarc"),
      priority: searchParams.get("priority"),
      followUpDue: searchParams.get("followUpDue"),
    };

    // Pull open / in-progress 277CA workqueue items.
    let wqQuery = (supabase as any)
      .from("workqueue_items")
      .select(
        "id, status, priority, assigned_to_user_id, deferred_until, created_at, updated_at, " +
          "professional_claim_id, client_id, context_payload",
      )
      .eq("organization_id", organizationId)
      .eq("work_type", "payer_rejection")
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(500);

    if (filter.status) {
      wqQuery = wqQuery.eq("status", filter.status);
    } else {
      wqQuery = wqQuery.in("status", ["open", "in_progress", "blocked"]);
    }
    if (filter.priority) wqQuery = wqQuery.eq("priority", filter.priority);

    const { data: wqRows, error: wqErr } = await wqQuery;
    if (wqErr) throw wqErr;

    // Keep only 277CA-sourced items (the same work_type is also used by 999
    // payer rejections — the source discriminator lives in context_payload).
    const items = ((wqRows ?? []) as DbRow[]).filter((row) => {
      const ctx = (row.context_payload as Record<string, unknown> | null) ?? null;
      return text(ctx?.source) === "277CA";
    });

    const claimIds = Array.from(
      new Set(items.map((r) => text(r.professional_claim_id)).filter(Boolean)),
    );
    const clientIds = Array.from(
      new Set(items.map((r) => text(r.client_id)).filter(Boolean)),
    );
    const assignedIds = Array.from(
      new Set(
        items.map((r) => text(r.assigned_to_user_id)).filter(Boolean),
      ),
    );

    const [
      { data: claims },
      { data: clients },
      { data: lines },
      { data: comments },
      { data: assignees },
    ] = await Promise.all([
      claimIds.length
        ? (supabase as any)
            .from("professional_claims")
            .select(
              "id, claim_number, claim_status, payer_profile_id, total_charge, rendering_provider_id, service_location_id",
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
            .select("claim_id, service_date_from")
            .in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      items.length
        ? (supabase as any)
            .from("workqueue_item_comments")
            .select(
              "id, workqueue_item_id, comment_body, comment_type, created_at, created_by_user_id",
            )
            .in(
              "workqueue_item_id",
              items.map((r) => text(r.id)),
            )
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      assignedIds.length
        ? (supabase as any)
            .from("users")
            .select("id, full_name, email")
            .in("id", assignedIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const payerIds = Array.from(
      new Set(
        ((claims ?? []) as DbRow[])
          .map((c) => text(c.payer_profile_id))
          .filter(Boolean),
      ),
    );
    const renderingIds = Array.from(
      new Set(
        ((claims ?? []) as DbRow[])
          .map((c) => text(c.rendering_provider_id))
          .filter(Boolean),
      ),
    );
    const locationIds = Array.from(
      new Set(
        ((claims ?? []) as DbRow[])
          .map((c) => text(c.service_location_id))
          .filter(Boolean),
      ),
    );

    const [{ data: payers }, { data: providers }, { data: locations }] =
      await Promise.all([
        payerIds.length
          ? (supabase as any)
              .from("payer_profiles")
              .select("id, payer_name")
              .in("id", payerIds)
          : Promise.resolve({ data: [] as DbRow[] }),
        renderingIds.length
          ? (supabase as any)
              .from("providers")
              .select("id, first_name, last_name, full_name")
              .in("id", renderingIds)
          : Promise.resolve({ data: [] as DbRow[] }),
        locationIds.length
          ? (supabase as any)
              .from("service_locations")
              .select("id, location_name")
              .in("id", locationIds)
          : Promise.resolve({ data: [] as DbRow[] }),
      ]);

    const claimById = new Map<string, DbRow>(
      ((claims ?? []) as DbRow[]).map((c) => [text(c.id), c]),
    );
    const clientById = new Map<string, DbRow>(
      ((clients ?? []) as DbRow[]).map((c) => [text(c.id), c]),
    );
    const payerById = new Map<string, DbRow>(
      ((payers ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const providerById = new Map<string, DbRow>(
      ((providers ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const locationById = new Map<string, DbRow>(
      ((locations ?? []) as DbRow[]).map((l) => [text(l.id), l]),
    );
    const assigneeById = new Map<string, DbRow>(
      ((assignees ?? []) as DbRow[]).map((u) => [text(u.id), u]),
    );

    const dosByClaim = new Map<string, string | null>();
    for (const line of (lines ?? []) as DbRow[]) {
      const cid = text(line.claim_id);
      const dt = (line.service_date_from as string | null) ?? null;
      if (!cid || !dt) continue;
      const cur = dosByClaim.get(cid);
      if (!cur || dt < cur) dosByClaim.set(cid, dt);
    }

    const commentsByItem = new Map<string, DbRow[]>();
    for (const c of (comments ?? []) as DbRow[]) {
      const itemId = text(c.workqueue_item_id);
      const arr = commentsByItem.get(itemId) ?? [];
      arr.push(c);
      commentsByItem.set(itemId, arr);
    }

    const rows: RowOut[] = items.map((row) => {
      const itemId = text(row.id);
      const claimId = text(row.professional_claim_id);
      const clientId = text(row.client_id);
      const claim = claimById.get(claimId);
      const client = clientById.get(clientId);
      const payerId = text(claim?.payer_profile_id);
      const payer = payerById.get(payerId);
      const provider = providerById.get(text(claim?.rendering_provider_id));
      const location = locationById.get(text(claim?.service_location_id));
      const ctx = (row.context_payload as Record<string, unknown> | null) ?? null;
      const extracted = extractFromContext(ctx);
      const tab = classifyRejection277Ca({
        message: extracted.message,
        categoryCode: extracted.categoryCode,
        statusCode: extracted.statusCode,
        entityCode: extracted.entityCode,
        source: extracted.source ?? "277CA",
      });
      const category = rejection277CaCategoryLabel(
        extracted.categoryCode,
        extracted.statusCode,
        tab,
      );
      const dateRejected = (row.created_at as string | null) ?? null;
      const dos = dosByClaim.get(claimId) ?? null;
      const totalCharge = Number(claim?.total_charge ?? 0) || 0;
      const aging = ageDays(dateRejected);
      const assignee = assigneeById.get(text(row.assigned_to_user_id));
      const assignedTo = assignee
        ? text(assignee.full_name) ||
          text(assignee.email) ||
          text(row.assigned_to_user_id)
        : null;
      const providerName = provider
        ? text(provider.full_name) ||
          fullName(provider.first_name, provider.last_name)
        : null;
      const itemComments = (commentsByItem.get(itemId) ?? []).map((c) => ({
        id: text(c.id),
        body: text(c.comment_body),
        type: text(c.comment_type) || "note",
        createdAt: (c.created_at as string | null) ?? null,
        createdBy: text(c.created_by_user_id) || null,
      }));

      return {
        id: itemId,
        workqueueItemId: itemId,
        claimId,
        claimNumber: text(claim?.claim_number) || null,
        clientId: clientId || null,
        clientName: client
          ? fullName(client.first_name, client.last_name)
          : "Unknown client",
        payerId: payerId || null,
        payerName: text(payer?.payer_name) || null,
        practiceName: text(location?.location_name) || null,
        clinicianName: providerName,
        dos,
        ca277Status: extracted.ca277Status,
        rejectionReason: extracted.message,
        category,
        categoryCode: extracted.categoryCode,
        statusCode: extracted.statusCode,
        entityCode: extracted.entityCode,
        tab,
        totalCharge,
        dateRejected,
        assignedTo,
        status: text(row.status) || "open",
        priority: text(row.priority) || null,
        followUpDue: (row.deferred_until as string | null) ?? null,
        agingDays: aging,
        correctionHistory: itemComments,
        contextPayload: ctx ?? {},
      };
    });

    // Apply remaining (in-memory) filters that involve joined fields.
    const filtered = rows.filter((r) => {
      if (filter.payer && r.payerId !== filter.payer) return false;
      if (filter.client && r.clientId !== filter.client) return false;
      if (filter.dosFrom && (!r.dos || r.dos < filter.dosFrom)) return false;
      if (filter.dosTo && (!r.dos || r.dos > filter.dosTo)) return false;
      if (filter.minAmount) {
        const n = Number(filter.minAmount);
        if (Number.isFinite(n) && r.totalCharge < n) return false;
      }
      if (filter.maxAmount) {
        const n = Number(filter.maxAmount);
        if (Number.isFinite(n) && r.totalCharge > n) return false;
      }
      if (!bucketMatch(r.agingDays, filter.agingBucket)) return false;
      if (filter.practice && !ciContains(r.practiceName, filter.practice)) return false;
      if (filter.clinician && !ciContains(r.clinicianName, filter.clinician)) return false;
      if (filter.assignedBiller) {
        const needle = filter.assignedBiller.trim().toLowerCase();
        const isUnassigned = ["unassigned", "—", "-", "none"].includes(needle);
        if (isUnassigned) {
          if (r.assignedTo) return false;
        } else if (!ciContains(r.assignedTo, filter.assignedBiller)) {
          return false;
        }
      }
      if (filter.carcRarc) {
        if (
          !ciContains(r.rejectionReason, filter.carcRarc) &&
          !ciContains(r.category, filter.carcRarc) &&
          !ciContains(r.ca277Status, filter.carcRarc)
        ) {
          return false;
        }
      }
      if (filter.followUpDue) {
        if (!r.followUpDue || !r.followUpDue.startsWith(filter.followUpDue)) {
          return false;
        }
      }
      return true;
    });

    return NextResponse.json({
      success: true,
      organizationId,
      generatedAt: new Date().toISOString(),
      items: filtered,
      count: filtered.length,
    });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Failed to load 277CA rejections",
      },
      { status: 500 },
    );
  }
}
