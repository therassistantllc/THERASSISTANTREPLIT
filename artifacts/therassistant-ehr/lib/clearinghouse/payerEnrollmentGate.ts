// Per-payer enrollment gate. Blocks 837P production transmission to any payer in the batch
// whose (org, payer, transaction_type, environment) enrollment is not "approved".
//
// Sandbox submissions ALWAYS pass — operators need to be able to round-trip the sandbox
// without first running the production enrollment process. Production submissions block on
// any payer in the batch that lacks an approved enrollment.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CredentialEnvironment } from "./credentials";

export type PayerEnrollmentGateResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      missing: Array<{
        payerProfileId: string;
        payerName: string;
        officeAllyPayerId: string | null;
        currentStatus: string | null;
      }>;
    };

/**
 * Assert that every distinct payer in `batchId` has an `approved` enrollment for the given
 * transaction type and environment. Sandbox is always allowed.
 */
export async function assertPayerEnrollmentsForBatch(params: {
  supabase: SupabaseClient;
  organizationId: string;
  batchId: string;
  transactionType: "837P" | "837I" | "835" | "270" | "276" | "999";
  environment: CredentialEnvironment;
}): Promise<PayerEnrollmentGateResult> {
  const { supabase, organizationId, batchId, transactionType, environment } = params;

  // Sandbox is always allowed.
  if (environment === "sandbox") return { ok: true };

  // 1. Collect distinct payer_profile_ids in the batch via the batch_claims → professional_claims FK.
  const { data: batchClaims, error: batchErr } = await supabase
    .from("claim_837p_batch_claims")
    .select("professional_claim_id, professional_claims!inner(payer_profile_id)")
    .eq("organization_id", organizationId)
    .eq("batch_id", batchId)
    .is("archived_at", null);

  if (batchErr) {
    return {
      ok: false,
      message: `Failed to look up payers for batch: ${batchErr.message}`,
      missing: [],
    };
  }

  const payerIds = new Set<string>();
  // supabase-js types the nested join as an array; at runtime it may be either an array
  // (one-to-many) or an object (one-to-one). Handle both shapes defensively.
  for (const row of (batchClaims ?? []) as Array<{
    professional_claims:
      | { payer_profile_id: string | null }
      | Array<{ payer_profile_id: string | null }>
      | null;
  }>) {
    const pc = row.professional_claims;
    if (!pc) continue;
    const records = Array.isArray(pc) ? pc : [pc];
    for (const rec of records) {
      if (rec?.payer_profile_id) payerIds.add(rec.payer_profile_id);
    }
  }

  if (payerIds.size === 0) {
    return {
      ok: false,
      message:
        "No payer_profile_id set on any claim in this batch. Each claim must reference a payer profile before it can be submitted.",
      missing: [],
    };
  }

  // 2. Look up approved enrollments for those payers in the requested env/transaction.
  const payerIdList = Array.from(payerIds);
  const [{ data: approvedRows, error: enrollErr }, { data: payerRows, error: payerErr }] = await Promise.all([
    supabase
      .from("payer_enrollments")
      .select("payer_profile_id, status")
      .eq("organization_id", organizationId)
      .eq("transaction_type", transactionType)
      .eq("environment", environment)
      // Only "approved" rows authorize transmission. Terminated rows are kept for history
      // and must never be considered. Filtering in SQL (rather than in-memory) prevents an
      // old terminated/approved row from winning over a current "pending" row.
      .eq("status", "approved")
      .neq("status", "terminated")
      .in("payer_profile_id", payerIdList),
    supabase
      .from("payer_profiles")
      .select("id, payer_name, office_ally_payer_id")
      .eq("organization_id", organizationId)
      .in("id", payerIdList),
  ]);

  if (enrollErr) {
    return {
      ok: false,
      message: `Failed to read payer_enrollments: ${enrollErr.message}`,
      missing: [],
    };
  }
  if (payerErr) {
    return {
      ok: false,
      message: `Failed to read payer_profiles: ${payerErr.message}`,
      missing: [],
    };
  }

  const statusByPayer = new Map<string, string>();
  for (const r of (approvedRows ?? []) as Array<{ payer_profile_id: string; status: string }>) {
    // Most recent non-terminated row wins; the partial unique index already enforces "at most one".
    statusByPayer.set(r.payer_profile_id, r.status);
  }

  const payerMeta = new Map<string, { name: string; oaId: string | null }>();
  for (const p of (payerRows ?? []) as Array<{ id: string; payer_name: string; office_ally_payer_id: string | null }>) {
    payerMeta.set(p.id, { name: p.payer_name, oaId: p.office_ally_payer_id });
  }

  const missing = payerIdList
    .filter((id) => statusByPayer.get(id) !== "approved")
    .map((id) => ({
      payerProfileId: id,
      payerName: payerMeta.get(id)?.name ?? "(unknown payer)",
      officeAllyPayerId: payerMeta.get(id)?.oaId ?? null,
      currentStatus: statusByPayer.get(id) ?? null,
    }));

  if (missing.length === 0) return { ok: true };

  const list = missing
    .map((m) => `${m.payerName}${m.officeAllyPayerId ? ` (OA ${m.officeAllyPayerId})` : ""}: ${m.currentStatus ?? "not enrolled"}`)
    .join("; ");

  return {
    ok: false,
    message:
      `Production ${transactionType} submission blocked. The following payer(s) lack an approved ${environment} ${transactionType} enrollment: ${list}. ` +
      `Open /settings/payer-enrollments to track and update the Office Ally enrollment status.`,
    missing,
  };
}
