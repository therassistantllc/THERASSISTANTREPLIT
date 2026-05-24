/**
 * POST /api/billing/refunds/[rowId]
 *
 * Action endpoint for the Refund / Overpayment workqueue. The rowId is
 * one of:
 *   refund:<payment_refunds.id>     — existing refund row
 *   recoup:<payment_recoupments.id> — recoupment row
 *   era:<era_claim_payments.id>     — credit-balance review row (no refund yet)
 *
 * Body:  { organizationId, action, reason? }
 *
 * Actions:
 *   approve_refund    — mark a pending refund as approved (writes audit;
 *                        for era: rows, mints a payment_refunds row first)
 *   issue_refund      — set refund_status='issued', issued_at=now()
 *   apply_to_balance  — write a note that the credit was applied to
 *                        future patient balance (cancels the refund row)
 *   dispute_refund    — set refund_status='cancelled' with reason
 *   mark_complete     — set refund_status='issued' (manual reconciliation)
 *
 * Every action writes an audit_logs entry with
 * event_type='refund_action'.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type Action =
  | "approve_refund"
  | "issue_refund"
  | "apply_to_balance"
  | "dispute_refund"
  | "mark_complete";

const VALID: Action[] = [
  "approve_refund",
  "issue_refund",
  "apply_to_balance",
  "dispute_refund",
  "mark_complete",
];

type DbRow = Record<string, any>;

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

interface Body {
  organizationId?: string;
  action?: Action;
  reason?: string;
}

interface ParsedRow {
  kind: "refund" | "recoup" | "era";
  id: string;
}

function parseRowId(rowId: string): ParsedRow | null {
  const idx = rowId.indexOf(":");
  if (idx < 0) return null;
  const kind = rowId.slice(0, idx);
  const id = rowId.slice(idx + 1);
  if (!id) return null;
  if (kind === "refund" || kind === "recoup" || kind === "era") {
    return { kind, id };
  }
  return null;
}

async function writeAudit(
  supabase: any,
  args: {
    organizationId: string;
    claimId: string | null;
    patientId: string | null;
    objectType: string;
    objectId: string | null;
    action: string;
    summary: string;
    metadata: Record<string, unknown>;
    userId: string | null;
    userRole: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
) {
  await supabase.from("audit_logs").insert({
    organization_id: args.organizationId,
    claim_id: args.claimId,
    patient_id: args.patientId,
    object_type: args.objectType,
    object_id: args.objectId,
    action: args.action,
    event_type: "refund_action",
    event_summary: args.summary,
    event_metadata: args.metadata,
    user_id: args.userId,
    user_role: args.userRole,
    before_value: args.before ?? null,
    after_value: args.after ?? null,
  });
}

/**
 * For Credit Balance Review rows we need an existing payment_refunds row
 * before most actions can run. This mints one from the era_claim_payments
 * record (overpayment amount = paid − charge).
 */
async function mintRefundFromEra(
  supabase: any,
  organizationId: string,
  eraId: string,
  actorId: string | null,
): Promise<{
  id: string;
  clientId: string | null;
  claimId: string | null;
  reused: boolean;
} | null> {
  const { data: era } = await supabase
    .from("era_claim_payments")
    .select(
      "id, professional_claim_id, client_id, clp03_total_charge, clp04_payment_amount",
    )
    .eq("id", eraId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!era) return null;

  // Idempotency: if a non-archived refund already tracks this ERA, reuse it
  // instead of creating duplicates on repeated action clicks.
  const { data: existing } = await supabase
    .from("payment_refunds")
    .select("id, client_id, professional_claim_id")
    .eq("organization_id", organizationId)
    .eq("source_era_claim_payment_id", era.id)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      id: text(existing.id),
      clientId: text(existing.client_id) || null,
      claimId: text(existing.professional_claim_id) || null,
      reused: true,
    };
  }

  // ERA-derived refunds need a payer_profile_id (NOT NULL on join paths);
  // pull it from the claim.
  let payerProfileId: string | null = null;
  if (era.professional_claim_id) {
    const { data: claim } = await supabase
      .from("professional_claims")
      .select("payer_profile_id")
      .eq("id", era.professional_claim_id)
      .maybeSingle();
    payerProfileId = claim ? text(claim.payer_profile_id) || null : null;
  }

  const charge = Number(era.clp03_total_charge ?? 0);
  const paid = Number(era.clp04_payment_amount ?? 0);
  const amount = Math.max(0.01, Math.round((paid - charge) * 100) / 100);
  const { data: created, error } = await supabase
    .from("payment_refunds")
    .insert({
      organization_id: organizationId,
      refund_type: "insurance",
      source_era_claim_payment_id: era.id,
      client_id: era.client_id,
      professional_claim_id: era.professional_claim_id,
      payer_profile_id: payerProfileId,
      amount,
      reason: "Credit-balance review — payer overpayment",
      refund_status: "pending",
      requested_by_actor_id: actorId,
    })
    .select("id")
    .single();
  if (error) throw error;
  return {
    id: text((created as any).id),
    clientId: text(era.client_id) || null,
    claimId: text(era.professional_claim_id) || null,
    reused: false,
  };
}

