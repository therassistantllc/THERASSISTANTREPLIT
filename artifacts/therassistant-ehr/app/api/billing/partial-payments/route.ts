/**
 * GET /api/billing/partial-payments
 *
 * "Partial Payments" workqueue: claims that have been paid in part, not
 * fully paid, and not fully denied. The source of truth for each row's
 * dollar columns is the latest ERA (`era_claim_payments`) joined to the
 * underlying `professional_claims`.
 *
 * Tabs (a single claim may belong to multiple):
 *   - partial_payment        Insurance paid 0 < x < billed and the claim
 *                            is not fully denied.
 *   - multiple_line_issues   ERA service_lines contains 2+ lines and at
 *                            least one line was adjusted (paid < billed
 *                            or carries a CAS row).
 *   - bundled_payment        A line carries CARC 97 (paid as part of
 *                            another already-adjudicated service) or
 *                            the ERA paid one line and zero-allowed
 *                            another with CO group code.
 *   - split_responsibility   ERA reports both insurance payment AND
 *                            client responsibility (`clp05` > 0 with
 *                            `clp04` > 0).
 *   - secondary_needed       Primary paid less than billed AND the
 *                            client has an active secondary policy.
 *
 * Action history is overlaid from `audit_logs` rows with event_type
 * prefixed `pp_` (accept_payment, appeal_balance, bill_secondary,
 * transfer_to_patient, add_note). Resolved claims drop off by default.
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

function daysSince(iso: string | null | undefined): number | null {
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

function priorityFor(days: number | null, remaining: number): "low" | "normal" | "high" | "urgent" {
  const d = days ?? 0;
  if (d >= 90 || remaining >= 1000) return "urgent";
  if (d >= 60 || remaining >= 300) return "high";
  if (d >= 30) return "normal";
  return "low";
}

export type PartialTab =
  | "partial_payment"
  | "multiple_line_issues"
  | "bundled_payment"
  | "split_responsibility"
  | "secondary_needed";

export type PartialState =
  | "open"
  | "payment_accepted"
  | "appealed"
  | "billed_secondary"
  | "transferred_to_patient"
  | "resolved";

export interface AdjustmentEntry {
  group_code: string;
  reason_code: string;
  amount: number;
  description?: string;
}

export interface EraServiceLineRow {
  line_number: number;
  procedure_code: string;
  billed_amount: number;
  allowed_amount: number;
  paid_amount: number;
  adjustments: AdjustmentEntry[];
}

export interface PartialRow {
  id: string;                // professional_claims.id
  era_claim_payment_id: string | null;
  claim_number: string;
  client_id: string | null;
  client_name: string;
  payer_profile_id: string | null;
  payer_name: string;
  billed_amount: number;
  allowed_amount: number;
  paid_amount: number;
  adjustment_amount: number;
  remaining_balance: number;
  patient_responsibility: number;
  responsibility_type: string;
  service_date: string | null;
  clinician_id: string | null;
  clinician_name: string | null;
  age_days: number | null;
  aging_bucket: string;
  priority: "low" | "normal" | "high" | "urgent";
  tabs: PartialTab[];
  state: PartialState;
  status_label: string;
  era_service_lines: EraServiceLineRow[];
  claim_service_lines: Array<{
    line_number: number;
    procedure_code: string;
    charge_amount: number;
    units: number;
    service_date: string | null;
  }>;
  cas_adjustments: AdjustmentEntry[];
  has_secondary_policy: boolean;
  secondary_payer_name: string | null;
  assigned_to_user_id: string | null;
  last_action_at: string | null;
  last_action: string | null;
  workqueue_item_id: string | null;
  carc_codes: string[];
  rarc_codes: string[];
}

export interface PartialSummary {
  total_count: number;
  total_dollars: number;
  oldest_age_days: number | null;
  urgent_count: number;
  by_tab: Record<PartialTab, number>;
}

const ACTION_EVENT_PREFIX = "pp_";

function emptySummary(): PartialSummary {
  return {
    total_count: 0,
    total_dollars: 0,
    oldest_age_days: null,
    urgent_count: 0,
    by_tab: {
      partial_payment: 0,
      multiple_line_issues: 0,
      bundled_payment: 0,
      split_responsibility: 0,
      secondary_needed: 0,
    },
  };
}

function stateLabel(s: PartialState): string {
  switch (s) {
    case "open": return "Open";
    case "payment_accepted": return "Payment accepted";
    case "appealed": return "Appeal filed";
    case "billed_secondary": return "Billed secondary";
    case "transferred_to_patient": return "On client";
    case "resolved": return "Resolved";
  }
}

function parseAdjustments(raw: unknown): AdjustmentEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      if (!r || typeof r !== "object") return null;
      const o = r as Record<string, unknown>;
      const group = text(o.group_code ?? o.cas01 ?? o.group);
      const reason = text(o.reason_code ?? o.cas02 ?? o.code);
      const amount = money(o.amount ?? o.cas03 ?? o.value);
      if (!group && !reason && amount === 0) return null;
      const entry: AdjustmentEntry = {
        group_code: group,
        reason_code: reason,
        amount,
      };
      const desc = text(o.description ?? o.reason ?? "");
      if (desc) entry.description = desc;
      return entry;
    })
    .filter((x): x is AdjustmentEntry => x !== null);
}

function parseEraServiceLines(raw: unknown): EraServiceLineRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r, idx) => {
      if (!r || typeof r !== "object") return null;
      const o = r as Record<string, unknown>;
      const lineNumber = Number(o.line_number ?? o.lx01 ?? idx + 1) || idx + 1;
      const billed = money(o.billed_amount ?? o.svc02 ?? o.charge_amount);
      const paid = money(o.paid_amount ?? o.svc03);
      const allowedRaw = o.allowed_amount ?? o.svc_allowed;
      const allowed = allowedRaw == null ? Math.max(paid, 0) : money(allowedRaw);
      return {
        line_number: lineNumber,
        procedure_code:
          text(o.procedure_code ?? o.cpt ?? o.svc01) || "—",
        billed_amount: billed,
        allowed_amount: allowed,
        paid_amount: paid,
        adjustments: parseAdjustments(o.adjustments ?? o.cas ?? []),
      } satisfies EraServiceLineRow;
    })
    .filter((x): x is EraServiceLineRow => x !== null)
    .sort((a, b) => a.line_number - b.line_number);
}

function deriveResponsibilityType(
  cas: AdjustmentEntry[],
  patientResp: number,
): string {
  const groups = new Set(cas.map((c) => c.group_code).filter(Boolean));
  const hasPR = groups.has("PR") || patientResp > 0;
  const hasCO = groups.has("CO");
  const hasOA = groups.has("OA");
  const hasPI = groups.has("PI");
  const parts: string[] = [];
  if (hasPR) parts.push("Client");
  if (hasCO) parts.push("Contractual");
  if (hasOA) parts.push("Other");
  if (hasPI) parts.push("Payer");
  if (parts.length === 0) return "Insurance";
  if (parts.length === 1) return parts[0];
  return parts.join(" + ");
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

    const filterTab = (searchParams.get("tab") ?? "").trim() as PartialTab | "";
    const filterClinician = (searchParams.get("clinician") ?? "").trim();
    const filterPayer = (searchParams.get("payer") ?? "").trim();
    const filterClient = (searchParams.get("client") ?? "").trim();
    const filterDosFrom = (searchParams.get("dosFrom") ?? "").trim();
    const filterDosTo = (searchParams.get("dosTo") ?? "").trim();
    const filterStatus = (searchParams.get("status") ?? "").trim();
    const filterAssignedBiller = (searchParams.get("assignedBiller") ?? "").trim();
    const filterPriority = (searchParams.get("priority") ?? "").trim();
    const filterAgingBucket = (searchParams.get("agingBucket") ?? "").trim();
    const filterCarcRarc = (searchParams.get("carcRarc") ?? "").trim().toLowerCase();
    const filterFollowUpDue = (searchParams.get("followUpDue") ?? "").trim();
    const filterMinAmount = Number(searchParams.get("minAmount") ?? "");
    const filterMaxAmount = Number(searchParams.get("maxAmount") ?? "");

    // ── 1. Pull recent ERA records (drives the population). ────────────
    const lookbackFrom = new Date();
    lookbackFrom.setMonth(lookbackFrom.getMonth() - 18);

    const { data: eraRows, error: eraErr } = await (supabase as any)
      .from("era_claim_payments")
      .select(
        "id, professional_claim_id, clp02_claim_status_code, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, cas_adjustments, service_lines, carc_codes, rarc_codes, created_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .gte("created_at", lookbackFrom.toISOString())
      .order("created_at", { ascending: false })
      .limit(2000);
    if (eraErr) throw eraErr;

    const eras = (eraRows ?? []) as DbRow[];

    // Keep the latest ERA per claim only.
    const latestEraByClaim = new Map<string, DbRow>();
    for (const e of eras) {
      const cid = text(e.professional_claim_id);
      if (!cid) continue;
      if (!latestEraByClaim.has(cid)) latestEraByClaim.set(cid, e);
    }

    const claimIds = Array.from(latestEraByClaim.keys());

    if (claimIds.length === 0) {
      return NextResponse.json({
        success: true,
        organizationId,
        items: [],
        summary: emptySummary(),
      });
    }

    const [
      { data: claimRows },
      { data: serviceLineRows },
      { data: workqueueItems },
      { data: notesRows },
      { data: auditRows },
    ] = await Promise.all([
      (supabase as any)
        .from("professional_claims")
        .select(
          "id, organization_id, patient_id, appointment_id, payer_profile_id, claim_number, claim_status, total_charge, created_at, updated_at",
        )
        .eq("organization_id", organizationId)
        .in("id", claimIds),
      (supabase as any)
        .from("professional_claim_service_lines")
        .select(
          "claim_id, line_number, procedure_code, charge_amount, units, service_date_from, service_date_to",
        )
        .in("claim_id", claimIds)
        .order("line_number", { ascending: true }),
      // Task #485: this queue is driven by claim_workqueue_items rows
      // tagged item_status='partial_payment' (open) or 'resolved' /
      // 'deferred' (terminal). Filter to those statuses so we never
      // surface an unrelated workqueue row (denial, aging, eligibility,
      // etc.) when overlaying state / priority / assignment. Order by
      // updated_at desc so the freshest row for the partial-payments
      // workflow wins when more than one historical row exists.
      (supabase as any)
        .from("claim_workqueue_items")
        .select(
          "id, claim_id, item_status, priority, assigned_to_user_id, action_taken, days_in_ar, updated_at",
        )
        .eq("organization_id", organizationId)
        .in("claim_id", claimIds)
        .in("item_status", ["partial_payment", "resolved", "deferred"])
        .is("archived_at", null)
        .order("updated_at", { ascending: false }),
      (supabase as any)
        .from("claim_notes")
        .select("claim_id, body, created_at")
        .eq("organization_id", organizationId)
        .in("claim_id", claimIds)
        .order("created_at", { ascending: false }),
      (supabase as any)
        .from("audit_logs")
        .select("claim_id, event_type, event_summary, event_metadata, created_at, user_id")
        .eq("organization_id", organizationId)
        .in("claim_id", claimIds)
        .ilike("event_type", `${ACTION_EVENT_PREFIX}%`)
        .order("created_at", { ascending: true }),
    ]);

    const claims = (claimRows ?? []) as DbRow[];
    const claimById = new Map<string, DbRow>(
      claims.map((c) => [text(c.id), c]),
    );

    const clientIds = [
      ...new Set(claims.map((c) => text(c.patient_id)).filter(Boolean)),
    ];
    const payerIds = [
      ...new Set(claims.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];
    const apptIds = [
      ...new Set(claims.map((c) => text(c.appointment_id)).filter(Boolean)),
    ];

    const [
      { data: clientRows },
      { data: payerRows },
      { data: apptRows },
      { data: policyRows },
    ] = await Promise.all([
      clientIds.length
        ? (supabase as any)
            .from("clients")
            .select("id, first_name, last_name")
            .in("id", clientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name")
            .in("id", payerIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      apptIds.length
        ? (supabase as any)
            .from("appointments")
            .select("id, provider_id, scheduled_start_at")
            .in("id", apptIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      clientIds.length
        ? (supabase as any)
            .from("insurance_policies")
            .select(
              "client_id, payer_id, priority, active_flag, archived_at",
            )
            .eq("organization_id", organizationId)
            .in("client_id", clientIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const providerIds = [
      ...new Set(
        ((apptRows ?? []) as DbRow[])
          .map((a) => text(a.provider_id))
          .filter(Boolean),
      ),
    ];
    const { data: providerRows } = providerIds.length
      ? await (supabase as any)
          .from("providers")
          .select("id, first_name, last_name, display_name")
          .in("id", providerIds)
      : { data: [] as DbRow[] };

    // Resolve secondary-payer names via insurance_policies → payer_profiles.
    const secondaryPayerIdByClient = new Map<string, string>();
    const policiesByClient = new Map<string, DbRow[]>();
    for (const p of (policyRows ?? []) as DbRow[]) {
      const cid = text(p.client_id);
      if (!cid) continue;
      const arr = policiesByClient.get(cid) ?? [];
      arr.push(p);
      policiesByClient.set(cid, arr);
      if (
        p.active_flag !== false &&
        text(p.priority) === "secondary" &&
        text(p.payer_id) &&
        !secondaryPayerIdByClient.has(cid)
      ) {
        secondaryPayerIdByClient.set(cid, text(p.payer_id));
      }
    }
    const extraPayerIds = Array.from(
      new Set(secondaryPayerIdByClient.values()),
    ).filter((id) => !payerIds.includes(id));
    const { data: extraPayerRows } = extraPayerIds.length
      ? await (supabase as any)
          .from("payer_profiles")
          .select("id, payer_name")
          .in("id", extraPayerIds)
      : { data: [] as DbRow[] };

    const clientById = new Map<string, DbRow>(
      ((clientRows ?? []) as DbRow[]).map((c) => [text(c.id), c]),
    );
    const payerById = new Map<string, DbRow>(
      [
        ...((payerRows ?? []) as DbRow[]),
        ...((extraPayerRows ?? []) as DbRow[]),
      ].map((p) => [text(p.id), p]),
    );
    const apptById = new Map<string, DbRow>(
      ((apptRows ?? []) as DbRow[]).map((a) => [text(a.id), a]),
    );
    const providerById = new Map<string, DbRow>(
      ((providerRows ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );

    const serviceLinesByClaim = new Map<string, DbRow[]>();
    for (const sl of (serviceLineRows ?? []) as DbRow[]) {
      const cid = text(sl.claim_id);
      if (!cid) continue;
      const arr = serviceLinesByClaim.get(cid) ?? [];
      arr.push(sl);
      serviceLinesByClaim.set(cid, arr);
    }

    const wqByClaim = new Map<string, DbRow>();
    for (const w of (workqueueItems ?? []) as DbRow[]) {
      const cid = text(w.claim_id);
      if (!wqByClaim.has(cid)) wqByClaim.set(cid, w);
    }

    const lastNoteByClaim = new Map<string, DbRow>();
    for (const n of (notesRows ?? []) as DbRow[]) {
      const cid = text(n.claim_id);
      if (!lastNoteByClaim.has(cid)) lastNoteByClaim.set(cid, n);
    }

    type AuditAgg = {
      state: PartialState;
      last_action_at: string | null;
      last_action: string | null;
    };
    const auditByClaim = new Map<string, AuditAgg>();
    for (const a of (auditRows ?? []) as DbRow[]) {
      const cid = text(a.claim_id);
      if (!cid) continue;
      const cur = auditByClaim.get(cid) ?? {
        state: "open" as PartialState,
        last_action_at: null as string | null,
        last_action: null as string | null,
      };
      const ev = text(a.event_type);
      cur.last_action_at = text(a.created_at) || cur.last_action_at;
      cur.last_action = text(a.event_summary) || ev.replace(ACTION_EVENT_PREFIX, "");
      switch (ev) {
        case `${ACTION_EVENT_PREFIX}accept_payment`:
          cur.state = "payment_accepted";
          break;
        case `${ACTION_EVENT_PREFIX}appeal_balance`:
          cur.state = "appealed";
          break;
        case `${ACTION_EVENT_PREFIX}bill_secondary`:
          cur.state = "billed_secondary";
          break;
        case `${ACTION_EVENT_PREFIX}transfer_to_patient`:
          cur.state = "transferred_to_patient";
          break;
        case `${ACTION_EVENT_PREFIX}reopen`:
          cur.state = "open";
          break;
        // add_note doesn't change state.
      }
      auditByClaim.set(cid, cur);
    }

    // ── 2. Build rows. ────────────────────────────────────────────────
    const allRows: PartialRow[] = [];

    for (const claimId of claimIds) {
      const claim = claimById.get(claimId);
      if (!claim) continue;
      const era = latestEraByClaim.get(claimId)!;

      const clientId = text(claim.patient_id);
      const apptId = text(claim.appointment_id);
      const apptRow = apptId ? apptById.get(apptId) : undefined;

      const billed = money(era.clp03_total_charge ?? claim.total_charge);
      const paid = money(era.clp04_payment_amount);
      const patientResp = money(era.clp05_patient_responsibility);
      const eraSvcLines = parseEraServiceLines(era.service_lines);
      const cas = parseAdjustments(era.cas_adjustments);
      const adjustmentAmount = Math.round(
        (cas.reduce((s, c) => s + (c.amount || 0), 0) +
          eraSvcLines.reduce(
            (s, l) =>
              s + l.adjustments.reduce((ls, la) => ls + (la.amount || 0), 0),
            0,
          )) *
          100,
      ) / 100;
      const allowedSumLines = eraSvcLines.reduce((s, l) => s + l.allowed_amount, 0);
      const allowed = allowedSumLines > 0
        ? Math.round(allowedSumLines * 100) / 100
        : Math.round(Math.max(0, billed - adjustmentAmount) * 100) / 100;
      const remaining = Math.round(Math.max(0, billed - paid - adjustmentAmount) * 100) / 100;

      // Skip claims that are either fully paid (remaining ~0 and client
      // resp 0) or pre-payment (no paid amount and no client resp).
      if (paid === 0 && patientResp === 0 && remaining === 0) continue;
      if (remaining === 0 && patientResp === 0) continue;

      // Skip pure denials (no insurance payment at all and no PR).
      if (paid === 0 && patientResp === 0) continue;

      const carcCodes = Array.isArray(era.carc_codes)
        ? (era.carc_codes as unknown[]).map(text).filter(Boolean)
        : [];
      const rarcCodes = Array.isArray(era.rarc_codes)
        ? (era.rarc_codes as unknown[]).map(text).filter(Boolean)
        : [];

      // ── Tab classification ──────────────────────────────────────
      const tabs: PartialTab[] = [];

      if (paid > 0 && paid < billed) {
        tabs.push("partial_payment");
      }

      const adjustedLines = eraSvcLines.filter(
        (l) => l.paid_amount < l.billed_amount || l.adjustments.length > 0,
      );
      if (eraSvcLines.length > 1 && adjustedLines.length > 0) {
        tabs.push("multiple_line_issues");
      }

      const hasBundleCarc =
        carcCodes.includes("97") ||
        cas.some((c) => c.reason_code === "97") ||
        eraSvcLines.some((l) =>
          l.adjustments.some((a) => a.reason_code === "97"),
        );
      const hasZeroAllowedLine = eraSvcLines.some(
        (l) => l.billed_amount > 0 && l.allowed_amount === 0 && l.paid_amount === 0,
      );
      if (hasBundleCarc || (eraSvcLines.length > 1 && hasZeroAllowedLine)) {
        tabs.push("bundled_payment");
      }

      if (patientResp > 0 && paid > 0) {
        tabs.push("split_responsibility");
      }

      const secondaryPayerId = secondaryPayerIdByClient.get(clientId);
      const hasSecondary = Boolean(secondaryPayerId);
      const secondaryPayer = secondaryPayerId
        ? payerById.get(secondaryPayerId)
        : undefined;
      if (hasSecondary && remaining > 0) {
        tabs.push("secondary_needed");
      }

      // Only include claims that match at least one tab.
      if (tabs.length === 0) continue;

      const client = clientId ? clientById.get(clientId) : undefined;
      const clientName = client
        ? [client.first_name, client.last_name]
            .map(text)
            .filter(Boolean)
            .join(" ") || "Unknown client"
        : "Unknown client";

      const payerProfileId = text(claim.payer_profile_id) || null;
      const payer = payerProfileId ? payerById.get(payerProfileId) : undefined;
      const payerName = payer ? text(payer.payer_name) || "Unknown payer" : "Unknown payer";

      const dosIso = apptRow ? text(apptRow.scheduled_start_at) : null;
      const claimLines = (serviceLinesByClaim.get(claimId) ?? []).map((sl) => ({
        line_number: Number(sl.line_number) || 0,
        procedure_code: text(sl.procedure_code),
        charge_amount: money(sl.charge_amount),
        units: Number(sl.units ?? 1) || 1,
        service_date: text(sl.service_date_from) || null,
      }));
      const dos =
        (dosIso ? dosIso.slice(0, 10) : null) ??
        (claimLines.length > 0 ? claimLines[0].service_date : null);
      const ageDays = daysSince(dos);

      const provId = apptRow ? text(apptRow.provider_id) : "";
      const provider = provId ? providerById.get(provId) : undefined;
      const clinicianName = provider
        ? text(provider.display_name) ||
          [provider.first_name, provider.last_name]
            .map(text)
            .filter(Boolean)
            .join(" ") ||
          null
        : null;

      const wq = wqByClaim.get(claimId);
      const audit = auditByClaim.get(claimId);
      const lastNote = lastNoteByClaim.get(claimId);

      // Task #485: prefer the claim_workqueue_items row when present so
      // assignment / deferral / resolution survive across page loads. The
      // audit-derived state still wins for the specific terminal labels
      // (payment_accepted / appealed / billed_secondary / transferred)
      // because action route stamps both — but a wq row tagged 'resolved'
      // (or 'deferred') trumps any leftover open audit state.
      const wqItemStatus = wq ? text(wq.item_status) : "";
      let state: PartialState = audit?.state ?? "open";
      if (wqItemStatus === "resolved" || wqItemStatus === "deferred") {
        state = "resolved";
      }
      const lastActionAt =
        audit?.last_action_at ?? (text(lastNote?.created_at) || null);
      const lastAction =
        audit?.last_action ??
        (lastNote
          ? `Note: ${text(lastNote.body).slice(0, 80)}`
          : text(wq?.action_taken) || null);

      const row: PartialRow = {
        id: claimId,
        era_claim_payment_id: text(era.id) || null,
        claim_number: text(claim.claim_number) || claimId.slice(0, 8),
        client_id: clientId || null,
        client_name: clientName,
        payer_profile_id: payerProfileId,
        payer_name: payerName,
        billed_amount: billed,
        allowed_amount: allowed,
        paid_amount: paid,
        adjustment_amount: adjustmentAmount,
        remaining_balance: remaining,
        patient_responsibility: patientResp,
        responsibility_type: deriveResponsibilityType(cas, patientResp),
        service_date: dos,
        clinician_id: provId || null,
        clinician_name: clinicianName,
        age_days: ageDays,
        aging_bucket: agingBucket(ageDays),
        priority: (wq && text(wq.priority)
          ? (text(wq.priority) as "low" | "normal" | "high" | "urgent")
          : priorityFor(ageDays, remaining)),
        tabs,
        state,
        status_label: stateLabel(state),
        era_service_lines: eraSvcLines,
        claim_service_lines: claimLines.sort(
          (a, b) => a.line_number - b.line_number,
        ),
        cas_adjustments: cas,
        has_secondary_policy: hasSecondary,
        secondary_payer_name: secondaryPayer
          ? text(secondaryPayer.payer_name) || null
          : null,
        assigned_to_user_id: wq ? text(wq.assigned_to_user_id) || null : null,
        last_action_at: lastActionAt,
        last_action: lastAction,
        workqueue_item_id: wq ? text(wq.id) : null,
        carc_codes: carcCodes,
        rarc_codes: rarcCodes,
      };

      allRows.push(row);
    }

    // ── 3. Tab + filter narrowing. ────────────────────────────────────
    const items: PartialRow[] = [];
    for (const row of allRows) {
      if (filterTab && !row.tabs.includes(filterTab)) continue;
      if (filterStatus) {
        if (filterStatus === "open" && row.state !== "open") continue;
        if (filterStatus !== "open" && row.state !== filterStatus) continue;
      } else {
        // Default: hide resolved claims.
        if (row.state === "resolved") continue;
      }
      if (filterClinician && row.clinician_id !== filterClinician) continue;
      if (filterPayer && row.payer_name !== filterPayer) continue;
      if (filterClient && row.client_id !== filterClient) continue;
      if (filterAssignedBiller && row.assigned_to_user_id !== filterAssignedBiller) continue;
      if (filterPriority && row.priority !== filterPriority) continue;
      if (filterAgingBucket && row.aging_bucket !== filterAgingBucket) continue;
      if (filterDosFrom && (row.service_date ?? "") < filterDosFrom) continue;
      if (filterDosTo && (row.service_date ?? "") > filterDosTo) continue;
      if (Number.isFinite(filterMinAmount) && row.remaining_balance < filterMinAmount) continue;
      if (Number.isFinite(filterMaxAmount) && row.remaining_balance > filterMaxAmount) continue;
      if (filterCarcRarc) {
        const haystack = [
          ...row.carc_codes,
          ...row.rarc_codes,
          ...row.cas_adjustments.map((c) => c.reason_code),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(filterCarcRarc)) continue;
      }
      if (filterFollowUpDue) {
        // Treat follow-up due ≤ filter date as "due by" filter; we don't
        // track per-claim follow-up date yet, so approximate with age.
        const cutoff = daysSince(filterFollowUpDue) ?? 0;
        if ((row.age_days ?? 0) < cutoff) continue;
      }
      items.push(row);
    }

    // ── 4. Summary (across all open rows, ignoring tab filter). ───────
    const openRows = allRows.filter((r) => r.state !== "resolved");
    const summary: PartialSummary = {
      total_count: openRows.length,
      total_dollars: Math.round(
        openRows.reduce((s, r) => s + r.remaining_balance, 0) * 100,
      ) / 100,
      oldest_age_days: openRows.reduce<number | null>((max, r) => {
        if (r.age_days == null) return max;
        if (max == null) return r.age_days;
        return Math.max(max, r.age_days);
      }, null),
      urgent_count: openRows.filter(
        (r) => r.priority === "urgent" || r.priority === "high",
      ).length,
      by_tab: {
        partial_payment: 0,
        multiple_line_issues: 0,
        bundled_payment: 0,
        split_responsibility: 0,
        secondary_needed: 0,
      },
    };
    for (const r of openRows) {
      for (const t of r.tabs) summary.by_tab[t] += 1;
    }

    return NextResponse.json({ success: true, organizationId, items, summary });
  } catch (error) {
    console.error("Partial Payments API error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load Partial Payments worklist",
      },
      { status: 500 },
    );
  }
}
