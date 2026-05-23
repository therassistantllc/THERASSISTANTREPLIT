/**
 * GET /api/billing/payments/posted/:id
 *
 * Read-only assembly of the posted-payment detail page. The path param is
 * a composite id of the form `<kind>:<uuid>` where kind is one of:
 *   - era         (era_claim_payments)
 *   - cp          (client_payments)
 *   - mi          (insurance_manual_payments)
 *
 * Returns header + source rows + posted lines + CAS adjustments + ledger
 * entries + workqueue items + audit chain + refund/recoupment history, so
 * the UI can render the spec'd detail view with zero extra round trips.
 */

import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";
import {
  parseCompositePostedPaymentId as parseCompositeId,
  UUID_RE,
} from "./_compositeId";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await context.params;
    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organizationId") || "";
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }
    await requireAuthenticatedPaymentPoster(organizationId);

    const parsed = parseCompositeId(rawId);
    if (!parsed) {
      return NextResponse.json(
        { success: false, error: "Invalid posted-payment id (expected era:|cp:|mi: prefix)" },
        { status: 400 },
      );
    }
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    // ── Header (source-specific) ────────────────────────────────────────────
    let header: Record<string, unknown> | null = null;
    let professionalClaimId: string | null = null;
    let clientId: string | null = null;
    let payerProfileId: string | null = null;
    let postingStatus = "";
    let totalImpact = 0;
    let sourceTitle = "";

    let sourceLink: { kind: string; id: string; label: string } | null = null;

    if (parsed.kind === "era_835") {
      const { data, error } = await supabase
        .from("era_claim_payments")
        .select(
          "id, organization_id, era_import_batch_id, professional_claim_id, client_id, clp01_claim_control_number, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, cas_adjustments, claim_match_status, posting_status, reversed_at, reversal_reason, voided_at, void_reason, created_at, updated_at",
        )
        .eq("organization_id", organizationId)
        .eq("id", parsed.id)
        .is("archived_at", null)
        .maybeSingle();
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }
      if (!data) {
        return NextResponse.json({ success: false, error: "Posted payment not found" }, { status: 404 });
      }
      const row = data as Record<string, unknown>;
      header = row;
      professionalClaimId = (row.professional_claim_id as string | null) ?? null;
      clientId = (row.client_id as string | null) ?? null;
      postingStatus = String(row.posting_status ?? "");
      totalImpact = Number(row.clp04_payment_amount ?? 0);
      sourceTitle = `ERA 835 ${String(row.clp01_claim_control_number ?? parsed.id)}`;
      const batchId = (row.era_import_batch_id as string | null) ?? null;
      if (batchId) {
        sourceLink = {
          kind: "era_import_batch",
          id: batchId,
          label: `ERA Import Batch ${batchId.slice(0, 8)}`,
        };
      }
    } else if (parsed.kind === "client_payment") {
      const { data, error } = await supabase
        .from("client_payments")
        .select(
          "id, organization_id, client_id, claim_id, patient_invoice_id, payment_method, amount, reference_number, external_payment_id, stripe_charge_id, posting_status, posted_at, reversed_at, reversal_reason, voided_at, void_reason, source_label, created_at, updated_at",
        )
        .eq("organization_id", organizationId)
        .eq("id", parsed.id)
        .is("archived_at", null)
        .maybeSingle();
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }
      if (!data) {
        return NextResponse.json({ success: false, error: "Posted payment not found" }, { status: 404 });
      }
      const row = data as Record<string, unknown>;
      header = row;
      professionalClaimId = (row.claim_id as string | null) ?? null;
      clientId = (row.client_id as string | null) ?? null;
      postingStatus = String(row.posting_status ?? "");
      totalImpact = Number(row.amount ?? 0);
      sourceTitle = `Client payment (${String(row.payment_method ?? "")})`;
      const invId = (row.patient_invoice_id as string | null) ?? null;
      if (invId) {
        sourceLink = { kind: "patient_invoice", id: invId, label: `Patient invoice ${invId.slice(0, 8)}` };
      }
    } else {
      const { data, error } = await supabase
        .from("insurance_manual_payments")
        .select(
          "id, organization_id, professional_claim_id, client_id, payer_profile_id, payer_payment_amount, patient_responsibility_amount, contractual_adjustment_amount, check_number, payment_date, mailroom_item_id, posting_status, reversed_at, reversal_reason, voided_at, void_reason, created_at, updated_at",
        )
        .eq("organization_id", organizationId)
        .eq("id", parsed.id)
        .is("archived_at", null)
        .maybeSingle();
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }
      if (!data) {
        return NextResponse.json({ success: false, error: "Posted payment not found" }, { status: 404 });
      }
      const row = data as Record<string, unknown>;
      header = row;
      professionalClaimId = (row.professional_claim_id as string | null) ?? null;
      clientId = (row.client_id as string | null) ?? null;
      payerProfileId = (row.payer_profile_id as string | null) ?? null;
      postingStatus = String(row.posting_status ?? "");
      totalImpact = Number(row.payer_payment_amount ?? 0);
      sourceTitle = `Manual EOB ${String(row.check_number ?? parsed.id.slice(0, 8))}`;
      const mrId = (row.mailroom_item_id as string | null) ?? null;
      if (mrId) {
        sourceLink = { kind: "mailroom_item", id: mrId, label: `Mailroom item ${mrId.slice(0, 8)}` };
      }
    }

    // ── Ledger entries (all source kinds share this table) ──────────────────
    const { data: ledgerEntries } = await supabase
      .from("era_posting_ledger_entries")
      .select(
        "id, source_type, source_id, entry_type, amount, group_code, reason_code, description, posted_at, professional_claim_id",
      )
      .eq("organization_id", organizationId)
      .eq("source_id", parsed.id)
      .is("archived_at", null)
      .order("posted_at", { ascending: true });

    // Linked refunds & recoupments
    const sourceCol =
      parsed.kind === "era_835"
        ? "source_era_claim_payment_id"
        : parsed.kind === "client_payment"
          ? "source_client_payment_id"
          : "source_insurance_manual_payment_id";
    const [refundsRes, recoupsRes] = await Promise.all([
      supabase
        .from("payment_refunds")
        .select(
          "id, refund_type, amount, reason, refund_status, stripe_refund_id, workqueue_item_id, requested_at, issued_at",
        )
        .eq("organization_id", organizationId)
        .eq(sourceCol, parsed.id)
        .is("archived_at", null)
        .order("requested_at", { ascending: false }),
      parsed.kind === "insurance_manual"
        ? Promise.resolve({ data: [] as Array<Record<string, unknown>> })
        : supabase
            .from("payment_recoupments")
            .select(
              "id, amount, reason, reason_code, workqueue_item_id, recouped_at, offset_era_claim_payment_id",
            )
            .eq("organization_id", organizationId)
            .eq(
              parsed.kind === "era_835" ? "source_era_claim_payment_id" : "source_client_payment_id",
              parsed.id,
            )
            .is("archived_at", null)
            .order("recouped_at", { ascending: false }),
    ]);

    // Workqueue items anchored to this payment id OR to any of its
    // child recoupment / refund rows. The PP-5 rule engine anchors
    // recoupment + refund items on the child row id (not the parent
    // payment) so we must explicitly include those source_object_ids
    // here — otherwise auto-generated recoupment/refund-review items
    // wouldn't surface on the posted-payment detail.
    const childSourceIds = [
      ...((refundsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id),
      ...((recoupsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id),
    ].filter((v): v is string => typeof v === "string" && UUID_RE.test(v));
    const wqSourceIds = [parsed.id, ...childSourceIds];
    const { data: workqueueItems } = await supabase
      .from("workqueue_items")
      .select("id, work_type, queue_type, status, priority, title, description, created_at, resolved_at")
      .eq("organization_id", organizationId)
      .in("source_object_id", wqSourceIds)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    // Audit chain — payment object + child refund/recoupment audit rows +
    // any related claim. Refund/recoup audits are written keyed on the
    // refund/recoupment row id (not the payment), so we must explicitly
    // include those object_ids here or they'd be missing from history —
    // especially for client_payments without a professional claim link.
    const refundIds = ((refundsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    const recoupIds = ((recoupsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    const auditObjectIds = [parsed.id, ...refundIds, ...recoupIds].filter((v): v is string =>
      typeof v === "string" && UUID_RE.test(v),
    );
    // Build typed predicates only — no raw string interpolation of user input
    // into the filter grammar. The IN clause is composed from values we just
    // validated as UUIDs above, so it cannot be abused as a filter-injection.
    let auditQuery = supabase
      .from("audit_logs")
      .select(
        "id, user_id, user_role, action, object_type, object_id, claim_id, before_value, after_value, event_summary, event_metadata, created_at",
      )
      .eq("organization_id", organizationId);
    if (professionalClaimId && UUID_RE.test(professionalClaimId)) {
      auditQuery = auditQuery.or(
        `object_id.in.(${auditObjectIds.join(",")}),claim_id.eq.${professionalClaimId}`,
      );
    } else {
      auditQuery = auditQuery.in("object_id", auditObjectIds);
    }
    const { data: auditRows } = await auditQuery.order("created_at", { ascending: true });

    // Claim summary (for header context, denied/paid status). Includes
    // billing_notes + denial_reason_code/description so the detail UI can
    // render the biller-notes and denial-action context required by spec
    // without an extra round trip.
    let claim: Record<string, unknown> | null = null;
    if (professionalClaimId) {
      const { data: claimRow } = await supabase
        .from("professional_claims")
        .select(
          "id, claim_number, claim_status, total_charge, patient_responsibility_amount, date_of_service_from, date_of_service_to, submitted_at, paid_at, denied_at, denial_reason, denial_reason_code, denial_reason_description, billing_notes",
        )
        .eq("id", professionalClaimId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      claim = (claimRow as Record<string, unknown> | null) ?? null;
    }

    // Attachments: documents tied to this claim (claim_id direct or via
    // document_links polymorphic link), plus any documents linked to the
    // mailroom item for paper EOB sources. Best-effort, non-fatal.
    let attachments: Array<Record<string, unknown>> = [];
    try {
      const mrId =
        parsed.kind === "insurance_manual"
          ? ((header as { mailroom_item_id?: string | null })?.mailroom_item_id ?? null)
          : null;
      const claimIdForDocs = professionalClaimId && UUID_RE.test(professionalClaimId) ? professionalClaimId : null;
      if (claimIdForDocs || mrId) {
        const orParts: string[] = [];
        if (claimIdForDocs) orParts.push(`claim_id.eq.${claimIdForDocs}`);
        if (mrId && UUID_RE.test(mrId)) orParts.push(`mailroom_item_id.eq.${mrId}`);
        const { data: docs } = await supabase
          .from("documents")
          .select("id, document_type, title, file_name, mime_type, file_size_bytes, created_at, storage_path")
          .eq("organization_id", organizationId)
          .or(orParts.join(","))
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(50);
        attachments = (docs ?? []) as Array<Record<string, unknown>>;
      }
    } catch {
      attachments = [];
    }

    // Patient-side context (invoice + payments) for the right rail
    let patientInvoice: Record<string, unknown> | null = null;
    if (parsed.kind === "client_payment" && header) {
      const invId = (header as { patient_invoice_id?: string | null }).patient_invoice_id ?? null;
      if (invId) {
        const { data: invRow } = await supabase
          .from("patient_invoices")
          .select("id, invoice_number, invoice_status, patient_responsibility_amount, paid_amount, balance_amount")
          .eq("id", invId)
          .eq("organization_id", organizationId)
          .maybeSingle();
        patientInvoice = (invRow as Record<string, unknown> | null) ?? null;
      }
    }

    return NextResponse.json({
      success: true,
      compositeId: rawId,
      kind: parsed.kind,
      paymentId: parsed.id,
      sourceTitle,
      postingStatus,
      totalImpact,
      header,
      claim,
      patientInvoice,
      ledgerEntries: ledgerEntries ?? [],
      refunds: (refundsRes.data ?? []) as Array<Record<string, unknown>>,
      recoupments: (recoupsRes.data ?? []) as Array<Record<string, unknown>>,
      workqueueItems: workqueueItems ?? [],
      auditChain: auditRows ?? [],
      sourceLink,
      casAdjustments: header && (header as { cas_adjustments?: unknown }).cas_adjustments
        ? (header as { cas_adjustments: unknown }).cas_adjustments
        : null,
      payerProfileId,
      clientId,
      professionalClaimId,
      attachments,
      billingNotes: claim ? (claim as { billing_notes?: string | null }).billing_notes ?? null : null,
      denial: claim
        ? {
            reason: (claim as { denial_reason?: string | null }).denial_reason ?? null,
            reasonCode: (claim as { denial_reason_code?: string | null }).denial_reason_code ?? null,
            reasonDescription:
              (claim as { denial_reason_description?: string | null }).denial_reason_description ?? null,
            deniedAt: (claim as { denied_at?: string | null }).denied_at ?? null,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    if (error instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    console.error("GET /api/billing/payments/posted/[id] error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load posted payment" },
      { status: 500 },
    );
  }
}