// ─── GET — ledger detail for one refund/recoup/era row ─────────────────────
//
// Returns the real posted-payment ledger so billers can verify the credit
// before issuing:
//   - paymentHistory: every era_posting_ledger_entries, client_payments,
//     patient_invoice_payments, and payment_refunds row tied to the source
//     claim (and, for patient credits, the source client_payment).
//   - creditSource: the originating ERA's CARC/RARC + CAS breakdown plus
//     any prior refunds linked to the same source payment.
export interface LedgerEntry {
  id: string;
  kind:
    | "era_posting"
    | "client_payment"
    | "patient_invoice_payment"
    | "refund";
  postedAt: string | null;
  amount: number;
  description: string;
  status: string | null;
  reasonCode: string | null;
  source: string | null;
}

interface CasAdjustmentRow {
  groupCode: string;
  reasonCode: string;
  amount: number;
  quantity: number | null;
}

interface CreditSourcePayload {
  kind: "era" | "client_payment" | "none";
  era: {
    id: string;
    checkEftNumber: string | null;
    checkIssueDate: string | null;
    payerClaimControlNumber: string | null;
    payerTraceNumber: string | null;
    totalCharge: number;
    paymentAmount: number;
    patientResponsibility: number;
    allowedAmount: number | null;
    carcCodes: string[];
    rarcCodes: string[];
    casAdjustments: CasAdjustmentRow[];
  } | null;
  clientPayment: {
    id: string;
    amount: number;
    postedAt: string | null;
    method: string | null;
    referenceNumber: string | null;
    sourceLabel: string | null;
  } | null;
  priorRefunds: Array<{
    id: string;
    amount: number;
    status: string;
    requestedAt: string | null;
    issuedAt: string | null;
    reason: string | null;
  }>;
}

function normaliseCas(value: unknown): CasAdjustmentRow[] {
  if (!Array.isArray(value)) return [];
  const out: CasAdjustmentRow[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const group =
      text(r.group_code) || text(r.groupCode) || text(r.cas01) || "";
    const reason =
      text(r.reason_code) || text(r.reasonCode) || text(r.cas02) || "";
    const amt = Number(r.amount ?? r.cas03 ?? 0);
    const qty = r.quantity ?? r.cas04;
    if (!group && !reason && !Number.isFinite(amt)) continue;
    out.push({
      groupCode: group,
      reasonCode: reason,
      amount: Number.isFinite(amt) ? Math.round(amt * 100) / 100 : 0,
      quantity:
        qty === null || qty === undefined || qty === ""
          ? null
          : Number.isFinite(Number(qty))
            ? Number(qty)
            : null,
    });
  }
  return out;
}

