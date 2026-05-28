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

// Tab → batch_status filter. "all" is no filter.
const TAB_STATUS: Record<string, string[]> = {
  all: [],
  draft: ["draft", "ready_to_generate"],
  ready: ["generated"],
  submitted: ["submitted", "accepted"],
  failed: ["rejected", "failed", "cancelled"],
  partial: ["partially_accepted"],
};

function classifyTab(status: string): string {
  const s = (status || "").toLowerCase();
  for (const [tab, list] of Object.entries(TAB_STATUS)) {
    if (tab === "all") continue;
    if (list.includes(s)) return tab;
  }
  return "draft";
}

function ageDays(iso: string): number {
  if (!iso) return 0;
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.floor((Date.now() - d) / (1000 * 60 * 60 * 24)));
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const tab = (searchParams.get("tab") || "all").toLowerCase();
    const fPayer = text(searchParams.get("payer"));
    const fClient = text(searchParams.get("client"));
    const fStatus = text(searchParams.get("status"));
    const fDosFrom = text(searchParams.get("dosFrom"));
    const fDosTo = text(searchParams.get("dosTo"));
    const fMinAmount = Number(searchParams.get("minAmount") || "");
    const fMaxAmount = Number(searchParams.get("maxAmount") || "");
    const fAgingBucket = text(searchParams.get("agingBucket"));
    const fPriority = text(searchParams.get("priority"));
    // Universal filter slots — accepted for URL persistence; applied best-effort
    // against joined claim/workqueue data. Slots without a meaningful batch-level
    // signal (practice, follow-up due) accept the param but do not filter.
    const fPractice = text(searchParams.get("practice")).toLowerCase();
    const fClinician = text(searchParams.get("clinician")).toLowerCase();
    const fAssignedBiller = text(searchParams.get("assignedBiller")).toLowerCase();
    const fCarcRarc = text(searchParams.get("carcRarc")).toUpperCase();
    const fFollowUpDue = text(searchParams.get("followUpDue"));

    let query = supabase
      .from("claim_837p_batches")
      .select(
        "id, batch_number, batch_status, claim_count, total_charge_amount, generated_file_name, submitted_at, created_at, updated_at, submission_error, last_submission_http_status",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(200);

    const tabStatuses = TAB_STATUS[tab] ?? [];
    if (tabStatuses.length > 0) query = query.in("batch_status", tabStatuses);
    if (fStatus) query = query.eq("batch_status", fStatus);

    const { data: batches, error: batchError } = await query;
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

    const claimIds = [
      ...new Set((batchClaims ?? []).map((row: DbRow) => text(row.professional_claim_id)).filter(Boolean)),
    ];
    const { data: claims } = claimIds.length
      ? await supabase
          .from("professional_claims")
          .select(
            "id, patient_id, client_id, claim_number, claim_status, total_charge, payer_profile_id, validation_errors, updated_at, rendering_provider_npi, rendering_provider_last_name_or_org, rendering_provider_first_name, billing_provider_name, billing_provider_npi",
          )
          .eq("organization_id", organizationId)
          .in("id", claimIds)
          .is("archived_at", null)
      : { data: [] as DbRow[] };

    const clientIds = [
      ...new Set((claims ?? []).map((c: DbRow) => text(c.patient_id) || text(c.client_id)).filter(Boolean)),
    ];
    const { data: clients } = clientIds.length
      ? await supabase.from("clients").select("id, first_name, last_name, date_of_birth").in("id", clientIds)
      : { data: [] as DbRow[] };

    const payerIds = [...new Set((claims ?? []).map((c: DbRow) => text(c.payer_profile_id)).filter(Boolean))];
    const { data: payers } = payerIds.length
      ? await supabase.from("payer_profiles").select("id, payer_name").in("id", payerIds)
      : { data: [] as DbRow[] };

    const clientById = new Map<string, DbRow>((clients ?? []).map((c: DbRow) => [text(c.id), c]));
    const payerNameById = new Map<string, string>(
      (payers ?? []).map((p: DbRow) => [text(p.id), text((p as { payer_name?: unknown }).payer_name) || "Payer"]),
    );
    const claimById = new Map<string, DbRow>((claims ?? []).map((c: DbRow) => [text(c.id), c]));
    const claimsByBatchId = new Map<string, DbRow[]>();
    for (const row of batchClaims ?? []) {
      const batchId = text(row.batch_id);
      const claim = claimById.get(text(row.professional_claim_id));
      if (!claim) continue;
      const current = claimsByBatchId.get(batchId) ?? [];
      current.push(claim);
      claimsByBatchId.set(batchId, current);
    }

    const normalizedBatches = (batches ?? [])
      .map((batch: DbRow) => {
        const batchId = text(batch.id);
        const claimRows = claimsByBatchId.get(batchId) ?? [];
        const status = text(batch.batch_status);

        const payerCounts = new Map<string, number>();
        let errorCount = 0;
        const claimsOut = claimRows.map((claim) => {
          const payerId = text(claim.payer_profile_id);
          if (payerId) payerCounts.set(payerId, (payerCounts.get(payerId) ?? 0) + 1);
          const ve = claim.validation_errors;
          if (Array.isArray(ve)) errorCount += ve.length;
          const client = clientById.get(text(claim.patient_id) || text(claim.client_id));
          const patientName = client
            ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ")
            : "Unknown client";
          return {
            id: text(claim.id),
            patientId: text(claim.patient_id) || text(claim.client_id),
            patientName,
            dateOfBirth: client?.date_of_birth ?? null,
            claimNumber: claim.claim_number,
            status: claim.claim_status,
            totalChargeAmount: money(claim.total_charge),
            payerId,
            payerName: payerId ? payerNameById.get(payerId) ?? "Payer" : "",
            updatedAt: claim.updated_at,
          };
        });
        if (text(batch.submission_error)) errorCount += 1;

        const payerMix = Array.from(payerCounts.entries())
          .map(([pid, count]) => ({ payerId: pid, payerName: payerNameById.get(pid) ?? "Payer", count }))
          .sort((a, b) => b.count - a.count);

        return {
          id: batchId,
          batchNumber: text(batch.batch_number) || batchId.slice(0, 8),
          status,
          tab: classifyTab(status),
          claimCount: Number(batch.claim_count ?? claimRows.length) || claimRows.length,
          totalChargeAmount: money(batch.total_charge_amount),
          generatedFileName: text(batch.generated_file_name),
          submittedAt: text(batch.submitted_at),
          createdAt: text(batch.created_at),
          updatedAt: text(batch.updated_at),
          submissionError: text(batch.submission_error),
          lastHttpStatus: batch.last_submission_http_status ?? null,
          ageDays: ageDays(text(batch.created_at)),
          createdBy: "—", // not tracked in schema yet
          clearinghouseStatus:
            status === "submitted" || status === "accepted"
              ? "Accepted"
              : status === "rejected" || status === "failed"
              ? "Rejected"
              : status === "partially_accepted"
              ? "Partial"
              : "Pending",
          errorCount,
          payerMix,
          claims: claimsOut,
        };
      })
      .filter((b) => {
        if (fPayer && !b.payerMix.some((p) => p.payerId === fPayer)) return false;
        if (fClient) {
          const needle = fClient.toLowerCase();
          if (!b.claims.some((c) => c.patientName.toLowerCase().includes(needle))) return false;
        }
        if (fDosFrom && b.createdAt && b.createdAt < fDosFrom) return false;
        if (fDosTo && b.createdAt && b.createdAt > `${fDosTo}T23:59:59`) return false;
        if (Number.isFinite(fMinAmount) && fMinAmount > 0 && b.totalChargeAmount < fMinAmount) return false;
        if (Number.isFinite(fMaxAmount) && fMaxAmount > 0 && b.totalChargeAmount > fMaxAmount) return false;
        if (fAgingBucket) {
          const a = b.ageDays;
          const ok =
            (fAgingBucket === "0-7" && a <= 7) ||
            (fAgingBucket === "8-30" && a >= 8 && a <= 30) ||
            (fAgingBucket === "31-60" && a >= 31 && a <= 60) ||
            (fAgingBucket === "61-90" && a >= 61 && a <= 90) ||
            (fAgingBucket === "90+" && a > 90);
          if (!ok) return false;
        }
        if (fPriority === "urgent" && b.ageDays < 14 && b.errorCount === 0) return false;
        if (fCarcRarc) {
          const hay = b.claims
            .map((c) => {
              const ve = (claimById.get(c.id) as { validation_errors?: unknown } | undefined)?.validation_errors;
              return typeof ve === "string" ? ve : JSON.stringify(ve ?? "");
            })
            .join(" ")
            .toUpperCase();
          if (!hay.includes(fCarcRarc)) return false;
        }
        if (fPractice || fClinician || fAssignedBiller) {
          const anyClaimMatches = b.claims.some((c) => {
            const raw = claimById.get(c.id) as Record<string, unknown> | undefined;
            if (!raw) return false;
            const billingName = text(raw.billing_provider_name).toLowerCase();
            const billingNpi = text(raw.billing_provider_npi).toLowerCase();
            const renderingName = [raw.rendering_provider_first_name, raw.rendering_provider_last_name_or_org]
              .map(text)
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            const renderingNpi = text(raw.rendering_provider_npi).toLowerCase();
            if (fPractice && !billingName.includes(fPractice)) return false;
            if (fClinician && !renderingName.includes(fClinician) && !renderingNpi.includes(fClinician)) return false;
            if (fAssignedBiller && !billingName.includes(fAssignedBiller) && !billingNpi.includes(fAssignedBiller)) return false;
            return true;
          });
          if (!anyClaimMatches) return false;
        }
        if (fFollowUpDue) {
          // Follow-up due interpreted as "batches created on or before this date
          // that are still awaiting clearinghouse closure". Generated/draft/failed
          // batches past their target date surface as follow-ups.
          const cutoff = `${fFollowUpDue}T23:59:59`;
          const openTabs = new Set(["draft", "ready", "failed"]);
          if (!openTabs.has(b.tab)) return false;
          if (b.createdAt && b.createdAt > cutoff) return false;
        }
        return true;
      });

    const totals = {
      count: normalizedBatches.length,
      totalCharges: Math.round(normalizedBatches.reduce((s, b) => s + b.totalChargeAmount, 0) * 100) / 100,
      oldestAgeDays: normalizedBatches.reduce((max, b) => Math.max(max, b.ageDays), 0),
      urgentCount: normalizedBatches.filter((b) => b.ageDays >= 14 || b.errorCount > 0).length,
    };

    // Per-tab counts run from the un-tab-filtered (status-only) set we have.
    // To keep one round-trip, run a second lightweight count grouped by status.
    const { data: countRows } = await supabase
      .from("claim_837p_batches")
      .select("batch_status")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .limit(2000);
    const tabCounts: Record<string, number> = { all: 0, draft: 0, ready: 0, submitted: 0, failed: 0, partial: 0 };
    for (const r of (countRows ?? []) as DbRow[]) {
      const t = classifyTab(text(r.batch_status));
      tabCounts[t] = (tabCounts[t] ?? 0) + 1;
      tabCounts.all += 1;
    }

    const payerOptions = Array.from(payerNameById.entries()).map(([id, label]) => ({ value: id, label }));

    return NextResponse.json({
      success: true,
      organizationId,
      tab,
      totals,
      tabCounts,
      payerOptions,
      batches: normalizedBatches,
    });
  } catch (error) {
    console.error("837P batches API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "837P batches API failed" },
      { status: 500 },
    );
  }
}
