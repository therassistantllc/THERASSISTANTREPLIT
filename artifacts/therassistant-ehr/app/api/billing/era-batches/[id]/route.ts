/**
 * GET /api/billing/era-batches/[id]?organizationId=…
 *
 * Returns one ERA batch fully hydrated for the poster workspace:
 *   - batch header (payer, EFT, payment date, method, totals)
 *   - all era_claim_payments rows for the batch (with PP-1 validation result)
 *   - each row's professional_claim + client (when matched)
 *   - per-row suggestions (deductible / coinsurance / contractual / denial / etc.)
 *   - payment_adjustments rows scoped to the batch
 *   - raw 835 content
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  requireAuthenticatedPaymentPoster,
  validateEra835Posting,
  type EraClaimPaymentRow,
} from "@/lib/payments/postingEngine";
import {
  generatePostingSuggestions,
  detectDuplicatePostingSuggestion,
} from "@/lib/payments/suggestionEngine";

type ProfessionalClaimRow = {
  id: string;
  claim_number: string | null;
  claim_status: string | null;
  date_of_service_from: string | null;
  date_of_service_to: string | null;
  total_charge: number | string | null;
  patient_id: string | null;
  payer_profile_id: string | null;
};

type ClientRow = { id: string; first_name: string | null; last_name: string | null };

type ClaimPaymentRow = {
  id: string;
  era_import_batch_id: string;
  professional_claim_id: string | null;
  client_id: string | null;
  clp01_claim_control_number: string;
  clp02_claim_status_code: string | null;
  clp03_total_charge: number | string;
  clp04_payment_amount: number | string;
  clp05_patient_responsibility: number | string;
  payer_claim_control_number: string | null;
  claim_match_status: string;
  posting_status: string;
  cas_adjustments: unknown;
  service_lines: unknown;
  raw_segments: unknown;
  created_at: string;
  updated_at: string;
};

type AdjustmentRow = {
  id: string;
  scope: string;
  adjustment_type: string;
  group_code: string | null;
  reason_code: string | null;
  reference_id: string | null;
  amount: number | string;
  description: string | null;
  source: string;
  posted_at: string | null;
  era_claim_payment_id: string | null;
  professional_claim_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

function n(v: unknown): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }
    if (!id) {
      return NextResponse.json({ success: false, error: "Batch id is required" }, { status: 400 });
    }
    await requireAuthenticatedPaymentPoster(organizationId);

    const { data: batch, error: batchErr } = await supabase
      .from("era_import_batches")
      .select(
        "id, source, file_name, raw_content, parsed_summary, import_status, total_claims, total_payment_amount, total_patient_responsibility, payer_identifier, payer_name, eft_or_check_number, payment_date, payment_method_code, imported_at, created_at, updated_at, archived_at",
      )
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
    if (batchErr) {
      return NextResponse.json({ success: false, error: batchErr.message }, { status: 500 });
    }
    if (!batch) {
      return NextResponse.json({ success: false, error: "Batch not found" }, { status: 404 });
    }

    const { data: rawClaimPayments, error: claimErr } = await supabase
      .from("era_claim_payments")
      .select(
        "id, era_import_batch_id, professional_claim_id, client_id, clp01_claim_control_number, clp02_claim_status_code, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, payer_claim_control_number, claim_match_status, posting_status, cas_adjustments, service_lines, raw_segments, created_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .eq("era_import_batch_id", id)
      .is("archived_at", null)
      .order("created_at", { ascending: true });
    if (claimErr) {
      return NextResponse.json({ success: false, error: claimErr.message }, { status: 500 });
    }
    const claimPayments = (rawClaimPayments ?? []) as ClaimPaymentRow[];

    const claimIds = Array.from(
      new Set(claimPayments.map((c) => c.professional_claim_id).filter((x): x is string => Boolean(x))),
    );
    const clientIds = Array.from(
      new Set(claimPayments.map((c) => c.client_id).filter((x): x is string => Boolean(x))),
    );

    const [claimsRes, clientsRes, adjustmentsRes] = await Promise.all([
      claimIds.length
        ? supabase
            .from("professional_claims")
            .select(
              "id, claim_number, claim_status, date_of_service_from, date_of_service_to, total_charge, patient_id, payer_profile_id",
            )
            .eq("organization_id", organizationId)
            .in("id", claimIds)
        : Promise.resolve({ data: [] as ProfessionalClaimRow[], error: null }),
      clientIds.length
        ? supabase
            .from("clients")
            .select("id, first_name, last_name")
            .eq("organization_id", organizationId)
            .in("id", clientIds)
        : Promise.resolve({ data: [] as ClientRow[], error: null }),
      supabase
        .from("payment_adjustments")
        .select(
          "id, scope, adjustment_type, group_code, reason_code, reference_id, amount, description, source, posted_at, era_claim_payment_id, professional_claim_id, metadata, created_at, updated_at",
        )
        .eq("organization_id", organizationId)
        .eq("era_import_batch_id", id)
        .is("archived_at", null)
        .order("created_at", { ascending: true }),
    ]);

    const claimsById = new Map<string, ProfessionalClaimRow>(
      ((claimsRes.data ?? []) as ProfessionalClaimRow[]).map((c) => [c.id, c]),
    );
    const clientsById = new Map<string, ClientRow>(
      ((clientsRes.data ?? []) as ClientRow[]).map((c) => [c.id, c]),
    );

    const hydrated = await Promise.all(
      claimPayments.map(async (row) => {
        const claim = row.professional_claim_id ? claimsById.get(row.professional_claim_id) ?? null : null;
        const client = row.client_id ? clientsById.get(row.client_id) ?? null : null;
        const cas = asArray<{ groupCode?: string; reasonCode?: string; amount?: number }>(
          row.cas_adjustments,
        );

        const validation = validateEra835Posting({
          id: row.id,
          professional_claim_id: row.professional_claim_id,
          client_id: row.client_id,
          clp01_claim_control_number: row.clp01_claim_control_number,
          clp03_total_charge: n(row.clp03_total_charge),
          clp04_payment_amount: n(row.clp04_payment_amount),
          clp05_patient_responsibility: n(row.clp05_patient_responsibility),
          cas_adjustments: cas,
          claim_match_status: row.claim_match_status,
          posting_status: row.posting_status,
        } as EraClaimPaymentRow);

        const suggestions = generatePostingSuggestions({
          clp02ClaimStatusCode: row.clp02_claim_status_code,
          clp03TotalCharge: n(row.clp03_total_charge),
          clp04PaymentAmount: n(row.clp04_payment_amount),
          clp05PatientResponsibility: n(row.clp05_patient_responsibility),
          casAdjustments: cas,
        });
        const dup = await detectDuplicatePostingSuggestion(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase as any,
          {
            organizationId,
            selfEraClaimPaymentId: row.id,
            payerClaimControlNumber: row.payer_claim_control_number,
          },
        );
        const allSuggestions = dup ? [...suggestions, dup] : suggestions;

        return {
          id: row.id,
          eraImportBatchId: row.era_import_batch_id,
          clp01ClaimControlNumber: row.clp01_claim_control_number,
          clp02ClaimStatusCode: row.clp02_claim_status_code,
          payerClaimControlNumber: row.payer_claim_control_number,
          totalCharge: n(row.clp03_total_charge),
          paymentAmount: n(row.clp04_payment_amount),
          patientResponsibility: n(row.clp05_patient_responsibility),
          claimMatchStatus: row.claim_match_status,
          postingStatus: row.posting_status,
          casAdjustments: cas.map((a) => ({
            groupCode: a.groupCode ?? null,
            reasonCode: a.reasonCode ?? null,
            amount: n(a.amount),
          })),
          serviceLines: asArray(row.service_lines),
          rawSegments: asArray<string>(row.raw_segments),
          professionalClaim: claim
            ? {
                id: claim.id,
                claimNumber: claim.claim_number,
                claimStatus: claim.claim_status,
                dateOfServiceFrom: claim.date_of_service_from,
                dateOfServiceTo: claim.date_of_service_to,
                totalCharge: n(claim.total_charge),
              }
            : null,
          client: client
            ? {
                id: client.id,
                displayName:
                  [client.first_name, client.last_name].filter(Boolean).join(" ").trim() ||
                  "Unknown client",
              }
            : null,
          validation,
          suggestions: allSuggestions,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
    );

    const adjustments = ((adjustmentsRes.data ?? []) as AdjustmentRow[]).map((a) => ({
      id: a.id,
      scope: a.scope,
      adjustmentType: a.adjustment_type,
      groupCode: a.group_code,
      reasonCode: a.reason_code,
      referenceId: a.reference_id,
      amount: n(a.amount),
      description: a.description,
      source: a.source,
      postedAt: a.posted_at,
      eraClaimPaymentId: a.era_claim_payment_id,
      professionalClaimId: a.professional_claim_id,
      metadata: a.metadata ?? {},
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    }));

    const totalApplied = hydrated
      .filter((h) => h.postingStatus === "posted")
      .reduce((s, h) => s + h.paymentAmount, 0);
    const totalAdjustments = hydrated.reduce(
      (s, h) => s + h.casAdjustments.reduce((ss, a) => ss + a.amount, 0),
      0,
    );

    const summary = {
      totalPaymentAmount: n(batch.total_payment_amount),
      totalAllocated: +totalApplied.toFixed(2),
      totalAdjustments: +totalAdjustments.toFixed(2),
      unallocated: +(n(batch.total_payment_amount) - totalApplied).toFixed(2),
      totalClaims: hydrated.length,
      matched: hydrated.filter((h) => h.claimMatchStatus === "matched").length,
      unmatched: hydrated.filter((h) => h.claimMatchStatus !== "matched").length,
      posted: hydrated.filter((h) => h.postingStatus === "posted").length,
      blocked: hydrated.filter((h) => h.postingStatus === "blocked").length,
    };

    return NextResponse.json({
      success: true,
      batch: {
        id: batch.id,
        source: batch.source,
        fileName: batch.file_name,
        importStatus: batch.import_status,
        payer: {
          identifier: batch.payer_identifier,
          name:
            batch.payer_name ??
            (batch.parsed_summary && typeof batch.parsed_summary === "object"
              ? ((batch.parsed_summary as Record<string, unknown>).payer as string) ?? null
              : null) ??
            "Unknown payer",
        },
        eftOrCheckNumber: batch.eft_or_check_number,
        paymentMethodCode: batch.payment_method_code,
        paymentDate: batch.payment_date,
        receivedAt: batch.imported_at,
        rawContent: batch.raw_content,
        parsedSummary: batch.parsed_summary,
        archivedAt: batch.archived_at,
        createdAt: batch.created_at,
        updatedAt: batch.updated_at,
        summary,
      },
      claimPayments: hydrated,
      adjustments,
    });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    if (error instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    console.error("ERA batch detail API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "ERA batch detail failed" },
      { status: 500 },
    );
  }
}
