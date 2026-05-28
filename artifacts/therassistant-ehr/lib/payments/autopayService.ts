/**
 * Autopay engine (Task #590).
 *
 * `clients.autopay_enabled` flips the toggle; this service is what turns
 * the toggle into an actual recurring charge. Whenever a new
 * `patient_invoices` row is created (ERA PR transfer, denied-claim
 * payback, etc.) the caller invokes `attemptAutopayForInvoice` to run an
 * off-session Stripe charge against the client's saved card.
 *
 * Success path:
 *   - chargeSavedCardForInvoice posts the payment row and decrements the
 *     invoice balance (via recordPatientInvoicePayment).
 *   - We additionally emit a `patient_billing_autopay_succeeded` audit so
 *     the Client Billing queue's communications timeline shows it.
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
import {
  sendAutopayFailureEmail,
  sendAutopayRetryNoticeEmail,
} from "@/lib/email/resend";

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
  email: string | null;
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
/** Task #736: stamped after we actually send the client an email so
 *  repeated failures on a stuck card don't re-flood their inbox. */
const AUTOPAY_FAILURE_EMAIL_EVT = "patient_billing_autopay_failure_email_sent";
/** Throttle window between consecutive failure emails for the same
 *  invoice. The retry sweep waits 24h between attempts (see
 *  `DEFAULT_AUTOPAY_RETRY_BACKOFF_HOURS`), so 20h gives the email a
 *  little grace and still pairs one email with each retry boundary. */
const AUTOPAY_FAILURE_EMAIL_THROTTLE_HOURS = 20;
/** Task #732: heads-up email before the final retry. */
const AUTOPAY_RETRY_NOTICE_EVT = "patient_billing_autopay_retry_notice_sent";

/**
 * Task #732. Right before the FINAL scheduled autopay retry runs, send
 * the client a heads-up email so they can update their saved card
 * before we re-charge it (and before a biller has to chase them
 * manually).
 *
 * Idempotency:
 *   - Looks for an existing `patient_billing_autopay_retry_notice_sent`
 *     audit row for the same (invoice, attempt). If one exists we skip
 *     the send — so re-running the cron the same day, or running it
 *     after a transient failure, will not spam the client.
 *   - The audit row is written even when Resend isn't configured / the
 *     send fails, so a future cron pass does not retry the email and
 *     accidentally spam either. Failures are logged.
 *
 * Returns the audit row insert outcome only so the caller can log;
 * never throws.
 *
 * Note: uses the shared `resolvePortalBaseUrl` defined later in this
 * file (added by Task #736) for app URL resolution.
 */
