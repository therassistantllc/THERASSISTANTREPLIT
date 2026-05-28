/**
 * /api/billing/denials-by-carc
 *
 * Returns denied claims grouped by Claim Adjustment Reason Code (CARC).
 *
 * CARC sources, in priority order, per claim:
 *   1. `claim_workqueue_items.carc_code` (single, when a workqueue item exists)
 *   2. `era_claim_payments.carc_codes[]` (from the latest ERA on that claim)
 *
 * Each claim is bucketed under at most one CARC. Claims with no CARC at any
 * source fall into a synthetic "UNKNOWN" group so the page still reflects the
 * full denial backlog.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, any>;

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

// ── CARC description dictionary ─────────────────────────────────────────────
// Source: X12 CARC code list. Limited to the most common denial codes we
// surface in the UI; unknown codes fall through to a generic label.
export const CARC_DESCRIPTIONS: Record<string, string> = {
  "16": "Claim/service lacks information or has submission/billing error(s)",
  "22": "Care may be covered by another payer per coordination of benefits",
  "23": "Impact of prior payer adjudication including payments and adjustments",
  "24": "Charges covered under a capitation agreement / managed care plan",
  "29": "Time limit for filing has expired",
  "45": "Charge exceeds contracted/legislated fee arrangement",
  "50": "Non-covered services because not deemed medical necessity by the payer",
  "96": "Non-covered charges",
  "97": "Procedure/service is paid as part of another already-adjudicated service",
  "109": "Claim/service not covered by this payer/contractor",
  "119": "Benefit maximum for this time period or occurrence has been reached",
  "151": "Information from another provider was not provided or was insufficient",
  "167": "This (these) diagnosis(es) is (are) not covered",
  "197": "Precertification / authorization / notification absent",
  "204": "This service/equipment/drug is not covered under the client's benefit plan",
  "253": "Sequestration — reduction in federal payment",
};

export function describeCarc(code: string): string {
  const c = text(code);
  if (!c) return "Unknown reason — no CARC reported";
  return CARC_DESCRIPTIONS[c] ?? `CARC ${c}`;
}

// ── Suggested correction templates ──────────────────────────────────────────
// Per-CARC playbook strings used by the detail panel.
export const CARC_CORRECTION_TEMPLATES: Record<string, string> = {
  "16": "Verify member ID, DOB, and required loops (2010BA/BB). Re-bill once data is complete.",
  "22": "Confirm primary/secondary order. Update COB on the client and resubmit to the correct payer first.",
  "29": "Gather proof of timely original submission (clearinghouse 277CA) and file a timely-filing appeal.",
  "50": "Attach medical-necessity documentation (notes, LCD/NCD citation) and submit appeal.",
  "96": "Validate service is a covered benefit under the client's plan; if covered, dispute with EOB and CPT.",
  "97": "Review NCCI edits and modifiers (25/59/XE/XS). If clinically distinct, appeal with documentation.",
  "109": "Identify the correct payer / payer ID and resubmit. Update the client's payer profile.",
  "151": "Send the missing provider records to the payer and resubmit a corrected claim.",
  "167": "Verify the diagnosis pointer order and ICD-10 code. Submit a corrected claim (frequency code 7).",
  "197": "Obtain retro authorization or attach medical necessity to support absence-of-auth appeal.",
  "204": "Confirm benefits and bill the client (or alternate payer) for the non-covered service.",
};

export function correctionTemplateFor(code: string): string {
  const c = text(code);
  return (
    CARC_CORRECTION_TEMPLATES[c] ??
    "Review the EOB / 835 CAS segment, gather supporting documentation, and either correct + resubmit or initiate an appeal."
  );
}

export const TOP_CARC_CODES = ["16", "22", "29", "96", "197"] as const;

function ageDays(value: string | null | undefined): number | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000));
}

export interface DrilldownClaim {
  workqueueItemId: string | null;
  claimId: string;
  claimNumber: string;
  clientId: string;
  clientName: string;
  serviceDate: string | null;
  payer: string;
  payerProfileId: string;
  deniedAmount: number;
  rarcCode: string | null;
  rarcCodes: string[];
  lastAction: string | null;
  nextStep: string | null;
  assignedToUserId: string | null;
  priority: string;
  ageDays: number | null;
  updatedAt: string | null;
}

export interface CarcGroup {
  carcCode: string;
  carcDescription: string;
  claimCount: number;
  totalDeniedAmount: number;
  avgAgeDays: number | null;
  oldestAgeDays: number | null;
  payers: string[];
  assignedOwners: string[];
  topPriority: string;
  payerBreakdown: Array<{ payer: string; claimCount: number; totalAmount: number }>;
  suggestedCorrection: string;
  claims: DrilldownClaim[];
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const today = new Date().toISOString().slice(0, 10);

    // 1) All open denied claims for the org.
    const { data: claims, error: claimsErr } = await (supabase as any)
      .from("professional_claims")
      .select(
        "id, claim_number, patient_id, payer_profile_id, total_charge, write_off_amount, defer_until, deferred_reason, updated_at, created_at",
      )
      .eq("organization_id", organizationId)
      .eq("claim_status", "denied")
      .is("archived_at", null)
      .or(`defer_until.is.null,defer_until.lte.${today}`)
      .order("updated_at", { ascending: false })
      .limit(500);

    if (claimsErr) throw claimsErr;

    const claimRows: DbRow[] = (claims as DbRow[]) ?? [];
    const claimIds = claimRows.map((c) => text(c.id)).filter(Boolean);
    const patientIds = [...new Set(claimRows.map((c) => text(c.patient_id)).filter(Boolean))];
    const payerProfileIds = [
      ...new Set(claimRows.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];

    const [
      { data: clients },
      { data: payerProfiles },
      { data: serviceLines },
      { data: workqueueItems },
      { data: eraPayments },
      { data: templates },
    ] = await Promise.all([
      patientIds.length
        ? (supabase as any)
            .from("clients")
            .select("id, first_name, last_name")
            .in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerProfileIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name")
            .in("id", payerProfileIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claim_service_lines")
            .select("claim_id, service_date_from, service_date_to, line_number")
            .in("claim_id", claimIds)
            .order("line_number", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_workqueue_items")
            .select(
              "id, claim_id, carc_code, rarc_code, priority, item_status, action_taken, assigned_to_user_id, days_in_ar, updated_at",
            )
            .eq("organization_id", organizationId)
            .in("claim_id", claimIds)
            .is("archived_at", null)
            .neq("item_status", "resolved")
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("era_claim_payments")
            .select(
              "id, professional_claim_id, carc_codes, rarc_codes, clp03_total_charge, clp04_payment_amount, check_issue_date, created_at",
            )
            .eq("organization_id", organizationId)
            .in("professional_claim_id", claimIds)
            .is("archived_at", null)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      (supabase as any)
        .from("claim_appeal_templates")
        .select("id, name, body, is_system, organization_id")
        .is("archived_at", null)
        .or(`is_system.eq.true,organization_id.eq.${organizationId}`)
        .order("is_system", { ascending: false })
        .order("name", { ascending: true }),
    ]);

    const patientById = new Map<string, DbRow>(
      ((clients as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const payerProfileById = new Map<string, DbRow>(
      ((payerProfiles as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );

    const serviceLinesByClaim = new Map<string, DbRow[]>();
    for (const sl of ((serviceLines as DbRow[]) ?? [])) {
      const cid = text(sl.claim_id);
      if (!serviceLinesByClaim.has(cid)) serviceLinesByClaim.set(cid, []);
      serviceLinesByClaim.get(cid)!.push(sl);
    }

    const wqItemByClaim = new Map<string, DbRow>();
    for (const w of ((workqueueItems as DbRow[]) ?? [])) {
      // First (most-recent by update) wins.
      const cid = text(w.claim_id);
      if (!wqItemByClaim.has(cid)) wqItemByClaim.set(cid, w);
    }

    const eraByClaim = new Map<string, DbRow>();
    for (const e of ((eraPayments as DbRow[]) ?? [])) {
      const cid = text(e.professional_claim_id);
      if (!eraByClaim.has(cid)) eraByClaim.set(cid, e);
    }

    // 2) Bucket claims by CARC.
    const groups = new Map<string, DrilldownClaim[]>();

    for (const claim of claimRows) {
      const claimId = text(claim.id);
      const wq = wqItemByClaim.get(claimId);
      const era = eraByClaim.get(claimId);

      // CARC priority: workqueue item > first ERA CARC
      let carc = text(wq?.carc_code);
      if (!carc) {
        const eraCarcs = Array.isArray(era?.carc_codes) ? era!.carc_codes : [];
        carc = text(eraCarcs[0] ?? "");
      }
      const bucketKey = carc || "UNKNOWN";

      // RARC priority: workqueue item > first ERA RARC
      const rarcCodesEra: string[] = Array.isArray(era?.rarc_codes) ? era!.rarc_codes : [];
      const primaryRarc = text(wq?.rarc_code) || text(rarcCodesEra[0] ?? "") || null;

      const client = patientById.get(text(claim.patient_id));
      const payerProfile = payerProfileById.get(text(claim.payer_profile_id));
      const lines = serviceLinesByClaim.get(claimId) ?? [];
      const serviceDate = lines.length > 0 ? text(lines[0].service_date_from) || null : null;

      const totalCharge = money(claim.total_charge);
      const eraPaid = money(era?.clp04_payment_amount);
      const deniedAmount = Math.max(0, Math.round((totalCharge - eraPaid) * 100) / 100);

      const drill: DrilldownClaim = {
        workqueueItemId: wq ? text(wq.id) : null,
        claimId,
        claimNumber: text(claim.claim_number) || claimId.slice(0, 8),
        clientId: text(claim.patient_id),
        clientName: client
          ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") ||
            "Unknown client"
          : "Unknown client",
        serviceDate,
        payer: text(payerProfile?.payer_name) || "Unknown payer",
        payerProfileId: text(claim.payer_profile_id),
        deniedAmount,
        rarcCode: primaryRarc,
        rarcCodes: rarcCodesEra.map(text).filter(Boolean),
        lastAction: text(wq?.action_taken) || null,
        nextStep: correctionTemplateFor(carc).slice(0, 120),
        assignedToUserId: wq ? text(wq.assigned_to_user_id) || null : null,
        priority: text(wq?.priority) || "normal",
        ageDays: ageDays(claim.updated_at) ?? ageDays(claim.created_at),
        updatedAt: claim.updated_at ?? null,
      };

      if (!groups.has(bucketKey)) groups.set(bucketKey, []);
      groups.get(bucketKey)!.push(drill);
    }

    // 3) Compose CarcGroup rows.
    const priorityRank: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

    const carcGroups: CarcGroup[] = Array.from(groups.entries())
      .map(([code, claims]) => {
        const claimCount = claims.length;
        const totalDeniedAmount = Math.round(
          claims.reduce((s, c) => s + (c.deniedAmount || 0), 0) * 100,
        ) / 100;
        const ages = claims.map((c) => c.ageDays).filter((a): a is number => a != null);
        const avgAgeDays = ages.length ? Math.round(ages.reduce((s, a) => s + a, 0) / ages.length) : null;
        const oldestAgeDays = ages.length ? Math.max(...ages) : null;
        const payerSet = new Map<string, { count: number; total: number }>();
        for (const c of claims) {
          const cur = payerSet.get(c.payer) ?? { count: 0, total: 0 };
          cur.count += 1;
          cur.total = Math.round((cur.total + c.deniedAmount) * 100) / 100;
          payerSet.set(c.payer, cur);
        }
        const payerBreakdown = Array.from(payerSet.entries())
          .map(([payer, v]) => ({ payer, claimCount: v.count, totalAmount: v.total }))
          .sort((a, b) => b.totalAmount - a.totalAmount);
        const owners = Array.from(
          new Set(claims.map((c) => c.assignedToUserId).filter((x): x is string => !!x)),
        );
        const topPriority = claims.reduce(
          (best, c) => (priorityRank[c.priority] > priorityRank[best] ? c.priority : best),
          "normal",
        );

        return {
          carcCode: code,
          carcDescription: code === "UNKNOWN" ? describeCarc("") : describeCarc(code),
          claimCount,
          totalDeniedAmount,
          avgAgeDays,
          oldestAgeDays,
          payers: payerBreakdown.map((p) => p.payer),
          assignedOwners: owners,
          topPriority,
          payerBreakdown,
          suggestedCorrection: correctionTemplateFor(code === "UNKNOWN" ? "" : code),
          claims,
        };
      })
      .sort((a, b) => b.totalDeniedAmount - a.totalDeniedAmount);

    // 4) Counts for the top CARC tabs (always include the canonical five).
    const topCounts: Record<string, number> = {};
    for (const code of TOP_CARC_CODES) topCounts[code] = 0;
    for (const g of carcGroups) {
      if ((TOP_CARC_CODES as readonly string[]).includes(g.carcCode)) {
        topCounts[g.carcCode] = g.claimCount;
      }
    }

    const totalClaims = claimRows.length;
    const totalDollars = Math.round(
      carcGroups.reduce((s, g) => s + g.totalDeniedAmount, 0) * 100,
    ) / 100;
    const allAges = claimRows
      .map((c) => ageDays(c.updated_at) ?? ageDays(c.created_at))
      .filter((a): a is number => a != null);
    const oldest = allAges.length ? Math.max(...allAges) : 0;
    const urgent = carcGroups
      .flatMap((g) => g.claims)
      .filter((c) => (c.ageDays ?? 0) > 60).length;

    return NextResponse.json({
      success: true,
      organizationId,
      summary: {
        totalClaims,
        totalDollars,
        oldestAgeDays: oldest,
        urgentCount: urgent,
      },
      groups: carcGroups,
      topCounts,
      templates: ((templates as DbRow[]) ?? []).map((t) => ({
        id: text(t.id),
        name: text(t.name),
        body: text(t.body),
        isSystem: Boolean(t.is_system),
      })),
    });
  } catch (error) {
    console.error("denials-by-carc API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "denials-by-carc failed",
      },
      { status: 500 },
    );
  }
}
