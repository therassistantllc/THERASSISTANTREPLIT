/**
 * GET /api/billing/payments/export?organizationId=…&<dashboardFilters>
 *
 * Streams a CSV of the dashboard rows matching the current filter set.
 * Identical filter parsing to /api/billing/payments/dashboard.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { writePaymentAuditLog } from "@/lib/payments/postingEngine/audit";
import { requireAuthenticatedPaymentPoster } from "@/lib/payments/postingEngine";
import {
  queryPaymentsDashboard,
  type DashboardFilters,
  type PaymentSource,
} from "@/lib/payments/dashboardQuery";

export const runtime = "nodejs";

function parseList(v: string | null): string[] | null {
  if (!v) return null;
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parsePaymentSources(v: string | null): PaymentSource[] | null {
  const list = parseList(v);
  if (!list) return null;
  const allowed: PaymentSource[] = ["era", "manual_insurance", "client"];
  return list.filter((s): s is PaymentSource => (allowed as string[]).includes(s));
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const organizationId = searchParams.get("organizationId");
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  let actor;
  try {
    actor = await requireAuthenticatedPaymentPoster(organizationId);
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
    limit: 500,
  };

  // Page through the dashboard in chunks of 500 so export covers the FULL
  // filtered population (no silent 500-row truncation). Cap absolute volume
  // at MAX_EXPORT_ROWS to keep memory bounded; the dashboard itself never
  // surfaces more than this in one CSV. The audit row records the cap hit.
  const MAX_EXPORT_ROWS = 25000;
  const PAGE = 500;
  let allRows: Awaited<ReturnType<typeof queryPaymentsDashboard>>["rows"] = [];
  let totals: Awaited<ReturnType<typeof queryPaymentsDashboard>>["totals"] | null = null;
  let pageOffset = 0;
  let capHit = false;
  while (allRows.length < MAX_EXPORT_ROWS) {
    const page = await queryPaymentsDashboard(supabase, {
      ...filters,
      limit: PAGE,
      offset: pageOffset,
    });
    if (!totals) totals = page.totals;
    if (page.rows.length === 0) break;
    allRows = allRows.concat(page.rows);
    if (page.rows.length < PAGE) break;
    pageOffset += PAGE;
    if (allRows.length >= MAX_EXPORT_ROWS) {
      allRows = allRows.slice(0, MAX_EXPORT_ROWS);
      capHit = true;
      break;
    }
  }
  const result = {
    rows: allRows,
    totals: totals ?? {
      imported: 0,
      posted: 0,
      unmatched: 0,
      unapplied: 0,
      denied: 0,
      recoupments: 0,
      refunds: 0,
      pendingReview: 0,
      amountPosted: 0,
      amountPending: 0,
    },
    rowCount: allRows.length,
  };
  const header = [
    "id",
    "source",
    "paymentType",
    "postingStatus",
    "payerName",
    "clientId",
    "professionalClaimId",
    "checkNumber",
    "amount",
    "depositDate",
    "paymentDate",
    "importedAt",
  ];
  const lines = [header.join(",")];
  for (const r of result.rows) {
    lines.push(
      [
        csvCell(r.id),
        csvCell(r.source),
        csvCell(r.paymentType),
        csvCell(r.postingStatus),
        csvCell(r.payerName),
        csvCell(r.clientId),
        csvCell(r.professionalClaimId),
        csvCell(r.checkNumber),
        csvCell(r.amount),
        csvCell(r.depositDate),
        csvCell(r.paymentDate),
        csvCell(r.importedAt),
      ].join(","),
    );
  }
  const csv = lines.join("\n") + "\n";

  // Best-effort export audit (one row covering the whole export).
  await writePaymentAuditLog(supabase, {
    organizationId,
    actor,
    action: "payment_adjusted",
    objectType: "era_claim_payment",
    objectId: "00000000-0000-0000-0000-000000000000",
    afterValue: { row_count: result.rowCount, filters, cap_hit: capHit },
    summary: `CSV export — ${result.rowCount} rows${capHit ? " (cap hit)" : ""}`,
    metadata: { source: "dashboard_export", cap_hit: capHit, max_rows: MAX_EXPORT_ROWS },
  });

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payments-export-${Date.now()}.csv"`,
    },
  });
}
