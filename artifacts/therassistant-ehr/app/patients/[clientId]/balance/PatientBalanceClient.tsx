"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

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

type InsurancePayment = {
  id: string;
  claimId: string;
  claimNumber: string;
  paymentAmount: number;
  adjustmentAmount: number;
  checkOrEft: string | null;
  paidAt: string | null;
  postingStatus: string | null;
};

type WriteOff = {
  id: string;
  claimId: string;
  claimNumber: string;
  amount: number;
  date: string | null;
};

type ClaimLite = {
  id: string;
  claimNumber: string;
  serviceDate: string | null;
  totalCharge: number;
  writeOff: number;
  outstanding: number;
  status: string | null;
};

type PatientBalancePayload = {
  success: boolean;
  error?: string;
  patient?: { id: string; name: string; dateOfBirth?: string | null; email?: string | null; phone?: string | null };
  totals?: {
    openBalance: number;
    totalPaid: number;
    totalResponsibility: number;
    invoiceCount: number;
    insurancePaid?: number;
    adjustmentsTotal?: number;
    writeOffTotal?: number;
  };
  invoices?: Invoice[];
  insurancePayments?: InsurancePayment[];
  writeOffs?: WriteOff[];
  claims?: ClaimLite[];
};

type LedgerEntry = {
  key: string;
  date: string | null;
  kind: "invoice" | "payment" | "insurance_payment" | "adjustment" | "write_off";
  description: string;
  reference: string;
  charge: number;
  credit: number;
  status?: string;
  invoiceId?: string;
  claimId?: string;
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function formatMoney(value: string | number | null | undefined) {
  const amount = Number(value ?? 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDate(value: unknown) {
  if (!value) return "—";
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

function buildLedger(
  invoices: Invoice[],
  insurancePayments: InsurancePayment[],
  writeOffs: WriteOff[],
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const inv of invoices) {
    const invDate = inv.createdAt ? String(inv.createdAt) : null;
    const ref = String(inv.invoiceNumber ?? inv.id.slice(0, 8));
    entries.push({
      key: `inv:${inv.id}`,
      date: invDate,
      kind: "invoice",
      description: `Invoice ${ref}`,
      reference: ref,
      charge: Number(inv.patientResponsibilityAmount ?? 0),
      credit: 0,
      status: String(inv.status ?? ""),
      invoiceId: inv.id,
    });
    for (const pay of inv.payments) {
      entries.push({
        key: `pay:${pay.id}`,
        date: pay.paid_at ?? invDate,
        kind: "payment",
        description: `Patient payment · ${pay.payment_method ?? "method not set"}${pay.memo ? ` — ${pay.memo}` : ""}`,
        reference: ref,
        charge: 0,
        credit: Number(pay.amount ?? 0),
        status: String(pay.payment_status ?? "posted"),
        invoiceId: inv.id,
      });
    }
  }
  for (const era of insurancePayments) {
    const ref = era.claimNumber ? `Claim ${era.claimNumber}` : `Claim ${era.claimId.slice(0, 8)}`;
    if (era.paymentAmount > 0) {
      entries.push({
        key: `era-pay:${era.id}`,
        date: era.paidAt,
        kind: "insurance_payment",
        description: `Insurance payment${era.checkOrEft ? ` · check/EFT ${era.checkOrEft}` : ""}`,
        reference: ref,
        charge: 0,
        credit: era.paymentAmount,
        status: era.postingStatus ?? "posted",
        claimId: era.claimId,
      });
    }
    if (era.adjustmentAmount > 0) {
      entries.push({
        key: `era-adj:${era.id}`,
        date: era.paidAt,
        kind: "adjustment",
        description: "Payer adjustment (CO/PR/OA/PI)",
        reference: ref,
        charge: 0,
        credit: era.adjustmentAmount,
        status: era.postingStatus ?? "posted",
        claimId: era.claimId,
      });
    }
  }
  for (const wo of writeOffs) {
    const ref = wo.claimNumber ? `Claim ${wo.claimNumber}` : `Claim ${wo.claimId.slice(0, 8)}`;
    entries.push({
      key: wo.id,
      date: wo.date,
      kind: "write_off",
      description: "Write-off",
      reference: ref,
      charge: 0,
      credit: wo.amount,
      status: "posted",
      claimId: wo.claimId,
    });
  }
  entries.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    if (ta !== tb) return ta - tb;
    const order = { invoice: 0, payment: 1, insurance_payment: 1, adjustment: 1, write_off: 1 } as const;
    return order[a.kind] - order[b.kind];
  });
  return entries;
}

function ledgerKindLabel(kind: LedgerEntry["kind"]): string {
  switch (kind) {
    case "invoice": return "Invoice";
    case "payment": return "Patient payment";
    case "insurance_payment": return "Insurance payment";
    case "adjustment": return "Adjustment";
    case "write_off": return "Write-off";
  }
}

function ledgerKindClass(kind: LedgerEntry["kind"]): string {
  if (kind === "invoice") return "status";
  if (kind === "write_off") return "status status-yellow";
  return "status status-green";
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
      const response = await fetch(`/api/patients/${clientId}/balance?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
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
        { organizationId, patientInvoiceId: invoice.id, amount: Number(amount), paymentMethod: "manual", memo: "Manual payment posted from patient balance screen" },
        "Payment posted.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
    }
  }

  async function markSent(invoice: Invoice) {
    try {
      await postAction(
        "/api/patient-invoices/mark-sent",
        { organizationId, patientInvoiceId: invoice.id, memo: "Marked sent from patient balance screen" },
        "Invoice marked sent.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mark sent failed");
    }
  }

  async function voidInvoice(invoice: Invoice) {
    if (!window.confirm("Void this invoice? This removes the collectible balance from this invoice.")) return;
    try {
      await postAction(
        "/api/patient-invoices/void",
        { organizationId, patientInvoiceId: invoice.id, memo: "Voided from patient balance screen" },
        "Invoice voided.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Void failed");
    }
  }

  const patient = payload?.patient;
  const totals = payload?.totals;
  const invoices = payload?.invoices ?? [];
  const insurancePayments = payload?.insurancePayments ?? [];
  const writeOffs = payload?.writeOffs ?? [];
  const openClaims = payload?.claims ?? [];
  const ledger = useMemo(
    () => buildLedger(invoices, insurancePayments, writeOffs),
    [invoices, insurancePayments, writeOffs],
  );
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);

  let running = 0;
  const ledgerWithBalance = ledger.map((entry) => {
    running = running + entry.charge - entry.credit;
    return { ...entry, runningBalance: running };
  });

  if (loading) return <div className="empty-state">Loading balance…</div>;
  if (error) return <div className="alert-panel">{error}</div>;
  if (!patient) return <div className="alert-panel">Patient balance not found.</div>;

  const orgQ = `?organizationId=${encodeURIComponent(organizationId)}`;
  const statementHref = `/clients/${patient.id}/balance/statement/print${orgQ}`;

  return (
    <>
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Patient Balance</p>
          <h1>{patient.name}</h1>
          <p className="hero-copy">Account ledger of charges, payments, and adjustments with running balance.</p>
        </div>
        <div className="hero-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setInvoiceModalOpen(true)}
            disabled={openClaims.length === 0}
            title={openClaims.length === 0 ? "No open claims available to invoice" : "Generate a patient invoice from an open claim"}
          >
            Generate invoice
          </button>
          <a
            className="button button-secondary"
            href={statementHref}
            target="_blank"
            rel="noreferrer"
          >
            Generate statement
          </a>
          <Link className="button button-secondary" href={`/billing/payments${orgQ}`}>
            Enter payment
          </Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}${orgQ}`}>Patient Chart</Link>
        </div>
      </section>

      {actionMessage ? <div className="empty-state success-panel">{actionMessage}</div> : null}

      <section className="metric-grid">
        <article className="metric-card">
          <span>Open Balance</span>
          <strong>{formatMoney(totals?.openBalance ?? 0)}</strong>
        </article>
        <article className="metric-card">
          <span>Patient Paid</span>
          <strong>{formatMoney(totals?.totalPaid ?? 0)}</strong>
        </article>
        <article className="metric-card">
          <span>Insurance Paid</span>
          <strong>{formatMoney(totals?.insurancePaid ?? 0)}</strong>
        </article>
        <article className="metric-card">
          <span>Adjustments</span>
          <strong>{formatMoney(totals?.adjustmentsTotal ?? 0)}</strong>
        </article>
        <article className="metric-card">
          <span>Write-offs</span>
          <strong>{formatMoney(totals?.writeOffTotal ?? 0)}</strong>
        </article>
        <article className="metric-card">
          <span>Invoices</span>
          <strong>{totals?.invoiceCount ?? 0}</strong>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Account ledger</h2>
          <span className="muted" style={{ fontSize: 12 }}>{ledgerWithBalance.length} entries</span>
        </div>
        {ledgerWithBalance.length === 0 ? (
          <div className="empty-state">No ledger activity yet.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Description</th>
                <th>Reference</th>
                <th style={{ textAlign: "right" }}>Charge</th>
                <th style={{ textAlign: "right" }}>Credit</th>
                <th style={{ textAlign: "right" }}>Running balance</th>
              </tr>
            </thead>
            <tbody>
              {ledgerWithBalance.map((entry) => (
                <tr key={entry.key}>
                  <td>{formatDate(entry.date)}</td>
                  <td>
                    <span className={ledgerKindClass(entry.kind)}>
                      {ledgerKindLabel(entry.kind)}
                    </span>
                  </td>
                  <td>{entry.description}</td>
                  <td>
                    {entry.invoiceId ? (
                      <Link className="inline-link" href={`/clients/${patient.id}/balance/invoice/${entry.invoiceId}/print${orgQ}`} target="_blank">
                        {entry.reference}
                      </Link>
                    ) : entry.claimId ? (
                      <Link className="inline-link" href={`/claims/${entry.claimId}${orgQ}`}>
                        {entry.reference}
                      </Link>
                    ) : (
                      entry.reference
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>{entry.charge ? formatMoney(entry.charge) : ""}</td>
                  <td style={{ textAlign: "right" }}>{entry.credit ? formatMoney(entry.credit) : ""}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{formatMoney(entry.runningBalance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Invoices</h2>
        </div>
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
                <a
                  className="button button-primary"
                  href={`/clients/${patient.id}/balance/invoice/${invoice.id}/print${orgQ}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Print invoice
                </a>
                <button className="button button-secondary" type="button" onClick={() => recordManualPayment(invoice)}>Post Payment</button>
                <button className="button button-secondary" type="button" onClick={() => markSent(invoice)}>Mark Sent</button>
                <button className="button button-secondary" type="button" onClick={() => voidInvoice(invoice)}>Void</button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {invoiceModalOpen ? (
        <GenerateInvoiceModal
          organizationId={organizationId}
          claims={openClaims}
          onClose={() => setInvoiceModalOpen(false)}
          onCreated={async (message) => {
            setInvoiceModalOpen(false);
            setActionMessage(message);
            await loadBalance();
          }}
        />
      ) : null}
    </>
  );
}

function GenerateInvoiceModal({
  organizationId,
  claims,
  onClose,
  onCreated,
}: {
  organizationId: string;
  claims: ClaimLite[];
  onClose: () => void;
  onCreated: (message: string) => void | Promise<void>;
}) {
  const [claimId, setClaimId] = useState(claims[0]?.id ?? "");
  const selected = claims.find((c) => c.id === claimId);
  const [amount, setAmount] = useState(selected ? String(selected.outstanding) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = claims.find((c) => c.id === claimId);
    if (next) setAmount(String(next.outstanding));
  }, [claimId, claims]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        throw new Error("Enter a positive invoice amount");
      }
      const res = await fetch("/api/patient-invoices/from-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, claimId, amount: numericAmount }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Could not generate invoice");
      }
      await onCreated(`Patient invoice generated and posted to ledger.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 10, padding: 20, minWidth: 480, maxWidth: 560,
          boxShadow: "0 20px 40px rgba(15,23,42,0.2)",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Generate patient invoice</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Create a new patient invoice from an open claim. The invoice posts to the ledger and is marked sent.
        </p>
        {error ? <div className="alert-panel" style={{ marginBottom: 10 }}>{error}</div> : null}

        <div style={{ display: "grid", gap: 10 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>Source claim</span>
            <select
              value={claimId}
              onChange={(e) => setClaimId(e.target.value)}
              style={{ padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 6 }}
            >
              {claims.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.claimNumber || c.id.slice(0, 8)} · {c.serviceDate ?? "no service date"} · outstanding {c.outstanding.toLocaleString(undefined, { style: "currency", currency: "USD" })}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>Invoice amount</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 6 }}
            />
          </label>
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void submit()}
            disabled={busy || !claimId || !amount}
          >
            {busy ? "Generating…" : "Generate invoice"}
          </button>
        </div>
      </div>
    </div>
  );
}
