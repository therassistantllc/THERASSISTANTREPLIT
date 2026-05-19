import { NextResponse } from "next/server";
import crypto from "crypto";
import { OfficeAllyJsonApiAdapter } from "@/lib/clearinghouse/adapters/OfficeAllyJsonApiAdapter";
import { parse835 } from "@/lib/clearinghouse/parsers/parse835";
import { createServerSupabaseServiceRoleClientTyped } from "@/lib/supabase/server";
import type { Json } from "@/src/types/supabase";
import type { Database } from "@/lib/supabase/database.types";

function generateUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const organizationId = String(body.organizationId ?? "").trim();

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    const supabase = createServerSupabaseServiceRoleClientTyped();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "SUPABASE_SERVICE_ROLE_KEY is required for ERA auto-posting." },
        { status: 503 },
      );
    }

    const adapter = new OfficeAllyJsonApiAdapter();
    const { raw835, fileName } = await adapter.fetchEra835({ organizationId });

    if (!raw835.includes("ISA") || !raw835.includes("CLP")) {
      return NextResponse.json(
        { success: false, error: "Office Ally ERA response does not appear to be a valid 835 file." },
        { status: 422 },
      );
    }

    const parsed = parse835(raw835);
    const now = new Date().toISOString();
    const fileHash = crypto.createHash("sha256").update(raw835).digest("hex");

    // Guard against duplicate ingestion of the same ERA file
    const { data: existingBatch } = await supabase
      .from("payment_import_batches")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("source_file_hash", fileHash)
      .limit(1)
      .maybeSingle();

    if (existingBatch) {
      return NextResponse.json({ success: false, error: "This ERA file has already been imported.", batchId: existingBatch.id }, { status: 409 });
    }

    const batchId = generateUuid();

    const { error: batchError } = await supabase.from("payment_import_batches").insert({
      id: batchId,
      organization_id: organizationId,
      import_source: "835_era_office_ally",
      payment_import_status: "parsed" as Database["public"]["Enums"]["payment_import_status"],
      source_file_name: fileName,
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

    for (const claim of parsed.claims) {
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

      const adjustmentTotal = claim.adjustments.reduce((sum, adj) => sum + Number(adj.amount ?? 0), 0);

      const itemRecord = {
        id: itemId,
        organization_id: organizationId,
        batch_id: batchId,
        payment_import_status: "parsed" as Database["public"]["Enums"]["payment_import_status"],
        imported_item_ref: patientControlNumber,
        payment_date: claim.paymentDate,
        payer_id: null,
        claim_id: matchedClaim?.id ?? null,
        client_id: matchedClaim?.client_id ?? null,
        service_line_ref: null,
        gross_amount: claim.totalChargeAmount ?? 0,
        adjustment_amount: adjustmentTotal,
        net_amount: claim.paidAmount ?? 0,
        unapplied_amount: matchedClaim ? 0 : (claim.paidAmount ?? 0),
        posting_ready: Boolean(matchedClaim),
        raw_item_payload: payload,
        original_file_name: fileName,
        storage_bucket: null,
        storage_path: null,
        file_hash: fileHash,
        parse_status: "parsed",
        parse_error: null,
        parsed_at: now,
        match_status: matchedClaim ? "matched" : "unmatched",
        match_reason: matchedClaim
          ? "Matched by claim number or claim id"
          : "No claim matched from ERA auto-ingest",
        matched_at: matchedClaim ? now : null,
        created_at: now,
        updated_at: now,
      };

      const { error: itemError } = await supabase.from("payment_import_items").insert(itemRecord);
      if (itemError) throw itemError;

      importedItems.push(itemRecord);

      if (itemRecord.posting_ready) {
        const { error: queueError } = await supabase.from("workqueue_items").insert({
          id: generateUuid(),
          organization_id: organizationId,
          source_object_type: "payment_import_item",
          source_object_id: itemId,
          work_type: "payment_posting_needed",
          status: "open",
          priority: "normal",
          title: `Post ERA payment for ${patientControlNumber || "ERA claim"}`,
          description: `${claim.payerName ?? "Payer"} - $${Number(claim.paidAmount ?? 0).toFixed(2)} (auto-ingested from Office Ally)`,
          resolved_at: null,
          created_at: now,
          updated_at: now,
        });
        if (queueError) throw queueError;
      } else {
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
      fileName,
      summary: {
        claimsFound: parsed.claims.length,
        matchedClaims: importedItems.filter((x) => x.claim_id).length,
        unmatchedClaims: unmatchedClaims.length,
        postingReady: importedItems.filter((x) => x.posting_ready).length,
        totalPaymentAmount: parsed.totalPaymentAmount,
        payerName: parsed.payerName,
        paymentDate: parsed.paymentDate,
      },
      unmatchedClaims,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ERA ingest failed";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
