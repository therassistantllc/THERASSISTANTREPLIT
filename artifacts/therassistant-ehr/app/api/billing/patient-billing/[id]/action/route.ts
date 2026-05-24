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
 *   - charge_card:                runs a real Stripe charge off-session
 *                                 against the patient's previously-stored
 *                                 customer + payment_method (recovered
 *                                 from the most recent successful
 *                                 client_payments row). On Stripe success
 *                                 inserts a patient_invoice_payments row
 *                                 (method='stripe', status='posted',
 *                                 external_payment_id=<stripe charge id>)
 *                                 applied oldest-invoice-first; decrements
 *                                 the invoice balance. Stripe failures
 *                                 short-circuit before any DB mutation,
 *                                 and the Stripe charge id is captured in
 *                                 the audit_logs event_metadata.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { createHash } from "node:crypto";
import {
  chargeSavedPaymentMethod,
  getStripeSecretKey,
  refundConnectCharge,
  retrieveConnectCharge,
  StripeRequestError,
} from "@/lib/stripe/connect";

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
      if (openInvoices.length === 0) {
        return NextResponse.json(
          { success: false, error: "No open invoices to apply payment to" },
          { status: 422 },
        );
      }
      // Cap charge at the patient's total open balance so we never
      // collect more on Stripe than we can post to the local ledger
      // (the leftover would be unaccounted money on the connected
      // account). Reject explicitly instead of silently truncating —
      // billers should know they typed too high.
      const totalOpenBalance =
        Math.round(
          openInvoices.reduce((s, i) => s + money(i.balance_amount), 0) * 100,
        ) / 100;
      if (amount > totalOpenBalance) {
        return NextResponse.json(
          {
            success: false,
            error: `Charge amount $${amount.toFixed(2)} exceeds open balance $${totalOpenBalance.toFixed(2)}`,
          },
          { status: 422 },
        );
      }
      if (!getStripeSecretKey()) {
        return NextResponse.json(
          { success: false, error: "Online card payment is not configured" },
          { status: 503 },
        );
      }

      // Recover a reusable (customer, payment_method) pair from the
      // patient's most-recent successful Stripe charge so we can run an
      // off-session charge. We don't store card metadata locally — we
      // rely on Stripe being the source of truth.
      const { data: lastChargeRow, error: lastChargeErr } = await (supabase as any)
        .from("client_payments")
        .select("external_payment_id, stripe_charge_id, stripe_connected_account_id")
        .eq("organization_id", organizationId)
        .eq("client_id", id)
        .eq("payment_method", "stripe")
        .eq("posting_status", "posted")
        .is("archived_at", null)
        .not("external_payment_id", "is", null)
        .order("posted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastChargeErr) throw lastChargeErr;
      const lastCharge = lastChargeRow as
        | {
            external_payment_id: string | null;
            stripe_charge_id: string | null;
            stripe_connected_account_id: string | null;
          }
        | null;
      const priorChargeId = text(lastCharge?.stripe_charge_id) || text(lastCharge?.external_payment_id);
      const connectedAccountId = text(lastCharge?.stripe_connected_account_id);
      if (!priorChargeId || !connectedAccountId) {
        return NextResponse.json(
          {
            success: false,
            error:
              "No saved card on file — ask the patient to pay an invoice via the portal first, then retry.",
          },
          { status: 422 },
        );
      }

      // Look up the prior charge on Stripe to recover the customer +
      // payment_method ids we need for the off-session re-charge.
      let customerId = "";
      let paymentMethodId = "";
      try {
        const prior = await retrieveConnectCharge({
          chargeId: priorChargeId,
          connectedAccountId,
        });
        customerId = text(prior.customer);
        paymentMethodId = text(prior.payment_method);
      } catch (err) {
        const message =
          err instanceof StripeRequestError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to read prior charge from Stripe";
        return NextResponse.json(
          { success: false, error: `Could not load saved card: ${message}` },
          { status: 502 },
        );
      }
      if (!customerId || !paymentMethodId) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Saved Stripe payment method is missing — ask the patient to re-enter their card via the portal.",
          },
          { status: 422 },
        );
      }

      // Run the real charge BEFORE mutating invoices. We commit money
      // first, then record it locally only on success.
      const amountCents = Math.round(amount * 100);
      // Deterministic idempotency key tied to (org, client, amount,
      // current open-invoice state). Retries within the same state
      // collapse to the same Stripe charge — Stripe returns the prior
      // PaymentIntent instead of creating a duplicate. Once invoices
      // change (because a charge actually succeeded and reduced
      // balances), the key naturally rolls. Mirrors the pattern in
      // lib/portal/invoiceCheckout.ts.
      const invoiceSnapshot = openInvoices
        .map((i) => `${text(i.id)}:${Math.round(money(i.balance_amount) * 100)}`)
        .sort()
        .join("|");
      const snapshotHash = createHash("sha256")
        .update(invoiceSnapshot)
        .digest("hex")
        .slice(0, 16);
      const idempotencyKey = `pb-charge-${organizationId}-${id}-${amountCents}-${snapshotHash}`;
      let chargeId: string | null = null;
      let paymentIntentId: string | null = null;
      try {
        const intent = await chargeSavedPaymentMethod({
          amountCents,
          currency: "usd",
          connectedAccountId,
          customerId,
          paymentMethodId,
          description: `Patient balance charge for client ${id}`,
          metadata: {
            origin: "patient_billing_charge_card",
            organization_id: organizationId,
            client_id: id,
            requested_amount_cents: String(amountCents),
          },
          idempotencyKey,
        });
        if (intent.status !== "succeeded") {
          return NextResponse.json(
            {
              success: false,
              error: `Stripe charge did not succeed (status=${intent.status})`,
            },
            { status: 402 },
          );
        }
        paymentIntentId = text(intent.id) || null;
        const latest = (intent as { latest_charge?: string | { id?: string } | null }).latest_charge;
        if (typeof latest === "string") chargeId = latest;
        else if (latest && typeof latest === "object") chargeId = text(latest.id) || null;

        // Defense against idempotency-replay after a compensated
        // failure: Stripe's idempotency cache returns the original
        // PaymentIntent on a retry with the same key — including one
        // we may have refunded ourselves. Re-read the charge and
        // refuse to post locally if it's been (even partially)
        // refunded or uncaptured. Without this guard, a retry after a
        // successful local rollback + refund would re-post invoice
        // balances against a charge that no longer holds funds.
        if (!chargeId) {
          return NextResponse.json(
            { success: false, error: "Stripe PaymentIntent did not return a charge id" },
            { status: 502 },
          );
        }
        const verifyCharge = await retrieveConnectCharge({
          chargeId,
          connectedAccountId,
        });
        const refundedAmount = Number(verifyCharge.amount_refunded ?? 0);
        if (
          verifyCharge.status !== "succeeded" ||
          verifyCharge.captured === false ||
          verifyCharge.refunded === true ||
          refundedAmount > 0
        ) {
          return NextResponse.json(
            {
              success: false,
              error: `Stripe charge ${chargeId} is not collectible (status=${verifyCharge.status}, refunded=${verifyCharge.refunded ?? false}, amount_refunded=${refundedAmount}). This is usually an idempotent retry of a previously compensated charge — change the amount or wait for the prior charge to clear, then retry.`,
              stripe_charge_id: chargeId,
            },
            { status: 409 },
          );
        }
      } catch (err) {
        const message =
          err instanceof StripeRequestError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Stripe charge failed";
        return NextResponse.json(
          { success: false, error: message },
          { status: 402 },
        );
      }

      // Stripe succeeded — now apply the payment to invoices oldest-first.
      // supabase-js cannot wrap multi-row writes in a SQL transaction, so
      // if a DB write fails mid-loop we have already collected money on
      // Stripe but only partially recorded it locally. Compensate by
      // refunding the Stripe charge so the patient is never silently
      // overcharged. The compensating refund is itself idempotent (keyed
      // off the charge id) so a retry collapses to the same Stripe
      // refund object.
      let remaining = amount;
      const touched: string[] = [];
      // Snapshot every invoice + payment-row mutation so a mid-loop
      // failure can roll back to the pre-charge ledger state. supabase-js
      // doesn't expose SQL transactions, so we implement compensating
      // writes manually: any invoice we updated gets restored to its
      // prior balance/paid/status, any payment row we inserted gets
      // archived. Combined with the Stripe refund below this preserves
      // the invariant "failed charge attempts do not modify invoice
      // balances".
      const invoicePriorState: Array<{
        id: string;
        balance_amount: number;
        paid_amount: number;
        invoice_status: string;
      }> = [];
      const insertedPaymentIds: string[] = [];
      try {
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
          // Record prior state ONLY after a successful write so the
          // rollback list reflects writes we actually made.
          invoicePriorState.push({
            id: text(inv.id),
            balance_amount: bal,
            paid_amount: money(inv.paid_amount),
            invoice_status: text(inv.invoice_status) || "open",
          });
          const { data: insertedPayment, error: payErr } = await (supabase as any)
            .from("patient_invoice_payments")
            .insert({
              organization_id: organizationId,
              patient_invoice_id: inv.id,
              client_id: id,
              amount: apply,
              payment_method: "stripe",
              payment_status: "posted",
              external_payment_id: chargeId,
              memo: text(body.note) || null,
              paid_at: new Date().toISOString(),
            })
            .select("id")
            .single();
          if (payErr) throw payErr;
          if (insertedPayment?.id) insertedPaymentIds.push(String(insertedPayment.id));
          touched.push(text(inv.id));
          remaining = Math.round((remaining - apply) * 100) / 100;
        }
      } catch (persistErr) {
        const persistMessage =
          persistErr instanceof Error ? persistErr.message : String(persistErr);

        // Compensating local rollback first: restore every invoice we
        // touched to its prior balance/paid/status, then archive every
        // patient_invoice_payments row we inserted. Any failures here
        // are recorded in the audit row so AR has a manual reconciliation
        // trail.
        const rollbackErrors: Array<{ kind: string; id: string; error: string }> = [];
        for (const prior of invoicePriorState) {
          const { error: rbErr } = await (supabase as any)
            .from("patient_invoices")
            .update({
              balance_amount: prior.balance_amount,
              paid_amount: prior.paid_amount,
              invoice_status: prior.invoice_status,
              updated_at: new Date().toISOString(),
            })
            .eq("id", prior.id);
          if (rbErr) {
            rollbackErrors.push({ kind: "invoice", id: prior.id, error: rbErr.message });
          }
        }
        if (insertedPaymentIds.length > 0) {
          const { error: archErr } = await (supabase as any)
            .from("patient_invoice_payments")
            .update({
              payment_status: "voided",
              archived_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .in("id", insertedPaymentIds);
          if (archErr) {
            rollbackErrors.push({
              kind: "payment",
              id: insertedPaymentIds.join(","),
              error: archErr.message,
            });
          }
        }
        const localRollback = rollbackErrors.length === 0 ? "restored" : "partial";

        let refundOutcome = "skipped";
        let refundError: string | null = null;
        if (chargeId) {
          try {
            await refundConnectCharge({
              chargeId,
              connectedAccountId,
              reason: "requested_by_customer",
              idempotencyKey: `pb-charge-compensate-${chargeId}`,
            });
            refundOutcome = "refunded";
          } catch (refundErr) {
            refundOutcome = "failed";
            refundError =
              refundErr instanceof Error ? refundErr.message : String(refundErr);
            console.error(
              "[patient-billing.charge_card] compensating refund failed",
              { chargeId, persistMessage, refundError },
            );
          }
        }
        // Audit the failure so AR has a trail even though we return 5xx.
        await (supabase as any)
          .from("audit_logs")
          .insert({
            organization_id: organizationId,
            patient_id: id,
            event_type: "patient_billing_charge_card_persist_failed",
            event_summary: "Stripe charge captured but local posting failed",
            event_metadata: {
              stripe_charge_id: chargeId,
              stripe_payment_intent_id: paymentIntentId,
              stripe_connected_account_id: connectedAccountId,
              amount,
              persist_error: persistMessage,
              compensating_refund: refundOutcome,
              ...(refundError ? { compensating_refund_error: refundError } : {}),
              local_rollback: localRollback,
              ...(rollbackErrors.length > 0 ? { local_rollback_errors: rollbackErrors } : {}),
              rolled_back_invoice_ids: invoicePriorState.map((p) => p.id),
              voided_payment_ids: insertedPaymentIds,
              touched_invoice_ids: touched,
            },
            user_id: guard.userId,
            action: "patient_billing_charge_card_persist_failed",
            object_type: "client",
            object_id: id,
          });
        const rollbackBlurb =
          localRollback === "restored"
            ? "Local invoice balances were restored to their prior state"
            : "Local rollback was only partial — some invoices require manual reconciliation";
        const refundBlurb =
          refundOutcome === "refunded"
            ? `Stripe charge ${chargeId} was refunded`
            : `Stripe charge ${chargeId} refund ${refundOutcome === "failed" ? "FAILED" : "could not be issued"} — manual reconciliation required`;
        return NextResponse.json(
          {
            success: false,
            error: `Charge captured but local posting failed (${persistMessage}). ${rollbackBlurb}. ${refundBlurb}.`,
            stripe_charge_id: chargeId,
            compensating_refund: refundOutcome,
            local_rollback: localRollback,
          },
          { status: 500 },
        );
      }
      metadata.amount = amount;
      metadata.applied = Math.round((amount - remaining) * 100) / 100;
      metadata.invoice_ids = touched;
      metadata.stripe_charge_id = chargeId;
      metadata.stripe_payment_intent_id = paymentIntentId;
      metadata.stripe_connected_account_id = connectedAccountId;
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
