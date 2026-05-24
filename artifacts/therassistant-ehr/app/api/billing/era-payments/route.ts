import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type CasAdjustment = {
  groupCode?: string | null;
  reasonCode?: string | null;
  amount?: number | string | null;
  group_code?: string | null;
  reason_code?: string | null;
  description?: string | null;
};

type ServiceLine = {
  procedure_code?: string | null;
  charge?: number | string | null;
  allowed?: number | string | null;
  paid?: number | string | null;
  adjustment?: number | string | null;
  adjustment_code?: string | null;
};

type EraImportBatchRow = {
  id: string;
  payer_identifier: string | null;
  payer_name: string | null;
  parsed_summary: Record<string, unknown> | null;
  imported_at: string | null;
};

type ProfessionalClaimRow = {
  id: string;
  claim_number: string | null;
  claim_status: string | null;
  date_of_service_from: string | null;
  date_of_service_to: string | null;
  ready_to_submit_at: string | null;
  submitted_at: string | null;
  accepted_at: string | null;
  paid_at: string | null;
  denied_at: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
};

type LedgerRow = {
  era_claim_payment_id: string;
  entry_type: string;
  amount: number | string | null;
  group_code: string | null;
  reason_code: string | null;
  description: string | null;
  created_at: string | null;
};

type EraClaimPaymentRow = {
  id: string;
  organization_id: string;
  era_import_batch_id: string;
  professional_claim_id: string | null;
  client_id: string | null;
  clp01_claim_control_number: string;
  clp03_total_charge: number | string;
  clp04_payment_amount: number | string;
  clp05_patient_responsibility: number | string;
  payer_claim_control_number: string | null;
  claim_match_status: string;
  posting_status: string;
  cas_adjustments: CasAdjustment[] | null;
  service_lines: ServiceLine[] | null;
  created_at: string;
  updated_at: string;
};

function money(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function safeString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return String(value);
}

