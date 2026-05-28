import crypto from "crypto";
import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import {
  requireAuthenticatedPaymentPoster,
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
} from "@/lib/payments/postingEngine";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

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
  return "Client payment posting failed";
}

function isMissingRelation(message: string) {
  const text = message.toLowerCase();
  return text.includes("does not exist") || text.includes("schema cache") || text.includes("client_payments") || text.includes("payment_applications");
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        {
          success: false,
          error: "SUPABASE_SERVICE_ROLE_KEY is required for client payment posting.",
        },
        { status: 503 },
      );
    }

    const body = (await request.json()) as {
      organizationId?: string;
      clientId?: string;
      claimId?: string;
      amount?: number | string;
      method?: string;
      reference?: string;
      note?: string;
    };

    const guard = await requireOrgAccess({
      requestedOrganizationId: body.organizationId,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    // Task #112 — POST_PAYMENTS gate. Clinicians lacking the permission
    // cannot post client payments via this legacy route.
    try {
      await requireAuthenticatedPaymentPoster(organizationId);
    } catch (err) {
      const status =
        err instanceof PaymentPostingUnauthenticatedError ? 401 : err instanceof PaymentPostingForbiddenError ? 403 : 403;
      return NextResponse.json(
        { success: false, error: err instanceof Error ? err.message : "Forbidden" },
        { status },
      );
    }

    const clientId = String(body.clientId ?? "").trim();
    const claimId = String(body.claimId ?? "").trim() || null;
    const amount = toAmount(body.amount);
    const method = String(body.method ?? "").trim();
    const allowedMethods = ["cash", "check", "credit_card", "debit_card", "other"];

    if (!clientId || !isUuid(clientId)) {
      return NextResponse.json({ success: false, error: "Valid clientId is required." }, { status: 400 });
    }

    if (amount <= 0) {
      return NextResponse.json({ success: false, error: "Payment amount must be greater than zero." }, { status: 400 });
    }

    if (!allowedMethods.includes(method)) {
      return NextResponse.json({ success: false, error: "Payment method is invalid." }, { status: 400 });
    }

    const now = new Date().toISOString();

    let claimRow: { id: string; client_id: string | null; patient_responsibility_amount: number | string | null; payer_responsibility_amount: number | string | null } | null = null;
    if (claimId) {
      const { data: claimData, error: claimError } = await supabase
        .from("claims")
        .select("id, client_id, patient_responsibility_amount, payer_responsibility_amount")
        .eq("organization_id", organizationId)
        .eq("id", claimId)
        .is("archived_at", null)
        .maybeSingle();

      if (claimError) throw claimError;
      if (!claimData) {
        return NextResponse.json({ success: false, error: "Claim not found." }, { status: 404 });
      }

      if (claimData.client_id && claimData.client_id !== clientId) {
        return NextResponse.json({ success: false, error: "Claim does not belong to the provided client/client." }, { status: 409 });
      }

      claimRow = claimData;
    }

    const paymentId = generateUuid();
    const { error: insertError } = await supabase
      .from("client_payments")
      .insert({
        id: paymentId,
        organization_id: organizationId,
        client_id: clientId,
        claim_id: claimId,
        payment_method: method,
        amount,
        reference_number: body.reference ?? null,
        note: body.note ?? null,
        posted_at: now,
        created_at: now,
        updated_at: now,
      });

    if (insertError) {
      if (isMissingRelation(insertError.message)) {
        return NextResponse.json(
          { success: false, error: "Run latest billing migrations before posting client payments." },
          { status: 409 },
        );
      }
      throw insertError;
    }

    let appliedAmount = 0;

    if (claimRow) {
      const patientRemaining = Math.max(0, toAmount(claimRow.patient_responsibility_amount));
      appliedAmount = Math.min(amount, patientRemaining > 0 ? patientRemaining : amount);

      if (appliedAmount > 0) {
        const { error: appError } = await supabase
          .from("payment_applications")
          .insert({
            id: generateUuid(),
            organization_id: organizationId,
            payment_kind: "client",
            payment_source_id: paymentId,
            client_id: clientId,
            claim_id: claimRow.id,
            applied_amount: appliedAmount,
            applied_at: now,
            created_at: now,
            updated_at: now,
          });

        if (appError && !isMissingRelation(appError.message)) throw appError;

        const nextPatientBalance = Math.max(0, patientRemaining - appliedAmount);
        const payerRemaining = Math.max(0, toAmount(claimRow.payer_responsibility_amount));
        const claimPatch: ClaimUpdate = {
          patient_responsibility_amount: nextPatientBalance,
          updated_at: now,
        };

        if (nextPatientBalance <= 0 && payerRemaining <= 0) {
          claimPatch.claim_status = "paid";
          claimPatch.paid_at = now;
        }

        const { error: claimUpdateError } = await supabase
          .from("claims")
          .update(claimPatch)
          .eq("id", claimRow.id)
          .eq("organization_id", organizationId)
          .is("archived_at", null);

        if (claimUpdateError) throw claimUpdateError;
      }
    }

    return NextResponse.json({
      success: true,
      paymentId,
      appliedAmount,
      unappliedAmount: Math.max(0, amount - appliedAmount),
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
