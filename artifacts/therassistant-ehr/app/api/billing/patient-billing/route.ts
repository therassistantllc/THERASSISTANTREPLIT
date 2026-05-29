/**
 * GET /api/billing/patient-billing
 *
 * "Client Billing" workqueue: self-pay balances after insurance has
 * processed. Returns one row per client (the guarantor), aggregating
 * across that client's open patient_invoices.
 *
 * Tabs:
 *   - invoice_ready       — open balance, no statement ever sent
 *   - statements_sent     — statement sent in the last 30 days
 *   - 30_days / 60_days / 90_days — aging buckets since first statement
 *   - collections_review  — any invoice with invoice_status='collections'
 *   - payment_plans       — active payment plan event recorded
 *
 * Action state (statement-sent timestamps, payment-plan rows,
 * collections flags, reminders) is reduced from audit_logs under the
 * `patient_billing_*` event prefix, mirroring the docpending pattern.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { DEFAULT_AUTOPAY_RETRY_BACKOFF_HOURS } from "@/lib/payments/autopayService";

type DbRow = Record<string, unknown>;

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

function daysSinceIso(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function agingBucket(days: number | null): "0_30" | "31_60" | "61_90" | "90_plus" {
  const d = days ?? 0;
  if (d <= 30) return "0_30";
  if (d <= 60) return "31_60";
  if (d <= 90) return "61_90";
  return "90_plus";
}

export type PatientBillingTab =
  | "invoice_ready"
  | "statements_sent"
  | "30_days"
  | "60_days"
  | "90_days"
  | "collections_review"
  | "payment_plans";

export type PatientBillingRow = {
  id: string; // client_id (aggregated)
  client_id: string;
  client_name: string;
  practice_id: string | null;
  primary_clinician_id: string | null;
  primary_clinician_name: string | null;
  payer_name: string | null;
  balance: number;
  open_invoice_count: number;
  oldest_dos: string | null;
  oldest_dos_days: number | null;
  last_statement_at: string | null;
  payment_method: string | null;
  autopay_status: "on" | "off" | "unknown";
  autopay_last_attempt_at: string | null;
  autopay_last_attempt_status: "succeeded" | "failed" | null;
  autopay_last_attempt_error: string | null;
  /**
   * When the next automatic retry of a failed autopay will fire, derived
   * from the same backoff schedule as `retryEligibleAutopayFailures`
   * (Task #669). Null unless the latest attempt failed AND the invoice
   * still has retries remaining.
   */
  autopay_next_retry_at: string | null;
  /**
   * True when the latest attempt failed AND the invoice has used up all
   * retries in the backoff schedule — i.e. no more automatic retries
   * will fire and a biller has to step in.
   */
  autopay_retries_exhausted: boolean;
  last_payment_at: string | null;
  last_payment_amount: number | null;
  next_follow_up_at: string | null;
  status: "ready" | "sent" | "collections" | "payment_plan";
  priority: "low" | "medium" | "high" | "critical";
  aging_bucket: "0_30" | "31_60" | "61_90" | "90_plus";
  has_payment_plan: boolean;
  in_collections: boolean;
  assigned_biller_id: string | null;
  carc_codes: string[];
  rarc_codes: string[];
  tabs: PatientBillingTab[];
  invoices: Array<{
    id: string;
    invoice_number: string;
    invoice_status: string;
    balance: number;
    paid: number;
    responsibility: number;
    created_at: string | null;
    dos: string | null;
    professional_claim_id: string | null;
    source: string | null;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    payment_method: string;
    payment_status: string;
    paid_at: string;
    memo: string | null;
  }>;
  communications: Array<{
    id: string;
    event_type: string;
    event_summary: string | null;
    created_at: string;
    metadata: Record<string, unknown>;
  }>;
  payment_plan: {
    created_at: string;
    monthly_amount: number | null;
    total_amount: number | null;
    months: number | null;
    note: string | null;
  } | null;
};