async function resolveSourceContext(
  supabase: any,
  organizationId: string,
  parsed: ParsedRow,
): Promise<{
  claimId: string | null;
  clientId: string | null;
  eraId: string | null;
  clientPaymentId: string | null;
  selfRefundId: string | null;
} | null> {
  if (parsed.kind === "era") {
    const { data: era } = await supabase
      .from("era_claim_payments")
      .select("id, professional_claim_id, client_id")
      .eq("id", parsed.id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!era) return null;
    return {
      claimId: text(era.professional_claim_id) || null,
      clientId: text(era.client_id) || null,
      eraId: text(era.id),
      clientPaymentId: null,
      selfRefundId: null,
    };
  }
  if (parsed.kind === "recoup") {
    const { data: rec } = await supabase
      .from("payment_recoupments")
      .select(
        "id, professional_claim_id, client_id, source_era_claim_payment_id, source_client_payment_id",
      )
      .eq("id", parsed.id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!rec) return null;
    return {
      claimId: text(rec.professional_claim_id) || null,
      clientId: text(rec.client_id) || null,
      eraId: text(rec.source_era_claim_payment_id) || null,
      clientPaymentId: text(rec.source_client_payment_id) || null,
      selfRefundId: null,
    };
  }
  // refund
  const { data: refund } = await supabase
    .from("payment_refunds")
    .select(
      "id, professional_claim_id, client_id, source_era_claim_payment_id, source_client_payment_id",
    )
    .eq("id", parsed.id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!refund) return null;
  return {
    claimId: text(refund.professional_claim_id) || null,
    clientId: text(refund.client_id) || null,
    eraId: text(refund.source_era_claim_payment_id) || null,
    clientPaymentId: text(refund.source_client_payment_id) || null,
    selfRefundId: text(refund.id),
  };
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ rowId: string }> },
) {
  try {
    const { rowId: rawRowId } = await ctx.params;
    const rowId = decodeURIComponent(rawRowId);
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const parsed = parseRowId(rowId);
    if (!parsed) {
      return NextResponse.json(
        { success: false, error: "Invalid row id" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const ctxIds = await resolveSourceContext(
      supabase as any,
      organizationId,
      parsed,
    );
    if (!ctxIds) {
      return NextResponse.json(
        { success: false, error: "Row not found" },
        { status: 404 },
      );
    }

    // ── Payment history (real ledger rows) ───────────────────────────────
    const eraEntriesP =
      ctxIds.claimId || ctxIds.eraId
        ? (supabase as any)
            .from("era_posting_ledger_entries")
            .select(
              "id, entry_type, amount, posted_at, description, reason_code, group_code, source_segment, source_type, era_claim_payment_id, professional_claim_id",
            )
            .eq("organization_id", organizationId)
            .is("archived_at", null)
            .or(
              [
                ctxIds.claimId
                  ? `professional_claim_id.eq.${ctxIds.claimId}`
                  : null,
                ctxIds.eraId
                  ? `era_claim_payment_id.eq.${ctxIds.eraId}`
                  : null,
              ]
                .filter(Boolean)
                .join(","),
            )
            .order("posted_at", { ascending: false })
            .limit(500)
        : Promise.resolve({ data: [] as DbRow[] });

    const clientPaymentsP = ctxIds.claimId
      ? (supabase as any)
          .from("client_payments")
          .select(
            "id, amount, posted_at, payment_method, posting_status, reference_number, source_label, note, claim_id",
          )
          .eq("organization_id", organizationId)
          .eq("claim_id", ctxIds.claimId)
          .is("archived_at", null)
          .order("posted_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] as DbRow[] });

    // patient_invoice_payments link to invoices, not directly to a claim.
    // Pull the invoices for this claim first, then their payments.
    const invoicesP = ctxIds.claimId
      ? (supabase as any)
          .from("patient_invoices")
          .select("id, invoice_number")
          .eq("organization_id", organizationId)
          .eq("professional_claim_id", ctxIds.claimId)
          .is("archived_at", null)
      : Promise.resolve({ data: [] as DbRow[] });

    const refundsForClaimP = ctxIds.claimId
      ? (supabase as any)
          .from("payment_refunds")
          .select(
            "id, amount, refund_status, refund_type, requested_at, issued_at, reason, note, source_era_claim_payment_id, source_client_payment_id",
          )
          .eq("organization_id", organizationId)
          .eq("professional_claim_id", ctxIds.claimId)
          .is("archived_at", null)
          .order("requested_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] as DbRow[] });

    const eraSourceP = ctxIds.eraId
      ? (supabase as any)
          .from("era_claim_payments")
          .select(
            "id, check_eft_number, check_issue_date, payer_claim_control_number, payer_trace_number, clp03_total_charge, clp04_payment_amount, clp05_patient_responsibility, allowed_amount, carc_codes, rarc_codes, cas_adjustments",
          )
          .eq("id", ctxIds.eraId)
          .eq("organization_id", organizationId)
          .maybeSingle()
      : Promise.resolve({ data: null });

    const clientPaymentSourceP = ctxIds.clientPaymentId
      ? (supabase as any)
          .from("client_payments")
          .select(
            "id, amount, posted_at, payment_method, reference_number, source_label",
          )
          .eq("id", ctxIds.clientPaymentId)
          .eq("organization_id", organizationId)
          .maybeSingle()
      : Promise.resolve({ data: null });

    const [
      { data: eraEntries },
      { data: claimClientPayments },
      { data: invoices },
      { data: refundRows },
      { data: eraSource },
      { data: clientPaymentSource },
    ] = await Promise.all([
      eraEntriesP,
      clientPaymentsP,
      invoicesP,
      refundsForClaimP,
      eraSourceP,
      clientPaymentSourceP,
    ]);

    const invoiceIds = ((invoices as DbRow[]) ?? [])
      .map((i) => text(i.id))
      .filter(Boolean);
    const invoiceNumberById = new Map<string, string>(
      ((invoices as DbRow[]) ?? []).map((i) => [
        text(i.id),
        text(i.invoice_number) || "",
      ]),
    );

    const { data: invoicePayments } = invoiceIds.length
      ? await (supabase as any)
          .from("patient_invoice_payments")
          .select(
            "id, amount, paid_at, payment_method, payment_status, memo, patient_invoice_id",
          )
          .eq("organization_id", organizationId)
          .in("patient_invoice_id", invoiceIds)
          .is("archived_at", null)
          .order("paid_at", { ascending: false })
          .limit(200)
      : { data: [] as DbRow[] };

    const ledger: LedgerEntry[] = [];

    for (const e of (eraEntries as DbRow[]) ?? []) {
      const segment = text(e.source_segment);
      const grp = text(e.group_code);
      const reason = text(e.reason_code);
      const parts = [
        text(e.entry_type) || "ERA entry",
        segment ? `(${segment})` : "",
        grp && reason ? `${grp}/${reason}` : grp || reason,
        text(e.description),
      ].filter(Boolean);
      ledger.push({
        id: `era_entry:${text(e.id)}`,
        kind: "era_posting",
        postedAt: text(e.posted_at) || null,
        amount: money(e.amount),
        description: parts.join(" · ") || "ERA ledger entry",
        status: "posted",
        reasonCode: reason || grp || null,
        source: text(e.source_type) || "era",
      });
    }
    for (const p of (claimClientPayments as DbRow[]) ?? []) {
      const bits = [
        text(p.payment_method) || "client payment",
        text(p.source_label),
        text(p.reference_number) ? `ref ${text(p.reference_number)}` : "",
      ].filter(Boolean);
      ledger.push({
        id: `client_payment:${text(p.id)}`,
        kind: "client_payment",
        postedAt: text(p.posted_at) || null,
        amount: money(p.amount),
        description: bits.join(" · "),
        status: text(p.posting_status) || null,
        reasonCode: null,
        source: text(p.source_label) || text(p.payment_method) || null,
      });
    }
    for (const p of (invoicePayments as DbRow[]) ?? []) {
      const invNum = invoiceNumberById.get(text(p.patient_invoice_id)) || "";
      const bits = [
        text(p.payment_method) || "patient payment",
        invNum ? `invoice ${invNum}` : "",
        text(p.memo),
      ].filter(Boolean);
      ledger.push({
        id: `invoice_payment:${text(p.id)}`,
        kind: "patient_invoice_payment",
        postedAt: text(p.paid_at) || null,
        amount: money(p.amount),
        description: bits.join(" · "),
        status: text(p.payment_status) || null,
        reasonCode: null,
        source: "patient invoice",
      });
    }
    for (const r of (refundRows as DbRow[]) ?? []) {
      ledger.push({
        id: `refund:${text(r.id)}`,
        kind: "refund",
        postedAt: text(r.issued_at) || text(r.requested_at) || null,
        // Refunds reduce the credit on the claim — render as a negative
        // so the ledger totals correctly without callers having to know
        // the row kind.
        amount: -money(r.amount),
        description:
          (text(r.refund_type) === "patient"
            ? "Patient refund"
            : "Payer refund") +
          (text(r.reason) ? ` · ${text(r.reason)}` : ""),
        status: text(r.refund_status) || null,
        reasonCode: null,
        source: text(r.refund_type) || "refund",
      });
    }

    ledger.sort((a, b) => {
      const at = a.postedAt ? Date.parse(a.postedAt) : 0;
      const bt = b.postedAt ? Date.parse(b.postedAt) : 0;
      return bt - at;
    });

    // ── Credit source ────────────────────────────────────────────────────
    const priorRefunds = ((refundRows as DbRow[]) ?? [])
      .filter((r) => {
        if (ctxIds.selfRefundId && text(r.id) === ctxIds.selfRefundId) {
          return false;
        }
        if (
          ctxIds.eraId &&
          text(r.source_era_claim_payment_id) === ctxIds.eraId
        ) {
          return true;
        }
        if (
          ctxIds.clientPaymentId &&
          text(r.source_client_payment_id) === ctxIds.clientPaymentId
        ) {
          return true;
        }
        return false;
      })
      .map((r) => ({
        id: text(r.id),
        amount: money(r.amount),
        status: text(r.refund_status) || "pending",
        requestedAt: text(r.requested_at) || null,
        issuedAt: text(r.issued_at) || null,
        reason: text(r.reason) || text(r.note) || null,
      }));

    const creditSource: CreditSourcePayload = {
      kind: eraSource ? "era" : clientPaymentSource ? "client_payment" : "none",
      era: eraSource
        ? {
            id: text((eraSource as any).id),
            checkEftNumber: text((eraSource as any).check_eft_number) || null,
            checkIssueDate: text((eraSource as any).check_issue_date) || null,
            payerClaimControlNumber:
              text((eraSource as any).payer_claim_control_number) || null,
            payerTraceNumber:
              text((eraSource as any).payer_trace_number) || null,
            totalCharge: money((eraSource as any).clp03_total_charge),
            paymentAmount: money((eraSource as any).clp04_payment_amount),
            patientResponsibility: money(
              (eraSource as any).clp05_patient_responsibility,
            ),
            allowedAmount:
              (eraSource as any).allowed_amount == null
                ? null
                : money((eraSource as any).allowed_amount),
            carcCodes: Array.isArray((eraSource as any).carc_codes)
              ? (eraSource as any).carc_codes
              : [],
            rarcCodes: Array.isArray((eraSource as any).rarc_codes)
              ? (eraSource as any).rarc_codes
              : [],
            casAdjustments: normaliseCas((eraSource as any).cas_adjustments),
          }
        : null,
      clientPayment: clientPaymentSource
        ? {
            id: text((clientPaymentSource as any).id),
            amount: money((clientPaymentSource as any).amount),
            postedAt: text((clientPaymentSource as any).posted_at) || null,
            method: text((clientPaymentSource as any).payment_method) || null,
            referenceNumber:
              text((clientPaymentSource as any).reference_number) || null,
            sourceLabel:
              text((clientPaymentSource as any).source_label) || null,
          }
        : null,
      priorRefunds,
    };

    return NextResponse.json({
      success: true,
      claimId: ctxIds.claimId,
      paymentHistory: ledger,
      creditSource,
    });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Failed to load detail",
      },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ rowId: string }> },
) {
  try {
    const { rowId: rawRowId } = await ctx.params;
    const rowId = decodeURIComponent(rawRowId);
    const body = (await request.json().catch(() => ({}))) as Body;

    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const action = body.action;
    if (!action || !VALID.includes(action)) {
      return NextResponse.json(
        { success: false, error: `action must be one of ${VALID.join(", ")}` },
        { status: 400 },
      );
    }

    const parsed = parseRowId(rowId);
    if (!parsed) {
      return NextResponse.json(
        { success: false, error: "Invalid row id" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const reason = text(body.reason).slice(0, 1000) || null;
    const actorId = guard.staffId ?? guard.userId ?? null;

    // ── Recoupment row (Offset Requested) ────────────────────────────────
    if (parsed.kind === "recoup") {
      const { data: rec } = await (supabase as any)
        .from("payment_recoupments")
        .select(
          "id, professional_claim_id, client_id, payer_profile_id, amount, offset_era_claim_payment_id, reason",
        )
        .eq("id", parsed.id)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!rec) {
        return NextResponse.json(
          { success: false, error: "Recoupment not found" },
          { status: 404 },
        );
      }
      if (action !== "mark_complete" && action !== "dispute_refund") {
        return NextResponse.json(
          {
            success: false,
            error: "Only mark_complete or dispute_refund apply to recoupments",
          },
          { status: 400 },
        );
      }
      // Both actions archive the recoupment so the next list call removes
      // it from the Offset Requested tab (the table has no status column,
      // so archived_at is the durable resolution flag).
      await (supabase as any)
        .from("payment_recoupments")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", parsed.id)
        .eq("organization_id", organizationId);
      const after: Record<string, unknown> = {
        archived: true,
        resolution: action,
      };
      await writeAudit(supabase, {
        organizationId,
        claimId: text(rec.professional_claim_id) || null,
        patientId: text(rec.client_id) || null,
        objectType: "payment_recoupment",
        objectId: parsed.id,
        action,
        summary:
          action === "dispute_refund"
            ? "Disputed payer recoupment"
            : "Marked recoupment offset complete",
        metadata: { rowId, reason, amount: rec.amount },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
        before: rec as Record<string, unknown>,
        after,
      });
      return NextResponse.json({ success: true, action, archived: true });
    }

    // ── ERA overpayment → mint a refund row first when needed ────────────
    let refundId: string;
    let refundClaimId: string | null = null;
    let refundClientId: string | null = null;
    let mintedFromEra = false;
    let reusedExisting = false;
    if (parsed.kind === "era") {
      const minted = await mintRefundFromEra(
        supabase,
        organizationId,
        parsed.id,
        actorId,
      );
      if (!minted) {
        return NextResponse.json(
          { success: false, error: "ERA payment not found" },
          { status: 404 },
        );
      }
      refundId = minted.id;
      refundClaimId = minted.claimId;
      refundClientId = minted.clientId;
      mintedFromEra = true;
      reusedExisting = minted.reused;
    } else {
      refundId = parsed.id;
    }

    const { data: refund } = await (supabase as any)
      .from("payment_refunds")
      .select(
        "id, refund_type, client_id, professional_claim_id, payer_profile_id, amount, refund_status, reason, note, requested_at, issued_at",
      )
      .eq("id", refundId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (!refund) {
      return NextResponse.json(
        { success: false, error: "Refund not found" },
        { status: 404 },
      );
    }

    const before = { ...refund };
    refundClaimId = refundClaimId ?? (text(refund.professional_claim_id) || null);
    refundClientId = refundClientId ?? (text(refund.client_id) || null);

    // ── Mutate based on action ───────────────────────────────────────────
    let update: Record<string, unknown> | null = null;
    let summary = "";

    if (action === "approve_refund") {
      const noteLine = `[REFUND_APPROVED ${new Date().toISOString().slice(0, 10)}] ${reason ?? ""}`.trim();
      update = {
        refund_status: "pending",
        note: [text(refund.note), noteLine].filter(Boolean).join("\n"),
        updated_at: new Date().toISOString(),
      };
      summary = "Approved refund (ready to issue)";
    } else if (action === "issue_refund") {
      if (refund.refund_status === "issued") {
        return NextResponse.json(
          { success: false, error: "Refund is already issued" },
          { status: 422 },
        );
      }
      update = {
        refund_status: "issued",
        issued_at: new Date().toISOString(),
        issued_by_actor_id: actorId,
        updated_at: new Date().toISOString(),
      };
      summary = "Issued refund";
    } else if (action === "apply_to_balance") {
      const noteLine = `[APPLIED_TO_BALANCE ${new Date()
        .toISOString()
        .slice(0, 10)}] ${reason ?? "Credit applied to outstanding patient balance"}`;
      update = {
        refund_status: "cancelled",
        note: [text(refund.note), noteLine].filter(Boolean).join("\n"),
        updated_at: new Date().toISOString(),
      };
      summary = "Applied credit to balance (refund cancelled)";
    } else if (action === "dispute_refund") {
      if (!reason) {
        return NextResponse.json(
          { success: false, error: "A reason is required to dispute" },
          { status: 400 },
        );
      }
      update = {
        refund_status: "cancelled",
        note: [
          text(refund.note),
          `[DISPUTED ${new Date().toISOString().slice(0, 10)}] ${reason}`,
        ]
          .filter(Boolean)
          .join("\n"),
        updated_at: new Date().toISOString(),
      };
      summary = "Disputed refund (cancelled)";
    } else if (action === "mark_complete") {
      update = {
        refund_status: "issued",
        issued_at: refund.issued_at ?? new Date().toISOString(),
        issued_by_actor_id: actorId,
        updated_at: new Date().toISOString(),
      };
      summary = "Marked refund complete";
    }

    if (update) {
      const { error: updErr } = await (supabase as any)
        .from("payment_refunds")
        .update(update)
        .eq("id", refundId)
        .eq("organization_id", organizationId);
      if (updErr) {
        return NextResponse.json(
          { success: false, error: updErr.message },
          { status: 422 },
        );
      }
    }

    await writeAudit(supabase, {
      organizationId,
      claimId: refundClaimId,
      patientId: refundClientId,
      objectType: "payment_refund",
      objectId: refundId,
      action,
      summary,
      metadata: {
        rowId,
        reason,
        mintedFromEra,
        reusedExistingRefund: reusedExisting,
      },
      userId: guard.userId ?? null,
      userRole: guard.roles?.[0] ?? null,
      before,
      after: update,
    });

    return NextResponse.json({ success: true, action, refundId });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Action failed",
      },
      { status: 500 },
    );
  }
}
