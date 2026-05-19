import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { mapLegacyClaimInputToProfessionalClaim } from "@/lib/claims/createProfessionalClaimFromLegacyInput";

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

    const { data: existingClaim } = await supabase
      .from("professional_claims")
      .select("*")
      .eq("encounter_id", encounterId)
      .maybeSingle();

    if (existingClaim) {
      return NextResponse.json({ success: true, message: "Claim already exists", claim: existingClaim });
    }

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
      created_at: now,
      updated_at: now,
    };

    const { data: claim, error: claimError } = await supabase
      .from("professional_claims")
      .insert(claimPayload)
      .select()
      .single();

    if (claimError) throw claimError;

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
