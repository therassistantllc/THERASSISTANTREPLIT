/**
 * Autopay engine (Task #590).
 *
 * `clients.autopay_enabled` flips the toggle; this service is what turns
 * the toggle into an actual recurring charge. Whenever a new
 * `patient_invoices` row is created (ERA PR transfer, denied-claim
 * payback, etc.) the caller invokes `attemptAutopayForInvoice` to run an
 * off-session Stripe charge against the patient's saved card.
 *
 * Success path:
 *   - chargeSavedCardForInvoice posts the payment row and decrements the
 *     invoice balance (via recordPatientInvoicePayment).
 *   - We additionally emit a `patient_billing_autopay_succeeded` audit so
 *     the Patient Billing queue's communications timeline shows it.
 *
 * Failure path:
 *   - We insert a `patient_invoice_payments` row with
 *     `payment_status='failed'` so the queue's payments aggregator
 *     surfaces the failed attempt with brand/last4 in the memo.
 *   - We emit a `patient_billing_autopay_failed` audit so the row's
 *     `autopay_status` and communications list both reflect the failure.
 *
 * This module is intentionally best-effort from the caller's POV — it
 * never throws. Returning {attempted, ok, code, message} lets the
 * invoice-creation paths log/log-and-continue without blocking the
 * primary write.
 */
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { chargeSavedCardForInvoice } from "@/lib/payments/savedCardService";

type SupabaseAdmin = NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>;

export interface AutopayAttemptResult {
  /** Did we actually try to charge (vs. skip because autopay off / no card)? */
  attempted: boolean;
  ok: boolean;
  code:
    | "skipped_autopay_off"
    | "skipped_no_card"
    | "skipped_no_balance"
    | "skipped_invoice_missing"
    | "skipped_client_missing"
    | "skipped_no_organization"
    | "succeeded"
    | "failed";
  message: string;
  paymentIntentId?: string | null;
  amountCharged?: number;
}

interface ClientAutopayRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  organization_id: string;
  autopay_enabled: boolean;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  stripe_payment_method_brand: string | null;
  stripe_payment_method_last4: string | null;
  stripe_connect_account_id: string | null;
}

interface InvoiceAutopayRow {
  id: string;
  client_id: string;
  organization_id: string;
  invoice_status: string;
  balance_amount: number;
}

const AUTOPAY_SUCCESS_EVT = "patient_billing_autopay_succeeded";
const AUTOPAY_FAILURE_EVT = "patient_billing_autopay_failed";

async function writeAutopayAudit(
  supabase: SupabaseAdmin,
  args: {
    organizationId: string;
    clientId: string;
    invoiceId: string;
    success: boolean;
    summary: string;
    metadata: Record<string, unknown>;
  },
) {
  try {
    const eventType = args.success ? AUTOPAY_SUCCESS_EVT : AUTOPAY_FAILURE_EVT;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("audit_logs").insert({
      organization_id: args.organizationId,
      patient_id: args.clientId,
      event_type: eventType,
      event_summary: args.summary,
      event_metadata: { ...args.metadata, patient_invoice_id: args.invoiceId },
      action: eventType,
      object_type: "patient_invoice",
      object_id: args.invoiceId,
    });
  } catch (err) {
    console.warn(
      "[autopay] audit_logs insert failed (non-fatal)",
      err instanceof Error ? err.message : err,
    );
  }
}

