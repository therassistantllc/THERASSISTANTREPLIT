import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type RejectionSource = "999" | "277CA";

export interface RouteRejectedClaimsInput {
  organizationId: string;
  acknowledgementId: string;
  batchId: string;
  claimIds: string[];
  source: RejectionSource;
  outcome: "rejected" | "partial";
  parsedContent?: Record<string, unknown> | null;
}

export interface RouteRejectedClaimsResult {
  ok: boolean;
  created: number;
  skipped: number;
  errors: Array<{ field: string; message: string }>;
}

type ClaimRow = {
  id: string;
  patient_id: string | null;
  claim_number: string | null;
  patient_account_number: string | null;
  claim_status: string;
};

function workTypeForSource(source: RejectionSource) {
  return source === "999" ? "clearinghouse_rejection" : "payer_rejection";
}

function titleForSource(source: RejectionSource, claim: ClaimRow) {
  const claimLabel = claim.claim_number || claim.patient_account_number || claim.id;
  return source === "999"
    ? `999 clearinghouse rejection - claim ${claimLabel}`
    : `277CA payer rejection - claim ${claimLabel}`;
}

async function hasOpenWorkqueueItem(params: {
  organizationId: string;
  claimId: string;
  workType: string;
}) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("workqueue_items")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("source_object_type", "professional_claim")
    .eq("source_object_id", params.claimId)
    .eq("work_type", params.workType)
    .in("status", ["open", "in_progress", "blocked"])
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return Boolean(data?.id);
}

export async function routeRejectedClaimsToWorkqueue(
  input: RouteRejectedClaimsInput
): Promise<RouteRejectedClaimsResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      created: 0,
      skipped: 0,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  if (!input.claimIds.length) {
    return { ok: true, created: 0, skipped: 0, errors: [] };
  }

  const workType = workTypeForSource(input.source);
  const { data: claims, error: claimError } = await supabase
    .from("professional_claims")
    .select("id, patient_id, claim_number, patient_account_number, claim_status")
    .eq("organization_id", input.organizationId)
    .in("id", input.claimIds);

  if (claimError) {
    return {
      ok: false,
      created: 0,
      skipped: 0,
      errors: [{ field: "professional_claims", message: claimError.message }],
    };
  }

  let created = 0;
  let skipped = 0;
  const errors: Array<{ field: string; message: string }> = [];
  const now = new Date().toISOString();

  for (const claim of (claims ?? []) as ClaimRow[]) {
    try {
      const exists = await hasOpenWorkqueueItem({
        organizationId: input.organizationId,
        claimId: claim.id,
        workType,
      });

      if (exists) {
        skipped += 1;
        continue;
      }

      const { error: insertError } = await supabase.from("workqueue_items").insert({
        organization_id: input.organizationId,
        title: titleForSource(input.source, claim),
        description:
          input.source === "999"
            ? "The clearinghouse 999 acknowledgement rejected this claim batch. Review the acknowledgement details and correct the claim before rebilling."
            : "The 277CA acknowledgement rejected this claim at the clearinghouse/payer acceptance stage. Review the STC details and correct the claim before rebilling.",
        work_type: workType,
        status: "open",
        priority: "high",
        source_object_type: "professional_claim",
        source_object_id: claim.id,
        client_id: claim.patient_id,
        professional_claim_id: claim.id,
        context_payload: {
          source: input.source,
          outcome: input.outcome,
          acknowledgement_id: input.acknowledgementId,
          edi_batch_id: input.batchId,
          claim_status: claim.claim_status,
          claim_number: claim.claim_number,
          patient_account_number: claim.patient_account_number,
          parsed_content: input.parsedContent ?? {},
        },
        created_at: now,
        updated_at: now,
      });

      if (insertError) throw new Error(insertError.message);
      created += 1;
    } catch (error) {
      errors.push({
        field: claim.id,
        message: error instanceof Error ? error.message : "Failed to create rejection workqueue item",
      });
    }
  }

  return { ok: errors.length === 0, created, skipped, errors };
}
