/**
 * GET /api/billing/payments/dashboard?organizationId=…&payerProfileId=…&…
 *
 * Master Payment Posting dashboard query. Returns unified rows + filter-aware
 * totals. Read endpoint — role-guarded but only enforces tenant isolation
 * (any authenticated staff in the same org may view the dashboard).
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireAuthenticatedPaymentPoster } from "@/lib/payments/postingEngine";
import {
  queryPaymentsDashboard,
  type DashboardFilters,
  type PaymentSource,
} from "@/lib/payments/dashboardQuery";

export const runtime = "nodejs";

function parseList(v: string | null): string[] | null {
  if (!v) return null;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parsePaymentSources(v: string | null): PaymentSource[] | null {
  const list = parseList(v);
  if (!list) return null;
  const allowed: PaymentSource[] = ["era", "manual_insurance", "client"];
  return list.filter((s): s is PaymentSource =>
    (allowed as string[]).includes(s),
  );
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const organizationId = searchParams.get("organizationId");
  if (!organizationId) {
    return NextResponse.json(
      { error: "organizationId is required" },
      { status: 400 },
    );
  }
  // Tenant + role binding. The dashboard reads payment data — every caller
  // must be an authenticated staff member of the requested organization.
  try {
    await requireAuthenticatedPaymentPoster(organizationId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Forbidden" },
      { status: 403 },
    );
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const pt = searchParams.get("paymentType");
  const filters: DashboardFilters = {
    organizationId,
    payerProfileId: searchParams.get("payerProfileId"),
    providerNpi: searchParams.get("providerNpi"),
    clientId: searchParams.get("clientId"),
    paymentSource: parsePaymentSources(searchParams.get("paymentSource")),
    paymentType: pt === "insurance" || pt === "client" ? pt : null,
    postingStatus: parseList(searchParams.get("postingStatus")),
    depositDateFrom: searchParams.get("depositDateFrom"),
    depositDateTo: searchParams.get("depositDateTo"),
    paymentDateFrom: searchParams.get("paymentDateFrom"),
    paymentDateTo: searchParams.get("paymentDateTo"),
    eftCheckNumber: searchParams.get("eftCheckNumber"),
    eraImportDateFrom: searchParams.get("eraImportDateFrom"),
    eraImportDateTo: searchParams.get("eraImportDateTo"),
    limit: searchParams.get("limit") ? Number(searchParams.get("limit")) : null,
    offset: searchParams.get("offset") ? Number(searchParams.get("offset")) : null,
  };

  try {
    const result = await queryPaymentsDashboard(supabase, filters);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Dashboard query failed",
      },
      { status: 500 },
    );
  }
}
