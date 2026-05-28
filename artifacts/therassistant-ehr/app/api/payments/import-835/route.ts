import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
// File: app/api/payments/import-835/route.ts
import { NextResponse } from "next/server";
import crypto from "crypto";
import { createServerSupabaseAdminClient as createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { parse835 } from "@/lib/clearinghouse/parsers/parse835";
import type { Json } from "@/lib/supabase/database.types";
import {
  requireAuthenticatedPaymentPoster,
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
} from "@/lib/payments/postingEngine";
import { UNIQUE_VIOLATION } from "@/lib/db/findOrCreate";

function generateUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "835 import failed";
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const submittedOrganizationId = String(formData.get("organizationId") ?? "").trim();

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "835 file is required" }, { status: 400 });
    }

    const supabase = createServerSupabaseServiceRoleClient();

    if (!supabase) {
      return NextResponse.json(
        {
          success: false,
          error:
            "SUPABASE_SERVICE_ROLE_KEY is required for 835 import writes. Add it to .env.local and restart dev server.",
        },
        { status: 503 },
      );
    }

    const guard = await requireOrgAccess({
      requestedOrganizationId: submittedOrganizationId || null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    // Task #112 — POST_PAYMENTS gate on 835 ingest.
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

    const raw835 = await file.text();

    if (!raw835.includes("ISA") || !raw835.includes("CLP")) {
      return NextResponse.json({ success: false, error: "File does not appear to be a valid 835 ERA" }, { status: 422 });
    }

    const parsed = parse835(raw835);
    const now = new Date().toISOString();
    const fileHash = crypto.createHash("sha256").update(raw835).digest("hex");

    const batchId = generateUuid();

    const { error: batchError } = await supabase
      .from("payment_import_batches")
      .insert({
        id: batchId,
        organization_id: organizationId,
        import_source: "835_era_upload",
        payment_import_status: "parsed",
        source_file_name: file.name,
        source_file_hash: fileHash,
        imported_at: now,
        total_item_count: parsed.claims.length,
        total_amount: parsed.totalPaymentAmount ?? 0,
        parse_errors_count: 0,
        created_at: now,
        updated_at: now,
      });

    if (batchError) throw batchError;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importedItems: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unmatchedClaims: any[] = [];

    let duplicateClaims = 0;

    for (const [claimIndex, claim] of parsed.claims.entries()) {
      const patientControlNumber = claim.patientControlNumber;

      let matchedClaim: { id: string; client_id: string | null } | null = null;

      if (patientControlNumber) {
        const { data: claimNumberMatch } = await supabase
          .from("claims")
          .select("id, client_id")
          .eq("organization_id", organizationId)
          .eq("claim_number", patientControlNumber)
          .limit(1)
          .maybeSingle();

        matchedClaim = claimNumberMatch;
      }

      if (!matchedClaim && patientControlNumber && isUuid(patientControlNumber)) {
        const { data: idMatch } = await supabase
          .from("claims")
          .select("id, client_id")
          .eq("organization_id", organizationId)
          .eq("id", patientControlNumber)
          .limit(1)
          .maybeSingle();

        matchedClaim = idMatch;
      }

      const itemId = generateUuid();

      const payload = {
        payer_name: claim.payerName,
        payee_name: claim.payeeName,
        payment_date: claim.paymentDate,
        claim_status_code: claim.claimStatusCode,
        total_charge_amount: claim.totalChargeAmount,
        paid_amount: claim.paidAmount,
        patient_responsibility_amount: claim.patientResponsibilityAmount,
        payer_claim_control_number: claim.payerClaimControlNumber,
        claim_filing_indicator_code: claim.claimFilingIndicatorCode,
        check_or_eft_number: claim.checkOrEftNumber,
        trace_number: claim.traceNumber,
        adjustments: claim.adjustments,
        service_lines: claim.serviceLines,
        raw_claim_payload: claim.raw,
      } as unknown as Json;

      const itemFileHash = `${fileHash}:${patientControlNumber || claim.payerClaimControlNumber || claim.traceNumber || claimIndex + 1}`;

      const itemRecord = {
        id: itemId,
        organization_id: organizationId,
        batch_id: batchId,
        payment_import_status: "parsed",
        imported_item_ref: patientControlNumber,
        payment_date: claim.paymentDate,
        payer_id: null,
        claim_id: matchedClaim?.id ?? null,
        client_id: matchedClaim?.client_id ?? null,
        service_line_ref: null,
        gross_amount: claim.totalChargeAmount ?? 0,
        adjustment_amount:
          claim.adjustments.reduce((sum, adj) => sum + Number(adj.amount ?? 0), 0),
        net_amount: claim.paidAmount ?? 0,
        unapplied_amount: matchedClaim ? 0 : claim.paidAmount ?? 0,
        posting_ready: Boolean(matchedClaim),
        raw_item_payload: payload,
        original_file_name: file.name,
        storage_bucket: null,
        storage_path: null,
        file_hash: itemFileHash,
        parse_status: "parsed",
        parse_error: null,
        parsed_at: now,
        match_status: matchedClaim ? "matched" : "unmatched",
        match_reason: matchedClaim
          ? "Matched by claim number or claim id"
          : "No claim matched from ERA import",
        matched_at: matchedClaim ? now : null,
        created_at: now,
        updated_at: now,
      };

      const { error: itemError } = await supabase
        .from("payment_import_items")
        .insert(itemRecord);

      if (itemError) {
        if ((itemError as { code?: string }).code === UNIQUE_VIOLATION) {
          duplicateClaims += 1;
          continue;
        }
        throw itemError;
      }

      importedItems.push(itemRecord);

      // Create workqueue item if payment is ready to post (matched)
      if (itemRecord.posting_ready) {
        const { error: queueError } = await supabase
          .from("workqueue_items")
          .insert({
            id: generateUuid(),
            organization_id: organizationId,
            source_object_type: "payment_import_item",
            source_object_id: itemId,
            work_type: "payment_posting_needed",
            status: "open",
            priority: "medium",
            title: `Post payment for ${patientControlNumber || "ERA claim"}`,
            description: `${claim.payerName ?? "Payer"} - $${Number(claim.paidAmount ?? 0).toFixed(2)}`,
            resolved_at: null,
            created_at: now,
            updated_at: now,
          });

        if (queueError) throw queueError;
      }

      if (!matchedClaim) {
        unmatchedClaims.push({
          imported_item_ref: patientControlNumber,
          payer_name: claim.payerName,
          paid_amount: claim.paidAmount,
        });
      }
    }

    return NextResponse.json({
      success: true,
      batchId,
      fileName: file.name,
      summary: {
        claimsFound: parsed.claims.length,
        matchedClaims: importedItems.filter((x) => x.claim_id).length,
        unmatchedClaims: unmatchedClaims.length,
        postingReady: importedItems.filter((x) => x.posting_ready).length,
        duplicateClaims,
        totalPaymentAmount: parsed.totalPaymentAmount,
        payerName: parsed.payerName,
        paymentDate: parsed.paymentDate,
      },
      unmatchedClaims,
    });
  } catch (error) {
    console.error("835 import failed", extractErrorMessage(error));

    return NextResponse.json(
      {
        success: false,
        error: extractErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