export type PatientBillingSummary = {
  total_count: number;
  total_dollars: number;
  oldest_age_days: number | null;
  urgent_count: number;
  autopay_failed_count: number;
  by_tab: Record<PatientBillingTab, number>;
};

const EVT = "patient_billing_";

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
    const organizationId = guard.organizationId;

    // ── Filter rail ────────────────────────────────────────────────
    const filterTab = (searchParams.get("tab") ?? "").trim() as
      | PatientBillingTab
      | "";
    const filterClinician = (searchParams.get("clinician") ?? "").trim();
    const filterPayer = (searchParams.get("payer") ?? "").trim();
    const filterClient = (searchParams.get("client") ?? "").trim();
    const filterDosFrom = (searchParams.get("dosFrom") ?? "").trim();
    const filterDosTo = (searchParams.get("dosTo") ?? "").trim();
    const filterStatus = (searchParams.get("status") ?? "").trim();
    const filterPriority = (searchParams.get("priority") ?? "").trim();
    const filterAgingBucket = (searchParams.get("agingBucket") ?? "").trim();
    const rawMin = (searchParams.get("minAmount") ?? "").trim();
    const rawMax = (searchParams.get("maxAmount") ?? "").trim();
    const filterMinAmount = rawMin === "" ? NaN : Number(rawMin);
    const filterMaxAmount = rawMax === "" ? NaN : Number(rawMax);
    const filterFollowUp = (searchParams.get("followUpDue") ?? "").trim();
    const filterPractice = (searchParams.get("practice") ?? "").trim();
    const filterAssignedBiller = (searchParams.get("assignedBiller") ?? "").trim();
    const filterCarcRarc = (searchParams.get("carcRarc") ?? "").trim().toUpperCase();
    const filterAutopayFailed = (searchParams.get("autopayFailed") ?? "").trim();

    // ── Pull open client invoices for this org ────────────────────
    const { data: invoiceRows, error: invErr } = await (supabase as any)
      .from("patient_invoices")
      .select(
        "id, client_id, professional_claim_id, era_claim_payment_id, invoice_status, invoice_number, patient_responsibility_amount, paid_amount, balance_amount, source, created_at, archived_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .in("invoice_status", ["open", "sent", "collections"]);
    if (invErr) throw invErr;

    const invoices = (invoiceRows ?? []) as DbRow[];
    if (invoices.length === 0) {
      return NextResponse.json({
        success: true,
        organizationId,
        items: [],
        summary: emptySummary(),
      });
    }

    const clientIds = [
      ...new Set(invoices.map((i) => text(i.client_id)).filter(Boolean)),
    ];
    const claimIds = [
      ...new Set(
        invoices.map((i) => text(i.professional_claim_id)).filter(Boolean),
      ),
    ];
    const eraPaymentIds = [
      ...new Set(
        invoices.map((i) => text(i.era_claim_payment_id)).filter(Boolean),
      ),
    ];

    const [
      { data: clients },
      { data: claims },
      { data: payments },
      { data: audit },
    ] = await Promise.all([
      clientIds.length
        ? supabase
            .from("clients")
            .select(
              "id, first_name, last_name, primary_provider_id, primary_clinician_user_id, organization_id, autopay_enabled, stripe_payment_method_brand, stripe_payment_method_last4",
            )
            .in("id", clientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claims")
            .select(
              "id, appointment_id, payer_profile_id, first_billed_date, total_charge, claim_status",
            )
            .in("id", claimIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      clientIds.length
        ? (supabase as any)
            .from("patient_invoice_payments")
            .select(
              "id, patient_invoice_id, client_id, amount, payment_method, payment_status, paid_at, memo",
            )
            .eq("organization_id", organizationId)
            .in("client_id", clientIds)
            .is("archived_at", null)
            .order("paid_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      clientIds.length
        ? (supabase as any)
            .from("audit_logs")
            .select(
              "id, patient_id, event_type, event_summary, event_metadata, created_at, user_id",
            )
            .eq("organization_id", organizationId)
            .in("patient_id", clientIds)
            .ilike("event_type", `${EVT}%`)
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    // CARC/RARC codes live on era_claim_payments — pull them so the
    // filter rail can narrow by adjustment reason.
    const { data: eraPayments } = eraPaymentIds.length
      ? await (supabase as any)
          .from("era_claim_payments")
          .select("id, carc_codes, rarc_codes")
          .in("id", eraPaymentIds)
      : { data: [] as DbRow[] };
    const eraById = new Map<string, DbRow>(
      ((eraPayments ?? []) as DbRow[]).map((e) => [text(e.id), e]),
    );

    // Resolve provider + payer names.
    const providerIds = [
      ...new Set(
        ((clients ?? []) as DbRow[])
          .map((c) => text(c.primary_provider_id) || text(c.primary_clinician_user_id))
          .filter(Boolean),
      ),
    ];
    const payerIds = [
      ...new Set(
        ((claims ?? []) as DbRow[])
          .map((c) => text(c.payer_profile_id))
          .filter(Boolean),
      ),
    ];

    const [{ data: providers }, { data: payerProfiles }, { data: appts }] =
      await Promise.all([
        providerIds.length
          ? supabase
              .from("providers")
              .select("id, first_name, last_name, display_name")
              .in("id", providerIds)
          : Promise.resolve({ data: [] as DbRow[] }),
        payerIds.length
          ? (supabase as any)
              .from("payer_profiles")
              .select("id, payer_name")
              .in("id", payerIds)
          : Promise.resolve({ data: [] as DbRow[] }),
        (claims ?? []).length
          ? (supabase as any)
              .from("appointments")
              .select("id, scheduled_start_at")
              .in(
                "id",
                [
                  ...new Set(
                    ((claims ?? []) as DbRow[])
                      .map((c) => text(c.appointment_id))
                      .filter(Boolean),
                  ),
                ],
              )
          : Promise.resolve({ data: [] as DbRow[] }),
      ]);

    const clientById = new Map<string, DbRow>(
      ((clients ?? []) as DbRow[]).map((c) => [text(c.id), c]),
    );
    const providerById = new Map<string, DbRow>(
      ((providers ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payerProfiles ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );
    const claimById = new Map<string, DbRow>(
      ((claims ?? []) as DbRow[]).map((c) => [text(c.id), c]),
    );
    const apptById = new Map<string, DbRow>(
      ((appts ?? []) as DbRow[]).map((a) => [text(a.id), a]),
    );

    // ── Aggregate per client ───────────────────────────────────────
    type Aggregate = {
      client_id: string;
      invoices: PatientBillingRow["invoices"];
      payments: PatientBillingRow["payments"];
      communications: PatientBillingRow["communications"];
      claim_ids: Set<string>;
      carc: Set<string>;
      rarc: Set<string>;
    };
    const byClient = new Map<string, Aggregate>();

    for (const inv of invoices) {
      const cid = text(inv.client_id);
      if (!cid) continue;
      const agg =
        byClient.get(cid) ??
        ({
          client_id: cid,
          invoices: [],
          payments: [],
          communications: [],
          claim_ids: new Set<string>(),
          carc: new Set<string>(),
          rarc: new Set<string>(),
        } as Aggregate);
      const eraId = text(inv.era_claim_payment_id);
      if (eraId) {
        const era = eraById.get(eraId);
        if (era) {
          for (const c of (era.carc_codes as string[] | null) ?? []) {
            if (c) agg.carc.add(String(c).toUpperCase());
          }
          for (const r of (era.rarc_codes as string[] | null) ?? []) {
            if (r) agg.rarc.add(String(r).toUpperCase());
          }
        }
      }
      const claimId = text(inv.professional_claim_id) || null;
      const claim = claimId ? claimById.get(claimId) : undefined;
      const apptId = claim ? text(claim.appointment_id) : "";
      const appt = apptId ? apptById.get(apptId) : undefined;
      const dosIso =
        text(appt?.scheduled_start_at) ||
        text(claim?.first_billed_date) ||
        text(inv.created_at) ||
        null;
      const dos = dosIso ? dosIso.slice(0, 10) : null;
      agg.invoices.push({
        id: text(inv.id),
        invoice_number: text(inv.invoice_number),
        invoice_status: text(inv.invoice_status),
        balance: money(inv.balance_amount),
        paid: money(inv.paid_amount),
        responsibility: money(inv.patient_responsibility_amount),
        created_at: text(inv.created_at) || null,
        dos,
        professional_claim_id: claimId,
        source: text(inv.source) || null,
      });
      if (claimId) agg.claim_ids.add(claimId);
      byClient.set(cid, agg);
    }

    for (const p of (payments ?? []) as DbRow[]) {
      const cid = text(p.client_id);
      const agg = byClient.get(cid);
      if (!agg) continue;
      agg.payments.push({
        id: text(p.id),
        amount: money(p.amount),
        payment_method: text(p.payment_method) || "manual",
        payment_status: text(p.payment_status) || "posted",
        paid_at: text(p.paid_at),
        memo: text(p.memo) || null,
      });
    }

    for (const a of (audit ?? []) as DbRow[]) {
      const cid = text(a.patient_id);
      const agg = byClient.get(cid);
      if (!agg) continue;
      agg.communications.push({
        id: text(a.id),
        event_type: text(a.event_type),
        event_summary: text(a.event_summary) || null,
        created_at: text(a.created_at),
        metadata:
          (a.event_metadata as Record<string, unknown> | null) ?? {},
      });
    }

    // ── Build rows ─────────────────────────────────────────────────
    const today = new Date();
    const allRows: PatientBillingRow[] = [];

    for (const [cid, agg] of byClient.entries()) {
      const client = clientById.get(cid);
      if (!client) continue;
      const clientName =
        [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") ||
        "Unknown client";

      const provId = text(client.primary_provider_id) || text(client.primary_clinician_user_id) || null;
      const provider = provId ? providerById.get(provId) : undefined;
      const providerName = provider
        ? text(provider.display_name) ||
          [provider.first_name, provider.last_name]
            .map(text)
            .filter(Boolean)
            .join(" ") ||
          null
        : null;

      // Choose a representative payer (first invoice with one).
      let payerName: string | null = null;
      for (const inv of agg.invoices) {
        if (!inv.professional_claim_id) continue;
        const claim = claimById.get(inv.professional_claim_id);
        const pid = claim ? text(claim.payer_profile_id) : "";
        if (pid && payerById.get(pid)) {
          payerName = text(payerById.get(pid)!.payer_name) || null;
          if (payerName) break;
        }
      }

      const balance = Math.round(
        agg.invoices.reduce((s, i) => s + i.balance, 0) * 100,
      ) / 100;

      // Oldest DOS / invoice age.
      const oldestDos = agg.invoices
        .map((i) => i.dos)
        .filter((d): d is string => Boolean(d))
        .sort()[0] ?? null;
      const oldestDosDays = oldestDos
        ? daysSinceIso(`${oldestDos}T00:00:00Z`)
        : null;

      // Reduce audit events → action state.
      let lastStatementAt: string | null = null;
      let inCollections = false;
      let writtenOff = false;
      let nextFollowUpAt: string | null = null;
      let paymentPlan: PatientBillingRow["payment_plan"] = null;

      for (const ev of agg.communications) {
        const t = ev.event_type;
        if (t === `${EVT}send_invoice` || t === `${EVT}send_reminder`) {
          if (!lastStatementAt || ev.created_at > lastStatementAt) {
            lastStatementAt = ev.created_at;
          }
        }
        if (t === `${EVT}send_to_collections_review`) inCollections = true;
        if (t === `${EVT}write_off`) writtenOff = true;
        if (t === `${EVT}create_payment_plan`) {
          const md = ev.metadata ?? {};
          paymentPlan = {
            created_at: ev.created_at,
            monthly_amount:
              md.monthly_amount != null ? Number(md.monthly_amount) : null,
            total_amount:
              md.total_amount != null ? Number(md.total_amount) : null,
            months: md.months != null ? Number(md.months) : null,
            note: text(md.note) || null,
          };
        }
        const fu = text((ev.metadata ?? {}).follow_up_at);
        if (fu) nextFollowUpAt = fu;
      }
      // Also: invoice-level 'collections' status implies in_collections.
      if (
        agg.invoices.some((i) => i.invoice_status === "collections") ||
        agg.communications.some(
          (c) => c.event_type === `${EVT}send_to_collections_review`,
        )
      ) {
        inCollections = true;
      }

      // Most recent biller user id from audit events (acts as the
      // "assigned biller" for the filter rail).
      let assignedBillerId: string | null = null;
      for (const ev of agg.communications) {
        const md = ev.metadata ?? {};
        const u = text((md as { user_id?: unknown }).user_id);
        if (u) assignedBillerId = u;
      }
      const auditWithUser = (audit ?? []).find(
        (a: DbRow) =>
          text(a.patient_id) === cid && text(a.user_id),
      );
      if (!assignedBillerId && auditWithUser) {
        assignedBillerId = text((auditWithUser as DbRow).user_id) || null;
      }

      // Latest payment.
      const sortedPayments = [...agg.payments].sort((a, b) =>
        a.paid_at < b.paid_at ? 1 : -1,
      );
      const lastPayment = sortedPayments[0] ?? null;

      // Preferred payment method = most recent posted payment's method;
      // if any was via Stripe/portal we count as autopay-eligible.
      const recentPosted = sortedPayments.find(
        (p) => p.payment_status === "posted",
      );
      const paymentMethod = recentPosted?.payment_method ?? null;
      // Source of truth for autopay enrollment is the persisted column
      // `clients.autopay_enabled` (Task #590). Audit-event fallbacks only
      // matter when the column is null (legacy rows pre-#590).
      let autopayStatus: PatientBillingRow["autopay_status"] = "unknown";
      const persistedAutopay = (client as { autopay_enabled?: boolean | null })
        .autopay_enabled;
      if (persistedAutopay === true) {
        autopayStatus = "on";
      } else if (persistedAutopay === false) {
        autopayStatus = "off";
      } else {
        const autopayEv = agg.communications.find(
          (c) => c.event_type === `${EVT}enable_autopay`,
        );
        const autopayOffEv = agg.communications
          .slice()
          .reverse()
          .find((c) => c.event_type === `${EVT}disable_autopay`);
        if (autopayOffEv && (!autopayEv || autopayOffEv.created_at > autopayEv.created_at)) {
          autopayStatus = "off";
        } else if (autopayEv) {
          autopayStatus = "on";
        } else if (paymentMethod === "card" || paymentMethod === "stripe") {
          autopayStatus = "off";
        }
      }

      // Autopay last-attempt status (Task #590): scan the most recent
      // patient_billing_autopay_* event so the UI can flag failed
      // auto-charges that need biller attention.
      let autopayLastAttemptAt: string | null = null;
      let autopayLastAttemptStatus: "succeeded" | "failed" | null = null;
      let autopayLastAttemptError: string | null = null;
      let autopayLastAttemptInvoiceId: string | null = null;
      for (const ev of agg.communications) {
        if (
          ev.event_type === `${EVT}autopay_succeeded` ||
          ev.event_type === `${EVT}autopay_failed`
        ) {
          if (!autopayLastAttemptAt || ev.created_at > autopayLastAttemptAt) {
            autopayLastAttemptAt = ev.created_at;
            autopayLastAttemptStatus =
              ev.event_type === `${EVT}autopay_succeeded` ? "succeeded" : "failed";
            const md = ev.metadata ?? {};
            autopayLastAttemptError =
              autopayLastAttemptStatus === "failed"
                ? text((md as { error_message?: unknown }).error_message) || null
                : null;
            autopayLastAttemptInvoiceId =
              text((md as { patient_invoice_id?: unknown }).patient_invoice_id) ||
              null;
          }
        }
      }

      // Next auto-retry window (Task #731): reuse the same backoff
      // schedule as `retryEligibleAutopayFailures` so billers see when
      // the cron will retry on its own, or when retries are exhausted
      // and they need to step in manually. Only meaningful when the
      // latest attempt failed and we can tie it back to a specific
      // invoice via event_metadata.patient_invoice_id (newer rows).
      let autopayNextRetryAt: string | null = null;
      let autopayRetriesExhausted = false;
      if (
        autopayLastAttemptStatus === "failed" &&
        autopayLastAttemptAt &&
        autopayLastAttemptInvoiceId
      ) {
        const backoff = DEFAULT_AUTOPAY_RETRY_BACKOFF_HOURS;
        const maxAttempts = backoff.length + 1; // original + N retries
        const attemptCount = agg.communications.filter((c) => {
          if (
            c.event_type !== `${EVT}autopay_succeeded` &&
            c.event_type !== `${EVT}autopay_failed`
          ) {
            return false;
          }
          const mid = text(
            (c.metadata as { patient_invoice_id?: unknown } | null)
              ?.patient_invoice_id,
          );
          return mid === autopayLastAttemptInvoiceId;
        }).length;
        if (attemptCount >= maxAttempts) {
          autopayRetriesExhausted = true;
        } else if (attemptCount >= 1) {
          const hours = backoff[attemptCount - 1];
          if (typeof hours === "number" && Number.isFinite(hours)) {
            const lastMs = new Date(autopayLastAttemptAt).getTime();
            if (Number.isFinite(lastMs)) {
              autopayNextRetryAt = new Date(
                lastMs + hours * 3600 * 1000,
              ).toISOString();
            }
          }
        }
      }

      // Tab classification.
      const tabs: PatientBillingTab[] = [];
      const daysSinceStatement = lastStatementAt
        ? daysSinceIso(lastStatementAt) ?? 0
        : null;

      if (paymentPlan) tabs.push("payment_plans");
      if (inCollections) tabs.push("collections_review");
      if (!lastStatementAt && balance > 0 && !inCollections && !paymentPlan) {
        tabs.push("invoice_ready");
      }
      if (lastStatementAt && daysSinceStatement != null) {
        if (daysSinceStatement <= 30) tabs.push("statements_sent");
        if (daysSinceStatement > 30 && daysSinceStatement <= 60) tabs.push("30_days");
        if (daysSinceStatement > 60 && daysSinceStatement <= 90) tabs.push("60_days");
        if (daysSinceStatement > 90) tabs.push("90_days");
      }
      if (tabs.length === 0 && balance > 0) tabs.push("invoice_ready");

      let status: PatientBillingRow["status"] = "ready";
      if (paymentPlan) status = "payment_plan";
      else if (inCollections) status = "collections";
      else if (lastStatementAt) status = "sent";

      // Priority by aging.
      const ageDays = oldestDosDays ?? daysSinceStatement ?? 0;
      let priority: PatientBillingRow["priority"] = "low";
      if (ageDays >= 90 || balance >= 500) priority = "critical";
      else if (ageDays >= 60 || balance >= 250) priority = "high";
      else if (ageDays >= 30) priority = "medium";

      // Hide rows that have been written off and have zero balance.
      if (writtenOff && balance <= 0) continue;

      allRows.push({
        id: cid,
        client_id: cid,
        client_name: clientName,
        practice_id: text(client.organization_id) || null,
        primary_clinician_id: provId,
        primary_clinician_name: providerName,
        payer_name: payerName,
        balance,
        open_invoice_count: agg.invoices.length,
        oldest_dos: oldestDos,
        oldest_dos_days: oldestDosDays,
        last_statement_at: lastStatementAt,
        payment_method: paymentMethod,
        autopay_status: autopayStatus,
        autopay_last_attempt_at: autopayLastAttemptAt,
        autopay_last_attempt_status: autopayLastAttemptStatus,
        autopay_last_attempt_error: autopayLastAttemptError,
        autopay_next_retry_at: autopayNextRetryAt,
        autopay_retries_exhausted: autopayRetriesExhausted,
        last_payment_at: lastPayment?.paid_at ?? null,
        last_payment_amount: lastPayment?.amount ?? null,
        next_follow_up_at: nextFollowUpAt,
        status,
        priority,
        aging_bucket: agingBucket(ageDays),
        has_payment_plan: !!paymentPlan,
        in_collections: inCollections,
        assigned_biller_id: assignedBillerId,
        carc_codes: Array.from(agg.carc),
        rarc_codes: Array.from(agg.rarc),
        tabs,
        invoices: agg.invoices.sort((a, b) =>
          (a.dos ?? "") < (b.dos ?? "") ? -1 : 1,
        ),
        payments: sortedPayments,
        communications: agg.communications
          .slice()
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
        payment_plan: paymentPlan,
      });
    }

    // ── Apply filter rail ──────────────────────────────────────────
    const items: PatientBillingRow[] = [];
    for (const row of allRows) {
      if (filterTab && !row.tabs.includes(filterTab)) continue;
      if (filterStatus && row.status !== filterStatus) continue;
      if (filterPractice && row.practice_id !== filterPractice) continue;
      if (filterClinician && row.primary_clinician_id !== filterClinician)
        continue;
      if (filterPayer && row.payer_name !== filterPayer) continue;
      if (filterClient && row.client_id !== filterClient) continue;
      if (filterPriority && row.priority !== filterPriority) continue;
      if (filterAgingBucket && row.aging_bucket !== filterAgingBucket) continue;
      if (filterDosFrom && (row.oldest_dos ?? "") < filterDosFrom) continue;
      if (filterDosTo && (row.oldest_dos ?? "") > filterDosTo) continue;
      if (Number.isFinite(filterMinAmount) && row.balance < filterMinAmount)
        continue;
      if (Number.isFinite(filterMaxAmount) && row.balance > filterMaxAmount)
        continue;
      if (filterFollowUp) {
        if (!row.next_follow_up_at) continue;
        if (row.next_follow_up_at.slice(0, 10) > filterFollowUp) continue;
      }
      if (filterAssignedBiller && row.assigned_biller_id !== filterAssignedBiller) {
        continue;
      }
      if (
        filterAutopayFailed === "failed" &&
        row.autopay_last_attempt_status !== "failed"
      ) {
        continue;
      }
      if (filterCarcRarc) {
        const hit =
          row.carc_codes.includes(filterCarcRarc) ||
          row.rarc_codes.includes(filterCarcRarc);
        if (!hit) continue;
      }
      items.push(row);
    }

    // ── Summary (across the whole queue, not the active slice) ─────
    const summary: PatientBillingSummary = {
      total_count: allRows.length,
      total_dollars:
        Math.round(allRows.reduce((s, r) => s + r.balance, 0) * 100) / 100,
      oldest_age_days: allRows.reduce<number | null>((max, r) => {
        if (r.oldest_dos_days == null) return max;
        if (max == null) return r.oldest_dos_days;
        return Math.max(max, r.oldest_dos_days);
      }, null),
      urgent_count: allRows.filter(
        (r) => r.priority === "critical" || r.priority === "high",
      ).length,
      autopay_failed_count: allRows.filter(
        (r) => r.autopay_last_attempt_status === "failed",
      ).length,
      by_tab: {
        invoice_ready: 0,
        statements_sent: 0,
        "30_days": 0,
        "60_days": 0,
        "90_days": 0,
        collections_review: 0,
        payment_plans: 0,
      },
    };
    for (const r of allRows) {
      for (const t of r.tabs) summary.by_tab[t] += 1;
    }

    return NextResponse.json({
      success: true,
      organizationId,
      items,
      summary,
    });
  } catch (error) {
    console.error("Client Billing API error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load client-billing worklist",
      },
      { status: 500 },
    );
  }
}

function emptySummary(): PatientBillingSummary {
  return {
    total_count: 0,
    total_dollars: 0,
    oldest_age_days: null,
    urgent_count: 0,
    autopay_failed_count: 0,
    by_tab: {
      invoice_ready: 0,
      statements_sent: 0,
      "30_days": 0,
      "60_days": 0,
      "90_days": 0,
      collections_review: 0,
      payment_plans: 0,
    },
  };
}
