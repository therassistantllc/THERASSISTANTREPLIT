import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { routeRejectedClaimsToWorkqueue } from "@/lib/workqueue/claimRejectionWorkqueueService";
import {
  detect277CADocumentationRequest,
  writeMedicalReviewRequestAudit,
} from "@/lib/medical-review/documentationRequestDetection";

type Edi277CAOutcome = "accepted" | "rejected" | "partial" | "unknown";

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

type ParsedStc = {
  raw: string;
  category: string | null;
  status: string | null;
  entity: string | null;
  actionCode: string | null;
  monetaryAmount: string | null;
  message: string | null;
};

function parseStcSegment(elements: string[]): ParsedStc {
  const composite = normalizeText(elements[1]);
  const [category, status, entity] = composite.split(":");
  // STC11 carries the free-form Health Care Claim Status text the payer
  // uses to describe why a claim was rejected. We surface it as `message`
  // so per-claim classification can keyword-match the same way the
  // batch-level message classifier does.
  return {
    raw: elements.join("*"),
    category: category || null,
    status: status || null,
    entity: entity || null,
    actionCode: normalizeText(elements[3]) || null,
    monetaryAmount: normalizeText(elements[4]) || null,
    message: normalizeText(elements[11]) || null,
  };
}

function isRejectStc(entry: ParsedStc): boolean {
  const category = normalizeText(entry.category).toUpperCase();
  const status = normalizeText(entry.status).toUpperCase();
  return (
    ["A3", "A6", "A7", "A8", "E0"].includes(category) ||
    ["562", "U", "R"].includes(status)
  );
}

function isAcceptStc(entry: ParsedStc): boolean {
  const category = normalizeText(entry.category).toUpperCase();
  return ["A1", "A2", "A5"].includes(category);
}

export type Parsed277CaClaimRef = {
  /** TRN02 from the 2200D loop — echoes the original 837P CLM01 (patient
   *  account number) so we can match each per-claim status back to the
   *  professional_claims row we submitted. */
  trn: string;
  stcStatuses: ParsedStc[];
  message: string | null;
};

