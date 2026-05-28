/**
 * GET /api/billing/charge-capture
 *
 * Workqueue list for the Charge Capture screen. Returns one row per
 * un-archived `charge_capture_items` row, joined with the supporting
 * detail the spec asks for (appointment, encounter / note, provider,
 * client, payer, latest eligibility check).
 *
 * Query params:
 *   organizationId — tenant id (verified against the session)
 *   tab            — one of the spec tab ids (filters by status/blocker)
 *   client         — free-text match on client or CPT
 *   clinician      — provider display name (exact)
 *   payer          — payer name (exact)
 *   dosFrom/dosTo  — service-date bounds (YYYY-MM-DD)
 *   status         — raw charge_status filter (overrides tab if set)
 *   minAmount      — minimum total_charge
 *   priority       — "urgent" → only blocked / missing-dx rows
 *
 * The tabs are computed server-side so the header counts and row list
 * stay consistent regardless of which tab the biller has open.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;

const text = (v: unknown) => String(v ?? "").trim();
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

function ageDays(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000)));
}

function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const t1 = new Date(a).getTime();
  const t2 = new Date(b).getTime();
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Math.max(0, Math.round((t2 - t1) / 60000));
}

export type ChargeCaptureTab =
  | "ready_for_review"
  | "documentation_missing"
  | "coding_mismatch"
  | "eligibility_auth_issue"
  | "held_charges"
  | "released_to_claims";

export const CHARGE_CAPTURE_TABS: Array<{ id: ChargeCaptureTab; label: string }> = [
  { id: "ready_for_review", label: "Ready for Review" },
  { id: "documentation_missing", label: "Documentation Missing" },
  { id: "coding_mismatch", label: "Coding Mismatch" },
  { id: "eligibility_auth_issue", label: "Eligibility/Auth Issue" },
  { id: "held_charges", label: "Held Charges" },
  { id: "released_to_claims", label: "Released to Claims" },
];

interface BlockerObj { field?: string; message?: string }

function blockerText(blockers: BlockerObj[]): string[] {
  return blockers.map((b) => [b.field, b.message].filter(Boolean).join(": ") || "Needs review");
}

function classifyTab(opts: {
  chargeStatus: string;
  blockers: BlockerObj[];
  noteSigned: boolean;
  eligibilityStatus: string | null;
}): ChargeCaptureTab {
  const { chargeStatus, blockers, noteSigned, eligibilityStatus } = opts;
  if (chargeStatus === "claim_created" || chargeStatus === "ready_for_batch") return "released_to_claims";
  if (chargeStatus === "blocked" || chargeStatus === "voided") return "held_charges";

  const fields = new Set(blockers.map((b) => (b.field ?? "").toLowerCase()));
  if (!noteSigned || fields.has("documentation") || fields.has("note") || fields.has("required_billing_fields")) {
    return "documentation_missing";
  }
  if (
    fields.has("diagnosis_codes") ||
    fields.has("service_lines.procedure_code") ||
    fields.has("service_lines") ||
    fields.has("cpt") ||
    fields.has("modifier")
  ) {
    return "coding_mismatch";
  }
  if (eligibilityStatus && !["active", "covered"].includes(eligibilityStatus.toLowerCase())) {
    return "eligibility_auth_issue";
  }
  if (fields.has("eligibility") || fields.has("authorization") || fields.has("auth")) {
    return "eligibility_auth_issue";
  }
  return "ready_for_review";
}

function actionNeeded(tab: ChargeCaptureTab): string {
  switch (tab) {
    case "ready_for_review": return "Review & approve";
    case "documentation_missing": return "Get signed note";
    case "coding_mismatch": return "Fix coding";
    case "eligibility_auth_issue": return "Verify eligibility / auth";
    case "held_charges": return "Resolve hold";
    case "released_to_claims": return "—";
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database not available" }, { status: 500 });
    }

    const tab = (searchParams.get("tab") || "") as ChargeCaptureTab | "";
    const statusFilter = (searchParams.get("status") || "").trim();
    const clientQ = (searchParams.get("client") || "").trim().toLowerCase();
    const clinicianQ = (searchParams.get("clinician") || "").trim();
    const payerQ = (searchParams.get("payer") || "").trim();
    const dosFrom = (searchParams.get("dosFrom") || "").trim();
    const dosTo = (searchParams.get("dosTo") || "").trim();
    const minAmount = Number(searchParams.get("minAmount") || "");
    const priorityQ = (searchParams.get("priority") || "").trim();

    let query = (supabase as any)
      .from("charge_capture_items")
      .select(
        "id, organization_id, charge_status, service_date, total_charge, blocker_reasons, " +
        "service_lines, diagnosis_codes, claim_id, client_id, provider_id, appointment_id, " +
        "encounter_id, insurance_policy_id, captured_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("service_date", { ascending: true, nullsFirst: false });

    if (statusFilter) query = query.eq("charge_status", statusFilter);
    if (dosFrom) query = query.gte("service_date", dosFrom);
    if (dosTo) query = query.lte("service_date", dosTo);

    const { data: chargeRows, error } = await query;
    if (error) throw error;
    const charges = (chargeRows ?? []) as DbRow[];

    const clientIds = [...new Set(charges.map((c) => text(c.client_id)).filter(Boolean))];
    const providerIds = [...new Set(charges.map((c) => text(c.provider_id)).filter(Boolean))];
    const appointmentIds = [...new Set(charges.map((c) => text(c.appointment_id)).filter(Boolean))];
    const encounterIds = [...new Set(charges.map((c) => text(c.encounter_id)).filter(Boolean))];
    const policyIds = [...new Set(charges.map((c) => text(c.insurance_policy_id)).filter(Boolean))];

    const [clientsRes, providersRes, apptsRes, encRes, policiesRes] = await Promise.all([
      clientIds.length
        ? supabase.from("clients").select("id, first_name, last_name, date_of_birth").in("id", clientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      providerIds.length
        ? supabase.from("providers").select("id, display_name, first_name, last_name").in("id", providerIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      appointmentIds.length
        ? (supabase as any)
            .from("appointments")
            .select("id, appointment_type, appointment_status, scheduled_start_at, scheduled_end_at, cpt_code")
            .in("id", appointmentIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      encounterIds.length
        ? (supabase as any)
            .from("encounters")
            .select("id, encounter_status, required_billing_fields_complete, session_summary, started_at, ended_at, service_date")
            .in("id", encounterIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      policyIds.length
        ? (supabase as any)
            .from("insurance_policies")
            .select("id, payer_id, plan_name, policy_number, subscriber_id")
            .in("id", policyIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const policies = (policiesRes.data ?? []) as DbRow[];
    const payerIds = [...new Set(policies.map((p) => text(p.payer_id)).filter(Boolean))];
    const { data: payersRows } = payerIds.length
      ? await supabase.from("insurance_payers").select("id, payer_name, payer_category").in("id", payerIds)
      : { data: [] as DbRow[] };

    // Latest eligibility check per client (best-effort)
    let eligByClient = new Map<string, DbRow>();
    if (clientIds.length) {
      const { data: eligRows } = await (supabase as any)
        .from("eligibility_checks")
        .select("client_id, eligibility_status, checked_at, authorization_required, raw_status_text")
        .eq("organization_id", organizationId)
        .in("client_id", clientIds)
        .is("archived_at", null)
        .order("checked_at", { ascending: false });
      for (const row of ((eligRows ?? []) as DbRow[])) {
        const cid = text(row.client_id);
        if (cid && !eligByClient.has(cid)) eligByClient.set(cid, row);
      }
    }

    const clientById = new Map<string, DbRow>(((clientsRes.data ?? []) as DbRow[]).map((c) => [text(c.id), c]));
    const providerById = new Map<string, DbRow>(((providersRes.data ?? []) as DbRow[]).map((p) => [text(p.id), p]));
    const apptById = new Map<string, DbRow>(((apptsRes.data ?? []) as DbRow[]).map((a) => [text(a.id), a]));
    const encById = new Map<string, DbRow>(((encRes.data ?? []) as DbRow[]).map((e) => [text(e.id), e]));
    const policyById = new Map<string, DbRow>(policies.map((p) => [text(p.id), p]));
    const payerById = new Map<string, DbRow>(((payersRows ?? []) as DbRow[]).map((p) => [text(p.id), p]));

    const items = charges.map((c) => {
      const client = clientById.get(text(c.client_id));
      const provider = providerById.get(text(c.provider_id));
      const appt = apptById.get(text(c.appointment_id));
      const enc = encById.get(text(c.encounter_id));
      const policy = policyById.get(text(c.insurance_policy_id));
      const payer = policy ? payerById.get(text(policy.payer_id)) : null;
      const elig = client ? eligByClient.get(text(client.id)) : null;

      const blockers = Array.isArray(c.blocker_reasons) ? (c.blocker_reasons as BlockerObj[]) : [];
      const noteSigned = enc ? text(enc.encounter_status) === "signed" : false;
      const eligStatus = elig ? text(elig.eligibility_status) || null : null;
      const lines = Array.isArray(c.service_lines) ? (c.service_lines as DbRow[]) : [];
      const providerCode = text(lines[0]?.procedureCode) || null;
      const suggestedCode = appt ? text(appt.cpt_code) || null : null;

      const tabId = classifyTab({
        chargeStatus: text(c.charge_status),
        blockers,
        noteSigned,
        eligibilityStatus: eligStatus,
      });

      const apptStartIso = appt ? (appt.scheduled_start_at as string | null) ?? null : null;
      const apptEndIso = appt ? (appt.scheduled_end_at as string | null) ?? null : null;
      const durationMin = minutesBetween(apptStartIso, apptEndIso);

      const codingAlerts: string[] = [];
      if (providerCode && suggestedCode && providerCode.toUpperCase() !== suggestedCode.toUpperCase()) {
        codingAlerts.push(`Mismatch: provider ${providerCode} vs suggested ${suggestedCode}`);
      }
      const dxCodes = Array.isArray(c.diagnosis_codes) ? (c.diagnosis_codes as unknown[]).map(text).filter(Boolean) : [];
      if (dxCodes.length === 0) codingAlerts.push("No diagnosis on file");

      return {
        id: text(c.id),
        chargeStatus: text(c.charge_status),
        tab: tabId,
        dateOfService: c.service_date ?? null,
        client: {
          id: text(c.client_id),
          name: client
            ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") || "Unknown client"
            : "Unknown client",
          dob: client?.date_of_birth ?? null,
        },
        clinician: provider
          ? text(provider.display_name) || [provider.first_name, provider.last_name].map(text).filter(Boolean).join(" ") || "—"
          : "—",
        appointment: {
          id: text(c.appointment_id) || null,
          type: appt ? text(appt.appointment_type) || "—" : "—",
          status: appt ? text(appt.appointment_status) || "—" : "—",
          startAt: apptStartIso,
          endAt: apptEndIso,
          durationMin,
        },
        encounter: {
          id: text(c.encounter_id) || null,
          noteStatus: enc ? text(enc.encounter_status) || "—" : "—",
          noteSigned,
          billingFieldsComplete: enc ? Boolean(enc.required_billing_fields_complete) : false,
          summary: enc ? text(enc.session_summary) || null : null,
        },
        payer: payer ? {
          id: text(payer.id),
          name: text(payer.payer_name),
          category: text(payer.payer_category) || null,
        } : null,
        policy: policy ? {
          id: text(policy.id),
          planName: text(policy.plan_name) || null,
          memberId: text(policy.subscriber_id) || text(policy.policy_number) || null,
        } : null,
        providerSelectedCode: providerCode,
        systemSuggestedCode: suggestedCode,
        codingAlerts,
        eligibility: elig ? {
          status: eligStatus,
          checkedAt: elig.checked_at ?? null,
          authorizationRequired: Boolean(elig.authorization_required),
          rawStatusText: text(elig.raw_status_text) || null,
        } : null,
        authorization: { status: "—", number: null as string | null }, // no auth table yet
        chargeAmount: num(c.total_charge),
        agingDays: ageDays(c.service_date as string | null),
        blockers: blockerText(blockers),
        actionNeeded: actionNeeded(tabId),
        claimId: c.claim_id ?? null,
      };
    });

    // In-memory filters (after tab classification).
    let filtered = items;
    if (tab) filtered = filtered.filter((i) => i.tab === tab);
    if (clientQ) {
      filtered = filtered.filter(
        (i) =>
          i.client.name.toLowerCase().includes(clientQ) ||
          (i.providerSelectedCode ?? "").toLowerCase().includes(clientQ) ||
          (i.systemSuggestedCode ?? "").toLowerCase().includes(clientQ),
      );
    }
    if (clinicianQ) filtered = filtered.filter((i) => i.clinician === clinicianQ);
    if (payerQ) filtered = filtered.filter((i) => i.payer?.name === payerQ);
    if (Number.isFinite(minAmount)) filtered = filtered.filter((i) => i.chargeAmount >= minAmount);
    if (priorityQ === "urgent") {
      filtered = filtered.filter(
        (i) => i.tab === "documentation_missing" || i.tab === "coding_mismatch" || i.tab === "eligibility_auth_issue" || i.tab === "held_charges",
      );
    }

    const tabCounts = CHARGE_CAPTURE_TABS.reduce<Record<string, number>>((acc, t) => {
      acc[t.id] = items.filter((i) => i.tab === t.id).length;
      return acc;
    }, {});

    return NextResponse.json({
      success: true,
      organizationId,
      tabs: CHARGE_CAPTURE_TABS,
      tabCounts,
      items: filtered,
      totalItems: items.length,
    });
  } catch (e) {
    console.error("Charge capture list API error:", e);
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed to load charge capture queue" },
      { status: 500 },
    );
  }
}
