"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

const HISTORY_PAGE_SIZE = 10;

type Policy = {
  id: string;
  planName: string;
  policyNumber: string;
  priority: string;
  active: boolean;
  effectiveDate: string;
  terminationDate: string;
  payerName: string;
  clearinghousePayerId: string;
};

type BenefitSegment = {
  id: string;
  segmentIndex: number | null;
  category: string | null;
  eligibilityCode: string;
  eligibilityCodeMeaning: string | null;
  coverageLevelCode: string | null;
  serviceTypeCode: string | null;
  planCoverageDescription: string | null;
  timePeriodQualifier: string | null;
  monetaryAmount: number | null;
  percent: number | null;
  quantityQualifier: string | null;
  quantity: number | null;
  authorizationRequired: boolean | null;
  inPlanNetworkCode: string | null;
  isInNetwork: boolean | null;
  isRemaining: boolean | null;
  benefitTier: string | null;
  telemedicineFlag: boolean | null;
  messageText: string | null;
};

type AaaError = {
  code?: string;
  description?: string;
  followUpAction?: string | null;
  loop?: string | null;
};

type Attribution = {
  target?: "subscriber" | "dependent";
  subscriberName?: string | null;
  subscriberMemberId?: string | null;
  dependentName?: string | null;
  dependentDob?: string | null;
} | null;

type AttributionDecision = {
  target?: "subscriber" | "dependent";
  attributedName?: string | null;
  matchesRequestedClient?: boolean;
  mismatchReasons?: string[];
} | null;

const MISMATCH_LABELS: Record<string, string> = {
  name_mismatch: "name does not match",
  dob_mismatch: "date of birth does not match",
  member_id_mismatch: "member ID does not match",
  missing_response_identity: "payer returned no identifying details",
};

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
  maxCoveragePeriod: string | null;
  remainingCoverageAmount: number | null;
  remainingCoveragePeriod: string | null;
  telemedicineCovered: boolean | null;
  authorizationRequired: boolean | null;
  benefitTier: string | null;
  coverageStartDate: string;
  coverageEndDate: string;
  coverageLevel: string | null;
  serviceTypeCode: string;
  planName: string | null;
  payerName: string | null;
  memberId: string | null;
  subscriberName: string | null;
  aaaErrors: AaaError[];
  attribution: Attribution;
  attributionDecision: AttributionDecision;
  benefitSegments: BenefitSegment[];
  responseSummary: unknown;
  rawResponse: unknown;
  errorMessage: string;
  insurancePolicyId: string;
};

type EligibilityResponse = {
  success?: boolean;
  client?: { id: string; name: string; dateOfBirth: string; email: string; phone: string };
  policies?: Policy[];
  latestEligibility?: EligibilityCheck | null;
  eligibilityHistory?: EligibilityCheck[];
  error?: string;
};

const STALE_DAYS = 30;

const CATEGORY_LABELS: Record<string, string> = {
  active_coverage: "Active coverage",
  inactive_coverage: "Inactive coverage",
  copay: "Copay",
  coinsurance: "Coinsurance",
  deductible: "Deductible",
  out_of_pocket: "Out of pocket",
  limitation: "Limitation",
  exclusion: "Exclusion",
  non_covered: "Not covered",
  max_coverage: "Maximum coverage",
  remaining_coverage: "Remaining coverage",
  telemedicine: "Telemedicine",
  authorization: "Authorization",
  benefit_description: "Benefit description",
  other: "Other",
};

