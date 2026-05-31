/**
 * POST /api/billing/era-batches/[id]/archive
 * Body: { organizationId, reason?: 'duplicate' | 'archive', duplicateOfBatchId?: string, undo?: boolean }
 *
 * Soft-archives the batch (sets archived_at). When reason='duplicate' and
 * duplicateOfBatchId provided, also writes parsed_summary.marked_duplicate_of.
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
      reason?: "duplicate" | "archive";
      duplicateOfBatchId?: string;
      undo?: boolean;
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

    const now = new Date().toISOString();
    if (body.undo) {
      delete parsedSummary.marked_duplicate_of;
      delete parsedSummary.archived_reason;
      const { error: updErr } = await supabase
        .from("payment_import_batches")
        .update({ archived_at: null, parsed_summary: parsedSummary, updated_at: now })
        .eq("id", id)
        .eq("organization_id", organizationId);
      if (updErr) {
        return NextResponse.json({ success: false, error: updErr.message }, { status: 500 });
      }
      return NextResponse.json({ success: true, archived: false });
    }

    if (body.reason === "duplicate" && body.duplicateOfBatchId) {
      parsedSummary.marked_duplicate_of = body.duplicateOfBatchId;
    }
    parsedSummary.archived_reason = body.reason ?? "archive";

    const { error: updErr } = await supabase
      .from("payment_import_batches")
      .update({ archived_at: now, parsed_summary: parsedSummary, updated_at: now })
      .eq("id", id)
      .eq("organization_id", organizationId);
    if (updErr) {
      return NextResponse.json({ success: false, error: updErr.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, archived: true });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    if (error instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Archive failed" },
      { status: 500 },
    );
  }
}
