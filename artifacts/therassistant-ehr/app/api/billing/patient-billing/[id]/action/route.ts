/**
 * POST /api/billing/patient-billing/:id/action
 *
 * `:id` is a client id (the workqueue aggregates self-pay balance per
 * client/guarantor). Body shape:
 *   {
 *     action: "send_invoice" | "charge_card" | "create_payment_plan" |
 *             "send_reminder" | "write_off" | "send_to_collections_review",
 *     organizationId: string,
 *     amount?: number,           // charge_card, write_off
 *     monthly_amount?: number,   // create_payment_plan
 *     months?: number,           // create_payment_plan
 *     total_amount?: number,     // create_payment_plan
 *     note?: string,
 *     follow_up_at?: string,     // ISO date
 *   }
 *
 * Every action writes an audit_logs entry under the
 * `patient_billing_<action>` event_type. Some actions also mutate
 * patient_invoices / patient_invoice_payments:
 *   - send_invoice:               sets invoice_status='sent' on open invoices
 *   - send_to_collections_review: sets invoice_status='collections'
 *   - write_off:                  zeroes balance + sets invoice_status='voided'
 *                                 and inserts a patient_invoice_payments row
 *                                 with method='manual' to track the write-off
 *   - charge_card:                inserts a patient_invoice_payments row
 *                                 (method='card', status='posted') applied
 *                                 oldest-invoice-first; decrements balance
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const ALLOWED = [
  "send_invoice",
  "charge_card",
  "create_payment_plan",
  "send_reminder",
  "write_off",
  "send_to_collections_review",
] as const;
type Action = (typeof ALLOWED)[number];

const SUMMARIES: Record<Action, string> = {
  send_invoice: "Patient invoice sent",
  charge_card: "Card charge posted against patient balance",
  create_payment_plan: "Patient payment plan created",
  send_reminder: "Reminder sent to patient",
  write_off: "Patient balance written off",
  send_to_collections_review: "Patient balance routed for collections review",
};

type DbRow = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    if (!id) {
      return NextResponse.json(
        { success: false, error: "Missing client id" },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      organizationId?: string;
      amount?: number;
      monthly_amount?: number;
      months?: number;
      total_amount?: number;
      note?: string;
      follow_up_at?: string;
    };

    const action = body.action as Action | undefined;
    if (!action || !ALLOWED.includes(action)) {
      return NextResponse.json(
        { success: false, error: `Unknown action: ${body.action ?? ""}` },
        { status: 400 },
      );
    }

    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    // Tenant check: the client must belong to this org.
    const { data: client, error: clientErr } = await (supabase as any)
      .from("clients")
      .select("id, organization_id, first_name, last_name")
      .eq("id", id)
      .maybeSingle();
    if (clientErr) throw clientErr;
    if (!client || text(client.organization_id) !== organizationId) {
      return NextResponse.json(
        { success: false, error: "Client not found" },
        { status: 404 },
      );
    }

    // Pull open invoices for this client (used by most mutating actions).
    const { data: invRows } = await (supabase as any)
      .from("patient_invoices")
      .select(
        "id, invoice_status, balance_amount, paid_amount, patient_responsibility_amount",
      )
      .eq("organization_id", organizationId)
      .eq("client_id", id)
      .is("archived_at", null)
      .in("invoice_status", ["open", "sent", "collections"])
      .order("created_at", { ascending: true });
    const openInvoices = ((invRows ?? []) as DbRow[]).filter(
      (i) => money(i.balance_amount) > 0,
    );

    const metadata: Record<string, unknown> = {};
    if (body.note) metadata.note = String(body.note).slice(0, 2000);
    if (body.follow_up_at) metadata.follow_up_at = String(body.follow_up_at);

    // ── Apply per-action mutations ─────────────────────────────────
    if (action === "send_invoice") {
      const toSend = openInvoices.filter(
        (i) => text(i.invoice_status) === "open",
      );
      if (toSend.length > 0) {
        const ids = toSend.map((i) => text(i.id));
        const { error } = await (supabase as any)
          .from("patient_invoices")
          .update({
            invoice_status: "sent",
            updated_at: new Date().toISOString(),
          })
          .in("id", ids);
        if (error) throw error;
        metadata.invoice_ids = ids;
        metadata.invoice_count = ids.length;
      } else {
        metadata.invoice_count = 0;
      }
    }

    if (action === "send_to_collections_review") {
      if (openInvoices.length > 0) {
        const ids = openInvoices.map((i) => text(i.id));
        const { error } = await (supabase as any)
          .from("patient_invoices")
          .update({
            invoice_status: "collections",
            updated_at: new Date().toISOString(),
          })
          .in("id", ids);
        if (error) throw error;
        metadata.invoice_ids = ids;
      }
    }

    if (action === "write_off") {
      const amount = money(body.amount);
      const totalOpen =
        Math.round(openInvoices.reduce((s, i) => s + money(i.balance_amount), 0) * 100) / 100;
      const target = amount > 0 ? Math.min(amount, totalOpen) : totalOpen;
      let remaining = target;
      const touched: string[] = [];
      for (const inv of openInvoices) {
        if (remaining <= 0) break;
        const bal = money(inv.balance_amount);
        const apply = Math.min(bal, remaining);
        const newBal = Math.round((bal - apply) * 100) / 100;
        const newPaid = money(inv.paid_amount) + apply;
        const update: Record<string, unknown> = {
          balance_amount: newBal,
          paid_amount: Math.round(newPaid * 100) / 100,
          updated_at: new Date().toISOString(),
        };
        if (newBal <= 0) update.invoice_status = "voided";
        const { error } = await (supabase as any)
          .from("patient_invoices")
          .update(update)
          .eq("id", inv.id);
        if (error) throw error;
        // Record write-off as a manual "payment" so it shows in history.
        const { error: payErr } = await (supabase as any)
          .from("patient_invoice_payments")
          .insert({
            organization_id: organizationId,
            patient_invoice_id: inv.id,
            client_id: id,
            amount: apply,
            payment_method: "manual",
            payment_status: "posted",
            memo: text(body.note) || "Patient balance written off",
            paid_at: new Date().toISOString(),
          });
        if (payErr) throw payErr;
        touched.push(text(inv.id));
        remaining = Math.round((remaining - apply) * 100) / 100;
      }
      metadata.amount = target;
      metadata.invoice_ids = touched;
    }

    if (action === "charge_card") {
      const amount = money(body.amount);
      if (amount <= 0) {
        return NextResponse.json(
          { success: false, error: "Charge amount must be greater than zero" },
          { status: 400 },
        );
      }
      let remaining = amount;
      const touched: string[] = [];
      for (const inv of openInvoices) {
        if (remaining <= 0) break;
        const bal = money(inv.balance_amount);
        const apply = Math.min(bal, remaining);
        const newBal = Math.round((bal - apply) * 100) / 100;
        const newPaid = money(inv.paid_amount) + apply;
        const update: Record<string, unknown> = {
          balance_amount: newBal,
          paid_amount: Math.round(newPaid * 100) / 100,
          updated_at: new Date().toISOString(),
        };
        if (newBal <= 0) update.invoice_status = "paid";
        const { error } = await (supabase as any)
          .from("patient_invoices")
          .update(update)
          .eq("id", inv.id);
        if (error) throw error;
        const { error: payErr } = await (supabase as any)
          .from("patient_invoice_payments")
          .insert({
            organization_id: organizationId,
            patient_invoice_id: inv.id,
            client_id: id,
            amount: apply,
            payment_method: "card",
            payment_status: "posted",
            memo: text(body.note) || null,
            paid_at: new Date().toISOString(),
          });
        if (payErr) throw payErr;
        touched.push(text(inv.id));
        remaining = Math.round((remaining - apply) * 100) / 100;
      }
      metadata.amount = amount;
      metadata.applied = Math.round((amount - remaining) * 100) / 100;
      metadata.invoice_ids = touched;
    }

    if (action === "create_payment_plan") {
      if (body.monthly_amount != null) metadata.monthly_amount = Number(body.monthly_amount);
      if (body.months != null) metadata.months = Number(body.months);
      if (body.total_amount != null) metadata.total_amount = Number(body.total_amount);
    }

    // ── Always write the audit event ───────────────────────────────
    const eventType = `patient_billing_${action}`;
    const { error: auditErr } = await (supabase as any)
      .from("audit_logs")
      .insert({
        organization_id: organizationId,
        patient_id: id,
        event_type: eventType,
        event_summary: SUMMARIES[action],
        event_metadata: metadata,
        user_id: guard.userId,
        action: eventType,
        object_type: "client",
        object_id: id,
      });
    if (auditErr) throw auditErr;

    return NextResponse.json({
      success: true,
      organizationId,
      clientId: id,
      action,
      summary: SUMMARIES[action],
      metadata,
    });
  } catch (error) {
    console.error("Patient Billing action error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Action failed",
      },
      { status: 500 },
    );
  }
}
