/**
 * POST /api/billing/ready-to-generate/bulk-batch
 *
 * Body:
 *   {
 *     organizationId: string,
 *     claimIds: string[],
 *     payerId?: string,   // optional — if provided, all selected claims
 *                          // must be on this payer or the request is rejected
 *   }
 *
 * Bundles multiple ready_for_batch professional_claims into a single
 * claim_837p_batches row, links them via claim_837p_batch_claims, and flips
 * every claim's claim_status to 'batched' in one logical transaction. On any
 * failure mid-write, best-effort rollback removes orphaned rows so the user
 * does not end up with a half-built batch.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

function batchNumber() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `837P-${stamp}`;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      organizationId?: string;
      claimIds?: unknown;
      payerProfileId?: string | null;
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

    const { data: claims, error: fetchError } = await (supabase as any)
      .from("professional_claims")
      .select("id, claim_status, total_charge, held_at, archived_at, payer_profile_id")
      .eq("organization_id", organizationId)
      .in("id", claimIds);
    if (fetchError) throw fetchError;

    const found = (claims ?? []) as Array<{
      id: string;
      claim_status: string;
      total_charge: number | null;
      held_at: string | null;
      archived_at: string | null;
      payer_profile_id: string | null;
    }>;
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

    const totalChargeAmount = found.reduce(
      (sum, c) => sum + Number(c.total_charge ?? 0),
      0,
    );
    const now = new Date().toISOString();

    const { data: batch, error: batchError } = await (supabase as any)
      .from("claim_837p_batches")
      .insert({
        organization_id: organizationId,
        batch_number: batchNumber(),
        batch_status: "ready_to_generate",
        claim_count: found.length,
        total_charge_amount: totalChargeAmount,
        created_at: now,
        updated_at: now,
      })
      .select("id, batch_number")
      .single();
    if (batchError || !batch) {
      return NextResponse.json(
        { success: false, error: batchError?.message ?? "Failed to create batch" },
        { status: 422 },
      );
    }

    const linkRows = found.map((c) => ({
      organization_id: organizationId,
      batch_id: batch.id,
      professional_claim_id: c.id,
      created_at: now,
    }));
    const { error: linkError } = await (supabase as any)
      .from("claim_837p_batch_claims")
      .insert(linkRows);
    if (linkError) {
      await (supabase as any)
        .from("claim_837p_batches")
        .delete()
        .eq("organization_id", organizationId)
        .eq("id", batch.id);
      throw linkError;
    }

    const ids = found.map((c) => c.id);
    const { error: updateError } = await (supabase as any)
      .from("professional_claims")
      .update({ claim_status: "batched", updated_at: now })
      .eq("organization_id", organizationId)
      .in("id", ids);
    if (updateError) {
      await (supabase as any)
        .from("claim_837p_batch_claims")
        .delete()
        .eq("organization_id", organizationId)
        .eq("batch_id", batch.id);
      await (supabase as any)
        .from("claim_837p_batches")
        .delete()
        .eq("organization_id", organizationId)
        .eq("id", batch.id);
      throw updateError;
    }

    // Best-effort audit trail per claim (do not fail the batch if it errors).
    try {
      const eventRows = found.map((c) => ({
        organization_id: organizationId,
        claim_id: c.id,
        source: "ready_to_generate",
        detail: {
          action: "bulk_batch",
          batch_id: batch.id,
          batch_number: batch.batch_number,
          claim_count: found.length,
        },
      }));
      await (supabase as any).from("claim_status_events").insert(eventRows);
    } catch (err) {
      console.warn("[ready-to-generate/bulk-batch] audit insert failed", {
        organizationId,
        batchId: batch.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      batchNumber: batch.batch_number,
      claimCount: found.length,
      totalChargeAmount,
    });
  } catch (error) {
    console.error("Ready-to-Generate bulk-batch error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Bulk batch failed" },
      { status: 500 },
    );
  }
}
