import crypto from "crypto";
import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClientTyped } from "@/lib/supabase/server";
import type { Database } from "@/src/types/supabase";

type ClaimUpdate = Database["public"]["Tables"]["claims"]["Update"];

function generateUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function toAmount(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100) / 100;
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Insurance payment posting failed";
}

function isMissingRelation(message: string) {
  const text = message.toLowerCase();
  return text.includes("does not exist") || text.includes("schema cache") || text.includes("insurance_manual_payments") || text.includes("payment_applications");
}

async function resolveOrganizationId(
  supabase: NonNullable<ReturnType<typeof createServerSupabaseServiceRoleClientTyped>>,
  submittedOrganizationId?: string | null,
) {
  const submitted = String(submittedOrganizationId ?? "").trim();
  if (submitted && isUuid(submitted)) return submitted;

  const envOrganizationId = String(process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "").trim();
  if (envOrganizationId && isUuid(envOrganizationId)) return envOrganizationId;

  const { data, error } = await supabase
    .from("organizations")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  const resolvedId = data?.id;
  if (typeof resolvedId === "string" && isUuid(resolvedId)) return resolvedId;
  return null;
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseServiceRoleClientTyped();
    if (!supabase) {
      return NextResponse.json(
        {
          success: false,
          error: "SUPABASE_SERVICE_ROLE_KEY is required for insurance payment posting.",
        },
        { status: 503 },
      );
    }

    const body = (await request.json()) as {
      organizationId?: string;
      claimId?: string;
      allowedAmount?: number | string;
      paidAmount?: number | string;
      adjustmentAmount?: number | string;
      patientResponsibility?: number | string;
      eobReference?: string;
      note?: string;
    };

    const organizationId = await resolveOrganizationId(supabase, body.organizationId);
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "No organization found for payment posting." }, { status: 400 });
    }

    const claimId = String(body.claimId ?? "").trim();
    const allowedAmount = toAmount(body.allowedAmount);
    const paidAmount = toAmount(body.paidAmount);
    const adjustmentAmount = toAmount(body.adjustmentAmount);
    const patientResponsibility = toAmount(body.patientResponsibility);

    if (!claimId || !isUuid(claimId)) {
      return NextResponse.json({ success: false, error: "Valid claimId is required." }, { status: 400 });
    }

    if (allowedAmount < 0 || paidAmount < 0 || adjustmentAmount < 0 || patientResponsibility < 0) {
      return NextResponse.json({ success: false, error: "Amounts must be non-negative values." }, { status: 400 });
    }

    const { data: claimData, error: claimError } = await supabase
      .from("claims")
      .select("id, client_id, payer_responsibility_amount, patient_responsibility_amount")
      .eq("organization_id", organizationId)
      .eq("id", claimId)
      .is("archived_at", null)
      .maybeSingle();

    if (claimError) throw claimError;
    if (!claimData) {
      return NextResponse.json({ success: false, error: "Claim not found." }, { status: 404 });
    }

    if (!claimData.client_id) {
      return NextResponse.json({ success: false, error: "Claim is missing client linkage." }, { status: 422 });
    }

    const now = new Date().toISOString();
    const insurancePaymentId = generateUuid();

    const { error: insertError } = await supabase
      .from("insurance_manual_payments")
      .insert({
        id: insurancePaymentId,
        organization_id: organizationId,
        claim_id: claimData.id,
        client_id: claimData.client_id,
        eob_reference: body.eobReference ?? null,
        allowed_amount: allowedAmount,
        paid_amount: paidAmount,
        adjustment_amount: adjustmentAmount,
        patient_responsibility_amount: patientResponsibility,
        note: body.note ?? null,
        posted_at: now,
        created_at: now,
        updated_at: now,
      });

    if (insertError) {
      if (isMissingRelation(insertError.message)) {
        return NextResponse.json(
          { success: false, error: "Run latest billing migrations before posting insurance payments." },
          { status: 409 },
        );
      }
      throw insertError;
    }

    if (paidAmount > 0) {
      const { error: appError } = await supabase
        .from("payment_applications")
        .insert({
          id: generateUuid(),
          organization_id: organizationId,
          payment_kind: "insurance",
          payment_source_id: insurancePaymentId,
          client_id: claimData.client_id,
          claim_id: claimData.id,
          applied_amount: paidAmount,
          applied_at: now,
          created_at: now,
          updated_at: now,
        });

      if (appError && !isMissingRelation(appError.message)) throw appError;
    }

    const payerRemainingCurrent = Math.max(0, toAmount(claimData.payer_responsibility_amount));
    const nextPayerRemaining = Math.max(0, payerRemainingCurrent - paidAmount);
    const nextPatientRemaining = patientResponsibility;

    const claimPatch: ClaimUpdate = {
      payer_responsibility_amount: nextPayerRemaining,
      patient_responsibility_amount: nextPatientRemaining,
      updated_at: now,
    };

    if (nextPayerRemaining <= 0 && nextPatientRemaining <= 0) {
      claimPatch.claim_status = "paid";
      claimPatch.paid_at = now;
    }

    const { error: updateError } = await supabase
      .from("claims")
      .update(claimPatch)
      .eq("id", claimData.id)
      .eq("organization_id", organizationId)
      .is("archived_at", null);

    if (updateError) throw updateError;

    return NextResponse.json({
      success: true,
      insurancePaymentId,
      appliedAmount: paidAmount,
      remainingPayerBalance: nextPayerRemaining,
      remainingPatientBalance: nextPatientRemaining,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: extractErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
