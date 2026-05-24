import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  loadRejection277CaAutoRouteSettings,
  pickAutoRouteForRejection277Ca,
  type Rejection277CaTabId,
} from "@/lib/billing/rejections277ca";

type RejectionSource = "999" | "277CA";

const FAR_FUTURE_ISO = "9999-12-31T00:00:00.000Z";

type ParsedStcEntry = {
  category?: string | null;
  status?: string | null;
  entity?: string | null;
  message?: string | null;
};

function toStcEntries(raw: unknown): ParsedStcEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({
      category: typeof e.category === "string" ? e.category : null,
      status: typeof e.status === "string" ? e.status : null,
      entity: typeof e.entity === "string" ? e.entity : null,
      message: typeof e.message === "string" ? e.message : null,
    }));
}

function extractStcEntries(parsed: Record<string, unknown> | null | undefined): ParsedStcEntry[] {
  if (!parsed) return [];
  return toStcEntries((parsed as { stcStatuses?: unknown }).stcStatuses);
}

type ParsedClaimRef = {
  trn: string;
  stcStatuses: ParsedStcEntry[];
  message: string | null;
};

function extractClaimRefs(parsed: Record<string, unknown> | null | undefined): ParsedClaimRef[] {
  if (!parsed) return [];
  const raw = (parsed as { claimRefs?: unknown }).claimRefs;
  if (!Array.isArray(raw)) return [];
  const out: ParsedClaimRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const trn = typeof obj.trn === "string" ? obj.trn.trim() : "";
    if (!trn) continue;
    out.push({
      trn,
      stcStatuses: toStcEntries(obj.stcStatuses),
      message: typeof obj.message === "string" ? obj.message : null,
    });
  }
  return out;
}

function buildClaimRefIndex(refs: ParsedClaimRef[]): Map<string, ParsedClaimRef> {
  // Index by the trimmed/uppercased TRN value so we can match it against
  // a claim's patient_account_number or claim_number regardless of
  // surrounding whitespace or case in the inbound 277CA.
  const idx = new Map<string, ParsedClaimRef>();
  for (const ref of refs) {
    const key = ref.trn.toUpperCase();
    if (!idx.has(key)) idx.set(key, ref);
  }
  return idx;
}

function lookupClaimRef(
  index: Map<string, ParsedClaimRef>,
  claim: ClaimRow,
): ParsedClaimRef | null {
  if (index.size === 0) return null;
  for (const candidate of [claim.patient_account_number, claim.claim_number, claim.id]) {
    if (!candidate) continue;
    const hit = index.get(String(candidate).trim().toUpperCase());
    if (hit) return hit;
  }
  return null;
}

