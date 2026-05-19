import { NextResponse } from "next/server";
import crypto from "crypto";
import { createServerSupabaseServiceRoleClientTyped } from "@/lib/supabase/server";

function generateUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Payment posting failed";
  }
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseServiceRoleClientTyped();

    if (!supabase) {
      return NextResponse.json(
        {
          success: false,
          error:
            "SUPABASE_SERVICE_ROLE_KEY is required for payment posting writes. Add it to .env.local and restart dev server.",
        },
        { status: 503 },
      );
    }

    const body = (await request.json()) as { paymentImportItemId?: unknown };
    const paymentImportItemId = String(body.paymentImportItemId ?? "").trim();

    if (!paymentImportItemId) {
      return NextResponse.json({ success: false, error: "paymentImportItemId is required" }, { status: 400 });
    }

    const { data: paymentImportItem, error: itemError } = await supabase
      .from("payment_import_items")
      .select("id, organization_id, claim_id, net_amount, posting_ready, imported_item_ref")
      .eq("id", paymentImportItemId)
      .is("archived_at", null)
      .maybeSingle();

    if (itemError) throw itemError;
    if (!paymentImportItem) {
      return NextResponse.json({ success: false, error: "Payment import item not found" }, { status: 404 });
    }

    if (!paymentImportItem.posting_ready) {
      return NextResponse.json({ success: false, error: "Payment import item is not ready to post" }, { status: 409 });
    }

    const { data: existingPosting, error: existingPostingError } = await supabase
      .from("payment_postings")
      .select("id, posting_reference, total_posted_amount, posted_at")
      .eq("payment_import_item_id", paymentImportItemId)
      .is("archived_at", null)
      .maybeSingle();

    if (existingPostingError) throw existingPostingError;

    if (existingPosting) {
      return NextResponse.json({ success: true, reused: true, posting: existingPosting });
    }

    const now = new Date().toISOString();
    const amount = Number(paymentImportItem.net_amount ?? 0);
    const safeAmount = Number.isFinite(amount) ? amount : 0;

    const { data: createdPosting, error: postingError } = await supabase
      .from("payment_postings")
      .insert({
        id: generateUuid(),
        organization_id: paymentImportItem.organization_id,
        payment_import_item_id: paymentImportItem.id,
        posting_status: "posted",
        posting_reference: `POST-${Date.now()}`,
        total_posted_amount: safeAmount,
        note: `Posted from payment posting workspace for ${paymentImportItem.imported_item_ref ?? paymentImportItem.id}`,
        posted_at: now,
        created_at: now,
        updated_at: now,
      })
      .select("*")
      .single();

    if (postingError) throw postingError;
    if (!createdPosting) throw new Error("Payment posting creation returned no row");

    const paymentImportUpdate = await supabase
      .from("payment_import_items")
      .update({ payment_import_status: "posted", posting_ready: false, updated_at: now })
      .eq("id", paymentImportItem.id);
    if (paymentImportUpdate.error) throw paymentImportUpdate.error;

    const workqueueUpdate = await supabase
      .from("workqueue_items")
      .update({ status: "resolved", resolved_at: now, updated_at: now })
      .eq("source_object_id", paymentImportItem.id)
      .eq("work_type", "payment_posting_needed")
      .is("archived_at", null);
    if (workqueueUpdate.error) throw workqueueUpdate.error;

    if (paymentImportItem.claim_id) {
      const claimUpdate = await supabase
        .from("claims")
        .update({
          claim_status: "paid",
          paid_at: now,
          payer_responsibility_amount: safeAmount,
          updated_at: now,
        })
        .eq("id", paymentImportItem.claim_id);
      if (claimUpdate.error) throw claimUpdate.error;
    }

    return NextResponse.json({ success: true, reused: false, posting: createdPosting });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: extractErrorMessage(error),
      },
      { status: 500 },
    );
  }
}