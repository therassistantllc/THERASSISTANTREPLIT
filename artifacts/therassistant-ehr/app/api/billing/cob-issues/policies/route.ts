/**
 * GET /api/billing/cob-issues/policies
 *
 * Lists insurance_policies for the given client. When `history=true`,
 * archived/inactive rows are included so the COB detail panel can
 * show a full timeline.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();

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

    const clientId = (searchParams.get("clientId") ?? "").trim();
    const includeHistory = (searchParams.get("history") ?? "") === "true";
    if (!clientId) {
      return NextResponse.json(
        { success: false, error: "Missing clientId" },
        { status: 400 },
      );
    }

    let query = (supabase as any)
      .from("insurance_policies")
      .select(
        "id, client_id, payer_id, priority, plan_name, policy_number, effective_date, termination_date, active_flag, archived_at",
      )
      .eq("organization_id", guard.organizationId)
      .eq("client_id", clientId)
      .order("effective_date", { ascending: false });
    if (!includeHistory) query = query.is("archived_at", null);

    const { data: policyRows, error: polErr } = await query;
    if (polErr) throw polErr;
    const policies = (policyRows ?? []) as DbRow[];

    const payerIds = [
      ...new Set(policies.map((p) => text(p.payer_id)).filter(Boolean)),
    ];
    let payerById = new Map<string, DbRow>();
    if (payerIds.length > 0) {
      const { data: payers } = await (supabase as any)
        .from("payer_profiles")
        .select("id, payer_name, payer_type")
        .in("id", payerIds);
      payerById = new Map(((payers ?? []) as DbRow[]).map((p) => [text(p.id), p]));
    }

    return NextResponse.json({
      success: true,
      policies: policies.map((p) => {
        const payer = payerById.get(text(p.payer_id));
        return {
          id: text(p.id),
          priority: text(p.priority) || "primary",
          payer_id: text(p.payer_id) || null,
          payer_name: payer ? text(payer.payer_name) || null : null,
          payer_type: payer ? text(payer.payer_type) || null : null,
          policy_number: text(p.policy_number) || null,
          effective_date: text(p.effective_date) || null,
          termination_date: text(p.termination_date) || null,
          active: p.active_flag !== false && !p.archived_at,
        };
      }),
    });
  } catch (error) {
    console.error("COB policies API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load policies",
      },
      { status: 500 },
    );
  }
}
