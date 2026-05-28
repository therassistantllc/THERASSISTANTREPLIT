/**
 * POST /api/billing/payments/bulk/export
 * Body: { organizationId, ids: string[] }
 *
 * Bulk export of selected dashboard rows as CSV. Distinct from the
 * top-level /api/billing/payments/export endpoint (which exports the
 * full filtered set): this one streams only the explicitly selected
 * payment rows so a biller can hand off a working set to AR.
 *
 * Role-guarded via requireAuthenticatedPaymentPoster; one audit row
 * summarizes the export.
 */
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { writePaymentAuditLog } from "@/lib/payments/postingEngine/audit";
import { requireAuthenticatedPaymentPoster } from "@/lib/payments/postingEngine";
import { parseTargets } from "../_shared";

export const runtime = "nodejs";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const organizationId = String((body as { organizationId?: string }).organizationId ?? "");
  if (!organizationId) {
    return Response.json({ error: "organizationId is required" }, { status: 400 });
  }
  const { targets, errors: parseErrors } = parseTargets((body as { ids?: unknown }).ids);
  if (targets.length === 0) {
    return Response.json({ error: "No valid targets", parseErrors }, { status: 400 });
  }

  let actor;
  try {
    actor = await requireAuthenticatedPaymentPoster(organizationId);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Forbidden" },
      { status: 403 },
    );
  }

  const supabaseMaybe = createServerSupabaseAdminClient();
  if (!supabaseMaybe) {
    return Response.json({ error: "Database unavailable" }, { status: 503 });
  }
  const supabase = supabaseMaybe;

  const header = [
    "id",
    "source",
    "amount",
    "checkNumber",
    "postedAt",
    "clientId",
    "claimId",
  ];
  const lines = [header.join(",")];
  const errors: Array<{ id: string; message: string }> = [];

  // Tolerate variant column names by retrying with a narrower select when
  // the wide select fails (mirrors the row-loader fallbacks in
  // dashboardQuery.ts). And surface fetch failures via `errors` instead
  // of silently dropping them — that was the silent-data-loss path.
  async function fetchEra(id: string) {
    const wide = await supabase
      .from("era_claim_payments")
      .select(
        "id, client_id, professional_claim_id, clp04_payment_amount, check_eft_number, created_at",
      )
      .eq("organization_id", organizationId)
      .eq("id", id)
      .is("archived_at", null)
      .maybeSingle();
    if (!wide.error) return wide;
    return supabase
      .from("era_claim_payments")
      .select("id, client_id, professional_claim_id, clp04_payment_amount, created_at")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .is("archived_at", null)
      .maybeSingle();
  }
  async function fetchManual(id: string) {
    const wide = await supabase
      .from("insurance_manual_payments")
      .select("id, client_id, claim_id, paid_amount, eob_reference, posted_at")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .is("archived_at", null)
      .maybeSingle();
    if (!wide.error) return wide;
    return supabase
      .from("insurance_manual_payments")
      .select("id, client_id, claim_id, paid_amount, posted_at")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .is("archived_at", null)
      .maybeSingle();
  }

  for (const t of targets) {
    if (t.kind === "era_835") {
      const { data, error } = await fetchEra(t.id);
      if (error) {
        errors.push({ id: `era:${t.id}`, message: error.message });
        continue;
      }
      if (!data) {
        errors.push({ id: `era:${t.id}`, message: "row not found or archived" });
        continue;
      }
      const r = data as Record<string, unknown>;
      lines.push(
        [
          csvCell(`era:${r.id}`),
          "era",
          csvCell(r.clp04_payment_amount),
          csvCell(r.check_eft_number),
          csvCell(r.created_at),
          csvCell(r.client_id),
          csvCell(r.professional_claim_id),
        ].join(","),
      );
    } else if (t.kind === "insurance_manual") {
      const { data, error } = await fetchManual(t.id);
      if (error) {
        errors.push({ id: `mi:${t.id}`, message: error.message });
        continue;
      }
      if (!data) {
        errors.push({ id: `mi:${t.id}`, message: "row not found or archived" });
        continue;
      }
      const r = data as Record<string, unknown>;
      lines.push(
        [
          csvCell(`mi:${r.id}`),
          "manual_insurance",
          csvCell(r.paid_amount),
          csvCell(r.eob_reference),
          csvCell(r.posted_at),
          csvCell(r.client_id),
          csvCell(r.claim_id),
        ].join(","),
      );
    } else {
      const { data, error } = await supabase
        .from("client_payments")
        .select("id, client_id, claim_id, amount, reference_number, posted_at")
        .eq("organization_id", organizationId)
        .eq("id", t.id)
        .is("archived_at", null)
        .maybeSingle();
      if (error) {
        errors.push({ id: `cp:${t.id}`, message: error.message });
        continue;
      }
      if (!data) {
        errors.push({ id: `cp:${t.id}`, message: "row not found or archived" });
        continue;
      }
      const r = data as Record<string, unknown>;
      lines.push(
        [
          csvCell(`cp:${r.id}`),
          "client",
          csvCell(r.amount),
          csvCell(r.reference_number),
          csvCell(r.posted_at),
          csvCell(r.client_id),
          csvCell(r.claim_id),
        ].join(","),
      );
    }
  }

  await writePaymentAuditLog(supabase, {
    organizationId,
    actor,
    action: "payment_adjusted",
    objectType: "era_claim_payment",
    objectId: "00000000-0000-0000-0000-000000000000",
    afterValue: { row_count: lines.length - 1, requested: targets.length, errors },
    summary: `Bulk CSV export — ${lines.length - 1}/${targets.length} rows${errors.length ? ` (${errors.length} errors)` : ""}`,
    metadata: { source: "bulk_export", parseErrors, errors },
  });

  const csv = lines.join("\n") + "\n";
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payments-selected-${Date.now()}.csv"`,
    },
  });
}
