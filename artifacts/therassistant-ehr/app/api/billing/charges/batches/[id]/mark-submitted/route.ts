import { NextResponse } from "next/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type DbRow = Record<string, unknown>;

function text(value: unknown) {
  return String(value ?? "").trim();
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json().catch(() => ({}));
    const guard = await requireBillingAccess({ requestedOrganizationId: body.organizationId ?? null });
    if (guard instanceof NextResponse) return guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { id } = await ctx.params;

    const { data: batch, error: lookupError } = await (supabase as unknown as { from: (table: string) => any })
      .from("claim_837p_batches")
      .select("id, batch_source, batch_status")
      .eq("organization_id", guard.organizationId)
      .eq("id", id)
      .eq("batch_source", "charge_auto")
      .is("archived_at", null)
      .maybeSingle();

    if (lookupError) {
      return NextResponse.json({ success: false, error: lookupError.message ?? "Failed to load batch" }, { status: 422 });
    }
    if (!batch) {
      return NextResponse.json({ success: false, error: "Batch not found" }, { status: 404 });
    }

    const now = new Date().toISOString();

    const { error: batchUpdateError } = await (supabase as unknown as { from: (table: string) => any })
      .from("claim_837p_batches")
      .update({
        batch_status: "submitted",
        submitted_at: now,
        submission_error: null,
        updated_at: now,
      })
      .eq("organization_id", guard.organizationId)
      .eq("id", id);

    if (batchUpdateError) {
      return NextResponse.json(
        { success: false, error: batchUpdateError.message ?? "Failed to update batch" },
        { status: 422 },
      );
    }

    const { data: links } = await (supabase as unknown as { from: (table: string) => any })
      .from("claim_837p_batch_claims")
      .select("professional_claim_id")
      .eq("organization_id", guard.organizationId)
      .eq("batch_id", id)
      .is("archived_at", null);

    const claimIds = ((links ?? []) as DbRow[]).map((r) => text(r.professional_claim_id)).filter(Boolean);

    if (claimIds.length > 0) {
      await (supabase as unknown as { from: (table: string) => any })
        .from("professional_claims")
        .update({ claim_status: "submitted", submitted_at: now, updated_at: now })
        .eq("organization_id", guard.organizationId)
        .in("id", claimIds)
        .in("claim_status", ["batched", "ready_for_batch"]);
    }

    return NextResponse.json({ success: true, batchId: id, status: "submitted", submittedAt: now });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to mark batch submitted" },
      { status: 500 },
    );
  }
}
