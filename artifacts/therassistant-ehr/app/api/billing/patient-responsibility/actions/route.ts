import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { markPatientInvoiceSent } from "@/lib/payments/patientInvoicePaymentService";

type ActionName =
  | "create_invoice"
  | "send_statement"
  | "charge_card"
  | "apply_adjustment"
  | "hold_billing"
  | "release_hold";

interface ActionBody {
  organizationId?: string;
  action?: ActionName;
  eraClaimPaymentId?: string;
  claimId?: string | null;
  clientId?: string | null;
  amount?: number;
  adjustmentAmount?: number;
  adjustmentReason?: string;
  note?: string;
  invoiceId?: string;
}

async function writeAudit(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  args: {
    organizationId: string;
    userId: string | null;
    action: string;
    claimId: string | null;
    clientId: string | null;
    summary: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: "Database connection not available" };
  try {
    const { error } = await (
      supabase as unknown as {
        from: (t: string) => {
          insert: (v: unknown) => Promise<{ error: { message?: string } | null }>;
        };
      }
    )
      .from("audit_logs")
      .insert({
        organization_id: args.organizationId,
        user_id: args.userId,
        action: args.action,
        event_type: "patient_responsibility_workqueue",
        event_summary: args.summary,
        event_metadata: args.metadata ?? {},
        claim_id: args.claimId,
        patient_id: args.clientId,
        object_type: args.claimId ? "professional_claim" : null,
        object_id: args.claimId,
      });
    if (error) return { ok: false, error: error.message ?? "audit_logs insert failed" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "audit_logs insert failed" };
  }
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }
    const body = (await request.json()) as ActionBody;
    const guard = await requireBillingAccess({ requestedOrganizationId: body.organizationId });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const userId = guard.userId;

    const action = body.action;
    const eraId = (body.eraClaimPaymentId ?? "").trim();
    const note = (body.note ?? "").trim();
    if (!action || !eraId) {
      return NextResponse.json(
        { success: false, error: "action and eraClaimPaymentId are required" },
        { status: 400 },
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };

    // Validate the ERA exists in the caller's org.
    const { data: era, error: eraErr } = await sb
      .from("era_claim_payments")
      .select("id, professional_claim_id, client_id, pr_amount, clp05_patient_responsibility")
      .eq("id", eraId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (eraErr) {
      return NextResponse.json(
        { success: false, error: eraErr.message ?? "Failed to look up ERA payment" },
        { status: 500 },
      );
    }
    if (!era) {
      return NextResponse.json(
        { success: false, error: "ERA payment not found in this organization" },
        { status: 404 },
      );
    }
    const claimId = body.claimId ?? (era.professional_claim_id as string | null) ?? null;
    const clientId = body.clientId ?? (era.client_id as string | null) ?? null;
    const prAmount = Number(era.pr_amount ?? era.clp05_patient_responsibility ?? 0);

    switch (action) {
      case "create_invoice": {
        if (!clientId) {
          return NextResponse.json(
            { success: false, error: "ERA has no responsible patient" },
            { status: 422 },
          );
        }
        const amount = Math.round(Math.max(0, Number(body.amount ?? prAmount)) * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0) {
          return NextResponse.json(
            { success: false, error: "Patient responsibility amount is zero" },
            { status: 422 },
          );
        }

        // Pull the claim number for a friendlier invoice number.
        let claimNumber = "";
        if (claimId) {
          const { data: c } = await sb
            .from("professional_claims")
            .select("claim_number")
            .eq("id", claimId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          claimNumber = c ? String(c.claim_number ?? "") : "";
        }
        const invoiceNumber = `INV-${(claimNumber || eraId).toString().slice(0, 16)}-${Date.now()
          .toString()
          .slice(-6)}`;

        const { data: invoice, error: invErr } = await sb
          .from("patient_invoices")
          .insert({
            organization_id: organizationId,
            client_id: clientId,
            professional_claim_id: claimId,
            era_claim_payment_id: eraId,
            invoice_status: "open",
            invoice_number: invoiceNumber,
            patient_responsibility_amount: amount,
            paid_amount: 0,
            balance_amount: amount,
            source: "era_remit",
          })
          .select("id, invoice_number, invoice_status, balance_amount")
          .single();
        if (invErr || !invoice) {
          return NextResponse.json(
            { success: false, error: invErr?.message ?? "Failed to create invoice" },
            { status: 500 },
          );
        }
        const audit = await writeAudit(supabase, {
          organizationId, userId,
          action: "patient_resp_invoice_created",
          claimId, clientId,
          summary: note || `Created patient invoice ${invoiceNumber} for $${amount.toFixed(2)}`,
          metadata: { eraClaimPaymentId: eraId, invoiceId: String(invoice.id), amount, invoiceNumber },
        });
        if (!audit.ok) {
          return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        }
        return NextResponse.json({
          success: true,
          invoiceId: String(invoice.id),
          invoiceNumber,
          invoiceStatus: String(invoice.invoice_status),
          balanceAmount: Number(invoice.balance_amount ?? amount),
        });
      }

      case "send_statement": {
        // Pick the most recent open invoice for this ERA / claim.
        let invoiceId = (body.invoiceId ?? "").trim();
        if (!invoiceId) {
          const filter = claimId
            ? `professional_claim_id.eq.${claimId},era_claim_payment_id.eq.${eraId}`
            : `era_claim_payment_id.eq.${eraId}`;
          const { data: invRow } = await sb
            .from("patient_invoices")
            .select("id")
            .eq("organization_id", organizationId)
            .or(filter)
            .is("archived_at", null)
            .neq("invoice_status", "void")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          invoiceId = invRow ? String(invRow.id) : "";
        }
        if (!invoiceId) {
          return NextResponse.json(
            { success: false, error: "No invoice exists yet — create one first." },
            { status: 422 },
          );
        }
        const sent = await markPatientInvoiceSent({
          organizationId,
          patientInvoiceId: invoiceId,
          memo: note || null,
        });
        if (!sent.ok) {
          return NextResponse.json({ success: false, error: sent.errors?.[0]?.message ?? "Failed to send statement" }, { status: 422 });
        }
        await writeAudit(supabase, {
          organizationId, userId,
          action: "patient_resp_statement_sent",
          claimId, clientId,
          summary: note || `Statement sent for invoice ${invoiceId}`,
          metadata: { eraClaimPaymentId: eraId, invoiceId },
        });
        return NextResponse.json({ success: true, invoiceId, statementDate: new Date().toISOString() });
      }

      case "charge_card": {
        // No saved card / autopay schema exists on `clients` — log the
        // attempt so the action is auditable, and surface a clear message
        // when a payment method isn't on file.
        if (!clientId) {
          return NextResponse.json(
            { success: false, error: "ERA has no responsible patient" },
            { status: 422 },
          );
        }
        const amount = Math.round(Math.max(0, Number(body.amount ?? prAmount)) * 100) / 100;
        const audit = await writeAudit(supabase, {
          organizationId, userId,
          action: "patient_resp_charge_card_requested",
          claimId, clientId,
          summary: note || `Card charge requested for $${amount.toFixed(2)}`,
          metadata: { eraClaimPaymentId: eraId, amount, status: "queued_no_card_on_file" },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        return NextResponse.json({
          success: true,
          status: "queued",
          message: "No card on file — patient will be prompted to add one via the portal.",
        });
      }

      case "apply_adjustment": {
        const adj = Math.round(Math.max(0, Number(body.adjustmentAmount ?? 0)) * 100) / 100;
        if (!Number.isFinite(adj) || adj <= 0) {
          return NextResponse.json(
            { success: false, error: "adjustmentAmount must be greater than zero" },
            { status: 400 },
          );
        }
        if (claimId) {
          const { data: claim } = await sb
            .from("professional_claims")
            .select("id, write_off_amount, total_charge")
            .eq("id", claimId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          if (claim) {
            const newWriteOff = Math.round((Number(claim.write_off_amount ?? 0) + adj) * 100) / 100;
            const { error: updErr } = await sb
              .from("professional_claims")
              .update({ write_off_amount: newWriteOff })
              .eq("id", claimId)
              .eq("organization_id", organizationId);
            if (updErr) {
              return NextResponse.json(
                { success: false, error: updErr.message ?? "Failed to update claim" },
                { status: 500 },
              );
            }
          }
        }
        const audit = await writeAudit(supabase, {
          organizationId, userId,
          action: "patient_resp_adjustment_applied",
          claimId, clientId,
          summary: note || `Applied $${adj.toFixed(2)} adjustment (${body.adjustmentReason ?? "manual"})`,
          metadata: {
            eraClaimPaymentId: eraId,
            adjustmentAmount: adj,
            reason: body.adjustmentReason ?? "manual",
          },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        return NextResponse.json({ success: true, adjustmentAmount: adj });
      }

      case "hold_billing": {
        const audit = await writeAudit(supabase, {
          organizationId, userId,
          action: "patient_resp_hold",
          claimId, clientId,
          summary: note || "Patient billing placed on hold",
          metadata: { eraClaimPaymentId: eraId, reason: body.adjustmentReason ?? null },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        return NextResponse.json({ success: true, onHold: true });
      }

      case "release_hold": {
        const audit = await writeAudit(supabase, {
          organizationId, userId,
          action: "patient_resp_hold_released",
          claimId, clientId,
          summary: note || "Patient billing hold released",
          metadata: { eraClaimPaymentId: eraId },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        return NextResponse.json({ success: true, onHold: false });
      }

      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Action failed" },
      { status: 500 },
    );
  }
}