function pickStringField(
  parsed: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!parsed) return null;
  for (const k of keys) {
    const v = (parsed as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

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
  autoRouted: number;
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
      autoRouted: 0,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  if (!input.claimIds.length) {
    return { ok: true, created: 0, skipped: 0, autoRouted: 0, errors: [] };
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
      autoRouted: 0,
      errors: [{ field: "professional_claims", message: claimError.message }],
    };
  }

  let created = 0;
  let skipped = 0;
  let autoRouted = 0;
  const errors: Array<{ field: string; message: string }> = [];
  const now = new Date().toISOString();

  // Per-org auto-routing config (277CA only). Default is "on", so a
  // freshly-arrived rejection that's obviously an eligibility or
  // credentialing issue gets deferred immediately instead of waiting
  // for a biller to click "Route to …".
  const autoRouteSettings =
    input.source === "277CA"
      ? await loadRejection277CaAutoRouteSettings(supabase, input.organizationId)
      : null;

  // Per-claim STC index — the 277CA parser groups STC segments under the
  // 2200D TRN that identifies each claim, so different claims in the same
  // batch can carry different rejection reasons. We fall back to the
  // batch-level entries when a claim has no per-claim ref (eg. older acks
  // that only carried transaction-level STCs).
  const claimRefIndex = buildClaimRefIndex(extractClaimRefs(input.parsedContent ?? null));
  const batchLevelStcEntries = extractStcEntries(input.parsedContent ?? null);
  const batchLevelMessage = pickStringField(input.parsedContent ?? null, [
    "rejection_reason",
    "status_message",
    "message",
    "free_form_message",
  ]);
  const batchLevelCategory = pickStringField(input.parsedContent ?? null, [
    "category_code",
    "stc_category_code",
  ]);
  const batchLevelStatus = pickStringField(input.parsedContent ?? null, [
    "status_code",
    "stc_status_code",
  ]);
  const batchLevelEntity = pickStringField(input.parsedContent ?? null, [
    "entity_code",
    "stc_entity_code",
  ]);

  function classifyClaim(claim: ClaimRow): ReturnType<typeof pickAutoRouteForRejection277Ca> {
    if (input.source !== "277CA" || !autoRouteSettings?.enabled) return null;
    const ref = lookupClaimRef(claimRefIndex, claim);
    const stcEntries = ref ? ref.stcStatuses : batchLevelStcEntries;
    const message = ref?.message ?? batchLevelMessage;
    const decision = pickAutoRouteForRejection277Ca({
      stcEntries,
      message,
      // Only fall back to the batch-level singular code hints when we don't
      // have a per-claim STC list at all — otherwise the per-claim entries
      // already carry the codes inside `stcEntries`.
      categoryCode: ref ? null : batchLevelCategory,
      statusCode: ref ? null : batchLevelStatus,
      entityCode: ref ? null : batchLevelEntity,
    });
    if (!decision) return null;
    if (decision.tab === "invalid_member" && !autoRouteSettings.routeInvalidMember) return null;
    if (decision.tab === "invalid_provider" && !autoRouteSettings.routeInvalidProvider) return null;
    return decision;
  }

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

      const claimRef = lookupClaimRef(claimRefIndex, claim);
      const autoRouteDecision = classifyClaim(claim);

      const baseContext: Record<string, unknown> = {
        source: input.source,
        outcome: input.outcome,
        acknowledgement_id: input.acknowledgementId,
        edi_batch_id: input.batchId,
        claim_status: claim.claim_status,
        claim_number: claim.claim_number,
        patient_account_number: claim.patient_account_number,
        parsed_content: input.parsedContent ?? {},
      };

      // Surface the matched per-claim STC slice so downstream UIs (and
      // human reviewers reading the workqueue context) can see exactly
      // which STC entries drove the routing decision for this claim.
      if (claimRef) {
        baseContext.claim_ref_trn = claimRef.trn;
        baseContext.claim_stc_statuses = claimRef.stcStatuses;
        if (claimRef.message) baseContext.claim_message = claimRef.message;
      }

      if (autoRouteDecision) {
        baseContext.auto_routed = true;
        baseContext.auto_routed_tab = autoRouteDecision.tab as Rejection277CaTabId;
        baseContext.auto_routed_reason = autoRouteDecision.reason;
        baseContext.auto_routed_at = now;
      }

      const insertRow: Record<string, unknown> = {
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
        context_payload: baseContext,
        created_at: now,
        updated_at: now,
      };

      // Auto-routed items stay visible in the 277CA queue (status=open,
      // not archived) so the biller can override. We mark them with
      // deferred_until + defer_reason, matching what the manual
      // "Route to eligibility / enrollment" action produces.
      if (autoRouteDecision) {
        insertRow.deferred_until = FAR_FUTURE_ISO;
        insertRow.defer_reason = autoRouteDecision.reason;
      }

      const { error: insertError } = await (supabase as unknown as {
        from: (t: string) => { insert: (r: Record<string, unknown>) => Promise<{ error: { message: string } | null }> };
      })
        .from("workqueue_items")
        .insert(insertRow);

      if (insertError) throw new Error(insertError.message);
      created += 1;
      if (autoRouteDecision) autoRouted += 1;
    } catch (error) {
      errors.push({
        field: claim.id,
        message: error instanceof Error ? error.message : "Failed to create rejection workqueue item",
      });
    }
  }

  return { ok: errors.length === 0, created, skipped, autoRouted, errors };
}
