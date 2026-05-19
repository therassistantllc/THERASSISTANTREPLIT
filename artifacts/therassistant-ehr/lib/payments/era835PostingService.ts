import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export interface PostEra835BatchInput {
  organizationId: string;
  eraImportBatchId: string;
}

export interface PostEra835BatchResult {
  ok: boolean;
  postedClaims: number;
  blockedClaims: number;
  patientInvoicesCreated: number;
  errors: Array<{ field: string; message: string }>;
}

type EraClaimPaymentRow = {
  id: string;
  professional_claim_id: string | null;
  client_id: string | null;
  clp01_claim_control_number: string;
  clp03_total_charge: number;
  clp04_payment_amount: number;
  clp05_patient_responsibility: number;
  cas_adjustments: Array<{ groupCode?: string; reasonCode?: string; amount?: number }>;
  claim_match_status: string;
  posting_status: string;
};

function invoiceNumber(paymentId: string) {
  return `INV-${paymentId.slice(0, 8).toUpperCase()}`;
}

function sumContractualAdjustments(adjustments: EraClaimPaymentRow["cas_adjustments"]) {
  return (adjustments ?? [])
    .filter((adjustment) => adjustment.groupCode === "CO")
    .reduce((sum, adjustment) => sum + Number(adjustment.amount ?? 0), 0);
}

async function createLedgerEntry(params: {
  organizationId: string;
  payment: EraClaimPaymentRow;
  entryType: "insurance_payment" | "contractual_adjustment" | "patient_responsibility";
  amount: number;
  groupCode?: string | null;
  reasonCode?: string | null;
  description: string;
}) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { error } = await supabase.from("era_posting_ledger_entries").insert({
    organization_id: params.organizationId,
    era_claim_payment_id: params.payment.id,
    professional_claim_id: params.payment.professional_claim_id,
    client_id: params.payment.client_id,
    entry_type: params.entryType,
    amount: params.amount,
    group_code: params.groupCode ?? null,
    reason_code: params.reasonCode ?? null,
    description: params.description,
  });

  if (error) throw new Error(error.message);
}

async function createPatientInvoiceIfNeeded(params: {
  organizationId: string;
  payment: EraClaimPaymentRow;
}) {
  const responsibility = Number(params.payment.clp05_patient_responsibility ?? 0);
  if (responsibility <= 0 || !params.payment.client_id) return false;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data: existing } = await supabase
    .from("patient_invoices")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("era_claim_payment_id", params.payment.id)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();

  if (existing?.id) return false;

  const { error } = await supabase.from("patient_invoices").insert({
    organization_id: params.organizationId,
    client_id: params.payment.client_id,
    professional_claim_id: params.payment.professional_claim_id,
    era_claim_payment_id: params.payment.id,
    invoice_status: "open",
    invoice_number: invoiceNumber(params.payment.id),
    patient_responsibility_amount: responsibility,
    paid_amount: 0,
    balance_amount: responsibility,
    source: "era_pr",
  });

  if (error) throw new Error(error.message);
  return true;
}

export async function postEra835Batch(input: PostEra835BatchInput): Promise<PostEra835BatchResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      postedClaims: 0,
      blockedClaims: 0,
      patientInvoicesCreated: 0,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  const { data: payments, error: paymentError } = await supabase
    .from("era_claim_payments")
    .select("id, professional_claim_id, client_id, clp01_claim_control_number, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, cas_adjustments, claim_match_status, posting_status")
    .eq("organization_id", input.organizationId)
    .eq("era_import_batch_id", input.eraImportBatchId)
    .is("archived_at", null);

  if (paymentError) {
    return {
      ok: false,
      postedClaims: 0,
      blockedClaims: 0,
      patientInvoicesCreated: 0,
      errors: [{ field: "era_claim_payments", message: paymentError.message }],
    };
  }

  let postedClaims = 0;
  let blockedClaims = 0;
  let patientInvoicesCreated = 0;
  const errors: Array<{ field: string; message: string }> = [];

  for (const payment of (payments ?? []) as EraClaimPaymentRow[]) {
    try {
      if (payment.claim_match_status !== "matched" || !payment.professional_claim_id) {
        blockedClaims += 1;
        continue;
      }

      if (payment.posting_status === "posted") {
        postedClaims += 1;
        continue;
      }

      const insurancePayment = Number(payment.clp04_payment_amount ?? 0);
      if (insurancePayment > 0) {
        await createLedgerEntry({
          organizationId: input.organizationId,
          payment,
          entryType: "insurance_payment",
          amount: insurancePayment,
          description: "Insurance payment posted from ERA 835 CLP04",
        });
      }

      const contractualAdjustment = sumContractualAdjustments(payment.cas_adjustments);
      if (contractualAdjustment > 0) {
        await createLedgerEntry({
          organizationId: input.organizationId,
          payment,
          entryType: "contractual_adjustment",
          amount: contractualAdjustment,
          groupCode: "CO",
          description: "Contractual adjustment posted from ERA 835 CAS CO segments",
        });
      }

      const patientResponsibility = Number(payment.clp05_patient_responsibility ?? 0);
      if (patientResponsibility > 0) {
        await createLedgerEntry({
          organizationId: input.organizationId,
          payment,
          entryType: "patient_responsibility",
          amount: patientResponsibility,
          groupCode: "PR",
          description: "Patient responsibility transferred from ERA 835 CLP05",
        });

        const invoiceCreated = await createPatientInvoiceIfNeeded({ organizationId: input.organizationId, payment });
        if (invoiceCreated) patientInvoicesCreated += 1;
      }

      await supabase
        .from("era_claim_payments")
        .update({ posting_status: "posted", updated_at: new Date().toISOString() })
        .eq("id", payment.id)
        .eq("organization_id", input.organizationId);

      await supabase
        .from("professional_claims")
        .update({ claim_status: insurancePayment > 0 || patientResponsibility > 0 ? "paid" : "denied", updated_at: new Date().toISOString() })
        .eq("id", payment.professional_claim_id)
        .eq("organization_id", input.organizationId);

      postedClaims += 1;
    } catch (error) {
      errors.push({
        field: payment.clp01_claim_control_number,
        message: error instanceof Error ? error.message : "Failed to post ERA claim payment",
      });
    }
  }

  await supabase
    .from("era_import_batches")
    .update({ import_status: errors.length > 0 ? "blocked" : "posted", updated_at: new Date().toISOString() })
    .eq("id", input.eraImportBatchId)
    .eq("organization_id", input.organizationId);

  return {
    ok: errors.length === 0,
    postedClaims,
    blockedClaims,
    patientInvoicesCreated,
    errors,
  };
}
