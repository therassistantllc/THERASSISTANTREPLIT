import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export interface RouteEra835ExceptionsInput {
  organizationId: string;
  eraImportBatchId?: string | null;
}

export interface RouteEra835ExceptionsResult {
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
  clp02_claim_status_code: string | null;
  clp03_total_charge: number;
  clp04_payment_amount: number;
  clp05_patient_responsibility: number;
  claim_match_status: string;
  posting_status: string;
  cas_adjustments: Array<{ groupCode?: string; reasonCode?: string; amount?: number }>;
  payer_claim_control_number: string | null;
};

function isDenied(payment: EraClaimPaymentRow) {
  return payment.clp02_claim_status_code === "4" || (Number(payment.clp04_payment_amount) === 0 && Number(payment.clp03_total_charge) > 0);
}

function isRecoupment(payment: EraClaimPaymentRow) {
  return Number(payment.clp04_payment_amount) < 0;
}

function workTypeForPayment(payment: EraClaimPaymentRow) {
  if (payment.claim_match_status === "unmatched") return "era_unmatched_claim";
  if (payment.claim_match_status === "ambiguous") return "era_ambiguous_match";
  if (payment.posting_status === "blocked") return "era_posting_blocked";
  if (isRecoupment(payment)) return "era_recoupment_review";
  if (isDenied(payment)) return "era_denial_review";
  return null;
}

function titleForPayment(payment: EraClaimPaymentRow, workType: string) {
  const label = payment.clp01_claim_control_number || payment.id;
  if (workType === "era_unmatched_claim") return `ERA unmatched claim - ${label}`;
  if (workType === "era_ambiguous_match") return `ERA ambiguous claim match - ${label}`;
  if (workType === "era_posting_blocked") return `ERA posting blocked - ${label}`;
  if (workType === "era_recoupment_review") return `ERA recoupment review - ${label}`;
  if (workType === "era_denial_review") return `ERA denial review - ${label}`;
  return `ERA exception - ${label}`;
}

function descriptionForWorkType(workType: string) {
  if (workType === "era_unmatched_claim") return "ERA claim payment could not be matched to a professional claim. Review CLP01 and claim identifiers before posting.";
  if (workType === "era_ambiguous_match") return "ERA claim payment matched multiple possible claims. Select the correct claim before posting.";
  if (workType === "era_posting_blocked") return "ERA claim payment is blocked from posting. Review match status, claim status, and adjustment details.";
  if (workType === "era_recoupment_review") return "ERA includes a negative payment or recoupment. Review before posting or offsetting balances.";
  if (workType === "era_denial_review") return "ERA indicates no payment or denied claim. Review CAS reason codes and determine appeal, correction, or write-off action.";
  return "ERA exception requires billing review.";
}

async function hasOpenItem(params: {
  organizationId: string;
  sourceObjectId: string;
  workType: string;
}) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("workqueue_items")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("source_object_type", "era_claim_payment")
    .eq("source_object_id", params.sourceObjectId)
    .eq("work_type", params.workType)
    .in("status", ["open", "in_progress", "blocked"])
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return Boolean(data?.id);
}

export async function routeEra835ExceptionsToWorkqueue(
  input: RouteEra835ExceptionsInput,
): Promise<RouteEra835ExceptionsResult> {
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

  let query = supabase
    .from("era_claim_payments")
    .select("id, professional_claim_id, client_id, clp01_claim_control_number, clp02_claim_status_code, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, claim_match_status, posting_status, cas_adjustments, payer_claim_control_number")
    .eq("organization_id", input.organizationId)
    .is("archived_at", null);

  if (input.eraImportBatchId) query = query.eq("era_import_batch_id", input.eraImportBatchId);

  const { data: payments, error: paymentError } = await query;
  if (paymentError) {
    return {
      ok: false,
      reviewed: 0,
      created: 0,
      skipped: 0,
      errors: [{ field: "era_claim_payments", message: paymentError.message }],
    };
  }

  let created = 0;
  let skipped = 0;
  const errors: Array<{ field: string; message: string }> = [];
  const now = new Date().toISOString();
  const rows = (payments ?? []) as EraClaimPaymentRow[];

  for (const payment of rows) {
    const workType = workTypeForPayment(payment);
    if (!workType) {
      skipped += 1;
      continue;
    }

    try {
      if (await hasOpenItem({ organizationId: input.organizationId, sourceObjectId: payment.id, workType })) {
        skipped += 1;
        continue;
      }

      const { error: insertError } = await supabase.from("workqueue_items").insert({
        organization_id: input.organizationId,
        title: titleForPayment(payment, workType),
        description: descriptionForWorkType(workType),
        work_type: workType,
        status: "open",
        priority: workType === "era_recoupment_review" ? "urgent" : "high",
        source_object_type: "era_claim_payment",
        source_object_id: payment.id,
        client_id: payment.client_id,
        professional_claim_id: payment.professional_claim_id,
        context_payload: {
          clp01_claim_control_number: payment.clp01_claim_control_number,
          payer_claim_control_number: payment.payer_claim_control_number,
          clp02_claim_status_code: payment.clp02_claim_status_code,
          clp03_total_charge: payment.clp03_total_charge,
          clp04_payment_amount: payment.clp04_payment_amount,
          clp05_patient_responsibility: payment.clp05_patient_responsibility,
          claim_match_status: payment.claim_match_status,
          posting_status: payment.posting_status,
          cas_adjustments: payment.cas_adjustments ?? [],
        },
        created_at: now,
        updated_at: now,
      });

      if (insertError) throw new Error(insertError.message);
      created += 1;
    } catch (error) {
      errors.push({
        field: payment.id,
        message: error instanceof Error ? error.message : "Failed to create ERA exception workqueue item",
      });
    }
  }

  return { ok: errors.length === 0, reviewed: rows.length, created, skipped, errors };
}
