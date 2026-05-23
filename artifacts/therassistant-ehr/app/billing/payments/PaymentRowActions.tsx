"use client";

/**
 * Row-level action menu for the master payments dashboard (Task #133 / PP-4).
 *
 * Renders a compact "Actions ▾" popover per posted-payment row that opens the
 * five destructive/finalising flows the biller used to have to curl directly:
 *   - Issue refund (insurance or patient)
 *   - Reverse posted payment
 *   - Void (no financial impact)
 *   - Record recoupment (payer takeback)
 *   - Confirm pending insurance refund (two-step issuance)
 *
 * Each flow renders a focused modal that fetches the detail payload
 * (totalImpact + prior refunds/recoupments + pending refund rows) on open so
 * we can validate against the *remaining refundable balance* client-side
 * before submitting, and surface Stripe-issued vs pending status on success.
 *
 * Side-effect: on every successful action we call `onChanged()` so the parent
 * dashboard can refresh totals + row state.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

type ActionKind = "refund" | "reverse" | "void" | "recoup" | "confirm-refund";

interface RowSummary {
  id: string; // composite (era:|cp:|mi: + uuid)
  paymentType: "insurance" | "patient";
  postingStatus: string;
  amount: number;
  payerName: string | null;
  source: "era" | "manual_insurance" | "patient";
}

interface DetailResponse {
  success: boolean;
  kind: "era_835" | "client_payment" | "insurance_manual";
  postingStatus: string;
  totalImpact: number;
  professionalClaimId: string | null;
  patientInvoice: {
    invoice_number?: string;
    balance_amount?: number;
    paid_amount?: number;
  } | null;
  refunds: Array<{
    id: string;
    refund_type: "insurance" | "patient";
    amount: number;
    refund_status: "pending" | "issued" | "failed" | "cancelled";
    reason: string;
    stripe_refund_id: string | null;
    requested_at: string;
    issued_at: string | null;
  }>;
  recoupments: Array<{ id: string; amount: number; reason: string }>;
}

function fmtMoney(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export default function PaymentRowActions({
  row,
  orgId,
  onChanged,
  onFlash,
}: {
  row: RowSummary;
  orgId: string;
  onChanged: () => void;
  onFlash: (tone: "ok" | "err", msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ActionKind | null>(null);

  const close = () => {
    setActive(null);
    setOpen(false);
  };

  const isPosted = row.postingStatus === "posted";
  const isReversed = row.postingStatus === "reversed";
  const isVoided = row.postingStatus === "voided";

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: "2px 8px",
          fontSize: 12,
          border: "1px solid #d1d5db",
          borderRadius: 4,
          background: "white",
          cursor: "pointer",
          marginLeft: 6,
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Actions ▾
      </button>
      {open ? (
        <>
          {/* click-away overlay */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            role="menu"
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 4px)",
              zIndex: 50,
              background: "white",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
              minWidth: 180,
              padding: 4,
            }}
          >
            <MenuItem
              label="Issue refund…"
              disabled={!isPosted}
              hint={!isPosted ? `Only posted payments (current: ${row.postingStatus})` : undefined}
              onClick={() => {
                setOpen(false);
                setActive("refund");
              }}
            />
            <MenuItem
              label="Reverse payment…"
              disabled={!isPosted}
              hint={
                isReversed
                  ? "Already reversed"
                  : isVoided
                    ? "Voided — cannot reverse"
                    : !isPosted
                      ? `Only posted payments (current: ${row.postingStatus})`
                      : undefined
              }
              danger
              onClick={() => {
                setOpen(false);
                setActive("reverse");
              }}
            />
            <MenuItem
              label="Void…"
              disabled={isReversed || isVoided}
              hint={
                isVoided
                  ? "Already voided"
                  : isReversed
                    ? "Reversed — cannot void"
                    : undefined
              }
              onClick={() => {
                setOpen(false);
                setActive("void");
              }}
            />
            <MenuItem
              label="Record recoupment…"
              disabled={row.source === "manual_insurance" || !isPosted}
              hint={
                row.source === "manual_insurance"
                  ? "Recoupments apply to ERA / Stripe only"
                  : !isPosted
                    ? "Only posted payments"
                    : undefined
              }
              onClick={() => {
                setOpen(false);
                setActive("recoup");
              }}
            />
            <MenuItem
              label="Confirm refund…"
              hint="Mark a pending insurance refund as issued"
              onClick={() => {
                setOpen(false);
                setActive("confirm-refund");
              }}
            />
          </div>
        </>
      ) : null}

      {active === "refund" ? (
        <RefundModal
          row={row}
          orgId={orgId}
          onClose={close}
          onDone={(msg) => {
            onFlash("ok", msg);
            onChanged();
            close();
          }}
          onError={(msg) => onFlash("err", msg)}
        />
      ) : null}
      {active === "reverse" ? (
        <ReverseModal
          row={row}
          orgId={orgId}
          onClose={close}
          onDone={(msg) => {
            onFlash("ok", msg);
            onChanged();
            close();
          }}
          onError={(msg) => onFlash("err", msg)}
        />
      ) : null}
      {active === "void" ? (
        <SimpleReasonModal
          title="Void payment"
          intro={`Void this ${row.source} payment of ${fmtMoney(row.amount)}? Voiding is only allowed when no ledger entries exist (data-entry mistake caught early). It does NOT move money.`}
          submitLabel="Void payment"
          danger
          row={row}
          orgId={orgId}
          path="void"
          onClose={close}
          onDone={(msg) => {
            onFlash("ok", msg);
            onChanged();
            close();
          }}
          onError={(msg) => onFlash("err", msg)}
        />
      ) : null}
      {active === "recoup" ? (
        <RecoupModal
          row={row}
          orgId={orgId}
          onClose={close}
          onDone={(msg) => {
            onFlash("ok", msg);
            onChanged();
            close();
          }}
          onError={(msg) => onFlash("err", msg)}
        />
      ) : null}
      {active === "confirm-refund" ? (
        <ConfirmRefundModal
          row={row}
          orgId={orgId}
          onClose={close}
          onDone={(msg) => {
            onFlash("ok", msg);
            onChanged();
            close();
          }}
          onError={(msg) => onFlash("err", msg)}
        />
      ) : null}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  disabled,
  danger,
  hint,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        fontSize: 13,
        background: "transparent",
        border: "none",
        color: disabled ? "#9ca3af" : danger ? "#991b1b" : "#111827",
        cursor: disabled ? "not-allowed" : "pointer",
        borderRadius: 4,
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = "#f3f4f6";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared modal chrome
// ─────────────────────────────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
  width = 520,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        zIndex: 100,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 80,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          width,
          maxWidth: "92vw",
          borderRadius: 8,
          boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
          padding: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{title}</h2>
          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 18,
              color: "#6b7280",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      style={{
        padding: 8,
        background: "#fef2f2",
        color: "#991b1b",
        border: "1px solid #fecaca",
        borderRadius: 6,
        marginBottom: 10,
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", fontSize: 13, padding: "3px 0" }}>
      <span style={{ color: "#6b7280", width: 180 }}>{label}</span>
      <span style={{ color: "#111827", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function useDetail(rowId: string, orgId: string) {
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(
      `/api/billing/payments/posted/${encodeURIComponent(rowId)}?organizationId=${encodeURIComponent(orgId)}`,
      { cache: "no-store" },
    )
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok || !j?.success) throw new Error(j?.error ?? "Failed to load payment detail");
        return j as DetailResponse;
      })
      .then((j) => {
        if (!cancelled) setDetail(j);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load detail");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rowId, orgId]);

  const remaining = useMemo(() => {
    if (!detail) return 0;
    const refunded = detail.refunds
      .filter((r) => r.refund_status !== "cancelled")
      .reduce((s, r) => s + Number(r.amount ?? 0), 0);
    const recouped = detail.recoupments.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    return Math.round((detail.totalImpact - refunded - recouped) * 100) / 100;
  }, [detail]);

  return { detail, loading, error, remaining };
}

// ─────────────────────────────────────────────────────────────────────────────
// Refund modal
// ─────────────────────────────────────────────────────────────────────────────

interface RefundPreviewShape {
  source: { kind: string; id: string; label: string };
  refundType: "insurance" | "patient";
  amount: number;
  paymentTotalImpact: number;
  priorRefundTotal: number;
  priorRecoupTotal: number;
  remainingRefundableBefore: number;
  remainingRefundableAfter: number;
  initialRefundStatus: "pending" | "issued";
  compensatingLedgerEntry: {
    entryType: string;
    amount: number;
    description: string;
  } | null;
  patientInvoice: {
    invoiceId: string;
    currentPaidAmount: number;
    paidAmountDelta: number;
    newPaidAmount: number;
    newBalanceAmount: number;
    newStatus: string;
  } | null;
  stripeRefund: {
    wouldFire: boolean;
    reason: string;
    chargeId: string | null;
    paymentIntentId: string | null;
    amountCents: number;
  } | null;
  workqueueItem: {
    wouldOpen: boolean;
    queueType: string | null;
    title: string | null;
  };
}

function RefundModal({
  row,
  orgId,
  onClose,
  onDone,
  onError,
}: {
  row: RowSummary;
  orgId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { detail, loading, error: loadError, remaining } = useDetail(row.id, orgId);
  const defaultRefundType: "insurance" | "patient" =
    row.source === "patient" ? "patient" : "insurance";
  const [refundType, setRefundType] = useState<"insurance" | "patient">(defaultRefundType);
  const [amount, setAmount] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RefundPreviewShape | null>(null);
  const [result, setResult] = useState<{
    refundStatus: "pending" | "issued" | "failed" | "cancelled" | null;
    stripeRefundId: string | null;
    workqueueItemId: string | null;
    warnings: string[];
  } | null>(null);

  useEffect(() => {
    if (detail && !amount) setAmount(remaining > 0 ? remaining.toFixed(2) : "");
  }, [detail, remaining, amount]);

  const amountNum = Number(amount);
  const clientValidation = useMemo(() => {
    if (!detail) return null;
    if (!Number.isFinite(amountNum) || amountNum <= 0)
      return "Enter a refund amount greater than zero.";
    if (amountNum > remaining + 0.005)
      return `Refund ${amountNum.toFixed(2)} exceeds remaining refundable balance ${remaining.toFixed(2)}.`;
    if (!reason.trim()) return "A reason is required.";
    return null;
  }, [detail, amountNum, remaining, reason]);

  const callApi = useCallback(
    async (dryRun: boolean) => {
      const r = await fetch(
        `/api/billing/payments/posted/${encodeURIComponent(row.id)}/refund`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId: orgId,
            refundType,
            amount: amountNum,
            reason: reason.trim(),
            dryRun,
          }),
        },
      );
      const j = await r.json();
      if (!r.ok || !j?.success) {
        const msg =
          (j?.errors?.[0]?.message as string | undefined) ?? j?.error ?? "Refund failed";
        throw new Error(msg);
      }
      return j;
    },
    [row.id, orgId, refundType, amountNum, reason],
  );

  const requestPreview = useCallback(async () => {
    if (clientValidation) {
      setError(clientValidation);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const j = await callApi(true);
      if (!j.preview) throw new Error("Server did not return a preview");
      setPreview(j.preview as RefundPreviewShape);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Preview failed";
      setError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [clientValidation, callApi, onError]);

  const confirmLive = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const j = await callApi(false);
      setResult({
        refundStatus: j.refundStatus ?? null,
        stripeRefundId: j.stripeRefundId ?? null,
        workqueueItemId: j.workqueueItemId ?? null,
        warnings: Array.isArray(j.errors)
          ? j.errors.map((e: { message?: string }) => String(e?.message ?? "")).filter(Boolean)
          : [],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Refund failed";
      setError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [callApi, onError]);

  if (result) {
    const status = result.refundStatus ?? "pending";
    const badge =
      status === "issued"
        ? { bg: "#ecfdf5", fg: "#065f46", label: "Issued via Stripe" }
        : status === "pending"
          ? { bg: "#fffbeb", fg: "#92400e", label: "Pending — work item opened" }
          : { bg: "#fef2f2", fg: "#991b1b", label: status };
    return (
      <Modal title="Refund recorded" onClose={onClose}>
        <div
          style={{
            padding: 10,
            background: badge.bg,
            color: badge.fg,
            border: `1px solid ${badge.fg}33`,
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {badge.label}
        </div>
        <InfoLine label="Refund type" value={refundType} />
        <InfoLine label="Amount" value={fmtMoney(amountNum)} />
        {result.stripeRefundId ? (
          <InfoLine label="Stripe refund id" value={<code>{result.stripeRefundId}</code>} />
        ) : null}
        {result.workqueueItemId ? (
          <InfoLine label="Workqueue item" value={result.workqueueItemId.slice(0, 8)} />
        ) : null}
        {result.warnings.length > 0 ? (
          <div style={{ marginTop: 10, fontSize: 12, color: "#92400e" }}>
            <strong>Notes:</strong>
            <ul style={{ margin: "4px 0 0 18px" }}>
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div style={{ marginTop: 16, textAlign: "right" }}>
          <button
            onClick={() => {
              onDone(
                `Refund ${fmtMoney(amountNum)} ${status === "issued" ? "issued via Stripe" : "queued (pending)"}`,
              );
            }}
            style={primaryBtn}
          >
            Done
          </button>
        </div>
      </Modal>
    );
  }

  if (preview) {
    return (
      <Modal title="Confirm refund" onClose={onClose} width={580}>
        <ErrorBanner message={error} />
        <div
          style={{
            padding: 10,
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            color: "#1e3a8a",
            borderRadius: 6,
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          <strong>Preview — nothing has been written yet.</strong> Review the impact below,
          then confirm to actually issue this refund.
        </div>
        <InfoLine label="Source" value={preview.source.label} />
        <InfoLine label="Refund type" value={preview.refundType} />
        <InfoLine label="Amount" value={fmtMoney(preview.amount)} />
        <InfoLine
          label="Refundable balance"
          value={`${fmtMoney(preview.remainingRefundableBefore)} → ${fmtMoney(preview.remainingRefundableAfter)}`}
        />
        <InfoLine
          label="Initial refund status"
          value={
            preview.initialRefundStatus === "issued"
              ? "issued (no follow-up work item)"
              : "pending (work item will be opened)"
          }
        />

        <StripePreviewLine stripe={preview.stripeRefund} amount={preview.amount} />

        {preview.compensatingLedgerEntry ? (
          <div style={{ marginTop: 10, fontSize: 13, color: "#374151" }}>
            <strong>Compensating ledger entry:</strong>
            <ul style={{ margin: "4px 0 0 18px" }}>
              <li>
                {preview.compensatingLedgerEntry.entryType}{" "}
                {fmtMoney(preview.compensatingLedgerEntry.amount)} —{" "}
                {preview.compensatingLedgerEntry.description}
              </li>
            </ul>
          </div>
        ) : (
          <div style={{ marginTop: 10, fontSize: 12, color: "#6b7280" }}>
            No compensating ledger entry will be posted at this step.
          </div>
        )}

        {preview.patientInvoice ? (
          <div style={{ marginTop: 10, fontSize: 13, color: "#374151" }}>
            <strong>Patient invoice impact:</strong>
            <ul style={{ margin: "4px 0 0 18px" }}>
              <li>
                paid_amount {fmtMoney(preview.patientInvoice.currentPaidAmount)} →{" "}
                {fmtMoney(preview.patientInvoice.newPaidAmount)} (Δ{" "}
                {fmtMoney(preview.patientInvoice.paidAmountDelta)})
              </li>
              <li>
                new balance {fmtMoney(preview.patientInvoice.newBalanceAmount)}, status{" "}
                <code>{preview.patientInvoice.newStatus}</code>
              </li>
            </ul>
          </div>
        ) : null}

        {preview.workqueueItem.wouldOpen ? (
          <div style={{ marginTop: 10, fontSize: 12, color: "#92400e" }}>
            A workqueue follow-up will be opened: {preview.workqueueItem.title ?? "(no title)"}
          </div>
        ) : null}

        <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setPreview(null)} style={secondaryBtn} disabled={submitting}>
            Back
          </button>
          <button onClick={confirmLive} style={primaryBtn} disabled={submitting}>
            {submitting ? "Issuing…" : "Confirm & issue refund"}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Issue refund" onClose={onClose}>
      <ErrorBanner message={error ?? loadError} />
      {loading ? (
        <div style={{ padding: 12, color: "#6b7280", fontSize: 13 }}>Loading payment detail…</div>
      ) : detail ? (
        <>
          <InfoLine label="Original payment" value={fmtMoney(detail.totalImpact)} />
          <InfoLine label="Remaining refundable" value={fmtMoney(remaining)} />
          {detail.patientInvoice?.invoice_number ? (
            <InfoLine
              label="Patient invoice"
              value={`${detail.patientInvoice.invoice_number} (bal ${fmtMoney(Number(detail.patientInvoice.balance_amount ?? 0))})`}
            />
          ) : null}

          <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
            <label style={fieldLabel}>
              <span>Refund type</span>
              <select
                value={refundType}
                onChange={(e) => setRefundType(e.target.value as "insurance" | "patient")}
                style={fieldInput}
                disabled={row.source === "patient"}
              >
                <option value="insurance">Insurance (payer)</option>
                <option value="patient">Patient</option>
              </select>
            </label>
            <label style={fieldLabel}>
              <span>Amount (USD)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={fieldInput}
              />
            </label>
            <label style={fieldLabel}>
              <span>Reason</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                style={{ ...fieldInput, resize: "vertical" }}
                placeholder="Why is this refund being issued?"
              />
            </label>
            {clientValidation ? (
              <div style={{ fontSize: 12, color: "#b45309" }}>{clientValidation}</div>
            ) : null}
            {refundType === "patient" && row.source === "patient" ? (
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                If the original charge was on Stripe and a secret key is configured, the refund
                will be issued immediately and surfaced below.
              </div>
            ) : null}
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={onClose} style={secondaryBtn} disabled={submitting}>
              Cancel
            </button>
            <button
              onClick={requestPreview}
              style={primaryBtn}
              disabled={submitting || Boolean(clientValidation)}
            >
              {submitting ? "Loading preview…" : "Preview refund"}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function StripePreviewLine({
  stripe,
  amount,
}: {
  stripe: RefundPreviewShape["stripeRefund"];
  amount: number;
}) {
  if (!stripe) return null;
  if (stripe.wouldFire) {
    const target = stripe.chargeId
      ? `charge ${stripe.chargeId}`
      : stripe.paymentIntentId
        ? `payment intent ${stripe.paymentIntentId}`
        : "the originating charge";
    return (
      <div
        style={{
          marginTop: 10,
          padding: 8,
          background: "#ecfdf5",
          color: "#065f46",
          border: "1px solid #a7f3d0",
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        <strong>Stripe will issue {fmtMoney(amount)}</strong> to {target}.
      </div>
    );
  }
  const why: Record<string, string> = {
    no_stripe_key: "no STRIPE_SECRET_KEY is configured",
    no_charge_or_intent: "no Stripe charge or payment intent is linked to this payment",
    not_applicable: "this is an insurance refund (Stripe does not apply)",
    already_issued: "the caller marked this refund as already issued externally",
  };
  return (
    <div
      style={{
        marginTop: 10,
        padding: 8,
        background: "#fffbeb",
        color: "#92400e",
        border: "1px solid #fde68a",
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      <strong>Stripe will NOT fire</strong> because {why[stripe.reason] ?? stripe.reason}.
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reverse modal
// ─────────────────────────────────────────────────────────────────────────────

interface ReversalPreviewShape {
  source: { kind: string; id: string; label: string };
  paymentTotalImpact: number;
  ledgerReversalEntries: Array<{
    entryType: string;
    amount: number;
    groupCode: string | null;
    reasonCode: string | null;
    description: string;
  }>;
  claimStatusChange: { claimId: string; from: string; to: string } | null;
  patientInvoice: {
    invoiceId: string;
    currentPaidAmount: number;
    paidAmountDelta: number;
    newPaidAmount: number;
    newBalanceAmount: number;
    newStatus: string;
  } | null;
  autoPatientRefund: {
    amount: number;
    stripeChargeId: string | null;
    method: string;
  } | null;
  workqueueItemsToClose: number;
}

function ReverseModal({
  row,
  orgId,
  onClose,
  onDone,
  onError,
}: {
  row: RowSummary;
  orgId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { detail, loading, error: loadError } = useDetail(row.id, orgId);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReversalPreviewShape | null>(null);

  const downstreamLines: string[] = useMemo(() => {
    if (!detail) return [];
    const lines: string[] = [];
    if (detail.professionalClaimId) {
      lines.push(
        `Claim ${detail.professionalClaimId.slice(0, 8)} will be flipped back to 'billed'.`,
      );
    }
    if (detail.patientInvoice) {
      lines.push(
        `Patient invoice ${detail.patientInvoice.invoice_number ?? ""} balance will be restored.`,
      );
    }
    const activeRefunds = detail.refunds.filter((r) => r.refund_status !== "cancelled");
    if (activeRefunds.length > 0) {
      lines.push(
        `${activeRefunds.length} existing refund row(s) will remain on the audit trail.`,
      );
    }
    if (detail.recoupments.length > 0) {
      lines.push(`${detail.recoupments.length} recoupment row(s) on this payment.`);
    }
    if (row.source === "patient") {
      lines.push(
        `If this was a Stripe charge, a pending patient refund + workqueue item will be auto-created.`,
      );
    }
    return lines;
  }, [detail, row.source]);

  const callApi = useCallback(
    async (dryRun: boolean) => {
      const r = await fetch(
        `/api/billing/payments/posted/${encodeURIComponent(row.id)}/reverse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId: orgId, reason: reason.trim(), dryRun }),
        },
      );
      const j = await r.json();
      if (!r.ok || !j?.success) {
        const msg =
          (j?.errors?.[0]?.message as string | undefined) ?? j?.error ?? "Reversal failed";
        throw new Error(msg);
      }
      return j;
    },
    [row.id, orgId, reason],
  );

  const requestPreview = useCallback(async () => {
    if (!reason.trim()) {
      setError("A reversal reason is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const j = await callApi(true);
      if (!j.preview) throw new Error("Server did not return a preview");
      setPreview(j.preview as ReversalPreviewShape);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Preview failed";
      setError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [reason, callApi, onError]);

  const confirmLive = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const j = await callApi(false);
      onDone(
        j.alreadyReversed
          ? "Payment was already reversed."
          : `Reversed payment (${j.ledgerEntriesWritten ?? 0} compensating entries, ${j.workqueueItemsClosed ?? 0} workqueue items closed)`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Reversal failed";
      setError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [callApi, onDone, onError]);

  if (preview) {
    return (
      <Modal title="Confirm reversal" onClose={onClose} width={600}>
        <ErrorBanner message={error} />
        <div
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 6,
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          <strong>Preview — no rows have been written yet.</strong> The live reverse will
          post the entries below and restore parent balances.
        </div>
        <InfoLine label="Source" value={preview.source.label} />
        <InfoLine label="Original amount" value={fmtMoney(preview.paymentTotalImpact)} />

        {preview.claimStatusChange ? (
          <InfoLine
            label="Claim status change"
            value={
              <>
                {preview.claimStatusChange.claimId.slice(0, 8)}:{" "}
                <code>{preview.claimStatusChange.from}</code> →{" "}
                <code>{preview.claimStatusChange.to}</code>
              </>
            }
          />
        ) : null}

        <div style={{ marginTop: 10, fontSize: 13, color: "#374151" }}>
          <strong>
            Compensating ledger entries to be written ({preview.ledgerReversalEntries.length}):
          </strong>
          {preview.ledgerReversalEntries.length === 0 ? (
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
              No prior ledger entries on this payment — nothing to mirror.
            </div>
          ) : (
            <ul style={{ margin: "4px 0 0 18px", maxHeight: 160, overflowY: "auto" }}>
              {preview.ledgerReversalEntries.map((e, i) => (
                <li key={i} style={{ fontSize: 12 }}>
                  {e.entryType} {fmtMoney(e.amount)}
                  {e.groupCode ? ` [${e.groupCode}/${e.reasonCode ?? "?"}]` : ""} —{" "}
                  {e.description}
                </li>
              ))}
            </ul>
          )}
        </div>

        {preview.patientInvoice ? (
          <div style={{ marginTop: 10, fontSize: 13, color: "#374151" }}>
            <strong>Patient invoice impact:</strong>
            <ul style={{ margin: "4px 0 0 18px" }}>
              <li>
                paid_amount {fmtMoney(preview.patientInvoice.currentPaidAmount)} →{" "}
                {fmtMoney(preview.patientInvoice.newPaidAmount)} (Δ{" "}
                {fmtMoney(preview.patientInvoice.paidAmountDelta)})
              </li>
              <li>
                new balance {fmtMoney(preview.patientInvoice.newBalanceAmount)}, status{" "}
                <code>{preview.patientInvoice.newStatus}</code>
              </li>
            </ul>
          </div>
        ) : null}

        {preview.autoPatientRefund ? (
          <div
            style={{
              marginTop: 10,
              padding: 8,
              background: "#ecfdf5",
              color: "#065f46",
              border: "1px solid #a7f3d0",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <strong>
              Stripe will issue {fmtMoney(preview.autoPatientRefund.amount)}
            </strong>{" "}
            {preview.autoPatientRefund.stripeChargeId
              ? `to charge ${preview.autoPatientRefund.stripeChargeId}`
              : `(method: ${preview.autoPatientRefund.method})`}{" "}
            as a pending patient refund.
          </div>
        ) : row.source === "patient" ? (
          <div
            style={{
              marginTop: 10,
              padding: 8,
              background: "#fffbeb",
              color: "#92400e",
              border: "1px solid #fde68a",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <strong>Stripe will NOT fire</strong> — no Stripe charge is linked, or amount is
            zero.
          </div>
        ) : null}

        {preview.workqueueItemsToClose > 0 ? (
          <div style={{ marginTop: 10, fontSize: 12, color: "#92400e" }}>
            {preview.workqueueItemsToClose} open workqueue item(s) on this payment will be
            resolved.
          </div>
        ) : null}

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            marginTop: 12,
            color: "#374151",
          }}
        >
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I understand this reverses the financial impact and notifies downstream queues.
        </label>

        <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setPreview(null)} style={secondaryBtn} disabled={submitting}>
            Back
          </button>
          <button
            onClick={confirmLive}
            style={dangerBtn}
            disabled={submitting || !confirmed}
          >
            {submitting ? "Reversing…" : "Confirm & reverse payment"}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Reverse posted payment" onClose={onClose}>
      <ErrorBanner message={error ?? loadError} />
      {loading ? (
        <div style={{ padding: 12, color: "#6b7280", fontSize: 13 }}>
          Loading downstream impact…
        </div>
      ) : (
        <>
          <div
            style={{
              padding: 10,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              borderRadius: 6,
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            <strong>Destructive action.</strong> Reversing writes paired negative ledger
            entries and restores parent balances. Review the preview before confirming.
          </div>
          <InfoLine label="Source" value={row.source} />
          <InfoLine label="Original amount" value={fmtMoney(row.amount)} />
          <InfoLine label="Current status" value={row.postingStatus} />
          {downstreamLines.length > 0 ? (
            <div style={{ marginTop: 10, fontSize: 13, color: "#374151" }}>
              <strong>Likely downstream effects:</strong>
              <ul style={{ margin: "4px 0 0 18px" }}>
                {downstreamLines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <label style={{ ...fieldLabel, marginTop: 14 }}>
            <span>Reversal reason (required)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              style={{ ...fieldInput, resize: "vertical" }}
              placeholder="Why is this payment being reversed?"
            />
          </label>

          <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={onClose} style={secondaryBtn} disabled={submitting}>
              Cancel
            </button>
            <button
              onClick={requestPreview}
              style={primaryBtn}
              disabled={submitting || !reason.trim()}
            >
              {submitting ? "Loading preview…" : "Preview reversal"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple reason-only modal (void)
// ─────────────────────────────────────────────────────────────────────────────

function SimpleReasonModal({
  title,
  intro,
  submitLabel,
  row,
  orgId,
  path,
  danger,
  onClose,
  onDone,
  onError,
}: {
  title: string;
  intro: string;
  submitLabel: string;
  row: RowSummary;
  orgId: string;
  path: "void";
  danger?: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/billing/payments/posted/${encodeURIComponent(row.id)}/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId: orgId, reason: reason.trim() }),
        },
      );
      const j = await r.json();
      if (!r.ok || !j?.success) {
        const msg = (j?.errors?.[0]?.message as string | undefined) ?? j?.error ?? "Action failed";
        throw new Error(msg);
      }
      onDone(j.alreadyVoided ? "Payment was already voided." : `${submitLabel} succeeded.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Action failed";
      setError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <ErrorBanner message={error} />
      <p style={{ fontSize: 13, color: "#374151", marginTop: 0 }}>{intro}</p>
      <label style={fieldLabel}>
        <span>Reason (required)</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          style={{ ...fieldInput, resize: "vertical" }}
        />
      </label>
      <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onClose} style={secondaryBtn} disabled={submitting}>
          Cancel
        </button>
        <button
          onClick={submit}
          style={danger ? dangerBtn : primaryBtn}
          disabled={submitting || !reason.trim()}
        >
          {submitting ? "Submitting…" : submitLabel}
        </button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Recoupment modal
// ─────────────────────────────────────────────────────────────────────────────

function RecoupModal({
  row,
  orgId,
  onClose,
  onDone,
  onError,
}: {
  row: RowSummary;
  orgId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { detail, loading, error: loadError, remaining } = useDetail(row.id, orgId);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountNum = Number(amount);

  const validation = useMemo(() => {
    if (!detail) return null;
    if (!Number.isFinite(amountNum) || amountNum <= 0) return "Enter a positive amount.";
    if (amountNum > remaining + 0.005)
      return `Recoupment ${amountNum.toFixed(2)} exceeds remaining balance ${remaining.toFixed(2)}.`;
    if (!reason.trim()) return "Reason is required.";
    return null;
  }, [detail, amountNum, remaining, reason]);

  const submit = async () => {
    if (validation) {
      setError(validation);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/billing/payments/posted/${encodeURIComponent(row.id)}/recoup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId: orgId,
            amount: amountNum,
            reason: reason.trim(),
            reasonCode: reasonCode.trim() || null,
          }),
        },
      );
      const j = await r.json();
      if (!r.ok || !j?.success) {
        const msg =
          (j?.errors?.[0]?.message as string | undefined) ?? j?.error ?? "Recoupment failed";
        throw new Error(msg);
      }
      onDone(`Recoupment ${fmtMoney(amountNum)} recorded.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Recoupment failed";
      setError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Record recoupment" onClose={onClose}>
      <ErrorBanner message={error ?? loadError} />
      {loading ? (
        <div style={{ padding: 12, color: "#6b7280", fontSize: 13 }}>Loading payment detail…</div>
      ) : detail ? (
        <>
          <InfoLine label="Original payment" value={fmtMoney(detail.totalImpact)} />
          <InfoLine label="Remaining" value={fmtMoney(remaining)} />
          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <label style={fieldLabel}>
              <span>Amount (USD)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={fieldInput}
              />
            </label>
            <label style={fieldLabel}>
              <span>Reason code (optional)</span>
              <input
                type="text"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                style={fieldInput}
                placeholder="e.g. WO, FB, 23"
              />
            </label>
            <label style={fieldLabel}>
              <span>Reason</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                style={{ ...fieldInput, resize: "vertical" }}
              />
            </label>
            {validation ? (
              <div style={{ fontSize: 12, color: "#b45309" }}>{validation}</div>
            ) : null}
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={onClose} style={secondaryBtn} disabled={submitting}>
              Cancel
            </button>
            <button onClick={submit} style={primaryBtn} disabled={submitting || Boolean(validation)}>
              {submitting ? "Submitting…" : "Record recoupment"}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirm-refund modal — pick a pending insurance refund and mark issued
// ─────────────────────────────────────────────────────────────────────────────

function ConfirmRefundModal({
  row,
  orgId,
  onClose,
  onDone,
  onError,
}: {
  row: RowSummary;
  orgId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { detail, loading, error: loadError } = useDetail(row.id, orgId);
  const pending = useMemo(
    () =>
      (detail?.refunds ?? []).filter(
        (r) => r.refund_type === "insurance" && r.refund_status === "pending",
      ),
    [detail],
  );
  const [refundId, setRefundId] = useState<string>("");
  const [externalRef, setExternalRef] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pending.length > 0 && !refundId) setRefundId(pending[0].id);
  }, [pending, refundId]);

  const submit = async () => {
    if (!refundId) {
      setError("Pick a pending refund to confirm.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/billing/payments/posted/${encodeURIComponent(row.id)}/confirm-refund`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId: orgId,
            refundId,
            reason: reason.trim() || null,
            externalReferenceNumber: externalRef.trim() || null,
          }),
        },
      );
      const j = await r.json();
      if (!r.ok || !j?.success) {
        const msg =
          (j?.errors?.[0]?.message as string | undefined) ?? j?.error ?? "Confirmation failed";
        throw new Error(msg);
      }
      onDone(`Refund ${refundId.slice(0, 8)} confirmed as issued.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Confirmation failed";
      setError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Confirm pending insurance refund" onClose={onClose}>
      <ErrorBanner message={error ?? loadError} />
      {loading ? (
        <div style={{ padding: 12, color: "#6b7280", fontSize: 13 }}>Loading refunds…</div>
      ) : pending.length === 0 ? (
        <>
          <p style={{ fontSize: 13, color: "#374151", marginTop: 0 }}>
            No pending insurance refunds are linked to this payment.
          </p>
          <div style={{ marginTop: 16, textAlign: "right" }}>
            <button onClick={onClose} style={secondaryBtn}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13, color: "#374151", marginTop: 0 }}>
            Confirming flips the refund to <code>issued</code> and posts a compensating
            negative ledger entry. Use this once the payer check/ACH has actually left the
            building.
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            <label style={fieldLabel}>
              <span>Pending refund</span>
              <select
                value={refundId}
                onChange={(e) => setRefundId(e.target.value)}
                style={fieldInput}
              >
                {pending.map((r) => (
                  <option key={r.id} value={r.id}>
                    {fmtMoney(Number(r.amount))} — {r.reason?.slice(0, 60) || "(no reason)"} —{" "}
                    {r.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldLabel}>
              <span>External reference (check #, ACH trace, etc.)</span>
              <input
                type="text"
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
                style={fieldInput}
              />
            </label>
            <label style={fieldLabel}>
              <span>Confirmation note (optional)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                style={{ ...fieldInput, resize: "vertical" }}
              />
            </label>
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={onClose} style={secondaryBtn} disabled={submitting}>
              Cancel
            </button>
            <button onClick={submit} style={primaryBtn} disabled={submitting || !refundId}>
              {submitting ? "Confirming…" : "Confirm as issued"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Local style helpers
// ─────────────────────────────────────────────────────────────────────────────

const fieldLabel: React.CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: 12,
  color: "#374151",
};
const fieldInput: React.CSSProperties = {
  padding: "6px 8px",
  fontSize: 13,
  border: "1px solid #d1d5db",
  borderRadius: 4,
  width: "100%",
};
const primaryBtn: React.CSSProperties = {
  padding: "7px 14px",
  fontSize: 13,
  fontWeight: 500,
  background: "#2563eb",
  color: "white",
  border: "1px solid #1d4ed8",
  borderRadius: 6,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  padding: "7px 14px",
  fontSize: 13,
  fontWeight: 500,
  background: "white",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  cursor: "pointer",
};
const dangerBtn: React.CSSProperties = {
  padding: "7px 14px",
  fontSize: 13,
  fontWeight: 500,
  background: "#dc2626",
  color: "white",
  border: "1px solid #b91c1c",
  borderRadius: 6,
  cursor: "pointer",
};
