import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

/**
 * GET /api/billing/rejections?organizationId=...
 *
 * Worklist of clearinghouse-rejected claims (claim_status='rejected_payer').
 * Returns the same shape as /api/billing/blocked-claims so the same client
 * component can render either source — `blockingFindings` is synthesised
 * from the latest claim_status_event for the claim.
 */

type DbRow = Record<string, unknown>;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function fullName(first: unknown, last: unknown): string {
  const parts = [text(first), text(last)].filter(Boolean);
  return parts.join(" ") || "Unknown patient";
}

function extractRejectionReason(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    p.rejection_reason,
    p.rejectionReason,
    p.status_message,
    p.statusMessage,
    p.message,
    p.error,
    (p.data as Record<string, unknown> | undefined)?.message,
  ];
  for (const c of candidates) {
    const t = text(c);
    if (t) return t;
  }
  return "";
}

export async function GET(request: Request) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { success: false, error: "Database connection not available" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const guard = await requireBillingAccess({
    requestedOrganizationId: searchParams.get("organizationId"),
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;
  const singleClaimId = searchParams.get("claimId");

  try {
    let claimsQuery = supabase
      .from("professional_claims")
      .select(
        "id, claim_number, claim_status, patient_id, payer_profile_id, total_charge, updated_at, created_at",
      )
      .eq("organization_id", organizationId)
      .eq("claim_status", "rejected_payer")
      .order("updated_at", { ascending: false })
      .limit(500);

    if (singleClaimId) {
      claimsQuery = claimsQuery.eq("id", singleClaimId);
    }

    const { data: claimRows, error: claimsError } = await claimsQuery;
    if (claimsError) throw claimsError;

    const claims = (claimRows ?? []) as DbRow[];
    const claimIds = claims.map((c) => text(c.id)).filter(Boolean);
    const patientIds = [...new Set(claims.map((c) => text(c.patient_id)).filter(Boolean))];
    const payerProfileIds = [
      ...new Set(claims.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];

    const [{ data: patientRows }, { data: payerRows }, { data: lineRows }, { data: events }] =
      await Promise.all([
        patientIds.length
          ? supabase
              .from("clients")
              .select("id, first_name, last_name, date_of_birth")
              .in("id", patientIds)
          : Promise.resolve({ data: [] as DbRow[] }),
        payerProfileIds.length
          ? supabase
              .from("payer_profiles")
              .select("id, payer_name")
              .in("id", payerProfileIds)
          : Promise.resolve({ data: [] as DbRow[] }),
        claimIds.length
          ? supabase
              .from("professional_claim_service_lines")
              .select("claim_id, service_date_from")
              .in("claim_id", claimIds)
          : Promise.resolve({ data: [] as DbRow[] }),
        claimIds.length
          ? (supabase as unknown as { from: (t: string) => { select: (s: string) => { in: (c: string, v: string[]) => { order: (c: string, o: { ascending: boolean }) => Promise<{ data: DbRow[] | null }> } } } })
              .from("claim_status_events")
              .select("claim_id, status, status_message, raw_payload, created_at")
              .in("claim_id", claimIds)
              .order("created_at", { ascending: false })
          : Promise.resolve({ data: [] as DbRow[] }),
      ]);

    const patientById = new Map<string, DbRow>(
      (patientRows ?? []).map((row: DbRow) => [text(row.id), row]),
    );
    const payerById = new Map<string, DbRow>(
      (payerRows ?? []).map((row: DbRow) => [text(row.id), row]),
    );

    const datesByClaim = new Map<string, { from: string | null; to: string | null }>();
    for (const line of (lineRows ?? []) as DbRow[]) {
      const cid = text(line.claim_id);
      const dt = (line.service_date_from as string | null | undefined) ?? null;
      if (!cid || !dt) continue;
      const cur = datesByClaim.get(cid);
      if (!cur) datesByClaim.set(cid, { from: dt, to: dt });
      else {
        if (cur.from === null || dt < cur.from) cur.from = dt;
        if (cur.to === null || dt > cur.to) cur.to = dt;
      }
    }

    const latestEventByClaim = new Map<string, DbRow>();
    for (const ev of (events ?? []) as DbRow[]) {
      const cid = text(ev.claim_id);
      if (!latestEventByClaim.has(cid)) latestEventByClaim.set(cid, ev);
    }

    const items = claims.map((claim) => {
      const claimId = text(claim.id);
      const patient = patientById.get(text(claim.patient_id));
      const payer = payerById.get(text(claim.payer_profile_id));
      const dates = datesByClaim.get(claimId) ?? { from: null, to: null };
      const event = latestEventByClaim.get(claimId);
      const reason =
        (event && (extractRejectionReason(event.raw_payload) || text(event.status_message))) ||
        "Rejected by payer";

      return {
        claimId,
        claimNumber: text(claim.claim_number) || null,
        claimStatus: text(claim.claim_status) || null,
        payerName: text(payer?.payer_name) || "No payer attached",
        payerProfileId: text(claim.payer_profile_id) || null,
        patientId: text(claim.patient_id) || null,
        patientName: fullName(patient?.first_name, patient?.last_name),
        patientDob: (patient?.date_of_birth as string | null) ?? null,
        serviceDateFrom: dates.from,
        serviceDateTo: dates.to,
        totalChargeAmount: Number(claim.total_charge ?? 0) || 0,
        updatedAt: (claim.updated_at as string | null) ?? null,
        blockingCount: 1,
        warningCount: 0,
        blockingFindings: [
          {
            ruleId: "rejected_payer",
            category: "rejection",
            message: reason,
            fixRoute: null,
            whyItMatters: "The payer's clearinghouse rejected the claim and will not adjudicate it until the issue is fixed and the claim is resubmitted.",
            resolution: "Open the claim, fix the rejection reason, and resubmit on the 837P Batches page.",
          },
        ],
        engineError: null as string | null,
      };
    });

    return NextResponse.json({
      success: true,
      organizationId,
      generatedAt: new Date().toISOString(),
      items,
      count: items.length,
      metrics: {
        blockedClaims: items.length,
        totalBlockingFindings: items.length,
        candidatesEvaluated: items.length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load rejections",
      },
      { status: 500 },
    );
  }
}
