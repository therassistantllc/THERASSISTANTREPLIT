/**
 * Payment Posting Engine — centralised audit writer.
 *
 * Every write the engine makes ends with a row in public.audit_logs.
 * The table already has the Medplum-style columns (user_id, user_role,
 * action, object_type, object_id, before_value, after_value,
 * organization_id, claim_id, workqueue_item_id) added in
 * 20260514000000_ehr_completion_patches.sql, so we reuse it rather than
 * standing up a duplicate payment_audit_log table.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PostingActor } from "./types";

export type PaymentAuditAction =
  | "payment_posted"
  | "payment_reversed"
  | "payment_adjusted"
  | "era_batch_posted"
  | "era_batch_imported"
  | "patient_invoice_created"
  | "patient_invoice_updated"
  | "recoupment_recorded"
  | "refund_issued"
  | "unapplied_credit_recorded";

export type PaymentAuditObjectType =
  | "era_import_batch"
  | "era_claim_payment"
  | "era_posting_ledger_entry"
  | "professional_claim"
  | "patient_invoice"
  | "payment_adjustment"
  | "patient_invoice_payment";

export interface WritePaymentAuditLogInput {
  organizationId: string;
  actor?: PostingActor | null;
  action: PaymentAuditAction;
  objectType: PaymentAuditObjectType;
  objectId: string;
  /** Optional claim_id to power claim-level audit timeline views. */
  claimId?: string | null;
  /** Optional workqueue_item_id for assisted-poster traceability. */
  workqueueItemId?: string | null;
  beforeValue?: Record<string, unknown> | null;
  afterValue?: Record<string, unknown> | null;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface WrittenAuditLog {
  id: string;
}

/**
 * Write a single payment-related audit log row.
 *
 * Failures are NEVER thrown — audit is best-effort, and a missing audit
 * row must not block a legitimate posting. Failures are logged to console
 * for ops debugging.
 */
export async function writePaymentAuditLog(
  supabase: SupabaseClient,
  input: WritePaymentAuditLogInput,
): Promise<WrittenAuditLog | null> {
  try {
    const eventMetadata = {
      ...(input.metadata ?? {}),
      actor_source: input.actor?.source ?? null,
    };

    const payload = {
      organization_id: input.organizationId,
      user_id: input.actor?.userId ?? null,
      user_role: input.actor?.role ?? null,
      action: input.action,
      object_type: input.objectType,
      object_id: input.objectId,
      claim_id: input.claimId ?? null,
      workqueue_item_id: input.workqueueItemId ?? null,
      before_value: input.beforeValue ?? null,
      after_value: input.afterValue ?? null,
      event_type: input.action,
      event_summary: input.summary ?? `${input.action} on ${input.objectType} ${input.objectId}`,
      event_metadata: eventMetadata,
    };

    // We cast through unknown because public.audit_logs columns were added
    // in a later migration than the generated database.types.ts in some
    // environments; runtime shape is correct.
    const { data, error } = await supabase
      .from("audit_logs")
      .insert(payload as never)
      .select("id")
      .single();

    if (error || !data) {
      console.warn(
        "[postingEngine.audit] audit_logs insert failed",
        error?.message ?? "no data returned",
      );
      return null;
    }

    return { id: String((data as { id: string }).id) };
  } catch (err) {
    console.warn(
      "[postingEngine.audit] audit_logs insert threw",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
