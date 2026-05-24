/**
 * GET /api/billing/era-batches?organizationId=…
 *
 * Returns the ERA queue: one row per 835 import batch with aggregate counts
 * of matched / unmatched / blocked / posted / denial / recoupment children.
 *
 * Task #108 — primary feed for /billing/payments/era.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";

type ParsedSummary = Record<string, unknown> | null;

type BatchRow = {
  id: string;
  organization_id: string;
  source: string;
  file_name: string | null;
  import_status: string;
  total_claims: number;
  total_payment_amount: number | string;
  total_patient_responsibility: number | string;
  payer_identifier: string | null;
  payer_name: string | null;
  eft_or_check_number: string | null;
  payment_date: string | null;
  payment_method_code: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  parsed_summary: ParsedSummary;
};

type ChildRow = {
  era_import_batch_id: string;
  claim_match_status: string;
  posting_status: string;
  clp02_claim_status_code: string | null;
  clp04_payment_amount: number | string;
  professional_claim_id: string | null;
  client_id: string | null;
};

type ClaimRow = {
  id: string;
  place_of_service: string | null;
  date_of_service_from: string | null;
  date_of_service_to: string | null;
};

type PartySnapshotRow = {
  claim_id: string;
  rendering_provider_last_name_or_org: string | null;
  rendering_provider_first_name: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
};

function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function asNumber(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function readString(parsed: ParsedSummary, key: string): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const v = (parsed as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }
    await requireAuthenticatedPaymentPoster(organizationId);
    const includeArchivedParam = searchParams.get("includeArchived");
    const includeArchived = includeArchivedParam === "1" || includeArchivedParam === "true";

    let batchQuery = supabase
      .from("era_import_batches")
      .select(
        "id, organization_id, source, file_name, import_status, total_claims, total_payment_amount, total_patient_responsibility, payer_identifier, payer_name, eft_or_check_number, payment_date, payment_method_code, imported_at, created_at, updated_at, archived_at, parsed_summary",
      )
      .eq("organization_id", organizationId)
      .order("imported_at", { ascending: false })
      .limit(200);
    if (!includeArchived) {
      batchQuery = batchQuery.is("archived_at", null);
    }
    const { data: batches, error } = await batchQuery;

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const rows = (batches ?? []) as BatchRow[];
    const batchIds = rows.map((r) => r.id);

    const childMap = new Map<
      string,
      {
        total: number;
        matched: number;
        unmatched: number;
        blocked: number;
        posted: number;
        denied: number;
        recoupment: number;
        totalApplied: number;
      }
    >();
    // Per-batch enrichment maps for the universal filter rail (patient,
    // clinician, practice/POS, DOS-from, DOS-to). Populated below alongside
    // the child rollup so the list payload contains everything the UI needs.
    const patientsByBatch = new Map<string, Set<string>>();
    const cliniciansByBatch = new Map<string, Set<string>>();
    const practicesByBatch = new Map<string, Set<string>>();
    const dosFromByBatch = new Map<string, string | null>();
    const dosToByBatch = new Map<string, string | null>();
    const childRows: ChildRow[] = [];
    if (batchIds.length > 0) {
      const { data: children } = await supabase
        .from("era_claim_payments")
        .select(
          "era_import_batch_id, claim_match_status, posting_status, clp02_claim_status_code, clp04_payment_amount, professional_claim_id, client_id",
        )
        .eq("organization_id", organizationId)
        .in("era_import_batch_id", batchIds)
        .is("archived_at", null);
      childRows.push(...((children ?? []) as ChildRow[]));
      for (const child of childRows) {
        const bucket = childMap.get(child.era_import_batch_id) ?? {
          total: 0,
          matched: 0,
          unmatched: 0,
          blocked: 0,
          posted: 0,
          denied: 0,
          recoupment: 0,
          totalApplied: 0,
        };
        bucket.total += 1;
        if (child.claim_match_status === "matched") bucket.matched += 1;
        else bucket.unmatched += 1;
        if (child.posting_status === "blocked") bucket.blocked += 1;
        if (child.posting_status === "posted") {
          bucket.posted += 1;
          bucket.totalApplied += asNumber(child.clp04_payment_amount);
        }
        if (child.clp02_claim_status_code === "4") bucket.denied += 1;
        if (asNumber(child.clp04_payment_amount) < 0) bucket.recoupment += 1;
        childMap.set(child.era_import_batch_id, bucket);
      }

      const claimIds = Array.from(
        new Set(childRows.map((c) => c.professional_claim_id).filter((id): id is string => !!id)),
      );
      const clientIds = Array.from(
        new Set(childRows.map((c) => c.client_id).filter((id): id is string => !!id)),
      );

      const [claimsRes, partiesRes, clientsRes] = await Promise.all([
        claimIds.length
          ? supabase
              .from("professional_claims")
              .select("id, place_of_service, date_of_service_from, date_of_service_to")
              .in("id", claimIds)
              .eq("organization_id", organizationId)
          : Promise.resolve({ data: [] as ClaimRow[], error: null }),
        claimIds.length
          ? supabase
              .from("claim_parties_snapshot")
              .select("claim_id, rendering_provider_last_name_or_org, rendering_provider_first_name")
              .in("claim_id", claimIds)
          : Promise.resolve({ data: [] as PartySnapshotRow[], error: null }),
        clientIds.length
          ? supabase
              .from("clients")
              .select("id, first_name, last_name")
              .in("id", clientIds)
              .eq("organization_id", organizationId)
          : Promise.resolve({ data: [] as ClientRow[], error: null }),
      ]);

      const claimsById = new Map<string, ClaimRow>(
        ((claimsRes.data ?? []) as ClaimRow[]).map((r) => [r.id, r]),
      );
      const partiesByClaim = new Map<string, PartySnapshotRow>(
        ((partiesRes.data ?? []) as PartySnapshotRow[]).map((r) => [r.claim_id, r]),
      );
      const clientsById = new Map<string, ClientRow>(
        ((clientsRes.data ?? []) as ClientRow[]).map((r) => [r.id, r]),
      );

      for (const child of childRows) {
        const batchKey = child.era_import_batch_id;
        const client = child.client_id ? clientsById.get(child.client_id) ?? null : null;
        if (client) {
          const name = [client.first_name, client.last_name].filter(Boolean).join(" ").trim();
          if (name) {
            if (!patientsByBatch.has(batchKey)) patientsByBatch.set(batchKey, new Set());
            patientsByBatch.get(batchKey)!.add(name);
          }
        }
        if (child.professional_claim_id) {
          const claim = claimsById.get(child.professional_claim_id);
          if (claim) {
            if (claim.place_of_service) {
              if (!practicesByBatch.has(batchKey)) practicesByBatch.set(batchKey, new Set());
              practicesByBatch.get(batchKey)!.add(claim.place_of_service);
            }
            dosFromByBatch.set(batchKey, minDate(dosFromByBatch.get(batchKey) ?? null, claim.date_of_service_from));
            dosToByBatch.set(batchKey, maxDate(dosToByBatch.get(batchKey) ?? null, claim.date_of_service_to));
          }
          const party = partiesByClaim.get(child.professional_claim_id);
          if (party) {
            const name = [party.rendering_provider_first_name, party.rendering_provider_last_name_or_org]
              .filter(Boolean)
              .join(" ")
              .trim();
            if (name) {
              if (!cliniciansByBatch.has(batchKey)) cliniciansByBatch.set(batchKey, new Set());
              cliniciansByBatch.get(batchKey)!.add(name);
            }
          }
        }
      }
    }

    const items = rows.map((row) => {
      const agg = childMap.get(row.id) ?? {
        total: row.total_claims ?? 0,
        matched: 0,
        unmatched: 0,
        blocked: 0,
        posted: 0,
        denied: 0,
        recoupment: 0,
        totalApplied: 0,
      };
      const totalPayment = asNumber(row.total_payment_amount);
      const totalApplied = +agg.totalApplied.toFixed(2);
      const unallocated = +(totalPayment - totalApplied).toFixed(2);
      const deferred =
        row.parsed_summary && typeof row.parsed_summary === "object"
          ? Boolean((row.parsed_summary as Record<string, unknown>).deferred)
          : false;
      const markedDuplicateOf = readString(row.parsed_summary, "marked_duplicate_of");
      const assignedBiller = readString(row.parsed_summary, "assigned_biller_name");
      return {
        id: row.id,
        source: row.source,
        fileName: row.file_name,
        importStatus: row.import_status,
        payer: {
          identifier: row.payer_identifier,
          name: row.payer_name ?? readString(row.parsed_summary, "payer") ?? "Unknown payer",
        },
        eftOrCheckNumber: row.eft_or_check_number,
        paymentMethodCode: row.payment_method_code,
        paymentDate: row.payment_date,
        receivedAt: row.imported_at,
        totalPaymentAmount: totalPayment,
        totalPatientResponsibility: asNumber(row.total_patient_responsibility),
        totalAllocated: totalApplied,
        unallocated,
        counts: {
          total: agg.total,
          matched: agg.matched,
          unmatched: agg.unmatched,
          blocked: agg.blocked,
          posted: agg.posted,
          denied: agg.denied,
          recoupment: agg.recoupment,
        },
        archivedAt: row.archived_at,
        deferred,
        markedDuplicateOf,
        assignedBiller,
        patients: Array.from(patientsByBatch.get(row.id) ?? []),
        clinicians: Array.from(cliniciansByBatch.get(row.id) ?? []),
        practices: Array.from(practicesByBatch.get(row.id) ?? []),
        dosFrom: dosFromByBatch.get(row.id) ?? null,
        dosTo: dosToByBatch.get(row.id) ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    return NextResponse.json({ success: true, organizationId, items });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    if (error instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    console.error("ERA batches API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "ERA batches API failed" },
      { status: 500 },
    );
  }
}