function parse277CA(rawContent: string) {
  const parsedSegments = splitSegments(rawContent).map(splitElements);
  const bht = parsedSegments.find((elements) => elements[0] === "BHT");

  // Walk the segments in order so we can group each STC under the closest
  // preceding TRN inside a 2200D (claim-level) loop. The 2200D loop only
  // appears nested under HL*…*…*23 (claim/patient detail), so we track the
  // current HL level and only attribute STCs to a claim when we're inside
  // a 23-level HL. STCs that appear outside any claim loop (eg. at the
  // transaction set or 2000A info-source level) are still kept on the
  // top-level `stcStatuses` list for back-compat consumers like the
  // documentation-request detector.
  const stcStatuses: ParsedStc[] = [];
  const claimRefs: Parsed277CaClaimRef[] = [];
  let currentHlLevel: string | null = null;
  let currentClaim: Parsed277CaClaimRef | null = null;

  for (const elements of parsedSegments) {
    const tag = elements[0];
    if (tag === "HL") {
      // HL01 = id, HL02 = parent id, HL03 = level code. A new HL closes
      // out any in-progress claim loop.
      currentHlLevel = normalizeText(elements[3]) || null;
      currentClaim = null;
      continue;
    }
    if (tag === "TRN" && currentHlLevel === "23") {
      const trn = normalizeText(elements[2]);
      if (trn) {
        currentClaim = { trn, stcStatuses: [], message: null };
        claimRefs.push(currentClaim);
      } else {
        currentClaim = null;
      }
      continue;
    }
    if (tag === "STC") {
      const entry = parseStcSegment(elements);
      stcStatuses.push(entry);
      if (currentClaim) {
        currentClaim.stcStatuses.push(entry);
        if (!currentClaim.message && entry.message) {
          currentClaim.message = entry.message;
        }
      }
    }
  }

  const hasReject = stcStatuses.some(isRejectStc);
  const hasAccept = stcStatuses.some(isAcceptStc);

  let outcome: Edi277CAOutcome = "unknown";
  if (hasReject && hasAccept) outcome = "partial";
  else if (hasReject) outcome = "rejected";
  else if (hasAccept) outcome = "accepted";

  return {
    outcome,
    bht: bht ? bht.join("*") : null,
    stcStatuses,
    claimRefs,
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

type ClaimContextRow = {
  patient_id: string | null;
  appointment_id: string | null;
  patient_account_number: string | null;
  claim_number: string | null;
};

async function loadClaimContexts(
  organizationId: string,
  claimIds: string[],
): Promise<Map<string, ClaimContextRow>> {
  const out = new Map<string, ClaimContextRow>();
  if (claimIds.length === 0) return out;
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return out;
  const { data } = await supabase
    .from("professional_claims")
    .select("id, patient_id, appointment_id, patient_account_number, claim_number")
    .eq("organization_id", organizationId)
    .in("id", claimIds);
  for (const row of (data ?? []) as Array<{
    id: string;
    patient_id: string | null;
    appointment_id: string | null;
    patient_account_number: string | null;
    claim_number: string | null;
  }>) {
    out.set(String(row.id), {
      patient_id: row.patient_id ?? null,
      appointment_id: row.appointment_id ?? null,
      patient_account_number: row.patient_account_number ?? null,
      claim_number: row.claim_number ?? null,
    });
  }
  return out;
}

/**
 * Resolve each parsed 277CA claim ref (keyed by TRN02 echoing the
 * original 837P CLM01) back to one or more linked professional_claims
 * rows. Matching is case/whitespace-insensitive against
 * patient_account_number, claim_number, then the claim id itself —
 * mirrors the workqueue routing service's lookup so both paths agree
 * on which claim a TRN names.
 */
function matchClaimsForTrn(
  trn: string,
  linkedClaimIds: string[],
  contexts: Map<string, ClaimContextRow>,
): string[] {
  const key = trn.trim().toUpperCase();
  if (!key) return [];
  const matches: string[] = [];
  for (const claimId of linkedClaimIds) {
    const ctx = contexts.get(claimId);
    const candidates = [
      ctx?.patient_account_number,
      ctx?.claim_number,
      claimId,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (String(candidate).trim().toUpperCase() === key) {
        matches.push(claimId);
        break;
      }
    }
  }
  return matches;
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

// Derive a single outcome from one 2200D claim ref's STC entries. Mirrors
// the batch-level aggregator in parse277CA but scoped to one claim so a
// mixed-rejection batch (one claim accepted, one rejected) can tag each
// claim with its own status instead of collapsing both to the batch
// outcome. Returns "unknown" when the ref carries no acc/rej STC so the
// caller can fall back to the batch outcome.
function outcomeForClaimRef(ref: Parsed277CaClaimRef): Edi277CAOutcome {
  const hasReject = ref.stcStatuses.some(isRejectStc);
  const hasAccept = ref.stcStatuses.some(isAcceptStc);
  if (hasReject && hasAccept) return "partial";
  if (hasReject) return "rejected";
  if (hasAccept) return "accepted";
  return "unknown";
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

  // Per-claim status: each linked claim is tagged from its OWN matching
  // 2200D STC entries (TRN ↔ patient_account_number / claim_number / id).
  // Claims with no matching ref fall back to the batch-level outcome so
  // older acks that don't slice per claim still flip everything as one.
  // We load contexts once here and reuse them below for the medical-review
  // seed pass — both need the same patient_account_number lookup.
  const claimContexts =
    linkedClaimIds.length > 0
      ? await loadClaimContexts(input.organizationId, linkedClaimIds)
      : new Map<string, ClaimContextRow>();

  if (linkedClaimIds.length > 0) {
    const batchStatus = claimStatusForOutcome(parsed.outcome);
    const perClaimStatus = new Map<string, string>();
    for (const claimId of linkedClaimIds) {
      perClaimStatus.set(claimId, batchStatus);
    }
    for (const ref of parsed.claimRefs) {
      const refOutcome = outcomeForClaimRef(ref);
      if (refOutcome === "unknown") continue;
      const matched = matchClaimsForTrn(ref.trn, linkedClaimIds, claimContexts);
      if (matched.length === 0) continue;
      const status = claimStatusForOutcome(refOutcome);
      for (const claimId of matched) perClaimStatus.set(claimId, status);
    }

    const idsByStatus = new Map<string, string[]>();
    for (const [claimId, status] of perClaimStatus) {
      const bucket = idsByStatus.get(status);
      if (bucket) bucket.push(claimId);
      else idsByStatus.set(status, [claimId]);
    }

    const updatedAt = new Date().toISOString();
    for (const [status, ids] of idsByStatus) {
      const { error: claimUpdateError } = await supabase
        .from("professional_claims")
        .update({ claim_status: status, updated_at: updatedAt })
        .in("id", ids)
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

  // ── Auto-seed Medical Review queue from 277CA documentation requests. ──
  // When the ack carries STC entries indicating the payer is asking for
  // additional documentation (e.g. category A6 with status 287/324/354),
  // write a `medical_review_requested` audit row for the specific claim
  // named by the matching 2200D TRN — NOT every claim in the batch. The
  // 277CA's HL/CLM hierarchy ties each STC to one claim control number,
  // so a documentation request for one of many claims must not seed the
  // queue for the other unrelated claims sharing the same batch. The
  // write is idempotent on (claim, origin, acknowledgement id) so
  // re-ingesting the same 277CA does not flood the queue.
  if (linkedClaimIds.length > 0 && parsed.claimRefs.length > 0) {
    const contexts = claimContexts;
    const seededClaimIds = new Set<string>();

    for (const claimRef of parsed.claimRefs) {
      const perClaimDetected = detect277CADocumentationRequest({
        stcStatuses: claimRef.stcStatuses,
      });
      if (!perClaimDetected) continue;

      const matchedClaimIds = matchClaimsForTrn(claimRef.trn, linkedClaimIds, contexts);
      if (matchedClaimIds.length === 0) {
        // Per-claim STC says "send docs" but we couldn't match the TRN
        // back to a known claim in this batch — log and skip rather
        // than fanning out to unrelated claims.
        console.warn(
          `[277CA medical-review seed] no claim matched TRN ${claimRef.trn} in batch ${batchId}`,
        );
        continue;
      }

      for (const claimId of matchedClaimIds) {
        if (seededClaimIds.has(claimId)) continue;
        seededClaimIds.add(claimId);
        const ctx = contexts.get(claimId);
        const writeResult = await writeMedicalReviewRequestAudit(supabase, {
          organizationId: input.organizationId,
          claimId,
          clientId: ctx?.patient_id ?? null,
          appointmentId: ctx?.appointment_id ?? null,
          detected: perClaimDetected,
          origin: "277CA",
          sourceObjectId: acknowledgementId,
          claimRefTrn: claimRef.trn || null,
        });
        if (writeResult.status === "error") {
          // Non-fatal: log but don't fail the whole ingest — the rejected
          // workqueue routing already succeeded and the queue can be
          // re-seeded by re-ingesting the same ack.
          console.warn(
            `[277CA medical-review seed] failed for claim ${claimId}: ${writeResult.error}`,
          );
        }
      }
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

// Test-only: exposes the internal parser to unit tests.
export const __private277CAParserForTests = { parse277CA };
