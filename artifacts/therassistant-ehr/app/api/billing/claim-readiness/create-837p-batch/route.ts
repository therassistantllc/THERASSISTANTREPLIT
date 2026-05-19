import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type DbRow = Record<string, unknown>;

function money(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

function batchNumber() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `837P-${stamp}`;
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const body = await request.json();
    const organizationId = body.organizationId ? String(body.organizationId) : "";

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    const { data: claims, error: claimsError } = await supabase
      .from("professional_claims")
      .select("id, total_charge_amount")
      .eq("organization_id", organizationId)
      .eq("claim_status", "ready_for_batch")
      .is("archived_at", null)
      .order("created_at", { ascending: true })
      .limit(100);

    if (claimsError) throw claimsError;

    const readyClaims = (claims ?? []) as DbRow[];
    if (readyClaims.length === 0) {
      return NextResponse.json({ success: false, error: "No ready_for_batch claims found" }, { status: 422 });
    }

    const totalChargeAmount = readyClaims.reduce((sum, claim) => sum + money(claim.total_charge_amount), 0);
    const now = new Date().toISOString();

    const { data: batch, error: batchError } = await supabase
      .from("claim_837p_batches")
      .insert({
        organization_id: organizationId,
        batch_number: batchNumber(),
        batch_status: "ready_to_generate",
        claim_count: readyClaims.length,
        total_charge_amount: totalChargeAmount,
        created_at: now,
        updated_at: now,
      })
      .select("id, batch_number")
      .single();

    if (batchError || !batch) {
      return NextResponse.json({ success: false, error: batchError?.message ?? "Failed to create 837P batch" }, { status: 422 });
    }

    const batchClaimRows = readyClaims.map((claim) => ({
      organization_id: organizationId,
      batch_id: batch.id,
      professional_claim_id: claim.id,
      created_at: now,
    }));

    const { error: batchClaimsError } = await supabase.from("claim_837p_batch_claims").insert(batchClaimRows);
    if (batchClaimsError) throw batchClaimsError;

    const claimIds = readyClaims.map((claim) => String(claim.id));
    const { error: claimUpdateError } = await supabase
      .from("professional_claims")
      .update({ claim_status: "batched", updated_at: now })
      .eq("organization_id", organizationId)
      .in("id", claimIds);

    if (claimUpdateError) throw claimUpdateError;

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      batchNumber: batch.batch_number,
      claimCount: readyClaims.length,
      totalChargeAmount,
    });
  } catch (error) {
    console.error("Create 837P batch API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Create 837P batch failed" },
      { status: 500 },
    );
  }
}
