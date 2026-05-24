import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { lookupRarc, type RarcCatalogEntry } from "@/lib/billing/rarcCatalog";

type DbRow = Record<string, any>;

function text(v: unknown) {
  return String(v ?? "").trim();
}
function money(v: unknown) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000));
}

function extractRarcCodes(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, any>;
  const out = new Set<string>();
  const direct =
    p.rarc_codes ?? p.rarcCodes ?? p.remark_codes ?? p.remarkCodes ?? null;
  if (Array.isArray(direct)) {
    for (const c of direct) {
      const s = text(c).toUpperCase();
      if (s) out.add(s);
    }
  }
  const single = text(p.rarc_code ?? p.rarcCode ?? "").toUpperCase();
  if (single) out.add(single);
  // CAS / MOA-style nested structures
  const adjustments = p.adjustments ?? p.cas_adjustments ?? null;
  if (Array.isArray(adjustments)) {
    for (const a of adjustments) {
      if (!a || typeof a !== "object") continue;
      const r = (a as any).rarc_code ?? (a as any).remark_code;
      const s = text(r).toUpperCase();
      if (s) out.add(s);
    }
  }
  return Array.from(out);
}

function extractCarcCodes(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, any>;
  const out = new Set<string>();
  const direct = p.carc_codes ?? p.carcCodes ?? null;
  if (Array.isArray(direct)) {
    for (const c of direct) {
      const s = text(c).toUpperCase();
      if (s) out.add(s);
    }
  }
  const single = text(p.carc_code ?? p.carcCode ?? "").toUpperCase();
  if (single) out.add(single);
  return Array.from(out);
}

interface RarcClaimRow {
  claimId: string;
  claimNumber: string;
  patientId: string;
  patientName: string;
  payerProfileId: string | null;
  payerName: string;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  totalCharge: number;
  deniedAmount: number;
  ageDays: number | null;
  carcCode: string | null;
  status: string;
  assignedBiller: string;
  followUpDue: string | null;
  practice: string;
  clinician: string;
}

interface MatchingPayerRule {
  id: string;
  payer: string | null;
  rarcCode: string | null;
  carcCode: string | null;
  rule: string;
  recommendedAction: string | null;
  scope: "payer_specific" | "any_payer";
  updatedAt: string | null;
}

interface RarcGroup {
  id: string;
  rarcCode: string;
  rarcMessage: string;
  relatedCarc: string | null;
  claimCount: number;
  deniedAmount: number;
  payer: string;
  payerBreakdown: Array<{ payer: string; count: number; amount: number }>;
  recommendedAction: string;
  catalogRecommendedAction: string;
  payerExplanation: string;
  suggestedCorrection: string;
  priority: RarcCatalogEntry["priority"];
  oldestAgeDays: number;
  urgentCount: number;
  claims: RarcClaimRow[];
  matchingRule: MatchingPayerRule | null;
  workedClaimCount: number;
  suggestRule: boolean;
}

