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
  if (error instanceof Error) {
    const m = error.message.toLowerCase();
    if (m.includes("not authenticated")) return "Not authenticated";
    if (m.includes("forbidden")) return "Forbidden";
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
    const limitRaw = Number(searchParams.get("limit") ?? "50");
    const offsetRaw = Number(searchParams.get("offset") ?? "0");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;
    const clinicianOnly = isClinicianScoped(guard.roles ?? []);
    const providerId = clinicianOnly && guard.userId ? await getProviderIdForUser(guard.userId, guard.organizationId) : null;

    if (clinicianOnly && !providerId) {
      return NextResponse.json({
        success: true,
        clinicianOnly,
        canManage: false,
        practiceOptions: [] as Array<{ value: string; label: string }>,
        pagination: {
          limit,
          offset,
          returned: 0,
          totalCount: 0,
          hasMore: false,
        },
        totals: {
          totalUnbilledCharges: 0,
          pendingBatches: 0,
          readyToSubmit: 0,
        },
        chargeRows: [] as unknown[],
        batches: [] as unknown[],
      });
    }

    const { data, error } = await (supabase as any).rpc("billing_charge_batches_page", {
      p_organization_id: guard.organizationId,
      p_practice: practiceFilter || null,
      p_provider_id: clinicianOnly ? providerId : null,
      p_limit: limit,
      p_offset: offset,
    });
    if (error) throw error;

    const rpcRows = (data ?? []) as DbRow[];
    const totalCount = rpcRows.length > 0 ? Number(rpcRows[0].total_count ?? 0) : 0;
    if (rpcRows.length === 0) {
      return NextResponse.json({
        success: true,
        clinicianOnly,
        canManage: !clinicianOnly,
        practiceOptions: [] as Array<{ value: string; label: string }>,
        pagination: {
          limit,
          offset,
          returned: 0,
          totalCount,
          hasMore: false,
        },
        totals: {
          totalUnbilledCharges: 0,
          pendingBatches: 0,
          readyToSubmit: 0,
        },
        chargeRows: [] as unknown[],
        batches: [] as unknown[],
      });
    }
    const practiceSet = new Set<string>();

    type BatchClaim = {
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
    };

    const outBatches = rpcRows.map((r) => {
      const rawClaims = Array.isArray(r.claims) ? (r.claims as DbRow[]) : [];
      const claims: BatchClaim[] = rawClaims.map((claim) => {
        const serviceLinesRaw = Array.isArray(claim.serviceLines) ? (claim.serviceLines as DbRow[]) : [];
        const practiceId = text(claim.practiceId) || null;
        if (practiceId) practiceSet.add(practiceId);

        return {
          id: text(claim.id),
          claimNumber: text(claim.claimNumber) || text(claim.id).slice(0, 8),
          status: text(claim.status),
          totalCharge: money(claim.totalCharge),
          practiceId,
          patientName: text(claim.patientName) || "Unknown Client",
          providerName: text(claim.providerName) || "—",
          serviceLines: serviceLinesRaw.map((line) => ({
            id: text(line.id) || `${text(claim.id)}-${text(line.lineNumber) || "1"}`,
            lineNumber: Number(line.lineNumber ?? 0) || 0,
            dateOfService: text(line.dateOfService) || null,
            procedureCode: text(line.procedureCode) || "—",
            chargeAmount: money(line.chargeAmount),
          })),
        };
      });

      return {
        id: text(r.id),
        batchNumber: text(r.batch_number) || text(r.id).slice(0, 8),
        status: text(r.batch_status),
        claimCount: Number(r.claim_count ?? claims.length) || claims.length,
        totalChargeAmount: money(r.total_charge_amount),
        generatedFileName: text(r.generated_file_name) || null,
        submittedAt: text(r.submitted_at) || null,
        createdAt: text(r.created_at) || null,
        updatedAt: text(r.updated_at) || null,
        payerProfileId: text(r.payer_profile_id) || null,
        payerName: text(r.payer_name) || "Payer",
        billingProviderTaxId: text(r.billing_provider_tax_id) || null,
        claims,
      };
    });

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
        .filter((row) => !outBatches.some((b) => b.batchNumber === row.batchId && ["submitted", "accepted"].includes((b.status || "").toLowerCase())))
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
      pagination: {
        limit,
        offset,
        returned: outBatches.length,
        totalCount,
        hasMore: offset + outBatches.length < totalCount,
      },
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
// payer via the atomic RPC, and stamps batch_source = "charge_auto".
// 837 generation can run eagerly (`generateNow=true`) or be deferred to the
// first download request for faster API response times.
//
// Body: { organizationId: string }

function makeBatchNumber(suffix?: number) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return suffix == null ? `CC-${stamp}` : `CC-${stamp}-${suffix}`;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { organizationId?: string; claimIds?: unknown; generateNow?: unknown };
    const guard = await requireBillingAccess({ requestedOrganizationId: body.organizationId ?? null });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const generateNow =
      body.generateNow === true ||
      body.generateNow === 1 ||
      String(body.generateNow ?? "").toLowerCase() === "true";

    const selectedClaimIds = Array.isArray(body.claimIds)
      ? [...new Set(body.claimIds.map((id) => text(id)).filter(Boolean))]
      : [];
    if (selectedClaimIds.length > 500) {
      return NextResponse.json(
        { success: false, error: "At most 500 claimIds can be submitted per request" },
        { status: 400 },
      );
    }
    const explicitSelection = selectedClaimIds.length > 0;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    // 1. Collect existing auto batches that are not yet submitted so
    // "Generate" can finalize already-grouped released claims.
    const { data: existingAutoBatches, error: existingBatchError } = await supabase
      .from("claim_837p_batches")
      .select("id, batch_number, batch_status")
      .eq("organization_id", organizationId)
      .eq("batch_source", "charge_auto")
      .in("batch_status", ["draft", "ready_to_generate", "generated"])
      .is("archived_at", null)
      .order("created_at", { ascending: true });
    if (existingBatchError) throw existingBatchError;

    const existingBatchRows = (existingAutoBatches ?? []) as DbRow[];
    const existingBatchIds = existingBatchRows.map((b) => text(b.id)).filter(Boolean);

    const { data: existingLinks, error: existingLinksError } = existingBatchIds.length > 0
      ? await supabase
          .from("claim_837p_batch_claims")
          .select("batch_id, professional_claim_id")
          .eq("organization_id", organizationId)
          .in("batch_id", existingBatchIds)
          .is("archived_at", null)
      : { data: [] as DbRow[], error: null as any };
    if (existingLinksError) throw existingLinksError;

    const existingClaimCountsByBatchId = new Map<string, number>();
    for (const link of (existingLinks ?? []) as DbRow[]) {
      const batchId = text(link.batch_id);
      if (!batchId) continue;
      existingClaimCountsByBatchId.set(batchId, (existingClaimCountsByBatchId.get(batchId) ?? 0) + 1);
    }

    const existingProcessable = existingBatchRows
      .filter((b) => (existingClaimCountsByBatchId.get(text(b.id)) ?? 0) > 0)
      .map((b) => ({
        batchId: text(b.id),
        batchNumber: text(b.batch_number) || text(b.id).slice(0, 8),
        status: text(b.batch_status).toLowerCase(),
        claimCount: existingClaimCountsByBatchId.get(text(b.id)) ?? 0,
      }));

    // 2. Load claims that are ready to batch and not yet in active batches.
    let totalReadyCountQuery = supabase
      .from("professional_claims")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("claim_status", "ready_for_batch")
      .is("archived_at", null);
    if (explicitSelection) {
      totalReadyCountQuery = totalReadyCountQuery.in("id", selectedClaimIds);
    }

    const [{ count: totalReadyCount, error: countError }] = await Promise.all([
      totalReadyCountQuery,
    ]);
    if (countError) throw countError;

    const allReady: DbRow[] = [];
    if (explicitSelection) {
      const { data: selectedReady, error: selectedError } = await supabase
        .from("professional_claims")
        .select("id, claim_status, total_charge, payer_profile_id")
        .eq("organization_id", organizationId)
        .eq("claim_status", "ready_for_batch")
        .is("archived_at", null)
        .in("id", selectedClaimIds)
        .order("created_at", { ascending: true });
      if (selectedError) throw selectedError;
      allReady.push(...((selectedReady ?? []) as DbRow[]));
    } else {
      const pageSize = 500;
      let pageOffset = 0;
      while (true) {
        const { data: pageRows, error: pageError } = await supabase
          .from("professional_claims")
          .select("id, claim_status, total_charge, payer_profile_id")
          .eq("organization_id", organizationId)
          .eq("claim_status", "ready_for_batch")
          .is("archived_at", null)
          .order("created_at", { ascending: true })
          .range(pageOffset, pageOffset + pageSize - 1);
        if (pageError) throw pageError;
        const page = (pageRows ?? []) as DbRow[];
        allReady.push(...page);
        if (page.length < pageSize) break;
        pageOffset += pageSize;
      }
    }

    const remainingReadyClaims = Math.max((totalReadyCount ?? allReady.length) - allReady.length, 0);

    // 2. Find which claims are already in an active (non-submitted, non-archived) batch
    const readyIds = allReady.map((c) => text(c.id)).filter(Boolean);
    const { data: readyClaimLinks } = await supabase
      .from("claim_837p_batch_claims")
      .select("professional_claim_id, batch_id")
      .eq("organization_id", organizationId)
      .in("professional_claim_id", readyIds)
      .is("archived_at", null);

    // Resolve batch statuses for linked claims
    const linkedBatchIds = [...new Set(((readyClaimLinks ?? []) as DbRow[]).map((r) => text(r.batch_id)).filter(Boolean))];
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
      ((readyClaimLinks ?? []) as DbRow[])
        .filter((r) => activeBatchIds.has(text(r.batch_id)))
        .map((r) => text(r.professional_claim_id)),
    );

    // 3. Only process claims not already in an active batch
    const unbatched = allReady.filter((c) => !alreadyBatchedClaimIds.has(text(c.id)));

    if (existingProcessable.length === 0 && unbatched.length === 0) {
      return NextResponse.json({
        success: true,
        batchesCreated: 0,
        selectionMode: explicitSelection ? "explicit" : "auto",
        totalReadyClaims: totalReadyCount ?? 0,
        scannedReadyClaims: allReady.length,
        remainingReadyClaims,
        batches: [],
        message: "No claims are currently in ready_for_batch status. Release charges first.",
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

    const processedBatches = [
      ...existingProcessable.map((b) => ({
        batchId: b.batchId,
        batchNumber: b.batchNumber,
        payerProfileId: null as string | null,
        claimCount: b.claimCount,
        totalChargeAmount: 0,
        claimIds: [] as string[],
      })),
      ...createdBatches,
    ];

    let outputBatches: Array<{
      batchId: string;
      batchNumber: string;
      payerProfileId: string | null;
      claimCount: number;
      totalChargeAmount: number;
      generated: boolean;
      generationError: string | null;
      generationDeferred: boolean;
    }>;
    let queuedJobs = 0;

    if (generateNow) {
      const batchResults = await Promise.allSettled(
        processedBatches.map((b) =>
          rebuild837PBatchFile({ batchId: b.batchId, organizationId }),
        ),
      );

      outputBatches = processedBatches.map((b, i) => {
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
            : (res.status === "fulfilled" && !res.value.ok ? (res.value.error ?? null) : null),
          generationDeferred: false,
        };
      });
    } else {
      for (const batch of processedBatches) {
        const { data: queueData, error: queueError } = await (supabase as any).rpc(
          "enqueue_claim_837p_batch_generation_job",
          {
            p_organization_id: organizationId,
            p_batch_id: batch.batchId,
          },
        );
        if (queueError) throw queueError;
        if (Boolean((queueData as { enqueued?: unknown } | null)?.enqueued)) {
          queuedJobs += 1;
        }
      }

      outputBatches = processedBatches.map((b) => ({
        batchId: b.batchId,
        batchNumber: b.batchNumber,
        payerProfileId: b.payerProfileId,
        claimCount: b.claimCount,
        totalChargeAmount: b.totalChargeAmount,
        generated: false,
        generationError: null,
        generationDeferred: true,
      }));
    }

    const createdSet = new Set(createdBatches.map((b) => b.batchId));
    const existingRegenerated = outputBatches.filter((b) => !createdSet.has(b.batchId)).length;
    const totalClaimsCovered = processedBatches.reduce((sum, b) => sum + b.claimCount, 0);

    return NextResponse.json({
      success: true,
      batchesCreated: createdBatches.length,
      generationMode: generateNow ? "eager" : "queued",
      jobsQueued: queuedJobs,
      selectionMode: explicitSelection ? "explicit" : "auto",
      totalReadyClaims: totalReadyCount ?? allReady.length,
      scannedReadyClaims: allReady.length,
      remainingReadyClaims,
      claimsQueued: totalClaimsCovered,
      existingBatchesRegenerated: existingRegenerated,
      message:
        !generateNow
          ? `Batches created. Queued ${queuedJobs} background job${queuedJobs === 1 ? "" : "s"} to generate 837 files.`
          :
        remainingReadyClaims > 0
          ? `Processed first ${allReady.length} ready claims; ${remainingReadyClaims} additional ready claim(s) remain outside this request window.`
          :
        createdBatches.length === 0 && existingRegenerated > 0
          ? `Regenerated ${existingRegenerated} existing batch${existingRegenerated === 1 ? "" : "es"}.`
          : undefined,
      batches: outputBatches,
    });
  } catch (error) {
    console.error("Charge batch generation failed", error);
    return NextResponse.json(
      { success: false, error: "Failed to generate charge batches" },
      { status: 500 },
    );
  }
}
