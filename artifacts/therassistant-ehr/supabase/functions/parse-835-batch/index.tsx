// @ts-expect-error - Deno edge runtime URL import is valid at runtime but not resolvable by this TS config.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-expect-error - Deno npm: specifier is valid at runtime but not resolvable by this TS config.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

type ParsedClaim835 = {
  claim_ref: string;
  payer_claim_control_number: string | null;
  claim_status_code: string | null;
  gross_amount: number;
  net_amount: number;
  patient_responsibility_amount: number;
  adjustment_amount: number;
  payment_date: string | null;
  check_or_eft_number: string | null;
  payer_name: string | null;
  payee_name: string | null;
  service_lines: Array<Record<string, unknown>>;
  adjustments: Array<Record<string, unknown>>;
  raw_segments: string[];
};

function money(value: string | undefined | null): number {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n : 0;
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseDateYYMMDD(value: string | null): string | null {
  if (!value || value.length !== 8) return null;
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  return `${year}-${month}-${day}`;
}

function detectSeparators(edi: string) {
  const segmentTerminator = edi.includes("~") ? "~" : "\n";
  const elementSeparator = edi.startsWith("ISA") && edi.length > 3 ? edi[3] : "*";
  return { segmentTerminator, elementSeparator };
}

function parse835(edi: string): {
  payment_date: string | null;
  check_or_eft_number: string | null;
  payer_name: string | null;
  payee_name: string | null;
  total_payment_amount: number;
  claims: ParsedClaim835[];
} {
  const { segmentTerminator, elementSeparator } = detectSeparators(edi);

  const segments = edi
    .split(segmentTerminator)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(elementSeparator));

  let paymentDate: string | null = null;
  let checkOrEftNumber: string | null = null;
  let payerName: string | null = null;
  let payeeName: string | null = null;
  let totalPaymentAmount = 0;

  const claims: ParsedClaim835[] = [];
  let currentClaim: ParsedClaim835 | null = null;

  for (const seg of segments) {
    const tag = seg[0];

    if (tag === "BPR") {
      totalPaymentAmount = money(seg[2]);
      paymentDate = parseDateYYMMDD(seg[16] ?? null);
    }

    if (tag === "TRN") {
      checkOrEftNumber = seg[2] ?? null;
    }

    if (tag === "N1" && seg[1] === "PR") {
      payerName = seg[2] ?? null;
    }

    if (tag === "N1" && seg[1] === "PE") {
      payeeName = seg[2] ?? null;
    }

    if (tag === "CLP") {
      if (currentClaim) claims.push(currentClaim);

      const claimRef = seg[1] ?? "";
      const gross = money(seg[3]);
      const net = money(seg[4]);
      const patientResponsibility = money(seg[5]);

      currentClaim = {
        claim_ref: claimRef,
        payer_claim_control_number: seg[7] ?? null,
        claim_status_code: seg[2] ?? null,
        gross_amount: gross,
        net_amount: net,
        patient_responsibility_amount: patientResponsibility,
        adjustment_amount: Math.max(0, gross - net - patientResponsibility),
        payment_date: paymentDate,
        check_or_eft_number: checkOrEftNumber,
        payer_name: payerName,
        payee_name: payeeName,
        service_lines: [],
        adjustments: [],
        raw_segments: [seg.join("*")],
      };

      continue;
    }

    if (currentClaim) {
      currentClaim.raw_segments.push(seg.join("*"));

      if (tag === "SVC") {
        currentClaim.service_lines.push({
          procedure_raw: seg[1] ?? null,
          charge_amount: money(seg[2]),
          paid_amount: money(seg[3]),
          units: money(seg[5] ?? "1"),
        });
      }

      if (tag === "CAS") {
        currentClaim.adjustments.push({
          group_code: seg[1] ?? null,
          reason_code_1: seg[2] ?? null,
          amount_1: money(seg[3]),
          reason_code_2: seg[5] ?? null,
          amount_2: money(seg[6]),
          raw: seg.join("*"),
        });
      }
    }
  }

  if (currentClaim) claims.push(currentClaim);

  return {
    payment_date: paymentDate,
    check_or_eft_number: checkOrEftNumber,
    payer_name: payerName,
    payee_name: payeeName,
    total_payment_amount: totalPaymentAmount,
    claims,
  };
}

