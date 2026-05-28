"use client";

/**
 * Update-card-and-retry modal (Task #737).
 *
 * Mounts a Stripe.js card element bound to a SetupIntent created on the
 * client's connected Stripe account, lets the biller paste in a new
 * card, and on confirm:
 *   1. POSTs the resulting payment_method id to
 *      /api/billing/patient-billing/:id/update-card-retry with
 *      action="confirm_and_retry" — the server swaps the client's
 *      `stripe_payment_method_id` and re-runs `attemptAutopayForInvoice`
 *      for every open `autopay_charge_failed` WQ row.
 *   2. Reports the retry outcome and closes.
 *
 * Stripe.js is loaded lazily via a script tag (no NPM dep added) since
 * this is the only spot in the app that needs Elements.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Row = {
  id: string;
  client_id: string;
  client_name: string;
  autopay_last_attempt_status: "succeeded" | "failed" | null;
  autopay_last_attempt_error: string | null;
  invoices: Array<{
    id: string;
    invoice_number: string;
    balance: number;
  }>;
};

interface Props {
  organizationId: string;
  row: Row;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

interface SetupResponse {
  success: boolean;
  error?: string;
  setupIntentId?: string;
  clientSecret?: string;
  publishableKey?: string;
  connectAccountId?: string;
}

interface ConfirmResponse {
  success: boolean;
  error?: string;
  retried?: number;
  anySucceeded?: boolean;
  allFailed?: boolean;
  retries?: Array<{
    patient_invoice_id: string;
    result: { ok: boolean; code: string; message: string };
  }>;
}

// Stripe.js global types (we don't take an NPM dep).
type StripeElement = {
  mount: (selector: string | HTMLElement) => void;
  unmount: () => void;
  on: (event: string, handler: (e: unknown) => void) => void;
};
type StripeElements = { create: (kind: string, opts?: unknown) => StripeElement };
type StripeInstance = {
  elements: () => StripeElements;
  confirmCardSetup: (
    clientSecret: string,
    data: { payment_method: { card: StripeElement } },
  ) => Promise<{
    error?: { message?: string };
    setupIntent?: { id: string; payment_method: string; status: string };
  }>;
};

type StripeFactory = (
  publishableKey: string,
  opts?: { stripeAccount?: string },
) => StripeInstance;

const STRIPE_JS_SRC = "https://js.stripe.com/v3/";

async function loadStripeJs(): Promise<StripeFactory> {
  if (typeof window === "undefined") throw new Error("Stripe.js requires a browser");
  const w = window as unknown as { Stripe?: unknown };
  if (w.Stripe) return w.Stripe as StripeFactory;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${STRIPE_JS_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Failed to load Stripe.js")),
        { once: true },
      );
      if (w.Stripe) resolve();
      return;
    }
    const tag = document.createElement("script");
    tag.src = STRIPE_JS_SRC;
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error("Failed to load Stripe.js"));
    document.head.appendChild(tag);
  });
  if (!w.Stripe) throw new Error("Stripe.js did not initialize");
  return w.Stripe as StripeFactory;
}

export default function UpdateCardRetryModal({
  organizationId,
  row,
  onClose,
  onSuccess,
  onError,
}: Props) {
  const [phase, setPhase] = useState<"loading" | "ready" | "submitting" | "error">(
    "loading",
  );
  const [errorText, setErrorText] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const cardMountRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<StripeInstance | null>(null);
  const cardElementRef = useRef<StripeElement | null>(null);
  const setupRef = useRef<{ setupIntentId: string; clientSecret: string } | null>(null);

  const initialize = useCallback(async () => {
    setPhase("loading");
    setErrorText(null);
    try {
      const res = await fetch(
        `/api/billing/patient-billing/${encodeURIComponent(row.client_id)}/update-card-retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, action: "start_setup" }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as SetupResponse;
      if (!res.ok || !json.success || !json.clientSecret || !json.publishableKey) {
        throw new Error(json.error ?? "Could not start card setup");
      }
      const Stripe = await loadStripeJs();
      if (!Stripe) throw new Error("Stripe.js unavailable");
      const stripe = Stripe(json.publishableKey, {
        stripeAccount: json.connectAccountId,
      });
      stripeRef.current = stripe;
      setupRef.current = {
        setupIntentId: json.setupIntentId!,
        clientSecret: json.clientSecret,
      };
      const elements = stripe.elements();
      const card = elements.create("card", {
        hidePostalCode: false,
        style: {
          base: {
            fontSize: "15px",
            color: "#0f172a",
            "::placeholder": { color: "#94a3b8" },
          },
        },
      });
      cardElementRef.current = card;
      setPhase("ready");
      // Defer mount to next tick so the ref is attached after the
      // re-render that swaps phase → "ready".
      window.setTimeout(() => {
        if (cardMountRef.current && cardElementRef.current) {
          cardElementRef.current.mount(cardMountRef.current);
          cardElementRef.current.on("change", (event: unknown) => {
            const e = event as { error?: { message?: string } };
            setCardError(e?.error?.message ?? null);
          });
        }
      }, 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorText(message);
      setPhase("error");
    }
  }, [organizationId, row.client_id]);

  useEffect(() => {
    void initialize();
    return () => {
      try {
        cardElementRef.current?.unmount();
      } catch {
        // ignore unmount errors
      }
    };
  }, [initialize]);

  const submit = useCallback(async () => {
    const stripe = stripeRef.current;
    const card = cardElementRef.current;
    const setup = setupRef.current;
    if (!stripe || !card || !setup) {
      setErrorText("Card form is not ready yet.");
      return;
    }
    setPhase("submitting");
    setErrorText(null);
    try {
      const result = await stripe.confirmCardSetup(setup.clientSecret, {
        payment_method: { card },
      });
      if (result.error || !result.setupIntent || result.setupIntent.status !== "succeeded") {
        const msg = result.error?.message ?? "Card could not be saved.";
        setErrorText(msg);
        setPhase("ready");
        return;
      }
      const paymentMethodId = result.setupIntent.payment_method;
      const res = await fetch(
        `/api/billing/patient-billing/${encodeURIComponent(row.client_id)}/update-card-retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            action: "confirm_and_retry",
            setupIntentId: setup.setupIntentId,
            paymentMethodId,
          }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as ConfirmResponse;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Card update failed");
      }
      const retried = json.retried ?? 0;
      if (retried === 0) {
        onSuccess(`Saved a new card on file for ${row.client_name}.`);
        return;
      }
      if (json.anySucceeded) {
        const successCount =
          json.retries?.filter((r) => r.result.ok && r.result.code === "succeeded").length ?? 0;
        onSuccess(
          `Saved the new card and ${successCount === retried ? "all" : `${successCount} of ${retried}`} retry charge${successCount === 1 ? "" : "s"} succeeded.`,
        );
        return;
      }
      // Card saved but the retry charge(s) all failed — keep modal open
      // so the biller sees Stripe's reason. Surface the first failure.
      const firstFail = json.retries?.find((r) => !r.result.ok) ?? null;
      const reason = firstFail?.result.message ?? "Stripe declined the retry charge.";
      onError(`Card saved, but the retry charge failed: ${reason}`);
      setErrorText(`Retry charge failed: ${reason}`);
      setPhase("ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorText(message);
      onError(message);
      setPhase("ready");
    }
  }, [organizationId, row.client_id, row.client_name, onSuccess, onError]);

  const failingInvoices = row.invoices.filter((i) => i.balance > 0);
  const totalFailing = failingInvoices.reduce((s, i) => s + i.balance, 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-card-retry-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 8,
          padding: 20,
          width: "min(520px, 92vw)",
          maxHeight: "92vh",
          overflow: "auto",
          boxShadow: "0 20px 50px rgba(15,23,42,0.25)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <h2
            id="update-card-retry-title"
            style={{ margin: 0, fontSize: 18 }}
          >
            Update card & retry
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: 0,
              fontSize: 20,
              cursor: "pointer",
              color: "#64748b",
            }}
          >
            ×
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: 13, color: "#475569" }}>
          {row.client_name}
        </div>
        {row.autopay_last_attempt_error ? (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              borderRadius: 6,
              background: "#fef2f2",
              color: "#7f1d1d",
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              Last autopay attempt failed
            </div>
            <div>{row.autopay_last_attempt_error}</div>
          </div>
        ) : null}
        {failingInvoices.length > 0 ? (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div style={{ color: "#64748b", marginBottom: 4 }}>
              Will retry on save:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {failingInvoices.slice(0, 5).map((i) => (
                <li key={i.id}>
                  Invoice {i.invoice_number} —{" "}
                  {i.balance.toLocaleString(undefined, {
                    style: "currency",
                    currency: "USD",
                  })}
                </li>
              ))}
              {failingInvoices.length > 5 ? (
                <li>and {failingInvoices.length - 5} more…</li>
              ) : null}
            </ul>
            <div style={{ marginTop: 4, color: "#64748b" }}>
              Total to recharge:{" "}
              {totalFailing.toLocaleString(undefined, {
                style: "currency",
                currency: "USD",
              })}
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 16 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            New card details
          </label>
          {phase === "loading" ? (
            <div
              style={{
                padding: 12,
                border: "1px dashed #cbd5e1",
                borderRadius: 6,
                color: "#64748b",
                fontSize: 13,
              }}
            >
              Loading secure card form…
            </div>
          ) : null}
          {phase === "error" ? (
            <div
              style={{
                padding: 10,
                borderRadius: 6,
                background: "#fef2f2",
                color: "#991b1b",
                fontSize: 13,
              }}
            >
              {errorText ?? "Could not load the card form."}
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => void initialize()}
                  style={{
                    background: "transparent",
                    border: "1px solid #991b1b",
                    color: "#991b1b",
                    borderRadius: 4,
                    padding: "4px 10px",
                    cursor: "pointer",
                  }}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : null}
          {phase === "ready" || phase === "submitting" ? (
            <div
              ref={cardMountRef}
              data-testid="stripe-card-mount"
              style={{
                padding: 10,
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                background: "white",
                minHeight: 40,
              }}
            />
          ) : null}
          {cardError ? (
            <div style={{ color: "#991b1b", fontSize: 12, marginTop: 6 }}>
              {cardError}
            </div>
          ) : null}
          {errorText && phase !== "error" ? (
            <div style={{ color: "#991b1b", fontSize: 12, marginTop: 6 }}>
              {errorText}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 18,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={phase === "submitting"}
            style={{
              background: "white",
              border: "1px solid #cbd5e1",
              color: "#334155",
              borderRadius: 4,
              padding: "8px 14px",
              cursor: phase === "submitting" ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={phase !== "ready"}
            style={{
              background: phase === "ready" ? "#0f172a" : "#94a3b8",
              border: "1px solid transparent",
              color: "white",
              borderRadius: 4,
              padding: "8px 14px",
              cursor: phase === "ready" ? "pointer" : "not-allowed",
              fontWeight: 600,
            }}
          >
            {phase === "submitting" ? "Saving…" : "Save card & retry"}
          </button>
        </div>
      </div>
    </div>
  );
}
