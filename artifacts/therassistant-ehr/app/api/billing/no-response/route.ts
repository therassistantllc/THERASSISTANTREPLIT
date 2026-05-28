/**
 * GET /api/billing/no-response
 *
 * "No Response" workqueue: claims that have been submitted but for which
 * the expected acknowledgement / status has not come back.
 *
 * Powers the page at /billing/no-response. Previously lived at
 * /api/billing/claim-readiness; that path was retired in Task #424 because
 * Charge Capture moved off it and the name implied a broader role than the
 * route actually had.
 *
 * Tabs (server-classified via missingArtifact):
 *   - no_999            : no 999 ack from clearinghouse
 *   - no_277ca          : no 277CA from clearinghouse
 *   - no_payer_status   : no payer-side status inquiry / response
 *   - no_era            : no ERA / 835 payment received
 *   - past_follow_up    : hold_follow_up_date or defer_until in the past
 *
 * Filter params (all optional, all client-driven, reflected in URL):
 *   tab, practice, clinician, payer, client, dosFrom, dosTo, status,
 *   assignedBiller, minAmount, maxAmount, agingBucket, carcRarc, priority,
 *   followUpDue
 *
 * Response shape:
 *   { success, organizationId, items: NoResponseRow[], tabCounts, practices, clinicians, assignees }
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;

export type NoResponseTab =
  | "no_999"
  | "no_277ca"
  | "no_payer_status"
  | "no_era"
  | "past_follow_up";

const TAB_IDS: NoResponseTab[] = [
  "no_999",
  "no_277ca",
  "no_payer_status",
  "no_era",
  "past_follow_up",
];

const text = (value: unknown) => String(value ?? "").trim();
const money = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function isExpired(value: string | null, today: string): boolean {
  return !!value && value < today;
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

    const today = new Date().toISOString().slice(0, 10);

    // 1) Pull every still-open submitted claim. Tab/filter is applied below
    //    in JS so we can compute tabCounts in one pass.
    const { data: claimRows, error: claimsError } = await (supabase as any)
      .from("professional_claims")
      .select(
        [
          "id",
          "claim_number",
          "claim_status",
          "patient_id",
          "payer_profile_id",
          "appointment_id",
          "total_charge",
          "submitted_at",
          "defer_until",
          "deferred_reason",
          "hold_follow_up_date",
          "hold_assigned_to_user_id",
          "hold_assigned_to_display_name",
          "hold_priority",
          "created_at",
          "updated_at",
        ].join(", "),
      )
      .eq("organization_id", organizationId)
      .in("claim_status", ["submitted", "accepted_oa", "accepted_payer"])
      .is("archived_at", null)
      .order("submitted_at", { ascending: true, nullsFirst: true });

    if (claimsError) throw claimsError;

    const claims = (claimRows ?? []) as DbRow[];
    const claimIds = claims.map((c) => text(c.id)).filter(Boolean);
    const patientIds = [...new Set(claims.map((c) => text(c.patient_id)).filter(Boolean))];
    const payerProfileIds = [
      ...new Set(claims.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];
    const appointmentIds = [
      ...new Set(claims.map((c) => text(c.appointment_id)).filter(Boolean)),
    ];

    // 2) Joins.
    const [
      { data: clients },
      { data: payerProfiles },
      { data: serviceLines },
      { data: notes },
      { data: ediTx },
      { data: statusInquiries },
      { data: eraPayments },
      { data: appointments },
    ] = await Promise.all([
      patientIds.length
        ? supabase
            .from("clients")
            .select("id, first_name, last_name")
            .in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerProfileIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name, office_ally_payer_id, notes, claims_phone, claims_fax, fax_number, provider_services_phone")
            .in("id", payerProfileIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claim_service_lines")
            .select("claim_id, service_date_from, service_date_to")
            .in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_notes")
            .select("claim_id, body, created_at, author_display_name")
            .eq("organization_id", organizationId)
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("edi_transactions")
            .select("claim_id, transaction_type, correlation_id, created_at")
            .eq("organization_id", organizationId)
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_status_inquiries")
            .select("claim_id, status, status_code, received_at, created_at")
            .eq("organization_id", organizationId)
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("era_claim_payments")
            .select("professional_claim_id, clp04_payment_amount, created_at")
            .eq("organization_id", organizationId)
            .in("professional_claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      appointmentIds.length
        ? (supabase as any)
            .from("appointments")
            .select("id, provider_id, location_id")
            .in("id", appointmentIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const patientById = new Map<string, DbRow>(
      ((clients ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payerProfiles ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const apptById = new Map<string, DbRow>(
      ((appointments ?? []) as DbRow[]).map((a) => [text(a.id), a]),
    );

    const serviceLinesByClaim = new Map<string, { from: string | null; to: string | null }>();
    for (const line of (serviceLines ?? []) as DbRow[]) {
      const key = text(line.claim_id);
      if (!key) continue;
      const from = (line.service_date_from as string | null) ?? null;
      const to = (line.service_date_to as string | null) ?? null;
      const prior = serviceLinesByClaim.get(key);
      if (!prior) {
        serviceLinesByClaim.set(key, { from, to });
        continue;
      }
      serviceLinesByClaim.set(key, {
        from: prior.from && from ? (prior.from < from ? prior.from : from) : (prior.from ?? from),
        to: prior.to && to ? (prior.to > to ? prior.to : to) : (prior.to ?? to),
      });
    }

    const notesByClaim = new Map<string, DbRow[]>();
    for (const note of (notes ?? []) as DbRow[]) {
      const key = text(note.claim_id);
      if (!key) continue;
      const arr = notesByClaim.get(key) ?? [];
      arr.push(note);
      notesByClaim.set(key, arr);
    }

    // edi_transactions: detect what acks/responses have come back per claim
    const ediByClaim = new Map<
      string,
      { has999: boolean; has277ca: boolean; latestTrace: string | null }
    >();
    for (const tx of (ediTx ?? []) as DbRow[]) {
      const key = text(tx.claim_id);
      if (!key) continue;
      const cur = ediByClaim.get(key) ?? { has999: false, has277ca: false, latestTrace: null };
      const ttype = text(tx.transaction_type).toUpperCase();
      if (ttype === "999") cur.has999 = true;
      if (ttype === "277CA" || ttype === "277") cur.has277ca = true;
      if (!cur.latestTrace && tx.correlation_id) cur.latestTrace = text(tx.correlation_id);
      ediByClaim.set(key, cur);
    }

    const statusByClaim = new Map<string, DbRow>();
    for (const s of (statusInquiries ?? []) as DbRow[]) {
      const key = text(s.claim_id);
      if (!key || statusByClaim.has(key)) continue;
      statusByClaim.set(key, s);
    }

    const eraByClaim = new Map<string, DbRow[]>();
    for (const p of (eraPayments ?? []) as DbRow[]) {
      const key = text(p.professional_claim_id);
      if (!key) continue;
      const arr = eraByClaim.get(key) ?? [];
      arr.push(p);
      eraByClaim.set(key, arr);
    }

    // 3) Build rows with classification
    type Row = {
      id: string;
      claim_number: string | null;
      claim_status: string | null;
      patient_id: string | null;
      patient_name: string;
      payer_profile_id: string | null;
      payer_name: string | null;
      payer_id_external: string | null;
      payer_notes: string | null;
      payer_claims_phone: string | null;
      payer_claims_fax: string | null;
      payer_provider_services_phone: string | null;
      service_date_from: string | null;
      service_date_to: string | null;
      submitted_at: string | null;
      days_outstanding: number | null;
      total_charge: number;
      defer_until: string | null;
      deferred_reason: string | null;
      follow_up_due_date: string | null;
      assigned_to_user_id: string | null;
      assigned_to_display_name: string | null;
      priority: string | null;
      clinician_id: string | null;
      practice_location_id: string | null;
      note_count: number;
      latest_note_excerpt: string | null;
      latest_note_at: string | null;
      last_known_status: string;
      last_status_at: string | null;
      missing_artifact: NoResponseTab; // tab category
      expected_response_missing: string; // human-readable label
      clearinghouse_trace_number: string | null;
    };

    const rows: Row[] = claims.map((claim) => {
      const id = text(claim.id);
      const client = patientById.get(text(claim.patient_id));
      const patientName = client
        ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") ||
          "Unknown client"
        : "Unknown client";
      const payer = payerById.get(text(claim.payer_profile_id));
      const dates = serviceLinesByClaim.get(id) ?? { from: null, to: null };
      const claimNotes = notesByClaim.get(id) ?? [];
      const latest = claimNotes[0];
      const latestBody = latest ? text(latest.body) : "";
      const excerpt =
        latestBody.length > 120 ? `${latestBody.slice(0, 117)}…` : latestBody || null;
      const submittedAt = (claim.submitted_at as string | null) ?? null;

      const edi = ediByClaim.get(id) ?? { has999: false, has277ca: false, latestTrace: null };
      const lastStatus = statusByClaim.get(id);
      const eras = eraByClaim.get(id) ?? [];
      const followUpDue = (claim.hold_follow_up_date as string | null) ?? (claim.defer_until as string | null) ?? null;

      // Classification: pick the most pressing missing artifact
      let missing: NoResponseTab;
      let missingLabel: string;
      if (isExpired(followUpDue, today)) {
        missing = "past_follow_up";
        missingLabel = "Past follow-up date";
      } else if (!edi.has999) {
        missing = "no_999";
        missingLabel = "999 acknowledgement";
      } else if (!edi.has277ca) {
        missing = "no_277ca";
        missingLabel = "277CA response";
      } else if (!lastStatus) {
        missing = "no_payer_status";
        missingLabel = "Payer status (276/277)";
      } else if (eras.length === 0) {
        missing = "no_era";
        missingLabel = "ERA / 835 payment";
      } else {
        missing = "no_payer_status";
        missingLabel = "Updated payer status";
      }

      const appt = apptById.get(text(claim.appointment_id));
      const clinicianFromAppt = appt ? text(appt.provider_id) || null : null;
      const practiceLocationId = appt ? text(appt.location_id) || null : null;

      const lastKnownStatus = lastStatus
        ? `${text(lastStatus.status)}${lastStatus.status_code ? ` (${text(lastStatus.status_code)})` : ""}`
        : edi.has277ca
          ? "Accepted by clearinghouse (277CA)"
          : edi.has999
            ? "Accepted by clearinghouse (999)"
            : text(claim.claim_status) || "submitted";

      return {
        id,
        claim_number: text(claim.claim_number) || null,
        claim_status: text(claim.claim_status) || null,
        patient_id: text(claim.patient_id) || null,
        patient_name: patientName,
        payer_profile_id: text(claim.payer_profile_id) || null,
        payer_name: payer ? text(payer.payer_name) || null : null,
        payer_id_external: payer ? text(payer.office_ally_payer_id) || null : null,
        payer_notes: payer ? text(payer.notes) || null : null,
        payer_claims_phone: payer ? text(payer.claims_phone) || null : null,
        payer_claims_fax: payer
          ? text(payer.claims_fax) || text(payer.fax_number) || null
          : null,
        payer_provider_services_phone: payer
          ? text(payer.provider_services_phone) || null
          : null,
        service_date_from: dates.from,
        service_date_to: dates.to,
        submitted_at: submittedAt,
        days_outstanding: daysSince(submittedAt),
        total_charge: money(claim.total_charge),
        defer_until: (claim.defer_until as string | null) ?? null,
        deferred_reason: (claim.deferred_reason as string | null) ?? null,
        follow_up_due_date: followUpDue,
        assigned_to_user_id: text(claim.hold_assigned_to_user_id) || null,
        assigned_to_display_name: text(claim.hold_assigned_to_display_name) || null,
        priority: text(claim.hold_priority) || null,
        clinician_id: clinicianFromAppt,
        practice_location_id: practiceLocationId,
        note_count: claimNotes.length,
        latest_note_excerpt: excerpt,
        latest_note_at: latest ? text(latest.created_at) || null : null,
        last_known_status: lastKnownStatus,
        last_status_at: lastStatus
          ? text(lastStatus.received_at) || text(lastStatus.created_at) || null
          : null,
        missing_artifact: missing,
        expected_response_missing: missingLabel,
        clearinghouse_trace_number: edi.latestTrace,
      };
    });

    // Tab counts before filtering
    const tabCounts: Record<NoResponseTab, number> = {
      no_999: 0,
      no_277ca: 0,
      no_payer_status: 0,
      no_era: 0,
      past_follow_up: 0,
    };
    for (const r of rows) tabCounts[r.missing_artifact] += 1;

    // 4) Apply filters from query string
    const rawTab = searchParams.get("tab");
    const tab: NoResponseTab | null =
      rawTab && (TAB_IDS as string[]).includes(rawTab) ? (rawTab as NoResponseTab) : null;

    const filterClient = (searchParams.get("client") ?? "").toLowerCase().trim();
    const filterPayer = (searchParams.get("payer") ?? "").trim();
    const filterClinician = (searchParams.get("clinician") ?? "").trim();
    const filterPractice = (searchParams.get("practice") ?? "").trim();
    const filterAssigned = (searchParams.get("assignedBiller") ?? "").trim();
    const filterDosFrom = (searchParams.get("dosFrom") ?? "").trim();
    const filterDosTo = (searchParams.get("dosTo") ?? "").trim();
    const filterStatus = (searchParams.get("status") ?? "").trim();
    const filterMin = Number(searchParams.get("minAmount") ?? "");
    const filterMax = Number(searchParams.get("maxAmount") ?? "");
    const filterAging = (searchParams.get("agingBucket") ?? "").trim();
    const filterPriority = (searchParams.get("priority") ?? "").trim();
    const filterFollowUp = (searchParams.get("followUpDue") ?? "").trim();

    const inAgingBucket = (d: number | null) => {
      if (d == null) return false;
      switch (filterAging) {
        case "0-30": return d <= 30;
        case "31-60": return d > 30 && d <= 60;
        case "61-90": return d > 60 && d <= 90;
        case "91-120": return d > 90 && d <= 120;
        case "120+": return d > 120;
        default: return true;
      }
    };

    const inFollowUpBucket = (d: string | null) => {
      if (!d) return filterFollowUp !== "overdue" && filterFollowUp !== "today" && filterFollowUp !== "week";
      if (filterFollowUp === "overdue") return d < today;
      if (filterFollowUp === "today") return d === today;
      if (filterFollowUp === "week") {
        const wk = new Date();
        wk.setDate(wk.getDate() + 7);
        return d >= today && d <= wk.toISOString().slice(0, 10);
      }
      return true;
    };

    const filtered = rows.filter((r) => {
      if (tab && r.missing_artifact !== tab) return false;
      if (filterClient && !r.patient_name.toLowerCase().includes(filterClient)) return false;
      if (filterPayer && r.payer_profile_id !== filterPayer && r.payer_name !== filterPayer) return false;
      if (filterClinician && r.clinician_id !== filterClinician) return false;
      if (filterPractice && r.practice_location_id !== filterPractice) return false;
      if (filterAssigned) {
        if (filterAssigned === "__unassigned__") {
          if (r.assigned_to_user_id) return false;
        } else if (r.assigned_to_user_id !== filterAssigned) return false;
      }
      const dosFrom = r.service_date_from ?? r.service_date_to;
      if (filterDosFrom && (!dosFrom || dosFrom < filterDosFrom)) return false;
      if (filterDosTo && (!dosFrom || dosFrom > filterDosTo)) return false;
      if (filterStatus && r.claim_status !== filterStatus) return false;
      if (Number.isFinite(filterMin) && filterMin > 0 && r.total_charge < filterMin) return false;
      if (Number.isFinite(filterMax) && filterMax > 0 && r.total_charge > filterMax) return false;
      if (filterAging && !inAgingBucket(r.days_outstanding)) return false;
      if (filterPriority && r.priority !== filterPriority) return false;
      if (filterFollowUp && !inFollowUpBucket(r.follow_up_due_date)) return false;
      return true;
    });

    // 5) Practices / clinicians / assignees options for the filter rail
    const practiceIds = [
      ...new Set(rows.map((r) => r.practice_location_id).filter((v): v is string => !!v)),
    ];
    const clinicianIds = [
      ...new Set(rows.map((r) => r.clinician_id).filter((v): v is string => !!v)),
    ];
    const assigneeIds = [
      ...new Set(
        rows
          .map((r) => r.assigned_to_user_id)
          .filter((v): v is string => !!v),
      ),
    ];

    const [{ data: practiceRows }, { data: clinicianRows }] = await Promise.all([
      practiceIds.length
        ? (supabase as any)
            .from("practice_locations")
            .select("id, name")
            .in("id", practiceIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      clinicianIds.length
        ? (supabase as any)
            .from("staff_profiles")
            .select("id, first_name, last_name, email")
            .in("id", clinicianIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const practices = ((practiceRows ?? []) as DbRow[]).map((p) => ({
      id: text(p.id),
      name: text(p.name) || "Unnamed practice",
    }));
    const clinicians = ((clinicianRows ?? []) as DbRow[]).map((c) => ({
      id: text(c.id),
      displayName:
        [c.first_name, c.last_name].map(text).filter(Boolean).join(" ") ||
        text(c.email) ||
        "Unnamed clinician",
    }));
    const assignees = assigneeIds.map((id) => {
      const row = rows.find((r) => r.assigned_to_user_id === id);
      return { id, displayName: row?.assigned_to_display_name || "Biller" };
    });

    return NextResponse.json({
      success: true,
      organizationId,
      items: filtered,
      tabCounts,
      practices,
      clinicians,
      assignees,
    });
  } catch (error) {
    console.error("No Response (claim-readiness) API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load no-response worklist",
      },
      { status: 500 },
    );
  }
}
