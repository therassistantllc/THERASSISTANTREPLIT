import { NextResponse } from "next/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { getProviderIdForUser } from "@/lib/rbac/auth";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { rebuild837PBatchFile } from "@/lib/claims/rebuild837PBatchFile";

type DbRow = Record<string, unknown>;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function money(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function isClinicianScoped(roles: string[]) {
  const hasClinician = roles.includes("clinician");
  const hasExpandedAccess = roles.some((r) => ["admin", "biller", "supervisor", "support"].includes(r));
  return hasClinician && !hasExpandedAccess;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null) {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim()) return maybeMessage;
  }
  return "Failed to load charge batches";
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const practiceFilter = text(searchParams.get("practice"));
    const clinicianOnly = isClinicianScoped(guard.roles ?? []);
    const providerId = clinicianOnly && guard.userId ? await getProviderIdForUser(guard.userId, guard.organizationId) : null;

    const primarySelect =
      "id, batch_number, batch_status, claim_count, total_charge_amount, generated_file_name, submitted_at, created_at, updated_at, payer_profile_id, billing_provider_tax_id";
    const fallbackSelect =
      "id, batch_number, batch_status, claim_count, total_charge_amount, generated_file_name, submitted_at, created_at, updated_at";

    const fetchBatches = async (applySourceFilter: boolean, selectClause: string) => {
      let query = supabase
        .from("claim_837p_batches")
        .select(selectClause)
        .eq("organization_id", guard.organizationId)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(250);

      if (applySourceFilter) {
        query = query.eq("batch_source", "charge_auto");
      }

      return query;
    };

    let { data: batchRows, error: batchError } = await fetchBatches(true, primarySelect);

    const isMissingColumnError = (err: unknown) =>
      String((err as { code?: string })?.code ?? "") === "42703"
      || String((err as { message?: string })?.message ?? "").toLowerCase().includes("does not exist");

    if (batchError && isMissingColumnError(batchError)) {
      // Backward-compatible fallback for environments that predate batch_source and newer batch columns.
      const fallback = await fetchBatches(false, fallbackSelect);
      batchRows = fallback.data;
      batchError = fallback.error;
    }
    if (batchError) throw batchError;

    const batches = (batchRows ?? []) as unknown as DbRow[];
    if (batches.length === 0) {
      return NextResponse.json({
        success: true,
        clinicianOnly,
        canManage: !clinicianOnly,
        practiceOptions: [] as Array<{ value: string; label: string }>,
        batches: [] as unknown[],
      });
    }

    const batchIds = batches.map((b) => text(b.id)).filter(Boolean);

    const { data: linkRows, error: linkError } = await supabase
      .from("claim_837p_batch_claims")
      .select("batch_id, professional_claim_id")
      .eq("organization_id", guard.organizationId)
      .in("batch_id", batchIds)
      .is("archived_at", null);
    if (linkError) throw linkError;

    const claimIds = [...new Set(((linkRows ?? []) as DbRow[]).map((r) => text(r.professional_claim_id)).filter(Boolean))];

    const { data: claimRows } = claimIds.length
        ? await supabase
          .from("professional_claims")
        .select("id, claim_number, claim_status, total_charge, payer_profile_id, appointment_id, patient_id, client_id")
          .eq("organization_id", guard.organizationId)
          .in("id", claimIds)
          .is("archived_at", null)
      : { data: [] as DbRow[] };

    const claims = (claimRows ?? []) as DbRow[];
    const appointmentIds = [...new Set(claims.map((c) => text(c.appointment_id)).filter(Boolean))];
    const clientIds = [...new Set(claims.map((c) => text(c.patient_id) || text(c.client_id)).filter(Boolean))];

    const { data: appointmentRows } = appointmentIds.length
        ? await supabase
          .from("appointments")
          .select("id, provider_id, provider_location_id")
          .eq("organization_id", guard.organizationId)
          .in("id", appointmentIds)
      : { data: [] as DbRow[] };

    const providerIds = [...new Set(((appointmentRows ?? []) as DbRow[]).map((a) => text(a.provider_id)).filter(Boolean))];

    const { data: providerRows } = providerIds.length
      ? await supabase
          .from("providers")
          .select("id, first_name, last_name, display_name")
          .eq("organization_id", guard.organizationId)
          .in("id", providerIds)
      : { data: [] as DbRow[] };

    const { data: clientRows } = clientIds.length
      ? await supabase
          .from("clients")
          .select("id, first_name, last_name")
          .eq("organization_id", guard.organizationId)
          .in("id", clientIds)
      : { data: [] as DbRow[] };

    const { data: serviceLineRows } = claimIds.length
      ? await supabase
          .from("professional_claim_service_lines")
          .select("id, claim_id, line_number, service_date_from, procedure_code, charge_amount")
          .eq("organization_id", guard.organizationId)
          .in("claim_id", claimIds)
          .is("archived_at", null)
      : { data: [] as DbRow[] };

    const { data: payerRows } = await supabase
      .from("payer_profiles")
      .select("id, payer_name")
      .eq("organization_id", guard.organizationId)
      .is("archived_at", null);

    const claimById = new Map<string, DbRow>(claims.map((c) => [text(c.id), c]));
    const appointmentById = new Map<string, DbRow>(((appointmentRows ?? []) as DbRow[]).map((a) => [text(a.id), a]));
    const providerById = new Map<string, DbRow>(((providerRows ?? []) as DbRow[]).map((p) => [text(p.id), p]));
    const clientById = new Map<string, DbRow>(((clientRows ?? []) as DbRow[]).map((c) => [text(c.id), c]));
    const payerNameById = new Map<string, string>(((payerRows ?? []) as DbRow[]).map((p) => [text(p.id), text(p.payer_name) || "Payer"]));
    const serviceLinesByClaimId = new Map<string, DbRow[]>();

    for (const line of (serviceLineRows ?? []) as DbRow[]) {
      const claimId = text(line.claim_id);
      if (!claimId) continue;
      const group = serviceLinesByClaimId.get(claimId) ?? [];
      group.push(line);
      serviceLinesByClaimId.set(claimId, group);
    }

    const practiceSet = new Set<string>();

    const claimsByBatch = new Map<string, Array<{
      id: string;
      claimNumber: string;
      status: string;
      totalCharge: number;
      practiceId: string | null;
      patientName: string;
      providerName: string;
      serviceLines: Array<{
        id: string;
        lineNumber: number;
        dateOfService: string | null;
        procedureCode: string;
        chargeAmount: number;
      }>;
    }>>();

    for (const link of (linkRows ?? []) as DbRow[]) {
      const batchId = text(link.batch_id);
      const claim = claimById.get(text(link.professional_claim_id));
      if (!claim) continue;
      const appt = appointmentById.get(text(claim.appointment_id));
      const claimProviderId = text(appt?.provider_id);
      const practiceId = text(appt?.provider_location_id) || null;
      const provider = providerById.get(claimProviderId);
      const providerName =
        text(provider?.display_name)
        || [text(provider?.first_name), text(provider?.last_name)].filter(Boolean).join(" ")
        || "—";

      const client = clientById.get(text(claim.patient_id) || text(claim.client_id));
      const patientName = client
        ? [text(client.first_name), text(client.last_name)].filter(Boolean).join(" ") || "Unknown Client"
        : "Unknown Client";

      const serviceLines = (serviceLinesByClaimId.get(text(claim.id)) ?? [])
        .map((line) => ({
          id: text(line.id) || `${text(claim.id)}-${text(line.line_number) || "1"}`,
          lineNumber: Number(line.line_number ?? 0) || 0,
          dateOfService: text(line.service_date_from) || null,
          procedureCode: text(line.procedure_code) || "—",
          chargeAmount: money(line.charge_amount),
        }))
        .sort((a, b) => a.lineNumber - b.lineNumber);

      if (practiceId) practiceSet.add(practiceId);
      if (clinicianOnly && providerId && claimProviderId !== providerId) continue;
      if (practiceFilter && practiceId !== practiceFilter) continue;

      const out = claimsByBatch.get(batchId) ?? [];
      out.push({
        id: text(claim.id),
        claimNumber: text(claim.claim_number) || text(claim.id).slice(0, 8),
        status: text(claim.claim_status),
        totalCharge: money(claim.total_charge),
        practiceId,
        patientName,
        providerName,
        serviceLines,
      });
      claimsByBatch.set(batchId, out);
    }

    const outBatches = batches
      .map((b) => {
        const id = text(b.id);
        const claimList = claimsByBatch.get(id) ?? [];
        const payerId = text(b.payer_profile_id) || (claimList.length > 0 ? text(claimById.get(claimList[0].id)?.payer_profile_id) : "");
        return {
          id,
          batchNumber: text(b.batch_number) || id.slice(0, 8),
          status: text(b.batch_status),
          claimCount: claimList.length,
          totalChargeAmount: Math.round(claimList.reduce((sum, c) => sum + c.totalCharge, 0) * 100) / 100,
          generatedFileName: text(b.generated_file_name) || null,
          submittedAt: text(b.submitted_at) || null,
          createdAt: text(b.created_at) || null,
          updatedAt: text(b.updated_at) || null,
          payerProfileId: payerId || null,
          payerName: payerId ? payerNameById.get(payerId) ?? "Payer" : "Payer",
          billingProviderTaxId: text(b.billing_provider_tax_id) || null,
          claims: claimList,
        };
      })
      .filter((b) => b.claimCount > 0);

    const chargeRows = outBatches.flatMap((batch) =>
      batch.claims.flatMap((claim) => {
        if (!claim.serviceLines.length) {
          return [
            {
              chargeId: `${claim.id}-1`,
              claimId: claim.id,
              patientName: claim.patientName,
              dateOfService: null,
              providerName: claim.providerName,
              cptCode: "—",
              billedAmount: claim.totalCharge,
              status: claim.status,
              batchId: batch.batchNumber,
              submitDate: batch.submittedAt,
              notes: "Auto-batched by payer/TIN",
            },
          ];
        }

        return claim.serviceLines.map((line) => ({
          chargeId: line.id,
          claimId: claim.id,
          patientName: claim.patientName,
          dateOfService: line.dateOfService,
          providerName: claim.providerName,
          cptCode: line.procedureCode,
          billedAmount: line.chargeAmount,
          status: claim.status,
          batchId: batch.batchNumber,
          submitDate: batch.submittedAt,
          notes: "Auto-batched by payer/TIN",
        }));
      }),
    );

    const totalUnbilledCharges = Math.round(
      chargeRows
        .filter((row) => !batches.some((b) => text(b.batch_number) === row.batchId && ["submitted", "accepted"].includes(text(b.batch_status).toLowerCase())))
        .reduce((sum, row) => sum + Number(row.billedAmount ?? 0), 0)
      * 100,
    ) / 100;
    const pendingBatches = outBatches.filter((b) => !["submitted", "accepted"].includes((b.status || "").toLowerCase())).length;
    const readyToSubmit = outBatches.filter((b) => ["generated", "ready_to_generate"].includes((b.status || "").toLowerCase())).length;

    return NextResponse.json({
      success: true,
      clinicianOnly,
      canManage: !clinicianOnly,
      practiceOptions: Array.from(practiceSet).sort().map((p) => ({ value: p, label: p })),
      totals: {
        totalUnbilledCharges,
        pendingBatches,
        readyToSubmit,
      },
      chargeRows,
      batches: outBatches,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}

// ─── POST /api/billing/charges/batches ──────────────────────────────────────
//
// Groups all `ready_for_batch` professional claims (not yet in an active
// batch) by payer_profile_id, creates one claim_837p_batches record per
// payer via the atomic RPC, stamps batch_source = "charge_auto", then
// eagerly generates the 837P file content so it's ready to download.
//
// Body: { organizationId: string }

function makeBatchNumber(suffix?: number) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return suffix == null ? `CC-${stamp}` : `CC-${stamp}-${suffix}`;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { organizationId?: string };
    const guard = await requireBillingAccess({ requestedOrganizationId: body.organizationId ?? null });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    // 1. Load all claims that are ready to batch
    const { data: readyClaims, error: claimsError } = await supabase
      .from("professional_claims")
      .select("id, claim_status, total_charge, payer_profile_id")
      .eq("organization_id", organizationId)
      .eq("claim_status", "ready_for_batch")
      .is("archived_at", null)
      .order("created_at", { ascending: true })
      .limit(500);
    if (claimsError) throw claimsError;

    const allReady = (readyClaims ?? []) as DbRow[];
    if (allReady.length === 0) {
      return NextResponse.json({
        success: true,
        batchesCreated: 0,
        batches: [],
        message: "No claims are currently in ready_for_batch status. Release charges first.",
      });
    }

    // 2. Find which claims are already in an active (non-submitted, non-archived) batch
    const readyIds = allReady.map((c) => text(c.id)).filter(Boolean);
    const { data: existingLinks } = await supabase
      .from("claim_837p_batch_claims")
      .select("professional_claim_id, batch_id")
      .eq("organization_id", organizationId)
      .in("professional_claim_id", readyIds)
      .is("archived_at", null);

    // Resolve batch statuses for linked claims
    const linkedBatchIds = [...new Set(((existingLinks ?? []) as DbRow[]).map((r) => text(r.batch_id)).filter(Boolean))];
    let activeBatchIds = new Set<string>();
    if (linkedBatchIds.length > 0) {
      const { data: linkedBatches } = await supabase
        .from("claim_837p_batches")
        .select("id, batch_status")
        .eq("organization_id", organizationId)
        .in("id", linkedBatchIds)
        .is("archived_at", null);
      activeBatchIds = new Set(
        ((linkedBatches ?? []) as DbRow[])
          .filter((b) => !["submitted", "accepted", "voided"].includes(text(b.batch_status).toLowerCase()))
          .map((b) => text(b.id)),
      );
    }

    const alreadyBatchedClaimIds = new Set(
      ((existingLinks ?? []) as DbRow[])
        .filter((r) => activeBatchIds.has(text(r.batch_id)))
        .map((r) => text(r.professional_claim_id)),
    );

    // 3. Only process claims not already in an active batch
    const unbatched = allReady.filter((c) => !alreadyBatchedClaimIds.has(text(c.id)));
    if (unbatched.length === 0) {
      return NextResponse.json({
        success: true,
        batchesCreated: 0,
        batches: [],
        message: "All ready claims are already assigned to active batches. Download them below.",
      });
    }

    // 4. Group by payer_profile_id (null payers go to their own group)
    const groups = new Map<string, DbRow[]>();
    for (const claim of unbatched) {
      const key = text(claim.payer_profile_id) || "__no_payer__";
      const group = groups.get(key) ?? [];
      group.push(claim);
      groups.set(key, group);
    }

    const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    const createdBatches: Array<{
      batchId: string; batchNumber: string; payerProfileId: string | null;
      claimCount: number; totalChargeAmount: number; claimIds: string[];
    }> = [];

    // 5. Create one batch per payer group via the atomic RPC
    for (let i = 0; i < orderedGroups.length; i++) {
      const [payerKey, rows] = orderedGroups[i];
      const payerProfileId = payerKey === "__no_payer__" ? null : payerKey;
      const ids = rows.map((c) => text(c.id));
      const totalChargeAmount = rows.reduce((s, r) => s + money(r.total_charge), 0);
      const number = orderedGroups.length === 1 ? makeBatchNumber() : makeBatchNumber(i + 1);

      const { data: rpcData, error: rpcError } = await (supabase as any).rpc("create_837p_batch_atomic", {
        p_organization_id: organizationId,
        p_claim_ids: ids,
        p_batch_number: number,
        p_payer_profile_id: payerProfileId,
      });
      if (rpcError) throw new Error(rpcError.message ?? "Batch creation failed");

      const result = (rpcData ?? {}) as { batch_id?: string; batch_number?: string };
      if (!result.batch_id) throw new Error("Batch creation returned no batch id");

      // Stamp batch_source so the download/mark-submitted routes recognize it
      await supabase
        .from("claim_837p_batches")
        .update({ batch_source: "charge_auto", updated_at: new Date().toISOString() })
        .eq("id", result.batch_id)
        .eq("organization_id", organizationId);

      createdBatches.push({
        batchId: result.batch_id,
        batchNumber: result.batch_number ?? number,
        payerProfileId,
        claimCount: rows.length,
        totalChargeAmount: Math.round(totalChargeAmount * 100) / 100,
        claimIds: ids,
      });
    }

    // 6. Eagerly generate 837P content for each batch (best-effort)
    const batchResults = await Promise.allSettled(
      createdBatches.map((b) =>
        rebuild837PBatchFile({ batchId: b.batchId, organizationId }),
      ),
    );

    const outputBatches = createdBatches.map((b, i) => {
      const res = batchResults[i];
      return {
        batchId: b.batchId,
        batchNumber: b.batchNumber,
        payerProfileId: b.payerProfileId,
        claimCount: b.claimCount,
        totalChargeAmount: b.totalChargeAmount,
        generated: res.status === "fulfilled" && res.value.ok,
        generationError: res.status === "rejected"
          ? String((res as PromiseRejectedResult).reason)
          : (res.status === "fulfilled" && !res.value.ok ? res.value.error : null),
      };
    });

    return NextResponse.json({
      success: true,
      batchesCreated: createdBatches.length,
      claimsQueued: unbatched.length,
      batches: outputBatches,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
