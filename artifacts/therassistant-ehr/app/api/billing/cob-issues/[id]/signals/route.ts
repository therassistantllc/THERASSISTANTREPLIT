/**
 * GET /api/billing/cob-issues/:id/signals
 *
 * Returns the raw COB evidence backing a single professional claim's
 * appearance on the COB queue:
 *
 *   - signals[]               — every `claim_cob_signals` row for the
 *                               claim (CO-22, MOA other-payer-paid,
 *                               271-other-payer). Carries signal_type,
 *                               other-payer name/id, paid amount, and
 *                               the source CAS/MOA segment string.
 *   - eligibility.other_payers[] — additional payers reported on the
 *                               most-recent `eligibility_checks` row for
 *                               this claim's client (271 EB*R subloop
 *                               + headline `other_payer_*` columns).
 *
 * Used by the "Coordination of Benefits" panel on the COB Issues
 * claim detail drawer so billers can see *why* a claim was flagged,
 * not just the tab it landed in.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const { id: claimId } = await context.params;
    if (!claimId) {
      return NextResponse.json(
        { success: false, error: "Missing claim id" },
        { status: 400 },
      );
    }

    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    // Resolve the client_id from the claim so we can pull eligibility
    // other-payer evidence for the same client.
    const { data: claim, error: claimErr } = await (supabase as any)
      .from("professional_claims")
      .select("id, organization_id, patient_id")
      .eq("id", claimId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const clientId = text((claim as DbRow).patient_id) || null;

    const [{ data: signalRows, error: signalErr }, eligibilityRes] =
      await Promise.all([
        (supabase as any)
          .from("claim_cob_signals")
          .select(
            "id, signal_type, other_payer_name, other_payer_id, other_payer_paid_amount, source_segment, era_claim_payment_id, created_at",
          )
          .eq("organization_id", organizationId)
          .eq("professional_claim_id", claimId)
          .order("created_at", { ascending: false }),
        clientId
          ? (supabase as any)
              .from("eligibility_checks")
              .select(
                "id, checked_at, payer_name, other_payer_name, other_payer_id, other_payer_effective_date, other_payer_termination_date, other_payers",
              )
              .eq("organization_id", organizationId)
              .eq("client_id", clientId)
              .not("other_payers", "is", null)
              .order("checked_at", { ascending: false })
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

    if (signalErr) throw signalErr;

    const signals = ((signalRows ?? []) as DbRow[]).map((s) => {
      const paid = s.other_payer_paid_amount;
      const paidNum =
        paid == null
          ? null
          : Number.isFinite(Number(paid))
            ? Number(paid)
            : null;
      return {
        id: text(s.id),
        signal_type: text(s.signal_type),
        other_payer_name: text(s.other_payer_name) || null,
        other_payer_id: text(s.other_payer_id) || null,
        other_payer_paid_amount: paidNum,
        source_segment: text(s.source_segment) || null,
        era_claim_payment_id: text(s.era_claim_payment_id) || null,
        created_at: text(s.created_at) || null,
      };
    });

    type OtherPayer = {
      name: string | null;
      payer_id: string | null;
      effective_date: string | null;
      termination_date: string | null;
    };
    let eligibility: {
      check_id: string | null;
      checked_at: string | null;
      payer_name: string | null;
      other_payers: OtherPayer[];
    } | null = null;

    const eligRow = (eligibilityRes as { data: DbRow | null } | undefined)
      ?.data;
    if (eligRow) {
      const list: OtherPayer[] = [];
      const headlineName = text(eligRow.other_payer_name) || null;
      const headlineId = text(eligRow.other_payer_id) || null;
      const headlineEff = text(eligRow.other_payer_effective_date) || null;
      const headlineTerm = text(eligRow.other_payer_termination_date) || null;
      if (headlineName || headlineId) {
        list.push({
          name: headlineName,
          payer_id: headlineId,
          effective_date: headlineEff,
          termination_date: headlineTerm,
        });
      }
      const arr = Array.isArray(eligRow.other_payers)
        ? (eligRow.other_payers as Array<Record<string, unknown>>)
        : [];
      for (const entry of arr) {
        const name = text(entry.name) || null;
        const payerId = text(entry.payerId ?? entry.payer_id) || null;
        if (!name && !payerId) continue;
        if (
          list.some(
            (e) =>
              (e.name && e.name === name) ||
              (e.payer_id && e.payer_id === payerId),
          )
        ) {
          continue;
        }
        list.push({
          name,
          payer_id: payerId,
          effective_date:
            text(entry.effectiveDate ?? entry.effective_date) || null,
          termination_date:
            text(entry.terminationDate ?? entry.termination_date) || null,
        });
      }
      eligibility = {
        check_id: text(eligRow.id) || null,
        checked_at: text(eligRow.checked_at) || null,
        payer_name: text(eligRow.payer_name) || null,
        other_payers: list,
      };
    }

    return NextResponse.json({
      success: true,
      claimId,
      clientId,
      signals,
      eligibility,
    });
  } catch (error) {
    console.error("COB signals API error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load COB signals",
      },
      { status: 500 },
    );
  }
}
