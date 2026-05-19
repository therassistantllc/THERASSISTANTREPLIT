import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export interface Mark837PBatchSubmittedInput {
  organizationId: string;
  batchId: string;
  officeAllyFileId?: string | null;
  submittedAt?: string | null;
}

export interface Mark837PBatchFailedInput {
  organizationId: string;
  batchId: string;
  reason: string;
}

export interface EdiSubmissionTrackingResult {
  ok: boolean;
  batchId: string;
  linkedClaimIds: string[];
  errors: Array<{ field: string; message: string }>;
}

type BatchRow = {
  id: string;
  organization_id: string;
  status: string;
  transaction_type: string;
};

async function loadBatch(organizationId: string, batchId: string): Promise<BatchRow | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("edi_batches")
    .select("id, organization_id, status, transaction_type")
    .eq("id", batchId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as BatchRow | null;
}

async function loadLinkedClaimIds(batchId: string): Promise<string[]> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("edi_batch_claims")
    .select("claim_id")
    .eq("edi_batch_id", batchId);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row: { claim_id: string }) => String(row.claim_id));
}

export async function mark837PBatchSubmitted(
  input: Mark837PBatchSubmittedInput
): Promise<EdiSubmissionTrackingResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      batchId: input.batchId,
      linkedClaimIds: [],
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const batch = await loadBatch(input.organizationId, input.batchId);
  if (!batch) {
    return {
      ok: false,
      batchId: input.batchId,
      linkedClaimIds: [],
      errors: [{ field: "edi_batches", message: "EDI batch not found for organization" }],
    };
  }

  if (batch.transaction_type !== "837P") {
    return {
      ok: false,
      batchId: input.batchId,
      linkedClaimIds: [],
      errors: [{ field: "edi_batches.transaction_type", message: "Only 837P batches can be submitted through this workflow" }],
    };
  }

  if (!["generated", "failed"].includes(batch.status)) {
    return {
      ok: false,
      batchId: input.batchId,
      linkedClaimIds: [],
      errors: [{ field: "edi_batches.status", message: `Batch status ${batch.status} cannot be marked submitted` }],
    };
  }

  const linkedClaimIds = await loadLinkedClaimIds(input.batchId);
  if (linkedClaimIds.length === 0) {
    return {
      ok: false,
      batchId: input.batchId,
      linkedClaimIds: [],
      errors: [{ field: "edi_batch_claims", message: "EDI batch has no linked claims" }],
    };
  }

  const submittedAt = input.submittedAt ?? new Date().toISOString();
  const { error: batchUpdateError } = await supabase
    .from("edi_batches")
    .update({
      status: "submitted",
      office_ally_file_id: input.officeAllyFileId ?? undefined,
      submitted_at: submittedAt,
    })
    .eq("id", input.batchId)
    .eq("organization_id", input.organizationId);

  if (batchUpdateError) {
    return {
      ok: false,
      batchId: input.batchId,
      linkedClaimIds,
      errors: [{ field: "edi_batches", message: batchUpdateError.message }],
    };
  }

  const { error: claimUpdateError } = await supabase
    .from("professional_claims")
    .update({ claim_status: "submitted", updated_at: new Date().toISOString() })
    .in("id", linkedClaimIds)
    .eq("organization_id", input.organizationId);

  if (claimUpdateError) {
    return {
      ok: false,
      batchId: input.batchId,
      linkedClaimIds,
      errors: [{ field: "professional_claims", message: claimUpdateError.message }],
    };
  }

  return { ok: true, batchId: input.batchId, linkedClaimIds, errors: [] };
}

export async function mark837PBatchSubmissionFailed(
  input: Mark837PBatchFailedInput
): Promise<EdiSubmissionTrackingResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      batchId: input.batchId,
      linkedClaimIds: [],
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const batch = await loadBatch(input.organizationId, input.batchId);
  if (!batch) {
    return {
      ok: false,
      batchId: input.batchId,
      linkedClaimIds: [],
      errors: [{ field: "edi_batches", message: "EDI batch not found for organization" }],
    };
  }

  const linkedClaimIds = await loadLinkedClaimIds(input.batchId);
  const { error: batchUpdateError } = await supabase
    .from("edi_batches")
    .update({ status: "failed" })
    .eq("id", input.batchId)
    .eq("organization_id", input.organizationId);

  if (batchUpdateError) {
    return {
      ok: false,
      batchId: input.batchId,
      linkedClaimIds,
      errors: [{ field: "edi_batches", message: batchUpdateError.message }],
    };
  }

  return {
    ok: true,
    batchId: input.batchId,
    linkedClaimIds,
    errors: [{ field: "submission", message: input.reason }],
  };
}
