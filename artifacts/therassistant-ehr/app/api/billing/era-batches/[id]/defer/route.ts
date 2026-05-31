/**
 * POST /api/billing/era-batches/[id]/defer
 * Body: { organizationId, undo?: boolean, note?: string }
 *
 * Marks the batch as deferred (biller wants to revisit later). Stored as
 * `parsed_summary.deferred = true` because the importer status
 * enum does not include a 'deferred' value.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      organizationId?: string;
      undo?: boolean;
      note?: string;
    };
    const organizationId = body.organizationId ? String(body.organizationId) : "";
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }
    await requireAuthenticatedPaymentPoster(organizationId);

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { data: batch } = await supabase
      .from("payment_import_batches")
      .select("id, parsed_summary")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
    if (!batch) {
      return NextResponse.json({ success: false, error: "Batch not found" }, { status: 404 });
    }
    const parsedSummary =
      batch.parsed_summary && typeof batch.parsed_summary === "object"
        ? { ...(batch.parsed_summary as Record<string, unknown>) }
        : {};
    if (body.undo) {
      delete parsedSummary.deferred;
      delete parsedSummary.deferred_at;
      delete parsedSummary.deferred_note;
    } else {
      parsedSummary.deferred = true;
      parsedSummary.deferred_at = new Date().toISOString();
      if (body.note) parsedSummary.deferred_note = body.note;
    }

    const { error: updErr } = await supabase
      .from("payment_import_batches")
      .update({ parsed_summary: parsedSummary, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", organizationId);
    if (updErr) {
      return NextResponse.json({ success: false, error: updErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, deferred: !body.undo });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    if (error instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Defer failed" },
      { status: 500 },
    );
  }
}
