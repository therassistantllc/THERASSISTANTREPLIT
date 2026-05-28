/**
 * GET /api/billing/paper-checks/search-claims
 *   ?organizationId=&q=&payerId=&excludePaperCheckId=&limit=
 *
 * Searchable claim picker used by the Match Claims modal in the
 * Paper Checks workqueue. Returns open professional claims with
 * client name, DOS, claim number, charge and a remaining balance
 * (total_charge minus what's already been applied from paper checks).
 *
 * Filters:
 *   - q          client name OR claim_number / patient_account_number
 *   - payerId    payer_profile_id; usually pre-set to the check's payer
 *   - excludePaperCheckId — drop claims already matched on THIS check
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: url.searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { ok: false, error: "Database connection not available" },
        { status: 503 },
      );
    }

    const q = (url.searchParams.get("q") ?? "").trim();
    const payerId = (url.searchParams.get("payerId") ?? "").trim();
    const excludeCheckId = (url.searchParams.get("excludePaperCheckId") ?? "").trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 25), 1), 100);

    // Step 1: optional client name pre-filter so we can search by name.
    let nameMatchedPatientIds: string[] | null = null;
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean).slice(0, 3);
      let pq = (supabase as any)
        .from("clients")
        .select("id")
        .eq("organization_id", organizationId)
        .limit(200);
      for (const t of tokens) {
        const safe = t.replace(/[%_]/g, "");
        pq = pq.or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`);
      }
      const { data: patientHits, error: pErr } = await pq;
      if (pErr) throw pErr;
      nameMatchedPatientIds = ((patientHits ?? []) as DbRow[])
        .map((p) => text(p.id))
        .filter(Boolean);
    }

    // Step 2: claim query.
    let cq = (supabase as any)
      .from("professional_claims")
      .select(
        "id, claim_number, patient_account_number, patient_id, payer_profile_id, claim_status, total_charge, payer_responsibility_amount, patient_responsibility_amount, first_billed_date, created_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("first_billed_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (payerId) cq = cq.eq("payer_profile_id", payerId);

    if (q) {
      const safe = q.replace(/[%_]/g, "");
      const ors: string[] = [
        `claim_number.ilike.%${safe}%`,
        `patient_account_number.ilike.%${safe}%`,
      ];
      if (nameMatchedPatientIds && nameMatchedPatientIds.length > 0) {
        ors.push(`patient_id.in.(${nameMatchedPatientIds.join(",")})`);
      }
      cq = cq.or(ors.join(","));
    }

    const { data: claims, error: cErr } = await cq;
    if (cErr) throw cErr;
    const claimList = (claims ?? []) as DbRow[];
    const claimIds = claimList.map((c) => text(c.id)).filter(Boolean);

    // Step 3: pull DOS from service_lines (one batch), client names, applied totals.
    const patientIds = [
      ...new Set(claimList.map((c) => text(c.patient_id)).filter(Boolean)),
    ];

    const [{ data: patientRows }, { data: appliedRows }, { data: serviceLineRows }] =
      await Promise.all([
        patientIds.length
          ? (supabase as any)
              .from("clients")
              .select("id, first_name, last_name")
              .in("id", patientIds)
          : Promise.resolve({ data: [] as DbRow[] }),
        claimIds.length
          ? (supabase as any)
              .from("paper_check_claim_matches")
              .select("claim_id, applied_amount, paper_check_id")
              .eq("organization_id", organizationId)
              .in("claim_id", claimIds)
          : Promise.resolve({ data: [] as DbRow[] }),
        claimIds.length
          ? (supabase as any)
              .from("claim_service_lines")
              .select("claim_id, service_date")
              .in("claim_id", claimIds)
          : Promise.resolve({ data: [] as DbRow[] }),
      ]);

    const patientById = new Map<string, DbRow>(
      ((patientRows ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );

    const appliedByClaim = new Map<string, number>();
    const alreadyOnCheck = new Set<string>();
    for (const r of ((appliedRows ?? []) as DbRow[])) {
      const cid = text(r.claim_id);
      appliedByClaim.set(cid, (appliedByClaim.get(cid) ?? 0) + money(r.applied_amount));
      if (excludeCheckId && text(r.paper_check_id) === excludeCheckId) {
        alreadyOnCheck.add(cid);
      }
    }

    const dosByClaim = new Map<string, { from: string | null; to: string | null }>();
    for (const r of ((serviceLineRows ?? []) as DbRow[])) {
      const cid = text(r.claim_id);
      const d = (r.service_date as string | null) ?? null;
      if (!d) continue;
      const existing = dosByClaim.get(cid);
      if (!existing) {
        dosByClaim.set(cid, { from: d, to: d });
      } else {
        if (!existing.from || d < existing.from) existing.from = d;
        if (!existing.to || d > existing.to) existing.to = d;
      }
    }

    const results = claimList
      .map((c) => {
        const id = text(c.id);
        const client = patientById.get(text(c.patient_id));
        const patientName = client
          ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") ||
            null
          : null;
        const charge = money(c.total_charge);
        const appliedFromPaperChecks = appliedByClaim.get(id) ?? 0;
        const balance = Math.round((charge - appliedFromPaperChecks) * 100) / 100;
        const dos = dosByClaim.get(id) ?? { from: null, to: null };
        return {
          id,
          claim_number: text(c.claim_number) || null,
          patient_account_number: text(c.patient_account_number) || null,
          patient_id: text(c.patient_id) || null,
          patient_name: patientName,
          payer_profile_id: text(c.payer_profile_id) || null,
          claim_status: text(c.claim_status) || null,
          date_of_service_from: dos.from,
          date_of_service_to: dos.to,
          total_charge: charge,
          payer_responsibility_amount: money(c.payer_responsibility_amount),
          patient_responsibility_amount: money(c.patient_responsibility_amount),
          applied_from_paper_checks: Math.round(appliedFromPaperChecks * 100) / 100,
          balance,
          already_matched_on_check: alreadyOnCheck.has(id),
        };
      })
      .filter((r) => !r.already_matched_on_check);

    return NextResponse.json({ ok: true, success: true, claims: results });
  } catch (err) {
    console.error("Paper checks search-claims error:", err);
    return NextResponse.json(
      { ok: false, success: false, error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
