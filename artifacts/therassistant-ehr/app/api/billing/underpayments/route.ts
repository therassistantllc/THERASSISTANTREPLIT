/**
 * GET /api/billing/underpayments?organizationId=...&...filters
 *
 * Powers the Underpayments workqueue (Task #377). A "row" is one ERA service
 * line that was reimbursed below the contracted fee-schedule amount, or where
 * the paid amount is below the payer's allowed amount.
 *
 * Tabs (a row can appear in more than one):
 *   commercial          — payer.payer_type = 'commercial' (or null)
 *   medicaid            — payer.payer_type = 'medicaid'
 *   contract_variance   — a fee_schedules row exists and allowed_paid < expected
 *   missing_modifier    — the claim line carried modifiers, but the fee_schedule
 *                         match required dropping them (suggests the payer
 *                         didn't honor a modifier uplift)
 *   partial_payment     — paid < allowed (insurance left money on the table
 *                         that isn't client responsibility)
 *
 * Rows previously marked accepted via the action endpoint are filtered out by
 * matching a claim_notes marker of the form
 *   UNDERPAYMENT_ACCEPTED:<eraPaymentId>#<lineIndex>
 *
 * Universal filter rail: practice, clinician, payer, client, dosFrom/dosTo,
 * status, assignedBiller, minAmount/maxAmount, agingBucket, carcRarc,
 * priority, followUpDue.
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
const ageDays = (d: string | null) => {
  if (!d) return 0;
  const t = Date.parse(d);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 3600 * 1000)));
};

export type UnderpaymentTab =
  | "commercial"
  | "medicaid"
  | "contract_variance"
  | "missing_modifier"
  | "partial_payment";

export interface UnderpaymentRow {
  id: string;
  tabs: UnderpaymentTab[];
  eraPaymentId: string;
  lineIndex: number;
  professionalClaimId: string | null;
  claimNumber: string | null;
  clientId: string | null;
  clientName: string;
  clinician: string;
  payerId: string | null;
  payerName: string;
  payerType: "medicaid" | "medicare" | "commercial" | "other" | null;
  procedureCode: string;
  modifiers: string[];
  allowedExpected: number;
  allowedPaid: number;
  paidAmount: number;
  patientResponsibility: number;
  variance: number;
  paidDate: string | null;
  dos: string | null;
  contractSource: string;
  contractId: string | null;
  feeScheduleId: string | null;
  carcCodes: string[];
  rarcCodes: string[];
  status: string;
  createdAt: string | null;
  priority: "high" | "medium" | "low";
  /**
   * Auto-detected fee-schedule-stale signal. Populated when >=3 ERA payments
   * for the same (payer, CPT, modifiers) have reimbursed the exact same
   * `allowedPaid` amount — strongly suggesting the contracted rate on file is
   * out of date rather than a real underpayment. Surfaced on Contract Variance.
   */
  suggestion: {
    kind: "repeated_payment";
    /** The amount each of those ERAs allowed — the proposed new contract rate. */
    adoptAmount: number;
    /** How many distinct ERA payments share that allowed amount. */
    sampleCount: number;
    /** Group key shared across all rows in the same suggestion cluster. */
    groupKey: string;
    /** All workqueue row ids in the same cluster (used to archive together). */
    similarRowIds: string[];
  } | null;
}

interface FilterSelection {
  client: string | null;
  clinician: string | null;
  payer: string | null;
  practice: string | null;
  dosFrom: string | null;
  dosTo: string | null;
  status: string | null;
  assignedBiller: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  agingBucket: "0-30" | "31-60" | "61-90" | "90+" | null;
  carcRarc: string | null;
  priority: "high" | "medium" | "low" | null;
  followUpDue: string | null;
}

function parseFilters(p: URLSearchParams): FilterSelection {
  const v = (k: string) => {
    const r = p.get(k);
    return r && r.trim() ? r.trim() : null;
  };
  const num = (k: string) => {
    const r = v(k);
    if (r == null) return null;
    const n = Number(r);
    return Number.isFinite(n) ? n : null;
  };
  const ag = v("agingBucket");
  const pr = v("priority");
  return {
    client: v("client"),
    clinician: v("clinician"),
    payer: v("payer"),
    practice: v("practice"),
    dosFrom: v("dosFrom"),
    dosTo: v("dosTo"),
    status: v("status"),
    assignedBiller: v("assignedBiller"),
    minAmount: num("minAmount"),
    maxAmount: num("maxAmount"),
    agingBucket:
      ag === "0-30" || ag === "31-60" || ag === "61-90" || ag === "90+"
        ? ag
        : null,
    carcRarc: v("carcRarc"),
    priority: pr === "high" || pr === "medium" || pr === "low" ? pr : null,
    followUpDue: v("followUpDue"),
  };
}