function escapeForOrPattern(value: string): string {
  // PostgREST `.or()` parses commas/parentheses as delimiters; strip them
  // from search input to avoid breaking the filter string.
  return value.replace(/[,()*]/g, " ").replace(/\s+/g, " ").trim();
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const payerProfileId = searchParams.get("payerProfileId");
    const searchRaw = searchParams.get("search");
    const dateFrom = searchParams.get("dateFrom");
    const dateTo = searchParams.get("dateTo");

    const limitParam = Number.parseInt(searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
    const offsetParam = Number.parseInt(searchParams.get("offset") ?? "", 10);
    const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

    // If filtering by payer, resolve the payer profile -> matching ERA batches.
    // `era_claim_payments` has no direct payer FK; payer is denormalized on
    // `era_import_batches` (payer_identifier + payer_name).
    let batchIdFilter: string[] | null = null;
    if (payerProfileId) {
      const { data: profile, error: profileError } = await supabase
        .from("payer_profiles")
        .select("id, payer_name, availity_payer_id")
        .eq("organization_id", organizationId)
        .eq("id", payerProfileId)
        .maybeSingle();
      if (profileError) {
        return NextResponse.json({ success: false, error: profileError.message }, { status: 500 });
      }
      if (!profile) {
        return NextResponse.json({
          success: true,
          organizationId,
          items: [],
          limit,
          offset,
          hasMore: false,
        });
      }

      const orParts: string[] = [];
      if (profile.availity_payer_id) {
        orParts.push(`payer_identifier.eq.${profile.availity_payer_id}`);
      }
      if (profile.payer_name) {
        orParts.push(`payer_name.ilike.${profile.payer_name}`);
      }
      let batchQuery = supabase
        .from("era_import_batches")
        .select("id")
        .eq("organization_id", organizationId)
        .is("archived_at", null);
      if (orParts.length) batchQuery = batchQuery.or(orParts.join(","));
      const { data: batchRows, error: batchErr } = await batchQuery;
      if (batchErr) {
        return NextResponse.json({ success: false, error: batchErr.message }, { status: 500 });
      }
      batchIdFilter = (batchRows ?? []).map((b) => b.id as string);
      if (batchIdFilter.length === 0) {
        return NextResponse.json({
          success: true,
          organizationId,
          items: [],
          limit,
          offset,
          hasMore: false,
        });
      }
    }

    let query = supabase
      .from("era_claim_payments")
      .select(
        "id, organization_id, era_import_batch_id, professional_claim_id, client_id, clp01_claim_control_number, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, payer_claim_control_number, claim_match_status, posting_status, cas_adjustments, service_lines, created_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null);

    if (batchIdFilter) query = query.in("era_import_batch_id", batchIdFilter);
    if (dateFrom) query = query.gte("created_at", dateFrom);
    if (dateTo) query = query.lte("created_at", dateTo);

    const searchClean = searchRaw ? escapeForOrPattern(searchRaw) : "";
    if (searchClean) {
      const pat = `%${searchClean}%`;
      query = query.or(
        [
          `clp01_claim_control_number.ilike.${pat}`,
          `payer_claim_control_number.ilike.${pat}`,
          `check_eft_number.ilike.${pat}`,
        ].join(","),
      );
    }

    const { data: payments, error } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const rows = (payments ?? []) as EraClaimPaymentRow[];
    const hasMore = rows.length === limit;

    const batchIds = Array.from(new Set(rows.map((r) => r.era_import_batch_id).filter(Boolean)));
    const claimIds = Array.from(new Set(rows.map((r) => r.professional_claim_id).filter((id): id is string => Boolean(id))));
    const clientIds = Array.from(new Set(rows.map((r) => r.client_id).filter((id): id is string => Boolean(id))));
    const paymentIds = rows.map((r) => r.id);

    const [batchesRes, claimsRes, clientsRes, ledgerRes] = await Promise.all([
      batchIds.length
        ? supabase
            .from("era_import_batches")
            .select("id, payer_identifier, payer_name, parsed_summary, imported_at")
            .in("id", batchIds)
        : Promise.resolve({ data: [] as EraImportBatchRow[], error: null }),
      claimIds.length
        ? supabase
            .from("professional_claims")
            .select(
              "id, claim_number, claim_status, date_of_service_from, date_of_service_to, ready_to_submit_at, submitted_at, accepted_at, paid_at, denied_at",
            )
            .in("id", claimIds)
        : Promise.resolve({ data: [] as ProfessionalClaimRow[], error: null }),
      clientIds.length
        ? supabase
            .from("clients")
            .select("id, first_name, last_name")
            .in("id", clientIds)
        : Promise.resolve({ data: [] as ClientRow[], error: null }),
      paymentIds.length
        ? supabase
            .from("era_posting_ledger_entries")
            .select("era_claim_payment_id, entry_type, amount, group_code, reason_code, description, created_at")
            .eq("organization_id", organizationId)
            .in("era_claim_payment_id", paymentIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as LedgerRow[], error: null }),
    ]);

    const batchesById = new Map<string, EraImportBatchRow>(
      ((batchesRes.data ?? []) as EraImportBatchRow[]).map((b) => [b.id, b]),
    );
    const claimsById = new Map<string, ProfessionalClaimRow>(
      ((claimsRes.data ?? []) as ProfessionalClaimRow[]).map((c) => [c.id, c]),
    );
    const clientsById = new Map<string, ClientRow>(
      ((clientsRes.data ?? []) as ClientRow[]).map((c) => [c.id, c]),
    );

    // era_import_batches carries its own `payer_name` denormalized from
    // N1*PR at import time; there is no FK to payer_profiles. The display
    // payer name therefore comes straight from the batch row (with a
    // parsed_summary.payer fallback), not from a payer_profiles join.

    const ledgerByPaymentId = new Map<string, LedgerRow[]>();
    for (const row of (ledgerRes.data ?? []) as LedgerRow[]) {
      const list = ledgerByPaymentId.get(row.era_claim_payment_id) ?? [];
      list.push(row);
      ledgerByPaymentId.set(row.era_claim_payment_id, list);
    }

    const items = rows.map((row) => {
      const batch = batchesById.get(row.era_import_batch_id) ?? null;
      const claim = row.professional_claim_id ? claimsById.get(row.professional_claim_id) ?? null : null;
      const client = row.client_id ? clientsById.get(row.client_id) ?? null : null;
      const parsedPayerName =
        batch?.payer_name ??
        (batch?.parsed_summary && typeof batch.parsed_summary === "object"
          ? safeString((batch.parsed_summary as Record<string, unknown>).payer)
          : null);
      const checkNumber =
        batch?.parsed_summary && typeof batch.parsed_summary === "object"
          ? safeString((batch.parsed_summary as Record<string, unknown>).check_number)
          : null;

      return {
        id: row.id,
        eraImportBatchId: row.era_import_batch_id,
        claimControlNumber: row.clp01_claim_control_number,
        payerClaimControlNumber: row.payer_claim_control_number,
        totalCharge: money(row.clp03_total_charge),
        paymentAmount: money(row.clp04_payment_amount),
        patientResponsibility: money(row.clp05_patient_responsibility),
        claimMatchStatus: row.claim_match_status,
        postingStatus: row.posting_status,
        casAdjustments: (row.cas_adjustments ?? []).map((adj) => ({
          groupCode: adj.groupCode ?? adj.group_code ?? null,
          reasonCode: adj.reasonCode ?? adj.reason_code ?? null,
          amount: money(adj.amount),
          description: adj.description ?? null,
        })),
        serviceLines: (row.service_lines ?? []).map((line) => ({
          procedureCode: line.procedure_code ?? null,
          charge: money(line.charge),
          allowed: money(line.allowed),
          paid: money(line.paid),
          adjustment: money(line.adjustment),
          adjustmentCode: line.adjustment_code ?? null,
        })),
        ledgerEntries: (ledgerByPaymentId.get(row.id) ?? []).map((entry) => ({
          entryType: entry.entry_type,
          amount: money(entry.amount),
          groupCode: entry.group_code,
          reasonCode: entry.reason_code,
          description: entry.description,
          postedAt: entry.created_at,
        })),
        professionalClaim: claim
          ? {
              id: claim.id,
              claimNumber: claim.claim_number,
              claimStatus: claim.claim_status,
              dateOfServiceFrom: claim.date_of_service_from,
              dateOfServiceTo: claim.date_of_service_to,
              readyToSubmitAt: claim.ready_to_submit_at,
              submittedAt: claim.submitted_at,
              acceptedAt: claim.accepted_at,
              paidAt: claim.paid_at,
              deniedAt: claim.denied_at,
            }
          : null,
        client: client
          ? {
              id: client.id,
              displayName:
                [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || "Unknown patient",
            }
          : null,
        payer: { id: null, name: parsedPayerName ?? "Unknown payer" },
        checkNumber,
        importedAt: batch?.imported_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    return NextResponse.json({
      success: true,
      organizationId,
      items,
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    });
  } catch (error) {
    console.error("ERA payments API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "ERA payments API failed" },
      { status: 500 },
    );
  }
}
