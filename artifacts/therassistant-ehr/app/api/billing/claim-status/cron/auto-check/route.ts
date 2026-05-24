/**
 * POST /api/billing/claim-status/cron/auto-check
 *
 * Scheduled 276 auto-checker for the Payer Received queue (Task #540).
 *
 * Two callable modes, mirroring the no-response-scan cron:
 *   1. Scheduler: header `x-cron-secret: $CRON_SECRET` — fans out across
 *      every organization that owns a claim currently in the Payer
 *      Received state.
 *   2. Authenticated biller: body `{ organizationId }` — manual run for
 *      that single org, useful for back-office triage / one-off catch-up
 *      after a payer outage.
 *
 * Per-org thresholds (resolved by `resolveAutoCheckConfig`):
 *   - payer_status.auto_check_age_days       (default 3)  — minimum age
 *      of `submitted_at` before a claim is eligible for auto-polling.
 *   - payer_status.auto_recheck_interval_days (default 2) — minimum gap
 *      between any two inquiries (manual or auto) before we re-poll, so
 *      we don't stomp on a claim a biller just checked.
 *
 * Body may also pass `{ ageDays, recheckIntervalDays, maxClaims }` to
 * override the resolved values for a single run.
 *
 * Idempotent within a window: the recheck-interval guard makes re-running
 * the same day a no-op for claims that were already polled.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { runClaimStatusAutoCheck } from "@/lib/billing/claimStatusAutoCheck";

export const runtime = "nodejs";

interface CronBody {
  organizationId?: string;
  ageDays?: number;
  recheckIntervalDays?: number;
  maxClaims?: number;
}

export async function POST(req: Request) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const body = ((await req.json().catch(() => null)) ?? {}) as CronBody;

  const cronSecret = process.env.CRON_SECRET;
  const headerSecret = req.headers.get("x-cron-secret");
  const isCronCaller = !!(cronSecret && headerSecret && headerSecret === cronSecret);

  let organizationIds: string[];
  if (isCronCaller) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };
    const { data, error } = await sb
      .from("professional_claims")
      .select("organization_id")
      .eq("claim_status", "accepted_payer")
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
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId,
    });
    if (guard instanceof NextResponse) return guard;
    organizationIds = [guard.organizationId];
  }

  const perOrg: Array<{
    organizationId: string;
    scanned: number;
    dispatched: number;
    skipped: number;
    failures: number;
  }> = [];

  for (const organizationId of organizationIds) {
    try {
      const r = await runClaimStatusAutoCheck(supabase, {
        organizationId,
        ageDays: body.ageDays,
        recheckIntervalDays: body.recheckIntervalDays,
        maxClaims: body.maxClaims,
      });
      perOrg.push({
        organizationId,
        scanned: r.scanned,
        dispatched: r.dispatched,
        skipped: r.skipped,
        failures: r.failures,
      });
    } catch (err) {
      perOrg.push({
        organizationId,
        scanned: 0,
        dispatched: 0,
        skipped: 0,
        failures: 1,
      });
      console.warn(
        `claim-status auto-check failed for ${organizationId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const totals = perOrg.reduce(
    (acc, r) => {
      acc.scanned += r.scanned;
      acc.dispatched += r.dispatched;
      acc.skipped += r.skipped;
      acc.failures += r.failures;
      return acc;
    },
    { scanned: 0, dispatched: 0, skipped: 0, failures: 0 },
  );

  return NextResponse.json({
    ok: true,
    organizations: perOrg.length,
    totals,
    perOrg,
  });
}