function passesAging(d: string | null, bucket: FilterSelection["agingBucket"]) {
  if (!bucket) return true;
  const a = ageDays(d);
  if (bucket === "0-30") return a <= 30;
  if (bucket === "31-60") return a > 30 && a <= 60;
  if (bucket === "61-90") return a > 60 && a <= 90;
  return a > 90;
}

function derivePriority(args: {
  variance: number;
  createdAt: string | null;
}): "high" | "medium" | "low" {
  const age = ageDays(args.createdAt);
  if (args.variance >= 250 || age > 60) return "high";
  if (args.variance >= 50 || age > 30) return "medium";
  return "low";
}

async function loadFacets(supabase: any, organizationId: string) {
  const [{ data: payers }, { data: locations }, { data: providers }] = await Promise.all([
    supabase
      .from("payer_profiles")
      .select("id, payer_name")
      .eq("organization_id", organizationId)
      .order("payer_name", { ascending: true }),
    supabase
      .from("locations")
      .select("id, name")
      .eq("organization_id", organizationId)
      .order("name", { ascending: true }),
    supabase
      .from("staff_profiles")
      .select("id, first_name, last_name")
      .eq("organization_id", organizationId)
      .order("last_name", { ascending: true }),
  ]);

  return {
    payers: ((payers as DbRow[]) ?? []).map((p) => ({
      id: text(p.id),
      name: text(p.payer_name) || "Unknown payer",
    })),
    practices: ((locations as DbRow[]) ?? []).map((l) => ({
      id: text(l.id),
      name: text(l.name) || "Unnamed practice",
    })),
    clinicians: ((providers as DbRow[]) ?? [])
      .map((p) =>
        [text(p.first_name), text(p.last_name)].filter(Boolean).join(" ") || "",
      )
      .filter(Boolean),
  };
}

interface FeeScheduleRow {
  id: string;
  payer_contract_id: string | null;
  procedure_code: string;
  modifiers: string[] | null;
  allowed_amount: number | string;
  schedule_name: string | null;
  effective_date: string | null;
  expiration_date: string | null;
}

