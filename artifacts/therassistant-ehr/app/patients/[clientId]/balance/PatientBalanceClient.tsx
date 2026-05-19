"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type InvoicePayment = {
  id: string;
  payment_status?: string | null;
  payment_method?: string | null;
  amount?: string | number | null;
  paid_at?: string | null;
  memo?: string | null;
};

type Invoice = {
  id: string;
  invoiceNumber?: unknown;
  status?: unknown;
  patientResponsibilityAmount: number;
  paidAmount: number;
  balanceAmount: number;
  source?: unknown;
  createdAt?: unknown;
  payments: InvoicePayment[];
};

type PatientBalancePayload = {
  success: boolean;
  error?: string;
  patient?: {
    id: string;
    name: string;
    dateOfBirth?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  totals?: {
    openBalance: number;
    totalPaid: number;
    totalResponsibility: number;
    invoiceCount: number;
  };
  invoices?: Invoice[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function formatMoney(value: string | number | null | undefined) {
  const amount = Number(value ?? 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDate(value: unknown) {
  if (!value) return "Not listed";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString();
}

function statusClass(value: unknown) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("paid") || normalized.includes("posted")) return "status status-green";
  if (normalized.includes("void") || normalized.includes("failed") || normalized.includes("collections")) return "status status-red";
  if (normalized.includes("open") || normalized.includes("sent") || normalized.includes("pending")) return "status status-yellow";
  return "status";
}

export default function PatientBalanceClient({ clientId }: { clientId: string }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [payload, setPayload] = useState<PatientBalancePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadBalance() {
    if (!organizationId) {
      setError("Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/patients/${clientId}/balance?organizationId=${encodeURIComponent(organizationId)}`, {
        cache: "no-store",
      });
      const json = (await response.json()) as PatientBalancePayload;
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load patient balance");
      setPayload(json);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load patient balance");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, organizationId]);

  async function postAction(path: string, body: Record<string, unknown>, successMessage: string) {
    setActionMessage(null);
    setError(null);
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { success?: boolean; error?: string; result?: { errors?: Array<{ message: string }> } };
    if (!response.ok || !json.success) {
      const detail = json.result?.errors?.[0]?.message ?? json.error ?? "Action failed";
      throw new Error(detail);
    }
    setActionMessage(successMessage);
    await loadBalance();
  }

  async function recordManualPayment(invoice: Invoice) {
    const amount = window.prompt("Payment amount", String(invoice.balanceAmount));
    if (!amount) return;
    try {
      await postAction(
        "/api/patient-invoices/pay",
        {
          organizationId,
          patientInvoiceId: invoice.id,
          amount: Number(amount),
          paymentMethod: "manual",
          memo: "Manual payment posted from patient balance screen",
        },
        "Payment posted.",
      );
    } catch (paymentError) {
      setError(paymentError instanceof Error ? paymentError.message : "Payment failed");
    }
  }

  async function markSent(invoice: Invoice) {
    try {
      await postAction(
        "/api/patient-invoices/mark-sent",
        { organizationId, patientInvoiceId: invoice.id, memo: "Marked sent from patient balance screen" },
        "Invoice marked sent.",
      );
    } catch (sentError) {
      setError(sentError instanceof Error ? sentError.message : "Mark sent failed");
    }
  }

  async function voidInvoice(invoice: Invoice) {
    const confirmed = window.confirm("Void this invoice? This removes the collectible balance from this invoice.");
    if (!confirmed) return;
    try {
      await postAction(
        "/api/patient-invoices/void",
        { organizationId, patientInvoiceId: invoice.id, memo: "Voided from patient balance screen" },
        "Invoice voided.",
      );
    } catch (voidError) {
      setError(voidError instanceof Error ? voidError.message : "Void failed");
    }
  }

  const patient = payload?.patient;
  const totals = payload?.totals;
  const invoices = payload?.invoices ?? [];
  const recentPayments = invoices
    .flatMap((invoice) => invoice.payments.map((payment) => ({ invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, payment })))
    .sort((a, b) => String(b.payment.paid_at ?? "").localeCompare(String(a.payment.paid_at ?? "")))
    .slice(0, 8);

  if (loading) return <div className="empty-state">Loading balance…</div>;
  if (error) return <div className="alert-panel">{error}</div>;
  if (!patient) return <div className="alert-panel">Patient balance not found.</div>;

  return (
    <>
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Patient Balance</p>
          <h1>{patient.name}</h1>
          <p className="hero-copy">Manual collection workflow for patient responsibility balances.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href={`/clients/${patient.id}`}>Patient Chart</Link>
          <Link className="button button-secondary" href="/clinician/agenda">Agenda</Link>
        </div>
      </section>

      {actionMessage ? <div className="empty-state success-panel">{actionMessage}</div> : null}

      <section className="metric-grid">
        <article className="metric-card">
          <span>Open Balance</span>
          <strong>{formatMoney(totals?.openBalance ?? 0)}</strong>
        </article>
        <article className="metric-card">
          <span>Total Responsibility</span>
          <strong>{formatMoney(totals?.totalResponsibility ?? 0)}</strong>
        </article>
        <article className="metric-card">
          <span>Total Paid</span>
          <strong>{formatMoney(totals?.totalPaid ?? 0)}</strong>
        </article>
        <article className="metric-card">
          <span>Invoices</span>
          <strong>{totals?.invoiceCount ?? 0}</strong>
        </article>
      </section>

      <section className="panel">
        <h2>Invoices</h2>
        {invoices.length === 0 ? <p className="muted">No patient invoices found.</p> : null}
        <div className="stack-list">
          {invoices.map((invoice) => (
            <article className="stack-item" key={invoice.id}>
              <div className="stack-row">
                <div>
                  <strong>{String(invoice.invoiceNumber ?? "Invoice")}</strong>
                  <span className={statusClass(invoice.status)}>{String(invoice.status ?? "status not set")}</span>
                  <span>Created: {formatDate(invoice.createdAt)}</span>
                </div>
                <div className="invoice-money-grid">
                  <span>Responsibility: {formatMoney(invoice.patientResponsibilityAmount)}</span>
                  <span>Paid: {formatMoney(invoice.paidAmount)}</span>
                  <span>Balance: {formatMoney(invoice.balanceAmount)}</span>
                </div>
              </div>

              <div className="section-actions">
                <button className="button button-secondary" type="button" onClick={() => recordManualPayment(invoice)}>Post Payment</button>
                <button className="button button-secondary" type="button" onClick={() => markSent(invoice)}>Mark Sent</button>
                <button className="button button-secondary" type="button" onClick={() => voidInvoice(invoice)}>Void</button>
              </div>

              {invoice.payments.length > 0 ? (
                <div className="payment-history">
                  <strong>Payments</strong>
                  {invoice.payments.map((payment) => (
                    <span key={payment.id}>
                      {formatDate(payment.paid_at)} · {formatMoney(payment.amount)} · {payment.payment_method ?? "method not set"}
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="panel" style={{ marginTop: "16px" }}>
        <h2>Recent Payment Activity</h2>
        {recentPayments.length === 0 ? (
          <p className="muted">No posted payment activity yet.</p>
        ) : (
          <div className="stack-list">
            {recentPayments.map((entry) => (
              <div className="stack-item" key={entry.payment.id}>
                <strong>{String(entry.invoiceNumber ?? "Invoice")}</strong>
                <span>{formatDate(entry.payment.paid_at)} · {entry.payment.payment_method ?? "method not set"}</span>
                <span>Amount: {formatMoney(entry.payment.amount)} · Status: {entry.payment.payment_status ?? "posted"}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
