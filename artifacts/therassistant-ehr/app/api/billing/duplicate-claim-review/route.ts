/**
 * GET /api/billing/duplicate-claim-review?organizationId=...&...filters
 *
 * Returns potential-duplicate claim pairs for the Duplicate Claim Review
 * workqueue. Detection is layered into five buckets:
 *
 *  - exact           — same client + same DOS + same procedure code + same units + same modifiers
 *  - same_dos_code   — same client + same DOS + same procedure code
 *  - same_dos_diff   — same client + same DOS + different procedure code
 *  - overlapping     — same client + DOS within +/- 1 day window
 *  - previously_paid — the "potential duplicate" claim has already been paid
 *
 * A pair is suppressed if any claim_note has been written with body prefix
 * `DUP_DISMISS:<otherClaimId>` (see POST .../[claimId] action=mark_not_duplicate).
 *
 * Universal filter rail support — all of these narrow the underlying claim
 * set before pairs are computed, so the table, summary strip, and tab
 * counts all reflect the filter selection:
 *
 *   client          — substring match on client first/last name
 *   clinician       — exact match on resolved provider display name
 *   payer           — payer_profile_id
 *   dosFrom/dosTo   — service-line first-service-date window
 *   status          — current claim_status
 *   assignedBiller  — substring match on billing_notes (free-text)
 *   minAmount/maxAmount — total_charge range on the current claim
 *   agingBucket     — bucketed days since current claim's created_at
 *   carcRarc        — substring match on denial_reason_code/description
 *   priority        — derived risk level (high|medium|low)
 *   followUpDue     — appeal_deadline_date <= value on the current claim
 *   practice        — clients.location_id (practice/location id)
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, any>;

function text(value: unknown): string {
  return String(value ?? "").trim();
}
function money(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.abs(Math.floor((da - db) / (24 * 3600 * 1000)));
}
function ageDays(d: string | null): number {
  if (!d) return 0;
  const t = Date.parse(d);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 3600 * 1000)));
}

const PAID_STATUSES = new Set(["paid"]);
const TERMINAL_STATUSES = new Set(["voided"]);

export type DuplicateTab =
  | "exact"
  | "same_dos_code"
  | "same_dos_diff"
  | "overlapping"
  | "previously_paid";

export interface DuplicateRow {
  id: string; // pairId: `${currentClaimId}::${otherClaimId}`
  currentClaimId: string;
  otherClaimId: string;
  tab: DuplicateTab;
  tabs: DuplicateTab[];
  clientId: string | null;
  clientName: string;
  dos: string | null;
  clinician: string;
  code: string;
  current: {
    id: string;
    claimNumber: string;
    status: string;
    totalCharge: number;
    createdAt: string | null;
  };
  potential: {
    id: string;
    claimNumber: string;
    status: string;
    totalCharge: number;
    paidAmount: number;
    createdAt: string | null;
  };
  riskLevel: "high" | "medium" | "low";
  matchReason: string;
}

interface FilterSelection {
  client: string | null;
  clinician: string | null;
  payer: string | null;
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
  practice: string | null;
}

function parseFilters(params: URLSearchParams): FilterSelection {
  const v = (k: string) => {
    const raw = params.get(k);
    return raw && raw.trim() ? raw.trim() : null;
  };
  const num = (k: string) => {
    const raw = v(k);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const agingBucket = v("agingBucket");
  const priority = v("priority");
  return {
    client: v("client"),
    clinician: v("clinician"),
    payer: v("payer"),
    dosFrom: v("dosFrom"),
    dosTo: v("dosTo"),
    status: v("status"),
    assignedBiller: v("assignedBiller"),
    minAmount: num("minAmount"),
    maxAmount: num("maxAmount"),
    agingBucket:
      agingBucket === "0-30" ||
      agingBucket === "31-60" ||
      agingBucket === "61-90" ||
      agingBucket === "90+"
        ? agingBucket
        : null,
    carcRarc: v("carcRarc"),
    priority: priority === "high" || priority === "medium" || priority === "low" ? priority : null,
    followUpDue: v("followUpDue"),
    practice: v("practice"),
  };
}

function passesAgingBucket(createdAt: string | null, bucket: FilterSelection["agingBucket"]): boolean {
  if (!bucket) return true;
  const age = ageDays(createdAt);
  switch (bucket) {
    case "0-30": return age <= 30;
    case "31-60": return age > 30 && age <= 60;
    case "61-90": return age > 60 && age <= 90;
    case "90+": return age > 90;
    default: return true;
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
    const filters = parseFilters(searchParams);

    // ── Pull all candidate claims (non-archived, non-voided). ────────────
    let claimsQuery = (supabase as any)
      .from("professional_claims")
      .select(
        "id, claim_number, patient_id, payer_profile_id, claim_status, total_charge, created_at, updated_at, encounter_id, appointment_id, appeal_deadline_date, billing_notes, denial_reason_code, denial_reason_description",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null);

    if (filters.payer) claimsQuery = claimsQuery.eq("payer_profile_id", filters.payer);
    if (filters.status) claimsQuery = claimsQuery.eq("claim_status", filters.status);
    if (filters.minAmount != null) claimsQuery = claimsQuery.gte("total_charge", filters.minAmount);
    if (filters.maxAmount != null) claimsQuery = claimsQuery.lte("total_charge", filters.maxAmount);
    if (filters.followUpDue) claimsQuery = claimsQuery.lte("appeal_deadline_date", filters.followUpDue);
    if (filters.assignedBiller) claimsQuery = claimsQuery.ilike("billing_notes", `%${filters.assignedBiller}%`);
    if (filters.carcRarc) {
      claimsQuery = claimsQuery.or(
        `denial_reason_code.ilike.%${filters.carcRarc}%,denial_reason_description.ilike.%${filters.carcRarc}%`,
      );
    }

    claimsQuery = claimsQuery.order("created_at", { ascending: false }).limit(2000);
    const { data: claims, error: claimsErr } = await claimsQuery;
    if (claimsErr) throw claimsErr;
    let claimRows: DbRow[] = (claims as DbRow[]) ?? [];

    // Aging bucket and practice need post-fetch / join filtering.
    if (filters.agingBucket) {
      claimRows = claimRows.filter((c) => passesAgingBucket(c.created_at ?? null, filters.agingBucket));
    }

    if (claimRows.length === 0) {
      const facets = await loadFacets(supabase, organizationId);
      return NextResponse.json({ success: true, rows: [], facets });
    }

    const claimIds = claimRows.map((c) => text(c.id));
    let patientIds = [...new Set(claimRows.map((c) => text(c.patient_id)).filter(Boolean))];
    const payerProfileIds = [
      ...new Set(claimRows.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];
    const appointmentIds = [
      ...new Set(claimRows.map((c) => text(c.appointment_id)).filter(Boolean)),
    ];

    const [
      { data: serviceLines },
      patientsResult,
      { data: payerProfiles },
      { data: appointments },
      { data: notes },
    ] = await Promise.all([
      (supabase as any)
        .from("professional_claim_service_lines")
        .select(
          "claim_id, line_number, service_date_from, service_date_to, procedure_code, modifiers, units, charge_amount, rendering_provider_npi",
        )
        .in("claim_id", claimIds)
        .order("line_number", { ascending: true }),
      patientIds.length
        ? (supabase as any)
            .from("clients")
            .select("id, first_name, last_name, date_of_birth, location_id")
            .in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerProfileIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name, office_ally_payer_id")
            .in("id", payerProfileIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      appointmentIds.length
        ? (supabase as any)
            .from("appointments")
            .select(
              "id, scheduled_start_at, scheduled_end_at, provider_id, client_id, appointment_type",
            )
            .in("id", appointmentIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_notes")
            .select("claim_id, body, created_at, author_display_name")
            .in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    // ── Per-claim aggregates ───────────────────────────────────────────────
    const linesByClaim = new Map<string, DbRow[]>();
    for (const sl of (serviceLines as DbRow[]) ?? []) {
      const cid = text(sl.claim_id);
      if (!linesByClaim.has(cid)) linesByClaim.set(cid, []);
      linesByClaim.get(cid)!.push(sl);
    }

    const patientById = new Map<string, DbRow>(
      ((patientsResult.data as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payerProfiles as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const apptById = new Map<string, DbRow>(
      ((appointments as DbRow[]) ?? []).map((a) => [text(a.id), a]),
    );

    // Resolve provider names from appointments → staff_profiles.
    const providerIds = [
      ...new Set(
        Array.from(apptById.values())
          .map((a) => text(a.provider_id))
          .filter(Boolean),
      ),
    ];
    let providerById = new Map<string, string>();
    if (providerIds.length) {
      const { data: providers } = await (supabase as any)
        .from("staff_profiles")
        .select("id, first_name, last_name")
        .in("id", providerIds);
      providerById = new Map(
        ((providers as DbRow[]) ?? []).map((p) => [
          text(p.id),
          [text(p.first_name), text(p.last_name)].filter(Boolean).join(" ") || "—",
        ]),
      );
    }

    // Paid amount from ERA postings.
    const paidByClaim = new Map<string, number>();
    if (claimIds.length) {
      const { data: postings } = await (supabase as any)
        .from("era_postings")
        .select("claim_id, paid_amount")
        .in("claim_id", claimIds);
      for (const p of (postings as DbRow[]) ?? []) {
        const cid = text(p.claim_id);
        const v = money(p.paid_amount);
        paidByClaim.set(cid, (paidByClaim.get(cid) ?? 0) + v);
      }
    }

    // Pair suppression — three markers in claim_notes the GET endpoint honours
    // so action results survive a refresh:
    //   DUP_DISMISS:<otherId>        — permanent (Mark not duplicate)
    //   DUP_OVERRIDE:<otherId>       — permanent (Submit anyway with reason)
    //   DUP_HOLD:<otherId>:<untilISO> — temporary; expires when untilISO < today
    const dismissed = new Set<string>();
    const today = new Date().toISOString().slice(0, 10);
    for (const n of (notes as DbRow[]) ?? []) {
      const body = text(n.body);
      let match = body.match(/^DUP_(?:DISMISS|OVERRIDE):([0-9a-f-]+)/i);
      if (match) {
        const cid = text(n.claim_id);
        const otherId = match[1].toLowerCase();
        dismissed.add(`${cid}::${otherId}`);
        dismissed.add(`${otherId}::${cid}`);
        continue;
      }
      match = body.match(/^DUP_HOLD:([0-9a-f-]+):(\d{4}-\d{2}-\d{2})/i);
      if (match && match[2] >= today) {
        const cid = text(n.claim_id);
        const otherId = match[1].toLowerCase();
        dismissed.add(`${cid}::${otherId}`);
        dismissed.add(`${otherId}::${cid}`);
      }
    }

    // ── Build per-claim derived shape ──────────────────────────────────────
    interface Derived {
      id: string;
      claimNumber: string;
      patientId: string | null;
      payerProfileId: string | null;
      status: string;
      createdAt: string | null;
      totalCharge: number;
      dosFrom: string | null;
      codes: string[];
      lines: Array<{
        procedureCode: string;
        modifiers: string[];
        units: number;
        dos: string | null;
      }>;
      providerName: string;
      locationId: string | null;
    }

    const derived = new Map<string, Derived>();
    for (const c of claimRows) {
      const id = text(c.id);
      const status = text(c.claim_status);
      if (TERMINAL_STATUSES.has(status)) continue;

      // Apply remaining row-level filters that we couldn't push to Postgres.
      const client = c.patient_id ? patientById.get(text(c.patient_id)) : null;
      if (filters.practice && text(client?.location_id) !== filters.practice) continue;
      if (filters.client) {
        const q = filters.client.toLowerCase();
        const name = client
          ? `${text(client.first_name)} ${text(client.last_name)}`.toLowerCase()
          : "";
        if (!name.includes(q)) continue;
      }
      if (filters.dosFrom || filters.dosTo) {
        const lines = linesByClaim.get(id) ?? [];
        const dos = lines.length ? text(lines[0].service_date_from) : "";
        if (!dos) continue;
        if (filters.dosFrom && dos < filters.dosFrom) continue;
        if (filters.dosTo && dos > filters.dosTo) continue;
      }
      const appt = apptById.get(text(c.appointment_id));
      const providerName =
        (appt ? providerById.get(text(appt.provider_id)) : null) || "—";
      if (filters.clinician && providerName !== filters.clinician) continue;

      const lines = linesByClaim.get(id) ?? [];
      const dosFrom = lines.length ? text(lines[0].service_date_from) || null : null;
      const codes = lines.map((l) => text(l.procedure_code)).filter(Boolean);
      derived.set(id, {
        id,
        claimNumber: text(c.claim_number),
        patientId: text(c.patient_id) || null,
        payerProfileId: text(c.payer_profile_id) || null,
        status,
        createdAt: c.created_at ?? null,
        totalCharge: money(c.total_charge),
        dosFrom,
        codes,
        lines: lines.map((l) => ({
          procedureCode: text(l.procedure_code),
          modifiers: ((l.modifiers as string[]) ?? []).map((m) => text(m)).filter(Boolean),
          units: Number(l.units ?? 1),
          dos: text(l.service_date_from) || null,
        })),
        providerName,
        locationId: text(client?.location_id) || null,
      });
    }

    // ── Pair detection ─────────────────────────────────────────────────────
    // Group by (patientId, dosFrom) and (patientId) for the overlap pass.
    const byPatientDos = new Map<string, Derived[]>();
    const byClient = new Map<string, Derived[]>();
    for (const d of derived.values()) {
      if (!d.patientId) continue;
      if (d.dosFrom) {
        const key = `${d.patientId}::${d.dosFrom}`;
        if (!byPatientDos.has(key)) byPatientDos.set(key, []);
        byPatientDos.get(key)!.push(d);
      }
      if (!byClient.has(d.patientId)) byClient.set(d.patientId, []);
      byClient.get(d.patientId)!.push(d);
    }

    const pairs = new Map<string, DuplicateRow>();

    function recordPair(
      current: Derived,
      other: Derived,
      tab: DuplicateTab,
      code: string,
      reason: string,
      risk: "high" | "medium" | "low",
    ) {
      if (current.id === other.id) return;
      if (dismissed.has(`${current.id}::${other.id}`)) return;
      const pairId = `${current.id}::${other.id}`;
      const existing = pairs.get(pairId);
      if (existing) {
        if (!existing.tabs.includes(tab)) existing.tabs.push(tab);
        const order: DuplicateTab[] = [
          "previously_paid",
          "exact",
          "same_dos_code",
          "same_dos_diff",
          "overlapping",
        ];
        if (order.indexOf(tab) < order.indexOf(existing.tab)) {
          existing.tab = tab;
          existing.matchReason = reason;
          existing.riskLevel = risk;
        }
        return;
      }
      const client = current.patientId ? patientById.get(current.patientId) : null;
      const clientName = client
        ? [text(client.first_name), text(client.last_name)].filter(Boolean).join(" ") ||
          "Unknown client"
        : "Unknown client";
      pairs.set(pairId, {
        id: pairId,
        currentClaimId: current.id,
        otherClaimId: other.id,
        tab,
        tabs: [tab],
        clientId: current.patientId,
        clientName,
        dos: current.dosFrom,
        clinician: current.providerName,
        code,
        current: {
          id: current.id,
          claimNumber: current.claimNumber || current.id.slice(0, 8),
          status: current.status,
          totalCharge: current.totalCharge,
          createdAt: current.createdAt,
        },
        potential: {
          id: other.id,
          claimNumber: other.claimNumber || other.id.slice(0, 8),
          status: other.status,
          totalCharge: other.totalCharge,
          paidAmount: paidByClaim.get(other.id) ?? 0,
          createdAt: other.createdAt,
        },
        riskLevel: risk,
        matchReason: reason,
      });
    }

    function isCurrentCandidate(a: Derived, b: Derived): boolean {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (ta !== tb) return ta > tb;
      return a.id > b.id;
    }

    // Same DOS buckets.
    for (const group of byPatientDos.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          const current = isCurrentCandidate(a, b) ? a : b;
          const other = current === a ? b : a;

          const aCodes = new Set(a.codes);
          const sharedCodes = b.codes.filter((c) => aCodes.has(c));
          const disjointCodes = b.codes.filter((c) => !aCodes.has(c));

          let exactCode: string | null = null;
          for (const la of current.lines) {
            for (const lo of other.lines) {
              if (
                la.procedureCode &&
                la.procedureCode === lo.procedureCode &&
                la.units === lo.units &&
                JSON.stringify([...la.modifiers].sort()) ===
                  JSON.stringify([...lo.modifiers].sort())
              ) {
                exactCode = la.procedureCode;
                break;
              }
            }
            if (exactCode) break;
          }

          if (exactCode) {
            recordPair(
              current,
              other,
              "exact",
              exactCode,
              `Exact match on ${exactCode} (same units & modifiers, DOS ${current.dosFrom})`,
              "high",
            );
          }

          for (const code of sharedCodes) {
            if (code === exactCode) continue;
            recordPair(
              current,
              other,
              "same_dos_code",
              code,
              `Same DOS ${current.dosFrom}, same procedure ${code}, different units/modifiers`,
              "high",
            );
          }

          for (const code of disjointCodes) {
            recordPair(
              current,
              other,
              "same_dos_diff",
              code || "—",
              `Same DOS ${current.dosFrom}, different procedure on this claim vs the other`,
              "medium",
            );
          }

          if (PAID_STATUSES.has(other.status)) {
            const code = exactCode || sharedCodes[0] || other.codes[0] || "—";
            recordPair(
              current,
              other,
              "previously_paid",
              code,
              `Previously paid claim ${other.claimNumber || other.id.slice(0, 8)} for same DOS`,
              "high",
            );
          }
        }
      }
    }

    // Overlapping time window (+/- 1 day, not same DOS).
    for (const list of byClient.values()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (!a.dosFrom || !b.dosFrom) continue;
          if (a.dosFrom === b.dosFrom) continue;
          const diff = daysBetween(a.dosFrom, b.dosFrom);
          if (diff == null || diff > 1) continue;
          const current = isCurrentCandidate(a, b) ? a : b;
          const other = current === a ? b : a;
          const code = current.codes[0] || other.codes[0] || "—";
          recordPair(
            current,
            other,
            "overlapping",
            code,
            `DOS ${a.dosFrom} and ${b.dosFrom} for the same client are ${diff} day(s) apart`,
            "low",
          );
        }
      }
    }

    let rows = Array.from(pairs.values());

    // Priority filter operates on the derived pair risk level.
    if (filters.priority) {
      rows = rows.filter((r) => r.riskLevel === filters.priority);
    }

    rows.sort((x, y) => {
      return (
        (Date.parse(y.current.createdAt ?? "") || 0) -
        (Date.parse(x.current.createdAt ?? "") || 0)
      );
    });

    const facets = await loadFacets(supabase, organizationId, {
      payerById,
      providerNames: new Set(
        Array.from(derived.values())
          .map((d) => d.providerName)
          .filter((n) => n && n !== "—"),
      ),
    });

    return NextResponse.json({
      success: true,
      organizationId,
      rows,
      facets,
    });
  } catch (error) {
    console.error("Duplicate review API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Duplicate review API failed",
      },
      { status: 500 },
    );
  }
}

async function loadFacets(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  organizationId: string,
  hints?: {
    payerById?: Map<string, DbRow>;
    providerNames?: Set<string>;
  },
): Promise<{
  clinicians: string[];
  payers: Array<{ id: string; name: string }>;
  practices: Array<{ id: string; name: string }>;
}> {
  if (!supabase) {
    return { clinicians: [], payers: [], practices: [] };
  }
  // Pull the org's full list of practices + payers + active providers so the
  // dropdowns include valid choices even when the current result set is
  // already narrowed by other filters (so a user can clear a filter and pick
  // a different value without losing context).
  const [{ data: practiceRows }, { data: payerRows }, { data: providerRows }] =
    await Promise.all([
      (supabase as any)
        .from("provider_locations")
        .select("id, location_name")
        .eq("organization_id", organizationId)
        .order("location_name", { ascending: true }),
      (supabase as any)
        .from("payer_profiles")
        .select("id, payer_name")
        .eq("organization_id", organizationId)
        .order("payer_name", { ascending: true }),
      (supabase as any)
        .from("staff_profiles")
        .select("id, first_name, last_name")
        .eq("organization_id", organizationId)
        .order("last_name", { ascending: true }),
    ]);

  const practices = ((practiceRows as DbRow[]) ?? [])
    .map((r) => ({ id: text(r.id), name: text(r.location_name) || "Unnamed practice" }))
    .filter((r) => r.id);
  const payers = ((payerRows as DbRow[]) ?? [])
    .map((r) => ({ id: text(r.id), name: text(r.payer_name) || "Unnamed payer" }))
    .filter((r) => r.id);
  const clinicians = ((providerRows as DbRow[]) ?? [])
    .map((r) => [text(r.first_name), text(r.last_name)].filter(Boolean).join(" "))
    .filter((n) => n.length > 0);

  // Preserve any provider name surfaced in the result set that isn't in
  // staff_profiles (e.g. legacy data).
  if (hints?.providerNames) {
    for (const n of hints.providerNames) {
      if (!clinicians.includes(n)) clinicians.push(n);
    }
  }
  clinicians.sort();

  return { clinicians, payers, practices };
}
