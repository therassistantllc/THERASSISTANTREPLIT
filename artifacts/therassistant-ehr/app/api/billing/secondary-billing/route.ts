/**
 * GET /api/billing/secondary-billing
 *
 * "Secondary Billing Needed" workqueue: claims where the primary payer
 * has adjudicated and a secondary claim needs to be generated.
 *
 * Authoritative state lives on `professional_claims.secondary_billing_*`
 * columns and is set by the POST action route. When those columns are
 * unset (claim has never been touched by this queue), the GET route
 * falls back to deriving an initial state from policies + ERA on file.
 *
 * Tabs:
 *   - ready_for_secondary     Primary EOB on file (ERA or manual),
 *                             secondary policy exists, not yet
 *                             submitted.
 *   - missing_primary_eob     Secondary policy exists but no primary
 *                             EOB.
 *   - cob_issue               2+ active policies but no clear primary
 *                             or secondary missing, or claim flagged
 *                             cob_issue by the biller.
 *   - secondary_claim_error   Last secondary action recorded an error.
 *   - secondary_submitted     Secondary claim has been submitted.
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

function priorityFor(days: number | null, error: boolean): "low" | "medium" | "high" | "critical" {
  const d = days ?? 0;
  if (error || d >= 75) return "critical";
  if (d >= 45) return "high";
  if (d >= 21) return "medium";
  return "low";
}

export type SecondaryTab =
  | "ready_for_secondary"
  | "missing_primary_eob"
  | "cob_issue"
  | "secondary_claim_error"
  | "secondary_submitted";

export type SecondaryState =
  | "ready"
  | "missing_eob"
  | "cob_issue"
  | "hold"
  | "generated"
  | "submitted"
  | "error";

export interface SecondaryPolicySummary {
  id: string;
  priority: string;
  payer_id: string | null;
  payer_name: string | null;
  payer_type: string | null;
  policy_number: string | null;
  active: boolean;
}

export interface SecondaryEraSummary {
  era_payment_id: string | null;
  era_batch_id: string | null;
  payer_paid: number;
  patient_responsibility: number;
  total_charge: number;
  posted_at: string | null;
  payer_claim_control_number: string | null;
  cas_adjustments: unknown[];
  service_lines: unknown[];
  carc_codes: string[];
  rarc_codes: string[];
}

export interface SecondaryRow {
  id: string;
  claim_number: string;
  client_id: string | null;
  client_name: string;
  practice_id: string | null;
  primary_payer_id: string | null;
  primary_payer_name: string | null;
  secondary_payer_id: string | null;
  secondary_payer_name: string | null;
  date_of_service: string | null;
  primary_paid: number;
  patient_responsibility: number;
  secondary_expected: number;
  total_charge: number;
  claim_status: string;
  has_primary_eob: boolean;
  primary_eob_source: "era" | "manual" | null;
  eob_attached_at: string | null;
  state: SecondaryState;
  tabs: SecondaryTab[];
  last_action_at: string | null;
  last_error: string | null;
  days_since_dos: number | null;
  aging_bucket: string;
  priority: "low" | "medium" | "high" | "critical";
  clinician_id: string | null;
  clinician_name: string | null;
  assigned_biller_user_id: string | null;
  assigned_biller_name: string | null;
  follow_up_due: string | null;
  policies: SecondaryPolicySummary[];
  era: SecondaryEraSummary | null;
  secondary_batch_id: string | null;
  secondary_batch_number: string | null;
  secondary_batch_status: string | null;
  secondary_batch_submitted_at: string | null;
  availity_transaction_id: string | null;
}

export interface SecondarySummary {
  total_count: number;
  total_dollars: number;
  oldest_age_days: number | null;
  urgent_count: number;
  by_tab: Record<SecondaryTab, number>;
}

const ACTION_EVENT_PREFIX = "sec_billing_";

function emptySummary(): SecondarySummary {
  return {
    total_count: 0,
    total_dollars: 0,
    oldest_age_days: null,
    urgent_count: 0,
    by_tab: {
      ready_for_secondary: 0,
      missing_primary_eob: 0,
      cob_issue: 0,
      secondary_claim_error: 0,
      secondary_submitted: 0,
    },
  };
}

function tabFor(state: SecondaryState): SecondaryTab {
  switch (state) {
    case "submitted":  return "secondary_submitted";
    case "error":      return "secondary_claim_error";
    case "missing_eob": return "missing_primary_eob";
    case "cob_issue":  return "cob_issue";
    case "hold":
    case "generated":
    case "ready":
    default:
      return "ready_for_secondary";
  }
}

function extractAdjustmentCodes(
  adjustments: unknown,
): { carc: string[]; rarc: string[] } {
  const carc = new Set<string>();
  const rarc = new Set<string>();
  if (!Array.isArray(adjustments)) return { carc: [], rarc: [] };
  for (const a of adjustments) {
    if (!a || typeof a !== "object") continue;
    const rec = a as Record<string, unknown>;
    // CAS reason codes (CARC) commonly live in `reason_codes`,
    // `reasonCode`, `reason_code`, or `code`.
    const reasonCandidates = [
      rec.reason_codes,
      rec.reasonCodes,
      rec.reasonCode,
      rec.reason_code,
      rec.code,
    ];
    for (const c of reasonCandidates) {
      if (Array.isArray(c)) {
        for (const v of c) if (v) carc.add(String(v));
      } else if (c) {
        carc.add(String(c));
      }
    }
    const remarkCandidates = [
      rec.remark_codes,
      rec.remarkCodes,
      rec.remark_code,
      rec.remarkCode,
    ];
    for (const r of remarkCandidates) {
      if (Array.isArray(r)) {
        for (const v of r) if (v) rarc.add(String(v));
      } else if (r) {
        rarc.add(String(r));
      }
    }
  }
  return { carc: Array.from(carc), rarc: Array.from(rarc) };
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

    const filterTab = (searchParams.get("tab") ?? "ready_for_secondary").trim() as SecondaryTab;
    const filterPractice = (searchParams.get("practice") ?? "").trim();
    const filterClinician = (searchParams.get("clinician") ?? "").trim();
    const filterPayer = (searchParams.get("payer") ?? "").trim();
    const filterClient = (searchParams.get("client") ?? "").trim();
    const filterDosFrom = (searchParams.get("dosFrom") ?? "").trim();
    const filterDosTo = (searchParams.get("dosTo") ?? "").trim();
    const filterStatus = (searchParams.get("status") ?? "").trim();
    const filterPriority = (searchParams.get("priority") ?? "").trim();
    const filterAgingBucket = (searchParams.get("agingBucket") ?? "").trim();
    const filterMinAmount = Number(searchParams.get("minAmount") ?? "");
    const filterMaxAmount = Number(searchParams.get("maxAmount") ?? "");
    const filterAssignedBiller = (searchParams.get("assignedBiller") ?? "").trim();
    const filterCarcRarc = (searchParams.get("carcRarc") ?? "").trim().toUpperCase();
    const filterFollowUpDue = (searchParams.get("followUpDue") ?? "").trim();

    const lookbackFrom = new Date();
    lookbackFrom.setMonth(lookbackFrom.getMonth() - 18);

    // Pull claims that are candidates for secondary billing:
    // adjudicated claims OR claims with any secondary_billing_state set.
    const { data: claimRows, error: claimsErr } = await (supabase as any)
      .from("professional_claims")
      .select(
        "id, organization_id, patient_id, appointment_id, payer_profile_id, claim_number, claim_status, total_charge, patient_responsibility_amount, payer_responsibility_amount, created_at, updated_at, secondary_billing_state, secondary_billing_eob_attached_at, secondary_billing_eob_reference, secondary_billing_generated_at, secondary_billing_submitted_at, secondary_billing_last_error, secondary_billing_assigned_to_user_id, secondary_billing_follow_up_due",
      )
      .eq("organization_id", organizationId)
      .gte("created_at", lookbackFrom.toISOString())
      .or(
        "claim_status.in.(paid,partially_paid,denied,submitted,accepted),secondary_billing_state.not.is.null",
      )
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
    const assignedUserIds = [
      ...new Set(
        claims
          .map((c) => text(c.secondary_billing_assigned_to_user_id))
          .filter(Boolean),
      ),
    ];

    const [
      { data: policies },
      { data: clients },
      { data: appts },
      { data: payerProfiles },
      { data: audit },
      { data: eraPayments },
      { data: secondaryBatchLinks },
      { data: assignedUsers },
    ] = await Promise.all([
      clientIds.length
        ? (supabase as any)
            .from("insurance_policies")
            .select(
              "id, client_id, payer_id, priority, plan_name, policy_number, active_flag, archived_at",
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
            .select("id, provider_id, location_id, scheduled_start_at")
            .in("id", apptIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      (supabase as any)
        .from("payer_profiles")
        .select("id, payer_name, payer_type")
        .eq("organization_id", organizationId),
      (supabase as any)
        .from("audit_logs")
        .select("claim_id, event_type, event_summary, event_metadata, created_at, user_id")
        .eq("organization_id", organizationId)
        .in("claim_id", claimIds)
        .ilike("event_type", `${ACTION_EVENT_PREFIX}%`)
        .order("created_at", { ascending: true }),
      (supabase as any)
        .from("era_claim_payments")
        .select(
          "id, era_import_batch_id, professional_claim_id, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, payer_claim_control_number, cas_adjustments, service_lines, created_at, archived_at",
        )
        .eq("organization_id", organizationId)
        .in("professional_claim_id", claimIds)
        .is("archived_at", null),
      (supabase as any)
        .from("claim_837p_batch_claims")
        .select(
          "professional_claim_id, batch_id, created_at, claim_837p_batches!inner(id, batch_number, batch_status, submitted_at, availity_transaction_id, submission_kind)",
        )
        .eq("organization_id", organizationId)
        .eq("submission_kind", "secondary")
        .in("professional_claim_id", claimIds)
        .is("archived_at", null),
      assignedUserIds.length
        ? (supabase as any)
            .from("staff_members")
            .select("user_id, display_name, first_name, last_name")
            .in("user_id", assignedUserIds)
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

    // ── Lookup maps ───────────────────────────────────────────────────
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
    const staffByUserId = new Map<string, DbRow>(
      ((assignedUsers ?? []) as DbRow[]).map((s) => [text(s.user_id), s]),
    );
    const eraByClaim = new Map<string, DbRow>();
    for (const e of ((eraPayments ?? []) as DbRow[])) {
      const k = text(e.professional_claim_id);
      if (!k) continue;
      const cur = eraByClaim.get(k);
      if (!cur || text(e.created_at) > text(cur.created_at)) eraByClaim.set(k, e);
    }

    // Map claim_id → most-recent active secondary 837P batch row so the
    // queue row can show the real batch number, transaction id, and
    // submission state instead of just the audit event timestamp.
    const secondaryBatchByClaim = new Map<string, DbRow>();
    for (const link of ((secondaryBatchLinks ?? []) as DbRow[])) {
      const k = text((link as DbRow).professional_claim_id);
      if (!k) continue;
      const batch = (link as DbRow).claim_837p_batches as DbRow | undefined;
      if (!batch) continue;
      const cur = secondaryBatchByClaim.get(k);
      if (!cur || text((link as DbRow).created_at) > text(cur.__link_created_at as string)) {
        secondaryBatchByClaim.set(k, {
          ...batch,
          __link_created_at: text((link as DbRow).created_at),
        });
      }
    }

    // Last `sec_billing_*` action timestamp per claim (for display).
    const lastActionByClaim = new Map<string, string>();
    for (const a of ((audit ?? []) as DbRow[])) {
      const k = text(a.claim_id);
      if (!k) continue;
      const t = text(a.created_at);
      const cur = lastActionByClaim.get(k);
      if (!cur || t > cur) lastActionByClaim.set(k, t);
    }

    // ── Classify ──────────────────────────────────────────────────────
    const allItems: SecondaryRow[] = [];
    const items: SecondaryRow[] = [];

    for (const claim of claims) {
      const claimId = text(claim.id);
      const clientId = text(claim.patient_id);
      const apptId = text(claim.appointment_id);
      const billedPayerId = text(claim.payer_profile_id) || null;

      const clientPolicies = (policiesByClient.get(clientId) ?? []).filter(
        (p) => p.active_flag !== false,
      );

      const policySummaries: SecondaryPolicySummary[] = clientPolicies.map((p) => {
        const payer = payerById.get(text(p.payer_id));
        return {
          id: text(p.id),
          priority: text(p.priority) || "primary",
          payer_id: text(p.payer_id) || null,
          payer_name: payer ? text(payer.payer_name) || null : null,
          payer_type: payer ? text(payer.payer_type) || null : null,
          policy_number: text(p.policy_number) || null,
          active: p.active_flag !== false,
        };
      });

      const primaryPolicy =
        policySummaries.find((p) => p.priority === "primary") ?? null;
      const secondaryPolicy =
        policySummaries.find((p) => p.priority === "secondary") ?? null;
      const primaries = policySummaries.filter((p) => p.priority === "primary");

      const era = eraByClaim.get(claimId);
      const persistedState =
        (text(claim.secondary_billing_state) || null) as SecondaryState | null;

      // Only consider claims that are real candidates:
      //   - There is a secondary policy on file, OR
      //   - The biller has already pulled the claim into the queue
      //     (persistedState non-null).
      if (!secondaryPolicy && !persistedState) continue;

      const primaryPayerId =
        primaryPolicy?.payer_id ?? billedPayerId ?? null;
      const primaryPayerName =
        primaryPolicy?.payer_name ??
        (billedPayerId
          ? text(payerById.get(billedPayerId)?.payer_name) || null
          : null);

      const eobAttachedAt = text(claim.secondary_billing_eob_attached_at) || null;
      const hasEraEob = !!era;
      const hasManualEob = !!eobAttachedAt;
      const hasPrimaryEob = hasEraEob || hasManualEob;

      const eobIso = hasEraEob ? text(era!.created_at) : eobAttachedAt;

      const { carc, rarc } = era
        ? extractAdjustmentCodes(era.cas_adjustments)
        : { carc: [], rarc: [] };

      const eraSummary: SecondaryEraSummary | null = era
        ? {
            era_payment_id: text(era.id) || null,
            era_batch_id: text(era.era_import_batch_id) || null,
            payer_paid: money(era.clp04_payment_amount),
            patient_responsibility: money(era.clp05_patient_responsibility),
            total_charge: money(era.clp03_total_charge),
            posted_at: text(era.created_at) || null,
            payer_claim_control_number: text(era.payer_claim_control_number) || null,
            cas_adjustments: Array.isArray(era.cas_adjustments)
              ? (era.cas_adjustments as unknown[])
              : [],
            service_lines: Array.isArray(era.service_lines)
              ? (era.service_lines as unknown[])
              : [],
            carc_codes: carc,
            rarc_codes: rarc,
          }
        : null;

      const totalCharge = money(claim.total_charge);
      const primaryPaid = era ? money(era.clp04_payment_amount) : 0;
      const patientResp = era
        ? money(era.clp05_patient_responsibility)
        : money(claim.patient_responsibility_amount);
      const secondaryExpected = Math.max(
        0,
        Math.round((totalCharge - primaryPaid - patientResp) * 100) / 100,
      );

      // ── State: persisted wins; otherwise derive ──────────────────
      const cobConflict =
        primaries.length > 1 ||
        (!primaryPolicy && policySummaries.length >= 2);

      let state: SecondaryState;
      if (persistedState) {
        state = persistedState;
      } else if (cobConflict) {
        state = "cob_issue";
      } else if (!hasPrimaryEob) {
        state = "missing_eob";
      } else if (!secondaryPolicy) {
        state = "cob_issue";
      } else {
        state = "ready";
      }

      const tab = tabFor(state);
      const tabs: SecondaryTab[] = [tab];

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

      const assignedUserId = text(claim.secondary_billing_assigned_to_user_id) || null;
      const assignedStaff = assignedUserId ? staffByUserId.get(assignedUserId) : undefined;
      const assignedName = assignedStaff
        ? text(assignedStaff.display_name) ||
          [assignedStaff.first_name, assignedStaff.last_name]
            .map(text)
            .filter(Boolean)
            .join(" ") ||
          null
        : null;

      const followUpDue = text(claim.secondary_billing_follow_up_due) || null;

      const row: SecondaryRow = {
        id: claimId,
        claim_number: text(claim.claim_number) || claimId.slice(0, 8),
        client_id: clientId || null,
        client_name: clientName,
        practice_id: apptRow ? text(apptRow.location_id) || null : null,
        primary_payer_id: primaryPayerId,
        primary_payer_name: primaryPayerName,
        secondary_payer_id: secondaryPolicy?.payer_id ?? null,
        secondary_payer_name: secondaryPolicy?.payer_name ?? null,
        date_of_service: dos,
        primary_paid: primaryPaid,
        patient_responsibility: patientResp,
        secondary_expected: secondaryExpected,
        total_charge: totalCharge,
        claim_status: text(claim.claim_status) || "draft",
        has_primary_eob: hasPrimaryEob,
        primary_eob_source: hasEraEob ? "era" : hasManualEob ? "manual" : null,
        eob_attached_at: eobIso || null,
        state,
        tabs,
        last_action_at: lastActionByClaim.get(claimId) ?? null,
        last_error: state === "error" ? text(claim.secondary_billing_last_error) || null : null,
        days_since_dos: days,
        aging_bucket: agingBucket(days),
        priority: priorityFor(days, state === "error"),
        clinician_id: provId || null,
        clinician_name: clinicianName,
        assigned_biller_user_id: assignedUserId,
        assigned_biller_name: assignedName,
        follow_up_due: followUpDue,
        policies: policySummaries,
        era: eraSummary,
        secondary_batch_id: (() => {
          const b = secondaryBatchByClaim.get(claimId);
          return b ? text(b.id) || null : null;
        })(),
        secondary_batch_number: (() => {
          const b = secondaryBatchByClaim.get(claimId);
          return b ? text(b.batch_number) || null : null;
        })(),
        secondary_batch_status: (() => {
          const b = secondaryBatchByClaim.get(claimId);
          return b ? text(b.batch_status) || null : null;
        })(),
        secondary_batch_submitted_at: (() => {
          const b = secondaryBatchByClaim.get(claimId);
          return b ? text(b.submitted_at) || null : null;
        })(),
        availity_transaction_id: (() => {
          const b = secondaryBatchByClaim.get(claimId);
          return b ? text(b.availity_transaction_id) || null : null;
        })(),
      };

      allItems.push(row);

      // ── Apply filters ──────────────────────────────────────────────
      if (!row.tabs.includes(filterTab)) continue;
      if (filterStatus && row.state !== filterStatus) continue;
      if (filterPractice && row.practice_id !== filterPractice) continue;
      if (filterClinician && row.clinician_id !== filterClinician) continue;
      if (
        filterPayer &&
        row.primary_payer_name !== filterPayer &&
        row.secondary_payer_name !== filterPayer
      ) continue;
      if (filterClient && row.client_id !== filterClient) continue;
      if (filterPriority && row.priority !== filterPriority) continue;
      if (filterAgingBucket && row.aging_bucket !== filterAgingBucket) continue;
      if (filterDosFrom && (row.date_of_service ?? "") < filterDosFrom) continue;
      if (filterDosTo && (row.date_of_service ?? "") > filterDosTo) continue;
      if (Number.isFinite(filterMinAmount) && row.secondary_expected < filterMinAmount) continue;
      if (Number.isFinite(filterMaxAmount) && row.secondary_expected > filterMaxAmount) continue;
      if (
        filterAssignedBiller &&
        row.assigned_biller_user_id !== filterAssignedBiller
      ) continue;
      if (filterCarcRarc) {
        const all = [
          ...(row.era?.carc_codes ?? []),
          ...(row.era?.rarc_codes ?? []),
        ].map((c) => c.toUpperCase());
        if (!all.includes(filterCarcRarc)) continue;
      }
      if (filterFollowUpDue) {
        if (!row.follow_up_due || row.follow_up_due > filterFollowUpDue) continue;
      }

      items.push(row);
    }

    const openItems = allItems.filter((i) => i.state !== "submitted");
    const summary: SecondarySummary = {
      total_count: openItems.length,
      total_dollars: Math.round(
        openItems.reduce((sum, i) => sum + (i.secondary_expected || 0), 0) * 100,
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
        ready_for_secondary: 0,
        missing_primary_eob: 0,
        cob_issue: 0,
        secondary_claim_error: 0,
        secondary_submitted: 0,
      },
    };
    for (const i of allItems) {
      for (const t of i.tabs) summary.by_tab[t] += 1;
    }

    return NextResponse.json({ success: true, organizationId, items, summary });
  } catch (error) {
    console.error("Secondary Billing API error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load Secondary Billing worklist",
      },
      { status: 500 },
    );
  }
}
