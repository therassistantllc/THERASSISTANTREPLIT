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
  client?: { id: string; name: string; dateOfBirth?: string | null };
  totals?: { openBalance: number; totalPaid: number; totalResponsibility: number; invoiceCount: number };
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

export default function PatientStatementPrintPage() {
  const params = useParams<{ clientId?: string; id?: string }>();
  const clientId = params?.clientId ?? params?.id ?? "";
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
  if (!data?.client) return <div style={{ padding: 24 }}>Loading statement…</div>;

  const today = new Date().toLocaleDateString();

  return (
    <div style={{ padding: 32, fontFamily: "system-ui, sans-serif", color: "#0f172a", maxWidth: 800, margin: "0 auto" }}>
      <style jsx global>{`
        @media print {
          @page { margin: 0.5in; }
          nav, header[role="banner"], aside, .no-print { display: none !important; }
          body { background: white !important; }
        }
      `}</style>

      <header style={{ borderBottom: "2px solid #0f172a", paddingBottom: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Client Account Statement</h1>
        <div style={{ marginTop: 8, fontSize: 14, color: "#475569" }}>Statement date: {today}</div>
      </header>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Client</h2>
        <div style={{ fontSize: 16 }}>
          <strong>{data.client.name}</strong>
          {data.client.dateOfBirth ? <span style={{ marginLeft: 12, color: "#64748b" }}>DOB {fmtDate(data.client.dateOfBirth)}</span> : null}
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        <Metric label="Open balance" value={fmtMoney(data.totals?.openBalance ?? 0)} highlight />
        <Metric label="Responsibility" value={fmtMoney(data.totals?.totalResponsibility ?? 0)} />
        <Metric label="Paid" value={fmtMoney(data.totals?.totalPaid ?? 0)} />
        <Metric label="Invoices" value={String(data.totals?.invoiceCount ?? 0)} />
      </section>

      <h2 style={{ fontSize: 14, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Account activity</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#f1f5f9" }}>
            <th style={th()}>Date</th>
            <th style={th()}>Description</th>
            <th style={{ ...th(), textAlign: "right" }}>Charge</th>
            <th style={{ ...th(), textAlign: "right" }}>Credit</th>
            <th style={{ ...th(), textAlign: "right" }}>Balance</th>
          </tr>
        </thead>
        <tbody>{renderLedger(data.invoices ?? [])}</tbody>
      </table>

      <footer style={{ marginTop: 32, fontSize: 12, color: "#64748b" }}>
        Please remit the balance shown. Questions? Contact the billing office.
      </footer>
    </div>
  );
}

function th(): React.CSSProperties {
  return { padding: "8px 10px", borderBottom: "1px solid #cbd5e1", textAlign: "left", fontWeight: 600 };
}

function td(): React.CSSProperties {
  return { padding: "8px 10px", borderBottom: "1px solid #e2e8f0" };
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ border: "1px solid #cbd5e1", borderRadius: 6, padding: 10, background: highlight ? "#fef3c7" : "#fff" }}>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function renderLedger(invoices: Invoice[]) {
  type Row = { date: string | null; description: string; charge: number; credit: number; sort: number };
  const rows: Row[] = [];
  for (const inv of invoices) {
    const invDate = inv.createdAt ? String(inv.createdAt) : null;
    const ref = String(inv.invoiceNumber ?? inv.id.slice(0, 8));
    rows.push({
      date: invDate,
      description: `Invoice ${ref}`,
      charge: Number(inv.patientResponsibilityAmount ?? 0),
      credit: 0,
      sort: invDate ? new Date(invDate).getTime() : 0,
    });
    for (const p of inv.payments) {
      const pd = p.paid_at ?? invDate;
      rows.push({
        date: pd,
        description: `Payment for ${ref} (${p.payment_method ?? "—"})`,
        charge: 0,
        credit: Number(p.amount ?? 0),
        sort: pd ? new Date(pd).getTime() : 0,
      });
    }
  }
  rows.sort((a, b) => a.sort - b.sort);
  let bal = 0;
  return rows.map((r, i) => {
    bal += r.charge - r.credit;
    return (
      <tr key={i}>
        <td style={td()}>{fmtDate(r.date)}</td>
        <td style={td()}>{r.description}</td>
        <td style={{ ...td(), textAlign: "right" }}>{r.charge ? fmtMoney(r.charge) : ""}</td>
        <td style={{ ...td(), textAlign: "right" }}>{r.credit ? fmtMoney(r.credit) : ""}</td>
        <td style={{ ...td(), textAlign: "right", fontWeight: 600 }}>{fmtMoney(bal)}</td>
      </tr>
    );
  });
}
