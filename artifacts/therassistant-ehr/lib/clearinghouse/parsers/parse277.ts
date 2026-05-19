// File: lib/clearinghouse/parsers/parse277.ts

import { parseX12Segments, splitComposite, normalizeX12Date, parseX12Money } from "./x12Segments";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export type Parsed277Line = {
  statusCategoryCode: string | null;
  statusCode: string | null;
  entityCode: string | null;
  effectiveDate: string | null;
  totalChargeAmount: number | null;
  paidAmount: number | null;
  checkEftNumber: string | null;
  payerClaimControlNumber: string | null;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  message: string | null;
  raw: Record<string, unknown>;
};

export function extract277Lines(rawX12: string): Parsed277Line[] {
  const segments = parseX12Segments(rawX12);
  const lines: Parsed277Line[] = [];

  let current: Parsed277Line | null = null;

  for (const seg of segments) {
    if (seg.id === "STC") {
      const composite = splitComposite(seg.elements[0]);

      current = {
        statusCategoryCode: composite[0] ?? null,
        statusCode: composite[1] ?? null,
        entityCode: composite[2] ?? null,
        effectiveDate: normalizeX12Date(seg.elements[1]),
        totalChargeAmount: parseX12Money(seg.elements[2]),
        paidAmount: parseX12Money(seg.elements[3]),
        checkEftNumber: null,
        payerClaimControlNumber: null,
        serviceDateFrom: null,
        serviceDateTo: null,
        message: null,
        raw: { stc: seg.raw },
      };

      lines.push(current);
      continue;
    }

    if (!current) continue;

    if (seg.id === "REF") {
      const qualifier = seg.elements[0];
      if (qualifier === "1K") {
        current.payerClaimControlNumber = seg.elements[1] ?? null;
      }
      if (qualifier === "F8") {
        current.checkEftNumber = seg.elements[1] ?? null;
      }
    }

    if (seg.id === "DTP") {
      const qualifier = seg.elements[0];
      if (qualifier === "472") {
        const date = normalizeX12Date(seg.elements[2]);
        current.serviceDateFrom = date;
        current.serviceDateTo = date;
      }
    }

    if (seg.id === "MSG") {
      current.message = seg.elements.join(" ");
    }
  }

  return lines;
}

export async function persist277Lines(params: {
  organizationId: string;
  claimStatusInquiryId: string;
  claimId: string;
  clientId: string;
  payerId?: string | null;
  payerName?: string | null;
  rawX12: string;
}) {
  const supabaseAdminClient = createServerSupabaseAdminClient();
  if (!supabaseAdminClient) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for parsing 277 responses.");
  }
  const supabase = supabaseAdminClient;

  const lines = extract277Lines(params.rawX12);

  if (!lines.length) {
    return { inserted: 0 };
  }

  const now = new Date().toISOString();

  const inserts = lines.map((line) => ({
    id: crypto.randomUUID(),
    organization_id: params.organizationId,
    claim_status_inquiry_id: params.claimStatusInquiryId,
    claim_id: params.claimId,
    client_id: params.clientId,
    payer_id: params.payerId ?? null,
    payer_name: params.payerName ?? null,
    status_category_code: line.statusCategoryCode,
    status_code: line.statusCode,
    entity_code: line.entityCode,
    status_effective_date: line.effectiveDate,
    total_charge_amount: line.totalChargeAmount,
    paid_amount: line.paidAmount,
    check_eft_number: line.checkEftNumber,
    payer_claim_control_number: line.payerClaimControlNumber,
    service_date_from: line.serviceDateFrom,
    service_date_to: line.serviceDateTo,
    message: line.message,
    raw_stc_segment: line.raw,
    created_at: now,
  }));

  const { error } = await supabase
    .from("claim_status_response_lines")
    .insert(inserts);

  if (error) throw error;

  const primary = lines[0];

  let summaryStatus = "unknown";
  if (primary?.statusCategoryCode === "A1") summaryStatus = "received";
  else if (primary?.statusCategoryCode === "A2" || primary?.statusCategoryCode === "A3") summaryStatus = "pending";
  else if (primary?.statusCategoryCode === "F2") summaryStatus = "denied";

  await supabase
    .from("claim_status_inquiries")
    .update({
      inquiry_status: summaryStatus,
      payer_status_code: primary?.statusCategoryCode ?? null,
      payer_status_text: primary?.message ?? null,
      updated_at: now,
    })
    .eq("id", params.claimStatusInquiryId);

  return { inserted: inserts.length };
}
