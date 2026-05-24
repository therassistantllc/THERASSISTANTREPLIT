import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { PATIENT_RESPONSIBILITY_TABS } from "./tabs";
import type {
  ExistingInvoice,
  PatientResponsibilityContext,
  PatientResponsibilityFilters,
  PatientResponsibilityReason,
  PatientResponsibilityRow,
  PrReasonBreakdown,
} from "./types";
import type { PatientResponsibilityTab } from "./tabs";

export { PATIENT_RESPONSIBILITY_TABS };
export type {
  PatientResponsibilityTab,
  PatientResponsibilityRow,
  PatientResponsibilityFilters,
  PatientResponsibilityContext,
};

type DbRow = Record<string, unknown>;

function text(v: unknown): string {
  return String(v ?? "").trim();
}
function money(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
function todayMs(): number {
  return Date.now();
}

const REASON_LABEL: Record<PatientResponsibilityReason, string> = {
  deductible: "Deductible",
  copay: "Copay",
  coinsurance: "Coinsurance",
  noncovered: "Noncovered",
  mixed: "Mixed responsibility",
  unknown: "—",
};

const REASON_TO_TAB: Record<PatientResponsibilityReason, PatientResponsibilityTab | null> = {
  deductible: "deductible",
  copay: "copay",
  coinsurance: "coinsurance",
  noncovered: "noncovered",
  mixed: null,
  unknown: null,
};

// PR CARC code → reason. Standard X12 CARC codes (PR group only).
const PR_CARC_REASON: Record<string, keyof PrReasonBreakdown> = {
  "1": "deductible",
  "2": "coinsurance",
  "3": "copay",
  "96": "noncovered",
  "204": "noncovered",
  "49": "noncovered",
  "50": "noncovered",
  "119": "noncovered",
};

interface CasAdjustment {
  group: string;
  code: string;
  amount: number;
}

function parseCasAdjustments(raw: unknown): CasAdjustment[] {
  if (!raw) return [];
  let arr: unknown[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "object") arr = Object.values(raw as Record<string, unknown>);
  const out: CasAdjustment[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const group = text(obj.group ?? obj.group_code ?? obj.cas01).toUpperCase();
    const code = text(obj.code ?? obj.reason_code ?? obj.cas02).toUpperCase();
    const amount = money(obj.amount ?? obj.adjustment_amount ?? obj.cas03);
    if (!code || !Number.isFinite(amount)) continue;
    out.push({ group, code, amount });
  }
  return out;
}

function classifyPr(
  prAmount: number,
  cas: CasAdjustment[],
): { reason: PatientResponsibilityReason; breakdown: PrReasonBreakdown } {
  const breakdown: PrReasonBreakdown = {
    deductible: 0,
    copay: 0,
    coinsurance: 0,
    noncovered: 0,
    other: 0,
  };
  for (const a of cas) {
    if (a.group !== "PR") continue;
    const bucket = PR_CARC_REASON[a.code];
    if (bucket) breakdown[bucket] += a.amount;
    else breakdown.other += a.amount;
  }
  const allocated =
    breakdown.deductible +
    breakdown.copay +
    breakdown.coinsurance +
    breakdown.noncovered +
    breakdown.other;
  // If CAS rollup is missing or doesn't fully cover the PR amount, dump the
  // remainder into "other" so the totals stay honest.
  if (prAmount > 0 && allocated + 0.01 < prAmount) {
    breakdown.other += Math.round((prAmount - allocated) * 100) / 100;
  }

  const sorted = (["deductible", "copay", "coinsurance", "noncovered"] as const)
    .map((k) => ({ k, v: breakdown[k] }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v);

  let reason: PatientResponsibilityReason = "unknown";
  if (sorted.length === 0 && breakdown.other > 0) reason = "unknown";
  else if (sorted.length === 1) reason = sorted[0].k;
  else if (sorted.length > 1) reason = "mixed";
  return { reason, breakdown };
}

export interface LoadPatientResponsibilityInput {
  supabase: SupabaseClient;
  organizationId: string;
  filters?: PatientResponsibilityFilters;
  limit?: number;
}

function applyFilters(
  rows: PatientResponsibilityRow[],
  f: PatientResponsibilityFilters | undefined,
  nowMs: number,
): PatientResponsibilityRow[] {
  if (!f) return rows;
  let out = rows;
  if (f.practice) out = out.filter((r) => r.practiceId === f.practice);
  if (f.clinician) out = out.filter((r) => r.providerId === f.clinician);
  if (f.client) {
    const q = f.client.toLowerCase();
    out = out.filter((r) => r.clientName.toLowerCase().includes(q));
  }
  if (f.payer) out = out.filter((r) => r.payerName === f.payer);
  if (f.dosFrom) out = out.filter((r) => (r.dateOfService ?? "") >= f.dosFrom!);
  if (f.dosTo) out = out.filter((r) => (r.dateOfService ?? "") <= f.dosTo! + "T23:59:59");
  if (f.status) {
    const s = f.status.toLowerCase();
    out = out.filter((r) => r.invoiceStatusLabel.toLowerCase() === s);
  }
  if (f.priority === "urgent") out = out.filter((r) => r.isUrgent);
  if (f.minAmount) {
    const min = Number(f.minAmount);
    if (Number.isFinite(min)) out = out.filter((r) => r.patientAmount >= min);
  }
  if (f.maxAmount) {
    const max = Number(f.maxAmount);
    if (Number.isFinite(max)) out = out.filter((r) => r.patientAmount <= max);
  }
  if (f.agingBucket) {
    out = out.filter((r) => {
      const days = Math.floor((nowMs - new Date(r.eraReceivedAt).getTime()) / 86_400_000);
      switch (f.agingBucket) {
        case "0-30": return days <= 30;
        case "31-60": return days > 30 && days <= 60;
        case "61-90": return days > 60 && days <= 90;
        case "90+": return days > 90;
        default: return true;
      }
    });
  }
  if (f.assignedBiller) {
    const q = f.assignedBiller.toLowerCase();
    out = out.filter((r) => (r.assignedBillerId ?? "").toLowerCase().includes(q));
  }
  if (f.carcRarc) {
    const q = f.carcRarc.toUpperCase();
    out = out.filter((r) => r.carcRarcCodes.some((c) => c.includes(q)));
  }
  if (f.followUpDue) {
    const cutoff = f.followUpDue + "T23:59:59";
    out = out.filter((r) => r.followUpDueAt != null && r.followUpDueAt <= cutoff);
  }
  return out;
}

export async function loadPatientResponsibility({
  supabase,
  organizationId,
  filters,
  limit = 500,
}: LoadPatientResponsibilityInput): Promise<PatientResponsibilityRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };

  // 1) Pull ERA claim payments with a patient responsibility component.
  const { data: eraRows } = await sb
    .from("era_claim_payments")
    .select(
      "id, professional_claim_id, client_id, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, pr_amount, co_amount, allowed_amount, cas_adjustments, carc_codes, rarc_codes, posting_status, created_at, check_eft_number, check_issue_date",
    )
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .is("reversed_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  const eras = ((eraRows as DbRow[]) ?? []).filter((r) => {
    const pr = money(r.pr_amount) || money(r.clp05_patient_responsibility);
    return pr > 0;
  });
  if (eras.length === 0) return [];

  // 2) Fan out to claims, clients, payers, invoices, audit history.
  const claimIds = Array.from(
    new Set(eras.map((r) => text(r.professional_claim_id)).filter(Boolean)),
  );
  const clientIds = Array.from(
    new Set(eras.map((r) => text(r.client_id)).filter(Boolean)),
  );
  const eraIds = eras.map((r) => text(r.id));

  const [
    { data: claimRows },
    { data: clientRows },
    { data: invoiceRows },
    { data: holdAudit },
    { data: followUpAudit },
  ] = await Promise.all([
    claimIds.length
      ? sb.from("professional_claims")
          .select(
            "id, claim_number, claim_status, appointment_id, patient_id, payer_profile_id, total_charge, write_off_amount, billing_notes, encounter_id",
          )
          .eq("organization_id", organizationId)
          .in("id", claimIds)
      : { data: [] as DbRow[] },
    clientIds.length
      ? sb.from("clients")
          .select("id, first_name, last_name, email, phone, address_line_1, city, state, postal_code, portal_status")
          .in("id", clientIds)
      : { data: [] as DbRow[] },
    sb.from("patient_invoices")
      .select(
        "id, invoice_number, invoice_status, patient_responsibility_amount, paid_amount, balance_amount, professional_claim_id, era_claim_payment_id, created_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .or(
        claimIds.length
          ? `professional_claim_id.in.(${claimIds.join(",")}),era_claim_payment_id.in.(${eraIds.join(",")})`
          : `era_claim_payment_id.in.(${eraIds.join(",")})`,
      ),
    sb.from("audit_logs")
      .select("claim_id, action, event_metadata, created_at")
      .eq("organization_id", organizationId)
      .in("action", ["patient_resp_hold", "patient_resp_hold_released"])
      .in("claim_id", claimIds.length ? claimIds : ["00000000-0000-0000-0000-000000000000"])
      .order("created_at", { ascending: false }),
    sb.from("audit_logs")
      .select("claim_id, action, event_metadata, created_at")
      .eq("organization_id", organizationId)
      .eq("action", "patient_resp_follow_up_set")
      .in("claim_id", claimIds.length ? claimIds : ["00000000-0000-0000-0000-000000000000"])
      .order("created_at", { ascending: false }),
  ]);

  const claimById = new Map<string, DbRow>(
    ((claimRows as DbRow[]) ?? []).map((c) => [text(c.id), c]),
  );
  const clientById = new Map<string, DbRow>(
    ((clientRows as DbRow[]) ?? []).map((c) => [text(c.id), c]),
  );

  // Index invoices: by era_claim_payment_id (preferred) and by claim_id.
  const invoiceByEra = new Map<string, DbRow>();
  const invoicesByClaim = new Map<string, DbRow[]>();
  for (const inv of ((invoiceRows as DbRow[]) ?? [])) {
    const eraId = text(inv.era_claim_payment_id);
    if (eraId) invoiceByEra.set(eraId, inv);
    const cId = text(inv.professional_claim_id);
    if (cId) {
      const list = invoicesByClaim.get(cId) ?? [];
      list.push(inv);
      invoicesByClaim.set(cId, list);
    }
  }

  // Hold state: latest action wins per claim.
  const holdMap = new Map<string, boolean>();
  for (const r of ((holdAudit as DbRow[]) ?? [])) {
    const cid = text(r.claim_id);
    if (!cid || holdMap.has(cid)) continue;
    holdMap.set(cid, text(r.action) === "patient_resp_hold");
  }
  const followUpMap = new Map<string, string>();
  for (const r of ((followUpAudit as DbRow[]) ?? [])) {
    const cid = text(r.claim_id);
    if (!cid || followUpMap.has(cid)) continue;
    const meta = (r.event_metadata as Record<string, unknown> | null) ?? {};
    const due = text(meta.dueAt);
    if (due) followUpMap.set(cid, due);
  }

  // Fan-out appointments + payers from the claims we resolved.
  const apptIds = new Set<string>();
  const payerIds = new Set<string>();
  for (const c of claimById.values()) {
    if (text(c.appointment_id)) apptIds.add(text(c.appointment_id));
    if (text(c.payer_profile_id)) payerIds.add(text(c.payer_profile_id));
  }
  const [{ data: apptRows }, { data: payerRows }] = await Promise.all([
    apptIds.size
      ? sb.from("appointments")
          .select("id, provider_id, provider_location_id, scheduled_start_at")
          .in("id", Array.from(apptIds))
      : { data: [] as DbRow[] },
    payerIds.size
      ? sb.from("payer_profiles")
          .select("id, payer_name")
          .in("id", Array.from(payerIds))
      : { data: [] as DbRow[] },
  ]);
  const apptById = new Map<string, DbRow>(((apptRows as DbRow[]) ?? []).map((a) => [text(a.id), a]));
  const payerById = new Map<string, DbRow>(((payerRows as DbRow[]) ?? []).map((p) => [text(p.id), p]));

  const nowMs = todayMs();
  const out: PatientResponsibilityRow[] = [];
  for (const era of eras) {
    const eraId = text(era.id);
    const claimId = text(era.professional_claim_id) || null;
    const claim = claimId ? claimById.get(claimId) : undefined;
    const appt = claim && text(claim.appointment_id) ? apptById.get(text(claim.appointment_id)) : undefined;
    const payer = claim && text(claim.payer_profile_id) ? payerById.get(text(claim.payer_profile_id)) : undefined;
    const clientId = text(era.client_id) || (claim ? text(claim.patient_id) : "") || null;
    const cli = clientId ? clientById.get(clientId) : undefined;
    const clientName = cli
      ? `${text(cli.last_name)}, ${text(cli.first_name)}`.replace(/^,\s*$/, "") || "Unknown patient"
      : "Unknown patient";

    const patientAmount = money(era.pr_amount) || money(era.clp05_patient_responsibility);
    const cas = parseCasAdjustments(era.cas_adjustments);
    const { reason, breakdown } = classifyPr(patientAmount, cas);

    const invoiceRow = invoiceByEra.get(eraId)
      ?? (claimId ? (invoicesByClaim.get(claimId) ?? [])[0] : undefined);
    const invoice: ExistingInvoice | null = invoiceRow
      ? {
          id: text(invoiceRow.id),
          invoiceNumber: text(invoiceRow.invoice_number),
          status: text(invoiceRow.invoice_status) || "open",
          amount: money(invoiceRow.patient_responsibility_amount),
          balanceAmount: money(invoiceRow.balance_amount),
          paidAmount: money(invoiceRow.paid_amount),
          createdAt: text(invoiceRow.created_at),
        }
      : null;

    const eraReceivedAt = text(era.created_at) || new Date().toISOString();
    const ageDays = Math.floor((nowMs - new Date(eraReceivedAt).getTime()) / 86_400_000);
    const isUrgent = !invoice && ageDays >= 14;

    const onHold = claimId ? !!holdMap.get(claimId) : false;
    const followUpDueAt = claimId ? followUpMap.get(claimId) ?? null : null;

    // Tabs: every row appears in its reason tab, plus the "Ready for Invoice"
    // tab if there's no invoice yet AND no hold AND no manual review needed,
    // OR the "Needs Review" tab when the picture is unclear.
    const tabs: PatientResponsibilityTab[] = [];
    const needsReview =
      reason === "unknown" ||
      reason === "mixed" ||
      !claimId ||
      !clientId ||
      onHold;
    if (!invoice && !needsReview) tabs.push("ready_for_invoice");
    if (needsReview && !invoice) tabs.push("needs_review");
    const reasonTab = REASON_TO_TAB[reason];
    if (reasonTab) tabs.push(reasonTab);
    // Mixed/unknown rows that already have an invoice still belong somewhere:
    // surface them under "needs review" so billers can confirm allocation.
    if (tabs.length === 0) tabs.push("needs_review");

    // Invoice status label (column "Invoice status")
    let invoiceStatusLabel = "Not created";
    if (invoice) {
      const s = invoice.status.toLowerCase();
      if (s === "paid") invoiceStatusLabel = "Paid";
      else if (s === "void" || s === "voided") invoiceStatusLabel = "Voided";
      else if (invoice.paidAmount > 0) invoiceStatusLabel = "Partial";
      else if (s === "sent") invoiceStatusLabel = "Sent";
      else invoiceStatusLabel = "Open";
    } else if (onHold) {
      invoiceStatusLabel = "On hold";
    }

    const statementDate = invoice && invoice.status.toLowerCase() === "sent"
      ? text((invoiceRow as DbRow | undefined)?.updated_at) || invoice.createdAt
      : null;

    const carcRarcCodes = [
      ...(Array.isArray(era.carc_codes) ? (era.carc_codes as string[]) : []),
      ...(Array.isArray(era.rarc_codes) ? (era.rarc_codes as string[]) : []),
    ].map((c) => text(c).toUpperCase()).filter(Boolean);

    out.push({
      id: eraId,
      eraClaimPaymentId: eraId,
      claimId,
      claimNumber: claim ? text(claim.claim_number) || null : null,
      clientId,
      clientName,
      payerProfileId: claim ? text(claim.payer_profile_id) || null : null,
      payerName: text(payer?.payer_name) || "—",
      appointmentId: claim ? text(claim.appointment_id) || null : null,
      providerId: appt ? text(appt.provider_id) || null : null,
      practiceId: appt ? text(appt.provider_location_id) || null : null,
      dateOfService: appt ? text(appt.scheduled_start_at) || null : null,

      patientAmount,
      totalCharge: money(era.clp03_total_charge),
      insurancePaid: money(era.clp04_payment_amount),
      contractualAdjustment: money(era.co_amount),
      breakdown,
      reason,
      reasonLabel: reason === "unknown"
        ? "Unspecified"
        : reason === "mixed"
          ? "Mixed (multiple)"
          : REASON_LABEL[reason],
      carcRarcCodes,

      invoice,
      invoiceStatusLabel,
      statementDate,
      // No autopay table exists in this schema — surface enrollment honestly.
      autopayStatusLabel: cli && text(cli.portal_status).toLowerCase() === "active"
        ? "Portal active"
        : "Not enrolled",
      onHold,

      eraReceivedAt,
      ageDays,
      isUrgent,
      followUpDueAt,
      assignedBillerId: null,
      tabs,
    });
  }

  return applyFilters(out, filters, nowMs);
}

