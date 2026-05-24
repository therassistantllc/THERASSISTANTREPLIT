/**
 * Transmit a generated 837P batch via Availity's JSON API and persist the
 * outcome (status, transaction id, attempt count, history row).
 *
 * Extracted from /api/claims/837p/batch/[id]/submit so the secondary-billing
 * action route can drive the same transport pipeline. Keep the route behavior
 * in lockstep with this helper.
 */
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { AvailityJsonApiAdapter } from "@/lib/clearinghouse/adapters/AvailityJsonApiAdapter";
import { resolveClearinghouseCredential } from "@/lib/clearinghouse/credentials";
import { assertPayerEnrollmentsForBatch } from "@/lib/clearinghouse/payerEnrollmentGate";
import { assertClaimSubmissionReady } from "@/lib/validation/claimSubmissionGate";

export interface SubmitClaim837PResult {
  ok: boolean;
  status: number;
  error?: string;
  batchId: string;
  attempt?: number;
  idempotencyKey?: string;
  externalTransactionId?: string | null;
  httpStatus?: number | null;
  gate?: {
    blocked: true;
    reason: string;
    missing?: unknown;
  };
}

function extractTransactionId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const candidates = [
    d.transactionId,
    d.submissionId,
    d.referenceId,
    (d.data as Record<string, unknown> | undefined)?.transactionId,
    (d.data as Record<string, unknown> | undefined)?.submissionId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

function excerpt(data: unknown): string | null {
  if (data == null) return null;
  try {
    const s = typeof data === "string" ? data : JSON.stringify(data);
    return s.slice(0, 4000);
  } catch {
    return null;
  }
}

async function recordAttempt(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  attempt: {
    organizationId: string;
    batchId: string;
    attemptNumber: number;
    attemptedAt: string;
    endpoint: string | null;
    httpStatus: number | null;
    idempotencyKey: string | null;
    externalTransactionId: string | null;
    outcome: "success" | "failure";
    errorMessage: string | null;
    responseExcerpt: string | null;
  },
): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await (supabase as any)
      .from("claim_837p_batch_transmission_attempts")
      .insert({
        organization_id: attempt.organizationId,
        batch_id: attempt.batchId,
        attempt_number: attempt.attemptNumber,
        attempted_at: attempt.attemptedAt,
        endpoint: attempt.endpoint,
        http_status: attempt.httpStatus,
        idempotency_key: attempt.idempotencyKey,
        external_transaction_id: attempt.externalTransactionId,
        outcome: attempt.outcome,
        error_message: attempt.errorMessage ? attempt.errorMessage.slice(0, 2000) : null,
        response_excerpt: attempt.responseExcerpt ? attempt.responseExcerpt.slice(0, 4000) : null,
      });
    if (error) {
      console.warn("[837p submit] failed to persist transmission attempt", error.message);
    }
  } catch (e) {
    console.warn(
      "[837p submit] failed to persist transmission attempt",
      e instanceof Error ? e.message : String(e),
    );
  }
}

