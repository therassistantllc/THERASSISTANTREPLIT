/**
 * GET /api/billing/cob-issues/eligibility
 *
 * Latest 270/271 eligibility checks for the given client. The COB
 * detail panel uses this to surface any other-payer hints that
 * showed up on a recent 271 response.
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
    const limit = Math.min(
      20,
      Math.max(1, Number(searchParams.get("limit") ?? "5") || 5),
    );
    if (!clientId) {
      return NextResponse.json(
        { success: false, error: "Missing clientId" },
        { status: 400 },
      );
    }

    const { data: rows, error } = await (supabase as any)
      .from("eligibility_checks")
      .select(
        "id, created_at, payer_name, status, plan_name, raw_benefits",
      )
      .eq("organization_id", guard.organizationId)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    const checks = ((rows ?? []) as DbRow[]).map((r) => {
      const raw = (r.raw_benefits as Record<string, unknown> | null) ?? {};
      // Best-effort surface of any "other payer" hints in the 271
      // benefits payload — different parsers stash this differently
      // so we try a few common shapes.
      const otherPayer =
        text((raw as Record<string, unknown>).other_payer_name) ||
        text((raw as Record<string, unknown>).cob_other_payer) ||
        text(
          (
            ((raw as Record<string, unknown>).cob as
              | Record<string, unknown>
              | undefined) ?? {}
          ).other_payer_name,
        ) ||
        null;
      const status = text(r.status);
      return {
        id: text(r.id),
        created_at: text(r.created_at),
        payer_name: text(r.payer_name) || null,
        plan_name: text(r.plan_name) || null,
        coverage_active:
          status === "active" ? true : status === "inactive" ? false : null,
        other_payer_text: otherPayer,
      };
    });

    return NextResponse.json({ success: true, checks });
  } catch (error) {
    console.error("COB eligibility API error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load eligibility",
      },
      { status: 500 },
    );
  }
}
