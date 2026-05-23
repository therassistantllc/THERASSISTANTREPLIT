/**
 * POST /api/billing/payments/bulk/reprocess
 * Body: { organizationId, ids: string[] }
 *
 * Re-runs the PP-1 intake/matching path for each selected payment:
 *   1. For unmatched ERA rows, re-attempt claim matching against
 *      professional_claims by clp01_claim_control_number / patient_account.
 *      If a match is found, write it back to era_claim_payments.
 *   2. Re-run the PP-5 workqueue rule engine so any rule changes (new
 *      thresholds, new rules, etc.) take effect against the now-current
 *      row state. The ledger itself is idempotent and is NOT re-written —
 *      reprocess is a re-evaluation, not a re-post.
 *
 * Only era_claim_payments and insurance_manual_payments are eligible
 * (patient_payments don't have the underpayment/denial signal).
 *
 * The per-target loop lives in `lib/payments/bulkReprocess.ts` so it can
 * be stress-tested end-to-end against a fake Supabase — see
 * `lib/payments/__tests__/bulkReprocessStress.test.ts`.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireAuthenticatedPaymentPoster } from "@/lib/payments/postingEngine";
import { matchProfessionalClaim } from "@/lib/payments/era835IntakeService";
import { parseTargets } from "../_shared";
import {
  reprocessBulkTargets,
  type BulkReprocessTarget,
} from "@/lib/payments/bulkReprocess";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const organizationId = String((body as { organizationId?: string }).organizationId ?? "");
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }
  const { targets, errors: parseErrors } = parseTargets((body as { ids?: unknown }).ids);
  if (targets.length === 0) {
    return NextResponse.json({ error: "No valid targets", parseErrors }, { status: 400 });
  }

  let actor;
  try {
    actor = await requireAuthenticatedPaymentPoster(organizationId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Forbidden" },
      { status: 403 },
    );
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const summary = await reprocessBulkTargets({
    supabase,
    organizationId,
    actor,
    targets: targets.map((t) => ({ kind: t.kind, id: t.id }) as BulkReprocessTarget),
    deps: { matchClaim: matchProfessionalClaim },
  });

  // `summary.errors` now includes per-emission rule-engine failures that
  // `applyWorkqueueRules` previously swallowed into its own internal
  // `result.errors` array. A non-empty `errors` here means at least one
  // workqueue item failed to insert — the dashboard surfaces these so
  // billers don't see a misleading "N reprocessed, 0 errors".
  return NextResponse.json({ ok: summary.errors.length === 0, parseErrors, ...summary });
}
