import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export interface RouteAgingProfessionalClaimsInput {
  organizationId: string;
  agingDays?: number;
  now?: string;
}

export interface RouteAgingProfessionalClaimsResult {
  ok: boolean;
  reviewed: number;
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
  updated_at: string | null;
  submitted_at: string | null;
};

// AR aging bucket work_type based on days since submission
const AR_AGING_BUCKETS = [
  { workType: "aging_0_30",   min: 0,   max: 30,   label: "AR 0–30 Days" },
  { workType: "aging_31_60",  min: 31,  max: 60,   label: "AR 31–60 Days" },
  { workType: "aging_61_90",  min: 61,  max: 90,   label: "AR 61–90 Days" },
  { workType: "aging_91_120", min: 91,  max: 120,  label: "AR 91–120 Days" },
  { workType: "aging_120_plus", min: 121, max: Infinity, label: "AR 120+ Days" },
] as const;

function agingBucketForDays(days: number) {
  return AR_AGING_BUCKETS.find((b) => days >= b.min && days <= b.max) ?? AR_AGING_BUCKETS[AR_AGING_BUCKETS.length - 1];
}

function daysSince(isoDate: string | null | undefined, now?: string): number {
  if (!isoDate) return 0;
  const base = now ? new Date(now) : new Date();
  const ms = base.getTime() - new Date(isoDate).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function cutoffIso(days: number, now?: string) {
  const base = now ? new Date(now) : new Date();
  return new Date(base.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function claimLabel(claim: ClaimRow) {
  return claim.claim_number || claim.patient_account_number || claim.id;
}

async function hasOpenAgingItem(organizationId: string, claimId: string, workType: string) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("workqueue_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("source_object_type", "professional_claim")
    .eq("source_object_id", claimId)
    .eq("work_type", workType)
    .in("status", ["open", "in_progress", "blocked"])
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return Boolean(data?.id);
}

// Keep legacy function name for callers
async function _hasOpenNoResponseItem(organizationId: string, claimId: string) {
  return hasOpenAgingItem(organizationId, claimId, "no_response");
}

async function hasPostSubmissionResponse(claimId: string) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data: batchLinks, error: linkError } = await supabase
    .from("edi_batch_claims")
    .select("edi_batch_id")
    .eq("claim_id", claimId);

  if (linkError) throw new Error(linkError.message);
  const batchIds = (batchLinks ?? []).map((row: { edi_batch_id: string }) => row.edi_batch_id);
  if (batchIds.length === 0) return false;

  const { data: acknowledgements, error: ackError } = await supabase
    .from("edi_acknowledgements")
    .select("id")
    .in("edi_batch_id", batchIds)
    .in("acknowledgement_type", ["999", "277CA", "835"])
    .limit(1);

  if (ackError) throw new Error(ackError.message);
  return Boolean(acknowledgements && acknowledgements.length > 0);
}

export async function routeAgingProfessionalClaimsToWorkqueue(
  input: RouteAgingProfessionalClaimsInput
): Promise<RouteAgingProfessionalClaimsResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      reviewed: 0,
      created: 0,
      skipped: 0,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  // Minimum days before we consider a claim aging (default 1 day so all submitted claims appear)
  const agingDays = input.agingDays ?? 1;
  const cutoff = cutoffIso(agingDays, input.now);
  const now = input.now ?? new Date().toISOString();

  const { data: claims, error: claimError } = await supabase
    .from("professional_claims")
    .select("id, patient_id, claim_number, patient_account_number, claim_status, updated_at, submitted_at")
    .eq("organization_id", input.organizationId)
    .eq("claim_status", "submitted")
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(250);

  if (claimError) {
    return {
      ok: false,
      reviewed: 0,
      created: 0,
      skipped: 0,
      errors: [{ field: "professional_claims", message: claimError.message }],
    };
  }

  let created = 0;
  let skipped = 0;
  const errors: Array<{ field: string; message: string }> = [];
  const rows = (claims ?? []) as ClaimRow[];

  for (const claim of rows) {
    try {
      const hasResponse = await hasPostSubmissionResponse(claim.id);
      if (hasResponse) {
        skipped += 1;
        continue;
      }

      // Calculate AR aging bucket from submission date (fall back to updated_at)
      const submittedDate = (claim as ClaimRow).submitted_at ?? claim.updated_at;
      const days = daysSince(submittedDate, input.now);
      const bucket = agingBucketForDays(days);

      // Always ensure a no_response item exists for 0-day threshold
      const noResponseExists = await hasOpenAgingItem(input.organizationId, claim.id, "no_response");
      if (!noResponseExists) {
        const { error: noResponseError } = await supabase.from("workqueue_items").insert({
          organization_id: input.organizationId,
          title: `No response received – claim ${claimLabel(claim)}`,
          description: "Professional claim submitted with no recorded 999, 277CA, or ERA response. Review clearinghouse status and follow up.",
          work_type: "no_response",
          status: "open",
          priority: "high",
          source_object_type: "professional_claim",
          source_object_id: claim.id,
          client_id: claim.patient_id,
          professional_claim_id: claim.id,
          context_payload: { claim_status: claim.claim_status, claim_number: claim.claim_number, days_outstanding: days },
          created_at: now,
          updated_at: now,
        });
        if (noResponseError) throw new Error(noResponseError.message);
        created += 1;
      }

      // Also create an AR aging bucket item if one doesn't exist for this bucket
      const bucketExists = await hasOpenAgingItem(input.organizationId, claim.id, bucket.workType);
      if (!bucketExists) {
        const priority = days >= 91 ? "urgent" : days >= 61 ? "high" : "normal";
        const { error: bucketError } = await supabase.from("workqueue_items").insert({
          organization_id: input.organizationId,
          title: `${bucket.label} – claim ${claimLabel(claim)}`,
          description: `Professional claim has been outstanding for ${days} day(s) with no recorded payment. Review payer status and initiate follow-up.`,
          work_type: bucket.workType,
          status: "open",
          priority,
          source_object_type: "professional_claim",
          source_object_id: claim.id,
          client_id: claim.patient_id,
          professional_claim_id: claim.id,
          context_payload: {
            claim_status: claim.claim_status,
            claim_number: claim.claim_number,
            patient_account_number: claim.patient_account_number,
            days_outstanding: days,
            submitted_at: submittedDate,
          },
          created_at: now,
          updated_at: now,
        });
        if (bucketError) throw new Error(bucketError.message);
        created += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      errors.push({
        field: claim.id,
        message: error instanceof Error ? error.message : "Failed to create aging workqueue item",
      });
    }
  }

  return {
    ok: errors.length === 0,
    reviewed: rows.length,
    created,
    skipped,
    errors,
  };
}