async function sendFinalRetryNoticeIfNeeded(
  supabase: SupabaseAdmin,
  args: {
    organizationId: string;
    patientInvoiceId: string;
    upcomingAttemptNumber: number;
    retryAt: string;
  },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };

  // Dedup per (invoice, attempt). We scope by the upcoming attempt
  // number so that if the retry budget were ever expanded later, a
  // brand-new "final" attempt would still warrant a fresh notice.
  try {
    const { data: existingRows } = await sb
      .from("audit_logs")
      .select("id, event_metadata")
      .eq("organization_id", args.organizationId)
      .eq("object_type", "patient_invoice")
      .eq("object_id", args.patientInvoiceId)
      .eq("event_type", AUTOPAY_RETRY_NOTICE_EVT)
      .order("created_at", { ascending: false })
      .limit(20);
    const existing = ((existingRows ?? []) as Array<{
      event_metadata?: Record<string, unknown> | null;
    }>).find((r) => {
      const md = (r.event_metadata ?? {}) as Record<string, unknown>;
      return Number(md.attempt ?? -1) === args.upcomingAttemptNumber;
    });
    if (existing) return;
  } catch (err) {
    console.warn(
      "[autopay-retry-notice] dedup lookup failed (will attempt send anyway)",
      err instanceof Error ? err.message : err,
    );
  }

  // Resolve recipient + practice name. If we can't find an email we
  // still record the audit so we don't loop on it the next pass.
  let toEmail: string | null = null;
  let patientName = "";
  let practiceName = "";
  let brand = "card";
  let last4 = "";
  let amount = 0;

  try {
    const { data: invRow } = await sb
      .from("patient_invoices")
      .select("id, client_id, balance_amount")
      .eq("organization_id", args.organizationId)
      .eq("id", args.patientInvoiceId)
      .is("archived_at", null)
      .maybeSingle();
    const invoice = invRow as
      | { id: string; client_id: string; balance_amount: number }
      | null;
    if (invoice) {
      amount = Math.round(Number(invoice.balance_amount ?? 0) * 100) / 100;
      const { data: cliRow } = await sb
        .from("clients")
        .select(
          "id, first_name, last_name, email, stripe_payment_method_brand, stripe_payment_method_last4",
        )
        .eq("organization_id", args.organizationId)
        .eq("id", invoice.client_id)
        .is("archived_at", null)
        .maybeSingle();
      const client = cliRow as {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        stripe_payment_method_brand: string | null;
        stripe_payment_method_last4: string | null;
      } | null;
      if (client) {
        toEmail = client.email?.trim() || null;
        patientName = [client.first_name, client.last_name]
          .filter(Boolean)
          .join(" ")
          .trim();
        brand = client.stripe_payment_method_brand ?? "card";
        last4 = client.stripe_payment_method_last4 ?? "";
      }
    }
    const { data: orgRow } = await sb
      .from("organizations")
      .select("name")
      .eq("id", args.organizationId)
      .maybeSingle();
    practiceName = (orgRow as { name?: string | null } | null)?.name?.trim() ?? "";
  } catch (err) {
    console.warn(
      "[autopay-retry-notice] failed to resolve recipient",
      err instanceof Error ? err.message : err,
    );
  }

  let sendResult: { ok: boolean; providerId?: string | null; error?: string } = {
    ok: false,
    error: "no_email_on_file",
  };
  if (toEmail) {
    const portalBase = resolvePortalBaseUrl();
    const portalUrl = portalBase ? `${portalBase}/portal/home` : "/portal/home";
    try {
      const r = await sendAutopayRetryNoticeEmail({
        to: toEmail,
        patientName,
        practiceName,
        amountDollars: amount,
        brand,
        last4,
        retryDate: args.retryAt,
        portalUrl,
      });
      sendResult = r.ok
        ? { ok: true, providerId: r.providerId }
        : { ok: false, error: r.error };
    } catch (err) {
      sendResult = {
        ok: false,
        error: err instanceof Error ? err.message : "send_threw",
      };
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("audit_logs").insert({
      organization_id: args.organizationId,
      object_type: "patient_invoice",
      object_id: args.patientInvoiceId,
      event_type: AUTOPAY_RETRY_NOTICE_EVT,
      event_summary: sendResult.ok
        ? `Sent final-retry heads-up email to ${toEmail}`
        : `Final-retry heads-up email NOT sent: ${sendResult.error ?? "unknown"}`,
      event_metadata: {
        patient_invoice_id: args.patientInvoiceId,
        attempt: args.upcomingAttemptNumber,
        retry_at: args.retryAt,
        to: toEmail,
        amount,
        brand,
        last4,
        ok: sendResult.ok,
        provider_id: sendResult.providerId ?? null,
        error: sendResult.ok ? null : sendResult.error ?? null,
      },
      action: AUTOPAY_RETRY_NOTICE_EVT,
    });
  } catch (err) {
    console.warn(
      "[autopay-retry-notice] audit insert failed",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Work-type for the WQ row a failed autopay attempt files. */
export const AUTOPAY_CHARGE_FAILED_WORK_TYPE = "autopay_charge_failed";

/**
 * Find an existing open `autopay_charge_failed` workqueue row for an
 * invoice. Used both to dedupe filings and to close on self-service
 * recovery (Task #674).
 *
 * Lookup is by org + work_type + open status + context_payload.patient_invoice_id.
 * We can't put `patient_invoice` into the source_object_type enum, so the
 * invoice id lives in context_payload — see workqueue-items-schema notes.
 */
async function findOpenAutopayFailureWqItem(
  supabase: SupabaseAdmin,
  organizationId: string,
  patientInvoiceId: string,
): Promise<{ id: string } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };
  const { data } = await sb
    .from("workqueue_items")
    .select("id, context_payload, status")
    .eq("organization_id", organizationId)
    .eq("work_type", AUTOPAY_CHARGE_FAILED_WORK_TYPE)
    .in("status", ["open", "in_progress", "blocked"])
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Array<{
    id: string;
    context_payload?: Record<string, unknown> | null;
  }>;
  for (const r of rows) {
    const ctx = (r.context_payload ?? {}) as Record<string, unknown>;
    if (String(ctx.patient_invoice_id ?? "") === patientInvoiceId) {
      return { id: r.id };
    }
  }
  return null;
}

/**
 * File a workqueue_items row that asks a biller to chase a failed
 * autopay charge. Idempotent — a no-op if one is already open for the
 * same invoice. Returns the row id, or null on failure (failures are
 * logged, never thrown).
 */
async function fileAutopayFailureWqItem(
  supabase: SupabaseAdmin,
  args: {
    organizationId: string;
    clientId: string;
    invoiceId: string;
    amount: number;
    brand: string;
    last4: string;
    errorCode: string;
    errorMessage: string;
  },
): Promise<string | null> {
  try {
    const existing = await findOpenAutopayFailureWqItem(
      supabase,
      args.organizationId,
      args.invoiceId,
    );
    if (existing) return existing.id;

    const isAuth = args.errorCode === "authentication_required";
    const headline = isAuth
      ? "Autopay needs client 3DS confirmation"
      : `Autopay card declined (${args.brand} •••• ${args.last4})`;
    const description = `Auto-charge of $${args.amount.toFixed(2)} failed: ${args.errorMessage}. ` +
      `Client can fix it from the portal, or you can update the card and retry from the Client Billing queue.`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("workqueue_items")
      .insert({
        organization_id: args.organizationId,
        client_id: args.clientId,
        work_type: AUTOPAY_CHARGE_FAILED_WORK_TYPE,
        status: "open",
        priority: isAuth ? "normal" : "high",
        title: headline,
        description,
        // source_object_type enum has no "patient_invoice" — use the
        // closest valid value and stash the invoice id in context.
        source_object_type: "payment_posting",
        source_object_id: args.invoiceId,
        context_payload: {
          origin: "autopay_charge_failure",
          patient_invoice_id: args.invoiceId,
          client_id: args.clientId,
          amount_dollars: args.amount,
          brand: args.brand,
          last4: args.last4,
          error_code: args.errorCode,
          error_message: args.errorMessage,
        },
      })
      .select("id")
      .single();
    if (error) {
      console.warn("[autopay] failed to file autopay_charge_failed WQ item", error.message);
      return null;
    }
    return ((data ?? null) as { id?: string } | null)?.id ?? null;
  } catch (err) {
    console.warn(
      "[autopay] file autopay_charge_failed WQ item threw",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Close any open `autopay_charge_failed` workqueue rows for an invoice.
 * Called when the client self-serves a successful charge from the
 * portal, when the biller manually charges from the queue, or when the
 * stripe webhook posts a payment to the invoice. Best-effort, swallows
 * its own errors. Returns the number of rows closed.
 */
export async function closeAutopayFailureWorkqueueItem(input: {
  organizationId: string;
  patientInvoiceId: string;
  reason: string;
  closedByUserId?: string | null;
  supabase?: SupabaseAdmin | null;
}): Promise<number> {
  const supabase = input.supabase ?? createServerSupabaseAdminClient();
  if (!supabase) return 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };
    const { data: rows } = await sb
      .from("workqueue_items")
      .select("id, context_payload")
      .eq("organization_id", input.organizationId)
      .eq("work_type", AUTOPAY_CHARGE_FAILED_WORK_TYPE)
      .in("status", ["open", "in_progress", "blocked"])
      .is("archived_at", null)
      .limit(50);
    const matches = ((rows ?? []) as Array<{
      id: string;
      context_payload?: Record<string, unknown> | null;
    }>).filter((r) => {
      const ctx = (r.context_payload ?? {}) as Record<string, unknown>;
      return String(ctx.patient_invoice_id ?? "") === input.patientInvoiceId;
    });
    if (matches.length === 0) return 0;
    const nowIso = new Date().toISOString();
    const ids = matches.map((m) => m.id);
    const { error } = await sb
      .from("workqueue_items")
      .update({
        status: "resolved",
        resolved_at: nowIso,
        resolved_by_user_id: input.closedByUserId ?? null,
        closed_at: nowIso,
        closed_by_user_id: input.closedByUserId ?? null,
        description: input.reason,
      })
      .in("id", ids);
    if (error) {
      console.warn("[autopay] closeAutopayFailureWorkqueueItem update error", error.message);
      return 0;
    }
    return ids.length;
  } catch (err) {
    console.warn(
      "[autopay] closeAutopayFailureWorkqueueItem threw",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

/**
 * Resolve the public base URL for portal deep-links emailed to clients.
 * Mirrors the portal/home route's resolver — env first, REPLIT_DEV_DOMAIN
 * as a dev fallback, otherwise null (we just omit the prefix and the
 * link becomes relative, which is better than blasting `localhost`).
 */
function resolvePortalBaseUrl(): string | null {
  const env =
    process.env.NEXT_PUBLIC_APP_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const replit = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (replit) return `https://${replit}`;
  return null;
}

function buildPortalHomeUrl(): string {
  const base = resolvePortalBaseUrl();
  return base ? `${base}/portal/home` : "/portal/home";
}

/**
 * Look up the practice/organization display name for outbound client
 * email. Best-effort — returns "your care team" if anything goes wrong
 * or the row isn't readable, so we never block the email send.
 */
async function fetchPracticeName(
  supabase: SupabaseAdmin,
  organizationId: string,
): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };
    const { data } = await sb
      .from("organizations")
      .select("name")
      .eq("id", organizationId)
      .maybeSingle();
    const name = (data as { name?: string | null } | null)?.name?.trim();
    return name || "your care team";
  } catch {
    return "your care team";
  }
}

/**
 * Throttle check (Task #736): true when we sent the client a failure
 * email for this invoice within the throttle window. Backed by an
 * audit_logs row we stamp on each successful send.
 */
async function recentFailureEmailExists(
  supabase: SupabaseAdmin,
  args: {
    organizationId: string;
    patientInvoiceId: string;
    windowHours: number;
    now: Date;
  },
): Promise<boolean> {
  try {
    const cutoff = new Date(
      args.now.getTime() - args.windowHours * 3600 * 1000,
    ).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };
    const { data } = await sb
      .from("audit_logs")
      .select("id, created_at")
      .eq("organization_id", args.organizationId)
      .eq("event_type", AUTOPAY_FAILURE_EMAIL_EVT)
      .eq("object_type", "patient_invoice")
      .eq("object_id", args.patientInvoiceId)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch {
    // If the throttle lookup itself blows up, err on the side of NOT
    // emailing (a missed nudge is better than a flood).
    return true;
  }
}

/**
 * Send the client-facing autopay failure email and stamp an audit row
 * so the throttle window starts ticking. Best-effort and isolated —
 * never throws to the caller; the WQ row and audit trail are the
 * source of truth for "what happened".
 */
async function notifyPatientOfAutopayFailure(
  supabase: SupabaseAdmin,
  args: {
    organizationId: string;
    client: ClientAutopayRow;
    invoiceId: string;
    amountDollars: number;
    brand: string;
    last4: string;
    failureCode: string;
    now: Date;
  },
): Promise<void> {
  const email = args.client.email?.trim();
  if (!email) return; // no email on file → nothing to send

  const throttled = await recentFailureEmailExists(supabase, {
    organizationId: args.organizationId,
    patientInvoiceId: args.invoiceId,
    windowHours: AUTOPAY_FAILURE_EMAIL_THROTTLE_HOURS,
    now: args.now,
  });
  if (throttled) return;

  const practiceName = await fetchPracticeName(supabase, args.organizationId);
  const patientName = [args.client.first_name, args.client.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const portalUrl = buildPortalHomeUrl();
  const failureKind =
    args.failureCode === "authentication_required"
      ? "authentication_required"
      : "card_declined";

  let sendResult:
    | { ok: true; providerId: string | null }
    | { ok: false; error: string };
  try {
    const result = await sendAutopayFailureEmail({
      to: email,
      patientName,
      practiceName,
      portalUrl,
      amountDollars: args.amountDollars,
      brand: args.brand,
      last4: args.last4,
      failureKind,
    });
    sendResult = result.ok
      ? { ok: true, providerId: result.providerId }
      : { ok: false, error: result.error };
  } catch (err) {
    sendResult = {
      ok: false,
      error: err instanceof Error ? err.message : "unknown send error",
    };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("audit_logs").insert({
      organization_id: args.organizationId,
      patient_id: args.client.id,
      event_type: AUTOPAY_FAILURE_EMAIL_EVT,
      event_summary: sendResult.ok
        ? `Emailed client about failed autopay charge ($${args.amountDollars.toFixed(2)})`
        : `Autopay failure email send failed: ${sendResult.error}`,
      event_metadata: {
        patient_invoice_id: args.invoiceId,
        amount: args.amountDollars,
        failure_kind: failureKind,
        failure_code: args.failureCode,
        to: email,
        ok: sendResult.ok,
        provider_id: sendResult.ok ? sendResult.providerId : null,
        error: sendResult.ok ? null : sendResult.error,
      },
      action: AUTOPAY_FAILURE_EMAIL_EVT,
      object_type: "patient_invoice",
      object_id: args.invoiceId,
    });
  } catch (err) {
    console.warn(
      "[autopay] failure-email audit insert threw (non-fatal)",
      err instanceof Error ? err.message : err,
    );
  }
}

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
      message: "Client invoice not found",
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
      "id, first_name, last_name, email, organization_id, autopay_enabled, " +
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
      message: "Client not found",
    };
  }
  if (!client.autopay_enabled) {
    return {
      attempted: false,
      ok: true,
      code: "skipped_autopay_off",
      message: "Autopay is off for this client",
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
  // Task #602/#674: file a workqueue row so a biller can chase it, and
  // so the portal can detect the failure and prompt the client to fix
  // their card / complete 3DS without anyone in the office having to act.
  await fileAutopayFailureWqItem(supabase, {
    organizationId: input.organizationId,
    clientId: client.id,
    invoiceId: invoice.id,
    amount: balance,
    brand,
    last4,
    errorCode: outcome.code,
    errorMessage: outcome.message,
  });
  // Task #736: also email the client directly so they don't have to
  // happen to log into the portal to learn the charge failed. Throttled
  // and best-effort — see notifyPatientOfAutopayFailure.
  await notifyPatientOfAutopayFailure(supabase, {
    organizationId: input.organizationId,
    client,
    invoiceId: invoice.id,
    amountDollars: balance,
    brand,
    last4,
    failureCode: outcome.code,
    now: new Date(),
  });
  return {
    attempted: true,
    ok: false,
    code: "failed",
    message: outcome.message,
  };
}

/**
 * Retry loop (Task #669).
 *
 * Default backoff schedule between failed autopay attempts, in hours.
 * Index N is the wait after the (N+1)-th failure: after the original
 * failure we wait 24h, then 72h, then 168h. With 3 entries the engine
 * runs the original attempt + up to 3 retries (max 4 total).
 *
 * The list is exported so a future settings UI can override it per-org;
 * the cron route currently uses the default.
 */
export const DEFAULT_AUTOPAY_RETRY_BACKOFF_HOURS = [24, 72, 168] as const;

export interface AutopayRetryDecision {
  organizationId: string;
  patientInvoiceId: string;
  /** Why we skipped, or "retried" if we ran attemptAutopayForInvoice. */
  outcome:
    | "retried"
    | "skipped_not_due"
    | "skipped_exhausted"
    | "skipped_autopay_off"
    | "skipped_no_card"
    | "skipped_recovered"
    | "skipped_invoice_closed";
  attemptCountBefore: number;
  nextRetryAt?: string | null;
  /** Set when outcome === "retried". */
  retryResult?: AutopayAttemptResult;
}

export interface AutopayRetrySummary {
  scanned: number;
  retried: number;
  skipped: number;
  succeeded: number;
  failed: number;
  decisions: AutopayRetryDecision[];
}

/**
 * Scan recent failed autopay attempts and retry the ones whose backoff
 * window has elapsed. Safe to invoke from a daily cron — idempotent
 * within a backoff window because each successful or failed run writes
 * a new audit event that resets the "last attempt at" timestamp.
 *
 * Skips, per Task #669:
 *   - client turned autopay off  (clients.autopay_enabled = false)
 *   - client removed the saved card (stripe_payment_method_id null)
 *   - invoice is already paid/voided or balance ≤ 0
 *   - the most recent autopay event is a success (already recovered)
 *   - the max retry count has been hit
 *   - the backoff window has not yet elapsed
 */
export async function retryEligibleAutopayFailures(opts: {
  organizationId?: string;
  supabase?: SupabaseAdmin | null;
  now?: Date;
  backoffHours?: readonly number[];
  /**
   * Cap on how many failed-event rows to scan per invocation. The cron
   * fans out per-org, so this only matters if a single org has produced
   * thousands of failures in the look-back window.
   */
  limit?: number;
}): Promise<AutopayRetrySummary> {
  const supabase = opts.supabase ?? createServerSupabaseAdminClient();
  const empty: AutopayRetrySummary = {
    scanned: 0,
    retried: 0,
    skipped: 0,
    succeeded: 0,
    failed: 0,
    decisions: [],
  };
  if (!supabase) return empty;

  const backoff =
    opts.backoffHours && opts.backoffHours.length > 0
      ? opts.backoffHours
      : DEFAULT_AUTOPAY_RETRY_BACKOFF_HOURS;
  const maxAttempts = backoff.length + 1; // original + N retries
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  // Look-back must cover the longest possible backoff plus a small grace
  // so a failure that landed right before the window edge still gets
  // its final retry.
  const lookBackHours = backoff.reduce((a, b) => a + b, 0) + 24;
  const cutoffIso = new Date(nowMs - lookBackHours * 3600 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as unknown as { from: (t: string) => any };

  // Pull recent autopay audit events across both success + failure so
  // we can correctly identify "already recovered" invoices (latest event
  // is a success → do not retry).
  let q = sb
    .from("audit_logs")
    .select("organization_id, object_id, event_type, created_at, event_metadata")
    .in("event_type", [AUTOPAY_SUCCESS_EVT, AUTOPAY_FAILURE_EVT])
    .eq("object_type", "patient_invoice")
    .gte("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 5000);
  if (opts.organizationId) q = q.eq("organization_id", opts.organizationId);

  const { data: evRows, error } = await q;
  if (error) {
    console.warn("[autopay-retry] audit_logs scan failed", error.message);
    return empty;
  }

  interface EvRow {
    organization_id: string;
    object_id: string;
    event_type: string;
    created_at: string;
    event_metadata: Record<string, unknown> | null;
  }
  const events = (evRows ?? []) as EvRow[];

  // Group by (org, invoice). Events are already ASC by created_at, so
  // the last entry per group is the most recent attempt.
  const groups = new Map<string, EvRow[]>();
  for (const ev of events) {
    if (!ev.object_id || !ev.organization_id) continue;
    const key = `${ev.organization_id}::${ev.object_id}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(ev);
  }

  const summary: AutopayRetrySummary = {
    scanned: groups.size,
    retried: 0,
    skipped: 0,
    succeeded: 0,
    failed: 0,
    decisions: [],
  };

  for (const [, evList] of groups) {
    const latest = evList[evList.length - 1];
    const organizationId = latest.organization_id;
    const patientInvoiceId = latest.object_id;

    // Count the full autopay history for this invoice, not just the
    // window-bounded slice. The look-back filter above is fine for
    // *finding* candidates (the latest failure must be recent enough
    // for a retry to be due), but using window-bounded `evList.length`
    // as the attempt count is unsafe: once the original failures age
    // out of the window, an already-exhausted invoice would look like
    // it had only 1 prior attempt and get retried again, violating the
    // max-attempts contract. So we run an unbounded count query for
    // this single invoice.
    const { count: fullHistoryCount, error: countErr } = await sb
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .in("event_type", [AUTOPAY_SUCCESS_EVT, AUTOPAY_FAILURE_EVT])
      .eq("object_type", "patient_invoice")
      .eq("organization_id", organizationId)
      .eq("object_id", patientInvoiceId);
    if (countErr) {
      console.warn(
        "[autopay-retry] full-history count failed",
        organizationId,
        patientInvoiceId,
        countErr.message,
      );
    }
    const attemptCountBefore =
      typeof fullHistoryCount === "number" && fullHistoryCount > 0
        ? fullHistoryCount
        : evList.length;

    const push = (
      outcome: AutopayRetryDecision["outcome"],
      extra?: Partial<AutopayRetryDecision>,
    ) => {
      summary.decisions.push({
        organizationId,
        patientInvoiceId,
        outcome,
        attemptCountBefore,
        ...extra,
      });
      if (outcome === "retried") {
        summary.retried += 1;
      } else {
        summary.skipped += 1;
      }
    };

    if (latest.event_type === AUTOPAY_SUCCESS_EVT) {
      push("skipped_recovered");
      continue;
    }

    if (attemptCountBefore >= maxAttempts) {
      push("skipped_exhausted");
      continue;
    }

    const backoffHours = backoff[attemptCountBefore - 1];
    const lastMs = new Date(latest.created_at).getTime();
    if (!Number.isFinite(lastMs)) {
      push("skipped_not_due");
      continue;
    }
    const nextRetryMs = lastMs + backoffHours * 3600 * 1000;
    if (nowMs < nextRetryMs) {
      push("skipped_not_due", { nextRetryAt: new Date(nextRetryMs).toISOString() });
      continue;
    }

    // Re-check the invoice and client state before charging again.
    // Task #669 explicitly requires that we do NOT keep emitting failed
    // audits once the client turned autopay off or removed their card —
    // attemptAutopayForInvoice would otherwise write another failure row
    // for "no saved card on file", which the cron would then keep
    // retrying forever.
    const { data: invRow } = await sb
      .from("patient_invoices")
      .select("id, client_id, invoice_status, balance_amount")
      .eq("organization_id", organizationId)
      .eq("id", patientInvoiceId)
      .is("archived_at", null)
      .maybeSingle();
    const invoice = invRow as
      | {
          id: string;
          client_id: string;
          invoice_status: string;
          balance_amount: number;
        }
      | null;
    if (
      !invoice ||
      Number(invoice.balance_amount ?? 0) <= 0 ||
      ["paid", "voided"].includes(invoice.invoice_status)
    ) {
      push("skipped_invoice_closed");
      continue;
    }

    const { data: cliRow } = await sb
      .from("clients")
      .select(
        "id, autopay_enabled, stripe_payment_method_id, stripe_customer_id, stripe_connect_account_id",
      )
      .eq("organization_id", organizationId)
      .eq("id", invoice.client_id)
      .is("archived_at", null)
      .maybeSingle();
    const client = cliRow as
      | {
          autopay_enabled: boolean;
          stripe_payment_method_id: string | null;
          stripe_customer_id: string | null;
          stripe_connect_account_id: string | null;
        }
      | null;
    if (!client || !client.autopay_enabled) {
      push("skipped_autopay_off");
      continue;
    }
    if (
      !client.stripe_payment_method_id ||
      !client.stripe_customer_id ||
      !client.stripe_connect_account_id
    ) {
      push("skipped_no_card");
      continue;
    }

    // Task #732: if this retry is the FINAL one in the schedule, send
    // the client a heads-up email first so they have a chance to
    // update their card before we re-charge it. Dedupe per (invoice,
    // upcoming attempt) lives inside sendFinalRetryNoticeIfNeeded.
    const upcomingAttemptNumber = attemptCountBefore + 1;
    if (upcomingAttemptNumber === maxAttempts) {
      await sendFinalRetryNoticeIfNeeded(supabase, {
        organizationId,
        patientInvoiceId,
        upcomingAttemptNumber,
        retryAt: new Date(nextRetryMs).toISOString(),
      });
    }

    const result = await attemptAutopayForInvoice({
      organizationId,
      patientInvoiceId,
      supabase,
    });
    if (result.ok && result.code === "succeeded") summary.succeeded += 1;
    else if (result.code === "failed") summary.failed += 1;
    push("retried", { retryResult: result });
  }

  return summary;
}
