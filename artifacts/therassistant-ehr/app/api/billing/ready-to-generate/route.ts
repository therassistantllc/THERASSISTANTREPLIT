/**
 * GET /api/billing/ready-to-generate
 *
 * Powers the "Ready to Generate" billing workqueue
 * (/billing/ready-to-generate). Returns every professional claim that has
 * cleared validation and is waiting to be assembled into an 837P batch.
 *
 * Criteria:
 *   - claim_status = 'ready_for_batch'
 *   - archived_at IS NULL
 *   - held_at IS NULL OR `?includeHeld=1` set (so the "On Hold" filter has
 *     something to show)
 *   - ordered by created_at ASC (oldest first)
 *
 * Returns enough fields to render the spec'd columns:
 *   Client, DOS, Clinician, Payer, CPT/HCPCS, Diagnosis, Modifiers,
 *   Charge amount, Place of service, Rendering provider, Billing provider,
 *   Ready status.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const money = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

function ageDays(value: string | null): number | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
}

export interface ReadyToGenerateItem {
  id: string;
  claim_number: string | null;
  claim_status: string;
  client_id: string | null;
  client_name: string;
  service_date: string | null;
  clinician_name: string | null;
  payer_profile_id: string | null;
  payer_name: string | null;
  payer_type: string | null;
  payer_id_value: string | null;
  cpt_codes: string[];
  diagnosis_codes: string[];
  modifiers: string[];
  charge_amount: number;
  place_of_service: string | null;
  rendering_provider_npi: string | null;
  billing_provider_name: string | null;
  billing_provider_npi: string | null;
  ready_status: "ready" | "on_hold" | "needs_batch_assignment";
  held_at: string | null;
  hold_reason: string | null;
  age_days: number | null;
  encounter_id: string | null;
  batch_id: string | null;
  practice_id: string | null;
  practice_name: string | null;
  assigned_biller_user_id: string | null;
  assigned_biller_name: string | null;
  carc_codes: string[];
  rarc_codes: string[];
  follow_up_due_at: string | null;
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

    const { data: claimRows, error: claimsError } = await (supabase as any)
      .from("professional_claims")
      .select(
        "id, claim_number, claim_status, patient_id, payer_profile_id, total_charge, place_of_service, diagnosis_codes, created_at, encounter_id, held_at, hold_reason",
      )
      .eq("organization_id", organizationId)
      .eq("claim_status", "ready_for_batch")
      .is("archived_at", null)
      .order("created_at", { ascending: true });

    if (claimsError) throw claimsError;

    const claims = (claimRows ?? []) as DbRow[];
    const claimIds = claims.map((c) => text(c.id)).filter(Boolean);
    const patientIds = [...new Set(claims.map((c) => text(c.patient_id)).filter(Boolean))];
    const payerProfileIds = [
      ...new Set(claims.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];
    const encounterIds = [
      ...new Set(claims.map((c) => text(c.encounter_id)).filter(Boolean)),
    ];

    const [
      { data: clients },
      { data: payerProfiles },
      { data: serviceLines },
      { data: snapshots },
      { data: encounters },
      { data: batchClaims },
      { data: workqueueItems },
    ] = await Promise.all([
      patientIds.length
        ? supabase.from("clients").select("id, first_name, last_name").in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerProfileIds.length
        ? supabase
            .from("payer_profiles")
            .select("id, payer_name, payer_type, payer_id")
            .in("id", payerProfileIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? supabase
            .from("professional_claim_service_lines")
            .select(
              "claim_id, line_number, procedure_code, service_date_from, service_date_to, modifiers, place_of_service, rendering_provider_npi, charge_amount, units",
            )
            .in("claim_id", claimIds)
            .order("line_number", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? supabase
            .from("claim_parties_snapshot")
            .select("claim_id, billing_provider_name, billing_provider_npi")
            .in("claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      encounterIds.length
        ? (supabase as any)
            .from("encounters")
            .select("id, provider_id, providers:providers(id, first_name, last_name)")
            .in("id", encounterIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? supabase
            .from("claim_837p_batch_claims")
            .select("professional_claim_id, batch_id")
            .in("professional_claim_id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("workqueue_items")
            .select("professional_claim_id, assigned_to_user_id, defer_until")
            .eq("organization_id", organizationId)
            .in("professional_claim_id", claimIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const billerUserIds = [
      ...new Set(
        ((workqueueItems ?? []) as DbRow[])
          .map((w) => text(w.assigned_to_user_id))
          .filter(Boolean),
      ),
    ];
    const { data: billerUsers } = billerUserIds.length
      ? await (supabase as any)
          .from("users")
          .select("id, full_name, email")
          .in("id", billerUserIds)
      : { data: [] as DbRow[] };
    const billerById = new Map<string, DbRow>(
      ((billerUsers ?? []) as DbRow[]).map((u) => [text(u.id), u]),
    );
    const wqByClaim = new Map<string, DbRow>();
    for (const w of (workqueueItems ?? []) as DbRow[]) {
      const k = text(w.professional_claim_id);
      if (k && !wqByClaim.has(k)) wqByClaim.set(k, w);
    }

    // There is no dedicated `practices` table in the current schema. For
    // 837P routing the "practice" is effectively the billing provider on
    // the claim_parties_snapshot, so we expose billing_provider_npi /
    // billing_provider_name as the practice identity. That lets the
    // Practice filter populate from real data and partition the worklist
    // by submitting entity.

    const patientById = new Map<string, DbRow>(
      ((clients ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payerProfiles ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const snapshotByClaim = new Map<string, DbRow>(
      ((snapshots ?? []) as DbRow[]).map((s) => [text(s.claim_id), s]),
    );
    const linesByClaim = new Map<string, DbRow[]>();
    for (const line of (serviceLines ?? []) as DbRow[]) {
      const key = text(line.claim_id);
      if (!key) continue;
      const arr = linesByClaim.get(key) ?? [];
      arr.push(line);
      linesByClaim.set(key, arr);
    }
    const encounterById = new Map<string, DbRow>(
      ((encounters ?? []) as DbRow[]).map((e) => [text(e.id), e]),
    );
    const batchByClaim = new Map<string, string>();
    for (const b of (batchClaims ?? []) as DbRow[]) {
      const k = text(b.professional_claim_id);
      if (k && !batchByClaim.has(k)) batchByClaim.set(k, text(b.batch_id));
    }

    const items: ReadyToGenerateItem[] = claims.map((claim) => {
      const id = text(claim.id);
      const client = patientById.get(text(claim.patient_id));
      const clientName = client
        ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") ||
          "Unknown client"
        : "Unknown client";
      const payer = payerById.get(text(claim.payer_profile_id));
      const lines = linesByClaim.get(id) ?? [];
      const firstLine = lines[0];
      const snapshot = snapshotByClaim.get(id);
      const encounter = encounterById.get(text(claim.encounter_id));
      const provider = (encounter as any)?.providers as DbRow | null | undefined;
      const clinicianName = provider
        ? [provider.first_name, provider.last_name].map(text).filter(Boolean).join(" ")
        : null;
      const heldAt = (claim.held_at as string | null) ?? null;
      const batchId = batchByClaim.get(id) ?? null;
      const wq = wqByClaim.get(id);
      const billerId = wq ? text(wq.assigned_to_user_id) || null : null;
      const biller = billerId ? billerById.get(billerId) : null;
      const billerName = biller
        ? text(biller.full_name) || text(biller.email) || null
        : null;
      const practiceId = snapshot ? text(snapshot.billing_provider_npi) || null : null;
      const practiceName = snapshot ? text(snapshot.billing_provider_name) || null : null;

      const cptCodes = [...new Set(lines.map((l) => text(l.procedure_code)).filter(Boolean))];
      const modifiers = [
        ...new Set(
          lines.flatMap((l) =>
            Array.isArray(l.modifiers) ? l.modifiers.map((m) => text(m)).filter(Boolean) : [],
          ),
        ),
      ];
      const diagnosisCodes = Array.isArray(claim.diagnosis_codes)
        ? (claim.diagnosis_codes as unknown[]).map((d) => text(d)).filter(Boolean)
        : [];

      return {
        id,
        claim_number: text(claim.claim_number) || null,
        claim_status: text(claim.claim_status),
        client_id: text(claim.patient_id) || null,
        client_name: clientName,
        service_date: firstLine ? text(firstLine.service_date_from) || null : null,
        clinician_name: clinicianName && clinicianName.length > 0 ? clinicianName : null,
        payer_profile_id: text(claim.payer_profile_id) || null,
        payer_name: payer ? text(payer.payer_name) || null : null,
        payer_type: payer ? text(payer.payer_type) || null : null,
        payer_id_value: payer ? text(payer.payer_id) || null : null,
        cpt_codes: cptCodes,
        diagnosis_codes: diagnosisCodes,
        modifiers,
        charge_amount: money(claim.total_charge),
        place_of_service:
          (firstLine ? text(firstLine.place_of_service) : "") ||
          text(claim.place_of_service) ||
          null,
        rendering_provider_npi: firstLine ? text(firstLine.rendering_provider_npi) || null : null,
        billing_provider_name: snapshot ? text(snapshot.billing_provider_name) || null : null,
        billing_provider_npi: snapshot ? text(snapshot.billing_provider_npi) || null : null,
        ready_status: heldAt ? "on_hold" : batchId ? "needs_batch_assignment" : "ready",
        held_at: heldAt,
        hold_reason: (claim.hold_reason as string | null) ?? null,
        age_days: ageDays(text(claim.created_at) || null),
        encounter_id: text(claim.encounter_id) || null,
        batch_id: batchId,
        practice_id: practiceId,
        practice_name: practiceName,
        assigned_biller_user_id: billerId,
        assigned_biller_name: billerName,
        // CARC/RARC are remit-side codes and don't exist on pre-submission
        // claims; expose empty arrays so the filter UI is honest about it.
        carc_codes: [],
        rarc_codes: [],
        follow_up_due_at: wq ? (text(wq.defer_until) || null) : null,
      };
    });

    return NextResponse.json({ success: true, organizationId, items });
  } catch (error) {
    console.error("Ready-to-Generate API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load Ready-to-Generate worklist",
      },
      { status: 500 },
    );
  }
}
