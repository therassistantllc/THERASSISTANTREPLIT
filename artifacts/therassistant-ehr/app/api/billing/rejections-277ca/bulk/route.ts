/**
 * POST /api/billing/rejections-277ca/bulk
 *
 * Body:
 *   {
 *     organizationId: string,
 *     action: "resubmit_corrected_claim" | "route_to_eligibility"
 *           | "route_to_enrollment"      | "mark_resolved"
 *           | "undo_auto_route",
 *     itemIds: string[],
 *     note?: string,
 *   }
 *
 * Applies the same per-item action (defined in `rejections277caActions.ts`)
 * to many workqueue items in one request. Iterates sequentially so a single
 * row failure does not abort the rest, then returns per-item success/failure
 * so the UI can show partial-success feedback.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import {
  applyRejection277CaAction,
  type Rejection277CaActionId,
} from "@/lib/billing/rejections277caActions";

const ALLOWED_BULK_ACTIONS: ReadonlySet<Rejection277CaActionId> = new Set([
  "resubmit_corrected_claim",
  "route_to_eligibility",
  "route_to_enrollment",
  "mark_resolved",
  "undo_auto_route",
]);

const MAX_BULK_ITEMS = 500;

type BulkBody = {
  organizationId?: string;
  action?: Rejection277CaActionId;
  itemIds?: unknown;
  note?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as BulkBody;

    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const { organizationId, userId, staffId } = guard;

    const action = body.action;
    if (!action || !ALLOWED_BULK_ACTIONS.has(action)) {
      return NextResponse.json(
        {
          success: false,
          error: `action must be one of: ${[...ALLOWED_BULK_ACTIONS].join(", ")}`,
        },
        { status: 400 },
      );
    }

    const itemIds = Array.isArray(body.itemIds)
      ? Array.from(
          new Set(
            body.itemIds
              .filter((x): x is string => typeof x === "string" && x.length > 0)
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        )
      : [];
    if (itemIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "itemIds must be a non-empty array" },
        { status: 400 },
      );
    }
    if (itemIds.length > MAX_BULK_ITEMS) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot apply bulk action to more than ${MAX_BULK_ITEMS} items at once`,
        },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const results: Array<{
      itemId: string;
      ok: boolean;
      error?: string;
    }> = [];

    for (const itemId of itemIds) {
      try {
        const r = await applyRejection277CaAction({
          supabase,
          organizationId,
          userId,
          staffId,
          itemId,
          action,
          note: body.note ?? null,
        });
        results.push({ itemId, ok: r.ok, error: r.ok ? undefined : r.error });
      } catch (e) {
        results.push({
          itemId,
          ok: false,
          error: e instanceof Error ? e.message : "Action failed",
        });
      }
    }

    const successCount = results.filter((r) => r.ok).length;
    const failedCount = results.length - successCount;

    return NextResponse.json({
      success: failedCount === 0,
      action,
      totalCount: results.length,
      successCount,
      failedCount,
      results,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Bulk action failed" },
      { status: 500 },
    );
  }
}
