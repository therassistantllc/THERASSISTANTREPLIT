/**
 * POST /api/billing/ready-to-generate/bulk-batch
 *
 * Body:
 *   {
 *     organizationId: string,
 *     claimIds: string[],
 *     payerProfileId?: string,   // optional — if provided, every selected
 *                                  // claim must be on this payer
 *     splitByPayer?: boolean,    // if true, partition the selection by
 *                                  // payer_profile_id and create ONE batch
 *                                  // per payer in a single request
 *   }
 *
 * Clearinghouses (Availity included) expect one payer per 837P file. This
 * endpoint enforces that invariant in TWO ways:
 *
 *   1. Hard pre-flight: a multi-payer selection without `splitByPayer:true`
 *      is rejected with 422 + a per-payer breakdown so the caller can
 *      either narrow the selection or opt into the split path.
 *   2. Opt-in split: with `splitByPayer:true`, the selection is grouped by
 *      payer_profile_id and one claim_837p_batches row is created per
 *      group. Claims missing a payer profile cannot be batched and force
 *      a 422 before any writes happen.
 *
 * Each per-payer batch (the insert / link / status-flip sequence) is
 * delegated to the `create_837p_batch_atomic` Postgres function so that
 * the three writes for a single batch commit or roll back as one
 * transaction — a mid-process kill can never leave one of the per-payer
 * batches half-built. When the request fans out into N batches and a
 * later batch fails, the prior successfully-committed batches are undone
 * best-effort in JS (the cross-batch rollback can't be wrapped in a
 * single Postgres transaction here without piping the whole fan-out into
 * the RPC).
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const UNASSIGNED_PAYER_KEY = "__no_payer__";

function batchNumber(suffix?: number) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return suffix == null ? `837P-${stamp}` : `837P-${stamp}-${suffix}`;
}

type ClaimRow = {
  id: string;
  claim_status: string;
  total_charge: number | null;
  held_at: string | null;
  archived_at: string | null;
  payer_profile_id: string | null;
};

type CreatedBatch = {
  payerProfileId: string | null;
  batchId: string;
  batchNumber: string;
  claimCount: number;
  totalChargeAmount: number;
  claimIds: string[];
};

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      organizationId?: string;
      claimIds?: unknown;
      payerProfileId?: string | null;
      splitByPayer?: boolean;
    };

    const claimIds = Array.isArray(body.claimIds)
      ? Array.from(new Set(body.claimIds.filter((x): x is string => typeof x === "string" && x.length > 0)))
      : [];
    if (claimIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "claimIds must be a non-empty array" },
        { status: 400 },
      );
    }
    if (claimIds.length > 500) {
      return NextResponse.json(
        { success: false, error: "Cannot batch more than 500 claims at once" },
        { status: 400 },
      );
    }

    const splitByPayer = body.splitByPayer === true;

    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    // Pre-flight fetch so we can validate the selection (presence, status,
    // payer grouping) and reject a multi-payer mix before any writes. The
    // atomic RPC re-validates every claim it touches, so this is a UX
    // niceness for the payer-split breakdown, not an authoritative check.
    const { data: claims, error: fetchError } = await (supabase as any)
      .from("professional_claims")
      .select("id, claim_status, total_charge, held_at, archived_at, payer_profile_id")
      .eq("organization_id", organizationId)
      .in("id", claimIds);
    if (fetchError) throw fetchError;

    const found = (claims ?? []) as ClaimRow[];
    if (found.length !== claimIds.length) {
      const foundIds = new Set(found.map((c) => c.id));
      const missing = claimIds.filter((id) => !foundIds.has(id));
      return NextResponse.json(
        { success: false, error: `Claims not found: ${missing.join(", ")}` },
        { status: 404 },
      );
    }

    const archived = found.filter((c) => c.archived_at);
    if (archived.length > 0) {
      return NextResponse.json(
        { success: false, error: `${archived.length} selected claim(s) are archived` },
        { status: 422 },
      );
    }
    const held = found.filter((c) => c.held_at);
    if (held.length > 0) {
      return NextResponse.json(
        { success: false, error: `${held.length} selected claim(s) are on hold; release the hold(s) before batching` },
        { status: 422 },
      );
    }
    const notReady = found.filter((c) => c.claim_status !== "ready_for_batch");
    if (notReady.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `${notReady.length} selected claim(s) are not ready_for_batch (statuses: ${[
            ...new Set(notReady.map((c) => c.claim_status)),
          ].join(", ")})`,
        },
        { status: 422 },
      );
    }

    if (body.payerProfileId) {
      const wrongPayer = found.filter((c) => c.payer_profile_id !== body.payerProfileId);
      if (wrongPayer.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: `${wrongPayer.length} selected claim(s) do not match the requested payer`,
          },
          { status: 422 },
        );
      }
    }

    // ── Group selection by payer ───────────────────────────────────────────
    const groups = new Map<string, ClaimRow[]>();
    for (const c of found) {
      const key = c.payer_profile_id ?? UNASSIGNED_PAYER_KEY;
      const list = groups.get(key);
      if (list) list.push(c);
      else groups.set(key, [c]);
    }

    const payerBreakdown = [...groups.entries()].map(([key, rows]) => ({
      payerProfileId: key === UNASSIGNED_PAYER_KEY ? null : key,
      claimCount: rows.length,
      totalChargeAmount: rows.reduce((s, r) => s + Number(r.total_charge ?? 0), 0),
    }));

    // Claims without a payer profile cannot be sent on an 837P — block early
    // whether we're splitting or not.
    if (groups.has(UNASSIGNED_PAYER_KEY)) {
      const orphan = groups.get(UNASSIGNED_PAYER_KEY)!;
      return NextResponse.json(
        {
          success: false,
          error: `${orphan.length} selected claim(s) have no payer assigned; assign a payer before batching`,
          payerBreakdown,
        },
        { status: 422 },
      );
    }

    // Hard pre-flight: refuse to mix payers in one 837P. The caller can
    // either narrow the selection or pass splitByPayer:true to fan out.
    if (!splitByPayer && groups.size > 1) {
      return NextResponse.json(
        {
          success: false,
          code: "multi_payer_selection",
          error: `Selection spans ${groups.size} payers. Pass splitByPayer:true to create one batch per payer, or filter to a single payer.`,
          payerBreakdown,
        },
        { status: 422 },
      );
    }

    const created: CreatedBatch[] = [];

    // Cleanup helper: undo every batch+links+status-flip created so far so
    // an N-of-M failure doesn't leave the org with half a fan-out. Each
    // individual batch was committed atomically by the RPC, but the
    // cross-batch fan-out is not itself a single transaction.
    async function rollback(reason: unknown): Promise<never> {
      for (const b of created) {
        try {
          await (supabase as any)
            .from("professional_claims")
            .update({ claim_status: "ready_for_batch", updated_at: new Date().toISOString() })
            .eq("organization_id", organizationId)
            .in("id", b.claimIds);
        } catch (err) {
          console.warn("[bulk-batch] rollback status flip failed", { batchId: b.batchId, err });
        }
        try {
          await (supabase as any)
            .from("claim_837p_batch_claims")
            .delete()
            .eq("organization_id", organizationId)
            .eq("batch_id", b.batchId);
        } catch (err) {
          console.warn("[bulk-batch] rollback link delete failed", { batchId: b.batchId, err });
        }
        try {
          await (supabase as any)
            .from("claim_837p_batches")
            .delete()
            .eq("organization_id", organizationId)
            .eq("id", b.batchId);
        } catch (err) {
          console.warn("[bulk-batch] rollback batch delete failed", { batchId: b.batchId, err });
        }
      }
      throw reason;
    }

    // Stable order so the per-payer batch_number suffix is deterministic
    // (helps log/audit readability).
    const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

    for (let i = 0; i < orderedGroups.length; i++) {
      const [payerKey, rows] = orderedGroups[i];
      const payerProfileId = payerKey === UNASSIGNED_PAYER_KEY ? null : payerKey;
      const totalChargeAmount = rows.reduce((s, r) => s + Number(r.total_charge ?? 0), 0);
      const number = orderedGroups.length === 1 ? batchNumber() : batchNumber(i + 1);
      const ids = rows.map((c) => c.id);

      // Atomic per-batch write: insert batch row + link rows + flip
      // claim_status all in a single Postgres transaction. If the RPC
      // raises, fall through to the JS-side cross-batch rollback so any
      // earlier per-payer batches in this same request get undone.
      const { data: rpcData, error: rpcError } = await (supabase as any).rpc(
        "create_837p_batch_atomic",
        {
          p_organization_id: organizationId,
          p_claim_ids: ids,
          p_batch_number: number,
          p_payer_profile_id: payerProfileId,
        },
      );
      if (rpcError) {
        await rollback(rpcError);
      }
      const result = (rpcData ?? {}) as {
        batch_id?: string;
        batch_number?: string;
        claim_count?: number;
        total_charge_amount?: number | string;
      };
      if (!result.batch_id) {
        await rollback(new Error("Batch creation returned no batch id"));
      }

      created.push({
        payerProfileId,
        batchId: result.batch_id!,
        batchNumber: result.batch_number ?? number,
        claimCount: result.claim_count ?? rows.length,
        totalChargeAmount,
        claimIds: ids,
      });
    }

    // Best-effort audit trail per claim (do not fail the batch if it errors).
    try {
      const eventRows = created.flatMap((b) =>
        b.claimIds.map((cid) => ({
          organization_id: organizationId,
          claim_id: cid,
          source: "ready_to_generate",
          detail: {
            action: "bulk_batch",
            batch_id: b.batchId,
            batch_number: b.batchNumber,
            claim_count: b.claimCount,
            payer_profile_id: b.payerProfileId,
            split_by_payer: splitByPayer && created.length > 1,
          },
        })),
      );
      if (eventRows.length > 0) {
        await (supabase as any).from("claim_status_events").insert(eventRows);
      }
    } catch (err) {
      console.warn("[ready-to-generate/bulk-batch] audit insert failed", {
        organizationId,
        batchIds: created.map((b) => b.batchId),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const totalChargeAmount = created.reduce((s, b) => s + b.totalChargeAmount, 0);
    const totalClaims = created.reduce((s, b) => s + b.claimCount, 0);

    // Preserve the single-batch response shape callers already depend on,
    // and add a `batches` array for the split path.
    const first = created[0];
    return NextResponse.json({
      success: true,
      batchId: first.batchId,
      batchNumber: first.batchNumber,
      claimCount: totalClaims,
      totalChargeAmount,
      batches: created.map((b) => ({
        payerProfileId: b.payerProfileId,
        batchId: b.batchId,
        batchNumber: b.batchNumber,
        claimCount: b.claimCount,
        totalChargeAmount: b.totalChargeAmount,
      })),
    });
  } catch (error) {
    console.error("Ready-to-Generate bulk-batch error:", error);
    // Map RPC validation errors to friendly status codes when possible.
    const err = error as { code?: string; message?: string };
    if (err?.code === "P0002") {
      return NextResponse.json({ success: false, error: err.message ?? "Not found" }, { status: 404 });
    }
    if (err?.code === "22023") {
      return NextResponse.json({ success: false, error: err.message ?? "Validation failed" }, { status: 422 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Bulk batch failed" },
      { status: 500 },
    );
  }
}
