import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, any>;

function text(value: unknown) {
  return String(value ?? "").trim();
}
function money(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function extractDenialReason(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, any>;
  return text(
    p.denial_reason ||
      p.reason ||
      p.status_message ||
      p.status_description ||
      p.message ||
      "",
  );
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const today = new Date().toISOString().slice(0, 10);

    const { data: claims, error: claimsErr } = await (supabase as any)
      .from("professional_claims")
      .select(
        "id, claim_number, patient_id, payer_profile_id, total_charge, patient_responsibility_amount, payer_responsibility_amount, write_off_amount, defer_until, deferred_reason, updated_at",
      )
      .eq("organization_id", organizationId)
      .eq("claim_status", "denied")
      .is("archived_at", null)
      .or(`defer_until.is.null,defer_until.lte.${today}`)
      .order("updated_at", { ascending: false })
      .limit(200);

    if (claimsErr) throw claimsErr;

    const claimRows: DbRow[] = (claims as DbRow[]) ?? [];
    const claimIds = claimRows.map((c) => text(c.id)).filter(Boolean);
    const patientIds = [...new Set(claimRows.map((c) => text(c.patient_id)).filter(Boolean))];
    const payerProfileIds = [...new Set(claimRows.map((c) => text(c.payer_profile_id)).filter(Boolean))];

    const [
      { data: clients },
      { data: payerProfiles },
      { data: serviceLines },
      { data: parties },
      { data: statusEvents },
      { data: noteCounts },
    ] = await Promise.all([
      patientIds.length
        ? (supabase as any).from("clients").select("id, first_name, last_name").in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerProfileIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name, office_ally_payer_id, fax_number")
            .in("id", payerProfileIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claim_service_lines")
            .select("claim_id, service_date_from, service_date_to, line_number")
            .in("claim_id", claimIds)
            .order("line_number", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_parties_snapshot")
            .select("claim_id, subscriber_member_id, patient_first_name, patient_last_name, subscriber_first_name, subscriber_last_name")
            .in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_status_events")
            .select("claim_id, status, status_message, raw_payload, created_at")
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_notes")
            .select("claim_id")
            .in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const payerOfficeIds = [
      ...new Set(((payerProfiles as DbRow[]) ?? []).map((p) => text(p.office_ally_payer_id)).filter(Boolean)),
    ];

    const { data: insurancePayers } = payerOfficeIds.length
      ? await (supabase as any)
          .from("insurance_payers")
          .select("id, payer_id, payer_name, fax_number")
          .eq("organization_id", organizationId)
          .in("payer_id", payerOfficeIds)
      : { data: [] as DbRow[] };

    const patientById = new Map<string, DbRow>(((clients as DbRow[]) ?? []).map((p) => [text(p.id), p]));
    const payerProfileById = new Map<string, DbRow>(
      ((payerProfiles as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const insurancePayerByExternalId = new Map<string, DbRow>(
      ((insurancePayers as DbRow[]) ?? []).map((p) => [text(p.payer_id), p]),
    );
    const partiesByClaim = new Map<string, DbRow>(
      ((parties as DbRow[]) ?? []).map((p) => [text(p.claim_id), p]),
    );

    const serviceLinesByClaim = new Map<string, DbRow[]>();
    for (const sl of ((serviceLines as DbRow[]) ?? [])) {
      const cid = text(sl.claim_id);
      if (!serviceLinesByClaim.has(cid)) serviceLinesByClaim.set(cid, []);
      serviceLinesByClaim.get(cid)!.push(sl);
    }

    const latestEventByClaim = new Map<string, DbRow>();
    for (const ev of ((statusEvents as DbRow[]) ?? [])) {
      const cid = text(ev.claim_id);
      if (!latestEventByClaim.has(cid)) latestEventByClaim.set(cid, ev);
    }

    const noteCountByClaim = new Map<string, number>();
    for (const n of ((noteCounts as DbRow[]) ?? [])) {
      const cid = text(n.claim_id);
      noteCountByClaim.set(cid, (noteCountByClaim.get(cid) ?? 0) + 1);
    }

    const rows = claimRows.map((claim) => {
      const claimId = text(claim.id);
      const client = patientById.get(text(claim.patient_id));
      const payerProfile = payerProfileById.get(text(claim.payer_profile_id));
      const insurancePayer = payerProfile
        ? insurancePayerByExternalId.get(text(payerProfile.office_ally_payer_id))
        : undefined;
      const lines = serviceLinesByClaim.get(claimId) ?? [];
      const serviceDates = lines
        .map((l) => text(l.service_date_from))
        .filter(Boolean);
      const dosFrom = serviceDates[0] ?? null;
      const dosTo =
        lines.length > 0
          ? text(lines[lines.length - 1].service_date_to) || text(lines[lines.length - 1].service_date_from) || null
          : null;
      const party = partiesByClaim.get(claimId);
      const event = latestEventByClaim.get(claimId);
      const denialReason = event
        ? extractDenialReason(event.raw_payload) || text(event.status_message) || text(event.status)
        : "";
      const totalCharge = money(claim.total_charge);
      const writeOff = money(claim.write_off_amount);
      // Best-effort outstanding balance — we don't track paid_amount on
      // professional_claims, so default to total_charge minus any write-off.
      const outstanding = Math.max(0, Math.round((totalCharge - writeOff) * 100) / 100);

      const patientName = client
        ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ")
        : party
          ? [party.patient_first_name || party.subscriber_first_name, party.patient_last_name || party.subscriber_last_name]
              .map(text)
              .filter(Boolean)
              .join(" ")
          : "Unknown client";

      const payerName =
        text(payerProfile?.payer_name) || text(insurancePayer?.payer_name) || "";

      return {
        id: claimId,
        claimNumber: text(claim.claim_number),
        patientId: text(claim.patient_id),
        patientName,
        memberId: text(party?.subscriber_member_id),
        payerProfileId: text(claim.payer_profile_id),
        payerId: insurancePayer ? text(insurancePayer.id) : null,
        payerName,
        payerFaxNumber: text(payerProfile?.fax_number) || text(insurancePayer?.fax_number) || null,
        serviceDateFrom: dosFrom,
        serviceDateTo: dosTo,
        totalChargeAmount: totalCharge,
        outstandingBalance: outstanding,
        denialReason,
        noteCount: noteCountByClaim.get(claimId) ?? 0,
        deferUntil: claim.defer_until ?? null,
        deferredReason: text(claim.deferred_reason) || null,
        updatedAt: claim.updated_at ?? null,
      };
    });

    const { data: templates } = await (supabase as any)
      .from("claim_appeal_templates")
      .select("id, name, body, is_system, organization_id")
      .is("archived_at", null)
      .or(`is_system.eq.true,organization_id.eq.${organizationId}`)
      .order("is_system", { ascending: false })
      .order("name", { ascending: true });

    return NextResponse.json({
      success: true,
      organizationId,
      rows,
      templates: ((templates as DbRow[]) ?? []).map((t) => ({
        id: text(t.id),
        name: text(t.name),
        body: text(t.body),
        isSystem: Boolean(t.is_system),
      })),
    });
  } catch (error) {
    console.error("Denials API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Denials API failed" },
      { status: 500 },
    );
  }
}
