import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { routeRejectedClaimsToWorkqueue } from "@/lib/workqueue/claimRejectionWorkqueueService";

export type Edi277CAOutcome = "accepted" | "rejected" | "partial" | "unknown";

export interface Intake277CAAcknowledgementInput {
  organizationId: string;
  batchId?: string | null;
  fileName?: string | null;
  rawContent: string;
}

export interface Intake277CAAcknowledgementResult {
  ok: boolean;
  acknowledgementId: string | null;
  batchId: string | null;
  outcome: Edi277CAOutcome;
  linkedClaimIds: string[];
  errors: Array<{ field: string; message: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRecord = Record<string, any>;

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function splitSegments(rawContent: string): string[] {
  return rawContent.split("~").map((segment) => segment.trim()).filter(Boolean);
}

function splitElements(segment: string): string[] {
  return segment.split("*").map((element) => element.trim());
}

function parse277CA(rawContent: string) {
  const parsedSegments = splitSegments(rawContent).map(splitElements);
  const stcSegments = parsedSegments.filter((elements) => elements[0] === "STC");
  const bht = parsedSegments.find((elements) => elements[0] === "BHT");

  const stcStatuses = stcSegments.map((elements) => {
    const composite = normalizeText(elements[1]);
    const [category, status, entity] = composite.split(":");
    return {
      raw: elements.join("*"),
      category: category || null,
      status: status || null,
      entity: entity || null,
      actionCode: normalizeText(elements[3]) || null,
      monetaryAmount: normalizeText(elements[4]) || null,
    };
  });

  const hasReject = stcStatuses.some((entry) => {
    const category = normalizeText(entry.category).toUpperCase();
    const status = normalizeText(entry.status).toUpperCase();
    return ["A3", "A6", "A7", "A8", "E0"].includes(category) || ["562", "U", "R"].includes(status);
  });

  const hasAccept = stcStatuses.some((entry) => {
    const category = normalizeText(entry.category).toUpperCase();
    return ["A1", "A2", "A5"].includes(category);
  });

  let outcome: Edi277CAOutcome = "unknown";
  if (hasReject && hasAccept) outcome = "partial";
  else if (hasReject) outcome = "rejected";
  else if (hasAccept) outcome = "accepted";

  return {
    outcome,
    bht: bht ? bht.join("*") : null,
    stcStatuses,
    segmentCount: parsedSegments.length,
  };
}

async function loadBatchById(organizationId: string, batchId: string) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("edi_batches")
    .select("id, organization_id, status, transaction_type")
    .eq("id", batchId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as DbRecord | null;
}

async function loadLinkedClaimIds(batchId: string) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("edi_batch_claims")
    .select("claim_id")
    .eq("edi_batch_id", batchId);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row: { claim_id: string }) => String(row.claim_id));
}

function batchStatusForOutcome(outcome: Edi277CAOutcome) {
  if (outcome === "accepted") return "accepted_277ca";
  if (outcome === "rejected") return "rejected_277ca";
  if (outcome === "partial") return "partially_accepted";
  return "submitted";
}

function claimStatusForOutcome(outcome: Edi277CAOutcome) {
  if (outcome === "accepted") return "accepted_payer";
  if (outcome === "rejected") return "rejected_payer";
  if (outcome === "partial") return "accepted_payer";
  return "submitted";
}

export async function intake277CAAcknowledgement(
  input: Intake277CAAcknowledgementInput
): Promise<Intake277CAAcknowledgementResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      acknowledgementId: null,
      batchId: input.batchId ?? null,
      outcome: "unknown",
      linkedClaimIds: [],
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  if (!normalizeText(input.rawContent)) {
    return {
      ok: false,
      acknowledgementId: null,
      batchId: input.batchId ?? null,
      outcome: "unknown",
      linkedClaimIds: [],
      errors: [{ field: "raw_content", message: "277CA acknowledgement content is required" }],
    };
  }

  const parsed = parse277CA(input.rawContent);
  const batch = input.batchId ? await loadBatchById(input.organizationId, input.batchId) : null;

  if (!batch) {
    return {
      ok: false,
      acknowledgementId: null,
      batchId: input.batchId ?? null,
      outcome: parsed.outcome,
      linkedClaimIds: [],
      errors: [{ field: "edi_batches", message: "Could not match 277CA acknowledgement to an EDI batch" }],
    };
  }

  const batchId = String(batch.id);
  const linkedClaimIds = await loadLinkedClaimIds(batchId);

  const { data: ack, error: ackError } = await supabase
    .from("edi_acknowledgements")
    .insert({
      organization_id: input.organizationId,
      edi_batch_id: batchId,
      acknowledgement_type: "277CA",
      file_name: input.fileName ?? undefined,
      raw_content: input.rawContent,
      parsed_content: parsed,
    })
    .select("id")
    .single();

  if (ackError || !ack) {
    return {
      ok: false,
      acknowledgementId: null,
      batchId,
      outcome: parsed.outcome,
      linkedClaimIds,
      errors: [{ field: "edi_acknowledgements", message: ackError?.message ?? "Failed to store 277CA acknowledgement" }],
    };
  }

  const acknowledgementId = String(ack.id);
  const { error: batchUpdateError } = await supabase
    .from("edi_batches")
    .update({ status: batchStatusForOutcome(parsed.outcome) })
    .eq("id", batchId)
    .eq("organization_id", input.organizationId);

  if (batchUpdateError) {
    return {
      ok: false,
      acknowledgementId,
      batchId,
      outcome: parsed.outcome,
      linkedClaimIds,
      errors: [{ field: "edi_batches", message: batchUpdateError.message }],
    };
  }

  if (linkedClaimIds.length > 0) {
    const { error: claimUpdateError } = await supabase
      .from("professional_claims")
      .update({ claim_status: claimStatusForOutcome(parsed.outcome), updated_at: new Date().toISOString() })
      .in("id", linkedClaimIds)
      .eq("organization_id", input.organizationId);

    if (claimUpdateError) {
      return {
        ok: false,
        acknowledgementId,
        batchId,
        outcome: parsed.outcome,
        linkedClaimIds,
        errors: [{ field: "professional_claims", message: claimUpdateError.message }],
      };
    }
  }

  if (["rejected", "partial"].includes(parsed.outcome) && linkedClaimIds.length > 0) {
    const routed = await routeRejectedClaimsToWorkqueue({
      organizationId: input.organizationId,
      acknowledgementId,
      batchId,
      claimIds: linkedClaimIds,
      source: "277CA",
      outcome: parsed.outcome as "rejected" | "partial",
      parsedContent: parsed,
    });

    if (!routed.ok) {
      return {
        ok: false,
        acknowledgementId,
        batchId,
        outcome: parsed.outcome,
        linkedClaimIds,
        errors: routed.errors,
      };
    }
  }

  return {
    ok: true,
    acknowledgementId,
    batchId,
    outcome: parsed.outcome,
    linkedClaimIds,
    errors: [],
  };
}

export const __private277CAParserForTests = { parse277CA };