export async function submitClaim837PBatch(args: {
  batchId: string;
  organizationId: string;
  isRetry?: boolean;
}): Promise<SubmitClaim837PResult> {
  const { batchId, organizationId, isRetry = false } = args;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return { ok: false, status: 500, batchId, error: "Database connection not available" };
  }

  const { data: existing, error: lookupErr } = await supabase
    .from("claim_837p_batches")
    .select(
      "id, batch_number, batch_status, generated_file_content, submission_idempotency_key, submission_attempt_count, availity_transaction_id, updated_at",
    )
    .eq("id", batchId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (lookupErr) return { ok: false, status: 422, batchId, error: lookupErr.message };
  if (!existing) return { ok: false, status: 404, batchId, error: "Batch not found" };

  const currentStatus = String((existing as Record<string, unknown>).batch_status ?? "");
  const x12 = String((existing as Record<string, unknown>).generated_file_content ?? "");

  if (!x12) {
    return {
      ok: false,
      status: 422,
      batchId,
      error: "Batch has no generated 837P content. Generate the EDI file before submitting.",
    };
  }
  if (currentStatus === "submitted" || currentStatus === "accepted") {
    return {
      ok: false,
      status: 409,
      batchId,
      error: `Batch is already ${currentStatus} (transaction ${(existing as Record<string, unknown>).availity_transaction_id ?? "unknown"}). Submission blocked.`,
    };
  }
  if (isRetry && currentStatus !== "rejected") {
    return {
      ok: false,
      status: 409,
      batchId,
      error: `Retry only valid for rejected batches; this batch is ${currentStatus}.`,
    };
  }
  if (
    !isRetry &&
    currentStatus !== "generated" &&
    currentStatus !== "ready_to_generate" &&
    currentStatus !== "draft"
  ) {
    return {
      ok: false,
      status: 409,
      batchId,
      error: `Batch cannot be submitted from status "${currentStatus}".`,
    };
  }

  const existingKey = (existing as Record<string, unknown>).submission_idempotency_key as
    | string
    | null;
  const idempotencyKey =
    existingKey ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${batchId}-${Date.now()}`);

  const prevAttemptCount = Number(
    (existing as Record<string, unknown>).submission_attempt_count ?? 0,
  );
  const attemptCount = prevAttemptCount + 1;
  const attemptedAt = new Date().toISOString();
  const observedUpdatedAt = String((existing as Record<string, unknown>).updated_at ?? "");

  const { data: claimed, error: claimErr } = await supabase
    .from("claim_837p_batches")
    .update({
      submission_idempotency_key: idempotencyKey,
      submission_attempt_count: attemptCount,
      last_submission_attempted_at: attemptedAt,
      updated_at: attemptedAt,
    })
    .eq("id", batchId)
    .eq("organization_id", organizationId)
    .eq("batch_status", currentStatus)
    .eq("submission_attempt_count", prevAttemptCount)
    .eq("updated_at", observedUpdatedAt)
    .select("id");
  if (claimErr) return { ok: false, status: 422, batchId, error: claimErr.message };
  if (!claimed || claimed.length === 0) {
    return {
      ok: false,
      status: 409,
      batchId,
      error: "Batch was modified by another request. Reload and try again.",
    };
  }

  const credential = await resolveClearinghouseCredential({
    organizationId,
    vendor: "availity",
  });
  if (!credential) {
    return {
      ok: false,
      status: 412,
      batchId,
      error:
        "No Availity credential configured for this organization. Add an API key on /settings/clearinghouse before submitting claims.",
    };
  }

  const readiness = await assertClaimSubmissionReady(organizationId);
  if (!readiness.ok) {
    return {
      ok: false,
      status: 422,
      batchId,
      error: readiness.message ?? "Trading-partner readiness gate failed",
    };
  }

  const enrollmentGate = await assertPayerEnrollmentsForBatch({
    supabase,
    organizationId,
    batchId,
    transactionType: "837P",
    environment: credential.environment,
  });
  if (!enrollmentGate.ok) {
    return {
      ok: false,
      status: 422,
      batchId,
      error: enrollmentGate.message,
      gate: { blocked: true, reason: "payer_not_enrolled", missing: enrollmentGate.missing },
    };
  }

  const adapter = new AvailityJsonApiAdapter({
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl,
  });
  const endpointUrl = `${adapter.baseUrl}/v1/claims/professional/x12`;

  try {
    const result = await adapter.submitProfessionalX12({
      organizationId,
      x12,
      idempotencyKey,
    });
    const externalId = extractTransactionId(result.data);
    const submittedAt = new Date().toISOString();

    const { error: updateErr } = await supabase
      .from("claim_837p_batches")
      .update({
        batch_status: "submitted",
        submitted_at: submittedAt,
        availity_transaction_id: externalId,
        submission_error: null,
        last_submission_endpoint: endpointUrl,
        last_submission_http_status: result.httpStatus ?? 200,
        updated_at: submittedAt,
      })
      .eq("id", batchId)
      .eq("organization_id", organizationId);
    if (updateErr) return { ok: false, status: 422, batchId, error: updateErr.message };

    await recordAttempt(supabase, {
      organizationId,
      batchId,
      attemptNumber: attemptCount,
      attemptedAt: submittedAt,
      endpoint: endpointUrl,
      httpStatus: result.httpStatus ?? 200,
      idempotencyKey,
      externalTransactionId: externalId,
      outcome: "success",
      errorMessage: null,
      responseExcerpt: excerpt(result.data),
    });

    return {
      ok: true,
      status: 200,
      batchId,
      attempt: attemptCount,
      idempotencyKey,
      externalTransactionId: externalId,
      httpStatus: result.httpStatus ?? 200,
    };
  } catch (transportError) {
    const message =
      transportError instanceof Error ? transportError.message : "Availity submission failed";
    const failedAt = new Date().toISOString();
    const httpStatusMatch = message.match(/failed\s+(\d{3})/);
    const failureHttpStatus = httpStatusMatch ? Number(httpStatusMatch[1]) : null;

    await supabase
      .from("claim_837p_batches")
      .update({
        batch_status: "rejected",
        submission_error: message.slice(0, 2000),
        last_submission_endpoint: endpointUrl,
        last_submission_http_status: failureHttpStatus,
        updated_at: failedAt,
      })
      .eq("id", batchId)
      .eq("organization_id", organizationId);

    await recordAttempt(supabase, {
      organizationId,
      batchId,
      attemptNumber: attemptCount,
      attemptedAt: failedAt,
      endpoint: endpointUrl,
      httpStatus: failureHttpStatus,
      idempotencyKey,
      externalTransactionId: null,
      outcome: "failure",
      errorMessage: message,
      responseExcerpt: message,
    });

    return {
      ok: false,
      status: 502,
      batchId,
      attempt: attemptCount,
      idempotencyKey,
      httpStatus: failureHttpStatus,
      error: message,
    };
  }
}
