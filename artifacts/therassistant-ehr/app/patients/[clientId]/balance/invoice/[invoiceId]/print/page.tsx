"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
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
  createdAt?: unknown;
  payments: InvoicePayment[];
};

type Payload = {
  success: boolean;
  patient?: { id: string; name: string; dateOfBirth?: string | null };
  invoices?: Invoice[];
};

function fmtMoney(v: number | string | null | undefined) {
  return Number(v ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function fmtDate(v: unknown) {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
}

export default function InvoicePrintPage() {
  const params = useParams<{ clientId?: string; id?: string; invoiceId: string }>();
  const clientId = params?.clientId ?? params?.id ?? "";
  const invoiceId = params?.invoiceId ?? "";
  const search = useSearchParams();
  const orgId = useMemo(
    () => search.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID,
    [search],
  );
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/patients/${clientId}/balance?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
        const json = (await r.json()) as Payload;
        if (!r.ok || !json.success) throw new Error("Failed to load");
        setData(json);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed");
      }
    })();
  }, [clientId, orgId]);

  useEffect(() => {
    if (data) {
      const t = setTimeout(() => {
        if (typeof window !== "undefined") window.print();
      }, 400);
      return () => clearTimeout(t);
    }
  }, [data]);

  if (error) return <div style={{ padding: 24 }}>{error}</div>;
  if (!data?.patient) return <div style={{ padding: 24 }}>Loading invoice…</div>;

  const invoice = (data.invoices ?? []).find((i) => i.id === invoiceId);
  if (!invoice) return <div style={{ padding: 24 }}>Invoice not found.</div>;

  return (
    <div style={{ padding: 32, fontFamily: "system-ui, sans-serif", color: "#0f172a", maxWidth: 800, margin: "0 auto" }}>
      <style jsx global>{`
        @media print {
          @page { margin: 0.5in; }
          nav, header[role="banner"], aside, .no-print { display: none !important; }
          body { background: white !important; }
        }
      `}</style>

      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "2px solid #0f172a", paddingBottom: 16, marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>Invoice</h1>
          <div style={{ marginTop: 8, fontSize: 14, color: "#475569" }}>
            #{String(invoice.invoiceNumber ?? invoice.id.slice(0, 8))}
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: 13, color: "#475569" }}>
          <div>Issued: {fmtDate(invoice.createdAt)}</div>
          <div>Status: {String(invoice.status ?? "—")}</div>
        </div>
      </header>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Bill to</h2>
        <div style={{ fontSize: 16 }}>
          <strong>{data.patient.name}</strong>
          {data.patient.dateOfBirth ? <span style={{ marginLeft: 12, color: "#64748b" }}>DOB {fmtDate(data.patient.dateOfBirth)}</span> : null}
        </div>
      </section>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 16 }}>
        <thead>
          <tr style={{ background: "#f1f5f9" }}>
            <th style={th()}>Description</th>
            <th style={{ ...th(), textAlign: "right" }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={td()}>Patient responsibility</td>
            <td style={{ ...td(), textAlign: "right" }}>{fmtMoney(invoice.patientResponsibilityAmount)}</td>
          </tr>
        </tbody>
      </table>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 24 }}>
        <tbody>
          <tr>
            <td style={{ ...td(), textAlign: "right" }}>Subtotal</td>
            <td style={{ ...td(), textAlign: "right", width: 140 }}>{fmtMoney(invoice.patientResponsibilityAmount)}</td>
          </tr>
          <tr>
            <td style={{ ...td(), textAlign: "right" }}>Paid</td>
            <td style={{ ...td(), textAlign: "right" }}>−{fmtMoney(invoice.paidAmount)}</td>
          </tr>
          <tr>
            <td style={{ ...td(), textAlign: "right", fontWeight: 700 }}>Balance due</td>
            <td style={{ ...td(), textAlign: "right", fontWeight: 700, background: "#fef3c7" }}>{fmtMoney(invoice.balanceAmount)}</td>
          </tr>
        </tbody>
      </table>

      {invoice.payments.length > 0 ? (
        <>
          <h2 style={{ fontSize: 14, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Payments</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f1f5f9" }}>
                <th style={th()}>Date</th>
                <th style={th()}>Method</th>
                <th style={{ ...th(), textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.payments.map((p) => (
                <tr key={p.id}>
                  <td style={td()}>{fmtDate(p.paid_at)}</td>
                  <td style={td()}>{p.payment_method ?? "—"}</td>
                  <td style={{ ...td(), textAlign: "right" }}>{fmtMoney(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}

function th(): React.CSSProperties {
  return { padding: "8px 10px", borderBottom: "1px solid #cbd5e1", textAlign: "left", fontWeight: 600 };
}

function td(): React.CSSProperties {
  return { padding: "8px 10px", borderBottom: "1px solid #e2e8f0" };
}
