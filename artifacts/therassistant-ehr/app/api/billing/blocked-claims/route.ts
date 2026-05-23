import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { runClaimContentValidation } from "@/lib/validation/claim/runClaimContentValidation";
import type { ValidationFinding } from "@/lib/validation/types";

/**
 * GET /api/billing/blocked-claims?organizationId=...[&claimId=...]
 *
 * Operational workqueue for the Claim Edit Dashboard. Enumerates all
 * pre-submission professional claims for the organization, runs the
 * Claim Content Validation engine on each, and returns the ones that
 * still have BLOCKING findings (i.e. cannot be submitted as-is).
 *
 * Pass `claimId` to re-validate a single claim (the per-row "recheck"
 * action on the dashboard). The single-claim response still uses the
 * `items` array shape so the client renders it identically.
 *
 * Statuses considered pre-submission (and therefore eligible for the
 * dashboard) are anything NOT in the post-submission terminal set:
 *   batched, submitted, voided, paid, accepted, denied, closed
 *
 * The same engine that the submission gate uses is invoked here, so a
 * claim that appears on this dashboard is exactly the set of claims
 * that the gate would reject if a user tried to transmit them.
 */

type DbRow = Record<string, unknown>;

const POST_SUBMISSION_STATUSES = new Set([
  "batched",
  "submitted",
  "voided",
  "paid",
  "accepted",
  "denied",
  "closed",
]);

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function fullName(first: unknown, last: unknown): string {
  const parts = [text(first), text(last)].filter(Boolean);
  return parts.join(" ") || "Unknown patient";
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
  const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
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
      .order("updated_at", { ascending: false })
      .limit(500);

    if (singleClaimId) {
      claimsQuery = claimsQuery.eq("id", singleClaimId);
    }

    const { data: claimRows, error: claimsError } = await claimsQuery;
    if (claimsError) throw claimsError;

    const candidateClaims = (claimRows ?? []).filter((row: DbRow) => {
      const status = text(row.claim_status).toLowerCase();
      return !POST_SUBMISSION_STATUSES.has(status);
    });

    const patientIds = [
      ...new Set(candidateClaims.map((c: DbRow) => text(c.patient_id)).filter(Boolean)),
    ];
    const payerProfileIds = [
      ...new Set(candidateClaims.map((c: DbRow) => text(c.payer_profile_id)).filter(Boolean)),
    ];

    const candidateClaimIds = candidateClaims.map((c: DbRow) => text(c.id)).filter(Boolean);

    const [{ data: patientRows }, { data: payerRows }, { data: lineRows }] =
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
        candidateClaimIds.length
          ? supabase
              .from("professional_claim_service_lines")
              .select("claim_id, service_date_from")
              .in("claim_id", candidateClaimIds)
          : Promise.resolve({ data: [] as DbRow[] }),
      ]);

    const patientById = new Map<string, DbRow>(
      (patientRows ?? []).map((row: DbRow) => [text(row.id), row]),
    );
    const payerById = new Map<string, DbRow>(
      (payerRows ?? []).map((row: DbRow) => [text(row.id), row]),
    );

    // Compute min/max service date per claim from the service lines, since
    // `professional_claims` itself does not carry a header service-date.
    const datesByClaim = new Map<string, { from: string | null; to: string | null }>();
    for (const line of lineRows ?? []) {
      const cid = text((line as DbRow).claim_id);
      const dt = (line as DbRow).service_date_from as string | null | undefined;
      if (!cid || !dt) continue;
      const cur = datesByClaim.get(cid);
      if (!cur) {
        datesByClaim.set(cid, { from: dt, to: dt });
      } else {
        if (cur.from === null || dt < cur.from) cur.from = dt;
        if (cur.to === null || dt > cur.to) cur.to = dt;
      }
    }

    // Run the validator for each candidate claim. Done in parallel — the
    // engine is read-only and each call is independent. This keeps the
    // dashboard snappy even with a few hundred claims, while still using
    // exactly the same code path the submission gate uses.
    const validated = await Promise.all(
      candidateClaims.map(async (claim: DbRow) => {
        const claimId = text(claim.id);
        try {
          const { report } = await runClaimContentValidation(
            supabase,
            organizationId,
            claimId,
          );
          return { claim, report, error: null as string | null };
        } catch (err) {
          return {
            claim,
            report: null,
            error: err instanceof Error ? err.message : "Validation engine failed",
          };
        }
      }),
    );

    const items = validated
      .map(({ claim, report, error }) => {
        const claimId = text(claim.id);
        const patient = patientById.get(text(claim.patient_id));
        const payer = payerById.get(text(claim.payer_profile_id));
        const dates = datesByClaim.get(claimId) ?? { from: null, to: null };

        const blocking: ValidationFinding[] =
          report?.findings.filter((f) => f.severity === "blocking") ?? [];
        const warning: ValidationFinding[] =
          report?.findings.filter((f) => f.severity === "warning") ?? [];

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
          blockingCount: blocking.length,
          warningCount: warning.length,
          blockingFindings: blocking.map((f) => ({
            ruleId: f.ruleId,
            category: f.category,
            message: f.message,
            fixRoute: f.fixRoute,
            whyItMatters: f.whyItMatters,
            resolution: f.resolution,
          })),
          engineError: error,
        };
      })
      // Only keep claims that are actually blocked OR errored, since this
      // dashboard is for the operational fix-it queue.
      .filter((item) => item.blockingCount > 0 || item.engineError !== null);

    const metrics = {
      blockedClaims: items.length,
      totalBlockingFindings: items.reduce((sum, i) => sum + i.blockingCount, 0),
      candidatesEvaluated: candidateClaims.length,
    };

    return NextResponse.json({
      success: true,
      organizationId,
      generatedAt: new Date().toISOString(),
      metrics,
      items,
    });
  } catch (error) {
    console.error("[GET /api/billing/blocked-claims]", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load blocked-claims workqueue",
      },
      { status: 500 },
    );
  }
}