const WORKED_RULE_THRESHOLD = 2;

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

    // Page through ALL denied claims — supabase-js caps a single request
    // at 1000 rows, so we fetch in 1000-row windows until we've drained
    // the queue. A hard ceiling of 25k rows protects against runaway
    // queries while still covering very large orgs.
    const PAGE_SIZE = 1000;
    const MAX_ROWS = 25000;
    const claimRows: DbRow[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
      const to = Math.min(from + PAGE_SIZE - 1, MAX_ROWS - 1);
      const { data: page, error: claimsErr } = await (supabase as any)
        .from("professional_claims")
        .select(
          "id, claim_number, patient_id, payer_profile_id, total_charge, denial_reason_code, denial_reason_description, days_in_ar, updated_at, encounter_id, appeal_deadline_date",
        )
        .eq("organization_id", organizationId)
        .eq("claim_status", "denied")
        .order("updated_at", { ascending: false })
        .range(from, to);
      if (claimsErr) throw claimsErr;
      const rows = (page as DbRow[]) ?? [];
      claimRows.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }

    const claimIds = claimRows.map((c) => text(c.id)).filter(Boolean);
    const patientIds = [
      ...new Set(claimRows.map((c) => text(c.patient_id)).filter(Boolean)),
    ];
    const payerProfileIds = [
      ...new Set(
        claimRows.map((c) => text(c.payer_profile_id)).filter(Boolean),
      ),
    ];
    const encounterIds = [
      ...new Set(claimRows.map((c) => text(c.encounter_id)).filter(Boolean)),
    ];

    const [
      { data: patients },
      { data: payerProfiles },
      { data: serviceLines },
      { data: statusEvents },
      { data: eraPayments },
      { data: workqueueItems },
      { data: encounters },
      { data: payerRules },
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
            .from("claim_status_events")
            .select("claim_id, status_message, raw_payload, created_at")
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("era_claim_payments")
            .select(
              "professional_claim_id, carc_codes, rarc_codes, clp04_payment_amount, clp03_total_charge",
            )
            .in("professional_claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_workqueue_items")
            .select(
              "claim_id, carc_code, rarc_code, priority, item_status, assigned_to_user_id, assigned_to:assigned_to_user_id(id, first_name, last_name, email)",
            )
            .in("claim_id", claimIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as DbRow[] }),
      encounterIds.length
        ? (supabase as any)
            .from("encounters")
            .select(
              "id, organization_id, clinician_id, clinician:clinician_id(id, first_name, last_name)",
            )
            .in("id", encounterIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      (supabase as any)
        .from("payer_rules")
        .select(
          "id, payer_name, rarc_code, carc_code, rule, recommended_action, updated_at",
        )
        .eq("organization_id", organizationId)
        .is("archived_at", null),
    ]);

    const patientById = new Map<string, DbRow>(
      ((patients as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payerProfiles as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );

    const serviceLinesByClaim = new Map<string, DbRow[]>();
    for (const sl of (serviceLines as DbRow[]) ?? []) {
      const cid = text(sl.claim_id);
      if (!serviceLinesByClaim.has(cid)) serviceLinesByClaim.set(cid, []);
      serviceLinesByClaim.get(cid)!.push(sl);
    }

    // Collect rarc + carc info per claim. Source priority:
    //   1. claim_workqueue_items (clean structured fields)
    //   2. era_claim_payments arrays
    //   3. claim_status_events raw_payload heuristics
    const rarcByClaim = new Map<string, Set<string>>();
    const carcByClaim = new Map<string, Set<string>>();
    const priorityByClaim = new Map<string, string>();
    const deniedAmountByClaim = new Map<string, number>();

    const statusByClaim = new Map<string, string>();
    const assigneeByClaim = new Map<string, string>();
    const workedClaimIds = new Set<string>();
    for (const w of (workqueueItems as DbRow[]) ?? []) {
      const cid = text(w.claim_id);
      const itemStatus = text(w.item_status).toLowerCase();
      if (
        itemStatus === "in_progress" ||
        itemStatus === "resolved" ||
        itemStatus === "snoozed" ||
        text(w.assigned_to_user_id)
      ) {
        workedClaimIds.add(cid);
      }
      const r = text(w.rarc_code).toUpperCase();
      const c = text(w.carc_code).toUpperCase();
      if (r) {
        if (!rarcByClaim.has(cid)) rarcByClaim.set(cid, new Set());
        rarcByClaim.get(cid)!.add(r);
      }
      if (c) {
        if (!carcByClaim.has(cid)) carcByClaim.set(cid, new Set());
        carcByClaim.get(cid)!.add(c);
      }
      const p = text(w.priority);
      if (p) priorityByClaim.set(cid, p);
      const st = text(w.item_status);
      if (st) statusByClaim.set(cid, st);
      const a = (w as any).assigned_to;
      if (a && typeof a === "object") {
        const nm =
          [a.first_name, a.last_name].map(text).filter(Boolean).join(" ") ||
          text(a.email);
        if (nm) assigneeByClaim.set(cid, nm);
      }
    }
    const encounterById = new Map<string, DbRow>(
      ((encounters as DbRow[]) ?? []).map((e) => [text(e.id), e]),
    );
    for (const e of (eraPayments as DbRow[]) ?? []) {
      const cid = text(e.professional_claim_id);
      const rarcs = Array.isArray(e.rarc_codes) ? e.rarc_codes : [];
      const carcs = Array.isArray(e.carc_codes) ? e.carc_codes : [];
      for (const r of rarcs) {
        const s = text(r).toUpperCase();
        if (!s) continue;
        if (!rarcByClaim.has(cid)) rarcByClaim.set(cid, new Set());
        rarcByClaim.get(cid)!.add(s);
      }
      for (const c of carcs) {
        const s = text(c).toUpperCase();
        if (!s) continue;
        if (!carcByClaim.has(cid)) carcByClaim.set(cid, new Set());
        carcByClaim.get(cid)!.add(s);
      }
      const charge = money(e.clp03_total_charge);
      const paid = money(e.clp04_payment_amount);
      const denied = Math.max(0, Math.round((charge - paid) * 100) / 100);
      if (denied > 0) {
        deniedAmountByClaim.set(
          cid,
          (deniedAmountByClaim.get(cid) ?? 0) + denied,
        );
      }
    }
    // Fallback: pull from latest status event raw_payload
    const seenStatusForClaim = new Set<string>();
    for (const ev of (statusEvents as DbRow[]) ?? []) {
      const cid = text(ev.claim_id);
      if (seenStatusForClaim.has(cid)) continue;
      seenStatusForClaim.add(cid);
      if (!rarcByClaim.has(cid) || rarcByClaim.get(cid)!.size === 0) {
        const codes = extractRarcCodes(ev.raw_payload);
        if (codes.length) {
          if (!rarcByClaim.has(cid)) rarcByClaim.set(cid, new Set());
          codes.forEach((c) => rarcByClaim.get(cid)!.add(c));
        }
      }
      if (!carcByClaim.has(cid) || carcByClaim.get(cid)!.size === 0) {
        const codes = extractCarcCodes(ev.raw_payload);
        if (codes.length) {
          if (!carcByClaim.has(cid)) carcByClaim.set(cid, new Set());
          codes.forEach((c) => carcByClaim.get(cid)!.add(c));
        }
      }
    }

    // Build per-claim rows, then group by RARC.
    const allClaims: RarcClaimRow[] = claimRows.map((c) => {
      const cid = text(c.id);
      const patient = patientById.get(text(c.patient_id));
      const payer = payerById.get(text(c.payer_profile_id));
      const lines = serviceLinesByClaim.get(cid) ?? [];
      const dosFrom = lines.length ? text(lines[0].service_date_from) || null : null;
      const dosTo = lines.length
        ? text(lines[lines.length - 1].service_date_to) ||
          text(lines[lines.length - 1].service_date_from) ||
          null
        : null;
      const totalCharge = money(c.total_charge);
      const carcSet = carcByClaim.get(cid);
      const firstCarc = carcSet && carcSet.size > 0 ? Array.from(carcSet)[0] : null;
      const enc = encounterById.get(text(c.encounter_id));
      const clinicianRow: any = enc?.clinician ?? null;
      const clinicianName = clinicianRow
        ? [clinicianRow.first_name, clinicianRow.last_name]
            .map(text)
            .filter(Boolean)
            .join(" ") || ""
        : "";
      return {
        claimId: cid,
        claimNumber: text(c.claim_number) || cid.slice(0, 8),
        patientId: text(c.patient_id),
        patientName: patient
          ? [patient.first_name, patient.last_name].map(text).filter(Boolean).join(" ") ||
            "Unknown patient"
          : "Unknown patient",
        payerProfileId: text(c.payer_profile_id) || null,
        payerName: text(payer?.payer_name) || "Unknown payer",
        serviceDateFrom: dosFrom,
        serviceDateTo: dosTo,
        totalCharge,
        deniedAmount: deniedAmountByClaim.get(cid) ?? totalCharge,
        ageDays: daysSince(c.updated_at),
        carcCode: firstCarc,
        status: statusByClaim.get(cid) || "denied",
        assignedBiller: assigneeByClaim.get(cid) || "",
        followUpDue: text(c.appeal_deadline_date) || null,
        practice: text(enc?.organization_id) || organizationId,
        clinician: clinicianName,
      };
    });

    const groupMap = new Map<string, RarcGroup>();
    for (const c of claimRows) {
      const cid = text(c.id);
      const claim = allClaims.find((x) => x.claimId === cid);
      if (!claim) continue;
      const rarcSet = rarcByClaim.get(cid);
      const codes =
        rarcSet && rarcSet.size > 0 ? Array.from(rarcSet) : ["UNSPECIFIED"];
      for (const rawCode of codes) {
        const code = rawCode || "UNSPECIFIED";
        const catalog = lookupRarc(code === "UNSPECIFIED" ? "" : code);
        let group = groupMap.get(code);
        if (!group) {
          group = {
            id: code,
            rarcCode: code,
            rarcMessage:
              code === "UNSPECIFIED"
                ? "No remark code on file (likely missing from payer response)"
                : catalog.message,
            relatedCarc: catalog.relatedCarc ?? claim.carcCode,
            claimCount: 0,
            deniedAmount: 0,
            payer: "",
            payerBreakdown: [],
            recommendedAction:
              code === "UNSPECIFIED"
                ? "Pull the raw 835/277 to identify the actual remark code."
                : catalog.recommendedAction,
            catalogRecommendedAction:
              code === "UNSPECIFIED"
                ? "Pull the raw 835/277 to identify the actual remark code."
                : catalog.recommendedAction,
            payerExplanation: catalog.payerExplanation,
            suggestedCorrection: catalog.suggestedCorrection,
            priority: catalog.priority,
            oldestAgeDays: 0,
            urgentCount: 0,
            claims: [],
            matchingRule: null,
            workedClaimCount: 0,
            suggestRule: false,
          };
          groupMap.set(code, group);
        }
        group.claims.push(claim);
        group.claimCount += 1;
        group.deniedAmount =
          Math.round((group.deniedAmount + claim.deniedAmount) * 100) / 100;
        if (typeof claim.ageDays === "number") {
          group.oldestAgeDays = Math.max(group.oldestAgeDays, claim.ageDays);
          if (claim.ageDays > 60) group.urgentCount += 1;
        }
        // Update payer breakdown
        const pbk = group.payerBreakdown.find((p) => p.payer === claim.payerName);
        if (pbk) {
          pbk.count += 1;
          pbk.amount = Math.round((pbk.amount + claim.deniedAmount) * 100) / 100;
        } else {
          group.payerBreakdown.push({
            payer: claim.payerName,
            count: 1,
            amount: claim.deniedAmount,
          });
        }
        // Promote priority if any claim has urgent workqueue priority
        const p = priorityByClaim.get(cid);
        if (p === "urgent") group.priority = "urgent";
        else if (p === "high" && group.priority !== "urgent")
          group.priority = "high";
      }
    }

    // Pick a primary payer label for each group (most claims)
    for (const g of groupMap.values()) {
      g.payerBreakdown.sort((a, b) => b.count - a.count);
      g.payer =
        g.payerBreakdown.length === 1
          ? g.payerBreakdown[0].payer
          : g.payerBreakdown.length > 1
            ? `${g.payerBreakdown[0].payer} +${g.payerBreakdown.length - 1}`
            : "—";
    }

    // Attach matching payer rule + count of "worked" claims per group so
    // the UI can pre-fill correction templates and nudge billers to save
    // a rule when they've worked the same payer/RARC repeatedly.
    const rules = ((payerRules as DbRow[]) ?? []).map((r) => ({
      id: text(r.id),
      payerName: text(r.payer_name) || null,
      payerNameLower: text(r.payer_name).toLowerCase() || null,
      rarcCode: text(r.rarc_code).toUpperCase() || null,
      carcCode: text(r.carc_code).toUpperCase() || null,
      rule: text(r.rule),
      recommendedAction: text(r.recommended_action) || null,
      updatedAt: text(r.updated_at) || null,
    }));

    for (const g of groupMap.values()) {
      // Count distinct worked claims tied to this group
      const workedSet = new Set<string>();
      for (const c of g.claims) {
        if (workedClaimIds.has(c.claimId)) workedSet.add(c.claimId);
      }
      g.workedClaimCount = workedSet.size;

      // Find the best-matching active rule. Priority:
      //   1. payer-specific match on (payer + rarc) — most recently updated
      //   2. any-payer match on rarc — most recently updated
      const groupRarc = g.rarcCode === "UNSPECIFIED" ? null : g.rarcCode;
      if (groupRarc) {
        const payerNamesLower = g.payerBreakdown
          .map((p) => p.payer.toLowerCase())
          .filter(Boolean);
        const rarcMatches = rules.filter((r) => r.rarcCode === groupRarc);
        const sortByUpdated = (a: typeof rules[number], b: typeof rules[number]) =>
          (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
        const payerSpecific = rarcMatches
          .filter(
            (r) =>
              r.payerNameLower !== null &&
              payerNamesLower.includes(r.payerNameLower),
          )
          .sort(sortByUpdated);
        const anyPayer = rarcMatches
          .filter((r) => r.payerNameLower === null)
          .sort(sortByUpdated);
        const best = payerSpecific[0] ?? anyPayer[0] ?? null;
        if (best) {
          g.matchingRule = {
            id: best.id,
            payer: best.payerName,
            rarcCode: best.rarcCode,
            carcCode: best.carcCode,
            rule: best.rule,
            recommendedAction: best.recommendedAction,
            scope: best.payerName ? "payer_specific" : "any_payer",
            updatedAt: best.updatedAt,
          };
          // Pre-fill the surfaced recommended action with the saved rule's
          // action when present (falls back to catalog otherwise).
          if (best.recommendedAction) {
            g.recommendedAction = best.recommendedAction;
          }
        }
      }

      // Nudge: no rule yet, but billers have worked >= N claims in this
      // group. Encourage capturing the fix as reusable guidance.
      g.suggestRule =
        !g.matchingRule && g.workedClaimCount >= WORKED_RULE_THRESHOLD;
    }

    const groups = Array.from(groupMap.values()).sort(
      (a, b) => b.deniedAmount - a.deniedAmount,
    );

    return NextResponse.json({
      success: true,
      organizationId,
      groups,
      claimCount: claimRows.length,
    });
  } catch (error) {
    console.error("Denials-by-RARC API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Denials-by-RARC API failed",
      },
      { status: 500 },
    );
  }
}
