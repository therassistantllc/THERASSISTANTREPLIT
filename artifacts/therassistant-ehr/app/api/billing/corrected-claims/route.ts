/**
 * GET /api/billing/corrected-claims?organizationId=...&...filters
 *
 * Backs the Corrected Claim workqueue (Task #367). The queue is layered into
 * five tabs computed off two shapes of row:
 *
 *   "Corrected Claim Needed"  — original claims (status in denied / rejected_*
 *                               / accepted_oa-then-rejected_payer) that do
 *                               NOT yet have any child correction.
 *   "Replacement Claim"       — child claims with correction_type='replacement'
 *                               and correction_status in (pending, ready).
 *   "Void Claim"              — child claims with correction_type='void' and
 *                               correction_status in (pending, ready).
 *   "Resubmission Ready"      — child claims with correction_status='ready'
 *                               (irrespective of replacement vs void).
 *   "Correction Sent"         — child claims with correction_status='sent'.
 *
 * Originals that have been dismissed with a claim_notes marker of
 * `CORRECTION_DISMISS:<claimId>` are suppressed from the "Needed" tab so
 * billers can drop them from the queue.
 *
 * Universal filter rail: client, clinician, payer, practice, dosFrom/dosTo,
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

const NEEDS_CORRECTION_STATUSES = new Set([
  "denied",
  "rejected_payer",
  "rejected_oa",
]);

export type CorrectedTab =
  | "needed"
  | "replacement"
  | "void"
  | "ready"
  | "sent";

export interface CorrectedRow {
  id: string;
  tab: CorrectedTab;
  tabs: CorrectedTab[];
  originalClaimId: string;
  correctedClaimId: string | null;
  clientId: string | null;
  clientName: string;
  clinician: string;
  payerId: string | null;
  payerName: string;
  dos: string | null;
  denialReason: string;
  denialCode: string;
  correctionType: "replacement" | "void" | null;
  correctionReason: string | null;
  frequencyCode: string;
  chargeAmount: number;
  status: string;
  correctionStatus: "pending" | "ready" | "sent" | null;
  createdAt: string | null;
  correctionSentAt: string | null;
  appealDeadlineDate: string | null;
  priority: "high" | "medium" | "low";
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
  appealDeadlineDate: string | null;
  createdAt: string | null;
  chargeAmount: number;
}): "high" | "medium" | "low" {
  const age = ageDays(args.createdAt);
  if (args.appealDeadlineDate) {
    const days = Math.floor(
      (Date.parse(args.appealDeadlineDate) - Date.now()) / (24 * 3600 * 1000),
    );
    if (Number.isFinite(days) && days <= 14) return "high";
  }
  if (age > 60 || args.chargeAmount >= 500) return "high";
  if (age > 30 || args.chargeAmount >= 150) return "medium";
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

    // ── Pull all candidate claims ────────────────────────────────────────
    // Candidates are either:
    //   (a) originals — denied / rejected_payer / rejected_oa, no child yet
    //   (b) children — correction_type is not null
    let q = (supabase as any)
      .from("professional_claims")
      .select(
        "id, organization_id, claim_number, patient_id, payer_profile_id, claim_status, claim_frequency_code, total_charge, created_at, updated_at, appointment_id, appeal_deadline_date, billing_notes, denial_reason_code, denial_reason_description, original_claim_id, correction_type, correction_status, correction_reason, correction_sent_at, archived_at",
      )
      .eq("organization_id", organizationId);

    if (filters.payer) q = q.eq("payer_profile_id", filters.payer);
    if (filters.minAmount != null) q = q.gte("total_charge", filters.minAmount);
    if (filters.maxAmount != null) q = q.lte("total_charge", filters.maxAmount);
    if (filters.followUpDue) q = q.lte("appeal_deadline_date", filters.followUpDue);
    if (filters.assignedBiller) {
      q = q.ilike("billing_notes", `%${filters.assignedBiller}%`);
    }
    if (filters.carcRarc) {
      q = q.or(
        `denial_reason_code.ilike.%${filters.carcRarc}%,denial_reason_description.ilike.%${filters.carcRarc}%`,
      );
    }

    q = q.order("created_at", { ascending: false }).limit(3000);
    const { data: claimsRaw, error } = await q;
    if (error) throw error;
    const all: DbRow[] = (claimsRaw as DbRow[]) ?? [];

    // Index by id and originals → children.
    const byId = new Map<string, DbRow>();
    const childrenOf = new Map<string, DbRow[]>();
    for (const c of all) {
      byId.set(text(c.id), c);
    }
    for (const c of all) {
      const orig = text(c.original_claim_id);
      if (orig) {
        if (!childrenOf.has(orig)) childrenOf.set(orig, []);
        childrenOf.get(orig)!.push(c);
      }
    }

    // ── Joins for display fields ─────────────────────────────────────────
    const patientIds = [
      ...new Set(all.map((c) => text(c.patient_id)).filter(Boolean)),
    ];
    const payerIds = [
      ...new Set(all.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];
    const appointmentIds = [
      ...new Set(all.map((c) => text(c.appointment_id)).filter(Boolean)),
    ];
    const claimIds = all.map((c) => text(c.id));

    const [
      { data: clients },
      { data: payers },
      { data: appointments },
      { data: lines },
      { data: notes },
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
            .select("id, payer_name")
            .in("id", payerIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      appointmentIds.length
        ? (supabase as any)
            .from("appointments")
            .select("id, provider_id")
            .in("id", appointmentIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claim_service_lines")
            .select("claim_id, line_number, service_date_from")
            .in("claim_id", claimIds)
            .order("line_number", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_notes")
            .select("claim_id, body")
            .in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const clientById = new Map<string, DbRow>(
      ((clients as DbRow[]) ?? []).map((c) => [text(c.id), c]),
    );
    const payerById = new Map<string, DbRow>(
      ((payers as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const apptById = new Map<string, DbRow>(
      ((appointments as DbRow[]) ?? []).map((a) => [text(a.id), a]),
    );

    const providerIds = [
      ...new Set(
        Array.from(apptById.values())
          .map((a) => text(a.provider_id))
          .filter(Boolean),
      ),
    ];
    const providerById = new Map<string, string>();
    if (providerIds.length) {
      const { data: provs } = await (supabase as any)
        .from("staff_profiles")
        .select("id, first_name, last_name")
        .in("id", providerIds);
      for (const p of (provs as DbRow[]) ?? []) {
        providerById.set(
          text(p.id),
          [text(p.first_name), text(p.last_name)].filter(Boolean).join(" ") || "—",
        );
      }
    }

    const dosByClaim = new Map<string, string>();
    for (const l of (lines as DbRow[]) ?? []) {
      const cid = text(l.claim_id);
      if (!dosByClaim.has(cid)) dosByClaim.set(cid, text(l.service_date_from));
    }

    // Dismissals from claim_notes — CORRECTION_DISMISS:<originalId>.
    const dismissed = new Set<string>();
    for (const n of (notes as DbRow[]) ?? []) {
      const body = text(n.body);
      const m = body.match(/^CORRECTION_DISMISS:([0-9a-f-]+)/i);
      if (m) dismissed.add(m[1].toLowerCase());
    }

    // ── Row construction ─────────────────────────────────────────────────
    function rowFromOriginal(orig: DbRow): CorrectedRow | null {
      const id = text(orig.id);
      const client = clientById.get(text(orig.patient_id)) ?? null;
      const payer = payerById.get(text(orig.payer_profile_id)) ?? null;
      const appt = apptById.get(text(orig.appointment_id)) ?? null;
      const clinician =
        (appt ? providerById.get(text(appt.provider_id)) : null) || "—";

      if (filters.practice && text(client?.location_id) !== filters.practice) return null;
      if (filters.clinician && clinician !== filters.clinician) return null;
      if (filters.client) {
        const name = client
          ? `${text(client.first_name)} ${text(client.last_name)}`.toLowerCase()
          : "";
        if (!name.includes(filters.client.toLowerCase())) return null;
      }
      const dos = dosByClaim.get(id) || null;
      if (filters.dosFrom && (!dos || dos < filters.dosFrom)) return null;
      if (filters.dosTo && (!dos || dos > filters.dosTo)) return null;
      if (filters.status && text(orig.claim_status) !== filters.status) return null;
      if (!passesAging(text(orig.created_at) || null, filters.agingBucket)) return null;

      const charge = money(orig.total_charge);
      const priority = derivePriority({
        appealDeadlineDate: text(orig.appeal_deadline_date) || null,
        createdAt: text(orig.created_at) || null,
        chargeAmount: charge,
      });
      if (filters.priority && filters.priority !== priority) return null;

      const clientName = client
        ? [text(client.first_name), text(client.last_name)].filter(Boolean).join(" ") ||
          "Unknown client"
        : "Unknown client";

      return {
        id,
        tab: "needed",
        tabs: ["needed"],
        originalClaimId: id,
        correctedClaimId: null,
        clientId: text(orig.patient_id) || null,
        clientName,
        clinician,
        payerId: text(orig.payer_profile_id) || null,
        payerName: payer ? text(payer.payer_name) : "—",
        dos,
        denialReason: text(orig.denial_reason_description) || "—",
        denialCode: text(orig.denial_reason_code) || "",
        correctionType: null,
        correctionReason: null,
        frequencyCode: text(orig.claim_frequency_code) || "1",
        chargeAmount: charge,
        status: text(orig.claim_status),
        correctionStatus: null,
        createdAt: text(orig.created_at) || null,
        correctionSentAt: null,
        appealDeadlineDate: text(orig.appeal_deadline_date) || null,
        priority,
      };
    }

    function rowFromChild(child: DbRow): CorrectedRow | null {
      const id = text(child.id);
      const origId = text(child.original_claim_id);
      const orig = origId ? byId.get(origId) : null;

      const client = clientById.get(text(child.patient_id)) ?? null;
      const payer = payerById.get(text(child.payer_profile_id)) ?? null;
      const appt = apptById.get(text(child.appointment_id)) ?? null;
      const clinician =
        (appt ? providerById.get(text(appt.provider_id)) : null) || "—";

      if (filters.practice && text(client?.location_id) !== filters.practice) return null;
      if (filters.clinician && clinician !== filters.clinician) return null;
      if (filters.client) {
        const name = client
          ? `${text(client.first_name)} ${text(client.last_name)}`.toLowerCase()
          : "";
        if (!name.includes(filters.client.toLowerCase())) return null;
      }
      const dos = dosByClaim.get(id) || (orig ? dosByClaim.get(text(orig.id)) ?? null : null);
      if (filters.dosFrom && (!dos || dos < filters.dosFrom)) return null;
      if (filters.dosTo && (!dos || dos > filters.dosTo)) return null;
      if (filters.status && text(child.claim_status) !== filters.status) return null;
      if (!passesAging(text(child.created_at) || null, filters.agingBucket)) return null;

      const charge = money(child.total_charge);
      const correctionStatus =
        (text(child.correction_status) as "pending" | "ready" | "sent") || null;
      const correctionType =
        (text(child.correction_type) as "replacement" | "void") || null;

      const tabs: CorrectedTab[] = [];
      if (correctionStatus === "sent") {
        tabs.push("sent");
      } else if (correctionStatus === "ready") {
        tabs.push("ready");
        if (correctionType === "replacement") tabs.push("replacement");
        if (correctionType === "void") tabs.push("void");
      } else {
        if (correctionType === "replacement") tabs.push("replacement");
        if (correctionType === "void") tabs.push("void");
      }
      if (tabs.length === 0) return null;

      const priority = derivePriority({
        appealDeadlineDate:
          text(child.appeal_deadline_date) ||
          (orig ? text(orig.appeal_deadline_date) : "") ||
          null,
        createdAt: text(child.created_at) || null,
        chargeAmount: charge,
      });
      if (filters.priority && filters.priority !== priority) return null;

      const clientName = client
        ? [text(client.first_name), text(client.last_name)].filter(Boolean).join(" ") ||
          "Unknown client"
        : "Unknown client";

      return {
        id,
        tab: tabs[0],
        tabs,
        originalClaimId: origId || id,
        correctedClaimId: id,
        clientId: text(child.patient_id) || null,
        clientName,
        clinician,
        payerId: text(child.payer_profile_id) || null,
        payerName: payer ? text(payer.payer_name) : "—",
        dos,
        denialReason:
          (orig ? text(orig.denial_reason_description) : "") ||
          text(child.denial_reason_description) ||
          "—",
        denialCode:
          (orig ? text(orig.denial_reason_code) : "") ||
          text(child.denial_reason_code) ||
          "",
        correctionType,
        correctionReason: text(child.correction_reason) || null,
        frequencyCode: text(child.claim_frequency_code) || (correctionType === "void" ? "8" : "7"),
        chargeAmount: charge,
        status: text(child.claim_status),
        correctionStatus,
        createdAt: text(child.created_at) || null,
        correctionSentAt: text(child.correction_sent_at) || null,
        appealDeadlineDate: text(child.appeal_deadline_date) || null,
        priority,
      };
    }

    const rows: CorrectedRow[] = [];

    for (const c of all) {
      // Skip archived correction children entirely (they shouldn't show up).
      if (text(c.archived_at)) continue;

      // Children (anything with a correction_type / original_claim_id set)
      if (text(c.original_claim_id) || text(c.correction_type)) {
        const r = rowFromChild(c);
        if (r) rows.push(r);
        continue;
      }

      // Originals — only those that need correction and have no child yet.
      const status = text(c.claim_status);
      if (!NEEDS_CORRECTION_STATUSES.has(status)) continue;
      if (dismissed.has(text(c.id))) continue;
      if ((childrenOf.get(text(c.id)) ?? []).length > 0) continue;
      const r = rowFromOriginal(c);
      if (r) rows.push(r);
    }

    rows.sort((a, b) => {
      const da = a.createdAt ? Date.parse(a.createdAt) : 0;
      const db = b.createdAt ? Date.parse(b.createdAt) : 0;
      return db - da;
    });

    const facets = await loadFacets(supabase, organizationId);
    return NextResponse.json({ success: true, rows, facets });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed to load corrected claims" },
      { status: 500 },
    );
  }
}