serve(async (req: Request) => {
  try {
    const body = await req.json();

    const organizationId = body.organization_id;
    const batchId = body.batch_id;
    const storagePaths: string[] = body.storage_paths ?? [];

    if (!organizationId) {
      return Response.json({ error: "Missing organization_id" }, { status: 400 });
    }

    if (!batchId) {
      return Response.json({ error: "Missing batch_id" }, { status: 400 });
    }

    if (!Array.isArray(storagePaths) || storagePaths.length === 0) {
      return Response.json({ error: "Missing storage_paths[]" }, { status: 400 });
    }

    const result = {
      files_checked: 0,
      claims_imported: 0,
      claims_duplicate: 0,
      files_failed: 0,
      errors: [] as string[],
    };

    for (const storagePath of storagePaths) {
      result.files_checked += 1;

      try {
        const { data: fileData, error: downloadError } = await supabase.storage
          .from("payment-imports")
          .download(storagePath);

        if (downloadError || !fileData) {
          throw new Error(downloadError?.message ?? "Could not download file");
        }

        const rawEdi = await fileData.text();
        const fileHash = await sha256(rawEdi);
        const parsed = parse835(rawEdi);

        for (const [claimIndex, claim] of parsed.claims.entries()) {
          const importedItemRef =
            claim.claim_ref ||
            claim.payer_claim_control_number ||
            `${fileHash}-${result.claims_imported + 1}`;
          const itemFileHash = `${fileHash}:${importedItemRef || claimIndex + 1}`;

          const { data: matchedClaim } = await supabase
            .from("claims")
            .select("id, client_id")
            .eq("organization_id", organizationId)
            .or(
              `claim_number.eq.${importedItemRef},duplicate_detection_key.eq.${importedItemRef}`
            )
            .maybeSingle();

          const postingReady = Boolean(matchedClaim?.id && claim.net_amount > 0);
          const status = postingReady ? "ready_to_post" : "needs_review";

          const { data: item, error: itemError } = await supabase
            .from("payment_import_items")
            .upsert(
              {
                organization_id: organizationId,
                batch_id: batchId,
                payment_import_status: status,
                imported_item_ref: importedItemRef,
                payment_date: claim.payment_date,
                claim_id: matchedClaim?.id ?? null,
                client_id: matchedClaim?.client_id ?? null,
                gross_amount: claim.gross_amount,
                adjustment_amount: claim.adjustment_amount,
                net_amount: claim.net_amount,
                unapplied_amount: postingReady ? 0 : claim.net_amount,
                posting_ready: postingReady,
                raw_item_payload: claim,
                storage_bucket: "payment-imports",
                storage_path: storagePath,
                original_file_name: storagePath.split("/").pop() ?? storagePath,
                file_hash: itemFileHash,
                raw_edi: rawEdi,
                parsed_payload: parsed,
                parse_status: "parsed",
                parse_error: null,
                parsed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              {
                onConflict: "organization_id,file_hash,imported_item_ref",
              }
            )
            .select("id")
            .single();

          if (itemError) {
            if (itemError.message.includes("duplicate")) {
              result.claims_duplicate += 1;
              continue;
            }
            throw itemError;
          }

          result.claims_imported += 1;

          if (!postingReady && item?.id) {
            await supabase.from("workqueue_items").insert({
              organization_id: organizationId,
              source_object_type: "payment_import_item",
              source_object_id: item.id,
              priority: claim.net_amount === 0 ? "high" : "medium",
              status: "open",
              work_type: "payment_import_review",
              title: `Review 835 payment: ${importedItemRef}`,
              description:
                matchedClaim?.id
                  ? "835 payment imported but needs review before posting."
                  : "835 payment could not be matched to a claim.",
              context_payload: {
                source: "835",
                storage_path: storagePath,
                imported_item_ref: importedItemRef,
                payer_name: claim.payer_name,
                payee_name: claim.payee_name,
                gross_amount: claim.gross_amount,
                net_amount: claim.net_amount,
                adjustment_amount: claim.adjustment_amount,
                check_or_eft_number: claim.check_or_eft_number,
                claim_status_code: claim.claim_status_code,
                adjustment_codes: claim.adjustments,
              },
            });
          }
        }
      } catch (err) {
        result.files_failed += 1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result.errors.push(`${storagePath}: ${String((err as any)?.message ?? err)}`);
      }
    }

    const { data: totals } = await supabase
      .from("payment_import_items")
      .select("net_amount, payment_import_status")
      .eq("batch_id", batchId)
      .is("archived_at", null);

    const totalItemCount = totals?.length ?? 0;
    const totalAmount =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      totals?.reduce((sum: number, item: any) => sum + Number(item.net_amount ?? 0), 0) ?? 0;
    const parseErrorsCount = result.files_failed;

    await supabase
      .from("payment_import_batches")
      .update({
        payment_import_status:
          parseErrorsCount > 0
            ? "needs_review"
            : totalItemCount > 0
              ? "parsed"
              : "failed",
        total_item_count: totalItemCount,
        total_amount: totalAmount,
        parse_errors_count: parseErrorsCount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId);

    return Response.json(result);
  } catch (err) {
    return Response.json(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { error: String((err as any)?.message ?? err) },
      { status: 500 }
    );
  }
});