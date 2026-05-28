/**
 * POST /api/billing/patient-billing/:id/update-card-retry
 *
 * `:id` is a client id. Lets a biller resolve a failed-autopay WQ row
 * (work_type='autopay_charge_failed') directly from the Client Billing
 * queue: paste in a new card via Stripe Elements (frontend), swap the
 * client's `stripe_payment_method_id`, and re-run autopay for every
 * invoice that has an open `autopay_charge_failed` workqueue row.
 *
 * Two-phase request:
 *   1. body: { action: "start_setup" }
 *        → { setupIntentId, clientSecret, publishableKey, connectAccountId }
 *      (Stripe.js on the client uses these to mount a card element and
 *       confirm the SetupIntent, producing a payment_method id.)
 *   2. body: { action: "confirm_and_retry", setupIntentId?, paymentMethodId? }
 *        → { summary: SavedCardSummary, retries: Array<…> }
 *
 * The retry loop calls `attemptAutopayForInvoice` for each failing
 * invoice; on success the open WQ row(s) are closed via
 * `closeAutopayFailureWorkqueueItem` (the standard recovery path).
 *
 * Task #737.
 */
import { NextResponse } from "next/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  confirmSavedCard,
  startCardSetup,
  type SavedCardError,
  type SavedCardSummary,
} from "@/lib/payments/savedCardService";
import {
  attemptAutopayForInvoice,
  closeAutopayFailureWorkqueueItem,
  type AutopayAttemptResult,
  AUTOPAY_CHARGE_FAILED_WORK_TYPE,
} from "@/lib/payments/autopayService";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface PostBody {
  organizationId?: string;
  action?: "start_setup" | "confirm_and_retry";
  setupIntentId?: string | null;
  paymentMethodId?: string | null;
}

function statusFor(code: SavedCardError): number {
  switch (code) {
    case "client_not_found":
      return 404;
    case "no_saved_card":
    case "no_connected_account":
    case "no_invoice":
      return 422;
    case "stripe_not_configured":
    case "db_unavailable":
      return 503;
    case "authentication_required":
    case "card_declined":
      return 402;
    default:
      return 502;
  }
}

interface RetryEntry {
  patient_invoice_id: string;
  workqueue_item_id: string;
  result: AutopayAttemptResult;
  wqClosed: number;
}

async function findOpenAutopayFailureItems(
  organizationId: string,
  clientId: string,
): Promise<Array<{ id: string; patientInvoiceId: string }>> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };
  const { data } = await sb
    .from("workqueue_items")
    .select("id, context_payload, status, created_at")
    .eq("organization_id", organizationId)
    .eq("client_id", clientId)
    .eq("work_type", AUTOPAY_CHARGE_FAILED_WORK_TYPE)
    .in("status", ["open", "in_progress", "blocked"])
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Array<{
    id: string;
    context_payload?: Record<string, unknown> | null;
  }>;
  const seen = new Set<string>();
  const out: Array<{ id: string; patientInvoiceId: string }> = [];
  for (const r of rows) {
    const ctx = (r.context_payload ?? {}) as Record<string, unknown>;
    const invoiceId = String(ctx.patient_invoice_id ?? "").trim();
    if (!invoiceId || seen.has(invoiceId)) continue;
    seen.add(invoiceId);
    out.push({ id: r.id, patientInvoiceId: invoiceId });
  }
  return out;
}

export async function POST(request: Request, ctx: RouteParams) {
  const { id: clientId } = await ctx.params;
  if (!clientId) {
    return NextResponse.json(
      { success: false, error: "Missing client id" },
      { status: 400 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as PostBody;
  const guard = await requireBillingAccess({
    requestedOrganizationId: body.organizationId ?? null,
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

  if (body.action === "start_setup") {
    const r = await startCardSetup({ organizationId, clientId });
    if (!r.ok) {
      return NextResponse.json(
        { success: false, error: r.message },
        { status: statusFor(r.code) },
      );
    }
    return NextResponse.json({
      success: true,
      setupIntentId: r.setupIntentId,
      clientSecret: r.clientSecret,
      publishableKey: r.publishableKey,
      connectAccountId: r.connectAccountId,
      customerId: r.customerId,
    });
  }

  if (body.action !== "confirm_and_retry") {
    return NextResponse.json(
      { success: false, error: `Unknown action: ${body.action ?? ""}` },
      { status: 400 },
    );
  }

  // Phase 2: swap the saved card, then retry each open
  // autopay_charge_failed WQ row.
  const confirmed = await confirmSavedCard({
    organizationId,
    clientId,
    setupIntentId: body.setupIntentId ?? null,
    paymentMethodId: body.paymentMethodId ?? null,
  });
  if (!confirmed.ok) {
    return NextResponse.json(
      { success: false, error: confirmed.message },
      { status: statusFor(confirmed.code) },
    );
  }
  const summary: SavedCardSummary = confirmed.summary;

  // Best-effort: ensure autopay is on so the retry actually attempts a
  // charge. If the client (or a previous removeSavedCard) flipped it
  // off, attemptAutopayForInvoice would skip with "autopay off". We
  // only flip it on if a saved card now exists.
  if (summary.hasSavedCard) {
    const supabase = createServerSupabaseAdminClient();
    if (supabase) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("clients")
        .update({ autopay_enabled: true })
        .eq("organization_id", organizationId)
        .eq("id", clientId);
    }
  }

  const failures = await findOpenAutopayFailureItems(organizationId, clientId);
  const retries: RetryEntry[] = [];
  for (const f of failures) {
    const result = await attemptAutopayForInvoice({
      organizationId,
      patientInvoiceId: f.patientInvoiceId,
    });
    let wqClosed = 0;
    if (result.ok && result.code === "succeeded") {
      wqClosed = await closeAutopayFailureWorkqueueItem({
        organizationId,
        patientInvoiceId: f.patientInvoiceId,
        reason: "Biller updated the card and the retry charge succeeded.",
        closedByUserId: guard.userId ?? null,
      });
    }
    retries.push({
      patient_invoice_id: f.patientInvoiceId,
      workqueue_item_id: f.id,
      result,
      wqClosed,
    });
  }

  const anySucceeded = retries.some(
    (r) => r.result.ok && r.result.code === "succeeded",
  );
  const allFailed =
    retries.length > 0 && retries.every((r) => r.result.code === "failed");

  return NextResponse.json({
    success: true,
    summary,
    retries,
    anySucceeded,
    allFailed,
    retried: retries.length,
  });
}
