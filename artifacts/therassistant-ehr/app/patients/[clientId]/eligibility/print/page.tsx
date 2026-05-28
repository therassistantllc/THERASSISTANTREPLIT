"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { DEFAULT_ORG_ID } from "@/lib/config";

type BenefitSegment = {
  id: string;
  category: string | null;
  eligibilityCode: string;
  eligibilityCodeMeaning: string | null;
  coverageLevelCode: string | null;
  serviceTypeCode: string | null;
  planCoverageDescription: string | null;
  timePeriodQualifier: string | null;
  monetaryAmount: number | null;
  percent: number | null;
  quantity: number | null;
  authorizationRequired: boolean | null;
  inPlanNetworkCode: string | null;
  isInNetwork: boolean | null;
  isRemaining: boolean | null;
  messageText: string | null;
};

type AaaError = { code?: string; description?: string; followUpAction?: string | null; loop?: string | null };

type EligibilityCheck = {
  id: string;
  status: string;
  checkedAt: string;
  copayAmount: number | null;
  coinsurancePercent: number | null;
  deductibleTotal: number | null;
  deductibleRemaining: number | null;
  outOfPocketTotal: number | null;
  outOfPocketRemaining: number | null;
  maxCoverageAmount: number | null;
  remainingCoverageAmount: number | null;
  authorizationRequired: boolean | null;
  coverageStartDate: string;
  coverageEndDate: string;
  planName: string | null;
  payerName: string | null;
  memberId: string | null;
  subscriberName: string | null;
  aaaErrors: AaaError[];
  benefitSegments: BenefitSegment[];
  errorMessage: string;
};

type Payload = {
  success?: boolean;
  client?: { id: string; name: string; dateOfBirth: string };
  latestEligibility?: EligibilityCheck | null;
  eligibilityHistory?: EligibilityCheck[];
};

