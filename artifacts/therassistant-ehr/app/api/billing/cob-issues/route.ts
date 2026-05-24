/**
 * GET /api/billing/cob-issues
 *
 * "COB Issues" workqueue: claims that need a coordination-of-benefits
 * decision before they can be (re)billed. Tabs are derived from the
 * client's insurance_policies plus a `cob_*` audit overlay that
 * records the biller's last decision (request EOB, route to client,
 * etc.).
 *
 * Tabs:
 *   - other_insurance_found        Client has 2+ active policies but the
 *                                  claim was billed to only one.
 *   - primary_secondary_conflict   Claim was billed to a non-primary
 *                                  payer, OR the client has more than
 *                                  one active 'primary' policy.
 *   - medicaid_cob                 Client has a Medicaid policy alongside
 *                                  another commercial/medicare payer.
 *   - client_update_needed         Biller has routed the claim back to
 *                                  the client/admin for an insurance
 *                                  update (via the action route), or the
 *                                  client has only one policy on file
 *                                  but the claim was COB-flagged.
 *   - eob_needed                   Claim was billed to a secondary payer
 *                                  but no prior-payer EOB has been
 *                                  recorded yet.
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

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function agingBucket(days: number | null): "0_30" | "31_60" | "61_90" | "90_plus" {
  const d = days ?? 0;
  if (d <= 30) return "0_30";
  if (d <= 60) return "31_60";
  if (d <= 90) return "61_90";
  return "90_plus";
}

function priorityFor(days: number | null, hasMedicaid: boolean): "low" | "medium" | "high" | "critical" {
  const d = days ?? 0;
  if (d >= 75) return "critical";
  if (d >= 45) return "high";
  if (hasMedicaid || d >= 21) return "medium";
  return "low";
}

export type CobTab =
  | "other_insurance_found"
  | "primary_secondary_conflict"
  | "medicaid_cob"
  | "client_update_needed"
  | "eob_needed";

export type CobState =
  | "open"
  | "awaiting_eob"
  | "client_update_needed"
  | "billing_in_progress"
  | "resolved";

export interface CobPolicySummary {
  id: string;
  priority: string;
  payer_id: string | null;
  payer_name: string | null;
  payer_type: string | null;
  policy_number: string | null;
  effective_date: string | null;
  termination_date: string | null;
  active: boolean;
}

export interface CobRow {
  id: string;            // professional_claims.id
  claim_number: string;
  client_id: string | null;
  client_name: string;
  payer_billed_id: string | null;
  payer_billed_name: string | null;
  other_payer_name: string | null;
  cob_issue: string;
  date_of_service: string | null;
  charge_amount: number;
  patient_contact_needed: boolean;
  status: string;        // human label of the queue state
  state: CobState;       // machine state
  tabs: CobTab[];
  policies: CobPolicySummary[];
  has_eob: boolean;
  eob_requested_at: string | null;
  eob_request_count: number;
  last_action_at: string | null;
  days_since_dos: number | null;
  aging_bucket: string;
  priority: "low" | "medium" | "high" | "critical";
  clinician_id: string | null;
  clinician_name: string | null;
  has_medicaid: boolean;
}

export interface CobSummary {
  total_count: number;
  total_dollars: number;
  oldest_age_days: number | null;
  urgent_count: number;
  by_tab: Record<CobTab, number>;
}

const ACTION_EVENT_PREFIX = "cob_";

function emptySummary(): CobSummary {
  return {
    total_count: 0,
    total_dollars: 0,
    oldest_age_days: null,
    urgent_count: 0,
    by_tab: {
      other_insurance_found: 0,
      primary_secondary_conflict: 0,
      medicaid_cob: 0,
      client_update_needed: 0,
      eob_needed: 0,
    },
  };
}

function stateLabel(s: CobState): string {
  switch (s) {
    case "open": return "Open";
    case "awaiting_eob": return "Awaiting EOB";
    case "client_update_needed": return "Client update needed";
    case "billing_in_progress": return "Billing in progress";
    case "resolved": return "Resolved";
  }
}

// Claim statuses that count as "transmitted" — used to auto-resolve a
// COB row once the (re-pointed primary or cloned secondary) claim has
// actually left the building.
const TRANSMITTED_CLAIM_STATUSES = new Set([
  "submitted",
  "accepted_oa",
  "accepted_payer",
  "rejected_oa",
  "rejected_payer",
  "paid",
  "denied",
]);

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

    const filterTab = (searchParams.get("tab") ?? "").trim() as CobTab | "";
    const filterClinician = (searchParams.get("clinician") ?? "").trim();
    const filterPayer = (searchParams.get("payer") ?? "").trim();
    const filterClient = (searchParams.get("client") ?? "").trim();
    const filterDosFrom = (searchParams.get("dosFrom") ?? "").trim();
    const filterDosTo = (searchParams.get("dosTo") ?? "").trim();
    const filterStatus = (searchParams.get("status") ?? "open").trim();
    const filterPriority = (searchParams.get("priority") ?? "").trim();
    const filterAgingBucket = (searchParams.get("agingBucket") ?? "").trim();
    const filterMinAmount = Number(searchParams.get("minAmount") ?? "");
    const filterMaxAmount = Number(searchParams.get("maxAmount") ?? "");

    // ── 1. Pull recent claims (any non-draft, any status — the COB
    //      queue spans pre- and post-payment work). ───────────────────
    const lookbackFrom = new Date();
    lookbackFrom.setMonth(lookbackFrom.getMonth() - 18);

    const { data: claimRows, error: claimsErr } = await (supabase as any)
      .from("professional_claims")
      .select(
        "id, organization_id, patient_id, appointment_id, payer_profile_id, claim_number, claim_status, total_charge, created_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .gte("created_at", lookbackFrom.toISOString())
      .order("created_at", { ascending: false })
      .limit(2000);
    if (claimsErr) throw claimsErr;

    const claims = (claimRows ?? []) as DbRow[];
    if (claims.length === 0) {
      return NextResponse.json({
        success: true,
        organizationId,
        items: [],
        summary: emptySummary(),
      });
    }

    const claimIds = claims.map((c) => text(c.id)).filter(Boolean);
    const clientIds = [...new Set(claims.map((c) => text(c.patient_id)).filter(Boolean))];
    const apptIds = [...new Set(claims.map((c) => text(c.appointment_id)).filter(Boolean))];

    const [
      { data: policies },
      { data: clients },
      { data: appts },
      { data: payerProfiles },
      { data: audit },
      { data: cobSignals },
      { data: eligibilityOtherPayers },
    ] = await Promise.all([
      clientIds.length
        ? (supabase as any)
            .from("insurance_policies")
            .select(
              "id, client_id, payer_id, priority, plan_name, policy_number, effective_date, termination_date, active_flag, archived_at",
            )
            .eq("organization_id", organizationId)
            .in("client_id", clientIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as DbRow[] }),
      clientIds.length
        ? (supabase as any)
            .from("clients")
            .select("id, first_name, last_name")
            .in("id", clientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      apptIds.length
        ? (supabase as any)
            .from("appointments")
            .select("id, provider_id, scheduled_start_at")
            .in("id", apptIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      (supabase as any)
        .from("payer_profiles")
        .select("id, payer_name, payer_type")
        .eq("organization_id", organizationId),
      (supabase as any)
        .from("audit_logs")
        .select("claim_id, event_type, event_metadata, created_at, user_id")
        .eq("organization_id", organizationId)
        .in("claim_id", claimIds)
        .ilike("event_type", `${ACTION_EVENT_PREFIX}%`)
        .order("created_at", { ascending: true }),
      // Task #457 — real COB evidence from the 835 (CO-22, MOA other-
      // payer paid). When present, these win over the policy-count
      // heuristic when classifying tabs and naming the other payer.
      (supabase as any)
        .from("claim_cob_signals")
        .select("professional_claim_id, signal_type, other_payer_name, other_payer_id, other_payer_paid_amount, created_at")
        .eq("organization_id", organizationId)
        .in("professional_claim_id", claimIds),
      // Task #457 — 271 other-payer evidence keyed by client.
      clientIds.length
        ? (supabase as any)
            .from("eligibility_checks")
            .select("client_id, other_payers, other_payer_name, other_payer_id, checked_at")
            .eq("organization_id", organizationId)
            .in("client_id", clientIds)
            .not("other_payers", "is", null)
            .order("checked_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const providerIds = [
      ...new Set(((appts ?? []) as DbRow[]).map((a) => text(a.provider_id)).filter(Boolean)),
    ];
    const { data: providers } = providerIds.length
      ? await (supabase as any)
          .from("providers")
          .select("id, first_name, last_name, display_name")
          .in("id", providerIds)
      : { data: [] as DbRow[] };

    // ── 2. Build lookup maps ─────────────────────────────────────────
    const policiesByClient = new Map<string, DbRow[]>();
    for (const p of ((policies ?? []) as DbRow[])) {
      const k = text(p.client_id);
      if (!k) continue;
      const arr = policiesByClient.get(k) ?? [];
      arr.push(p);
      policiesByClient.set(k, arr);
    }
    const clientById = new Map<string, DbRow>(
      ((clients ?? []) as DbRow[]).map((c) => [text(c.id), c]),
    );
    const apptById = new Map<string, DbRow>(
      ((appts ?? []) as DbRow[]).map((a) => [text(a.id), a]),
    );
    const providerById = new Map<string, DbRow>(
      ((providers ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payerProfiles ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );

    // ── COB signal lookup tables (Task #457) ─────────────────────────
    type CobSignalAgg = {
      hasCo22: boolean;
      hasOtherPayerPaid: boolean;
      otherPayerName: string | null;
      otherPayerId: string | null;
      otherPayerPaidAmount: number | null;
    };
    const cobSignalsByClaim = new Map<string, CobSignalAgg>();
    for (const s of ((cobSignals ?? []) as DbRow[])) {
      const k = text(s.professional_claim_id);
      if (!k) continue;
      const cur = cobSignalsByClaim.get(k) ?? {
        hasCo22: false,
        hasOtherPayerPaid: false,
        otherPayerName: null,
        otherPayerId: null,
        otherPayerPaidAmount: null,
      };
      const signalType = text(s.signal_type);
      if (signalType === "co_22") cur.hasCo22 = true;
      if (signalType === "other_payer_paid") {
        cur.hasOtherPayerPaid = true;
        const amt = Number(s.other_payer_paid_amount ?? 0);
        if (Number.isFinite(amt) && (cur.otherPayerPaidAmount == null || amt > cur.otherPayerPaidAmount)) {
          cur.otherPayerPaidAmount = amt;
        }
      }
      if (!cur.otherPayerName) cur.otherPayerName = text(s.other_payer_name) || null;
      if (!cur.otherPayerId) cur.otherPayerId = text(s.other_payer_id) || null;
      cobSignalsByClaim.set(k, cur);
    }

    type EligibilityOtherPayer = {
      name: string | null;
      payerId: string | null;
    };
    const eligibilityOtherPayersByClient = new Map<string, EligibilityOtherPayer[]>();
    for (const row of ((eligibilityOtherPayers ?? []) as DbRow[])) {
      const k = text(row.client_id);
      if (!k || eligibilityOtherPayersByClient.has(k)) continue; // most recent first
      const list: EligibilityOtherPayer[] = [];
      const headlineName = text(row.other_payer_name) || null;
      const headlineId = text(row.other_payer_id) || null;
      if (headlineName || headlineId) list.push({ name: headlineName, payerId: headlineId });
      const arr = Array.isArray(row.other_payers) ? (row.other_payers as Array<Record<string, unknown>>) : [];
      for (const entry of arr) {
        const name = text(entry.name) || null;
        const payerId = text(entry.payerId) || null;
        if (!name && !payerId) continue;
        if (list.some((e) => (e.name && e.name === name) || (e.payerId && e.payerId === payerId))) continue;
        list.push({ name, payerId });
      }
      if (list.length > 0) eligibilityOtherPayersByClient.set(k, list);
    }

    type AuditAgg = {
      state: CobState;
      has_eob: boolean;
      eob_requested_at: string | null;
      eob_request_count: number;
      last_action_at: string | null;
      ordered_policy_ids: string[];
      cob_flagged: boolean;
      // After a successful bill_primary/bill_secondary the action route
      // stamps the resulting child claim id (secondary) or just marks
      // the original re-pointed (primary). The reducer holds the row
      // in `billing_in_progress` and flips to `resolved` only once the
      // relevant claim transmits.
      billed_role: "primary" | "secondary" | null;
      child_claim_id: string | null;
    };
    const auditByClaim = new Map<string, AuditAgg>();
    for (const a of ((audit ?? []) as DbRow[])) {
      const k = text(a.claim_id);
      if (!k) continue;
      const cur = auditByClaim.get(k) ?? {
        state: "open" as CobState,
        has_eob: false,
        eob_requested_at: null as string | null,
        eob_request_count: 0,
        last_action_at: null as string | null,
        ordered_policy_ids: [] as string[],
        cob_flagged: false,
        billed_role: null as "primary" | "secondary" | null,
        child_claim_id: null as string | null,
      };
      const ev = text(a.event_type);
      const md = (a.event_metadata as Record<string, unknown> | null) ?? {};
      const created = text(a.created_at);
      cur.last_action_at = created;
      switch (ev) {
        case `${ACTION_EVENT_PREFIX}update_insurance_order`: {
          const ids = Array.isArray(md.ordered_policy_ids)
            ? (md.ordered_policy_ids as unknown[]).map((x) => String(x))
            : [];
          cur.ordered_policy_ids = ids;
          cur.cob_flagged = true;
          break;
        }
        case `${ACTION_EVENT_PREFIX}bill_primary`:
          cur.state = "billing_in_progress";
          cur.billed_role = "primary";
          break;
        case `${ACTION_EVENT_PREFIX}bill_secondary`:
          cur.state = "billing_in_progress";
          cur.billed_role = "secondary";
          cur.child_claim_id = text(md.child_claim_id) || cur.child_claim_id;
          break;
        case `${ACTION_EVENT_PREFIX}request_eob`:
          cur.state = "awaiting_eob";
          cur.eob_requested_at = created;
          cur.eob_request_count += 1;
          break;
        case `${ACTION_EVENT_PREFIX}record_eob`:
          cur.has_eob = true;
          if (cur.state === "awaiting_eob") cur.state = "open";
          break;
        case `${ACTION_EVENT_PREFIX}route_to_client_admin`:
          cur.state = "client_update_needed";
          cur.cob_flagged = true;
          break;
        case `${ACTION_EVENT_PREFIX}client_update_received`: {
          // Client submitted the secure update form → claim is resolved.
          cur.state = "resolved";
          const ids = Array.isArray(md.ordered_policy_ids)
            ? (md.ordered_policy_ids as unknown[]).map((x) => String(x))
            : [];
          if (ids.length > 0) cur.ordered_policy_ids = ids;
          break;
        }
        case `${ACTION_EVENT_PREFIX}reopen`:
          cur.state = "open";
          break;
      }
      auditByClaim.set(k, cur);
    }

    // ── 2b. Resolve "billing_in_progress" rows whose downstream claim
    //         has transmitted. For bill_secondary we check the cloned
    //         child claim's status; for bill_primary we re-check the
    //         original claim's status (already in `claims`).
    const childClaimIds: string[] = [];
    for (const agg of auditByClaim.values()) {
      if (agg.billed_role === "secondary" && agg.child_claim_id) {
        childClaimIds.push(agg.child_claim_id);
      }
    }
    const childStatusById = new Map<string, string>();
    if (childClaimIds.length) {
      const { data: childRows } = await (supabase as any)
        .from("professional_claims")
        .select("id, claim_status")
        .eq("organization_id", organizationId)
        .in("id", childClaimIds);
      for (const r of ((childRows ?? []) as DbRow[])) {
        childStatusById.set(text(r.id), text(r.claim_status));
      }
    }
    const claimStatusById = new Map<string, string>(
      claims.map((c) => [text(c.id), text(c.claim_status)]),
    );
    for (const [claimId, agg] of auditByClaim.entries()) {
      if (agg.state !== "billing_in_progress") continue;
      let downstreamStatus: string | null = null;
      if (agg.billed_role === "secondary" && agg.child_claim_id) {
        downstreamStatus = childStatusById.get(agg.child_claim_id) ?? null;
      } else if (agg.billed_role === "primary") {
        downstreamStatus = claimStatusById.get(claimId) ?? null;
      }
      if (downstreamStatus && TRANSMITTED_CLAIM_STATUSES.has(downstreamStatus)) {
        agg.state = "resolved";
      }
    }

    // ── 3. Classify each claim ───────────────────────────────────────
    const allItems: CobRow[] = [];
    const items: CobRow[] = [];

    for (const claim of claims) {
      const claimId = text(claim.id);
      const clientId = text(claim.patient_id);
      const apptId = text(claim.appointment_id);
      const billedPayerId = text(claim.payer_profile_id) || null;

      const clientPolicies = policiesByClient.get(clientId) ?? [];
      const activePolicies = clientPolicies.filter(
        (p) => p.active_flag !== false,
      );

      // Only consider claims where COB *might* matter:
      //   - real COB signals from 835 (CO-22 / other-payer paid) — Task #457,
      //   - 271 other-payer evidence on file for this client — Task #457,
      //   - 2+ active policies on the client (legacy heuristic), OR
      //   - the biller has already flagged this claim via an action.
      const audit = auditByClaim.get(claimId);
      const realSignal = cobSignalsByClaim.get(claimId);
      const eligibilityOthers = eligibilityOtherPayersByClient.get(clientId) ?? [];
      const hasRealCobEvidence = !!realSignal || eligibilityOthers.length > 0;
      if (activePolicies.length < 2 && !audit?.cob_flagged && !hasRealCobEvidence) continue;

      const policySummaries: CobPolicySummary[] = activePolicies.map((p) => {
        const payer = payerById.get(text(p.payer_id));
        return {
          id: text(p.id),
          priority: text(p.priority) || "primary",
          payer_id: text(p.payer_id) || null,
          payer_name: payer ? text(payer.payer_name) || null : null,
          payer_type: payer ? text(payer.payer_type) || null : null,
          policy_number: text(p.policy_number) || null,
          effective_date: text(p.effective_date) || null,
          termination_date: text(p.termination_date) || null,
          active: p.active_flag !== false,
        };
      });

      const primaryPolicy =
        policySummaries.find((p) => p.priority === "primary") ?? null;
      const secondaryPolicy =
        policySummaries.find((p) => p.priority === "secondary") ?? null;
      const primaries = policySummaries.filter((p) => p.priority === "primary");

      const hasMedicaid = policySummaries.some((p) => p.payer_type === "medicaid");

      const billedPayer = billedPayerId ? payerById.get(billedPayerId) : undefined;
      const billedPayerName = billedPayer ? text(billedPayer.payer_name) || null : null;

      const otherPayerCandidate = policySummaries.find(
        (p) => p.payer_id && p.payer_id !== billedPayerId,
      );
      // Prefer the real other-payer name from the 835 signal, then the
      // most-recent 271 other-payer entry, then the policy-list fallback.
      const otherPayerName =
        realSignal?.otherPayerName ??
        eligibilityOthers[0]?.name ??
        otherPayerCandidate?.payer_name ??
        null;

      // ── Tab classification ──────────────────────────────────────
      const tabs: CobTab[] = [];
      const issueParts: string[] = [];

      if (activePolicies.length >= 2 && billedPayerId) {
        const billedIsKnown = policySummaries.some((p) => p.payer_id === billedPayerId);
        if (billedIsKnown) {
          tabs.push("other_insurance_found");
          issueParts.push(
            `Client has ${activePolicies.length} active policies — only ${billedPayerName ?? "one"} was billed.`,
          );
        }
      } else if (realSignal?.hasCo22 || eligibilityOthers.length > 0) {
        // Task #457 — single-policy client but the payer told us via
        // 835 CO-22 ("covered by another payer") or 271 EB*R that
        // another carrier is on file. This is real COB evidence the
        // policy-count heuristic would otherwise miss.
        tabs.push("other_insurance_found");
        const reason = realSignal?.hasCo22
          ? `Payer returned CO-22 (covered by another payer${realSignal.otherPayerName ? `: ${realSignal.otherPayerName}` : ""}).`
          : `271 reported additional payer${eligibilityOthers[0]?.name ? ` ${eligibilityOthers[0].name}` : ""} on file for this client.`;
        issueParts.push(reason);
      }

      if (
        primaries.length > 1 ||
        (billedPayerId &&
          primaryPolicy &&
          primaryPolicy.payer_id &&
          primaryPolicy.payer_id !== billedPayerId)
      ) {
        tabs.push("primary_secondary_conflict");
        issueParts.push(
          primaries.length > 1
            ? "Multiple policies marked primary."
            : `Claim was sent to ${billedPayerName ?? "secondary"} but primary is ${primaryPolicy?.payer_name ?? "unset"}.`,
        );
      }

      if (hasMedicaid && policySummaries.length >= 2) {
        tabs.push("medicaid_cob");
        issueParts.push("Medicaid present — must bill commercial payer first.");
      }

      const isSecondaryBill = !!(
        billedPayerId &&
        secondaryPolicy &&
        secondaryPolicy.payer_id === billedPayerId
      );
      // Task #457 — a real 835 "other_payer_paid" signal proves the
      // claim was adjudicated as secondary; we need the prior-payer
      // EOB on file. This wins over the policy-priority heuristic.
      if (realSignal?.hasOtherPayerPaid && !(audit?.has_eob)) {
        tabs.push("eob_needed");
        issueParts.push(
          `Payer reported a prior-payer paid amount${realSignal.otherPayerPaidAmount != null ? ` of $${realSignal.otherPayerPaidAmount.toFixed(2)}` : ""} — EOB required.`,
        );
      } else if (isSecondaryBill && !(audit?.has_eob)) {
        tabs.push("eob_needed");
        issueParts.push("Secondary billing requires prior-payer EOB.");
      }

      if (
        audit?.state === "client_update_needed" ||
        (audit?.cob_flagged && activePolicies.length < 2)
      ) {
        tabs.push("client_update_needed");
        issueParts.push("Awaiting insurance update from client.");
      }

      if (tabs.length === 0) continue;

      const apptRow = apptId ? apptById.get(apptId) : undefined;
      const dosIso = apptRow ? text(apptRow.scheduled_start_at) : null;
      const dos = dosIso ? dosIso.slice(0, 10) : null;
      const days = daysSince(dosIso || null);

      const client = clientById.get(clientId);
      const clientName = client
        ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") ||
          "Unknown client"
        : "Unknown client";

      const provId = apptRow ? text(apptRow.provider_id) : "";
      const provider = provId ? providerById.get(provId) : undefined;
      const clinicianName = provider
        ? text(provider.display_name) ||
          [provider.first_name, provider.last_name].map(text).filter(Boolean).join(" ") ||
          null
        : null;

      const state: CobState = audit?.state ?? "open";

      const row: CobRow = {
        id: claimId,
        claim_number: text(claim.claim_number) || claimId.slice(0, 8),
        client_id: clientId || null,
        client_name: clientName,
        payer_billed_id: billedPayerId,
        payer_billed_name: billedPayerName,
        other_payer_name: otherPayerName,
        cob_issue: issueParts.join(" ") || "Coordination of benefits review",
        date_of_service: dos,
        charge_amount: money(claim.total_charge),
        patient_contact_needed:
          tabs.includes("client_update_needed") ||
          tabs.includes("other_insurance_found"),
        status: stateLabel(state),
        state,
        tabs,
        policies: policySummaries,
        has_eob: audit?.has_eob ?? false,
        eob_requested_at: audit?.eob_requested_at ?? null,
        eob_request_count: audit?.eob_request_count ?? 0,
        last_action_at: audit?.last_action_at ?? null,
        days_since_dos: days,
        aging_bucket: agingBucket(days),
        priority: priorityFor(days, hasMedicaid),
        clinician_id: provId || null,
        clinician_name: clinicianName,
        has_medicaid: hasMedicaid,
      };

      allItems.push(row);

      if (filterTab && !row.tabs.includes(filterTab)) continue;
      if (filterStatus && row.state !== filterStatus) continue;
      if (filterClinician && row.clinician_id !== filterClinician) continue;
      if (filterPayer && row.payer_billed_name !== filterPayer) continue;
      if (filterClient && row.client_id !== filterClient) continue;
      if (filterPriority && row.priority !== filterPriority) continue;
      if (filterAgingBucket && row.aging_bucket !== filterAgingBucket) continue;
      if (filterDosFrom && (row.date_of_service ?? "") < filterDosFrom) continue;
      if (filterDosTo && (row.date_of_service ?? "") > filterDosTo) continue;
      if (Number.isFinite(filterMinAmount) && row.charge_amount < filterMinAmount) continue;
      if (Number.isFinite(filterMaxAmount) && row.charge_amount > filterMaxAmount) continue;

      items.push(row);
    }

    // Summary across the entire queue (state = open) ─────────────────
    const openItems = allItems.filter((i) => i.state === "open");
    const summary: CobSummary = {
      total_count: openItems.length,
      total_dollars: Math.round(
        openItems.reduce((sum, i) => sum + (i.charge_amount || 0), 0) * 100,
      ) / 100,
      oldest_age_days: openItems.reduce<number | null>((max, i) => {
        if (i.days_since_dos == null) return max;
        if (max == null) return i.days_since_dos;
        return Math.max(max, i.days_since_dos);
      }, null),
      urgent_count: openItems.filter(
        (i) => i.priority === "critical" || i.priority === "high",
      ).length,
      by_tab: {
        other_insurance_found: 0,
        primary_secondary_conflict: 0,
        medicaid_cob: 0,
        client_update_needed: 0,
        eob_needed: 0,
      },
    };
    for (const i of openItems) {
      for (const t of i.tabs) summary.by_tab[t] += 1;
    }

    return NextResponse.json({ success: true, organizationId, items, summary });
  } catch (error) {
    console.error("COB Issues API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load COB Issues worklist",
      },
      { status: 500 },
    );
  }
}
