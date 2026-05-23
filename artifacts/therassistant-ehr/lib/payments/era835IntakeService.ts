import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { parseEra835, type Era835ClaimPayment } from "@/lib/payments/era835Parser";

export interface IntakeEra835Input {
  organizationId: string;
  rawContent: string;
  fileName?: string | null;
  source?: string | null;
}

export interface IntakeEra835Result {
  ok: boolean;
  batchId: string | null;
  totalClaims: number;
  matchedClaims: number;
  unmatchedClaims: number;
  errors: Array<{ field: string; message: string }>;
}

type ClaimMatch = {
  id: string;
  patient_id: string | null;
};

async function matchProfessionalClaim(organizationId: string, claimControlNumber: string): Promise<ClaimMatch | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("professional_claims")
    .select("id, patient_id")
    .eq("organization_id", organizationId)
    .or(`claim_number.eq.${claimControlNumber},patient_account_number.eq.${claimControlNumber}`)
    .limit(2);

  if (error) throw new Error(error.message);
  if (!data || data.length !== 1) return null;
  return data[0] as ClaimMatch;
}

function sumPatientResponsibility(claims: Era835ClaimPayment[]) {
  return claims.reduce((sum, claim) => sum + claim.clp05PatientResponsibility, 0);
}

export async function intakeEra835(input: IntakeEra835Input): Promise<IntakeEra835Result> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      batchId: null,
      totalClaims: 0,
      matchedClaims: 0,
      unmatchedClaims: 0,
      errors: [{ field: "system", message: "Database connection not available" }],
    };
  }

  if (!input.rawContent?.trim()) {
    return {
      ok: false,
      batchId: null,
      totalClaims: 0,
      matchedClaims: 0,
      unmatchedClaims: 0,
      errors: [{ field: "rawContent", message: "835 ERA content is required" }],
    };
  }

  const parsed = parseEra835(input.rawContent);

  // ── Duplicate-ERA detection (Task #107 foundation). ─────────────────────
  // Pre-check for a same-org batch with identical (payer, EFT#, payment date,
  // total amount). The DB has a partial unique index as a backstop, but
  // supabase-js cannot ON CONFLICT a partial index (see memory note), so we
  // must check explicitly.
  if (
    parsed.payerIdentifier &&
    parsed.traceNumber &&
    parsed.paymentDate &&
    parsed.paymentAmount > 0
  ) {
    const { data: existingDup } = await supabase
      .from("era_import_batches")
      .select("id, file_name, created_at")
      .eq("organization_id", input.organizationId)
      .eq("payer_identifier", parsed.payerIdentifier)
      .eq("eft_or_check_number", parsed.traceNumber)
      .eq("payment_date", parsed.paymentDate)
      .eq("total_payment_amount", parsed.paymentAmount)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();

    if (existingDup?.id) {
      return {
        ok: false,
        batchId: String(existingDup.id),
        totalClaims: parsed.claims.length,
        matchedClaims: 0,
        unmatchedClaims: parsed.claims.length,
        errors: [
          {
            field: "duplicate_era",
            message: `Duplicate ERA detected: an import batch with the same payer (${parsed.payerName ?? parsed.payerIdentifier}), EFT/check ${parsed.traceNumber}, payment date ${parsed.paymentDate}, and amount ${parsed.paymentAmount.toFixed(2)} already exists (batch ${String(existingDup.id).slice(0, 8)}).`,
          },
        ],
      };
    }
  }

  const { data: batch, error: batchError } = await supabase
    .from("era_import_batches")
    .insert({
      organization_id: input.organizationId,
      source: input.source ?? "manual_upload",
      file_name: input.fileName ?? undefined,
      raw_content: input.rawContent,
      parsed_summary: {
        transactionSetControlNumber: parsed.transactionSetControlNumber,
        paymentMethod: parsed.paymentMethod,
        traceNumber: parsed.traceNumber,
        segmentCount: parsed.segmentCount,
        paymentDate: parsed.paymentDate,
        payerName: parsed.payerName,
        payerIdentifier: parsed.payerIdentifier,
      },
      import_status: "parsed",
      total_claims: parsed.claims.length,
      total_payment_amount: parsed.paymentAmount,
      total_patient_responsibility: sumPatientResponsibility(parsed.claims),
      // Dedupe identity columns (Task #107).
      payer_identifier: parsed.payerIdentifier,
      payer_name: parsed.payerName,
      eft_or_check_number: parsed.traceNumber,
      payment_date: parsed.paymentDate,
      payment_method_code: parsed.paymentMethod,
    } as never)
    .select("id")
    .single();

  if (batchError || !batch) {
    return {
      ok: false,
      batchId: null,
      totalClaims: parsed.claims.length,
      matchedClaims: 0,
      unmatchedClaims: parsed.claims.length,
      errors: [{ field: "era_import_batches", message: batchError?.message ?? "Failed to create ERA import batch" }],
    };
  }

  const batchId = String(batch.id);
  let matchedClaims = 0;
  let unmatchedClaims = 0;
  const errors: Array<{ field: string; message: string }> = [];

  for (const claim of parsed.claims) {
    try {
      const match = await matchProfessionalClaim(input.organizationId, claim.clp01ClaimControlNumber);
      if (match) matchedClaims += 1;
      else unmatchedClaims += 1;

      const { error: claimPaymentError } = await supabase.from("era_claim_payments").insert({
        organization_id: input.organizationId,
        era_import_batch_id: batchId,
        professional_claim_id: match?.id ?? null,
        client_id: match?.patient_id ?? null,
        clp01_claim_control_number: claim.clp01ClaimControlNumber,
        clp02_claim_status_code: claim.clp02ClaimStatusCode,
        clp03_total_charge: claim.clp03TotalCharge,
        clp04_payment_amount: claim.clp04PaymentAmount,
        clp05_patient_responsibility: claim.clp05PatientResponsibility,
        payer_claim_control_number: claim.payerClaimControlNumber,
        claim_match_status: match ? "matched" : "unmatched",
        posting_status: match ? "ready" : "blocked",
        cas_adjustments: claim.casAdjustments,
        service_lines: claim.serviceLines,
        raw_segments: claim.rawSegments,
      });

      if (claimPaymentError) throw new Error(claimPaymentError.message);
    } catch (error) {
      errors.push({
        field: claim.clp01ClaimControlNumber,
        message: error instanceof Error ? error.message : "Failed to create ERA claim payment row",
      });
    }
  }

  const importStatus = errors.length > 0 ? "blocked" : unmatchedClaims > 0 ? "matched" : "matched";
  await supabase
    .from("era_import_batches")
    .update({ import_status: importStatus, updated_at: new Date().toISOString() })
    .eq("id", batchId)
    .eq("organization_id", input.organizationId);

  return {
    ok: errors.length === 0,
    batchId,
    totalClaims: parsed.claims.length,
    matchedClaims,
    unmatchedClaims,
    errors,
  };
}
