import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function money(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { data: batches, error: batchError } = await supabase
      .from("claim_837p_batches")
      .select("id, batch_number, batch_status, claim_count, total_charge_amount, generated_file_name, submitted_at, created_at, updated_at")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(100);

    if (batchError) throw batchError;

    const batchIds = (batches ?? []).map((batch: DbRow) => text(batch.id)).filter(Boolean);
    const { data: batchClaims } = batchIds.length
      ? await supabase
          .from("claim_837p_batch_claims")
          .select("batch_id, professional_claim_id")
          .eq("organization_id", organizationId)
          .in("batch_id", batchIds)
          .is("archived_at", null)
      : { data: [] as DbRow[] };

    const claimIds = [...new Set((batchClaims ?? []).map((row: DbRow) => text(row.professional_claim_id)).filter(Boolean))];
    const { data: claims } = claimIds.length
      ? await supabase
          .from("professional_claims")
          .select("id, patient_id, claim_number, claim_status, total_charge_amount, updated_at")
          .eq("organization_id", organizationId)
          .in("id", claimIds)
          .is("archived_at", null)
      : { data: [] as DbRow[] };

    const clientIds = [...new Set((claims ?? []).map((claim: DbRow) => text(claim.patient_id)).filter(Boolean))];
    const { data: clients } = clientIds.length
      ? await supabase.from("clients").select("id, first_name, last_name, date_of_birth").in("id", clientIds)
      : { data: [] as DbRow[] };

    const clientById = new Map<string, DbRow>((clients ?? []).map((client: DbRow) => [text(client.id), client]));
    const claimById = new Map<string, DbRow>((claims ?? []).map((claim: DbRow) => [text(claim.id), claim]));
    const claimsByBatchId = new Map<string, DbRow[]>();

    for (const row of batchClaims ?? []) {
      const batchId = text(row.batch_id);
      const claim = claimById.get(text(row.professional_claim_id));
      if (!claim) continue;
      const current = claimsByBatchId.get(batchId) ?? [];
      current.push(claim);
      claimsByBatchId.set(batchId, current);
    }

    const normalizedBatches = (batches ?? []).map((batch: DbRow) => {
      const batchId = text(batch.id);
      const claimRows = claimsByBatchId.get(batchId) ?? [];
      return {
        id: batchId,
        batchNumber: batch.batch_number,
        status: batch.batch_status,
        claimCount: Number(batch.claim_count ?? claimRows.length) || claimRows.length,
        totalChargeAmount: money(batch.total_charge_amount),
        generatedFileName: batch.generated_file_name,
        submittedAt: batch.submitted_at,
        createdAt: batch.created_at,
        updatedAt: batch.updated_at,
        claims: claimRows.map((claim) => {
          const client = clientById.get(text(claim.patient_id));
          const patientName = client ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") : "Unknown patient";
          return {
            id: text(claim.id),
            patientId: text(claim.patient_id),
            patientName,
            dateOfBirth: client?.date_of_birth ?? null,
            claimNumber: claim.claim_number,
            status: claim.claim_status,
            totalChargeAmount: money(claim.total_charge_amount),
            updatedAt: claim.updated_at,
          };
        }),
      };
    });

    const metrics = {
      total: normalizedBatches.length,
      readyToGenerate: normalizedBatches.filter((batch) => batch.status === "ready_to_generate").length,
      generated: normalizedBatches.filter((batch) => batch.status === "generated").length,
      submitted: normalizedBatches.filter((batch) => batch.status === "submitted").length,
      rejected: normalizedBatches.filter((batch) => batch.status === "rejected").length,
    };

    return NextResponse.json({ success: true, organizationId, metrics, batches: normalizedBatches });
  } catch (error) {
    console.error("837P batches API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "837P batches API failed" },
      { status: 500 },
    );
  }
}
