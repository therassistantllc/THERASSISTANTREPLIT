import { NextResponse } from "next/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { getProviderIdForUser } from "@/lib/rbac/auth";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

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

    const batchQuery = supabase
      .from("claim_837p_batches")
      .select(
        "id, batch_number, batch_status, claim_count, total_charge_amount, generated_file_name, submitted_at, created_at, updated_at, payer_profile_id, billing_provider_tax_id",
      )
      .eq("organization_id", guard.organizationId)
      .eq("batch_source", "charge_auto")
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(250);

    const { data: batchRows, error: batchError } = await batchQuery;
    if (batchError) throw batchError;

    const batches = (batchRows ?? []) as DbRow[];
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
          .select("id, claim_number, claim_status, total_charge, payer_profile_id, appointment_id")
          .eq("organization_id", guard.organizationId)
          .in("id", claimIds)
          .is("archived_at", null)
      : { data: [] as DbRow[] };

    const claims = (claimRows ?? []) as DbRow[];
    const appointmentIds = [...new Set(claims.map((c) => text(c.appointment_id)).filter(Boolean))];

    const { data: appointmentRows } = appointmentIds.length
        ? await supabase
          .from("appointments")
          .select("id, provider_id, provider_location_id")
          .eq("organization_id", guard.organizationId)
          .in("id", appointmentIds)
      : { data: [] as DbRow[] };

    const { data: payerRows } = await supabase
      .from("payer_profiles")
      .select("id, payer_name")
      .eq("organization_id", guard.organizationId)
      .is("archived_at", null);

    const claimById = new Map<string, DbRow>(claims.map((c) => [text(c.id), c]));
    const appointmentById = new Map<string, DbRow>(((appointmentRows ?? []) as DbRow[]).map((a) => [text(a.id), a]));
    const payerNameById = new Map<string, string>(((payerRows ?? []) as DbRow[]).map((p) => [text(p.id), text(p.payer_name) || "Payer"]));

    const practiceSet = new Set<string>();

    const claimsByBatch = new Map<string, Array<{
      id: string;
      claimNumber: string;
      status: string;
      totalCharge: number;
      practiceId: string | null;
    }>>();

    for (const link of (linkRows ?? []) as DbRow[]) {
      const batchId = text(link.batch_id);
      const claim = claimById.get(text(link.professional_claim_id));
      if (!claim) continue;
      const appt = appointmentById.get(text(claim.appointment_id));
      const claimProviderId = text(appt?.provider_id);
      const practiceId = text(appt?.provider_location_id) || null;

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

    return NextResponse.json({
      success: true,
      clinicianOnly,
      canManage: !clinicianOnly,
      practiceOptions: Array.from(practiceSet).sort().map((p) => ({ value: p, label: p })),
      batches: outBatches,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load charge batches" },
      { status: 500 },
    );
  }
}
