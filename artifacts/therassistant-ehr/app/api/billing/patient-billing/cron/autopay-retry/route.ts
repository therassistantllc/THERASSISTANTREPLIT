/**
 * POST /api/billing/patient-billing/cron/autopay-retry
 *
 * Daily retry sweep (Task #669). Re-runs `attemptAutopayForInvoice` for
 * client invoices whose most recent autopay attempt is a failure and
 * whose backoff window (default 1d / 3d / 7d, max 3 retries) has
 * elapsed.
 *
 * Two callable modes — mirrors `payments/cron/no-response-scan`:
 *   1. Scheduler: header `x-cron-secret: $CRON_SECRET` — fans out
 *      across every organization that has at least one failed autopay
 *      audit event in the look-back window.
 *   2. Manual: authenticated biller/admin POST with `{ organizationId }`
 *      — pinned single-org run for back-office triage.
 *
 * Idempotent within a backoff window: a successful retry writes a new
 * `_succeeded` audit (so the invoice no longer matches), and a failed
 * retry writes a new `_failed` audit whose timestamp resets the wait.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireAuthenticatedPaymentPoster } from "@/lib/payments/postingEngine";
import { retryEligibleAutopayFailures } from "@/lib/payments/autopayService";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const headerSecret = req.headers.get("x-cron-secret");
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as {
    organizationId?: string;
  } | null;
  const isCronCaller = !!(cronSecret && headerSecret && headerSecret === cronSecret);

  let organizationIds: string[] = [];
  if (isCronCaller) {
    // Resolve org list from audit_logs: only orgs with a recent
    // autopay_failed event can possibly produce work, so we don't need a
    // full org registry.
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from("audit_logs")
      .select("organization_id")
      .eq("event_type", "patient_billing_autopay_failed")
      .gte("created_at", cutoff)
      .not("organization_id", "is", null);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    organizationIds = [
      ...new Set(
        ((data ?? []) as Array<{ organization_id: string }>)
          .map((r) => r.organization_id)
          .filter(Boolean),
      ),
    ];
  } else {
    const organizationId = String(body?.organizationId ?? "");
    if (!organizationId) {
      return NextResponse.json(
        { error: "organizationId is required when not using cron secret" },
        { status: 400 },
      );
    }
    try {
      await requireAuthenticatedPaymentPoster(organizationId);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Forbidden" },
        { status: 403 },
      );
    }
    organizationIds = [organizationId];
  }

  const perOrg: Array<{
    organizationId: string;
    scanned: number;
    retried: number;
    succeeded: number;
    failed: number;
    skipped: number;
  }> = [];

  for (const organizationId of organizationIds) {
    try {
      const r = await retryEligibleAutopayFailures({
        organizationId,
        supabase,
      });
      perOrg.push({
        organizationId,
        scanned: r.scanned,
        retried: r.retried,
        succeeded: r.succeeded,
        failed: r.failed,
        skipped: r.skipped,
      });
    } catch (err) {
      perOrg.push({
        organizationId,
        scanned: 0,
        retried: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      });
      console.warn(
        "[autopay-retry] org sweep threw",
        organizationId,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const totals = perOrg.reduce(
    (acc, r) => {
      acc.scanned += r.scanned;
      acc.retried += r.retried;
      acc.succeeded += r.succeeded;
      acc.failed += r.failed;
      acc.skipped += r.skipped;
      return acc;
    },
    { scanned: 0, retried: 0, succeeded: 0, failed: 0, skipped: 0 },
  );

  return NextResponse.json({ ok: true, organizations: perOrg.length, totals, perOrg });
}
