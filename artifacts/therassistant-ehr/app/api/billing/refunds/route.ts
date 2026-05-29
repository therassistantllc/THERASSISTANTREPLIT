/**
 * GET /api/billing/refunds?organizationId=...&...filters
 *
 * Powers the Refund / Overpayment workqueue. Surfaces:
 *   - payment_refunds rows (insurance + client refunds) → tabs
 *       "Payer Refunds", "Client Refunds", "Refund Completed".
 *   - payment_recoupments rows → tab "Offset Requested".
 *   - era_claim_payments where the payer paid more than the claim's
 *     total charge and no refund row exists → tab "Credit Balance Review".
 *
 * Universal filter rail: practice, clinician, payer, client, dosFrom,
 * dosTo, status, assignedBiller, minAmount, maxAmount, agingBucket,
 * carcRarc, priority, followUpDue.
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

export type RefundTab =
  | "payer_refunds"
  | "patient_refunds"
  | "credit_balance_review"
  | "offset_requested"
  | "refund_completed";

export interface RefundRow {
  id: string;
  source: "payment_refund" | "payment_recoupment" | "era_overpayment";
  tab: RefundTab;
  refundId: string | null;
  recoupmentId: string | null;
  eraClaimPaymentId: string | null;
  clientId: string | null;
  clientName: string;
  payerProfileId: string | null;
  payerOrClient: string;
  payerType: "payer" | "client";
  professionalClaimId: string | null;
  claimNumber: string | null;
  locationId: string | null;
  providerId: string | null;
  creditAmount: number;
  reason: string | null;
  refundDueDate: string | null;
  status: string;
  assignedToUserId: string | null;
  assignedToName: string | null;
  requestedAt: string | null;
  issuedAt: string | null;
  ageDays: number;
  priority: "low" | "normal" | "high" | "urgent";
  serviceDate: string | null;
  carcCodes: string[];
  rarcCodes: string[];
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
  priority: "low" | "normal" | "high" | "urgent" | null;
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
    priority:
      pr === "low" || pr === "normal" || pr === "high" || pr === "urgent"
        ? pr
        : null,
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
  amount: number;
  age: number;
  status: string;
}): "low" | "normal" | "high" | "urgent" {
  if (args.status === "failed") return "urgent";
  if (args.age > 60 || args.amount >= 500) return "high";
  if (args.age > 30 || args.amount >= 100) return "normal";
  return "low";
}

function dueDate(requestedAt: string | null): string | null {
  if (!requestedAt) return null;
  const t = Date.parse(requestedAt);
  if (Number.isNaN(t)) return null;
  // Refund must be issued within 30 days of request per typical
  // overpayment-handling SLAs.
  return new Date(t + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

async function loadFacets(supabase: any, organizationId: string) {
  const [{ data: payers }, { data: locations }, { data: providers }] =
    await Promise.all([
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
      .map(
        (p) =>
          [text(p.first_name), text(p.last_name)].filter(Boolean).join(" ") ||
          "",
      )
      .filter(Boolean),
    staff: ((providers as DbRow[]) ?? []).map((p) => ({
      id: text(p.id),
      name:
        [text(p.first_name), text(p.last_name)].filter(Boolean).join(" ") ||
        "Staff",
    })),
  };
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

    const facets = await loadFacets(supabase, organizationId);
    const staffById = new Map(facets.staff.map((s) => [s.id, s.name]));

    // ── 1. payment_refunds ────────────────────────────────────────────────
    const { data: refundsRaw, error: refundsErr } = await (supabase as any)
      .from("payment_refunds")
      .select(
        "id, refund_type, source_era_claim_payment_id, source_client_payment_id, source_insurance_manual_payment_id, client_id, professional_claim_id, payer_profile_id, amount, reason, refund_status, stripe_refund_id, patient_invoice_id, workqueue_item_id, issued_at, issued_by_actor_id, requested_at, requested_by_actor_id, note, created_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("requested_at", { ascending: false })
      .limit(2000);
    if (refundsErr) throw refundsErr;

    // ── 2. payment_recoupments ────────────────────────────────────────────
    const { data: recoupRaw, error: recoupErr } = await (supabase as any)
      .from("payment_recoupments")
      .select(
        "id, source_era_claim_payment_id, source_client_payment_id, offset_era_claim_payment_id, professional_claim_id, client_id, payer_profile_id, amount, reason_code, reason, workqueue_item_id, recouped_at, recouped_by_actor_id, created_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("recouped_at", { ascending: false })
      .limit(2000);
    if (recoupErr) throw recoupErr;

    // ── 3. era_claim_payments overpayments (paid > total charge) ─────────
    // Credit Balance Review pulls posted ERA payments where the payer
    // remitted more than the claim was charged AND we don't already have a
    // refund record tracking it.
    const refundedEraIds = new Set<string>(
      ((refundsRaw as DbRow[]) ?? [])
        .map((r) => text(r.source_era_claim_payment_id))
        .filter(Boolean),
    );

    const { data: eraRaw, error: eraErr } = await (supabase as any)
      .from("era_claim_payments")
      .select(
        "id, organization_id, professional_claim_id, client_id, clp03_total_charge, clp04_payment_amount, allowed_amount, carc_codes, rarc_codes, check_issue_date, posting_status, created_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .eq("posting_status", "posted")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (eraErr) throw eraErr;

    const overpayments = ((eraRaw as DbRow[]) ?? []).filter((p) => {
      if (refundedEraIds.has(text(p.id))) return false;
      const charge = money(p.clp03_total_charge);
      const paid = money(p.clp04_payment_amount);
      // Strict overpayment: paid exceeded charge by at least one cent.
      return charge > 0 && paid - charge >= 0.01;
    });

    // ── Joins (clients / payers / claims) ────────────────────────────────
    const clientIds = new Set<string>();
    const payerIds = new Set<string>();
    const claimIds = new Set<string>();

    const pushIds = (r: DbRow) => {
      const c = text(r.client_id);
      if (c) clientIds.add(c);
      const p = text(r.payer_profile_id);
      if (p) payerIds.add(p);
      const cl = text(r.professional_claim_id);
      if (cl) claimIds.add(cl);
    };
    ((refundsRaw as DbRow[]) ?? []).forEach(pushIds);
    ((recoupRaw as DbRow[]) ?? []).forEach(pushIds);
    overpayments.forEach(pushIds);

    const [
      { data: clientsData },
      { data: payersData },
      { data: claimsData },
    ] = await Promise.all([
      clientIds.size
        ? (supabase as any)
            .from("clients")
            .select("id, first_name, last_name, primary_provider_id, primary_clinician_user_id")
            .in("id", Array.from(clientIds))
        : Promise.resolve({ data: [] as DbRow[] }),
      payerIds.size
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name, payer_type")
            .in("id", Array.from(payerIds))
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.size
        ? (supabase as any)
            .from("professional_claims")
            .select(
              "id, claim_number, claim_status, payer_profile_id, appointment_id, total_charge, created_at",
            )
            .in("id", Array.from(claimIds))
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const clientById = new Map<string, DbRow>(
      ((clientsData as DbRow[]) ?? []).map((c) => [text(c.id), c]),
    );
    const payerById = new Map<string, DbRow>(
      ((payersData as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const claimById = new Map<string, DbRow>(
      ((claimsData as DbRow[]) ?? []).map((c) => [text(c.id), c]),
    );

    const appointmentIds = Array.from(
      new Set(
        ((claimsData as DbRow[]) ?? [])
          .map((c) => text(c.appointment_id))
          .filter(Boolean),
      ),
    );
    const { data: apptData } = appointmentIds.length
      ? await (supabase as any)
          .from("appointments")
          .select("id, provider_id, location_id, start_time")
          .in("id", appointmentIds)
      : { data: [] as DbRow[] };
    const apptById = new Map<string, DbRow>(
      ((apptData as DbRow[]) ?? []).map((a) => [text(a.id), a]),
    );

    // Provider id → name (for clinician filter, which matches by name in
    // the facet payload).
    const providerNameById = new Map<string, string>(
      facets.staff.map((s) => [s.id, s.name]),
    );

    function clientName(id: string | null): string {
      if (!id) return "—";
      const c = clientById.get(id);
      if (!c) return "Unknown client";
      return (
        [text(c.first_name), text(c.last_name)].filter(Boolean).join(" ") ||
        "Unknown client"
      );
    }
    function payerName(id: string | null): string {
      if (!id) return "—";
      const p = payerById.get(id);
      return p ? text(p.payer_name) || "Unknown payer" : "Unknown payer";
    }
    function claimMeta(claimId: string | null): {
      number: string | null;
      serviceDate: string | null;
      locationId: string | null;
      providerId: string | null;
    } {
      if (!claimId) {
        return {
          number: null,
          serviceDate: null,
          locationId: null,
          providerId: null,
        };
      }
      const c = claimById.get(claimId);
      if (!c) {
        return {
          number: null,
          serviceDate: null,
          locationId: null,
          providerId: null,
        };
      }
      const appt = apptById.get(text(c.appointment_id));
      return {
        number: text(c.claim_number) || null,
        serviceDate: appt ? text(appt.start_time)?.slice(0, 10) || null : null,
        locationId: appt ? text(appt.location_id) || null : null,
        providerId: appt ? text(appt.provider_id) || null : null,
      };
    }
    function clinicianId(clientId: string | null): string | null {
      if (!clientId) return null;
      const c = clientById.get(clientId);
      return c
        ? text(c.primary_provider_id) || text(c.primary_clinician_user_id) || null
        : null;
    }

    // ── Build rows ───────────────────────────────────────────────────────
    const rows: RefundRow[] = [];

    // 1. payment_refunds
    for (const r of (refundsRaw as DbRow[]) ?? []) {
      const refundStatus = text(r.refund_status) || "pending";
      const refundType = text(r.refund_type) as "client" | "insurance";
      const isCompleted =
        refundStatus === "issued" || refundStatus === "cancelled";
      const tab: RefundTab = isCompleted
        ? "refund_completed"
        : refundType === "client"
          ? "patient_refunds"
          : "payer_refunds";
      const cid = text(r.client_id) || null;
      const pid = text(r.payer_profile_id) || null;
      const claimId = text(r.professional_claim_id) || null;
      const meta = claimMeta(claimId);
      const amount = money(r.amount);
      const requestedAt = text(r.requested_at) || null;
      const age = ageDays(requestedAt);
      const priority = derivePriority({
        amount,
        age,
        status: refundStatus,
      });
      const cName = clientName(cid);
      const payerOrClient =
        refundType === "client" ? cName : payerName(pid);

      rows.push({
        id: `refund:${text(r.id)}`,
        source: "payment_refund",
        tab,
        refundId: text(r.id),
        recoupmentId: null,
        eraClaimPaymentId: text(r.source_era_claim_payment_id) || null,
        clientId: cid,
        clientName: cName,
        payerProfileId: pid,
        payerOrClient,
        payerType: refundType === "client" ? "client" : "payer",
        professionalClaimId: claimId,
        claimNumber: meta.number,
        creditAmount: amount,
        reason: text(r.reason) || text(r.note) || null,
        refundDueDate: dueDate(requestedAt),
        status: refundStatus,
        assignedToUserId: null,
        assignedToName: null,
        requestedAt,
        issuedAt: text(r.issued_at) || null,
        ageDays: age,
        priority,
        serviceDate: meta.serviceDate,
        locationId: meta.locationId,
        providerId: meta.providerId,
        carcCodes: [],
        rarcCodes: [],
      });
    }

    // 2. payment_recoupments → Offset Requested
    for (const r of (recoupRaw as DbRow[]) ?? []) {
      const cid = text(r.client_id) || null;
      const pid = text(r.payer_profile_id) || null;
      const claimId = text(r.professional_claim_id) || null;
      const meta = claimMeta(claimId);
      const amount = money(r.amount);
      const recoupedAt = text(r.recouped_at) || null;
      const status = text(r.offset_era_claim_payment_id)
        ? "offset_applied"
        : "offset_pending";
      const age = ageDays(recoupedAt);
      const cName = clientName(cid);

      rows.push({
        id: `recoup:${text(r.id)}`,
        source: "payment_recoupment",
        tab: "offset_requested",
        refundId: null,
        recoupmentId: text(r.id),
        eraClaimPaymentId: text(r.source_era_claim_payment_id) || null,
        clientId: cid,
        clientName: cName,
        payerProfileId: pid,
        payerOrClient: payerName(pid),
        payerType: "payer",
        professionalClaimId: claimId,
        claimNumber: meta.number,
        creditAmount: amount,
        reason: text(r.reason) || text(r.reason_code) || null,
        refundDueDate: dueDate(recoupedAt),
        status,
        assignedToUserId: null,
        assignedToName: null,
        requestedAt: recoupedAt,
        issuedAt: null,
        ageDays: age,
        priority: derivePriority({ amount, age, status }),
        serviceDate: meta.serviceDate,
        locationId: meta.locationId,
        providerId: meta.providerId,
        carcCodes: [],
        rarcCodes: [],
      });
    }

    // 3. era_claim_payments overpayments → Credit Balance Review
    for (const r of overpayments) {
      const cid = text(r.client_id) || null;
      const claimId = text(r.professional_claim_id) || null;
      // ERA rows don't carry payer_profile_id directly — derive from the
      // claim that the ERA paid.
      const claim = claimId ? claimById.get(claimId) : undefined;
      const pid = claim ? text(claim.payer_profile_id) || null : null;
      const meta = claimMeta(claimId);
      const charge = money(r.clp03_total_charge);
      const paid = money(r.clp04_payment_amount);
      const credit = Math.round((paid - charge) * 100) / 100;
      const createdAt = text(r.created_at) || null;
      const age = ageDays(createdAt);
      const cName = clientName(cid);
      rows.push({
        id: `era:${text(r.id)}`,
        source: "era_overpayment",
        tab: "credit_balance_review",
        refundId: null,
        recoupmentId: null,
        eraClaimPaymentId: text(r.id),
        clientId: cid,
        clientName: cName,
        payerProfileId: pid,
        payerOrClient: payerName(pid),
        payerType: "payer",
        professionalClaimId: claimId,
        claimNumber: meta.number,
        creditAmount: credit,
        reason: `Payer paid ${paid.toFixed(2)} on a ${charge.toFixed(2)} claim`,
        refundDueDate: dueDate(createdAt),
        status: "needs_review",
        assignedToUserId: null,
        assignedToName: null,
        requestedAt: createdAt,
        issuedAt: null,
        ageDays: age,
        priority: derivePriority({
          amount: credit,
          age,
          status: "needs_review",
        }),
        serviceDate: meta.serviceDate ?? (text(r.check_issue_date) || null),
        locationId: meta.locationId,
        providerId: meta.providerId,
        carcCodes: Array.isArray(r.carc_codes) ? r.carc_codes : [],
        rarcCodes: Array.isArray(r.rarc_codes) ? r.rarc_codes : [],
      });
    }

    // ── Apply universal filters ──────────────────────────────────────────
    const filtered = rows.filter((row) => {
      if (filters.payer && row.payerProfileId !== filters.payer) return false;
      if (filters.client) {
        if (
          !row.clientName.toLowerCase().includes(filters.client.toLowerCase())
        ) {
          return false;
        }
      }
      if (filters.status && row.status !== filters.status) return false;
      if (filters.assignedBiller) {
        if (
          row.assignedToUserId !== filters.assignedBiller &&
          (row.assignedToName ?? "")
            .toLowerCase()
            .indexOf(filters.assignedBiller.toLowerCase()) === -1
        )
          return false;
      }
      if (filters.priority && row.priority !== filters.priority) return false;
      if (filters.minAmount != null && row.creditAmount < filters.minAmount)
        return false;
      if (filters.maxAmount != null && row.creditAmount > filters.maxAmount)
        return false;
      if (filters.dosFrom && (row.serviceDate ?? "") < filters.dosFrom)
        return false;
      if (filters.dosTo && (row.serviceDate ?? "") > filters.dosTo)
        return false;
      if (!passesAging(row.requestedAt, filters.agingBucket)) return false;
      if (filters.carcRarc) {
        const needle = filters.carcRarc.toLowerCase();
        const hay = [...row.carcCodes, ...row.rarcCodes]
          .join(",")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (filters.followUpDue) {
        if (!row.refundDueDate || row.refundDueDate > filters.followUpDue)
          return false;
      }
      if (filters.practice && row.locationId !== filters.practice) {
        return false;
      }
      if (filters.clinician) {
        // Clinician facet values are display names. Match against the
        // joined provider's name OR the client's primary clinician.
        const apptName =
          (row.providerId && providerNameById.get(row.providerId)) || "";
        const primaryName =
          (clinicianId(row.clientId) &&
            providerNameById.get(clinicianId(row.clientId)!)) ||
          "";
        const needle = filters.clinician.toLowerCase();
        if (
          apptName.toLowerCase() !== needle &&
          primaryName.toLowerCase() !== needle
        ) {
          return false;
        }
      }
      return true;
    });

    return NextResponse.json({
      success: true,
      rows: filtered,
      facets: {
        payers: facets.payers,
        practices: facets.practices,
        clinicians: facets.clinicians,
        staff: facets.staff,
      },
    });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Failed to load refunds",
      },
      { status: 500 },
    );
  }
}