function fmtMoney(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return Number(v).toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function fmtPct(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `${v}%`;
}
function fmtDate(v: unknown) {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
}
function fmtBool(v: boolean | null | undefined) {
  if (v === null || v === undefined) return "—";
  return v ? "Yes" : "No";
}

export default function EligibilityPrintPage() {
  const params = useParams<{ clientId?: string; id?: string }>();
  const clientId = params?.clientId ?? params?.id ?? "";
  const search = useSearchParams();
  const checkId = search.get("checkId") ?? "";
  const orgId = useMemo(
    () => search.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID,
    [search],
  );
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/patients/${clientId}/eligibility?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
        const json = (await r.json()) as Payload;
        if (!r.ok || !json.success) throw new Error("Failed to load eligibility");
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
  if (!data?.client) return <div style={{ padding: 24 }}>Loading eligibility report…</div>;

  const check =
    (checkId && (data.eligibilityHistory ?? []).find((c) => c.id === checkId)) ||
    data.latestEligibility ||
    null;
  if (!check) return <div style={{ padding: 24 }}>No eligibility check found.</div>;

  return (
    <div style={{ padding: 32, fontFamily: "system-ui, sans-serif", color: "#0f172a", maxWidth: 800, margin: "0 auto" }}>
      <style jsx global>{`
        @media print {
          @page { margin: 0.5in; }
          nav, header[role="banner"], aside, .no-print { display: none !important; }
          body { background: white !important; }
          section { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>

      <header style={{ borderBottom: "2px solid #0f172a", paddingBottom: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Eligibility Verification Report</h1>
        <div style={{ marginTop: 6, fontSize: 13, color: "#475569" }}>
          Report date: {new Date().toLocaleDateString()} · Check on file: {fmtDate(check.checkedAt)}
        </div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <Box label="Client">
          <div><strong>{data.client.name}</strong></div>
          <div style={{ color: "#475569", fontSize: 12 }}>DOB {fmtDate(data.client.dateOfBirth)}</div>
          {check.memberId ? <div style={{ fontSize: 12 }}>Member ID: {check.memberId}</div> : null}
          {check.subscriberName ? <div style={{ fontSize: 12 }}>Subscriber: {check.subscriberName}</div> : null}
        </Box>
        <Box label="Payer / Plan">
          <div><strong>{check.payerName ?? "—"}</strong></div>
          {check.planName ? <div style={{ fontSize: 12 }}>{check.planName}</div> : null}
          <div style={{ fontSize: 12 }}>Status: {check.status || "—"}</div>
          <div style={{ fontSize: 12 }}>
            Coverage: {fmtDate(check.coverageStartDate)} → {fmtDate(check.coverageEndDate) || "open"}
          </div>
        </Box>
      </section>

      {check.aaaErrors && check.aaaErrors.length > 0 ? (
        <section style={{ marginBottom: 20, border: "1px solid #fecaca", background: "#fef2f2", padding: 12, borderRadius: 6 }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>Payer reject (AAA)</h2>
          <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 18, fontSize: 12 }}>
            {check.aaaErrors.map((err, i) => (
              <li key={i}>
                <strong>{err.code ?? "AAA"}</strong> {err.description ?? "Payer rejected the request"}
                {err.followUpAction ? ` — ${err.followUpAction}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 14, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
          Cost share at a glance
        </h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            <Row label="Copay" value={fmtMoney(check.copayAmount)} />
            <Row label="Coinsurance" value={fmtPct(check.coinsurancePercent)} />
            <Row label="Deductible (total / remaining)" value={`${fmtMoney(check.deductibleTotal)} / ${fmtMoney(check.deductibleRemaining)}`} />
            <Row label="Out-of-pocket (total / remaining)" value={`${fmtMoney(check.outOfPocketTotal)} / ${fmtMoney(check.outOfPocketRemaining)}`} />
            <Row label="Max coverage (annual / remaining)" value={`${fmtMoney(check.maxCoverageAmount)} / ${fmtMoney(check.remainingCoverageAmount)}`} />
            <Row label="Authorization required" value={fmtBool(check.authorizationRequired)} />
          </tbody>
        </table>
      </section>

      <section style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 14, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
          Benefit detail ({check.benefitSegments.length} segments)
        </h2>
        {check.benefitSegments.length === 0 ? (
          <p style={{ fontSize: 12, color: "#64748b" }}>No benefit segments returned for this check.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#f1f5f9" }}>
                <th style={th()}>Category</th>
                <th style={th()}>Code</th>
                <th style={th()}>In/Out</th>
                <th style={{ ...th(), textAlign: "right" }}>Amount</th>
                <th style={{ ...th(), textAlign: "right" }}>Percent</th>
                <th style={th()}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {check.benefitSegments.map((seg) => (
                <tr key={seg.id}>
                  <td style={td()}>{seg.category ?? seg.planCoverageDescription ?? "—"}</td>
                  <td style={td()}>{seg.eligibilityCode}{seg.eligibilityCodeMeaning ? ` (${seg.eligibilityCodeMeaning})` : ""}</td>
                  <td style={td()}>{seg.isInNetwork === true ? "In" : seg.isInNetwork === false ? "Out" : (seg.inPlanNetworkCode ?? "—")}</td>
                  <td style={{ ...td(), textAlign: "right" }}>{seg.monetaryAmount !== null ? fmtMoney(seg.monetaryAmount) : ""}</td>
                  <td style={{ ...td(), textAlign: "right" }}>{seg.percent !== null ? fmtPct(seg.percent) : ""}</td>
                  <td style={td()}>{seg.messageText ?? seg.timePeriodQualifier ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer style={{ marginTop: 24, paddingTop: 12, borderTop: "1px solid #cbd5e1", fontSize: 11, color: "#64748b" }}>
        Generated from 271 response on {fmtDate(check.checkedAt)}. Suitable for appeal / pre-auth supporting documentation.
        {check.errorMessage ? <div style={{ marginTop: 4, color: "#b91c1c" }}>Error: {check.errorMessage}</div> : null}
      </footer>
    </div>
  );
}

function th(): React.CSSProperties {
  return { padding: "6px 8px", borderBottom: "1px solid #cbd5e1", textAlign: "left", fontWeight: 600 };
}
function td(): React.CSSProperties {
  return { padding: "6px 8px", borderBottom: "1px solid #e2e8f0", verticalAlign: "top" };
}
function Box({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #cbd5e1", borderRadius: 6, padding: 10 }}>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td style={{ ...td(), color: "#64748b", width: "55%" }}>{label}</td>
      <td style={{ ...td(), fontWeight: 600 }}>{value}</td>
    </tr>
  );
}