async function recordFailedAttempt(
  supabase: SupabaseAdmin,
  args: {
    organizationId: string;
    clientId: string;
    invoiceId: string;
    amount: number;
    memo: string;
  },
) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("patient_invoice_payments")
      .insert({
        organization_id: args.organizationId,
        client_id: args.clientId,
        patient_invoice_id: args.invoiceId,
        amount: args.amount,
        payment_method: "stripe",
        payment_status: "failed",
        memo: args.memo,
        paid_at: new Date().toISOString(),
      });
    if (error) {
      console.warn(
        "[autopay] failed-attempt patient_invoice_payments insert error",
        error.message,
      );
    }
  } catch (err) {
    console.warn(
      "[autopay] failed-attempt patient_invoice_payments insert threw",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Attempt to auto-charge an invoice's open balance against the saved
 * card. Safe to call from any invoice-creation path — never throws,
 * always returns a structured result.
 */
export async function attemptAutopayForInvoice(input: {
  organizationId: string;
  patientInvoiceId: string;
  supabase?: SupabaseAdmin | null;
}): Promise<AutopayAttemptResult> {
  if (!input.organizationId) {
    return {
      attempted: false,
      ok: false,
      code: "skipped_no_organization",
      message: "organizationId is required",
    };
  }
  const supabase = input.supabase ?? createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      attempted: false,
      ok: false,
      code: "skipped_invoice_missing",
      message: "Database unavailable",
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };

  const { data: invRow } = await sb
    .from("patient_invoices")
    .select("id, client_id, organization_id, invoice_status, balance_amount")
    .eq("organization_id", input.organizationId)
    .eq("id", input.patientInvoiceId)
    .is("archived_at", null)
    .maybeSingle();
  const invoice = invRow as InvoiceAutopayRow | null;
  if (!invoice) {
    return {
      attempted: false,
      ok: false,
      code: "skipped_invoice_missing",
      message: "Patient invoice not found",
    };
  }

  const balance = Math.round(Number(invoice.balance_amount ?? 0) * 100) / 100;
  if (!Number.isFinite(balance) || balance <= 0) {
    return {
      attempted: false,
      ok: true,
      code: "skipped_no_balance",
      message: "Invoice has no open balance to auto-charge",
    };
  }
  // Stripe minimum is $0.50; let chargeSavedCardForInvoice do the final
  // sub-50¢ rejection so we never charge below the floor.
  if (["paid", "voided"].includes(invoice.invoice_status)) {
    return {
      attempted: false,
      ok: true,
      code: "skipped_no_balance",
      message: `Invoice already ${invoice.invoice_status}`,
    };
  }

  const { data: cliRow } = await sb
    .from("clients")
    .select(
      "id, first_name, last_name, organization_id, autopay_enabled, " +
        "stripe_customer_id, stripe_payment_method_id, " +
        "stripe_payment_method_brand, stripe_payment_method_last4, " +
        "stripe_connect_account_id",
    )
    .eq("organization_id", input.organizationId)
    .eq("id", invoice.client_id)
    .is("archived_at", null)
    .maybeSingle();
  const client = cliRow as ClientAutopayRow | null;
  if (!client) {
    return {
      attempted: false,
      ok: false,
      code: "skipped_client_missing",
      message: "Patient not found",
    };
  }
  if (!client.autopay_enabled) {
    return {
      attempted: false,
      ok: true,
      code: "skipped_autopay_off",
      message: "Autopay is off for this patient",
    };
  }
  if (
    !client.stripe_customer_id ||
    !client.stripe_payment_method_id ||
    !client.stripe_connect_account_id
  ) {
    // Autopay flag is on but the saved card was detached after enabling.
    // Surface as a failed attempt so the biller sees it in the queue.
    await recordFailedAttempt(supabase, {
      organizationId: input.organizationId,
      clientId: client.id,
      invoiceId: invoice.id,
      amount: balance,
      memo: "Autopay attempt skipped — no saved card on file.",
    });
    await writeAutopayAudit(supabase, {
      organizationId: input.organizationId,
      clientId: client.id,
      invoiceId: invoice.id,
      success: false,
      summary: "Autopay skipped — no saved card on file.",
      metadata: { amount: balance, reason: "no_saved_card" },
    });
    return {
      attempted: false,
      ok: false,
      code: "skipped_no_card",
      message: "Autopay is on but no card is saved.",
    };
  }

  const brand = client.stripe_payment_method_brand ?? "card";
  const last4 = client.stripe_payment_method_last4 ?? "";

  const outcome = await chargeSavedCardForInvoice({
    organizationId: input.organizationId,
    clientId: client.id,
    patientInvoiceId: invoice.id,
    amountDollars: balance,
    memo: `Autopay: charged saved ${brand} •••• ${last4}`.trim(),
    metadataExtra: { origin: "autopay" },
  });

  if (outcome.ok) {
    await writeAutopayAudit(supabase, {
      organizationId: input.organizationId,
      clientId: client.id,
      invoiceId: invoice.id,
      success: true,
      summary: `Autopay charged ${brand} •••• ${last4} for $${balance.toFixed(2)}`,
      metadata: {
        amount: balance,
        stripe_payment_intent_id: outcome.paymentIntentId,
        brand,
        last4,
      },
    });
    return {
      attempted: true,
      ok: true,
      code: "succeeded",
      message: "Autopay charge succeeded.",
      paymentIntentId: outcome.paymentIntentId,
      amountCharged: balance,
    };
  }

  await recordFailedAttempt(supabase, {
    organizationId: input.organizationId,
    clientId: client.id,
    invoiceId: invoice.id,
    amount: balance,
    memo: `Autopay failed (${outcome.code}): ${outcome.message}`,
  });
  await writeAutopayAudit(supabase, {
    organizationId: input.organizationId,
    clientId: client.id,
    invoiceId: invoice.id,
    success: false,
    summary: `Autopay charge failed: ${outcome.message}`,
    metadata: {
      amount: balance,
      error_code: outcome.code,
      error_message: outcome.message,
      brand,
      last4,
    },
  });
  return {
    attempted: true,
    ok: false,
    code: "failed",
    message: outcome.message,
  };
}
