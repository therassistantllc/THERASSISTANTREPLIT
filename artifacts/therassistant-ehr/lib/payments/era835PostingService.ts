/**
 * Backwards-compat shim for the ERA 835 posting service.
 *
 * As of Task #107 (Payment Posting — Foundation), all ledger writes go
 * through the centralised posting engine in `lib/payments/postingEngine`.
 * This module re-exports the same public surface (`postEra835Batch`,
 * `postSingleEra835ClaimPayment`) so existing callers (API routes,
 * imports, UI server actions) keep working unchanged — they now route to
 * `commitPosting` under the hood with a `system` actor.
 *
 * Callers that have a resolved authenticated staff member should call
 * `commitPosting` directly and supply a real `PostingActor` — that path
 * also writes a richer audit log row with user_id / role.
 */

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  commitPosting,
  type PostingActor,
} from "@/lib/payments/postingEngine";

export interface PostEra835BatchInput {
  organizationId: string;
  eraImportBatchId: string;
  /** Optional — when omitted, a `system` actor is used. */
  actor?: PostingActor;
}

export interface PostEra835BatchResult {
  ok: boolean;
  postedClaims: number;
  blockedClaims: number;
  patientInvoicesCreated: number;
  errors: Array<{ field: string; message: string }>;
}

export interface PostSingleEra835ClaimPaymentInput {
  organizationId: string;
  eraClaimPaymentId: string;
  /** Optional — when omitted, a `system` actor is used. */
  actor?: PostingActor;
}

export interface PostSingleEra835ClaimPaymentResult {
  ok: boolean;
  posted: boolean;
  alreadyPosted: boolean;
  blocked: boolean;
  patientInvoiceCreated: boolean;
  workqueueItemsClosed: number;
  errors: Array<{ field: string; message: string }>;
}

export async function postEra835Batch(
  input: PostEra835BatchInput,
): Promise<PostEra835BatchResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      postedClaims: 0,
      blockedClaims: 0,
      patientInvoicesCreated: 0,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const { data: payments, error: paymentError } = await supabase
    .from("era_claim_payments")
    .select("id, claim_match_status, posting_status")
    .eq("organization_id", input.organizationId)
    .eq("era_import_batch_id", input.eraImportBatchId)
    .is("archived_at", null);

  if (paymentError) {
    return {
      ok: false,
      postedClaims: 0,
      blockedClaims: 0,
      patientInvoicesCreated: 0,
      errors: [{ field: "era_claim_payments", message: paymentError.message }],
    };
  }

  let postedClaims = 0;
  let blockedClaims = 0;
  let patientInvoicesCreated = 0;
  const errors: Array<{ field: string; message: string }> = [];

  // Validation codes that represent "row is not postable yet" rather than a
  // commit failure. Legacy batch behaviour was to silently skip these
  // (counting them as blocked); preserve that so the batch's overall
  // `ok` / `import_status` only flips when something truly broke.
  const SKIPPABLE_VALIDATION_CODES = new Set([
    "claim_not_matched",
    "posting_status_blocked",
  ]);

  for (const row of payments ?? []) {
    const result = await commitPosting({
      organizationId: input.organizationId,
      source: { type: "era_835", eraClaimPaymentId: String((row as { id: string }).id) },
      actor: input.actor ?? null,
    });

    if (result.alreadyPosted || result.posted) postedClaims += 1;
    if (result.blocked) blockedClaims += 1;
    if (result.patientInvoiceCreated) patientInvoicesCreated += 1;

    if (result.errors.length > 0) {
      const isOnlySkippableBlocked =
        result.blocked &&
        !result.posted &&
        result.validation.blocking.every((issue) =>
          SKIPPABLE_VALIDATION_CODES.has(issue.code),
        );

      if (!isOnlySkippableBlocked) {
        errors.push(...result.errors);
      }
    }
  }

  await supabase
    .from("era_import_batches")
    .update({
      import_status: errors.length > 0 ? "blocked" : "posted",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.eraImportBatchId)
    .eq("organization_id", input.organizationId);

  return {
    ok: errors.length === 0,
    postedClaims,
    blockedClaims,
    patientInvoicesCreated,
    errors,
  };
}

export async function postSingleEra835ClaimPayment(
  input: PostSingleEra835ClaimPaymentInput,
): Promise<PostSingleEra835ClaimPaymentResult> {
  const result = await commitPosting({
    organizationId: input.organizationId,
    source: { type: "era_835", eraClaimPaymentId: input.eraClaimPaymentId },
    actor: input.actor ?? null,
  });

  return {
    ok: result.ok,
    posted: result.posted,
    alreadyPosted: result.alreadyPosted,
    blocked: result.blocked,
    patientInvoiceCreated: result.patientInvoiceCreated,
    workqueueItemsClosed: result.workqueueItemsClosed,
    errors: result.errors,
  };
}