export async function loadPatientResponsibilityContext(
  supabase: SupabaseClient,
  organizationId: string,
  eraClaimPaymentId: string,
): Promise<PatientResponsibilityContext | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };

  const { data: era } = await sb
    .from("era_claim_payments")
    .select(
      "id, professional_claim_id, client_id, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, pr_amount, co_amount, allowed_amount, cas_adjustments, carc_codes, rarc_codes, service_lines, check_eft_number, check_issue_date",
    )
    .eq("organization_id", organizationId)
    .eq("id", eraClaimPaymentId)
    .maybeSingle();
  if (!era) return null;
  const eraRow = era as DbRow;

  const claimId = text(eraRow.professional_claim_id) || null;
  const [{ data: claim }, { data: invoiceRows }, { data: client }, { data: balance }] = await Promise.all([
    claimId
      ? sb.from("professional_claims")
          .select("id, claim_number, patient_id, total_charge")
          .eq("organization_id", organizationId)
          .eq("id", claimId)
          .maybeSingle()
      : { data: null },
    sb.from("patient_invoices")
      .select("id, invoice_number, invoice_status, patient_responsibility_amount, paid_amount, balance_amount, created_at")
      .eq("organization_id", organizationId)
      .or(
        claimId
          ? `professional_claim_id.eq.${claimId},era_claim_payment_id.eq.${eraClaimPaymentId}`
          : `era_claim_payment_id.eq.${eraClaimPaymentId}`,
      )
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(5),
    text(eraRow.client_id)
      ? sb.from("clients")
          .select("id, first_name, last_name, email, phone, address_line_1, city, state, postal_code, portal_status")
          .eq("id", text(eraRow.client_id))
          .maybeSingle()
      : { data: null },
    text(eraRow.client_id)
      ? sb.from("patient_balances")
          .select("current_balance, in_collections, last_payment_amount, last_payment_date, last_statement_date")
          .eq("organization_id", organizationId)
          .eq("client_id", text(eraRow.client_id))
          .maybeSingle()
      : { data: null },
  ]);

  const claimRow = claim as DbRow | null;
  const clientRow = client as DbRow | null;
  const balanceRow = balance as DbRow | null;
  const patientAmount =
    money(eraRow.pr_amount) || money(eraRow.clp05_patient_responsibility);
  const cas = parseCasAdjustments(eraRow.cas_adjustments);
  const { reason, breakdown } = classifyPr(patientAmount, cas);

  // Service-line breakdown for the ERA panel.
  const rawLines = Array.isArray(eraRow.service_lines)
    ? (eraRow.service_lines as unknown[])
    : [];
  const serviceLines = rawLines.map((line) => {
    const obj = (line ?? {}) as Record<string, unknown>;
    const adjArr = Array.isArray(obj.adjustments) ? (obj.adjustments as unknown[]) : [];
    return {
      cpt: text(obj.procedure_code ?? obj.cpt ?? obj.svc01) || null,
      charge: money(obj.charge_amount ?? obj.svc02 ?? obj.charge),
      paid: money(obj.payment_amount ?? obj.svc03 ?? obj.paid),
      patientResp: money(obj.patient_responsibility ?? obj.patient_resp ?? 0),
      adjustments: adjArr.map((a) => {
        const ao = (a ?? {}) as Record<string, unknown>;
        return {
          group: text(ao.group ?? ao.cas01).toUpperCase(),
          code: text(ao.code ?? ao.cas02).toUpperCase(),
          amount: money(ao.amount ?? ao.cas03),
        };
      }),
    };
  });

  const explanations: string[] = [];
  if (breakdown.deductible > 0) explanations.push(`Deductible: $${breakdown.deductible.toFixed(2)} (PR-1)`);
  if (breakdown.copay > 0) explanations.push(`Copay: $${breakdown.copay.toFixed(2)} (PR-3)`);
  if (breakdown.coinsurance > 0) explanations.push(`Coinsurance: $${breakdown.coinsurance.toFixed(2)} (PR-2)`);
  if (breakdown.noncovered > 0) explanations.push(`Noncovered: $${breakdown.noncovered.toFixed(2)} (PR-96/204)`);
  if (breakdown.other > 0) explanations.push(`Other PR: $${breakdown.other.toFixed(2)}`);

  const existingInvoice: ExistingInvoice | null = ((invoiceRows as DbRow[]) ?? [])[0]
    ? {
        id: text(((invoiceRows as DbRow[]) ?? [])[0].id),
        invoiceNumber: text(((invoiceRows as DbRow[]) ?? [])[0].invoice_number),
        status: text(((invoiceRows as DbRow[]) ?? [])[0].invoice_status),
        amount: money(((invoiceRows as DbRow[]) ?? [])[0].patient_responsibility_amount),
        balanceAmount: money(((invoiceRows as DbRow[]) ?? [])[0].balance_amount),
        paidAmount: money(((invoiceRows as DbRow[]) ?? [])[0].paid_amount),
        createdAt: text(((invoiceRows as DbRow[]) ?? [])[0].created_at),
      }
    : null;

  const clientName = clientRow
    ? `${text(clientRow.first_name)} ${text(clientRow.last_name)}`.trim() || "patient"
    : "patient";

  return {
    eraBreakdown: {
      totalCharge: money(eraRow.clp03_total_charge),
      allowedAmount: eraRow.allowed_amount == null ? null : money(eraRow.allowed_amount),
      insurancePaid: money(eraRow.clp04_payment_amount),
      contractualAdjustment: money(eraRow.co_amount),
      patientResponsibility: patientAmount,
      breakdown,
      carcCodes: (Array.isArray(eraRow.carc_codes) ? (eraRow.carc_codes as string[]) : []).map(text).filter(Boolean),
      rarcCodes: (Array.isArray(eraRow.rarc_codes) ? (eraRow.rarc_codes as string[]) : []).map(text).filter(Boolean),
      serviceLines,
      checkEftNumber: text(eraRow.check_eft_number) || null,
      checkIssueDate: text(eraRow.check_issue_date) || null,
    },
    reason: {
      primary: reason,
      label: reason === "unknown"
        ? "Unspecified"
        : reason === "mixed"
          ? "Mixed (multiple)"
          : REASON_LABEL[reason],
      explanations,
    },
    existingBalance: balanceRow
      ? {
          currentBalance: money(balanceRow.current_balance),
          inCollections: !!balanceRow.in_collections,
          lastPaymentAmount: balanceRow.last_payment_amount == null
            ? null
            : money(balanceRow.last_payment_amount),
          lastPaymentDate: text(balanceRow.last_payment_date) || null,
          lastStatementDate: text(balanceRow.last_statement_date) || null,
        }
      : null,
    paymentMethod: {
      hasEmail: !!(clientRow && text(clientRow.email)),
      hasPhone: !!(clientRow && text(clientRow.phone)),
      hasMailingAddress: !!(clientRow && text(clientRow.address_line_1)),
      portalStatus: clientRow ? text(clientRow.portal_status) || null : null,
    },
    invoicePreview: {
      invoiceNumberPreview: `INV-${(claimRow ? text(claimRow.claim_number) || text(claimRow.id).slice(0, 8) : eraClaimPaymentId.slice(0, 8))}-${Date.now().toString().slice(-6)}`,
      amount: patientAmount,
      proposedSource: "era_remit",
      lineDescription: `Patient responsibility from ERA remittance (${reason === "mixed" ? "mixed" : REASON_LABEL[reason]})`,
      clientName,
      clientEmail: clientRow ? text(clientRow.email) || null : null,
    },
    existingInvoice,
  };
}
