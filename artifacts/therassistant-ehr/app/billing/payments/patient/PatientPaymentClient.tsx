"use client";

/**
 * Client payment posting workspace (PP-3, Task #109).
 *
 * Accepts a payment from any source (Stripe / cash / check / external_card /
 * refund / unapplied_credit / transferred_balance) and applies it to one of:
 * an invoice, a claim's client-responsibility, the account-balance bucket
 * (becomes unapplied credit). Lists existing unapplied credits and supports
 * applying them to an invoice/claim.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, FileText } from "lucide-react";

interface ClientRow {
  id: string;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  balance_amount: number;
  patient_responsibility_amount: number;
  invoice_status: string;
}

interface Credit {
  id: string;
  initial_amount: number;
  applied_amount: number;
  balance_amount: number;
  note: string | null;
  created_at: string;
}

// PP-4 (Task #113): "refund" intentionally removed — refunds must be issued
// against the prior posted payment via /billing/payments → row action →
// /api/billing/payments/posted/[id]/refund so applications + Stripe charges
// reverse atomically. A flat negative entry here would silently diverge the
// ledger from the original posted payment.
const METHODS = [
  "cash",
  "check",
  "credit_card",
  "debit_card",
  "stripe",
  "external_card",
  "unapplied_credit",
  "transferred_balance",
  "other",
] as const;

function money(n: number | null | undefined) {
  return `$${(Number(n ?? 0)).toFixed(2)}`;
}

export default function PatientPaymentClient() {
  const orgId = process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "";
  const [clientId, setClientId] = useState("");
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [credits, setCredits] = useState<Credit[]>([]);

  const [applyToKind, setApplyToKind] = useState<"invoice" | "claim" | "encounter" | "account_balance">("account_balance");
  const [patientInvoiceId, setPatientInvoiceId] = useState("");
  const [professionalClaimId, setProfessionalClaimId] = useState("");
  const [appointmentId, setAppointmentId] = useState("");
  const [transferFromInvoiceId, setTransferFromInvoiceId] = useState("");
  const [transferFromClaimId, setTransferFromClaimId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("cash");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [externalPaymentId, setExternalPaymentId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [creditApplyId, setCreditApplyId] = useState<string>("");
  const [creditApplyAmount, setCreditApplyAmount] = useState("");
  const [creditApplyInvoiceId, setCreditApplyInvoiceId] = useState("");

  // Load clients (limited list).
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/clients?organizationId=${encodeURIComponent(orgId)}&limit=200`);
        const j = await r.json();
        const items = (j.clients ?? j.data ?? j.items ?? []) as ClientRow[];
        setClients(items);
      } catch {
        setClients([]);
      }
    })();
  }, [orgId]);

  const reloadForClient = useCallback(async () => {
    if (!clientId) {
      setInvoices([]);
      setCredits([]);
      return;
    }
    try {
      const [invRes, credRes] = await Promise.all([
        fetch(`/api/patients/${clientId}/balance?organizationId=${encodeURIComponent(orgId)}`),
        fetch(`/api/billing/clients/${clientId}/credits?organizationId=${encodeURIComponent(orgId)}`),
      ]);
      const invJson = await invRes.json().catch(() => ({}));
      const credJson = await credRes.json().catch(() => ({}));
      setInvoices((invJson.invoices ?? invJson.openInvoices ?? []) as InvoiceRow[]);
      setCredits((credJson.credits ?? []) as Credit[]);
    } catch {
      // best-effort load
    }
  }, [clientId, orgId]);

  useEffect(() => {
    void reloadForClient();
  }, [reloadForClient]);

  async function submit(dryRun: boolean) {
    setBusy(true);
    setResult(null);
    try {
      const body: Record<string, unknown> = {
        organizationId: orgId,
        clientId,
        amount: Number(amount || 0),
        method,
        applyToKind,
        reference: reference || null,
        note: note || null,
        externalPaymentId: externalPaymentId || null,
        dryRun,
      };
      if (applyToKind === "invoice") body.patientInvoiceId = patientInvoiceId;
      if (applyToKind === "claim") body.professionalClaimId = professionalClaimId;
      if (applyToKind === "encounter") body.appointmentId = appointmentId;
      if (method === "transferred_balance" && (transferFromInvoiceId || transferFromClaimId)) {
        body.transferFrom = {
          fromInvoiceId: transferFromInvoiceId || null,
          fromClaimId: transferFromClaimId || null,
        };
        if (transferReason) body.transferReason = transferReason;
      }
      const r = await fetch("/api/billing/payments/patient", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      setResult(j);
      if (!dryRun && j.ok) {
        setAmount("");
        setReference("");
        setExternalPaymentId("");
        setNote("");
        await reloadForClient();
      }
    } finally {
      setBusy(false);
    }
  }

  async function applyCredit() {
    if (!creditApplyId || !creditApplyInvoiceId || !creditApplyAmount) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/billing/clients/${clientId}/credits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: orgId,
          clientCreditId: creditApplyId,
          patientInvoiceId: creditApplyInvoiceId,
          amount: Number(creditApplyAmount),
        }),
      });
      const j = await r.json();
      setResult(j);
      if (j.ok) {
        setCreditApplyAmount("");
        setCreditApplyId("");
        setCreditApplyInvoiceId("");
        await reloadForClient();
      }
    } finally {
      setBusy(false);
    }
  }

  const r = result as { ok?: boolean; blocked?: boolean; errors?: Array<{ message: string }>; result?: { auditLogIds?: string[]; appliedAmount?: number; unappliedAmount?: number; creditId?: string | null } } | null;

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-800">
      <header className="flex h-12 items-center gap-3 border-b border-slate-200 bg-white px-4">
        <a href="/billing/payments" className="text-[12px] font-medium text-slate-500 hover:text-slate-800">
          ← Payments
        </a>
        <span className="text-[13px] font-semibold tracking-tight text-slate-900">Client payment posting</span>
      </header>

      <div className="grid flex-1 grid-cols-[1fr_1fr] gap-0 overflow-hidden">
        <div className="flex h-full flex-col overflow-auto border-r border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-slate-500">Post a payment</h2>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Client">
              <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">— Select —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name ?? (`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.id.slice(0, 8))}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Method">
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount">
              <input type="number" step="0.01" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Reference #">
              <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
            <Field label="Apply to">
              <select
                className="input"
                value={applyToKind}
                onChange={(e) => setApplyToKind(e.target.value as "invoice" | "claim" | "encounter" | "account_balance")}
              >
                <option value="invoice">Invoice</option>
                <option value="claim">Claim (client resp.)</option>
                <option value="encounter">Encounter (appointment)</option>
                <option value="account_balance">Account balance (unapplied credit)</option>
              </select>
            </Field>
            {applyToKind === "invoice" ? (
              <Field label="Invoice">
                <select className="input" value={patientInvoiceId} onChange={(e) => setPatientInvoiceId(e.target.value)}>
                  <option value="">— Select —</option>
                  {invoices.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoice_number} · {money(inv.balance_amount)}
                    </option>
                  ))}
                </select>
              </Field>
            ) : applyToKind === "claim" ? (
              <Field label="Claim id">
                <input className="input" value={professionalClaimId} onChange={(e) => setProfessionalClaimId(e.target.value)} />
              </Field>
            ) : applyToKind === "encounter" ? (
              <Field label="Appointment id">
                <input
                  className="input"
                  placeholder="appointment uuid"
                  value={appointmentId}
                  onChange={(e) => setAppointmentId(e.target.value)}
                />
              </Field>
            ) : (
              <div />
            )}
            {method === "transferred_balance" ? (
              <>
                <Field label="Transfer FROM invoice (optional)">
                  <select className="input" value={transferFromInvoiceId} onChange={(e) => setTransferFromInvoiceId(e.target.value)}>
                    <option value="">— None —</option>
                    {invoices.map((inv) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.invoice_number} · {money(inv.balance_amount)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Transfer FROM claim id (optional)">
                  <input className="input" value={transferFromClaimId} onChange={(e) => setTransferFromClaimId(e.target.value)} />
                </Field>
                <Field label="Transfer reason">
                  <input className="input" value={transferReason} onChange={(e) => setTransferReason(e.target.value)} />
                </Field>
              </>
            ) : null}
            {method === "stripe" || method === "external_card" ? (
              <Field label="External payment id (Stripe charge / processor ref)">
                <input className="input" value={externalPaymentId} onChange={(e) => setExternalPaymentId(e.target.value)} />
              </Field>
            ) : (
              <div />
            )}
            <Field label="Note">
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busy || !clientId || !amount}
              onClick={() => submit(true)}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-[12px] hover:bg-slate-50 disabled:opacity-50"
            >
              Preview
            </button>
            <button
              type="button"
              disabled={busy || !clientId || !amount}
              onClick={() => submit(false)}
              className="rounded bg-amber-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busy ? "Working…" : "Post payment"}
            </button>
          </div>

          {r ? (
            <div
              className={`mt-4 rounded border p-3 text-[12px] ${
                r.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900"
              }`}
            >
              <div className="mb-1 flex items-center gap-1.5 font-semibold">
                {r.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                {r.ok ? "Success" : r.blocked ? "Blocked by validation" : "Failed"}
              </div>
              {r.result?.appliedAmount != null ? (
                <div>
                  Applied {money(r.result.appliedAmount)} · Unapplied {money(r.result.unappliedAmount)}{" "}
                  {r.result.creditId ? `(credit ${r.result.creditId.slice(0, 8)})` : ""}
                </div>
              ) : null}
              {r.errors?.length ? (
                <ul className="ml-4 list-disc">
                  {r.errors.map((e, i) => (
                    <li key={i}>{e.message}</li>
                  ))}
                </ul>
              ) : null}
              {r.result?.auditLogIds?.length ? (
                <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-700">
                  <FileText className="h-3 w-3" /> Audit ids: {r.result.auditLogIds.join(", ")}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex h-full flex-col overflow-auto bg-white p-5">
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-slate-500">Unapplied credit bucket</h2>
          {!clientId ? (
            <div className="text-[12px] text-slate-400">Select a client to see their unapplied credits.</div>
          ) : credits.length === 0 ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-[12px] text-slate-500">
              No unapplied credits on file.
            </div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="bg-slate-100 text-[10px] uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 text-left">Credit</th>
                  <th className="px-2 py-1.5 text-right">Initial</th>
                  <th className="px-2 py-1.5 text-right">Applied</th>
                  <th className="px-2 py-1.5 text-right">Available</th>
                </tr>
              </thead>
              <tbody>
                {credits.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setCreditApplyId(c.id)}
                    className={`cursor-pointer border-b border-slate-100 ${creditApplyId === c.id ? "bg-amber-50" : ""}`}
                  >
                    <td className="px-2 py-1.5 font-mono text-[11px]">{c.id.slice(0, 8)}</td>
                    <td className="px-2 py-1.5 text-right">{money(c.initial_amount)}</td>
                    <td className="px-2 py-1.5 text-right">{money(c.applied_amount)}</td>
                    <td className="px-2 py-1.5 text-right font-semibold">{money(c.balance_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {creditApplyId ? (
            <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3">
              <div className="mb-2 text-[12px] font-semibold">Apply credit {creditApplyId.slice(0, 8)}</div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Apply to invoice">
                  <select className="input" value={creditApplyInvoiceId} onChange={(e) => setCreditApplyInvoiceId(e.target.value)}>
                    <option value="">— Select —</option>
                    {invoices.map((inv) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.invoice_number} · {money(inv.balance_amount)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Amount">
                  <input type="number" step="0.01" className="input" value={creditApplyAmount} onChange={(e) => setCreditApplyAmount(e.target.value)} />
                </Field>
              </div>
              <button
                type="button"
                disabled={busy || !creditApplyInvoiceId || !creditApplyAmount}
                onClick={applyCredit}
                className="mt-2 rounded bg-amber-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                Apply credit
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <style jsx>{`
        .input {
          height: 28px;
          width: 100%;
          padding: 0 8px;
          border: 1px solid rgb(203 213 225);
          border-radius: 4px;
          background: white;
          font-size: 12px;
          color: rgb(15 23 42);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[11px] font-medium text-slate-600">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
