import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { mapLegacyClaimInputToProfessionalClaim } from "@/lib/claims/createProfessionalClaimFromLegacyInput";
import { assertClaimSubmissionReady, gateResponse } from "@/lib/validation/claimSubmissionGate";
import {
  getCaseById,
  getDefaultCaseForClient,
  isPatientResponsibilityCaseType,
} from "@/lib/cases/clientCasesService";
import { findOrCreateRow } from "@/lib/db/findOrCreate";

function generateUuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ error: "Database connection not available" }, { status: 500 });

    const { encounterId } = await request.json();
    if (!encounterId) return NextResponse.json({ error: "encounterId is required" }, { status: 400 });

    const { data: encounter, error: encounterError } = await supabase
      .from("encounters")
      .select("*")
      .eq("id", encounterId)
      .single();

    if (encounterError || !encounter) return NextResponse.json({ error: "Encounter not found" }, { status: 404 });
    if (encounter.encounter_status !== "signed") {
      return NextResponse.json({ error: "Encounter must be signed before claim creation" }, { status: 422 });
    }

    // Resolve case (encounter.case_id wins; else client's default case).
    const organizationId = typeof encounter.organization_id === "string" ? encounter.organization_id : null;
    let resolvedCase = null as Awaited<ReturnType<typeof getCaseById>>;
    if (organizationId) {
      if (encounter.case_id) {
        resolvedCase = await getCaseById({ organizationId, caseId: String(encounter.case_id) });
      } else if (encounter.client_id) {
        resolvedCase = await getDefaultCaseForClient({
          organizationId,
          clientId: String(encounter.client_id),
        });
      }
    }

    // Self-pay / charity cases skip insurance claim creation entirely. The
    // charge capture row stays at status='patient_responsibility' and the
    // balance will be invoiced to the client by the existing balance flow.
    if (resolvedCase && isPatientResponsibilityCaseType(resolvedCase.caseType)) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: "patient_responsibility",
        caseId: resolvedCase.id,
        caseType: resolvedCase.caseType,
        message: `Encounter is routed to client responsibility under case "${resolvedCase.name}"; no insurance claim created.`,
      });
    }

    const gate = await assertClaimSubmissionReady(organizationId);
    const blocked = gateResponse(gate);
    if (blocked) return blocked;

    const now = new Date().toISOString();
    const claimNumber = `CLM-${Date.now()}`;

    const claimPayload = {
      id: generateUuid(),
      ...mapLegacyClaimInputToProfessionalClaim({
        organization_id: encounter.organization_id,
        client_id: encounter.client_id,
        encounter_id: encounterId,
        claim_number: claimNumber,
        claim_status: "ready_to_submit",
        total_charge_amount: 0,
      }),
      case_id: resolvedCase?.id ?? null,
      created_at: now,
      updated_at: now,
    };

    // Find-or-create with 23505 race protection (Task #184). Partial unique
    // index idx_professional_claims_unique_active_encounter at the DB
    // guarantees one live claim per signed encounter even under double-clicks.
    const claimResult = await findOrCreateRow<Record<string, unknown>>({
      label: "claim",
      findExisting: () =>
        supabase
          .from("professional_claims")
          .select("*")
          .eq("organization_id", encounter.organization_id)
          .eq("encounter_id", encounterId)
          .is("archived_at", null)
          .limit(1)
          .maybeSingle(),
      insertNew: () =>
        supabase.from("professional_claims").insert(claimPayload).select().single(),
    });

    if (!claimResult.ok) {
      return NextResponse.json({ success: false, error: claimResult.error }, { status: 422 });
    }
    const claim = claimResult.row as { id: string; [k: string]: unknown };

    if (!claimResult.created) {
      return NextResponse.json({ success: true, message: "Claim already exists", claim });
    }

    await supabase.from("workqueue_items").insert({
      id: generateUuid(),
      organization_id: encounter.organization_id,
      title: `Claim ${claimNumber} ready to submit`,
      work_type: "claim_submission",
      status: "open",
      priority: "high",
      source_object_type: "claim",
      source_object_id: claim.id,
      client_id: encounter.client_id,
      encounter_id: encounterId,
      professional_claim_id: claim.id,
      context_payload: { lifecycle_step: "claim_created" },
      created_at: now,
      updated_at: now,
    });

    return NextResponse.json({ success: true, claim });
  } catch (error) {
    console.error("Create claim error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create claim" },
      { status: 500 },
    );
  }
}
