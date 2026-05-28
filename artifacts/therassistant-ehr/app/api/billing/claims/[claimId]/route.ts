/**
 * /api/billing/claims/[claimId]
 *
 * GET — return basic header info for a single professional claim so the
 * claim detail page can render claim number, status, payer, totals, and
 * the linked client/encounter without re-implementing the joins on the
 * client. Scoped to the caller's organization.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function GET(
  request: Request,
  ctx: { params: Promise<{ claimId: string }> },
) {
  try {
    const { claimId } = await ctx.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const { data: claim, error } = await supabase
      .from("professional_claims")
      .select(
        "id, claim_number, claim_status, total_charge, patient_responsibility_amount, diagnosis_codes, created_at, submitted_at, patient_id, encounter_id, appointment_id, payer_profile_id, archived_at",
      )
      .eq("organization_id", organizationId)
      .eq("id", claimId)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 },
      );
    }
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const row = claim as Row;
    const patientId = str(row["patient_id"]);
    const payerProfileId = str(row["payer_profile_id"]);

    let patientName: string | null = null;
    if (patientId) {
      const { data: client } = await supabase
        .from("clients")
        .select("first_name, last_name")
        .eq("id", patientId)
        .maybeSingle();
      const c = (client ?? {}) as Row;
      const composed = [c["first_name"], c["last_name"]]
        .map((v) => str(v))
        .filter(Boolean)
        .join(" ");
      patientName = composed || null;
    }

    let payerName: string | null = null;
    if (payerProfileId) {
      const { data: profile } = await supabase
        .from("payer_profiles")
        .select("payer_name")
        .eq("id", payerProfileId)
        .maybeSingle();
      payerName = str((profile as Row | null)?.["payer_name"]);
    }

    return NextResponse.json({
      success: true,
      claim: {
        id: str(row["id"]),
        claim_number: str(row["claim_number"]),
        claim_status: str(row["claim_status"]),
        total_charge: num(row["total_charge"]),
        patient_responsibility_amount: num(
          row["patient_responsibility_amount"],
        ),
        diagnosis_codes: Array.isArray(row["diagnosis_codes"])
          ? (row["diagnosis_codes"] as unknown[]).map((v) => String(v))
          : [],
        created_at: str(row["created_at"]),
        submitted_at: str(row["submitted_at"]),
        patient_id: patientId,
        patient_name: patientName,
        encounter_id: str(row["encounter_id"]),
        appointment_id: str(row["appointment_id"]),
        payer_profile_id: payerProfileId,
        payer_name: payerName,
        archived_at: str(row["archived_at"]),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