function pickFeeSchedule(
  rows: FeeScheduleRow[],
  procedureCode: string,
  modifiers: string[],
  dos: string | null,
): { exact: FeeScheduleRow | null; codeOnly: FeeScheduleRow | null } {
  const pc = procedureCode.toUpperCase();
  const mods = (modifiers ?? []).map((m) => m.toUpperCase()).sort();
  const candidates = rows.filter(
    (r) => text(r.procedure_code).toUpperCase() === pc,
  );
  const effective = candidates.filter((r) => {
    if (!dos) return true;
    if (r.effective_date && dos < r.effective_date) return false;
    if (r.expiration_date && dos > r.expiration_date) return false;
    return true;
  });
  const pool = effective.length > 0 ? effective : candidates;

  let exact: FeeScheduleRow | null = null;
  let codeOnly: FeeScheduleRow | null = null;
  for (const r of pool) {
    const rm = (r.modifiers ?? []).map((m) => m.toUpperCase()).sort();
    const sameMods =
      rm.length === mods.length && rm.every((v, i) => v === mods[i]);
    if (sameMods) {
      if (
        !exact ||
        Number(r.allowed_amount ?? 0) > Number(exact.allowed_amount ?? 0)
      ) {
        exact = r;
      }
    }
    if (rm.length === 0) {
      if (
        !codeOnly ||
        Number(r.allowed_amount ?? 0) > Number(codeOnly.allowed_amount ?? 0)
      ) {
        codeOnly = r;
      }
    }
  }
  return { exact, codeOnly };
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
    const filters = parseFilters(searchParams);

    // ── Pull recent matched ERA claim payments ──────────────────────────
    let q = (supabase as any)
      .from("era_claim_payments")
      .select(
        "id, organization_id, era_import_batch_id, professional_claim_id, client_id, clp01_claim_control_number, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, allowed_amount, adjustment_amount, service_lines, carc_codes, rarc_codes, created_at, check_issue_date",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .eq("claim_match_status", "matched")
      .order("created_at", { ascending: false })
      .limit(2000);

    const { data: payRaw, error } = await q;
    if (error) throw error;
    const payments: DbRow[] = (payRaw as DbRow[]) ?? [];

    // ── Joins ───────────────────────────────────────────────────────────
    const batchIds = [
      ...new Set(payments.map((p) => text(p.era_import_batch_id)).filter(Boolean)),
    ];
    const claimIds = [
      ...new Set(
        payments.map((p) => text(p.professional_claim_id)).filter(Boolean),
      ),
    ];
    const clientIdsSeed = [
      ...new Set(payments.map((p) => text(p.client_id)).filter(Boolean)),
    ];

    const [
      { data: batches },
      { data: claims },
      { data: lines },
      { data: notes },
    ] = await Promise.all([
      batchIds.length
        ? (supabase as any)
            .from("era_import_batches")
            .select("id, payer_identifier, payer_name, imported_at, parsed_summary")
            .in("id", batchIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claims")
            .select(
              "id, claim_number, claim_status, patient_id, payer_profile_id, appointment_id, total_charge, billing_notes, created_at",
            )
            .in("id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claim_service_lines")
            .select(
              "claim_id, line_number, service_date_from, procedure_code, modifiers, charge_amount, units, place_of_service",
            )
            .in("claim_id", claimIds)
            .order("line_number", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_notes")
            .select("claim_id, body, created_at")
            .in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const batchById = new Map<string, DbRow>(
      ((batches as DbRow[]) ?? []).map((b) => [text(b.id), b]),
    );
    const claimById = new Map<string, DbRow>(
      ((claims as DbRow[]) ?? []).map((c) => [text(c.id), c]),
    );

    // Client / payer joins (payer comes from batch OR claim).
    const patientIds = [
      ...new Set(
        Array.from(claimById.values())
          .map((c) => text(c.patient_id))
          .filter(Boolean)
          .concat(clientIdsSeed),
      ),
    ];
    // era_import_batches has no payer_profile_id (denormalized payer_name
     // and payer_identifier only); the authoritative join is via the
     // professional_claims row's payer_profile_id.
    const payerIds = [
      ...new Set(
        Array.from(claimById.values())
          .map((c) => text(c.payer_profile_id))
          .filter(Boolean),
      ),
    ];
    const appointmentIds = [
      ...new Set(
        Array.from(claimById.values())
          .map((c) => text(c.appointment_id))
          .filter(Boolean),
      ),
    ];

    const [
      { data: clients },
      { data: payers },
      { data: contracts },
      { data: appointments },
    ] = await Promise.all([
      patientIds.length
        ? (supabase as any)
            .from("clients")
            .select("id, first_name, last_name, location_id")
            .in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name, payer_type")
            .in("id", payerIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerIds.length
        ? (supabase as any)
            .from("payer_contracts")
            .select(
              "id, payer_profile_id, contract_name, is_active, effective_date, expiration_date",
            )
            .eq("organization_id", organizationId)
            .is("archived_at", null)
            .in("payer_profile_id", payerIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      appointmentIds.length
        ? (supabase as any)
            .from("appointments")
            .select("id, provider_id")
            .in("id", appointmentIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const patientById = new Map<string, DbRow>(
      ((clients as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payers as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const appointmentById = new Map<string, DbRow>(
      ((appointments as DbRow[]) ?? []).map((a) => [text(a.id), a]),
    );
    const contractsByPayer = new Map<string, DbRow[]>();
    for (const c of (contracts as DbRow[]) ?? []) {
      const k = text(c.payer_profile_id);
      if (!contractsByPayer.has(k)) contractsByPayer.set(k, []);
      contractsByPayer.get(k)!.push(c);
    }

    // Provider names for clinician column.
    const providerIds = [
      ...new Set(
        Array.from(appointmentById.values())
          .map((a) => text(a.provider_id))
          .filter(Boolean),
      ),
    ];
    const providerName = new Map<string, string>();
    if (providerIds.length) {
      const { data: provs } = await (supabase as any)
        .from("staff_profiles")
        .select("id, first_name, last_name")
        .in("id", providerIds);
      for (const p of (provs as DbRow[]) ?? []) {
        providerName.set(
          text(p.id),
          [text(p.first_name), text(p.last_name)].filter(Boolean).join(" ") ||
            "—",
        );
      }
    }

    // Index claim service lines by (claim_id, procedure_code) for modifier
    // lookup and DOS resolution.
    const linesByClaim = new Map<string, DbRow[]>();
    for (const l of (lines as DbRow[]) ?? []) {
      const k = text(l.claim_id);
      if (!linesByClaim.has(k)) linesByClaim.set(k, []);
      linesByClaim.get(k)!.push(l);
    }

    // Fee schedules — pull once for the org; pickFeeSchedule filters per row.
    const contractIds = ((contracts as DbRow[]) ?? []).map((c) => text(c.id));
    let feeSchedules: FeeScheduleRow[] = [];
    {
      const { data: fs } = await (supabase as any)
        .from("fee_schedules")
        .select(
          "id, payer_contract_id, procedure_code, modifiers, allowed_amount, schedule_name, effective_date, expiration_date",
        )
        .eq("organization_id", organizationId)
        .is("archived_at", null);
      feeSchedules = ((fs as DbRow[]) ?? []) as FeeScheduleRow[];
    }
    const feeByContract = new Map<string | null, FeeScheduleRow[]>();
    for (const f of feeSchedules) {
      const k = text(f.payer_contract_id) || null;
      if (!feeByContract.has(k)) feeByContract.set(k, []);
      feeByContract.get(k)!.push(f);
    }
    // Pool: contract rates for this payer + org-wide (no contract) rates.
    function feesForPayer(payerId: string | null): FeeScheduleRow[] {
      const out: FeeScheduleRow[] = [];
      const cs = payerId ? contractsByPayer.get(payerId) ?? [] : [];
      for (const c of cs) {
        out.push(...(feeByContract.get(text(c.id)) ?? []));
      }
      out.push(...(feeByContract.get(null) ?? []));
      return out;
    }
    function contractNameById(id: string | null | undefined): string | null {
      if (!id) return null;
      for (const arr of contractsByPayer.values()) {
        const hit = arr.find((c) => text(c.id) === id);
        if (hit) return text(hit.contract_name) || null;
      }
      return null;
    }

    // Acceptance markers from claim_notes.
    const accepted = new Set<string>();
    for (const n of (notes as DbRow[]) ?? []) {
      const body = text(n.body);
      const m = body.match(/^UNDERPAYMENT_ACCEPTED:([^\s]+)/);
      if (m) accepted.add(m[1]);
    }

    // ── Build rows ──────────────────────────────────────────────────────
    const rows: UnderpaymentRow[] = [];

    for (const p of payments) {
      const claimId = text(p.professional_claim_id);
      const claim = claimId ? claimById.get(claimId) ?? null : null;
      const batch = batchById.get(text(p.era_import_batch_id)) ?? null;

      const payerId = text(claim?.payer_profile_id) || null;
      const payer = payerId ? payerById.get(payerId) ?? null : null;
      const payerType =
        (text(payer?.payer_type) as UnderpaymentRow["payerType"]) || null;

      // Filter: payer
      if (filters.payer && payerId !== filters.payer) continue;

      const client = claim ? patientById.get(text(claim.patient_id)) ?? null : null;
      const appt = claim ? appointmentById.get(text(claim.appointment_id)) ?? null : null;
      const clinician =
        (appt ? providerName.get(text(appt.provider_id)) : null) || "—";

      // Filter: practice / clinician / client
      if (filters.practice && text(client?.location_id) !== filters.practice) continue;
      if (filters.clinician && clinician !== filters.clinician) continue;
      if (filters.client) {
        const name = client
          ? `${text(client.first_name)} ${text(client.last_name)}`.toLowerCase()
          : "";
        if (!name.includes(filters.client.toLowerCase())) continue;
      }
      if (filters.assignedBiller && claim) {
        const bn = text(claim.billing_notes).toLowerCase();
        if (!bn.includes(filters.assignedBiller.toLowerCase())) continue;
      }
      if (filters.status && text(claim?.claim_status) !== filters.status) continue;

      const clientName = client
        ? [text(client.first_name), text(client.last_name)]
            .filter(Boolean)
            .join(" ") || "Unknown client"
        : "Unknown client";
      const payerName = payer ? text(payer.payer_name) || "Unknown payer" : "—";

      const claimLines = claimId ? linesByClaim.get(claimId) ?? [] : [];

      const carcCodes = (p.carc_codes as string[] | null) ?? [];
      const rarcCodes = (p.rarc_codes as string[] | null) ?? [];

      if (filters.carcRarc) {
        const needle = filters.carcRarc.toLowerCase();
        const haystack = [...carcCodes, ...rarcCodes].join(",").toLowerCase();
        if (!haystack.includes(needle)) continue;
      }

      const eraLines = Array.isArray(p.service_lines)
        ? (p.service_lines as DbRow[])
        : [];

      // Synthesize at least one line entry when ERA didn't break it down so
      // claim-level underpayments still appear.
      const effectiveLines: Array<{
        line: DbRow;
        index: number;
        claimLine: DbRow | null;
        dos: string | null;
      }> = [];
      if (eraLines.length > 0) {
        eraLines.forEach((l, i) => {
          const pc = text(l.procedure_code).toUpperCase();
          const claimLine =
            claimLines.find(
              (cl) => text(cl.procedure_code).toUpperCase() === pc,
            ) ?? null;
          const dos = claimLine ? text(claimLine.service_date_from) || null : null;
          effectiveLines.push({ line: l, index: i, claimLine, dos });
        });
      } else if (claimLines.length > 0) {
        claimLines.forEach((cl, i) => {
          const synth = {
            procedure_code: cl.procedure_code,
            charge: cl.charge_amount,
            allowed: p.allowed_amount,
            paid: p.clp04_payment_amount,
            adjustment: p.adjustment_amount,
          };
          effectiveLines.push({
            line: synth,
            index: i,
            claimLine: cl,
            dos: text(cl.service_date_from) || null,
          });
        });
      }

      for (const { line, index, claimLine, dos } of effectiveLines) {
        const procedureCode = text(line.procedure_code).toUpperCase();
        if (!procedureCode) continue;
        const modifiers: string[] = Array.isArray(claimLine?.modifiers)
          ? (claimLine!.modifiers as string[]).map((m) => String(m))
          : [];

        const allowedPaid = money(line.allowed);
        const paidAmount = money(line.paid);
        const patientResp =
          (p.clp05_patient_responsibility != null ? money(p.clp05_patient_responsibility) : 0) /
          Math.max(effectiveLines.length, 1);

        const { exact, codeOnly } = pickFeeSchedule(
          feesForPayer(payerId),
          procedureCode,
          modifiers,
          dos,
        );

        let allowedExpected = 0;
        let contractSource = "—";
        let contractId: string | null = null;
        let feeScheduleId: string | null = null;
        let missingModifier = false;

        if (exact) {
          allowedExpected = money(exact.allowed_amount);
          contractSource =
            (exact.payer_contract_id
              ? contractNameById(exact.payer_contract_id)
              : null) ||
            text(exact.schedule_name) ||
            "Fee schedule";
          contractId = text(exact.payer_contract_id) || null;
          feeScheduleId = text(exact.id);
        } else if (codeOnly) {
          allowedExpected = money(codeOnly.allowed_amount);
          contractSource =
            (codeOnly.payer_contract_id
              ? contractNameById(codeOnly.payer_contract_id)
              : null) ||
            text(codeOnly.schedule_name) ||
            "Fee schedule (no-modifier match)";
          contractId = text(codeOnly.payer_contract_id) || null;
          feeScheduleId = text(codeOnly.id);
          if (modifiers.length > 0) missingModifier = true;
        } else {
          allowedExpected = allowedPaid;
          contractSource = "No fee schedule on file";
        }

        const variance = Math.round((allowedExpected - allowedPaid) * 100) / 100;
        const partialPayment = allowedPaid - paidAmount - patientResp > 0.5;

        // Skip rows that aren't actually underpaid in any sense.
        if (variance <= 0.5 && !partialPayment && !missingModifier) continue;

        // Acceptance gate.
        const lineKey = `${text(p.id)}#${index}`;
        if (accepted.has(lineKey)) continue;

        // Amount filter (on variance — that's the actionable dollar value).
        if (filters.minAmount != null && variance < filters.minAmount) continue;
        if (filters.maxAmount != null && variance > filters.maxAmount) continue;

        const paidDate =
          text(p.check_issue_date) || text(batch?.imported_at) || null;

        if (!passesAging(text(p.created_at) || null, filters.agingBucket)) continue;
        if (filters.dosFrom && (!dos || dos < filters.dosFrom)) continue;
        if (filters.dosTo && (!dos || dos > filters.dosTo)) continue;

        // Follow-up due — convention: 14 days after the ERA was posted.
        // The filter passes any row whose follow-up date is on/before the
        // supplied calendar date (i.e. "show me what's due by <date>").
        if (filters.followUpDue) {
          const base = text(p.created_at) || text(p.check_issue_date) || null;
          if (!base) continue;
          const baseMs = Date.parse(base);
          if (!Number.isFinite(baseMs)) continue;
          const dueIso = new Date(baseMs + 14 * 24 * 3600 * 1000)
            .toISOString()
            .slice(0, 10);
          if (dueIso > filters.followUpDue) continue;
        }

        const priority = derivePriority({
          variance,
          createdAt: text(p.created_at) || null,
        });
        if (filters.priority && filters.priority !== priority) continue;

        const tabs: UnderpaymentTab[] = [];
        if (payerType === "medicaid") tabs.push("medicaid");
        else if (payerType === "commercial" || payerType == null) tabs.push("commercial");
        if (variance > 0.5 && feeScheduleId) tabs.push("contract_variance");
        if (missingModifier) tabs.push("missing_modifier");
        if (partialPayment) tabs.push("partial_payment");
        if (tabs.length === 0) tabs.push("commercial");

        rows.push({
          id: lineKey,
          tabs,
          eraPaymentId: text(p.id),
          lineIndex: index,
          professionalClaimId: claimId || null,
          claimNumber: claim ? text(claim.claim_number) || null : null,
          clientId: claim ? text(claim.patient_id) || null : null,
          clientName,
          clinician,
          payerId,
          payerName,
          payerType,
          procedureCode,
          modifiers,
          allowedExpected,
          allowedPaid,
          paidAmount,
          patientResponsibility: Math.round(patientResp * 100) / 100,
          variance,
          paidDate,
          dos,
          contractSource,
          contractId,
          feeScheduleId,
          carcCodes,
          rarcCodes,
          status: claim ? text(claim.claim_status) : "matched",
          createdAt: text(p.created_at) || null,
          priority,
          suggestion: null,
        });
      }
    }

    // ── Auto-suggest contracted rate updates ─────────────────────────────
    // Group contract-variance rows by (payerId, CPT, sorted-modifiers,
    // allowedPaid). The spec requires >=3 *prior* ERAs reimbursing the same
    // amount before we flag a row as a stale fee schedule — i.e. each row
    // needs three matching peers besides itself, so the cluster must contain
    // >=4 distinct ERA payments. Limited to contract_variance to avoid
    // cross-tab noise.
    {
      type Group = {
        adoptAmount: number;
        rowIds: string[];
        eraIds: Set<string>;
      };
      const groups = new Map<string, Group>();
      const groupKeyFor = (r: UnderpaymentRow): string | null => {
        if (!r.payerId || !r.procedureCode) return null;
        if (!r.tabs.includes("contract_variance")) return null;
        // Cents-quantize to avoid float jitter.
        const cents = Math.round((r.allowedPaid || 0) * 100);
        if (cents <= 0) return null;
        const mods = [...r.modifiers].map((m) => m.toUpperCase()).sort().join(",");
        return `${r.payerId}|${r.procedureCode}|${mods}|${cents}`;
      };
      for (const r of rows) {
        const k = groupKeyFor(r);
        if (!k) continue;
        let g = groups.get(k);
        if (!g) {
          g = { adoptAmount: r.allowedPaid, rowIds: [], eraIds: new Set() };
          groups.set(k, g);
        }
        g.rowIds.push(r.id);
        g.eraIds.add(r.eraPaymentId);
      }
      for (const r of rows) {
        const k = groupKeyFor(r);
        if (!k) continue;
        const g = groups.get(k);
        if (!g) continue;
        // >=3 prior ERAs ⇒ cluster (including the current row) must have >=4
        // distinct ERA payments.
        if (g.eraIds.size < 4) continue;
        r.suggestion = {
          kind: "repeated_payment",
          adoptAmount: g.adoptAmount,
          sampleCount: g.eraIds.size,
          groupKey: k,
          similarRowIds: [...g.rowIds],
        };
      }
    }

    rows.sort((a, b) => b.variance - a.variance);

    const facets = await loadFacets(supabase, organizationId);
    return NextResponse.json({ success: true, rows, facets });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Failed to load underpayments",
      },
      { status: 500 },
    );
  }
}
