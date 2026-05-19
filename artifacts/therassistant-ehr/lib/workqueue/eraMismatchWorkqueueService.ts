import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export interface RouteEraMismatchWorkqueueInput {
  organizationId: string;
  now?: string;
}

export interface RouteEraMismatchWorkqueueResult {
  ok: boolean;
  reviewed: number;
  created: number;
  skipped: number;
  errors: Array<{ field: string; message: string }>;
}

type EraClaimPaymentRow = {
  id: string;
  professional_claim_id: string | null;
  client_id: string | null;
  clp01_claim_control_number: string;
  clp03_total_charge: number;
  clp04_payment_amount: number;
  claim_match_status: string;
  posting_status: string;
};

async function hasOpenEraMismatchItem(organizationId: string, eraPaymentId: string) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");
  const { data, error } = await supabase
    .from("workqueue_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("source_object_type", "era_claim_payment")
    .eq("source_object_id", eraPaymentId)
    .eq("work_type", "era_mismatch")
    .in("status", ["open", "in_progress", "blocked"])
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data?.id);
}

export async function routeEraMismatchClaimsToWorkqueue(
  input: RouteEraMismatchWorkqueueInput,
): Promise<RouteEraMismatchWorkqueueResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return { ok: false, reviewed: 0, created: 0, skipped: 0, errors: [{ field: "system", message: "Database connection not available" }] };
  }

  const now = input.now ?? new Date().toISOString();

  // ERA payments that are unmatched or blocked from posting
  const { data: payments, error: paymentError } = await supabase
    .from("era_claim_payments")
    .select("id, professional_claim_id, client_id, clp01_claim_control_number, clp03_total_charge, clp04_payment_amount, claim_match_status, posting_status")
    .eq("organization_id", input.organizationId)
    .or("claim_match_status.eq.unmatched,posting_status.eq.blocked")
    .is("archived_at", null)
    .limit(250);

  if (paymentError) {
    return { ok: false, reviewed: 0, created: 0, skipped: 0, errors: [{ field: "era_claim_payments", message: paymentError.message }] };
  }

  let created = 0;
  let skipped = 0;
  const errors: Array<{ field: string; message: string }> = [];
  const rows = (payments ?? []) as EraClaimPaymentRow[];

  for (const payment of rows) {
    try {
      if (await hasOpenEraMismatchItem(input.organizationId, payment.id)) {
        skipped += 1;
        continue;
      }

      const reason = payment.claim_match_status === "unmatched"
        ? `ERA payment for claim control number ${payment.clp01_claim_control_number} could not be matched to a professional claim in the system.`
        : `ERA payment for claim control number ${payment.clp01_claim_control_number} is blocked from posting. Review ERA detail and resolve manually.`;

      const { error: insertError } = await supabase.from("workqueue_items").insert({
        organization_id: input.organizationId,
        title: `ERA mismatch – ${payment.clp01_claim_control_number}`,
        description: reason,
        work_type: "era_mismatch",
        status: "open",
        priority: "high",
        source_object_type: "era_claim_payment",
        source_object_id: payment.id,
        client_id: payment.client_id,
        professional_claim_id: payment.professional_claim_id,
        context_payload: {
          clp01_claim_control_number: payment.clp01_claim_control_number,
          claim_match_status: payment.claim_match_status,
          posting_status: payment.posting_status,
          total_charge: payment.clp03_total_charge,
          payment_amount: payment.clp04_payment_amount,
        },
        created_at: now,
        updated_at: now,
      });

      if (insertError) throw new Error(insertError.message);
      created += 1;
    } catch (error) {
      errors.push({
        field: payment.id,
        message: error instanceof Error ? error.message : "Failed to create ERA mismatch workqueue item",
      });
    }
  }

  return { ok: errors.length === 0, reviewed: rows.length, created, skipped, errors };
}
