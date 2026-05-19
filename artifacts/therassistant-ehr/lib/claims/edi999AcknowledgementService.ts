import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { routeRejectedClaimsToWorkqueue } from "@/lib/workqueue/claimRejectionWorkqueueService";

export type Edi999Outcome = "accepted" | "rejected" | "partial" | "unknown";

export interface Intake999AcknowledgementInput {
  organizationId: string;
  batchId?: string | null;
  fileName?: string | null;
  rawContent: string;
}

export interface Intake999AcknowledgementResult {
  ok: boolean;
  acknowledgementId: string | null;
  batchId: string | null;
  outcome: Edi999Outcome;
  linkedClaimIds: string[];
  errors: Array<{ field: string; message: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRecord = Record<string, any>;

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function splitSegments(rawContent: string): string[] {
  return rawContent
    .split("~")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function splitElements(segment: string): string[] {
  return segment.split("*").map((element) => element.trim());
}

function parse999(rawContent: string) {
  const segments = splitSegments(rawContent);
  const ak9 = segments.map(splitElements).find((elements) => elements[0] === "AK9");
  const ik5Segments = segments.map(splitElements).filter((elements) => elements[0] === "IK5");
  const errors = segments
    .map(splitElements)
    .filter((elements) => ["IK3", "IK4", "AK3", "AK4"].includes(elements[0] ?? ""));

  const ak9Code = normalizeText(ak9?.[1]).toUpperCase();
  let outcome: Edi999Outcome = "unknown";

  if (["A", "E"].includes(ak9Code)) outcome = "accepted";
  if (["R"].includes(ak9Code)) outcome = "rejected";
  if (["P"].includes(ak9Code)) outcome = "partial";

  if (outcome === "unknown" && ik5Segments.length > 0) {
    const hasRejected = ik5Segments.some((elements) => normalizeText(elements[1]).toUpperCase() === "R");
    const hasAccepted = ik5Segments.some((elements) => ["A", "E"].includes(normalizeText(elements[1]).toUpperCase()));
    if (hasRejected && hasAccepted) outcome = "partial";
    else if (hasRejected) outcome = "rejected";
    else if (hasAccepted) outcome = "accepted";
  }

  return {
    outcome,
    ak9Code: ak9Code || null,
    ik5Statuses: ik5Segments.map((elements) => elements[1] ?? null),
    errorSegments: errors.map((elements) => elements.join("*")),
    segmentCount: segments.length,
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

async function findBatchFromContent(organizationId: string, rawContent: string) {
  const segments = splitSegments(rawContent).map(splitElements);
  const ak2 = segments.find((elements) => elements[0] === "AK2");
  const stControlNumber = ak2?.[2] ? normalizeText(ak2[2]) : null;

  if (!stControlNumber) return null;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("edi_batches")
    .select("id, organization_id, status, transaction_type")
    .eq("organization_id", organizationId)
    .eq("transaction_type", "837P")
    .eq("st_control_number", stControlNumber)
    .order("generated_at", { ascending: false })
    .limit(1)
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

function batchStatusForOutcome(outcome: Edi999Outcome) {
  if (outcome === "accepted") return "accepted_999";
  if (outcome === "rejected") return "rejected_999";
  if (outcome === "partial") return "partially_accepted";
  return "submitted";
}

function claimStatusForOutcome(outcome: Edi999Outcome) {
  if (outcome === "accepted") return "accepted_oa";
  if (outcome === "rejected") return "rejected_oa";
  if (outcome === "partial") return "accepted_oa";
  return "submitted";
}

export async function intake999Acknowledgement(
  input: Intake999AcknowledgementInput
): Promise<Intake999AcknowledgementResult> {
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
      errors: [{ field: "raw_content", message: "999 acknowledgement content is required" }],
    };
  }

  const parsed = parse999(input.rawContent);
  const batch = input.batchId
    ? await loadBatchById(input.organizationId, input.batchId)
    : await findBatchFromContent(input.organizationId, input.rawContent);

  if (!batch) {
    return {
      ok: false,
      acknowledgementId: null,
      batchId: input.batchId ?? null,
      outcome: parsed.outcome,
      linkedClaimIds: [],
      errors: [{ field: "edi_batches", message: "Could not match 999 acknowledgement to an EDI batch" }],
    };
  }

  const batchId = String(batch.id);
  const linkedClaimIds = await loadLinkedClaimIds(batchId);

  const { data: ack, error: ackError } = await supabase
    .from("edi_acknowledgements")
    .insert({
      organization_id: input.organizationId,
      edi_batch_id: batchId,
      acknowledgement_type: "999",
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
      errors: [{ field: "edi_acknowledgements", message: ackError?.message ?? "Failed to store 999 acknowledgement" }],
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
      source: "999",
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

export const __private999ParserForTests = { parse999 };
