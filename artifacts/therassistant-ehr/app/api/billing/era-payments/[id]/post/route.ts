import { NextResponse } from "next/server";
import { postSingleEra835ClaimPayment } from "@/lib/payments/era835PostingService";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

interface PostBody {
  organizationId?: string;
  overrides?: {
    paymentAmount?: number;
    patientResponsibility?: number;
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as PostBody;
    const organizationId = body.organizationId ? String(body.organizationId) : "";

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }
    if (!id) {
      return NextResponse.json({ success: false, error: "ERA payment id is required" }, { status: 400 });
    }

    const actor = await requireAuthenticatedPaymentPoster(organizationId);

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    // Prefer legacy row when present to preserve posting ledger behavior.
    const { data: legacyRow } = await supabase
      .from("era_claim_payments")
      .select("id")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();

    // Persist biller inline edits (yellow-modified fields) before posting so
    // the commitPosting engine reads the corrected values. This makes the
    // poster's edit -> Post round-trip honest end-to-end.
    if (legacyRow && body.overrides && (body.overrides.paymentAmount !== undefined || body.overrides.patientResponsibility !== undefined)) {
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof body.overrides.paymentAmount === "number" && Number.isFinite(body.overrides.paymentAmount)) {
        update.clp04_payment_amount = +body.overrides.paymentAmount.toFixed(2);
      }
      if (
        typeof body.overrides.patientResponsibility === "number" &&
        Number.isFinite(body.overrides.patientResponsibility)
      ) {
        update.clp05_patient_responsibility = +body.overrides.patientResponsibility.toFixed(2);
      }
      const { error: editErr } = await supabase
        .from("era_claim_payments")
        .update(update)
        .eq("id", id)
        .eq("organization_id", organizationId);
      if (editErr) {
        return NextResponse.json(
          { success: false, error: `Failed to persist edits: ${editErr.message}` },
          { status: 500 },
        );
      }
    }

    if (legacyRow) {
      const result = await postSingleEra835ClaimPayment({
        organizationId,
        eraClaimPaymentId: id,
        actor,
      });

      if (!result.ok) {
        const status = result.blocked ? 409 : 500;
        return NextResponse.json({ success: false, ...result }, { status });
      }

      return NextResponse.json({ success: true, ...result });
    }

    // Importer-backed fallback path: mark payment_import_items as posted.
    const { data: importerRow } = await supabase
      .from("payment_import_items")
      .select("id, raw_item_payload")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!importerRow) {
      return NextResponse.json({ success: false, error: "ERA payment not found" }, { status: 404 });
    }

    const update: Record<string, unknown> = {
      payment_import_status: "posted",
      posting_ready: false,
      updated_at: new Date().toISOString(),
    };
    if (body.overrides && typeof body.overrides.paymentAmount === "number" && Number.isFinite(body.overrides.paymentAmount)) {
      update.net_amount = +body.overrides.paymentAmount.toFixed(2);
    }
    if (body.overrides && typeof body.overrides.patientResponsibility === "number" && Number.isFinite(body.overrides.patientResponsibility)) {
      const payload =
        importerRow.raw_item_payload && typeof importerRow.raw_item_payload === "object"
          ? { ...(importerRow.raw_item_payload as Record<string, unknown>) }
          : {};
      payload.patient_responsibility = +body.overrides.patientResponsibility.toFixed(2);
      update.raw_item_payload = payload;
    }

    const { error: importerUpdateErr } = await supabase
      .from("payment_import_items")
      .update(update)
      .eq("id", id)
      .eq("organization_id", organizationId);
    if (importerUpdateErr) {
      return NextResponse.json(
        { success: false, error: importerUpdateErr.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, ok: true, postedInImporter: true, eraClaimPaymentId: id });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    if (error instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    console.error("Post ERA payment API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to post ERA payment" },
      { status: 500 },
    );
  }
}