const CATEGORY_DISPLAY_ORDER = [
  "active_coverage",
  "inactive_coverage",
  "copay",
  "coinsurance",
  "deductible",
  "out_of_pocket",
  "max_coverage",
  "remaining_coverage",
  "limitation",
  "exclusion",
  "non_covered",
  "benefit_description",
  "telemedicine",
  "authorization",
  "other",
];

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function money(value: number | null) {
  if (value === null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatDate(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function statusClass(status: string) {
  const value = status.toLowerCase();
  if (value.includes("active")) return "status status-green";
  if (value.includes("inactive") || value.includes("error")) return "status status-red";
  return "status status-yellow";
}

function compactJson(value: unknown) {
  if (!value) return "No parsed details available.";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unable to display eligibility payload.";
  }
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

type Banner = { tone: "warn" | "error" | "info"; message: string };

function deriveBanner(latest: EligibilityCheck | null): Banner | null {
  if (!latest) {
    return { tone: "warn", message: "No eligibility check on file. Run a real-time check before the visit." };
  }
  const status = (latest.status || "").toLowerCase();
  if (status === "error") {
    return { tone: "error", message: latest.errorMessage || "Last eligibility check failed. Retry below." };
  }
  const days = daysSince(latest.checkedAt);
  if (days !== null && days > STALE_DAYS) {
    return { tone: "warn", message: `Last eligibility check was ${days} days ago (older than ${STALE_DAYS} days). Re-check before billing.` };
  }
  if (status === "inactive") {
    return { tone: "error", message: "Payer reports coverage is INACTIVE. Verify insurance with client." };
  }
  return null;
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "green" | "red" | "amber" | "blue" }) {
  const palette: Record<string, { bg: string; fg: string; border: string }> = {
    neutral: { bg: "#f1f5f9", fg: "#1f2937", border: "#cbd5e1" },
    green: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
    red: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
    amber: { bg: "#fffbeb", fg: "#92400e", border: "#fde68a" },
    blue: { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" },
  };
  const p = palette[tone];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        marginRight: 6,
        marginBottom: 4,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: p.bg,
        color: p.fg,
        border: `1px solid ${p.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function networkBadge(seg: BenefitSegment) {
  if (seg.isInNetwork === true || seg.inPlanNetworkCode === "Y") return <Badge tone="green">In network</Badge>;
  if (seg.isInNetwork === false || seg.inPlanNetworkCode === "N") return <Badge tone="amber">Out of network</Badge>;
  if (seg.inPlanNetworkCode === "W") return <Badge>Network not applicable</Badge>;
  return null;
}

function segmentPrimary(seg: BenefitSegment): string {
  if (seg.monetaryAmount != null) return money(seg.monetaryAmount);
  if (seg.percent != null) {
    const pct = seg.percent > 0 && seg.percent < 1 ? seg.percent * 100 : seg.percent;
    return `${Math.round(pct)}%`;
  }
  if (seg.quantity != null) return `${seg.quantity}${seg.quantityQualifier ? ` (${seg.quantityQualifier})` : ""}`;
  return "—";
}

function groupByCategory(segments: BenefitSegment[]) {
  const buckets = new Map<string, BenefitSegment[]>();
  for (const seg of segments) {
    const key = seg.category ?? "other";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(seg);
  }
  const ordered: Array<[string, BenefitSegment[]]> = [];
  for (const key of CATEGORY_DISPLAY_ORDER) {
    if (buckets.has(key)) {
      ordered.push([key, buckets.get(key)!]);
      buckets.delete(key);
    }
  }
  for (const [k, v] of buckets) ordered.push([k, v]);
  return ordered;
}

function BenefitSegmentRow({ seg }: { seg: BenefitSegment }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        background: "#fff",
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 6 }}>
        <div>
          <strong style={{ fontSize: 14 }}>{seg.eligibilityCodeMeaning || seg.eligibilityCode}</strong>
          {seg.planCoverageDescription ? (
            <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>{seg.planCoverageDescription}</div>
          ) : null}
        </div>
        <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{segmentPrimary(seg)}</div>
          {seg.timePeriodQualifier ? (
            <div style={{ fontSize: 11, color: "#64748b" }}>per {seg.timePeriodQualifier}</div>
          ) : null}
        </div>
      </div>
      <div>
        {networkBadge(seg)}
        {seg.coverageLevelCode ? <Badge>{seg.coverageLevelCode}</Badge> : null}
        {seg.isRemaining ? <Badge tone="blue">Remaining</Badge> : null}
        {seg.authorizationRequired === true ? <Badge tone="amber">Auth required</Badge> : null}
        {seg.authorizationRequired === false ? <Badge tone="green">No auth needed</Badge> : null}
        {seg.telemedicineFlag ? <Badge tone="blue">Telemedicine</Badge> : null}
        {seg.benefitTier ? <Badge>{seg.benefitTier}</Badge> : null}
        {seg.serviceTypeCode ? <Badge>STC {seg.serviceTypeCode}</Badge> : null}
      </div>
      {seg.messageText ? (
        <div style={{ fontSize: 12, color: "#475569", marginTop: 6, fontStyle: "italic" }}>{seg.messageText}</div>
      ) : null}
    </div>
  );
}

export default function EligibilityDetailClient({ clientId }: { clientId: string }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [data, setData] = useState<EligibilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const response = await fetch(`/api/patients/${clientId}/eligibility?organizationId=${encodeURIComponent(organizationId)}`);
    const json = (await response.json()) as EligibilityResponse;
    if (!response.ok || !json.success) {
      setError(json.error || "Unable to load eligibility.");
    } else {
      setData(json);
    }
    setLoading(false);
  }, [clientId, organizationId]);

  useEffect(() => {
    if (organizationId && clientId) {
      void load();
    } else {
      setError("Missing organizationId or clientId.");
      setLoading(false);
    }
  }, [clientId, organizationId, load]);

  const runCheck = useCallback(async (insurancePolicyId?: string | null) => {
    setRunning(insurancePolicyId ?? "any");
    setRunError(null);
    setRunMessage(null);
    try {
      const res = await fetch(`/api/clearinghouse/eligibility/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patientId: clientId,
          insurancePolicyId: insurancePolicyId ?? null,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setRunError(json?.error || "Eligibility check failed.");
      } else {
        const status = json?.normalized?.status ?? "completed";
        setRunMessage(`Eligibility check ${status}.`);
        await load();
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Eligibility check failed.");
    } finally {
      setRunning(null);
    }
  }, [clientId, load]);

  const client = data?.client;
  const latest = data?.latestEligibility ?? null;
  const history = data?.eligibilityHistory ?? [];

  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("checkId");
  });
  const [historyPage, setHistoryPage] = useState(0);
  const historyPageCount = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  useEffect(() => {
    if (historyPage >= historyPageCount) setHistoryPage(0);
  }, [historyPage, historyPageCount]);

  const selectedCheck = useMemo<EligibilityCheck | null>(() => {
    if (selectedCheckId) {
      const found = history.find((h) => h.id === selectedCheckId);
      if (found) return found;
    }
    return latest;
  }, [selectedCheckId, history, latest]);

  const banner = deriveBanner(latest);
  const isRunningAny = running !== null;

  const groupedSegments = useMemo(() => {
    if (!selectedCheck?.benefitSegments?.length) return [];
    return groupByCategory(selectedCheck.benefitSegments);
  }, [selectedCheck]);

  function selectCheck(id: string | null) {
    setSelectedCheckId(id);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("checkId", id);
      else url.searchParams.delete("checkId");
      window.history.replaceState({}, "", url.toString());
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Eligibility</p>
          <h1>{client?.name || "Client eligibility"}</h1>
          <p className="hero-copy">Coverage, copay, deductible, and benefit history for the visit workflow.</p>
        </div>
        <div className="hero-actions no-print">
          <button type="button" className="button button-primary" disabled={isRunningAny} onClick={() => runCheck(null)}>
            {isRunningAny ? "Checking…" : "Check eligibility"}
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              if (typeof window === "undefined" || !selectedCheck) return;
              const url = `/patients/${clientId}/eligibility/print?checkId=${encodeURIComponent(selectedCheck.id)}&organizationId=${encodeURIComponent(organizationId)}`;
              window.open(url, "_blank", "noreferrer");
            }}
            disabled={!selectedCheck}
            title={selectedCheck ? "Print this eligibility check as an appeal-ready report" : "No eligibility check to print"}
          >
            Print to PDF
          </button>
          <Link className="button button-secondary" href={`/clients/${clientId}`}>Client Chart</Link>
        </div>
      </section>

      <style jsx global>{`
        @media print {
          .no-print, nav, header[role="banner"], aside { display: none !important; }
          .hero-panel { box-shadow: none !important; border: none !important; }
          .panel { break-inside: avoid; page-break-inside: avoid; }
          body { background: white !important; }
        }
      `}</style>

      {banner ? (
        <div
          className="alert-panel"
          style={{
            background: banner.tone === "error" ? "#fef2f2" : banner.tone === "warn" ? "#fffbeb" : "#eff6ff",
            borderColor: banner.tone === "error" ? "#fecaca" : banner.tone === "warn" ? "#fde68a" : "#bfdbfe",
            color: banner.tone === "error" ? "#991b1b" : banner.tone === "warn" ? "#92400e" : "#1e40af",
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            {banner.tone === "error" ? "Eligibility issue" : banner.tone === "warn" ? "Eligibility attention" : "Eligibility"}
          </strong>
          <span>{banner.message}</span>
        </div>
      ) : null}

      {selectedCheck?.aaaErrors && selectedCheck.aaaErrors.length > 0 ? (
        <div className="alert-panel" style={{ background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          <strong style={{ display: "block", marginBottom: 6 }}>Payer rejected this inquiry</strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {selectedCheck.aaaErrors.map((err, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                <strong>[{err.code || "—"}]</strong> {err.description || "Reject reason not provided."}
                {err.followUpAction ? <span style={{ color: "#7f1d1d" }}> — {err.followUpAction}</span> : null}
                {err.loop ? <span style={{ color: "#7f1d1d", fontSize: 11 }}> ({err.loop})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {selectedCheck?.attributionDecision && selectedCheck.attributionDecision.matchesRequestedClient === false ? (
        <div className="alert-panel" style={{ background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          <strong style={{ display: "block", marginBottom: 4 }}>Client attribution mismatch</strong>
          <span>
            271 was attributed to {selectedCheck.attributionDecision.target ?? "subscriber"}
            {selectedCheck.attributionDecision.attributedName ? ` "${selectedCheck.attributionDecision.attributedName}"` : ""}
            , which does not match this client (
            {(selectedCheck.attributionDecision.mismatchReasons ?? [])
              .map((r) => MISMATCH_LABELS[r] ?? r)
              .join("; ") || "no identifying details returned"}
            ). Verify before billing.
          </span>
        </div>
      ) : null}

      {selectedCheck?.attribution ? (
        <div
          className="alert-panel"
          style={{
            background: selectedCheck.attribution.target === "dependent" ? "#eff6ff" : "#f8fafc",
            borderColor: selectedCheck.attribution.target === "dependent" ? "#bfdbfe" : "#e2e8f0",
            color: "#1f2937",
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            Response attributed to {selectedCheck.attribution.target === "dependent" ? "dependent" : "subscriber"}
          </strong>
          <span>
            {selectedCheck.attribution.target === "dependent"
              ? `Benefits returned for dependent ${selectedCheck.attribution.dependentName ?? "—"}${
                  selectedCheck.attribution.dependentDob ? ` (DOB ${formatDate(selectedCheck.attribution.dependentDob)})` : ""
                } under subscriber ${selectedCheck.attribution.subscriberName ?? "—"}.`
              : `Benefits returned for subscriber ${selectedCheck.attribution.subscriberName ?? "—"}${
                  selectedCheck.attribution.subscriberMemberId ? ` (Member ${selectedCheck.attribution.subscriberMemberId})` : ""
                }.`}
          </span>
        </div>
      ) : null}

      {runError ? (
        <div className="alert-panel" style={{ background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          <strong style={{ display: "block", marginBottom: 4 }}>Eligibility check failed</strong>
          <span>{runError}</span>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="button button-secondary" onClick={() => runCheck(null)} disabled={isRunningAny}>
              {isRunningAny ? "Retrying…" : "Retry"}
            </button>
          </div>
        </div>
      ) : null}

      {runMessage ? (
        <div className="alert-panel" style={{ background: "#ecfdf5", borderColor: "#a7f3d0", color: "#065f46" }}>
          {runMessage}
        </div>
      ) : null}

      {loading ? <div className="empty-state">Loading eligibility…</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}

      {!loading && !error ? (
        <>
          <section className="panel no-print" style={{ marginBottom: 16 }}>
            <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>
                Eligibility history <span className="muted" style={{ fontWeight: 400 }}>({history.length})</span>
              </h2>
              <span className="muted" style={{ fontSize: 12 }}>
                {selectedCheckId
                  ? <>Viewing selected check. <button type="button" className="inline-link" onClick={() => selectCheck(null)}>Back to latest</button></>
                  : "Viewing latest check"}
              </span>
            </div>
            {history.length === 0 ? (
              <div className="empty-state">No eligibility checks on file yet.</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Checked at</th>
                    <th>Status</th>
                    <th>Payer / plan</th>
                    <th>Service type</th>
                    <th>Copay</th>
                    <th>Deductible remaining</th>
                    <th>Coverage</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE).map((check) => {
                    const isCurrent = (selectedCheck?.id ?? latest?.id) === check.id;
                    return (
                      <tr
                        key={check.id}
                        style={isCurrent ? { background: "#eff6ff" } : undefined}
                      >
                        <td>{formatDate(check.checkedAt)}</td>
                        <td><span className={statusClass(check.status)}>{check.status || "—"}</span></td>
                        <td>{check.payerName ?? "—"}{check.planName ? ` · ${check.planName}` : ""}</td>
                        <td>{check.serviceTypeCode || "—"}</td>
                        <td>{money(check.copayAmount)}</td>
                        <td>{money(check.deductibleRemaining)}</td>
                        <td>{formatDate(check.coverageStartDate)} – {formatDate(check.coverageEndDate)}</td>
                        <td>
                          <button
                            type="button"
                            className="button button-secondary"
                            disabled={isCurrent}
                            onClick={() => selectCheck(check.id)}
                          >
                            {isCurrent ? "Viewing" : "Open"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {history.length > HISTORY_PAGE_SIZE ? (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 13 }}>
                <span className="muted">
                  Page {historyPage + 1} of {historyPageCount} · showing
                  {" "}
                  {Math.min(history.length, historyPage * HISTORY_PAGE_SIZE + 1)}
                  –{Math.min(history.length, (historyPage + 1) * HISTORY_PAGE_SIZE)}
                  {" "}of {history.length}
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={historyPage === 0}
                    onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={historyPage >= historyPageCount - 1}
                    onClick={() => setHistoryPage((p) => Math.min(historyPageCount - 1, p + 1))}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="metric-grid">
            <div className="metric-card">
              <span>Status</span>
              <strong className="metric-text">{selectedCheck?.status || "not checked"}</strong>
            </div>
            <div className="metric-card">
              <span>Copay</span>
              <strong>{money(selectedCheck?.copayAmount ?? null)}</strong>
            </div>
            <div className="metric-card">
              <span>Deductible remaining</span>
              <strong>{money(selectedCheck?.deductibleRemaining ?? null)}</strong>
            </div>
            <div className="metric-card">
              <span>Out of pocket left</span>
              <strong>{money(selectedCheck?.outOfPocketRemaining ?? null)}</strong>
            </div>
            <div className="metric-card">
              <span>Coinsurance</span>
              <strong>{selectedCheck?.coinsurancePercent != null ? `${Math.round(selectedCheck.coinsurancePercent)}%` : "—"}</strong>
            </div>
            <div className="metric-card">
              <span>Tier</span>
              <strong className="metric-text">{selectedCheck?.benefitTier || "—"}</strong>
            </div>
            <div className="metric-card">
              <span>Telemedicine</span>
              <strong className="metric-text">
                {selectedCheck?.telemedicineCovered === true
                  ? "Covered"
                  : selectedCheck?.telemedicineCovered === false
                    ? "Not covered"
                    : "—"}
              </strong>
            </div>
            <div className="metric-card">
              <span>Authorization</span>
              <strong className="metric-text">
                {selectedCheck?.authorizationRequired === true
                  ? "Required"
                  : selectedCheck?.authorizationRequired === false
                    ? "Not required"
                    : "—"}
              </strong>
            </div>
            <div className="metric-card">
              <span>Checked at</span>
              <strong className="metric-text">{formatDate(selectedCheck?.checkedAt || "")}</strong>
            </div>
          </section>

          {(selectedCheck?.maxCoverageAmount != null || selectedCheck?.remainingCoverageAmount != null) ? (
            <section className="panel" style={{ marginBottom: 16 }}>
              <h2>Coverage limits</h2>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>Maximum benefit</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{money(selectedCheck.maxCoverageAmount)}</div>
                  {selectedCheck.maxCoveragePeriod ? (
                    <div style={{ fontSize: 12, color: "#64748b" }}>per {selectedCheck.maxCoveragePeriod}</div>
                  ) : null}
                </div>
                <div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>Remaining benefit</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{money(selectedCheck.remainingCoverageAmount)}</div>
                  {selectedCheck.remainingCoveragePeriod ? (
                    <div style={{ fontSize: 12, color: "#64748b" }}>per {selectedCheck.remainingCoveragePeriod}</div>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          <section className="chart-grid">
            <div className="panel">
              <div className="panel-header">
                <div>
                  <h2>Current eligibility</h2>
                  <p>{client?.dateOfBirth ? `DOB ${formatDate(client.dateOfBirth)}` : "Client benefit detail"}</p>
                </div>
                <span className={statusClass(selectedCheck?.status || "not_checked")}>{selectedCheck?.status || "not checked"}</span>
              </div>
              <div className="detail-list">
                <p><strong>Payer:</strong> {selectedCheck?.payerName || "—"}</p>
                <p><strong>Plan:</strong> {selectedCheck?.planName || "—"}</p>
                <p><strong>Member ID:</strong> {selectedCheck?.memberId || "—"}</p>
                <p><strong>Coverage start:</strong> {formatDate(selectedCheck?.coverageStartDate || "")}</p>
                <p><strong>Coverage end:</strong> {formatDate(selectedCheck?.coverageEndDate || "")}</p>
                <p><strong>Coverage level:</strong> {selectedCheck?.coverageLevel || "—"}</p>
                <p><strong>Service type:</strong> {selectedCheck?.serviceTypeCode || "98"}</p>
                {selectedCheck?.errorMessage ? <p><strong>Error:</strong> {selectedCheck.errorMessage}</p> : null}
              </div>
            </div>

            <div className="panel">
              <h2>Insurance policies</h2>
              <div className="stack-list">
                {(data?.policies || []).map((policy) => (
                  <div className="stack-item" key={policy.id}>
                    <strong>{policy.payerName || policy.planName || "Insurance policy"}</strong>
                    <span>{policy.priority || "policy"} · {policy.active ? "active" : "inactive"}</span>
                    <span>Policy: {policy.policyNumber || "—"}</span>
                    <span>Payer ID: {policy.clearinghousePayerId || "—"}</span>
                    <span>{formatDate(policy.effectiveDate)} – {formatDate(policy.terminationDate)}</span>
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={isRunningAny}
                        onClick={() => runCheck(policy.id)}
                      >
                        {running === policy.id ? "Checking…" : "Check this policy"}
                      </button>
                    </div>
                  </div>
                ))}
                {(data?.policies || []).length === 0 ? <div className="empty-state">No insurance policies found.</div> : null}
              </div>
            </div>

            <div className="panel wide-panel">
              <h2>Benefits by category</h2>
              {groupedSegments.length === 0 ? (
                <div className="empty-state">No benefit segments returned. Headline values above come from the payer rollup.</div>
              ) : (
                <div>
                  {groupedSegments.map(([category, segs]) => (
                    <div key={category} style={{ marginBottom: 18 }}>
                      <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "#475569", marginBottom: 8 }}>
                        {CATEGORY_LABELS[category] || category} <span style={{ color: "#94a3b8", fontWeight: 400 }}>({segs.length})</span>
                      </h3>
                      {segs.map((seg) => <BenefitSegmentRow key={seg.id || `${seg.segmentIndex}`} seg={seg} />)}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="panel wide-panel">
              <h2>Response summary</h2>
              <pre className="json-panel">{compactJson(selectedCheck?.responseSummary)}</pre>
            </div>

            <div className="panel wide-panel">
              <h2>Raw 271 payload</h2>
              <pre className="json-panel">{compactJson(selectedCheck?.rawResponse)}</pre>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
