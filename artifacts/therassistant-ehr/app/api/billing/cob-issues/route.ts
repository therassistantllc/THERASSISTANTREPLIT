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
    case "resolved": return "Resolved";
  }
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

    type AuditAgg = {
      state: CobState;
      has_eob: boolean;
      eob_requested_at: string | null;
      eob_request_count: number;
      last_action_at: string | null;
      ordered_policy_ids: string[];
      cob_flagged: boolean;
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
        case `${ACTION_EVENT_PREFIX}bill_secondary`:
          cur.state = "resolved";
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
        case `${ACTION_EVENT_PREFIX}reopen`:
          cur.state = "open";
          break;
      }
      auditByClaim.set(k, cur);
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
      //   - 2+ active policies on the client (real COB territory), OR
      //   - the biller has already flagged this claim via an action.
      const audit = auditByClaim.get(claimId);
      if (activePolicies.length < 2 && !audit?.cob_flagged) continue;

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
      const otherPayerName = otherPayerCandidate?.payer_name ?? null;

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
      if (isSecondaryBill && !(audit?.has_eob)) {
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
